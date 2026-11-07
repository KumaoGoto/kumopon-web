// 耳切り法で単純多角形（凹でもよい）を三角形にする（iOS の RenderBuffers.swift の EarClipper を写したもの）。
// 点は場面の並び f の中（base から x0 y0 x1 y1 …）をそのまま読む。作業用の領域は使い回す（フレームごとに作らない）

export class EarClipper {
  constructor() {
    this.capacity = 64;
    this.prev = new Int32Array(this.capacity);
    this.next = new Int32Array(this.capacity);
    /** 三角形の頂点番号（3つずつ）。triangulate の結果 */
    this.indices = new Int32Array(this.capacity * 3);
  }

  #ensure(n) {
    if (n <= this.capacity) return;
    this.capacity = Math.max(n, this.capacity * 2);
    this.prev = new Int32Array(this.capacity);
    this.next = new Int32Array(this.capacity);
    this.indices = new Int32Array(this.capacity * 3);
  }

  /** f[base..] の n 点を三角形にして indices に元の点の番号を書く。三角形の数を返す（最大 n-2） */
  triangulate(f, base, n) {
    if (n < 3) return 0;
    this.#ensure(n);
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      area2 += f[base + 2 * i] * f[base + 2 * j + 1] - f[base + 2 * i + 1] * f[base + 2 * j];
    }
    if (!Number.isFinite(area2) || Math.abs(area2) <= 1e-6) return 0;
    const sgn = area2 > 0 ? 1 : -1;
    const prev = this.prev, next = this.next, indices = this.indices;
    for (let i = 0; i < n; i++) {
      prev[i] = i === 0 ? n - 1 : i - 1;
      next[i] = i + 1 === n ? 0 : i + 1;
    }
    let remaining = n;
    let i = 0;
    let misses = 0;
    let count = 0;
    while (remaining > 3) {
      const ip = prev[i], inx = next[i];
      if (misses > remaining || this.#isEar(f, base, ip, i, inx, sgn)) {
        // 耳が見つからない（自己交差・重なった点）ときは今の角を強制的に切って進む
        indices[count * 3] = ip; indices[count * 3 + 1] = i; indices[count * 3 + 2] = inx;
        count += 1;
        next[ip] = inx;
        prev[inx] = ip;
        remaining -= 1;
        i = ip;
        misses = 0;
      } else {
        i = inx;
        misses += 1;
      }
    }
    indices[count * 3] = prev[i]; indices[count * 3 + 1] = i; indices[count * 3 + 2] = next[i];
    return count + 1;
  }

  #isEar(f, base, ia, ib, ic, sgn) {
    const ax = f[base + 2 * ia], ay = f[base + 2 * ia + 1];
    const bx = f[base + 2 * ib], by = f[base + 2 * ib + 1];
    const cx = f[base + 2 * ic], cy = f[base + 2 * ic + 1];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (cross * sgn <= 1e-7) return false;
    let k = this.next[ic];
    while (k !== ia) {
      const qx = f[base + 2 * k], qy = f[base + 2 * k + 1];
      const same = (qx === ax && qy === ay) || (qx === bx && qy === by) || (qx === cx && qy === cy);
      if (!same && EarClipper.#inside(qx, qy, ax, ay, bx, by, cx, cy, sgn)) return false;
      k = this.next[k];
    }
    return true;
  }

  static #inside(qx, qy, ax, ay, bx, by, cx, cy, sgn) {
    const d1 = ((bx - ax) * (qy - ay) - (by - ay) * (qx - ax)) * sgn;
    const d2 = ((cx - bx) * (qy - by) - (cy - by) * (qx - bx)) * sgn;
    const d3 = ((ax - cx) * (qy - cy) - (ay - cy) * (qx - cx)) * sgn;
    return d1 >= 0 && d2 >= 0 && d3 >= 0;
  }
}
