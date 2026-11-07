// 色の扱い（iOS の RenderGPUTypes.swift の ColorSpace・RainbowGPU と RenderScene.swift の RainbowLook を写したもの）。
// 場面の色は sRGB の 0〜1。描画はリニアで混ぜるので、GPU に渡す前にここでリニアに直す。
// 値を変えるときは iOS の側（RenderScene.swift の RainbowLook・BlobRenderer.shadowColor）と一緒に直す（片方だけ変えない）。

/** sRGB の値（0〜1）1 つをリニアへ */
export function linear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 0〜1 に収めてからリニアへ（NaN・無限大は 0）。シーンから来た値はこれを通す */
export function clamp01(x) {
  return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0;
}

/** f[o..o+3] の sRGB の rgba を、リニアの rgba にして out[k..k+3] に書く（a はそのまま。ColorSpace.linearClamped） */
export function writeLinear(f, o, out, k) {
  out[k] = linear(clamp01(f[o]));
  out[k + 1] = linear(clamp01(f[o + 1]));
  out[k + 2] = linear(clamp01(f[o + 2]));
  out[k + 3] = clamp01(f[o + 3]);
}

/** 同じく、乗算済みアルファにして書く（ColorSpace.linearPremultiplied） */
export function writeLinearPremultiplied(f, o, out, k) {
  const a = clamp01(f[o + 3]);
  out[k] = linear(clamp01(f[o])) * a;
  out[k + 1] = linear(clamp01(f[o + 1])) * a;
  out[k + 2] = linear(clamp01(f[o + 2])) * a;
  out[k + 3] = a;
}

/** 影の色（sRGB）。暖かい暗い色（BlobRenderer.shadowColor） */
export const SHADOW_COLOR = [0.46, 0.27, 0.32, 1];

/** にじ雲の見た目（RenderScene.swift の RainbowLook と同じ値） */
export const RainbowLook = Object.freeze({
  /** 赤・橙・黄・緑・青・藍・紫（sRGB）。体はパステル */
  body: [
    [1.00, 0.70, 0.74, 1],
    [1.00, 0.81, 0.62, 1],
    [1.00, 0.94, 0.64, 1],
    [0.74, 0.93, 0.70, 1],
    [0.66, 0.88, 1.00, 1],
    [0.70, 0.76, 1.00, 1],
    [0.86, 0.74, 1.00, 1],
  ],
  /** 縁: 同じ色相の濃い色 */
  rim: [
    [0.92, 0.45, 0.55, 1],
    [0.94, 0.58, 0.36, 1],
    [0.88, 0.72, 0.28, 1],
    [0.42, 0.72, 0.46, 1],
    [0.36, 0.62, 0.92, 1],
    [0.44, 0.50, 0.90, 1],
    [0.64, 0.47, 0.90, 1],
  ],
  /** 帯の弧の中心（restUV。y は下向きなので体の下） */
  arcCenter: [0, 1.8],
  /** restUV 1 あたりの帯の数 */
  bandsPerUnit: 3.5,
  /** 流れる速さ（帯/秒） */
  flow: 0.35,
  /** 帯の境のぼかし（0〜0.5） */
  soft: 0.3,
  /** 体の真ん中を白に寄せる量 */
  coreWhite: 0.18,
  /** 変わっていく途中の境のぼかしと、境に光る線の明るさ */
  revealEdge: 0.12,
  revealGlow: 0.4,
});

/**
 * にじ雲の帯の表（RainbowGPU.table と同じ並び。17 個の vec4 = 272 バイト。シェーダーの RainbowTable の std140 と同じ）:
 * [0..<7] 体の色、[7..<14] 縁の色（どちらもリニア）、
 * [14] = (弧の中心 x, y, restUV 1 あたりの帯の数, 流れる速さ)、[15] = (境のぼかし, 上端の弧の距離, 芯の白さ, 0)、
 * [16] = (変わる途中の境のぼかし, 境の光, 0, 0)
 */
export function rainbowTable() {
  const t = new Float32Array(17 * 4);
  let k = 0;
  for (const list of [RainbowLook.body, RainbowLook.rim]) {
    for (const c of list) {
      writeLinear(c, 0, t, k);
      k += 4;
    }
  }
  const [cx, cy] = RainbowLook.arcCenter;
  // 体の上端（restUV で (0, -1)）が帯 0（赤）の始まりになるように
  const top = Math.hypot(0 - cx, -1 - cy);
  t.set([cx, cy, RainbowLook.bandsPerUnit, RainbowLook.flow], 14 * 4);
  t.set([Math.min(Math.max(RainbowLook.soft, 0.01), 0.5), top, RainbowLook.coreWhite, 0], 15 * 4);
  t.set([Math.max(RainbowLook.revealEdge, 0.01), RainbowLook.revealGlow, 0, 0], 16 * 4);
  return t;
}
