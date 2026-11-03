// 場面の並び（Web/Engine/Sources/KumoponWeb/WebScene.swift が書く Float32 の並び＋文字の表）を読む。
// 並びの説明は WebScene.swift の先頭にある。並びを変えたら、ここと WebScene.swift を一緒に直す（片方だけ変えない）。
//
// 読み方: 1 フレームに 1 回 read() で並びを頭から歩き、区切りごとに「その物が並びの何番目から始まるか」だけを
// 使い回しの Int32Array に控える（物ごとのオブジェクトは作らない。Android の安い端末で GC のひっかかりを起こさないように）。
// 描く側は f[off + BLOB.ALPHA] のように、下の番号の表で中身を読む。
// f は wasm のメモリの上の view なので、次の engine.frame() で中身が変わる。読み終えるのは同じフレームのうちに。

/** 並びの版（WebSceneWriter.version と同じ） */
export const SCENE_VERSION = 1;
/** 頭の数（WebSceneWriter.headerFloats） */
export const HEADER_FLOATS = 32;

/** 頭の中の番号 */
export const HEAD = Object.freeze({
  VERSION: 0,
  CANVAS_W: 1, CANVAS_H: 2,
  ROTATION: 3,          // カメラの回転（ラジアン、時計回りが正）
  PIVOT_X: 4, PIVOT_Y: 5,
  SHAKE_X: 6, SHAKE_Y: 7,
  SHIFT_X: 8, SHIFT_Y: 9, // 画面に固定した平行移動（cameraShift）
  ZOOM: 10,
  BG_TOP: 11,           // rgba
  BG_BOTTOM: 15,        // rgba
  DOT_INTENSITY: 19,
  DOT_DRIFT_X: 20, DOT_DRIFT_Y: 21,
  BG_IMAGE: 22,         // 背景の絵（文字の表の番号。無ければ -1）
  BG_IMAGE2: 23,        // 2 枚目の絵（同じ）
  BG_IMAGE_MIX: 24,     // 2 枚目へ移る割合
  FLASH: 25,            // 閃光（0〜0.35）
});

/** 多角形（1 つ）: 10 + 2n */
export const POLY = Object.freeze({ N: 0, COLOR: 1, HAS_BOTTOM: 5, BOTTOM: 6, POINTS: 10 });
/** カプセル（1 つ）: 10 */
export const CAPSULE = Object.freeze({ AX: 0, AY: 1, BX: 2, BY: 3, RADIUS: 4, COLOR: 5, GLOSS: 9, STRIDE: 10 });
/** ブロブ（1 つ）: 43 + 2n + 2m（外周 x y … のあとに restUV u v …） */
export const BLOB = Object.freeze({
  N: 0, M: 1, CX: 2, CY: 3, REST_RADIUS: 4, INFLATE: 5, UV_ROTATION: 6,
  BODY: 7, RIM: 11, HIGHLIGHT: 15, CHEEK: 19, EYE: 23,
  RAINBOW: 27, RAINBOW_FROM_X: 28, RAINBOW_FROM_Y: 29,
  FACE_VISIBLE: 30, EYE_OPEN: 31, SQUINT: 32, LOOK_X: 33, LOOK_Y: 34, FACE_SCALE: 35, MOUTH: 36, SWEAT: 37, MOOD: 38,
  GLOW: 39, ALPHA: 40, SHADOW: 41, RIM_SCALE: 42,
  OUTLINE: 43,
});
/** 波紋（1 つ）: 8 */
export const RING = Object.freeze({ X: 0, Y: 1, RADIUS: 2, THICKNESS: 3, COLOR: 4, STRIDE: 8 });
/** 火花（1 つ）: 9。形は 0 丸・1 星・2 ハート・3 しずく */
export const SPARK = Object.freeze({ X: 0, Y: 1, SIZE: 2, COLOR: 3, ROTATION: 7, SHAPE: 8, STRIDE: 9 });
/** 文字（1 つ）: 17。STRIDE は 1 つ分の数（ほかの表も同じ） */
export const TEXT = Object.freeze({
  STRING: 0, X: 1, Y: 2, SIZE: 3, COLOR: 4, OUTLINE: 8, ROTATION: 12, SCALE_X: 13, SCALE_Y: 14, ALPHA: 15, HEAVY: 16,
  STRIDE: 17,
});

/** 1 つの区切り（同じ種類の物の並び）。off[i] が i 番目の物の始まり（f の番号）。容量は足りないときだけ倍にする */
export class SceneSection {
  constructor(capacity = 64) {
    this.count = 0;
    this.off = new Int32Array(capacity);
  }
  clear() { this.count = 0; }
  push(o) {
    if (this.count === this.off.length) {
      const grown = new Int32Array(this.off.length * 2);
      grown.set(this.off);
      this.off = grown;
    }
    this.off[this.count++] = o;
  }
}

