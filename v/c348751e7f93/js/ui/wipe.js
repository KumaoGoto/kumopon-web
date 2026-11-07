// 画面の切り替えの雲（App/Shell/CloudWipe.swift の写し）: もくもくと雲が広がって画面を覆い、その裏で画面を替えてから、雲が晴れて次の画面が出る。
// 覆う 0.32 秒（easeIn）→ 0.06 秒おいて替える → 晴れる 0.5 秒（easeOut）。線形にしない。
// iOS は SwiftUI の Shape を毎フレーム描き直している。ブラウザでは全画面の 2D の canvas に同じ形を描く（DOM の丸を 100 こ動かすより軽い）

import { EASE } from './parts.js';

const COVER_TIME = 0.32;
const CLEAR_TIME = 0.5;
/** 覆いきってから画面を替えるまでの間（替えた最初のフレームの描き直しを雲の裏で済ませる） */
const HOLD = 0.06;

/** 丸の中心（0〜1 の画面の割合）と遅れ（0〜0.45。中ほど大きい）。iOS と同じ種・同じ乱数の並びで、毎回同じ形 */
const PUFFS = (() => {
  const out = [];
  const cols = 4, rows = 7;
  const MASK = (1n << 64n) - 1n;
  let seed = 0x9E3779B97F4A7C15n;
  const rnd = () => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & MASK;
    return Number((seed >> 33n) & 0xFFFFn) / 0xFFFF;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5 + (r % 2 === 0 ? -0.25 : 0.25)) / cols + (rnd() - 0.5) * 0.08;
      const y = (r + 0.5) / rows + (rnd() - 0.5) * 0.05;
      // 中心からの遠さで遅れを決める（外から寄ってくる）
      const d = Math.hypot(x - 0.5, (y - 0.5) * 0.6);
      out.push({ x, y, delay: Math.min(0.45, Math.max(0, 0.39 - d * 0.75) + rnd() * 0.06) });
    }
  }
  return out;
})();

/** 1 つの雲のこぶ（中心からのずれと半径の割合）: 真ん中の丸に、左右と上のこぶ */
const LOBES = [[0, 0, 0.82], [-0.62, 0.22, 0.6], [0.6, 0.18, 0.64], [0.12, -0.42, 0.58]];

export class CloudWipe {
  constructor(parent) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wipe';
    this.canvas.setAttribute('aria-hidden', 'true');
    parent.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.busy = false;
    this.cover = 0;
    this.clearing = false;
  }

  /** 雲で覆ってから midway を呼び、晴らす。走っている途中なら midway だけすぐ呼ぶ（2 度押しで止まらない） */
  run(midway) {
    if (this.busy) {
      midway();
      return;
    }
    this.busy = true;
    this.clearing = false;
    this.size();
    this.canvas.classList.add('on');
    const t0 = performance.now();
    let phase = 0; // 0 覆う・1 待つ・2 晴れる
    let tClear = 0;
    const step = (now) => {
      const t = (now - t0) / 1000;
      if (phase === 0) {
        this.cover = EASE.in(Math.min(1, t / COVER_TIME));
        if (t >= COVER_TIME) { this.cover = 1; phase = 1; }
      }
      if (phase === 1 && t >= COVER_TIME + HOLD) {
        try {
          midway();
        } catch (e) {
          console.error(e);
        }
        this.clearing = true;
        tClear = now;
        phase = 2;
      }
      if (phase === 2) {
        const u = (now - tClear) / 1000 / CLEAR_TIME;
        this.cover = 1 - EASE.out(Math.min(1, u));
        if (u >= 1) {
          this.cover = 0;
          this.draw();
          this.canvas.classList.remove('on');
          this.busy = false;
          this.clearing = false;
          return;
        }
      }
      this.draw();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, hgt = window.innerHeight;
    this.w = w;
    this.h = hgt;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 雲の形（CloudWipeShape.path と同じ）を 1 つの道にする。重なりは塗りの nonzero で 1 枚に溶ける */
  path(dy = 0) {
    const { w, h } = this;
    const p = new Path2D();
    // 覆いきったときの丸の半径（となりの丸と十分に重なる大きさ）
    const full = Math.max(w / 4, h / 7) * 0.95;
    for (const puff of PUFFS) {
      // 覆うときは外の丸から先に膨らみ、晴れるときは中の丸から先に縮む（遅れの大きい中が先に消える）
      const t = Math.min(Math.max((this.cover - puff.delay) / (1 - 0.45), 0), 1);
      if (t <= 0) continue;
      // 膨らみは少し行き過ぎてから落ち着く（easeOutBack に近い形）
      const s = t < 1 ? t * (1 + 0.18 * Math.sin(Math.PI * t)) : 1;
      const r = full * s;
      // 晴れるときは、縮みながら外へ散る
      const drift = this.clearing ? (1 - t) * 0.22 : 0;
      const cx = (puff.x + (puff.x - 0.5) * drift) * w;
      const cy = (puff.y + (puff.y - 0.5) * drift) * h + dy;
      for (const [dx, ly, k] of LOBES) {
        const rr = r * k;
        const ex = cx + dx * r, ey = cy + ly * r;
        p.moveTo(ex + rr, ey);
        p.ellipse(ex, ey, rr, rr * 0.92, 0, 0, Math.PI * 2);
      }
    }
    return p;
  }

  draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (this.cover <= 0.001) return;
    // 雲の影（少し下にずらした淡い空色）と、白い雲（上から下へ ほんの少し青み）
    ctx.fillStyle = 'rgba(184, 209, 250, 0.55)';
    ctx.fill(this.path(10));
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#f7f7ff');
    ctx.fillStyle = g;
    ctx.fill(this.path(0));
  }
}
