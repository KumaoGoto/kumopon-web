// 場面の並び（engine.scene()）を受け取って WebGL2 で描く。iOS の App/Render/BlobRenderer.swift を写したもの。
//
// 描く順: 背景 → polygonsBack → (カプセル奥の影) → capsulesBack → (ブロブの影) → blobs →
//        (カプセル手前の影) → capsulesFront → polygonsFront → (手前のブロブの影) → blobsFront → rings → sparks → texts → flash
//
// - ブロブの頂点は CPU で作らない。粒の位置と restUV だけを詰め、Catmull-Rom の分割・膨らませ・扇・帯はシェーダーが作る
// - 影はアルファチャンネルに「1-濃さ」の min で溜め、全画面（はさみ込み）で色に混ぜる。重なっても濃くならない
// - 輪が中心から見て裏返る形（強く凹んだ形）だけ、ステンシルの巻き数で正しく塗る
//
// 色の扱い（iOS と同じにするための段）:
// iOS は sRGB の描画先（bgra8Unorm_srgb、4x MSAA）にリニアの色で混ぜ、ハードが書くときに sRGB に戻す。
// WebGL2 の画面（既定のフレームバッファ）は sRGB の書き込みをしないので、
//   1. SRGB8_ALPHA8 の MSAA レンダーバッファ（＋ステンシル）に描く（混ぜるのはリニア、書くときに sRGB に戻る。iOS と同じ）
//   2. blitFramebuffer で同じ形式の SRGB8_ALPHA8 のテクスチャへ解決する
//   3. そのテクスチャを読み（読むとリニア）、sRGB の式で戻して画面へ書く（shaders.js の presentFS）
// MSAA を切る段では 1 と 2 を飛ばし、SRGB8_ALPHA8 のテクスチャ（＋ステンシル）に直接描く。
// 解像度を下げる段（renderScale）では、canvas の画素数そのものを減らし、拡大はブラウザ（CSS）に任せる。
//
// フレームをまたいで使い回す: CPU の詰め込み用の Float32Array・区切りの番号・作業領域は、足りないときだけ倍に作り直す
// （Android の安い端末で GC のひっかかりを起こさないように、draw の中でオブジェクトや配列を作らない）。

import { SceneReader, SCENE_VERSION, HEADER_FLOATS, HEAD, POLY, CAPSULE, BLOB, RING, SPARK, TEXT } from './scene_reader.js';
import { linear, writeLinear, writeLinearPremultiplied, SHADOW_COLOR, rainbowTable } from './color.js';
import * as SH from './shaders.js';
import { EarClipper } from './ear_clipper.js';
import { TextTextureCache, ensureFonts } from './text_cache.js';

/** 論理キャンバスの大きさ（CanvasFit.defaultCanvas） */
const DEFAULT_CANVAS_W = 360;
const DEFAULT_CANVAS_H = 720;
/** 数のテクスチャ（RGBA32F）の幅。シェーダーの「& 1023, >> 10」と同じ */
const DATA_W = 1024;
/** ブロブ 1 つのテクセル数（BlobInstanceGPU の 208 バイト = 13 × vec4） */
const BLOB_TEXELS = 13;
/** カプセル・波紋・火花 1 つの float の数（ShapeInstanceGPU の 96 バイト） */
const SHAPE_FLOATS = 24;
/** 多角形の頂点 1 つの float の数（位置 2 ＋ 乗算済みの色 4） */
const POLY_FLOATS = 6;
/** GPU の数のバッファを何組持つか（iOS の framesInFlight 3 の代わり。前のフレームが使っている所へ書いて待たされないように） */
const SLOTS = 2;
/** 影のぼかし＋ずらし（シェーダーの定数より少し大きめ）。影の resolve の範囲に使う */
const SHADOW_SPREAD = 3.4 + 4.5;
/** 起動のときに読んでおく背景の絵（JarModeV4 の skyImage・duskImage） */
const DEFAULT_BG_IMAGES = ['play_bg', 'result_bg'];

const BLEND_OPAQUE = 0, BLEND_PREMULTIPLIED = 1, BLEND_SHADOW_ACCUMULATE = 2, BLEND_SHADOW_RESOLVE = 3, BLEND_NONE = 4;
const STENCIL_NONE = 0, STENCIL_FILL = 1, STENCIL_COVER = 2;

/** 足りないときだけ倍にする Float32Array（中身は残す） */
function grow(arr, need) {
  if (arr.length >= need) return arr;
  let cap = Math.max(arr.length, 1024);
  while (cap < need) cap *= 2;
  const out = new Float32Array(cap);
  out.set(arr);
  return out;
}

/** 0〜1 などに収める（NaN・無限大は fallback）。BlobRenderer.clean */
function clean(x, lo, hi, fallback) {
  return Number.isFinite(x) ? (x < lo ? lo : x > hi ? hi : x) : fallback;
}

