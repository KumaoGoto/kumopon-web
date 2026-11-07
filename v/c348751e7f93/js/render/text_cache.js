// 文字列を Canvas 2D でテクスチャに焼いてキャッシュする（iOS の TextTextureCache.swift を写したもの）。
// テクスチャは 2 チャンネル（R = 字、G = 縁取り込みの字）。色は描くときにシェーダーで付けるので、色違いでも使い回せる。
// 大きさは段（64/128/256/512px）に丸めて焼き、ミップマップで縮める。ぽんっと拡大するアニメーションの途中で
// 段を焼き直さないよう、段は「拡大なしの大きさ × 1.15」以上にし、大きい段がすでにあればそれを使う。
// 上限は 96 個かつ 24MB（ミップ込み）。超えたら、そのフレームで使っていないものを古い順に捨てる。
//
// iOS との違い:
// - 字体は端末の丸ゴシック（SF Rounded）ではなく 'KumoponRounded'（M PLUS Rounded 1c を使う字だけに絞ったもの。
//   heavy = 900〈kumopon-rounded-black.woff〉、bold = 700〈kumopon-rounded-bold.woff〉）。字の形と字幅は少し変わる
// - iOS は裏のスレッドで焼いて 1〜2 フレーム遅れて出す。ブラウザはそのフレームのうちに焼く（Canvas 2D は裏で使えない
//   ブラウザがあるため）。代わりに 1 フレームに焼くのは 2 つまで・合わせて 4ms までにして、残りは次のフレームへ回す
//   （その間は小さい段か、出さない）。M4 の Chrome で 1 つ 0.5〜2ms。初めの数回は Canvas と字の準備で 10〜20ms かかるので、
//   字体を読んだあとに warmUp で一度焼いておく（遊び始めの最初の字でフレームが落ちないように）
// - Canvas は GPU のもののまま使う（willReadFrequently: true の CPU の Canvas は、大きい字と縁取りで 1 つ 30〜60ms かかった）
// - 画素を JavaScript で並べ替えない: 黒く塗った Canvas に、縁取り込みの字を緑（G）で、字を赤（R）で足して描き、
//   Canvas をそのまま RG8 のテクスチャに上げる（getImageData の読み戻しと 1 画素ずつのループが要らない）

/** 縁取りの太さ（フォントの大きさに対する比）。iOS の TextTextureCache.outlineRatio */
export const OUTLINE_RATIO = 0.13;
/** 1 枚のテクスチャの辺の上限（px）。長い文字列は段を下げて焼く */
export const MAX_SIDE = 4096;
/** 字体の名前（CSS の @font-face と同じ） */
export const FONT_FAMILY = 'KumoponRounded';

const BUCKETS = [64, 128, 256, 512];

/**
 * 字体を読み込んで使えるまで待つ。ページの CSS が @font-face で 'KumoponRounded' を名乗らせていればそれを使い、
 * 無ければここで FontFace を足す（assetsBase/fonts/ の woff）。字は使う字だけに絞ってあるので、
 * document.fonts.load には実際に出る字（かな・漢字・数字）を渡す
 */
