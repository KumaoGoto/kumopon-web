// 画面の共通の部品（iOS の App/Shell/Theme.swift にあたる）: 色・字・押すと沈むボタン・白い縁取りの文字・絵の場所・
// 動きの曲線（イージングと、SwiftUI の spring を写した曲線）・段の表（くもずかん・はしご）・小さな絵（SF Symbols の代わり）。
// 画面（ui.js・hud.js・sheets.js・wipe.js）はここから組み立てる。外部のライブラリは使わない

// ---- 色（Theme.swift と同じ sRGB の値。CSS の側は app.css の :root に同じ値を置いている）----

export const C = {
  ink: '#5c4054',
  inkSoft: '#8c7085',
  cream: '#fff5e8',
  blush: '#ffdbe0',
  pink: '#ff859e',
  pinkDeep: '#eb6180',
  mint: '#8cdbb8',
  sky: '#8cc7ff',
  lemon: '#ffdb73',
  gold: '#ffd15c',
  goldDeep: '#db9933',
  bookBlue: '#b8e0ff',
  bookBlueDeep: '#73a8e6',
  endless: '#8cdbd1',
  endlessDeep: '#4da39e',
  /** 遊び方の色（Theme.modeColor(.endless)。初めての説明の点と［はじめる］） */
  modeEndless: '#6bbddb',
};

/** RainbowLook.body（にじ雲の 7 色。赤・橙・黄・緑・青・藍・紫） */
export const RAINBOW = ['#ffb3bd', '#ffcf9e', '#fff0a3', '#bdedb3', '#a8e0ff', '#b3c2ff', '#dbbdff'];