/** RGBA32F の数のテクスチャ（幅 1024）。行が足りないときだけ倍に作り直す */
class DataTexture {
  constructor(gl) {
    this.gl = gl;
    this.texture = gl.createTexture();
    this.rows = 0;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  /** data の先頭 texels 個（4 float ずつ）を上げる。data は行の幅で切り上げた長さ以上あること */
  upload(data, texels) {
    const gl = this.gl;
    const rows = Math.max(1, Math.ceil(texels / DATA_W));
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (rows > this.rows) {
      this.rows = Math.max(rows, this.rows * 2, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, DATA_W, this.rows, 0, gl.RGBA, gl.FLOAT, null);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DATA_W, rows, gl.RGBA, gl.FLOAT, data, 0);
  }
}

/** 1 フレーム分の GPU の入れ物（iOS の FrameSlot） */
class FrameSlot {
  constructor(gl) {
    this.points = new DataTexture(gl);
    this.blobs = new DataTexture(gl);
    this.shapeBuffer = gl.createBuffer();
    this.shapeBytes = 0;
    this.polyBuffer = gl.createBuffer();
    this.polyBytes = 0;
    // 多角形: aPos(0) と aColor(1)
    this.polyVAO = gl.createVertexArray();
    gl.bindVertexArray(this.polyVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.polyBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, POLY_FLOATS * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, POLY_FLOATS * 4, 8);
    // カプセル・波紋・火花: インスタンスごとの属性（0〜5）。どこから読むかは描くたびに決める（baseInstance の代わり）
    this.shapeVAO = gl.createVertexArray();
    gl.bindVertexArray(this.shapeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shapeBuffer);
    for (let i = 0; i < 6; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
  }
}

/** 1 つの層（奥の blobs か手前の blobsFront）のインスタンスの範囲と、影を描くための値（iOS の BlobLayer） */
class BlobLayer {
  constructor() { this.reset(0); }
  reset(start) {
    this.start = start;
    this.end = start;
    this.maxM = 0;
    this.folded = 0;
    this.anyShadow = false;
    this.lox = Infinity; this.loy = Infinity; this.hix = -Infinity; this.hiy = -Infinity;
  }
  get count() { return this.end - this.start; }
}

/** ワールド座標の箱（影の resolve を必要な所だけにする） */
class WorldBounds {
  constructor() { this.clear(); }
  clear() { this.lox = Infinity; this.loy = Infinity; this.hix = -Infinity; this.hiy = -Infinity; }
  add(lox, loy, hix, hiy) {
    if (lox < this.lox) this.lox = lox;
    if (loy < this.loy) this.loy = loy;
    if (hix > this.hix) this.hix = hix;
    if (hiy > this.hiy) this.hiy = hiy;
  }
  get isEmpty() { return this.lox > this.hix; }
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ assetsBase?: string }} options assetsBase は assets の場所（img/・fonts/ がある所）
   */
  constructor(canvas, { assetsBase = 'assets' } = {}) {
    this.canvas = canvas;
    this.assetsBase = assetsBase.replace(/\/+$/, '');
    /** 最後に描いたシーンのキャンバスの大きさとカメラ（入力変換に使う） */
    this.canvasSize = [DEFAULT_CANVAS_W, DEFAULT_CANVAS_H];
    this.camera = { x0: 1, x1: 0, y0: 0, y1: 1, t0: 0, t1: 0 };
    /** 0.5 秒ごとの計測値（onStats でも届く） */
    this.stats = {
      fps: 0, cpuMs: 0, packMs: 0, gpuMs: 0, blobs: 0, points: 0, drawCalls: 0, foldedBlobs: 0,
      textTextures: 0, textMB: 0, textBakes: 0, textBakeMaxMs: 0, width: 0, height: 0, samples: 0, renderScale: 1,
    };
    /** @type {((stats: object) => void) | null} */
    this.onStats = null;

    this.renderScale = 1;
    this.msaa = true;
    this.cssWidth = Math.max(1, canvas.clientWidth || DEFAULT_CANVAS_W);
    this.cssHeight = Math.max(1, canvas.clientHeight || DEFAULT_CANVAS_H);
    this.dpr = 1;

    this.reader = new SceneReader();
    this.clipper = new EarClipper();

    // CPU の詰め込み（足りないときだけ倍に）
    this.pointData = new Float32Array(DATA_W * 4 * 4);
    this.blobData = new Float32Array(DATA_W * 4 * 4);
    this.shapeData = new Float32Array(SHAPE_FLOATS * 256);
    this.polyData = new Float32Array(POLY_FLOATS * 1024);
    this.blobFolded = new Uint8Array(128);
    this.blobShadow = new Uint8Array(128);
    this.blobM = new Int32Array(128);
    this.capsuleClips = new Float32Array(4 * 64);
    // 文字 1 つ = 16 個（中心・軸 x・軸 y・影のずれ・字の色・縁の色）と、不透明度・テクスチャ
    this.textData = new Float32Array(16 * 16);
    this.textAlpha = new Float32Array(16);
    this.textTextures = [];
    this.textCount = 0;
    // 多角形の上と下の色（乗算済みのリニア）
    this.polyTop = new Float32Array(4);
    this.polyBottom = new Float32Array(4);
    this.uniformData = new Float32Array(36);
    this.backLayer = new BlobLayer();
    this.frontLayer = new BlobLayer();
    this.capsBackBounds = new WorldBounds();
    this.capsFrontBounds = new WorldBounds();
    this.scissorRect = new Int32Array(4);
    // ブロブの形を調べた結果（blobGeometry。使い回す）
    this.g = { cx: 0, cy: 0, cuvx: 0, cuvy: 0, m0: 0, m1: 0, m2: 0, m3: 0, radius: 0, inflate: 0, orient: 1, folded: false,
      lox: 0, loy: 0, hix: 0, hiy: 0 };
    // 詰め込みの範囲
    this.capsBackStart = 0; this.capsBackEnd = 0;
    this.capsFrontStart = 0; this.capsFrontEnd = 0;
    this.effectsStart = 0; this.effectsEnd = 0;
    this.polyBackStart = 0; this.polyBackEnd = 0;
    this.polyFrontStart = 0; this.polyFrontEnd = 0;
    this.blobCount = 0;
    this.pointCount = 0;

    // 背景の絵（名前 → 絵 / テクスチャ）。絵は文脈が失われても残し、テクスチャは作り直す
    this.imageFiles = null;   // index.json（名前 → ファイル）
    this.imageSources = new Map();
    this.imageTextures = new Map();
    this.imageRequested = new Set();
    this.fontsRequested = false;

    /** 描いているフレームの値（#encodeScene が入れ、#resolveShadows・#drawShapes などが読む） */
    this.frame = { slot: null, W: 0, H: 0, fit: 1, originX: 0, originY: 0, draws: 0 };
    this.frameCounter = 0;
    this.statFrames = 0;
    this.statStart = 0;
    this.statCPU = 0;
    this.statPack = 0;
    /** GPU の時間（EXT_disjoint_timer_query_webgl2 があるときだけ。Android の Chrome などでは無いので 0 のまま） */
    this.gpuMs = 0;
    this.queryFree = [];
    this.queryPending = [];

    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('このブラウザでは WebGL2 が使えない');
    this.gl = gl;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      // 文脈が戻るのを待つ（preventDefault しないと戻らない）。戻るまで draw は何もしない
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.#initGL();
      this.lost = false;
    });
    this.textCache = new TextTextureCache(gl);
    this.#initGL();
  }

  // MARK: - 読み込み

  /** 背景の絵と字体を読む（どちらも待つ）。描き始める前に呼ぶ */
  async load() {
    await Promise.all([this.loadImages(), this.loadFonts()]);
  }

  /**
   * 背景の絵を読んで、テクスチャにしておく（1024×1536 で数 ms かかるので、遊んでいる間に読まないように）。
   * 場面の頭の「絵の番号」は文字の表の名前（play_bg など）。ここに無い名前が来たら、初めて出たときに読み始める
   * （読めるまでは色のグラデーション。iOS は初めて使うときに読む）
   */
  async loadImages(names = DEFAULT_BG_IMAGES) {
    await this.#loadIndex();
    await Promise.all(names.map((n) => this.#loadImage(n)));
    if (!this.lost) for (const n of names) this.#imageTexture(n);
  }

  /** 字体（'KumoponRounded'）を読む。読めるまで文字は焼かない */
  async loadFonts() {
    this.fontsRequested = true;
    try {
      await ensureFonts(this.assetsBase);
    } catch (e) {
      console.warn('描画: 字体を読めない', e);
    }
    this.textCache.fontsReady = true;
    if (!this.lost) this.textCache.warmUp();
  }

  async #loadIndex() {
    if (this.imageFiles) return;
    this.imageFiles = new Map();
    try {
      const res = await fetch(`${this.assetsBase}/img/index.json`);
      if (res.ok) for (const it of await res.json()) this.imageFiles.set(it.name, it.file);
    } catch (e) {
      console.warn('描画: 絵の一覧（img/index.json）を読めない', e);
    }
  }

  async #loadImage(name) {
    if (this.imageSources.has(name) || this.imageRequested.has(name)) return;
    this.imageRequested.add(name);
    await this.#loadIndex();
    const file = this.imageFiles.get(name) || `${name}.jpg`;
    const img = new Image();
    img.decoding = 'async';
    img.src = `${this.assetsBase}/img/${file}`;
    try {
      await img.decode();
      this.imageSources.set(name, img);
    } catch {
      console.warn(`描画: 背景の絵が読めない: ${name}`);
    }
  }

  /** 背景の絵のテクスチャ（無ければ読み始めて null。読めたら次のフレームから使う） */
  #imageTexture(name) {
    if (!name) return null;
    const t = this.imageTextures.get(name);
    if (t) return t;
    const img = this.imageSources.get(name);
    if (!img) {
      if (!this.imageRequested.has(name)) this.#loadImage(name);
      return null;
    }
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // sRGB として読むので、シェーダーで読むとリニアの色になる（iOS の MTKTextureLoader の .SRGB: true と同じ）
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.imageTextures.set(name, tex);
    return tex;
  }

  // MARK: - 大きさと重さの段

  /**
   * 画面の大きさ（CSS の px）と画素の比。canvas の画素数は css × dpr × renderScale（拡大は CSS に任せる）。
   * canvas の CSS の大きさは呼ぶ側が決める
   */
  resize(cssWidth, cssHeight, devicePixelRatio = window.devicePixelRatio || 1) {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.dpr = Math.max(0.5, devicePixelRatio || 1);
    this.#applySize();
  }

  /**
   * 重さの段。renderScale（0.25〜1）で描く解像度を下げ、msaa で 4x の縁のなめらかさを入れ切りする。
   * 既定は renderScale 1・msaa あり
   */
  setQuality({ renderScale = this.renderScale, msaa = this.msaa } = {}) {
    this.renderScale = clean(renderScale, 0.25, 1, 1);
    this.msaa = !!msaa;
    this.#applySize();
  }

  #applySize() {
    const w = Math.max(1, Math.round(this.cssWidth * this.dpr * this.renderScale));
    const h = Math.max(1, Math.round(this.cssHeight * this.dpr * this.renderScale));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  // MARK: - 入力変換（画面に固定された座標。カメラの回転・ズーム・揺れは含めない）

  /** 画面の点（clientX・clientY）→ 論理キャンバスの [x, y]（CanvasFit.canvasPoint と同じ） */
  canvasPoint(clientX, clientY, out = [0, 0]) {
    const rect = this.canvas.getBoundingClientRect();
    const vw = rect.width, vh = rect.height;
    const cw = Math.max(this.canvasSize[0], 1), ch = Math.max(this.canvasSize[1], 1);
    const s = Math.max(Math.min(vw / cw, vh / ch), 1e-6);
    const ox = (vw - cw * s) * 0.5, oy = (vh - ch * s) * 0.5;
    out[0] = (clientX - rect.left - ox) / s;
    out[1] = (clientY - rect.top - oy) / s;
    return out;
  }

  // MARK: - GL の準備

  #initGL() {
    const gl = this.gl;
    this.textCache.reset(gl);
    this.imageTextures.clear();
    this.targets = null;
    this.state = { program: null, blend: -1, stencil: -1, vao: null };

    const P = (vs, fs, label, attribs) => this.#program(vs, fs, label, attribs);
    const polyAttribs = ['aPos', 'aColor'];
    const shapeAttribs = ['aColor', 'aColor2', 'aAB', 'aClip', 'aParams', 'aKind'];
    this.programs = {
      bg: P(SH.fullscreenVS, SH.backgroundFS, 'background'),
      resolve: P(SH.fullscreenVS, SH.shadowResolveFS, 'shadowResolve'),
      flash: P(SH.fullscreenVS, SH.flashFS, 'flash'),
      present: P(SH.fullscreenVS, SH.presentFS, 'present'),
      poly: P(SH.polyVS, SH.polyFS, 'poly', polyAttribs),
      blob: P(SH.blobVS, SH.blobFS, 'blob'),
      blobShadow: P(SH.blobShadowVS, SH.blobShadowFS, 'blobShadow'),
      blobStencil: P(SH.blobVS, SH.stencilOnlyFS, 'blobStencil'),
      blobShadowStencil: P(SH.blobShadowVS, SH.stencilOnlyFS, 'blobShadowStencil'),
      shape: P(SH.shapeVS, SH.shapeFS, 'shape', shapeAttribs),
      shapeShadow: P(SH.shapeVS, SH.shapeShadowFS, 'shapeShadow', shapeAttribs),
      text: P(SH.textVS, SH.textFS, 'text'),
    };
    // テクスチャの番号（0 = ブロブ・絵 A・文字・描いた絵、1 = 粒・絵 B）
    const samplers = [
      ['bg', 'imageA', 0], ['bg', 'imageB', 1], ['present', 'uScene', 0], ['text', 'uTex', 0],
      ['blob', 'uBlobs', 0], ['blob', 'uPoints', 1], ['blobShadow', 'uBlobs', 0], ['blobShadow', 'uPoints', 1],
      ['blobStencil', 'uBlobs', 0], ['blobStencil', 'uPoints', 1],
      ['blobShadowStencil', 'uBlobs', 0], ['blobShadowStencil', 'uPoints', 1],
    ];
    for (const [p, name, unit] of samplers) {
      const prog = this.programs[p];
      const loc = prog.loc(name);
      if (loc !== null) {
        gl.useProgram(prog.program);
        gl.uniform1i(loc, unit);
      }
    }
    gl.useProgram(null);

    // 共有の uniform block（0 = Frame、1 = RainbowTable）
    this.frameUBO = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUBO);
    gl.bufferData(gl.UNIFORM_BUFFER, 144, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.frameUBO);
    this.rainbowUBO = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.rainbowUBO);
    gl.bufferData(gl.UNIFORM_BUFFER, rainbowTable(), gl.STATIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.rainbowUBO);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    this.emptyVAO = gl.createVertexArray();
    this.slots = [];
    for (let i = 0; i < SLOTS; i++) this.slots.push(new FrameSlot(gl));
    this.slotIndex = 0;

    // 絵が無いときに差しておく 1×1 の白（シェーダーは絵を読まないが、差さないと読み先が無い）
    this.blankTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blankTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // 4x MSAA が SRGB8_ALPHA8 で使えるか（使えなければ MSAA なしで描く）
    const counts = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.SRGB8_ALPHA8, gl.SAMPLES);
    let samples = 0;
    if (counts) for (const c of counts) if (c <= 4 && c > samples) samples = c;
    this.maxSamples = samples;

    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queryFree.length = 0;
    this.queryPending.length = 0;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  #program(vsSrc, fsSrc, label, attribs = null) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        const log = gl.getShaderInfoLog(s);
        const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)} ${l}`).join('\n');
        throw new Error(`描画: シェーダー ${label} が通らない\n${log}\n${lines}`);
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    if (attribs) attribs.forEach((name, i) => gl.bindAttribLocation(program, i, name));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`描画: シェーダー ${label} がつながらない\n${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    const blocks = [['Frame', 0], ['RainbowTable', 1]];
    for (const [name, binding] of blocks) {
      const idx = gl.getUniformBlockIndex(program, name);
      if (idx !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, idx, binding);
    }
    const locs = new Map();
    return {
      program,
      label,
      loc(name) {
        if (!locs.has(name)) locs.set(name, gl.getUniformLocation(program, name));
        return locs.get(name);
      },
    };
  }

  /** 描く先（MSAA のレンダーバッファ・解決先のテクスチャ・ステンシル）。大きさか段が変わったときだけ作り直す */
  #ensureTargets(w, h) {
    const samples = this.msaa ? this.maxSamples : 0;
    const t = this.targets;
    if (t && t.w === w && t.h === h && t.samples === samples) return true;
    const gl = this.gl;
    if (t) {
      gl.deleteFramebuffer(t.sceneFBO);
      gl.deleteTexture(t.sceneTex);
      if (t.sceneStencil) gl.deleteRenderbuffer(t.sceneStencil);
      if (t.msaaFBO) gl.deleteFramebuffer(t.msaaFBO);
      if (t.msaaColor) gl.deleteRenderbuffer(t.msaaColor);
      if (t.msaaStencil) gl.deleteRenderbuffer(t.msaaStencil);
    }
    const nt = { w, h, samples, sceneFBO: null, sceneTex: null, sceneStencil: null, msaaFBO: null, msaaColor: null, msaaStencil: null };
    nt.sceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, nt.sceneTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.SRGB8_ALPHA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    nt.sceneFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, nt.sceneFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, nt.sceneTex, 0);
    if (samples > 0) {
      nt.msaaColor = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, nt.msaaColor);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.SRGB8_ALPHA8, w, h);
      nt.msaaStencil = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, nt.msaaStencil);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, w, h);
      nt.msaaFBO = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, nt.msaaFBO);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, nt.msaaColor);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, nt.msaaStencil);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        console.warn('描画: MSAA の描き先が作れない（MSAA なしで描く）');
        this.maxSamples = 0;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.targets = nt;
        nt.samples = -1;   // 次で作り直す
        return false;
      }
    } else {
      nt.sceneStencil = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, nt.sceneStencil);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, nt.sceneStencil);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, nt.sceneFBO);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    this.targets = nt;
    if (!ok) console.warn('描画: 描き先が作れない');
    return ok;
  }

  // MARK: - 描く

  /**
   * 1 フレーム描く。scene は engine.scene() の戻り値（{ f, strings }）、timeSec は秒（背景の水玉・にじの帯の流れに使う）。
   * scene.f は wasm のメモリの上の view なので、このフレームのうちに読み終える（GPU へ上げるまでここで済ませる）
   */
  draw(scene, timeSec) {
    const frameStart = performance.now();
    if (this.lost || this.gl.isContextLost()) return;
    if (!this.fontsRequested) this.loadFonts();
    const gl = this.gl;
    const r = this.reader;
    if (scene) r.read(scene); else { r.f = null; r.ok = false; }
    const headOk = r.f !== null && r.f.length >= HEADER_FLOATS && r.f[HEAD.VERSION] === SCENE_VERSION;
    this.headOk = headOk;
    const f = r.f;
    const head = this.#headValue;

    const W = this.canvas.width, H = this.canvas.height;
    if (W < 1 || H < 1) return;
    const csx = head(HEAD.CANVAS_W, 0), csy = head(HEAD.CANVAS_H, 0);
    const cw = csx > 1 && csy > 1 ? csx : DEFAULT_CANVAS_W;
    const ch = csx > 1 && csy > 1 ? csy : DEFAULT_CANVAS_H;
    this.canvasSize[0] = cw;
    this.canvasSize[1] = ch;

    // 変換（シーンの値は有限・範囲内に直してから使う。NaN のピボットで全体が消えたり、はさみの計算が落ちたりしないように）
    // CanvasFit.clip と同じアスペクトフィット
    const fit = Math.max(Math.min(W / cw, H / ch), 1e-6);
    const originX = (W - cw * fit) * 0.5, originY = (H - ch * fit) * 0.5;
    const rotation = head(HEAD.ROTATION, 0);
    const z0 = head(HEAD.ZOOM, 1);
    const zoom = z0 > 1e-3 ? Math.min(Math.max(z0, 0.05), 50) : 1;
    const px0 = head(HEAD.PIVOT_X, NaN), py0 = head(HEAD.PIVOT_Y, NaN);
    const pivotX = Number.isFinite(px0) && Number.isFinite(py0) ? px0 : cw * 0.5;
    const pivotY = Number.isFinite(px0) && Number.isFinite(py0) ? py0 : ch * 0.5;
    const sx0 = head(HEAD.SHAKE_X, NaN), sy0 = head(HEAD.SHAKE_Y, NaN);
    const shakeOk = Number.isFinite(sx0) && Number.isFinite(sy0);
    const shakeX = shakeOk ? clean(sx0, -200, 200, 0) : 0, shakeY = shakeOk ? clean(sy0, -200, 200, 0) : 0;
    // 画面に固定した平行移動（揺れと同じ所にかける）
    const hx0 = head(HEAD.SHIFT_X, NaN), hy0 = head(HEAD.SHIFT_Y, NaN);
    const shiftOk = Number.isFinite(hx0) && Number.isFinite(hy0);
    const shiftX = shiftOk ? clean(hx0, -400, 400, 0) : 0, shiftY = shiftOk ? clean(hy0, -400, 400, 0) : 0;
    // CameraTransform(rotation:pivot:zoom:shake:)
    const cam = this.camera;
    const cr = Math.cos(rotation), sr = Math.sin(rotation);
    cam.x0 = cr * zoom; cam.x1 = sr * zoom;
    cam.y0 = -sr * zoom; cam.y1 = cr * zoom;
    cam.t0 = pivotX - (cam.x0 * pivotX + cam.y0 * pivotY) + shakeX + shiftX;
    cam.t1 = pivotY - (cam.x1 * pivotX + cam.y1 * pivotY) + shakeY + shiftY;

    const imageA = headOk ? this.#imageTexture(r.string(f[HEAD.BG_IMAGE])) : null;
    const imageB = (headOk ? this.#imageTexture(r.string(f[HEAD.BG_IMAGE2])) : null) || imageA;

    // FrameUniforms（std140 の並びは Metal の struct と同じ）
    const u = this.uniformData;
    u[0] = cam.x0; u[1] = cam.x1; u[2] = cam.y0; u[3] = cam.y1; u[4] = cam.t0; u[5] = cam.t1;
    u[6] = (2 * fit) / W; u[7] = (-2 * fit) / H;                    // fitScale
    u[8] = (2 * originX) / W - 1; u[9] = 1 - (2 * originY) / H;     // fitOffset
    u[10] = sr; u[11] = cr;                                          // worldDown
    u[12] = W; u[13] = H;                                            // viewSizePx
    u[14] = cw; u[15] = ch;                                          // canvasSize
    u[16] = zoom; u[17] = fit * zoom;                                // zoom・pxPerUnit
    u[18] = Number.isFinite(timeSec) ? timeSec % 3600 : 0;           // time
    u[19] = clean(head(HEAD.DOT_INTENSITY, 0.06), 0, 1, 0);          // dotIntensity
    const ddx = head(HEAD.DOT_DRIFT_X, NaN), ddy = head(HEAD.DOT_DRIFT_Y, NaN);
    const driftOk = Number.isFinite(ddx) && Number.isFinite(ddy);
    u[20] = driftOk ? ddx : (headOk ? 0 : 6); u[21] = driftOk ? ddy : (headOk ? 0 : -10);
    u[22] = imageA ? 1 : 0; u[23] = clean(head(HEAD.BG_IMAGE_MIX, 0), 0, 1, 0);
    if (headOk) {
      writeLinear(f, HEAD.BG_TOP, u, 24);
      writeLinear(f, HEAD.BG_BOTTOM, u, 28);
    } else {
      // BackgroundStyle の初めの値
      u[24] = linear(1.0); u[25] = linear(0.96); u[26] = linear(0.90); u[27] = 1;
      u[28] = linear(0.99); u[29] = linear(0.88); u[30] = linear(0.86); u[31] = 1;
    }
    u[32] = linear(SHADOW_COLOR[0]); u[33] = linear(SHADOW_COLOR[1]); u[34] = linear(SHADOW_COLOR[2]); u[35] = 1;

    this.frameCounter += 1;
    this.textCache.beginFrame(this.frameCounter);
    this.slotIndex = (this.slotIndex + 1) % SLOTS;
    const slot = this.slots[this.slotIndex];

    // CPU 側の詰め込み（頂点は作らない）。f はここで読み終える
    const packStart = performance.now();
    if (r.ok || headOk) {
      this.#packBlobs(f, r);
      this.#packShapes(f, r);
      this.#packPolygons(f, r);
      this.#prepareTexts(f, r, zoom, fit * zoom);
    } else {
      this.blobCount = 0; this.pointCount = 0;
      this.backLayer.reset(0); this.frontLayer.reset(0);
      this.capsBackStart = this.capsBackEnd = this.capsFrontStart = this.capsFrontEnd = this.effectsStart = this.effectsEnd = 0;
      this.polyBackStart = this.polyBackEnd = this.polyFrontStart = this.polyFrontEnd = 0;
      this.textCount = 0;
    }
    this.statPack += performance.now() - packStart;

    // GPU へ上げる
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUBO);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, u);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    if (this.blobCount > 0) {
      slot.points.upload(this.pointData, Math.max(this.pointCount, 1));
      slot.blobs.upload(this.blobData, this.blobCount * BLOB_TEXELS);
    }
    this.#uploadBuffer(slot, 'shape', this.shapeData, this.effectsEnd * SHAPE_FLOATS);
    this.#uploadBuffer(slot, 'poly', this.polyData, this.polyFrontEnd * POLY_FLOATS);

    let draws = 0;
    if (this.#ensureTargets(W, H)) {
      const query = this.#beginGpuTimer();
      draws = this.#encodeScene(slot, imageA, imageB, W, H, fit, originX, originY, head(HEAD.FLASH, 0));
      this.#present(W, H);
      if (query) gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
      draws += 1;
    }
    this.#pollGpuTimers();
    this.textTextures.fill(null, 0, this.textCount);

    this.#updateStats(frameStart, performance.now(), draws, W, H);
  }

  /** 頭の値（並びが読めない・NaN なら fallback）。draw の中で head(i, fallback) として使う */
  #headValue = (i, fallback) => (this.headOk && Number.isFinite(this.reader.f[i]) ? this.reader.f[i] : fallback);

  #uploadBuffer(slot, kind, data, floats) {
    if (floats <= 0) return;
    const gl = this.gl;
    const buf = kind === 'shape' ? slot.shapeBuffer : slot.polyBuffer;
    const have = kind === 'shape' ? slot.shapeBytes : slot.polyBytes;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    if (floats * 4 > have) {
      let cap = Math.max(have, 16 * 1024);
      while (cap < floats * 4) cap *= 2;
      gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
      if (kind === 'shape') slot.shapeBytes = cap; else slot.polyBytes = cap;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, floats);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  // MARK: - 状態の切り替え（同じなら呼ばない）

  #use(prog) {
    if (this.state.program !== prog) {
      this.gl.useProgram(prog.program);
      this.state.program = prog;
    }
    return prog;
  }

  #vao(vao) {
    if (this.state.vao !== vao) {
      this.gl.bindVertexArray(vao);
      this.state.vao = vao;
    }
  }

  #blend(mode) {
    if (this.state.blend === mode) return;
    this.state.blend = mode;
    const gl = this.gl;
    switch (mode) {
      case BLEND_OPAQUE:
        gl.disable(gl.BLEND);
        gl.colorMask(true, true, true, true);
        break;
      case BLEND_PREMULTIPLIED:
        // 色は乗算済みアルファの over。アルファ（影の溜め場）はそのまま残す
        gl.enable(gl.BLEND);
        gl.colorMask(true, true, true, true);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
        break;
      case BLEND_SHADOW_ACCUMULATE:
        // アルファだけに min で溜める（MIN では係数は使われない）
        gl.enable(gl.BLEND);
        gl.colorMask(false, false, false, true);
        gl.blendEquationSeparate(gl.FUNC_ADD, gl.MIN);
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
        break;
      case BLEND_SHADOW_RESOLVE:
        // 色 = 影の色 × (1-a) + 元の色 × a、アルファは 1 に戻す
        gl.enable(gl.BLEND);
        gl.colorMask(true, true, true, true);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.DST_ALPHA, gl.ONE, gl.ZERO);
        break;
      case BLEND_NONE:
        gl.colorMask(false, false, false, false);
        break;
    }
  }

  #stencil(mode) {
    if (this.state.stencil === mode) return;
    this.state.stencil = mode;
    const gl = this.gl;
    switch (mode) {
      case STENCIL_NONE:
        gl.disable(gl.STENCIL_TEST);
        break;
      case STENCIL_FILL:
        // 巻き数を数える（表は +1、裏は -1）
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.ALWAYS, 0, 0xff);
        gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
        gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
        break;
      case STENCIL_COVER:
        // 巻き数が 0 でない所だけ塗り、塗った所は 0 に戻す（次のブロブのために）
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
        break;
    }
  }

  /** ブロブのシェーダーの描くたびの値（stride・頂点の始まり・インスタンスの始まり・影の段） */
  #blobUniforms(prog, stride, firstVertex, baseInstance, shadowMode) {
    const gl = this.gl;
    gl.uniform1i(prog.loc('uStride'), stride);
    gl.uniform1i(prog.loc('uFirstVertex'), firstVertex);
    gl.uniform1i(prog.loc('uBaseInstance'), baseInstance);
    if (shadowMode >= 0) gl.uniform1i(prog.loc('uShadowMode'), shadowMode);
  }

  // MARK: - 1 つのパスに全部を描く

  /** 描いた回数を返す */
  #encodeScene(slot, imageA, imageB, W, H, fit, originX, originY, flashRaw) {
    const gl = this.gl;
    const t = this.targets;
    const st = this.state;
    st.program = null; st.blend = -1; st.stencil = -1; st.vao = null;
    // 下の #resolveShadows などが読むこのフレームの値（関数をフレームごとに作らないため、ここに置く）
    const fr = this.frame;
    fr.slot = slot; fr.W = W; fr.H = H; fr.fit = fit; fr.originX = originX; fr.originY = originY; fr.draws = 0;

    gl.bindFramebuffer(gl.FRAMEBUFFER, t.samples > 0 ? t.msaaFBO : t.sceneFBO);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0xff);
    gl.clearColor(1, 1, 1, 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    this.#stencil(STENCIL_NONE);

    // 背景（絵があれば、2 枚とも差す。2 枚目が無ければ 1 枚目を 2 回）
    this.#use(this.programs.bg);
    this.#blend(BLEND_OPAQUE);
    this.#vao(this.emptyVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageA || this.blankTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, imageB || this.blankTexture);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    fr.draws += 1;

    this.#drawPolys(this.polyBackStart, this.polyBackEnd);

    // 奥のカプセル（影 → 本体）
    if (this.capsBackEnd > this.capsBackStart) {
      const b = this.capsBackBounds;
      this.#drawShapes(this.capsBackStart, this.capsBackEnd, 1);
      this.#resolveShadows(b.lox, b.loy, b.hix, b.hiy);
      this.#drawShapes(this.capsBackStart, this.capsBackEnd, 2);
      this.#drawShapes(this.capsBackStart, this.capsBackEnd, 3);
    }

    // ブロブ（奥の層と手前の層は、同じ詰め込みの別の範囲。影 → 体の順に層ごとに描く）
    this.#drawBlobLayer(this.backLayer);

    // 手前のカプセル（影はブロブの上に落ちる）
    if (this.capsFrontEnd > this.capsFrontStart) {
      const b = this.capsFrontBounds;
      this.#drawShapes(this.capsFrontStart, this.capsFrontEnd, 1);
      this.#resolveShadows(b.lox, b.loy, b.hix, b.hiy);
      this.#drawShapes(this.capsFrontStart, this.capsFrontEnd, 2);
      this.#drawShapes(this.capsFrontStart, this.capsFrontEnd, 3);
    }
    this.#drawPolys(this.polyFrontStart, this.polyFrontEnd);
    // 手前の壁より前の雲（口を出た雲など）
    this.#drawBlobLayer(this.frontLayer);
    // 波紋と火花（続けて並べてあるので1回で描く）
    this.#drawShapes(this.effectsStart, this.effectsEnd, 0);

    // 文字（1 つずつ。Metal の setVertexBytes と同じ。数は多くて十数個）
    if (this.textCount > 0) {
      const prog = this.#use(this.programs.text);
      this.#blend(BLEND_PREMULTIPLIED);
      this.#vao(this.emptyVAO);
      gl.activeTexture(gl.TEXTURE0);
      const d = this.textData;
      for (let i = 0; i < this.textCount; i++) {
        const k = i * 16;
        gl.bindTexture(gl.TEXTURE_2D, this.textTextures[i]);
        gl.uniform2f(prog.loc('uCenter'), d[k], d[k + 1]);
        gl.uniform2f(prog.loc('uAxisX'), d[k + 2], d[k + 3]);
        gl.uniform2f(prog.loc('uAxisY'), d[k + 4], d[k + 5]);
        gl.uniform2f(prog.loc('uShadowUV'), d[k + 6], d[k + 7]);
        gl.uniform4f(prog.loc('uFill'), d[k + 8], d[k + 9], d[k + 10], d[k + 11]);
        gl.uniform4f(prog.loc('uOutline'), d[k + 12], d[k + 13], d[k + 14], d[k + 15]);
        gl.uniform1f(prog.loc('uAlpha'), this.textAlpha[i]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        fr.draws += 1;
      }
    }

    // 閃光（0.35 まで）
    const flash = Math.min(Math.max(Number.isFinite(flashRaw) ? flashRaw : 0, 0), 0.35);
    if (flash > 0.001) {
      const prog = this.#use(this.programs.flash);
      this.#blend(BLEND_PREMULTIPLIED);
      this.#vao(this.emptyVAO);
      gl.uniform1f(prog.loc('uFlash'), flash);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      fr.draws += 1;
    }
    this.#stencil(STENCIL_NONE);
    return fr.draws;
  }

  /** 影を溜めた所を色に混ぜる（箱の所だけ、はさみで切って） */
  #resolveShadows(lox, loy, hix, hiy) {
    const fr = this.frame;
    if (!this.#scissor(lox, loy, hix, hiy, 8, fr.W, fr.H, fr.fit, fr.originX, fr.originY)) return;
    const gl = this.gl;
    const s = this.scissorRect;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(s[0], s[1], s[2], s[3]);
    this.#use(this.programs.resolve);
    this.#blend(BLEND_SHADOW_RESOLVE);
    this.#vao(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    fr.draws += 1;
  }

  #drawPolys(start, end) {
    if (end <= start) return;
    this.#use(this.programs.poly);
    this.#blend(BLEND_PREMULTIPLIED);
    this.#vao(this.frame.slot.polyVAO);
    this.gl.drawArrays(this.gl.TRIANGLES, start, end - start);
    this.frame.draws += 1;
  }

  /** pass: 0 = そのまま、1 = 影の溜め、2 = カプセルの縁、3 = カプセルの中身 */
  #drawShapes(start, end, pass) {
    if (end <= start) return;
    const gl = this.gl;
    const slot = this.frame.slot;
    const prog = this.#use(pass === 1 ? this.programs.shapeShadow : this.programs.shape);
    gl.uniform1i(prog.loc('uPass'), pass);
    this.#blend(pass === 1 ? BLEND_SHADOW_ACCUMULATE : BLEND_PREMULTIPLIED);
    this.#vao(slot.shapeVAO);
    // baseInstance の代わりに、属性の読み始めをずらす
    gl.bindBuffer(gl.ARRAY_BUFFER, slot.shapeBuffer);
    const stride = SHAPE_FLOATS * 4, base = start * stride;
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, base);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, base + 16);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, base + 32);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, base + 48);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, stride, base + 64);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, base + 80);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, end - start);
    this.frame.draws += 1;
  }

  /** 1 つの層の影（まとめて → 裏返る輪はステンシル → resolve）と体 */
  #drawBlobLayer(layer) {
    if (layer.count <= 0) return;
    const gl = this.gl;
    const fr = this.frame;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fr.slot.blobs.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fr.slot.points.texture);
    this.#vao(this.emptyVAO);
    if (layer.anyShadow) {
      // (stride, 0) = 全部まとめて（裏返る輪の扇は飛ばす）
      const prog = this.#use(this.programs.blobShadow);
      this.#blobUniforms(prog, layer.maxM, 0, layer.start, 0);
      this.#blend(BLEND_SHADOW_ACCUMULATE);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 9 * layer.maxM, layer.count);
      fr.draws += 1;
      if (layer.folded > 0) fr.draws += this.#encodeFoldedShadows(layer.start, layer.end);
      this.#resolveShadows(layer.lox, layer.loy, layer.hix, layer.hiy);
      this.#vao(this.emptyVAO);
    }
    fr.draws += this.#encodeBlobBodies(layer.start, layer.end);
  }

  /** MSAA を解決して、sRGB に戻して画面へ */
  #present(W, H) {
    const gl = this.gl;
    const t = this.targets;
    if (t.samples > 0) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.msaaFBO);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.sceneFBO);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      // MSAA の中身はもう要らない（タイルの GPU でメモリへ書き戻さないように）
      gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, [gl.COLOR_ATTACHMENT0, gl.DEPTH_STENCIL_ATTACHMENT]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    this.#use(this.programs.present);
    this.#blend(BLEND_OPAQUE);
    this.#vao(this.emptyVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.sceneTex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 次のフレームの書き込みで使うので、描き先のテクスチャを差したままにしない
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * ワールドの箱を、描き先の画素のはさみの矩形にする（iOS の PixelMap.scissor）。scissorRect に GL の向き（下が 0）で入れる。
   * とても大きい値・無限大でも整数への変換で壊れないよう、小数のうちに画面へ収める
   */
  #scissor(lox, loy, hix, hiy, pad, W, H, fit, originX, originY) {
    if (lox > hix) return false;
    const cam = this.camera;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const wx = k & 1 ? hix : lox, wy = k & 2 ? hiy : loy;
      const px = (cam.x0 * wx + cam.y0 * wy + cam.t0) * fit + originX;
      const py = (cam.x1 * wx + cam.y1 * wy + cam.t1) * fit + originY;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
    let fx0 = Math.floor(x0 - pad), fy0 = Math.floor(y0 - pad), fx1 = Math.ceil(x1 + pad), fy1 = Math.ceil(y1 + pad);
    // NaN が混じったら全画面（影の無い所はアルファが 1 なので混ぜても色は変わらない）
    if (Number.isNaN(fx0) || Number.isNaN(fy0) || Number.isNaN(fx1) || Number.isNaN(fy1)) {
      fx0 = 0; fy0 = 0; fx1 = W; fy1 = H;
    }
    const ix0 = Math.min(Math.max(fx0, 0), W), iy0 = Math.min(Math.max(fy0, 0), H);
    const ix1 = Math.min(Math.max(fx1, 0), W), iy1 = Math.min(Math.max(fy1, 0), H);
    if (ix1 <= ix0 || iy1 <= iy0) return false;
    const s = this.scissorRect;
    s[0] = ix0; s[1] = H - iy1; s[2] = ix1 - ix0; s[3] = iy1 - iy0;
    return true;
  }

  // MARK: - ブロブ

  /** 粒と描画パラメータを詰める（奥の層の後に手前の層を続けて詰める） */
  #packBlobs(f, r) {
    const total = r.blobs.count + r.blobsFront.count;
    this.blobCount = 0;
    this.pointCount = 0;
    this.backLayer.reset(0);
    this.frontLayer.reset(0);
    if (total === 0) return;
    // 行の幅で切り上げた長さにしておく（DataTexture.upload は行ごとに上げる）
    const ptTexels = Math.ceil(Math.max(r.blobPoints, 1) / DATA_W) * DATA_W;
    this.pointData = grow(this.pointData, ptTexels * 4);
    const instTexels = Math.ceil((total * BLOB_TEXELS) / DATA_W) * DATA_W;
    this.blobData = grow(this.blobData, instTexels * 4);
    if (this.blobFolded.length < total) {
      const cap = Math.max(total, this.blobFolded.length * 2);
      this.blobFolded = new Uint8Array(cap);
      this.blobShadow = new Uint8Array(cap);
      this.blobM = new Int32Array(cap);
    }
    this.#packLayer(f, r.blobs, this.backLayer);
    this.#packLayer(f, r.blobsFront, this.frontLayer);
  }

  /** 1 つの層を詰める（blobCount・pointCount は層をまたいで続ける） */
  #packLayer(f, sec, layer) {
    layer.reset(this.blobCount);
    const pts = this.pointData, inst = this.blobData, g = this.g;
    let k = this.blobCount;
    let c = this.pointCount;
    for (let s = 0; s < sec.count; s++) {
      const o = sec.off[s];
      const n = f[o + BLOB.N];
      const alpha = f[o + BLOB.ALPHA];
      if (n < 3 || !Number.isFinite(alpha) || alpha <= 0.002) continue;
      if (!this.#blobGeometry(f, o, pts, c)) continue;
      const q = k * BLOB_TEXELS * 4;
      writeLinear(f, o + BLOB.BODY, inst, q);
      writeLinear(f, o + BLOB.RIM, inst, q + 4);
      writeLinear(f, o + BLOB.HIGHLIGHT, inst, q + 8);
      writeLinear(f, o + BLOB.CHEEK, inst, q + 12);
      writeLinear(f, o + BLOB.EYE, inst, q + 16);
      inst[q + 20] = g.cx; inst[q + 21] = g.cy; inst[q + 22] = g.cuvx; inst[q + 23] = g.cuvy;
      const rot = Number.isFinite(f[o + BLOB.UV_ROTATION]) ? f[o + BLOB.UV_ROTATION] : 0;
      inst[q + 24] = Math.cos(rot); inst[q + 25] = Math.sin(rot);
      let lx = f[o + BLOB.LOOK_X], ly = f[o + BLOB.LOOK_Y];
      if (!(Number.isFinite(lx) && Number.isFinite(ly))) { lx = 0; ly = 0; }
      const lookLen = Math.sqrt(lx * lx + ly * ly);
      if (lookLen > 0.3) { lx *= 0.3 / lookLen; ly *= 0.3 / lookLen; }
      inst[q + 26] = lx; inst[q + 27] = ly;
      inst[q + 28] = g.m0; inst[q + 29] = g.m1; inst[q + 30] = g.m2; inst[q + 31] = g.m3;
      inst[q + 32] = c; inst[q + 33] = n; inst[q + 34] = g.inflate; inst[q + 35] = g.radius;
      inst[q + 36] = clean(f[o + BLOB.EYE_OPEN], 0, 1, 1);
      inst[q + 37] = clean(f[o + BLOB.SQUINT], 0, 1, 0);
      inst[q + 38] = clean(f[o + BLOB.FACE_SCALE], 0.05, 3, 1);
      inst[q + 39] = clean(f[o + BLOB.MOUTH], 0, 0.3, 0);
      inst[q + 40] = clean(f[o + BLOB.SWEAT], 0, 1, 0);
      inst[q + 41] = clean(f[o + BLOB.GLOW], 0, 1, 0);
      inst[q + 42] = Math.min(alpha, 1);
      inst[q + 43] = g.orient;
      const shadow = f[o + BLOB.SHADOW] > 0.5;
      inst[q + 44] = f[o + BLOB.FACE_VISIBLE] > 0.5 ? 1 : 0;
      inst[q + 45] = shadow ? 1 : 0;
      inst[q + 46] = g.folded ? 1 : 0;
      inst[q + 47] = clean(f[o + BLOB.RAINBOW], 0, 1, 0);
      const rfx = f[o + BLOB.RAINBOW_FROM_X], rfy = f[o + BLOB.RAINBOW_FROM_Y];
      const rfOk = Number.isFinite(rfx) && Number.isFinite(rfy);
      inst[q + 48] = rfOk ? rfx : 0; inst[q + 49] = rfOk ? rfy : 0;
      inst[q + 50] = clean(f[o + BLOB.MOOD], -1, 1, 0);
      inst[q + 51] = clean(f[o + BLOB.RIM_SCALE], 0.5, 3, 1);
      this.blobFolded[k] = g.folded ? 1 : 0;
      this.blobShadow[k] = shadow ? 1 : 0;
      this.blobM[k] = n * 3;
      if (g.folded) layer.folded += 1;
      if (shadow) {
        layer.anyShadow = true;
        const e = g.inflate + SHADOW_SPREAD;
        if (g.lox - e < layer.lox) layer.lox = g.lox - e;
        if (g.loy - e < layer.loy) layer.loy = g.loy - e;
        if (g.hix + e > layer.hix) layer.hix = g.hix + e;
        if (g.hiy + e > layer.hiy) layer.hiy = g.hiy + e;
      }
      c += n;
      k += 1;
      if (n * 3 > layer.maxM) layer.maxM = n * 3;
    }
    this.pointCount = c;
    this.blobCount = k;
    layer.end = k;
  }

  /**
   * 1つの輪を調べて粒を pts の c 番目から書く。描けない輪は false（iOS の BlobRenderer.blobGeometry と同じ手順）。
   * 結果は this.g に入れる
   */
  #blobGeometry(f, o, pts, c) {
    const n = f[o + BLOB.N];
    const hasUV = f[o + BLOB.M] === n;
    const P = o + BLOB.OUTLINE;   // 外周 x y …
    const U = P + 2 * n;          // restUV u v …
    const ox = f[P], oy = f[P + 1];
    // 1回目: NaN・面積・重心・周の長さ
    let a2 = 0, cAccX = 0, cAccY = 0, uvAccX = 0, uvAccY = 0;
    let sumPX = 0, sumPY = 0, sumUVX = 0, sumUVY = 0, perim = 0;
    let lox = ox, loy = oy, hix = ox, hiy = oy;
    const uv0x = hasUV ? f[U] : 0, uv0y = hasUV ? f[U + 1] : 0;
    for (let i = 0; i < n; i++) {
      const px = f[P + 2 * i], py = f[P + 2 * i + 1];
      if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
      const i1 = i + 1 === n ? 0 : i + 1;
      const qx = f[P + 2 * i1], qy = f[P + 2 * i1 + 1];
      const ax = px - ox, ay = py - oy, cx = qx - ox, cy = qy - oy;
      const cr = ax * cy - ay * cx;
      a2 += cr;
      cAccX += (ax + cx) * cr;
      cAccY += (ay + cy) * cr;
      sumPX += ax;
      sumPY += ay;
      const dx = qx - px, dy = qy - py;
      perim += Math.sqrt(dx * dx + dy * dy);
      if (hasUV) {
        const uax = f[U + 2 * i], uay = f[U + 2 * i + 1];
        if (!Number.isFinite(uax) || !Number.isFinite(uay)) return false;
        const ubx = f[U + 2 * i1], uby = f[U + 2 * i1 + 1];
        uvAccX += (uax + ubx - uv0x * 2) * cr;
        uvAccY += (uay + uby - uv0y * 2) * cr;
        sumUVX += uax;
        sumUVY += uay;
      }
      if (px < lox) lox = px; if (px > hix) hix = px;
      if (py < loy) loy = py; if (py > hiy) hiy = py;
    }
    // ほぼ1点に縮んだ輪・桁あふれは描かない
    if (!Number.isFinite(a2) || !Number.isFinite(perim) || !(perim > 1) || !Number.isFinite(cAccX) || !Number.isFinite(cAccY)) return false;
    const rr = f[o + BLOB.REST_RADIUS];
    const restR = Number.isFinite(rr) && rr > 1e-3 ? rr : 0;
    const radius = restR > 0 ? restR : Math.max(perim / (2 * Math.PI), 0.5);
    const inflate = clean(f[o + BLOB.INFLATE], 0, 64, 0);
    const meanPX = ox + sumPX / n, meanPY = oy + sumPY / n;
    const meanUVX = hasUV ? sumUVX / n : 0, meanUVY = hasUV ? sumUVY / n : 0;
    const icx = f[o + BLOB.CX], icy = f[o + BLOB.CY];
    const fbOk = Number.isFinite(icx) && Number.isFinite(icy);
    const fbx = fbOk ? icx : meanPX, fby = fbOk ? icy : meanPY;
    const orient = a2 >= 0 ? 1 : -1;

    // 面積が周に比べて小さすぎる（8の字・一直線）と面積重心が当てにならないので、点の平均を使ってステンシルで塗る
    let twisted = Math.abs(a2) <= Math.max(2, 2e-3 * perim * perim);
    let centerX = meanPX, centerY = meanPY;
    let cuvx = meanUVX, cuvy = meanUVY;
    if (!twisted) {
      const gx = ox + cAccX / (3 * a2), gy = oy + cAccY / (3 * a2);
      if (gx >= lox && gx <= hix && gy >= loy && gy <= hiy) {
        centerX = gx; centerY = gy;
        if (hasUV) { cuvx = uv0x + uvAccX / (3 * a2); cuvy = uv0y + uvAccY / (3 * a2); }
        else { cuvx = (gx - fbx) / radius; cuvy = (gy - fby) / radius; }
      } else {
        twisted = true;
      }
    }
    if (!hasUV) { cuvx = (centerX - fbx) / radius; cuvy = (centerY - fby) / radius; }

    // 2回目: 重心から見て輪が裏返っていないか ＋ 粒を書き出す
    let folded = twisted;
    for (let i = 0; i < n; i++) {
      const px = f[P + 2 * i], py = f[P + 2 * i + 1];
      if (!folded) {
        const i1 = i + 1 === n ? 0 : i + 1;
        const ax = px - centerX, ay = py - centerY;
        const bx = f[P + 2 * i1] - centerX, by = f[P + 2 * i1 + 1] - centerY;
        const cr = (ax * by - ay * bx) * orient;
        if (cr < -1e-3 * (ax * ax + ay * ay + bx * bx + by * by)) folded = true;
      }
      const w = (c + i) * 4;
      pts[w] = px;
      pts[w + 1] = py;
      if (hasUV) { pts[w + 2] = f[U + 2 * i]; pts[w + 3] = f[U + 2 * i + 1]; }
      else { pts[w + 2] = (px - fbx) / radius; pts[w + 3] = (py - fby) / radius; }
    }

    const g = this.g;
    g.cx = centerX; g.cy = centerY; g.cuvx = cuvx; g.cuvy = cuvy;
    g.m0 = 0; g.m1 = 0; g.m2 = 0; g.m3 = 0;
    g.radius = radius; g.inflate = inflate; g.orient = orient; g.folded = folded;
    g.lox = lox; g.loy = loy; g.hix = hix; g.hiy = hiy;
    if (!folded) return true;

    // 輪が裏返る形（弓なりなど）は重心が体の外に出やすい。
    // 向かい合う粒の中点のうち、いちばん縁から遠い点を扇の中心にして、顔を体のいちばん太い所に置く
    let best = Renderer.#inside(centerX, centerY, f, P, n) ? Renderer.#depth2(centerX, centerY, f, P, n) : -1;
    const half = n >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + half) % n;
      const mx = (f[P + 2 * i] + f[P + 2 * j]) * 0.5, my = (f[P + 2 * i + 1] + f[P + 2 * j + 1]) * 0.5;
      if (!Renderer.#inside(mx, my, f, P, n)) continue;
      const d = Renderer.#depth2(mx, my, f, P, n);
      if (d > best) {
        best = d;
        g.cx = mx; g.cy = my;
        if (hasUV) { g.cuvx = (f[U + 2 * i] + f[U + 2 * j]) * 0.5; g.cuvy = (f[U + 2 * i + 1] + f[U + 2 * j + 1]) * 0.5; }
        else { g.cuvx = (mx - fbx) / radius; g.cuvy = (my - fby) / radius; }
      }
    }
    // 扇の三角形が重なるので、uv は三角形ごとの補間ではなく位置の1次式にする（最小二乗で restUV に合わせる）。
    // 顔が継ぎ目で切れない
    let sxx = 0, sxy = 0, syy = 0, uxx = 0, uxy = 0, uyx = 0, uyy = 0;
    for (let i = 0; i < n; i++) {
      const px = f[P + 2 * i], py = f[P + 2 * i + 1];
      const dx = px - meanPX, dy = py - meanPY;
      const ux = (hasUV ? f[U + 2 * i] : (px - fbx) / radius) - meanUVX;
      const uy = (hasUV ? f[U + 2 * i + 1] : (py - fby) / radius) - meanUVY;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
      // ux（ベクトル）+= du * d.x、uy（ベクトル）+= du * d.y
      uxx += ux * dx; uxy += uy * dx;
      uyx += ux * dy; uyy += uy * dy;
    }
    const eps = 1e-4 * (sxx + syy) + 1e-6;
    sxx += eps; syy += eps;
    const det = sxx * syy - sxy * sxy;
    if (Number.isFinite(det) && det > 1e-12) {
      let c0x = (uxx * syy - uyx * sxy) / det, c0y = (uxy * syy - uyy * sxy) / det;
      let c1x = (uyx * sxx - uxx * sxy) / det, c1y = (uyy * sxx - uxy * sxy) / det;
      // 一直線に近い輪で uv が飛ばないように、傾きは 4/半径 まで
      const cap = 4 / radius;
      const l0 = Math.sqrt(c0x * c0x + c0y * c0y), l1 = Math.sqrt(c1x * c1x + c1y * c1y);
      if (l0 > cap) { c0x *= cap / l0; c0y *= cap / l0; }
      if (l1 > cap) { c1x *= cap / l1; c1y *= cap / l1; }
      if (Number.isFinite(c0x) && Number.isFinite(c0y) && Number.isFinite(c1x) && Number.isFinite(c1y)) {
        g.m0 = c0x; g.m1 = c0y; g.m2 = c1x; g.m3 = c1y;
      }
    }
    if (g.m0 === 0 && g.m1 === 0 && g.m2 === 0 && g.m3 === 0) { g.m0 = 1 / radius; g.m3 = 1 / radius; }
    return true;
  }

  /** 点が輪の内側か（偶奇の交差数） */
  static #inside(qx, qy, f, P, n) {
    let c = false;
    let j = n - 1;
    for (let i = 0; i < n; i++) {
      const ax = f[P + 2 * i], ay = f[P + 2 * i + 1], bx = f[P + 2 * j], by = f[P + 2 * j + 1];
      if ((ay > qy) !== (by > qy) && qx < ((bx - ax) * (qy - ay)) / (by - ay) + ax) c = !c;
      j = i;
    }
    return c;
  }

  /** 縁（粒）までのいちばん近い距離の2乗 */
  static #depth2(qx, qy, f, P, n) {
    let d = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = f[P + 2 * i] - qx, dy = f[P + 2 * i + 1] - qy;
      const e = dx * dx + dy * dy;
      if (e < d) d = e;
    }
    return d;
  }

  /** 裏返る輪の影の扇はステンシルの巻き数で塗る（入り江に影がかからない）。縁のぼかしの帯はまとめた描画で描いてある */
  #encodeFoldedShadows(start, end) {
    const gl = this.gl;
    let draws = 0;
    for (let i = start; i < end; i++) {
      if (!this.blobFolded[i] || !this.blobShadow[i]) continue;
      const m = this.blobM[i];
      // (stride, 1) = 扇だけ
      let prog = this.#use(this.programs.blobShadowStencil);
      this.#blobUniforms(prog, m, 0, i, 1);
      this.#stencil(STENCIL_FILL);
      this.#blend(BLEND_NONE);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 3 * m, 1);
      prog = this.#use(this.programs.blobShadow);
      this.#blobUniforms(prog, m, 0, i, 1);
      this.#stencil(STENCIL_COVER);
      this.#blend(BLEND_SHADOW_ACCUMULATE);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 3 * m, 1);
      draws += 2;
    }
    this.#stencil(STENCIL_NONE);
    return draws;
  }

  /** 体と縁を描く。裏返らない輪は続けて1回のインスタンス描画にまとめ、裏返る輪だけステンシルで塗る */
  #encodeBlobBodies(start, end) {
    const gl = this.gl;
    let draws = 0;
    let i = start;
    while (i < end) {
      if (this.blobFolded[i]) {
        const m = this.blobM[i];
        let prog = this.#use(this.programs.blobStencil);
        this.#blobUniforms(prog, m, 0, i, -1);
        this.#stencil(STENCIL_FILL);
        this.#blend(BLEND_NONE);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3 * m, 1);
        prog = this.#use(this.programs.blob);
        this.#blobUniforms(prog, m, 0, i, -1);
        this.#stencil(STENCIL_COVER);
        this.#blend(BLEND_PREMULTIPLIED);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3 * m, 1);
        // 縁の帯（vertexStart 3m からの 6m 頂点）
        this.#stencil(STENCIL_NONE);
        gl.uniform1i(prog.loc('uFirstVertex'), 3 * m);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6 * m, 1);
        gl.uniform1i(prog.loc('uFirstVertex'), 0);
        draws += 3;
        i += 1;
        continue;
      }
      let j = i;
      let maxM = 0;
      while (j < end && !this.blobFolded[j]) {
        if (this.blobM[j] > maxM) maxM = this.blobM[j];
        j += 1;
      }
      const prog = this.#use(this.programs.blob);
      this.#blobUniforms(prog, maxM, 0, i, -1);
      this.#stencil(STENCIL_NONE);
      this.#blend(BLEND_PREMULTIPLIED);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 9 * maxM, j - i);
      draws += 1;
      i = j;
    }
    return draws;
  }

  // MARK: - カプセル・波紋・火花

  #packShapes(f, r) {
    const total = r.capsulesBack.count + r.capsulesFront.count + r.rings.count + r.sparks.count;
    this.shapeData = grow(this.shapeData, Math.max(total, 1) * SHAPE_FLOATS);
    const out = this.shapeData;
    let k = 0;
    this.capsBackStart = k;
    k = this.#packCapsules(f, r.capsulesBack, this.capsBackBounds, k);
    this.capsBackEnd = k;
    this.capsFrontStart = k;
    k = this.#packCapsules(f, r.capsulesFront, this.capsFrontBounds, k);
    this.capsFrontEnd = k;
    this.effectsStart = k;
    for (let i = 0; i < r.rings.count; i++) {
      const o = r.rings.off[i];
      const cx = f[o + RING.X], cy = f[o + RING.Y], rad = f[o + RING.RADIUS], th = f[o + RING.THICKNESS];
      if (!(Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(rad) && rad > 0 && Number.isFinite(th) && th > 0
        && f[o + RING.COLOR + 3] > 0.002)) continue;
      const q = k * SHAPE_FLOATS;
      writeLinear(f, o + RING.COLOR, out, q);
      out[q + 4] = 0; out[q + 5] = 0; out[q + 6] = 0; out[q + 7] = 0;
      out[q + 8] = cx; out[q + 9] = cy; out[q + 10] = 0; out[q + 11] = 0;
      out[q + 12] = 0; out[q + 13] = 0; out[q + 14] = 0; out[q + 15] = 0;
      out[q + 16] = rad; out[q + 17] = th; out[q + 18] = 0; out[q + 19] = 0;
      out[q + 20] = 1; out[q + 21] = 0; out[q + 22] = 0; out[q + 23] = 0;   // 種類 1 = 波紋
      k += 1;
    }
    for (let i = 0; i < r.sparks.count; i++) {
      const o = r.sparks.off[i];
      const x = f[o + SPARK.X], y = f[o + SPARK.Y], size = f[o + SPARK.SIZE];
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(size) && size > 0.05 && f[o + SPARK.COLOR + 3] > 0.002)) continue;
      const q = k * SHAPE_FLOATS;
      writeLinear(f, o + SPARK.COLOR, out, q);
      out[q + 4] = 0; out[q + 5] = 0; out[q + 6] = 0; out[q + 7] = 0;
      out[q + 8] = x; out[q + 9] = y; out[q + 10] = 0; out[q + 11] = 0;
      out[q + 12] = 0; out[q + 13] = 0; out[q + 14] = 0; out[q + 15] = 0;
      const rot = f[o + SPARK.ROTATION];
      out[q + 16] = size; out[q + 17] = 0; out[q + 18] = Number.isFinite(rot) ? rot : 0; out[q + 19] = 0;
      // 形 0 丸・1 星・2 ハート・3 しずく → 種類 2〜5
      const shape = clean(Math.round(f[o + SPARK.SHAPE]), 0, 3, 0);
      out[q + 20] = 2 + shape; out[q + 21] = 0; out[q + 22] = 0; out[q + 23] = 0;
      k += 1;
    }
    this.effectsEnd = k;
  }

  /** カプセルの並びを詰める（継ぎ目の切り口つき）。次に書く位置を返す */
  #packCapsules(f, sec, bounds, k) {
    const out = this.shapeData;
    bounds.clear();
    this.#computeJoints(f, sec);
    const clips = this.capsuleClips;
    for (let i = 0; i < sec.count; i++) {
      const o = sec.off[i];
      if (!Renderer.#validCapsule(f, o)) continue;
      const q = k * SHAPE_FLOATS;
      writeLinear(f, o + CAPSULE.COLOR, out, q);
      // 縁の色（リニアで 2 乗 × 0.82。同系色の濃い色）
      out[q + 4] = out[q] * out[q] * 0.82;
      out[q + 5] = out[q + 1] * out[q + 1] * 0.82;
      out[q + 6] = out[q + 2] * out[q + 2] * 0.82;
      out[q + 7] = out[q + 3];
      const ax = f[o + CAPSULE.AX], ay = f[o + CAPSULE.AY], bx = f[o + CAPSULE.BX], by = f[o + CAPSULE.BY];
      const rad = f[o + CAPSULE.RADIUS];
      out[q + 8] = ax; out[q + 9] = ay; out[q + 10] = bx; out[q + 11] = by;
      out[q + 12] = clips[4 * i]; out[q + 13] = clips[4 * i + 1]; out[q + 14] = clips[4 * i + 2]; out[q + 15] = clips[4 * i + 3];
      out[q + 16] = rad; out[q + 17] = 0; out[q + 18] = 0;
      out[q + 19] = clean(f[o + CAPSULE.GLOSS], 0, 1, 0);
      out[q + 20] = 0; out[q + 21] = 0; out[q + 22] = 0; out[q + 23] = 0;   // 種類 0 = カプセル
      bounds.add(Math.min(ax, bx) - (rad + 9), Math.min(ay, by) - (rad + 9), Math.max(ax, bx) + (rad + 9), Math.max(ay, by) + (rad + 9));
      k += 1;
    }
    return k;
  }

  static #validCapsule(f, o) {
    const ax = f[o + CAPSULE.AX], ay = f[o + CAPSULE.AY], bx = f[o + CAPSULE.BX], by = f[o + CAPSULE.BY], r = f[o + CAPSULE.RADIUS];
    return Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(bx) && Number.isFinite(by)
      && Number.isFinite(r) && r > 0.05 && f[o + CAPSULE.COLOR + 3] > 0.002;
  }

  /**
   * 並びで隣のカプセルと端を共有していたら、角の二等分線の向き（内向き）を capsuleClips に入れる。
   * (clipA.xy, clipB.xy)。折れ線を順に並べた壁やびんの角で、重なった丸い端の継ぎ目を消すため
   */
  #computeJoints(f, sec) {
    const n = sec.count;
    if (this.capsuleClips.length < 4 * n) this.capsuleClips = new Float32Array(Math.max(4 * n, this.capsuleClips.length * 2));
    const clips = this.capsuleClips;
    clips.fill(0, 0, 4 * n);
    if (n < 2) return;
    const last = n === 2 ? 1 : n;
    for (let i = 0; i < last; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      const ox = sec.off[i], oy = sec.off[j];
      if (!Renderer.#validCapsule(f, ox) || !Renderer.#validCapsule(f, oy)) continue;
      const tol = 0.02 * Math.min(f[ox + CAPSULE.RADIUS], f[oy + CAPSULE.RADIUS]) + 0.01;
      search: for (let ex = 0; ex < 2; ex++) {
        for (let ey = 0; ey < 2; ey++) {
          // px = x の端 ex、py = y の端 ey
          const pxx = f[ox + (ex === 0 ? 0 : 2)], pxy = f[ox + (ex === 0 ? 1 : 3)];
          const pyx = f[oy + (ey === 0 ? 0 : 2)], pyy = f[oy + (ey === 0 ? 1 : 3)];
          const dd = Math.sqrt((pxx - pyx) * (pxx - pyx) + (pxy - pyy) * (pxy - pyy));
          if (dd > tol) continue;
          const vxx = f[ox + (ex === 0 ? 2 : 0)] - pxx, vxy = f[ox + (ex === 0 ? 3 : 1)] - pxy;
          const vyx = f[oy + (ey === 0 ? 2 : 0)] - pyx, vyy = f[oy + (ey === 0 ? 3 : 1)] - pyy;
          const lx = Math.sqrt(vxx * vxx + vxy * vxy), ly = Math.sqrt(vyx * vyx + vyy * vyy);
          if (!(lx > 1e-4 && ly > 1e-4)) break search;
          const dx = vxx / lx - vyx / ly, dy = vxy / lx - vyy / ly;
          const ld = Math.sqrt(dx * dx + dy * dy);
          if (!(ld > 1e-3)) break search;   // 折り返し（180°）は切らない
          const mx = dx / ld, my = dy / ld;
          if (ex === 0) { clips[4 * i] = mx; clips[4 * i + 1] = my; } else { clips[4 * i + 2] = mx; clips[4 * i + 3] = my; }
          if (ey === 0) { clips[4 * j] = -mx; clips[4 * j + 1] = -my; } else { clips[4 * j + 2] = -mx; clips[4 * j + 3] = -my; }
          break search;
        }
      }
    }
  }

  // MARK: - 多角形

  #packPolygons(f, r) {
    let total = 0;
    for (let i = 0; i < r.polygonsBack.count; i++) total += Math.max(f[r.polygonsBack.off[i] + POLY.N] - 2, 0) * 3;
    for (let i = 0; i < r.polygonsFront.count; i++) total += Math.max(f[r.polygonsFront.off[i] + POLY.N] - 2, 0) * 3;
    this.polyData = grow(this.polyData, Math.max(total, 1) * POLY_FLOATS);
    this.polyBackStart = 0;
    this.polyBackEnd = this.#writePolygons(f, r.polygonsBack, 0);
    this.polyFrontStart = this.polyBackEnd;
    this.polyFrontEnd = this.#writePolygons(f, r.polygonsFront, this.polyBackEnd);
  }

  /** 耳切りで三角形にして、縦グラデーションの色を付けて書き出す。書き終えた頂点の位置を返す */
  #writePolygons(f, sec, start) {
    const out = this.polyData;
    const top = this.polyTop, bottom = this.polyBottom;
    let k = start;
    for (let s = 0; s < sec.count; s++) {
      const o = sec.off[s];
      const n = f[o + POLY.N];
      if (n < 3) continue;
      writeLinearPremultiplied(f, o + POLY.COLOR, top, 0);
      if (f[o + POLY.HAS_BOTTOM] > 0.5) writeLinearPremultiplied(f, o + POLY.BOTTOM, bottom, 0);
      else bottom.set(top);
      const base = o + POLY.POINTS;
      let minY = Infinity, maxY = -Infinity, finite = true;
      for (let i = 0; i < n; i++) {
        const x = f[base + 2 * i], y = f[base + 2 * i + 1];
        if (!(Number.isFinite(x) && Number.isFinite(y))) { finite = false; break; }
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (!finite) continue;
      const span = Math.max(maxY - minY, 1e-4);
      const tris = this.clipper.triangulate(f, base, n);
      const idx = this.clipper.indices;
      for (let v = 0; v < tris * 3; v++) {
        const p = idx[v];
        const x = f[base + 2 * p], y = f[base + 2 * p + 1];
        const t = (y - minY) / span;
        const q = k * POLY_FLOATS;
        out[q] = x; out[q + 1] = y;
        out[q + 2] = top[0] + (bottom[0] - top[0]) * t;
        out[q + 3] = top[1] + (bottom[1] - top[1]) * t;
        out[q + 4] = top[2] + (bottom[2] - top[2]) * t;
        out[q + 5] = top[3] + (bottom[3] - top[3]) * t;
        k += 1;
      }
    }
    return k;
  }

  // MARK: - 文字

  #prepareTexts(f, r, zoom, pxPerUnit) {
    this.textCount = 0;
    const sec = r.texts;
    if (sec.count === 0) return;
    if (this.textData.length < sec.count * 16) this.textData = new Float32Array(sec.count * 32);
    if (this.textAlpha.length < sec.count) this.textAlpha = new Float32Array(sec.count * 2);
    const cam = this.camera;
    const d = this.textData;
    for (let i = 0; i < sec.count; i++) {
      const o = sec.off[i];
      const alpha = f[o + TEXT.ALPHA], size = f[o + TEXT.SIZE];
      const x = f[o + TEXT.X], y = f[o + TEXT.Y];
      if (!(alpha > 0.002 && Number.isFinite(size) && size > 0.1 && Number.isFinite(x) && Number.isFinite(y))) continue;
      const text = r.string(f[o + TEXT.STRING]);
      if (!text) continue;
      const sx = Number.isFinite(f[o + TEXT.SCALE_X]) ? f[o + TEXT.SCALE_X] : 1;
      const sy = Number.isFinite(f[o + TEXT.SCALE_Y]) ? f[o + TEXT.SCALE_Y] : 1;
      const pixelHeight = size * Math.max(Math.abs(sx), Math.abs(sy)) * pxPerUnit;
      const e = this.textCache.entry(text, f[o + TEXT.HEAVY] > 0.5, pixelHeight, size * pxPerUnit);
      if (!e) continue;
      const k = size / e.fontPx;   // テクスチャ 1px が何 u か
      const halfX = e.width * (k * 0.5 * zoom), halfY = e.height * (k * 0.5 * zoom);
      const rot = Number.isFinite(f[o + TEXT.ROTATION]) ? f[o + TEXT.ROTATION] : 0;
      const c = Math.cos(rot), s = Math.sin(rot);
      const q = this.textCount * 16;
      d[q] = cam.x0 * x + cam.y0 * y + cam.t0;
      d[q + 1] = cam.x1 * x + cam.y1 * y + cam.t1;
      d[q + 2] = c * halfX * sx; d[q + 3] = s * halfX * sx;
      d[q + 4] = -s * halfY * sy; d[q + 5] = c * halfY * sy;
      d[q + 6] = 0; d[q + 7] = (0.06 * e.fontPx) / e.height;
      writeLinear(f, o + TEXT.COLOR, d, q + 8);
      writeLinear(f, o + TEXT.OUTLINE, d, q + 12);
      this.textAlpha[this.textCount] = Math.min(Math.max(alpha, 0), 1);
      this.textTextures[this.textCount] = e.texture;
      this.textCount += 1;
    }
  }

  // MARK: - 計測

  /** GPU の時間を測り始める（拡張が無い・前の結果がまだ 4 つ溜まっているときは測らない） */
  #beginGpuTimer() {
    const ext = this.timerExt;
    if (!ext || this.queryPending.length >= 4) return null;
    const gl = this.gl;
    const q = this.queryFree.pop() || gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.queryPending.push(q);
    return q;
  }

  /** 出た GPU の時間を読む（iOS と同じく、なめらかにした値） */
  #pollGpuTimers() {
    const ext = this.timerExt;
    if (!ext) return;
    const gl = this.gl;
    while (this.queryPending.length > 0) {
      const q = this.queryPending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      this.queryPending.shift();
      this.queryFree.push(q);
      const ms = ns / 1e6;
      if (!disjoint && ms > 0 && ms < 1000) this.gpuMs = this.gpuMs === 0 ? ms : this.gpuMs * 0.9 + ms * 0.1;
    }
  }

  #updateStats(frameStart, end, draws, W, H) {
    if (this.statFrames === 0 && this.statStart === 0) this.statStart = frameStart;
    this.statFrames += 1;
    this.statCPU += end - frameStart;
    const elapsed = end - this.statStart;
    if (elapsed < 500) return;
    const n = this.statFrames;
    const st = this.stats;
    st.fps = (n / elapsed) * 1000;
    st.cpuMs = this.statCPU / n;
    st.packMs = this.statPack / n;
    st.gpuMs = this.gpuMs;
    st.blobs = this.blobCount;
    st.points = this.pointCount;
    st.drawCalls = draws;
    st.foldedBlobs = this.backLayer.folded + this.frontLayer.folded;
    st.textTextures = this.textCache.count;
    st.textMB = this.textCache.totalBytes / 1048576;
    st.textBakes = this.textCache.statBakes;
    st.textBakeMaxMs = this.textCache.statBakeMaxMs;
    this.textCache.statBakes = 0;
    this.textCache.statBakeMaxMs = 0;
    st.width = W;
    st.height = H;
    st.samples = this.targets ? Math.max(this.targets.samples, 0) : 0;
    st.renderScale = this.renderScale;
    this.statFrames = 0;
    this.statStart = end;
    this.statCPU = 0;
    this.statPack = 0;
    if (this.onStats) this.onStats(st);
  }
}