export async function ensureFonts(assetsBase) {
  const weights = new Set();
  for (const face of document.fonts) {
    if (face.family.replace(/["']/g, '') === FONT_FAMILY) weights.add(String(face.weight));
  }
  const add = (file, weight) => {
    const face = new FontFace(FONT_FAMILY, `url(${assetsBase}/fonts/${file}) format('woff')`, { weight, display: 'block' });
    document.fonts.add(face);
  };
  if (!weights.has('900') && !weights.has('800')) add('kumopon-rounded-black.woff', '900');
  if (!weights.has('700') && !weights.has('bold')) add('kumopon-rounded-bold.woff', '700');
  const sample = 'くもぽん雲にじ0123456789+!';
  const [heavy, bold] = await Promise.all([
    document.fonts.load(`900 32px ${FONT_FAMILY}`, sample),
    document.fonts.load(`700 32px ${FONT_FAMILY}`, sample),
  ]);
  if (heavy.length === 0 || bold.length === 0) console.warn('描画: 字体 KumoponRounded が読めない（ほかの字体で焼く）');
}

export class TextTextureCache {
  constructor(gl) {
    this.gl = gl;
    /** 文字列 → 8 つの段の欄（太字 4 段 ＋ ふつう 4 段）。フレームごとに鍵の文字列を作らないため */
    this.byText = new Map();
    this.count = 0;
    this.totalBytes = 0;
    this.maxEntries = 96;
    this.maxBytes = 24 << 20;
    /** 焼けなかったもの（毎フレーム焼き直さない） */
    this.failed = new Set();
    this.maxBakesPerFrame = 2;
    this.maxBakeMsPerFrame = 4;
    this.bakedThisFrame = 0;
    this.bakeMsThisFrame = 0;
    /** 計測（焼いた数と、1 つにかかったいちばん長い時間。Renderer の stats が 0.5 秒ごとに読んで 0 に戻す） */
    this.statBakes = 0;
    this.statBakeMaxMs = 0;
    this.frame = 0;
    /** 字体が読めるまでは焼かない（ほかの字体で焼いた絵が残らないように） */
    this.fontsReady = false;
    this.maxSide = Math.min(MAX_SIDE, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  }

  /** フレームの頭に呼ぶ（古い順に捨てる目安と、1 フレームに焼く数） */
  beginFrame(frame) {
    this.frame = frame;
    this.bakedThisFrame = 0;
    this.bakeMsThisFrame = 0;
  }

  /** Canvas と字の準備を先に済ませる（字体を読んだあとに 1 回。焼いたテクスチャは捨てる） */
  warmUp() {
    const t0 = performance.now();
    for (const heavy of [true, false]) {
      const e = this.#rasterize('0123456789+,!? くもぽん雲にじ', heavy, 128);
      if (e) this.gl.deleteTexture(e.texture);
    }
    return performance.now() - t0;
  }

  /**
   * 画面上の高さ pixelHeight で描く文字のテクスチャ。baseHeight は拡大（scale）なしの高さ。
   * まだ無ければ焼く（このフレームで焼ける数を超えたら、焼き上がるまでは小さい段か null）
   */
  entry(text, heavy, pixelHeight, baseHeight) {
    if (!text || !Number.isFinite(pixelHeight) || pixelHeight <= 0.5) return null;
    const want = Math.max(pixelHeight, Number.isFinite(baseHeight) ? baseHeight * 1.15 : 0);
    let bi = 0;
    while (BUCKETS[bi] < want && bi < BUCKETS.length - 1) bi++;
    const slots = this.byText.get(text);
    const h = heavy ? 0 : 4;
    // 同じか大きい段があればそれを使う（ミップマップで縮める）
    if (slots) {
      for (let b = bi; b < BUCKETS.length; b++) {
        const e = slots[h + b];
        if (e) { e.lastUse = this.frame; return e; }
      }
    }
    if (this.fontsReady && this.bakedThisFrame < this.maxBakesPerFrame && this.bakeMsThisFrame < this.maxBakeMsPerFrame) {
      const e = this.#bake(text, heavy, bi);
      if (e) return e;
    }
    // 焼き上がるまでは小さい段で（少しぼやけるが消えない）
    if (slots) {
      for (let b = bi - 1; b >= 0; b--) {
        const e = slots[h + b];
        if (e) { e.lastUse = this.frame; return e; }
      }
    }
    return null;
  }

  #bake(text, heavy, bi) {
    const failKey = `${heavy ? 1 : 0}${bi}${text}`;
    if (this.failed.has(failKey)) return null;
    this.bakedThisFrame += 1;
    const t0 = performance.now();
    // 1 枚に収まらない長い文字列は段を下げる
    let tex = null;
    for (let fontPx = BUCKETS[bi]; fontPx >= 16 && !tex; fontPx /= 2) {
      tex = this.#rasterize(text, heavy, fontPx);
    }
    const ms = performance.now() - t0;
    this.bakeMsThisFrame += ms;
    this.statBakes += 1;
    if (ms > this.statBakeMaxMs) this.statBakeMaxMs = ms;
    if (!tex) {
      if (this.failed.size >= 256) this.failed.clear();
      this.failed.add(failKey);
      return null;
    }
    let slots = this.byText.get(text);
    if (!slots) {
      slots = new Array(8).fill(null);
      this.byText.set(text, slots);
    }
    const k = (heavy ? 0 : 4) + bi;
    const old = slots[k];
    if (old) this.#drop(old);
    tex.text = text;
    tex.slot = k;
    tex.lastUse = this.frame;
    slots[k] = tex;
    this.count += 1;
    this.totalBytes += tex.bytes;
    this.#evict();
    return slots[k];
  }

  /** 字（R）と縁取り込み（G）を並べた RG8 のテクスチャ。収まらなければ null */
  #rasterize(text, heavy, fontPx) {
    const gl = this.gl;
    const ctx = this.ctx;
    const font = `${heavy ? 900 : 700} ${fontPx}px ${FONT_FAMILY}, sans-serif`;
    ctx.font = font;
    const m = ctx.measureText(text);
    // iOS は CTLineGetTypographicBounds（字体の ascent・descent と字の送り幅）。同じ物差しにする
    const ascent = Number.isFinite(m.fontBoundingBoxAscent) ? m.fontBoundingBoxAscent : fontPx * 1.075;
    const descent = Number.isFinite(m.fontBoundingBoxDescent) ? m.fontBoundingBoxDescent : fontPx * 0.32;
    const outline = fontPx * OUTLINE_RATIO;
    const pad = Math.ceil(outline + 3);
    const w = Math.ceil(m.width + pad * 2);
    const h = Math.ceil(ascent + descent + pad * 2);
    if (!(w > 0 && h > 0 && w <= this.maxSide && h <= this.maxSide)) return null;

    const c = this.canvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    // 大きさを変えると字体などの設定が戻るので、毎回入れ直す
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = outline * 2;
    const x = pad, y = pad + ascent;
    // G = 縁取り込みの字（縁取りの線と字を緑で）
    ctx.strokeStyle = '#0f0';
    ctx.fillStyle = '#0f0';
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    // R = 字（赤を足す。G はそのまま）
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#f00';
    ctx.fillText(text, x, y);
    ctx.globalCompositeOperation = 'source-over';

    const t = gl.createTexture();
    if (!t) return null;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, gl.RG, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    return { texture: t, width: w, height: h, fontPx, bytes: Math.floor((w * h * 2 * 4) / 3), lastUse: 0, text: '', slot: 0 };
  }

  #drop(e) {
    this.gl.deleteTexture(e.texture);
    this.count -= 1;
    this.totalBytes -= e.bytes;
  }

  /**
   * 数か大きさが上限を超えたら、このフレームで使っていないものを古い順に捨てる。
   * WebGL はテクスチャを消しても、もう積んだ描画の命令は壊れない（消すのは使い終わってから）
   */
  #evict() {
    while (this.count > this.maxEntries || this.totalBytes > this.maxBytes) {
      let oldest = null;
      for (const slots of this.byText.values()) {
        for (const e of slots) {
          if (e && e.lastUse < this.frame && (!oldest || e.lastUse < oldest.lastUse)) oldest = e;
        }
      }
      if (!oldest) return;   // 全部このフレームで使っている
      const slots = this.byText.get(oldest.text);
      slots[oldest.slot] = null;
      if (slots.every((s) => s === null)) this.byText.delete(oldest.text);
      this.#drop(oldest);
    }
  }

  /** 全部捨てる（WebGL の文脈が失われたとき。テクスチャはもう無いので消さない） */
  reset(gl) {
    this.gl = gl;
    this.byText.clear();
    this.count = 0;
    this.totalBytes = 0;
    this.failed.clear();
  }
}