/** [r, g, b, a]（0〜1）を CSS の色に */
export function rgba(c) {
  const k = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${k(c[0])}, ${k(c[1])}, ${k(c[2])}, ${c.length > 3 ? c[3] : 1})`;
}

// ---- 外へのリンク（App/Shell/AppLinks.swift）----

export const LINKS = {
  privacy: 'https://kumaogoto.github.io/kumopon-site/privacy.html',
  /** iPhone で開いた人に勧める App Store の URL。AppLinks.storeShare の ct=share を ct=web にした（ブラウザ版から来た人を数える） */
  appStore: 'https://apps.apple.com/jp/app/id6824208372?pt=129314143&ct=web&mt=8',
};

// ---- 絵（App/Resources/Assets.xcassets を描画の担当が Web/tools/make_images.sh で書き出したもの。名前は iOS と同じ）----

const IMG_BASE = 'assets/img/';
export const IMG = {
  titleBg: IMG_BASE + 'title_bg.jpg',
  titleLogo: IMG_BASE + 'title_logo.png',
  cloud: (tier) => `${IMG_BASE}cloud_${tier + 1}.png`,
  badge: (n) => `${IMG_BASE}badge_${n}.png`,
  nijiBig: IMG_BASE + 'niji_big.png',
  nyudoBig: IMG_BASE + 'nyudo_big.png',
  trophy: IMG_BASE + 'trophy.png',
  crown: IMG_BASE + 'crown.png',
};

// ---- 段の表（V4Config.endlessDefault と JarModeV4.Tuning の 8 段。ゲームの決まりは WebAssembly の側が持ち、
//      ここは「くもずかん」と説明に見せるためだけの写し。決まりを変えたら、ここも直す）----

/** びんの胴の幅（JarModeV4.Tuning.jarHalfW × 2）。ずかんの「びんの N%」の分母 */
const JAR_WIDTH = 250;
export const TIERS = [
  // 名前・点・半径・出すと のびる秒・ずかんの棒の色（段の体の色。にじ雲は CloudInfo.swatch の藤色）
  { name: 'ちぎれ雲', points: 100, radius: 12, gain: 0, swatch: [0.98, 0.98, 1.0] },
  { name: 'わた雲', points: 200, radius: 16, gain: 0, swatch: [0.84, 0.93, 1.0] },
  { name: 'ひつじ雲', points: 400, radius: 22, gain: 0, swatch: [0.84, 0.97, 0.86] },
  { name: 'うろこ雲', points: 1000, radius: 30, gain: 1, swatch: [1.0, 0.96, 0.72] },
  { name: 'すじ雲', points: 3000, radius: 40, gain: 2, swatch: [1.0, 0.86, 0.74] },
  { name: 'おぼろ雲', points: 10000, radius: 52, gain: 5, swatch: [1.0, 0.8, 0.88] },
  { name: 'にゅうどう雲', points: 40000, radius: 66, gain: 15, swatch: [1.0, 0.8, 0.5] },
  { name: 'にじ雲', points: 200000, radius: 82, gain: 45, swatch: [0.86, 0.74, 1.0] },
].map((t) => ({ ...t, widthRatio: Math.min(1, (t.radius * 2) / JAR_WIDTH) }));

/** 一時停止の決まりの説明（JarModeV4.pauseRules(V4Config.endlessDefault) の写し）。
 *  ふだんは WebAssembly の HUD の pauseRules を使う。まだ HUD が来ていない所（タイトルのせっていの「あそびかた」）だけこれ */
export const DEFAULT_RULES = [
  'よこに なぞって びんを まわす\n同じ雲が ふれると くっついて 育つ（8段）',
  'びんを ふって 口から 出すと 点\n口が 上の まま あふれた雲は 0点',
  '大きな雲ほど 点が ぐんと 大きい\nにゅうどう雲 40,000・にじ雲 200,000',
  'もちじかんは 1ぷん。大きな雲を 出すと\n時間が のびる（びょう）',
  'うろこ雲 +1・すじ雲 +2・おぼろ雲 +5',
  'にゅうどう雲 +15・にじ雲 +45',
  '時間が なくなったら おしまい\nのこった雲も 出した時と 同じ点',
  'にじ雲（8段目）を 作れたら プロ級',
];

/** 初めての説明の文（ModeKind.endless.intro。改行は手で入れてある） */
export const ENDLESS_INTRO = [
  '同じ雲が ふれると くっついて 育つ',
  'びんを ふって 口から 出すと 点',
  'もちじかんは 1ぷん',
  '大きな雲を 出すと のびる',
  '時間が なくなるまで どこまでも',
];

// ---- 数と日付 ----

const NUM = new Intl.NumberFormat('ja-JP');
/** 3 けたごとの「,」（iOS の formatted() と同じ） */
export const fmt = (n) => NUM.format(Math.round(n || 0));

/** はじめて出会った日（ISO の文字列）→「11/3」（iOS の .dateTime.month(.defaultDigits).day() と同じ形） */
export function monthDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
}

// ---- 要素を作る小さな道具 ----

/** h('div.card', { onclick }, '字', 子…)。tag は「名前.クラス.クラス」。props の on〜 は addEventListener、style は文字列か物 */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') {
        // 「--c」などの CSS の変数は Object.assign では入らないので setProperty で
        for (const [sk, sv] of Object.entries(v)) {
          if (sv == null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else el.style[sk] = sv;
        }
      }
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k in el && k !== 'type' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** 絵（飾り。指で引っぱれない・長押しのメニューを出さない） */
export function img(src, cls = '', alt = '') {
  const el = h('img' + (cls ? '.' + cls : ''), { src, alt, draggable: false, decoding: 'async' });
  if (!alt) el.setAttribute('aria-hidden', 'true');
  return el;
}

// ---- 小さな絵（iOS は SF Symbols。同じ形を SVG で描く。色は字の色 currentColor）----

const SVG = {
  gear: '<path fill-rule="evenodd" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" d="M20.05 8.97 L23.07 9.76 L23.07 14.24 L20.05 15.03 L19.83 15.55 L21.42 18.24 L18.24 21.42 L15.55 19.83 L15.03 20.05 L14.24 23.07 L9.76 23.07 L8.97 20.05 L8.45 19.83 L5.76 21.42 L2.58 18.24 L4.17 15.55 L3.95 15.03 L0.93 14.24 L0.93 9.76 L3.95 8.97 L4.17 8.45 L2.58 5.76 L5.76 2.58 L8.45 4.17 L8.97 3.95 L9.76 0.93 L14.24 0.93 L15.03 3.95 L15.55 4.17 L18.24 2.58 L21.42 5.76 L19.83 8.45Z M15.4 12a3.4 3.4 0 1 0-6.8 0 3.4 3.4 0 1 0 6.8 0Z"/>',
  crown: '<path d="M2.6 7.2l4.8 3.6L12 4l4.6 6.8 4.8-3.6-1.9 10.3H4.5zM4.6 18.9h14.8c.6 0 1 .4 1 1v.3c0 .6-.4 1-1 1H4.6c-.6 0-1-.4-1-1v-.3c0-.6.4-1 1-1z"/>',
  book: '<path d="M11 5.6C9.2 4.4 6.6 3.8 3.4 3.9c-.6 0-1 .5-1 1v12.6c0 .6.5 1 1.1 1 2.9-.1 5.3.4 7.5 1.7zM13 5.6c1.8-1.2 4.4-1.8 7.6-1.7.6 0 1 .5 1 1v12.6c0 .6-.5 1-1.1 1-2.9-.1-5.3.4-7.5 1.7z"/>',
  pause: '<rect x="5.5" y="4" width="4.6" height="16" rx="1.6"/><rect x="13.9" y="4" width="4.6" height="16" rx="1.6"/>',
  xmark: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" fill="none"/>',
  retry: '<path d="M12 4.5a7.5 7.5 0 1 1-7.3 9.2" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" fill="none"/><path d="M12.6 1.2v7.6L7.2 5z"/>',
  external: '<path d="M14 3.5h6.5V10M20.2 3.8l-8.4 8.4M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  chevron: '<path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  back: '<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  arrowUp: '<path d="M12 20V5M5.5 11.5L12 5l6.5 6.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.6" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
};

export function icon(name, size = 20, cls = '') {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('fill', 'currentColor');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  el.innerHTML = SVG[name] || '';
  return el;
}

// ---- 白い縁取りの文字（OutlinedText）----

/** 字をずらした影を重ねて縁を作る（OutlinedText と同じ: ずらしは字の大きさの 0.07。40px 以上は 24 方向、ほかは 8 方向）。
 *  CSS の -webkit-text-stroke は字の内側にも線が食いこみ、丸ゴシックの太字がつぶれるので使わない */
export function outlineShadow(size, color = '#fff') {
  const n = size >= 40 ? 24 : 8;
  // 8 方向だと斜めのすき間が見えるので、ずらしを少しだけ足した 16 方向にする（iOS の 8 枚重ねは字の形ごとに縁を作るので、すき間が出ない）
  const m = n === 8 ? 16 : n;
  const r = size * 0.07;
  const out = [];
  for (let k = 0; k < m; k++) {
    const a = (k / m) * Math.PI * 2;
    out.push(`${(Math.cos(a) * r).toFixed(2)}px ${(Math.sin(a) * r).toFixed(2)}px 0 ${color}`);
  }
  return out.join(', ');
}

/** 縁取りの字の要素（size は px。色は字の色） */
export function outlined(text, size, color = C.ink, tag = 'div') {
  return h(`${tag}.ol`, { text, style: { fontSize: size + 'px', color, textShadow: outlineShadow(size) } });
}

// ---- ボタン ----

/** 押すと沈む厚みのボタン（ChunkyButtonStyle）。面（.face）の下に濃い色の厚み（.edge）を敷き、押すと面が沈む（ばねで戻る） */
export function chunky(label, { color = C.pink, edge = C.pinkDeep, text = '#fff', size = 22, depth = 6, hPad = 34, vPad = 14, minWidth = 0, fill = false, iconName = null, onClick } = {}) {
  const face = h('span.face', null,
    iconName ? icon(iconName, Math.round(size * 0.95)) : null,
    h('span.label', { text: label }));
  const btn = h('button.chunky' + (fill ? '.fill' : ''), {
    type: 'button',
    style: {
      '--c': color, '--edge': edge, '--fg': text, '--depth': depth + 'px',
      fontSize: size + 'px', minWidth: minWidth ? minWidth + 'px' : null,
    },
    onclick: onClick,
  }, h('span.edge'), face);
  face.style.padding = `${vPad}px ${hPad}px`;
  return btn;
}

/** 押すと「ぷにっ」と縮むボタン（SquishyButtonStyle。一時停止の［つづける］・初めての説明の［はじめる］） */
export function squishy(label, color, onClick) {
  return h('button.squishy', { type: 'button', style: { '--c': color }, onclick: onClick, text: label });
}

/** 字が入りきらなければ縮める（minimumScaleFactor）。base は元の大きさ（px） */
export function fitText(el, base, min = 0.5) {
  el.style.fontSize = base + 'px';
  const room = el.parentElement ? el.parentElement.clientWidth : el.clientWidth;
  const need = el.scrollWidth;
  if (room > 0 && need > room) {
    const k = Math.max(min, room / need);
    el.style.fontSize = (base * k).toFixed(2) + 'px';
    el.style.textShadow = el.classList.contains('ol') ? outlineShadow(base * k) : el.style.textShadow;
  } else if (el.classList.contains('ol')) {
    el.style.textShadow = outlineShadow(base);
  }
}

// ---- 動きの曲線 ----

/** CSS の cubic-bezier と同じ曲線を JavaScript で（requestAnimationFrame で回す動き用） */
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-5) break;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return sy(Math.max(0, Math.min(1, t)));
  };
}

/** SwiftUI の easeIn・easeOut・easeInOut と同じ曲線 */
export const EASE = {
  in: bezier(0.42, 0, 1, 1),
  out: bezier(0, 0, 0.58, 1),
  inOut: bezier(0.42, 0, 0.58, 1),
  outCubic: (u) => 1 - Math.pow(1 - Math.max(0, Math.min(1, u)), 3),
};
export const CSS_EASE = {
  in: 'cubic-bezier(0.42, 0, 1, 1)',
  out: 'cubic-bezier(0, 0, 0.58, 1)',
  inOut: 'cubic-bezier(0.42, 0, 0.58, 1)',
  /** easeOutBack（タイトルのロゴの弾み。ぷくぱくの 520ms と同じ形） */
  outBack: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  /** RowEntrance の曲線 */
  row: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
};

/** SwiftUI の .spring(response:dampingFraction:) と同じ動き（初めの速さ 0）。0→1 の進み具合を返す（行き過ぎて 1 を超える） */
export function springAt(response, damping, t) {
  const w = (2 * Math.PI) / response;
  const z = Math.min(damping, 0.999);
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

const linearFnOK = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('transition-timing-function', 'linear(0, 0.5, 1)');
const springCache = new Map();

/** ばねを CSS の曲線にする。CSS の linear() 関数は「点を並べた曲線」で、等速の linear とは別物（ばねの行き過ぎと戻りをそのまま写せる）。
 *  linear() が使えない古いブラウザでは、行き過ぎのある cubic-bezier で近づける。{ easing, duration（ミリ秒）} */
export function spring(response, damping) {
  const key = response + '/' + damping;
  let s = springCache.get(key);
  if (s) return s;
  const zw = ((2 * Math.PI) / response) * Math.min(damping, 0.999);
  // 揺れが 0.2% より小さくなるまで（長すぎるばねは 2 秒で切る）
  const settle = Math.min(2, -Math.log(0.002) / zw);
  if (linearFnOK) {
    const n = 40;
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(i === n ? '1' : springAt(response, damping, (settle * i) / n).toFixed(4));
    s = { easing: `linear(${pts.join(', ')})`, duration: Math.round(settle * 1000) };
  } else {
    // 行き過ぎの量をばねの減衰で選ぶ（0.6 より柔らかいばねは大きく行き過ぎる）
    s = { easing: damping < 0.6 ? 'cubic-bezier(0.34, 1.56, 0.64, 1)' : 'cubic-bezier(0.22, 1.2, 0.36, 1)', duration: Math.round(Math.min(settle, 0.7) * 1000) };
  }
  springCache.set(key, s);
  return s;
}

/** Web Animations で動かす（{ spring: [response, damping] } か { duration, easing }。delay はミリ秒）。終わった形を残す */
export function animate(el, frames, { spring: sp, duration, easing, delay = 0, fill = 'both' } = {}) {
  if (!el || !el.animate) return null;
  const t = sp ? spring(sp[0], sp[1]) : { duration, easing };
  return el.animate(frames, { duration: t.duration, easing: t.easing, delay, fill });
}

/** :root に ばねの曲線を置く（app.css の transition が var(--sp-…) で読む） */
export function installSprings(root = document.documentElement) {
  const list = {
    // ChunkyButtonStyle: spring(response: 0.2, dampingFraction: 0.62)
    press: [0.2, 0.62],
    // PressScaleStyle: 0.22 / 0.55、SquishyButtonStyle: 0.22 / 0.5
    scale: [0.22, 0.55],
    squish: [0.22, 0.5],
    // 切り替え（せっていのスイッチと区切りの選び）: 0.3 / 0.75
    toggle: [0.3, 0.75],
  };
  for (const [name, [r, d]] of Object.entries(list)) {
    const s = spring(r, d);
    root.style.setProperty(`--sp-${name}`, s.easing);
    root.style.setProperty(`--sp-${name}-d`, s.duration + 'ms');
  }
}

/** 小さな保存（初めての説明を見たか）。storage.js は親の持ち物なので、画面だけが使う鍵をここで読み書きする。
 *  保存できないブラウザ（シークレットのタブなど）でも落ちない */
export const local = {
  get(key) {
    try { return localStorage.getItem('kumopon.' + key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem('kumopon.' + key, value); } catch { /* 残らないだけ */ }
  },
};