/**
 * 場面の並びを読む。read(scene) のあと、f・strings・頭の値・区切りの off を描く側が読む。
 * 並びが壊れていたら（版が違う・数が並びの長さを超える）その区切りで読むのをやめ、ok を false にする
 * （それまでに読めた物は描く。全体が消えるより、壊れた所だけ欠けるほうがよい）。
 */
export class SceneReader {
  constructor() {
    /** @type {Float32Array | null} */
    this.f = null;
    /** @type {string[]} */
    this.strings = [];
    this.ok = false;
    // 描く順（RenderScene のコメントと同じ）
    this.polygonsBack = new SceneSection(16);
    this.capsulesBack = new SceneSection(64);
    this.blobs = new SceneSection(128);
    this.capsulesFront = new SceneSection(64);
    this.polygonsFront = new SceneSection(16);
    this.blobsFront = new SceneSection(32);
    this.rings = new SceneSection(16);
    this.sparks = new SceneSection(256);
    this.texts = new SceneSection(16);
    /** ブロブの外周の粒の数の合計（奥と手前） */
    this.blobPoints = 0;
  }

  /** scene = engine.scene() の戻り値（{ f, strings }） */
  read(scene) {
    const f = scene.f;
    this.f = f;
    this.strings = scene.strings || [];
    this.ok = false;
    this.polygonsBack.clear(); this.capsulesBack.clear(); this.blobs.clear();
    this.capsulesFront.clear(); this.polygonsFront.clear(); this.blobsFront.clear();
    this.rings.clear(); this.sparks.clear(); this.texts.clear();
    this.blobPoints = 0;
    const len = f ? f.length : 0;
    if (len < HEADER_FLOATS || f[HEAD.VERSION] !== SCENE_VERSION) return false;
    let p = HEADER_FLOATS;
    p = this.#polygons(f, p, len, this.polygonsBack); if (p < 0) return false;
    p = this.#fixed(f, p, len, this.capsulesBack, CAPSULE.STRIDE); if (p < 0) return false;
    p = this.#blobs(f, p, len, this.blobs); if (p < 0) return false;
    p = this.#fixed(f, p, len, this.capsulesFront, CAPSULE.STRIDE); if (p < 0) return false;
    p = this.#polygons(f, p, len, this.polygonsFront); if (p < 0) return false;
    p = this.#blobs(f, p, len, this.blobsFront); if (p < 0) return false;
    p = this.#fixed(f, p, len, this.rings, RING.STRIDE); if (p < 0) return false;
    p = this.#fixed(f, p, len, this.sparks, SPARK.STRIDE); if (p < 0) return false;
    p = this.#fixed(f, p, len, this.texts, TEXT.STRIDE); if (p < 0) return false;
    this.ok = true;
    return true;
  }

  /** 頭の値 */
  head(i) { return this.f[i]; }

  /** 文字の表の番号 → 文字列（範囲外なら null） */
  string(index) {
    const i = index | 0;
    return index >= 0 && i < this.strings.length ? this.strings[i] : null;
  }

  /** 区切りの物の数。数が負・小数・並びを超える数なら -1 */
  static #count(f, p, len) {
    if (p >= len) return -1;
    const n = f[p];
    return n >= 0 && n === Math.floor(n) && n <= len ? n : -1;
  }

  #fixed(f, p, len, sec, size) {
    const n = SceneReader.#count(f, p, len);
    if (n < 0) return -1;
    p += 1;
    if (p + n * size > len) return -1;
    for (let i = 0; i < n; i++) { sec.push(p); p += size; }
    return p;
  }

  #polygons(f, p, len, sec) {
    const n = SceneReader.#count(f, p, len);
    if (n < 0) return -1;
    p += 1;
    for (let i = 0; i < n; i++) {
      const k = SceneReader.#count(f, p + POLY.N, len);
      if (k < 0) return -1;
      const size = POLY.POINTS + 2 * k;
      if (p + size > len) return -1;
      sec.push(p);
      p += size;
    }
    return p;
  }

  #blobs(f, p, len, sec) {
    const n = SceneReader.#count(f, p, len);
    if (n < 0) return -1;
    p += 1;
    for (let i = 0; i < n; i++) {
      if (p + BLOB.OUTLINE > len) return -1;
      const k = f[p + BLOB.N], m = f[p + BLOB.M];
      if (!(k >= 0 && k === Math.floor(k) && (m === k || m === 0))) return -1;
      const size = BLOB.OUTLINE + 2 * k + 2 * m;
      if (p + size > len) return -1;
      sec.push(p);
      this.blobPoints += k;
      p += size;
    }
    return p;
  }
}
