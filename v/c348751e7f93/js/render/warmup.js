// 描画の「慣らし」の場面。読み込みのときに 1 回だけ描いて、全部の描き方（影の溜めと resolve・裏返る輪のステンシル・
// カプセルの縁と中身・多角形・ブロブの奥と手前・にじ雲・波紋・火花 4 つの形・文字・閃光）を一度ずつ通しておく。
// WebGL の下の仕組み（ANGLE の Metal・Vulkan など）は、描き方の組み合わせを初めて使うときに組み立てるので、
// 遊んでいる途中で初めて出た形（雲が強くしぼられて輪が裏返った・にじ雲・結果の空）で 1 フレームが 100〜200ms 止まった
// （2026-11-03 に M4 の Chrome で測った。安い Android ではもっと長くなりうる）。
// 並びは WebScene.swift の先頭の形（版 1）と同じ。描き終えたら見えないうちに次のフレームが上書きする。

const HEADER = 32;

/** 慣らしの場面（{ f, strings }。engine.scene() と同じ形） */
export function makeWarmUpScene() {
  const f = [];
  const strings = ['play_bg', 'result_bg', 'くもぽん', '+1,000'];
  // 頭
  f.push(1, 360, 720, 0.2, 180, 360, 0, 0, 0, -20, 1);
  f.push(0.7, 0.86, 0.99, 1, 0.98, 0.88, 0.96, 1);   // 空の上と下
  f.push(0.06, 6, -10, 0, 1, 0.5, 0.2);                // 水玉・絵 2 枚・移る割合・閃光
  while (f.length < HEADER) f.push(0);

  // 多角形（奥）
  polygons(f, [[[60, 520], [300, 520], [320, 700], [40, 700]]]);
  // カプセル（奥）: つながった 2 本（継ぎ目の切り口）
  capsules(f, [[100, 600, 180, 640, 6], [180, 640, 260, 600, 6]]);
  // ブロブ（奥）: ふつうの雲・にじ雲・裏返る輪（三日月）
  blobs(f, [
    { cx: 120, cy: 300, r: 40, rainbow: 0, shape: circle },
    { cx: 240, cy: 300, r: 44, rainbow: 1, shape: circle },
    { cx: 180, cy: 430, r: 46, rainbow: 0.5, shape: crescent },
  ]);
  // カプセル（手前）: びんのガラスのように 3 本つなぐ
  capsules(f, [[40, 200, 40, 500, 7], [40, 500, 320, 500, 7], [320, 500, 320, 200, 7]]);
  polygons(f, [[[150, 80], [210, 80], [180, 130]]]);
  // ブロブ（手前）
  blobs(f, [{ cx: 180, cy: 150, r: 30, rainbow: 0, shape: crescent }]);
  // 波紋・火花（丸・星・ハート・しずく）・文字
  f.push(1, 180, 360, 50, 4, 1, 1, 1, 0.8);
  f.push(4);
  for (let k = 0; k < 4; k++) f.push(100 + 50 * k, 620, 18, 1, 0.8, 0.5, 1, 0.3 * k, k);
  f.push(2);
  f.push(2, 180, 250, 30, 0.36, 0.25, 0.33, 1, 1, 1, 1, 1, 0.1, 1, 1, 1, 1);
  f.push(3, 180, 560, 18, 0.3, 0.42, 0.78, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0);
  return { f: new Float32Array(f), strings };
}

function polygons(f, list) {
  f.push(list.length);
  for (const pts of list) {
    f.push(pts.length, 0.9, 0.97, 1, 0.5, 1, 0.74, 0.88, 1, 0.62);
    for (const [x, y] of pts) f.push(x, y);
  }
}

function capsules(f, list) {
  f.push(list.length);
  for (const [ax, ay, bx, by, r] of list) f.push(ax, ay, bx, by, r, 0.8, 0.91, 1, 1, 0.6);
}

function circle(k, n) {
  const a = (k / n) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)];
}

/** 三日月（強く凹んだ形。重心から見て輪が裏返るので、ステンシルの道を通る） */
function crescent(k, n) {
  const half = n / 2;
  if (k < half) {
    const a = -2.4 + (k / (half - 1)) * 4.8;
    return [Math.cos(a), Math.sin(a)];
  }
  const a = 2.2 - ((k - half) / (half - 1)) * 4.4;
  return [0.55 + 0.8 * Math.cos(a), 0.8 * Math.sin(a)];
}

function blobs(f, list) {
  f.push(list.length);
  for (const b of list) {
    const n = 24;
    f.push(n, n, b.cx, b.cy, b.r, 3.5, 0.1);
    f.push(0.9, 0.95, 1, 1, 0.6, 0.55, 0.66, 1, 1, 1, 1, 0.75, 1, 0.45, 0.55, 0.45, 0.22, 0.15, 0.2, 1);
    f.push(b.rainbow, 0, -1);
    f.push(1, 1, 0.3, 0.02, 0, 1, 0.1, 0.3, 0.6);   // 顔: 見せる・目の開き・ぎゅっ・視線・大きさ・口・汗・気分
    f.push(0.4, 1, 1, 1.5);                          // 光・不透明度・影・縁の太さ
    const uv = [];
    for (let k = 0; k < n; k++) {
      const [x, y] = b.shape(k, n);
      f.push(b.cx + x * b.r, b.cy + y * b.r);
      uv.push(x, y);
    }
    f.push(...uv);
  }
}
