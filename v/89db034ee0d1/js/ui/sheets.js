// 下から出るシート（iOS の .sheet の .large）: せってい（SettingsView.swift）・くもずかん（CloudBookView.swift）・ランキングの入れ物（RankingSheet の外枠）。
// 出るときは iOS のシートと同じく下から（cubic-bezier(0.32, 0.72, 0, 1)。行き過ぎない）、閉じるときは easeIn。
// 上の見出しのあたりを下へ引くと閉じる（presentationDragIndicator の代わり）。後ろの幕を押しても、Esc でも閉じる。
// パソコンの広い画面では、遊ぶ列と同じくらいの幅で真ん中に出す

import { C, h, icon, img, outlined, fmt, monthDay, animate, fitAll, fits, CSS_EASE, EASE, TIERS, IMG, LINKS, DEFAULT_RULES } from './parts.js';
import { VERSION_LABEL } from '../version.js';

const OPEN_MS = 420;
const CLOSE_MS = 260;

export class Sheet {
  /** layer: シートを重ねる要素。title: 見出しの字（縁取り）。titleImg: 見出しの左の絵 */
  constructor(layer, { title, titleImg = null, cls = '', onClose = null }) {
    this.layer = layer;
    this.onClose = onClose;
    this.closeBtn = h('button.press.close-btn', { type: 'button', 'aria-label': 'とじる', onclick: () => this.close() }, icon('xmark', 15));
    this.titleText = outlined(title, 26, C.ink);
    this.titleEl = h('div.sheet-title', null, titleImg ? img(titleImg, 'sheet-title-img') : null, this.titleText);
    this.head = h('div.sheet-head', null, h('div.grabber'), this.titleEl, this.closeBtn);
    this.body = h('div.sheet-body');
    this.panel = h('div.sheet-panel' + (cls ? '.' + cls : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, this.head, this.body);
    this.backdrop = h('div.sheet-backdrop', { onclick: () => this.close() });
    this.root = h('div.sheet', { hidden: true }, this.backdrop, this.panel);
    layer.append(this.root);
    this.isOpen = false;
    this.bindDrag();
  }

  /** 見出しの字を替える（せっていの中の「あそびかた」のページへ移ったとき） */
  setTitle(text) {
    this.titleText.textContent = text;
    this.panel.setAttribute('aria-label', text);
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.returnFocus = document.activeElement;
    this.root.hidden = false;
    this.layer.classList.add('open');
    this.panel.style.transform = '';
    animate(this.backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS * 0.7, easing: CSS_EASE.out, fill: 'none' });
    animate(this.panel, [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: OPEN_MS, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'none' });
    this.body.scrollTop = 0;
    // 見出しの×に指の前の目印を置く（キーボードで閉じられるように）。スクロールで画面が動かないよう preventScroll
    setTimeout(() => this.closeBtn.focus({ preventScroll: true }), 30);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    const from = this.panel.style.transform || 'translateY(0)';
    this.panel.style.transform = '';
    animate(this.backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: CSS_EASE.in, fill: 'forwards' });
    const a = animate(this.panel, [{ transform: from }, { transform: 'translateY(100%)' }], { duration: CLOSE_MS, easing: 'cubic-bezier(0.32, 0, 0.67, 0)', fill: 'forwards' });
    const done = () => {
      this.root.hidden = true;
      this.backdrop.getAnimations?.().forEach((x) => x.cancel());
      this.panel.getAnimations?.().forEach((x) => x.cancel());
      if (!this.layer.querySelector('.sheet:not([hidden])')) this.layer.classList.remove('open');
      if (this.returnFocus && this.returnFocus.focus) this.returnFocus.focus({ preventScroll: true });
      this.onClose?.();
    };
    if (a) a.onfinish = done; else done();
  }

  /** 見出しのあたりを下へ引いて閉じる（120px より下か、速く引いたら閉じる。戻すときはばね） */
  bindDrag() {
    let y0 = 0, t0 = 0, dy = 0, id = null;
    this.head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      id = e.pointerId;
      y0 = e.clientY;
      t0 = e.timeStamp;
      dy = 0;
      this.head.setPointerCapture?.(id);
    });
    this.head.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      dy = Math.max(0, e.clientY - y0);
      this.panel.style.transform = `translateY(${dy}px)`;
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      const v = dy / Math.max(1, e.timeStamp - t0);
      if (dy > 120 || (dy > 30 && v > 0.8)) {
        this.close();
      } else if (dy > 0) {
        const from = `translateY(${dy}px)`;
        this.panel.style.transform = '';
        animate(this.panel, [{ transform: from }, { transform: 'translateY(0)' }], { spring: [0.35, 0.8], fill: 'none' });
      }
    };
    this.head.addEventListener('pointerup', end);
    this.head.addEventListener('pointercancel', end);
  }
}

// ---- せってい ----

/** 切り替え（iOS の Toggle）。onChange(新しい値) */
function toggle(label, value, onChange) {
  const sw = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(value), 'aria-label': label }, h('span.knob'));
  const row = h('div.row.row-toggle', null, h('span.row-label', { text: label }), sw);
  const set = (v) => {
    sw.setAttribute('aria-checked', String(v));
  };
  row.addEventListener('click', (e) => {
    if (row.classList.contains('disabled')) return;
    e.preventDefault();
    const v = sw.getAttribute('aria-checked') !== 'true';
    set(v);
    onChange(v);
  });
  return { row, set, disable: (d) => row.classList.toggle('disabled', d) };
}

/** 区切りの選び（iOS の segmented の Picker）。options: [[値, 字]…]。選んだ印は ばねで横へ動く */
function segmented(label, options, value, onChange) {
  const pill = h('span.seg-pill');
  const btns = options.map(([v, text]) => h('button.seg-opt', { type: 'button', role: 'radio', 'aria-checked': String(v === value), text, onclick: () => pick(v, true) }));
  const el = h('div.seg', { role: 'radiogroup', 'aria-label': label, style: { '--n': options.length } }, pill, ...btns);
  let cur = value;
  const place = () => {
    const i = Math.max(0, options.findIndex(([v]) => v === cur));
    pill.style.transform = `translateX(${i * 100}%)`;
    btns.forEach((b, k) => b.setAttribute('aria-checked', String(k === i)));
  };
  const pick = (v, user) => {
    if (el.classList.contains('disabled')) return;
    if (v === cur && user) return;
    cur = v;
    place();
    if (user) onChange(v);
  };
  place();
  return { el, set: (v) => pick(v, false), disable: (d) => el.classList.toggle('disabled', d) };
}

function group(header, rows, footer) {
  return h('section.group', null,
    header ? h('div.group-head', { text: header }) : null,
    h('div.group-box', null, ...rows),
    footer ? (footer instanceof Node ? footer : h('div.group-foot', { text: footer })) : null);
}

/** せっていの中身。広告・課金・ATT・App Store 用の項目は持たない（ブラウザ版は広告なし・課金なし）。
 *  iOS と違うもの: 振動の行の足元にブラウザの違いを書く・「あそびかた」と「この端末の記録」の行を足す（ブラウザ版には初めの説明を見返す所がほかに無く、
 *  記録はブラウザのデータを消すと消えるため） */
export class SettingsSheet extends Sheet {
  constructor(layer, { onChange, onTap, getRules }) {
    super(layer, { title: 'せってい', cls: 'settings' });
    this.onChange = onChange;
    this.onTap = onTap;
    this.getRules = getRules;
    this.settings = {};
    this.storageOK = true;
    this.isIOS = false;
    this.build();
  }

  build() {
    const set = (k, v) => {
      this.settings = { ...this.settings, [k]: v };
      this.refresh();
      this.onTap();
      this.onChange({ ...this.settings });
    };
    this.haptics = toggle('振動（触覚）', true, (v) => set('haptics', v));
    // 振動のつよさ: 選ぶと、その強さで短く 1 回震える（iOS は「ぽんっ」を鳴らす。ブラウザでは親の tap の振動で代える）
    this.strength = segmented('振動のつよさ', [[0, 'よわい'], [1, 'ふつう'], [2, 'つよい']], 2, (v) => set('strength', v));
    const strengthRow = h('div.row.row-seg', null, h('span.row-label', { text: '振動のつよさ' }), this.strength.el);
    this.sound = toggle('音', true, (v) => set('sound', v));
    this.music = toggle('BGM', true, (v) => set('music', v));
    this.shake = toggle('画面のゆれ', true, (v) => set('shake', v));
    const feelFoot = h('div.group-foot', null,
      h('div', { text: '振動は Android の Chrome で震えます。iPhone のブラウザは震えません。' }),
      h('div', { text: '音は、画面を さいしょに さわったときから 鳴ります。' }));

    // びんのまわる向き（2026-10-20 依頼者「右にずらすと左に倒れると思う人がいる」）
    this.spin = segmented('びんのまわる向き', [[false, 'ゆびと おなじ'], [true, 'ぎゃく']], false, (v) => set('spinReversed', v));
    this.spinFoot = h('div.group-foot');

    const rulesRow = h('button.row.row-link', { type: 'button', onclick: () => { this.onTap(); this.pushRules(); } },
      h('span.row-label', { text: 'あそびかた' }), icon('chevron', 14, 'row-chev'));
    this.storageText = h('div.row.row-text');
    const privacy = h('a.row.row-link', { href: LINKS.privacy, target: '_blank', rel: 'noopener', onclick: () => this.onTap() },
      h('span.row-label', { text: 'プライバシーポリシー' }), icon('external', 16, 'row-chev'));
    this.storeRow = h('a.row.row-link', { href: LINKS.appStore, target: '_blank', rel: 'noopener', onclick: () => this.onTap() },
      h('span.row-label', { text: 'App Store 版（iPhone・振動つき）' }), icon('external', 16, 'row-chev'));

    this.main = h('div.page.page-main', null,
      group(null, [this.haptics.row, strengthRow, this.sound.row, this.music.row, this.shake.row], feelFoot),
      group('びんのまわる向き', [h('div.row.row-seg.solo', null, this.spin.el)], this.spinFoot),
      group(null, [rulesRow]),
      group('この端末の記録', [this.storageText]),
      group(null, [privacy, this.storeRow]),
      // 版（js/version.js）と組みの印。問い合わせのときと、新しい版が届いたかを見るときに使う
      h('div.version', { text: `くもぽん ブラウザ版 ${VERSION_LABEL}` }));
    this.rulesPage = h('div.page.page-rules', { hidden: true });
    this.body.append(this.main, this.rulesPage);
  }

  /** 開く（settings は storage.js の DEFAULT_SETTINGS の形） */
  show(settings, { storageOK = true, isIOS = false } = {}) {
    this.settings = { ...settings };
    this.storageOK = storageOK;
    this.isIOS = isIOS;
    this.popRules(false);
    this.refresh();
    this.open();
  }

  refresh() {
    const s = this.settings;
    this.haptics.set(!!s.haptics);
    this.strength.set(s.strength ?? 2);
    this.strength.disable(!s.haptics);
    this.sound.set(!!s.sound);
    this.music.set(!!s.music);
    // BGM は音を切ったら選べない（iOS と同じ）
    this.music.disable(!s.sound);
    this.shake.set(!!s.shake);
    this.spin.set(!!s.spinReversed);
    this.spinFoot.textContent = s.spinReversed
      ? '右になぞると、びんの口が 左へ たおれます（下の目盛りを びんの底の車輪だと思う向き）。'
      : '右になぞると、びんの口が 右へ たおれます（ゆびと おなじ向き）。';
    this.storageText.replaceChildren(h('div', { text: 'さいこう点・きろく・くもずかんは、この端末の ブラウザに のこります。ブラウザの データを 消すと 消えます。' }));
    if (!this.storageOK) this.storageText.append(h('div.warn', { text: 'いまは 記録が のこりません（シークレットのタブなど）。' }));
    this.storeRow.hidden = !this.isIOS;
  }

  /** 「あそびかた」のページへ（iOS の NavigationStack の押し出しと同じく、右から入って前のページは左へ少し） */
  pushRules() {
    const rules = this.getRules() || DEFAULT_RULES;
    const back = h('button.press.back-btn', { type: 'button', onclick: () => { this.onTap(); this.popRules(true); } }, icon('back', 14), h('span', { text: 'せってい' }));
    this.rulesPage.replaceChildren(back, introGoals(), rulesBox(rules));
    this.rulesPage.hidden = false;
    this.setTitle('あそびかた');
    const ease = 'cubic-bezier(0.32, 0.72, 0, 1)';
    animate(this.rulesPage, [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], { duration: 380, easing: ease, fill: 'none' });
    const a = animate(this.main, [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-30%)', opacity: 0 }], { duration: 380, easing: ease, fill: 'forwards' });
    if (a) a.onfinish = () => { this.main.hidden = true; a.cancel(); };
    this.body.scrollTop = 0;
  }

  popRules(animated) {
    if (this.rulesPage.hidden) return;
    this.main.hidden = false;
    this.setTitle('せってい');
    if (!animated) {
      this.rulesPage.hidden = true;
      return;
    }
    const ease = 'cubic-bezier(0.32, 0.72, 0, 1)';
    animate(this.main, [{ transform: 'translateX(-30%)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], { duration: 380, easing: ease, fill: 'none' });
    const a = animate(this.rulesPage, [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }], { duration: 300, easing: ease, fill: 'forwards' });
    if (a) a.onfinish = () => { this.rulesPage.hidden = true; a.cancel(); };
    this.body.scrollTop = 0;
  }
}

/** 決まりの説明の箱（PauseView の rule の並び。空色の点と、手で入れた改行） */
export function rulesBox(rules) {
  return h('div.rules', null, ...rules.map((r) => h('div.rule', null, h('span.dot'), h('span.rule-text', { text: r }))));
}

/** エンドレスのめあて: にゅうどう雲とにじ雲の絵と、出すと のびる秒（ModeListView.swift の EndlessGoals） */
export function introGoals() {
  const goal = (src, t) => h('div.goal', null, img(src, 'goal-img'), h('div.goal-name', { text: t.name }), h('div.goal-gain', { text: `+${t.gain}びょう` }));
  return h('div.goals', null, goal(IMG.nyudoBig, TIERS[6]), goal(IMG.nijiBig, TIERS[7]));
}


// ---- くもずかん ----

/** くもずかん（各雲の点数表）。いちばん上が にじ雲で、下へ小さくなる。行の間に「2つ くっつくと ↑」。
 *  まだ出会っていない雲は絵だけ影にする。押すと絵が ぷるん と弾む */
export class BookSheet extends Sheet {
  constructor(layer, { onTap }) {
    super(layer, { title: 'くもずかん', cls: 'book' });
    this.onTap = onTap;
  }

  /** book: storage.js の loadBook() の形（[{ made, first }]×8）。tierNames: 段の名前（無ければ写しの表）。focus: 目立たせる段 */
  show(book, tierNames, focus = null) {
    const n = TIERS.length;
    const names = Array.isArray(tierNames) && tierNames.length === n ? tierNames : TIERS.map((t) => t.name);
    const found = (i) => !!(book[i] && book[i].first);
    const foundCount = TIERS.filter((_, i) => found(i)).length;
    const complete = foundCount === n;
    const progress = complete
      ? h('div.book-progress', null, img(IMG.trophy, 'trophy'), h('span.complete', { text: 'ずかん コンプリート!' }))
      : h('div.book-progress', null, h('span', { text: `であった雲 ${foundCount} / ${n} しゅるい` }));
    const list = h('div.book-list');
    const rows = [];
    for (let i = n - 1; i >= 0; i--) {
      const index = n - 1 - i;
      const row = this.row(i, names[i], book[i] || { made: 0, first: null }, found(i), focus === i, i === n - 1);
      row.style.animationDelay = `${0.036 * Math.min(index, 20)}s`;
      list.append(row);
      rows[i] = row;
      if (i > 0) {
        const arrow = h('div.merge-arrow' + (found(i) ? '' : '.faint'), null, icon('arrowUp', 13), h('span', { text: '2つ くっつくと' }));
        arrow.style.animationDelay = `${0.036 * Math.min(index + 1, 20)}s`;
        list.append(arrow);
      }
    }
    list.append(h('div.book-foot', { text: 'にじ雲どうしは くっつかない。口から 出すか、のこったまま おわると 点' }));
    this.body.replaceChildren(progress, list);
    this.open();
    fitAll(list);
    // 結果の「そだてた雲」から開いたときは、その雲の行へ（上の 3 段なら最初から見えている）
    if (focus != null && focus < n - 3 && rows[focus]) {
      setTimeout(() => this.scrollTo(rows[focus]), 450);
    }
  }

  row(i, name, entry, found, highlighted, top) {
    const t = TIERS[i];
    const art = h('div.book-art' + (found ? '' : '.shadow'), null, img(IMG.cloud(i), 'book-cloud'));
    const detail = !entry.first ? 'まだ であっていない'
      : i === 0 ? `空から くる いちばん小さな雲・${monthDay(entry.first)} から`
        : `そだてた かず ${fmt(entry.made)}・はじめて ${monthDay(entry.first)}`;
    const swatch = `rgb(${t.swatch.map((v) => Math.round(v * 255)).join(',')})`;
    const row = h('div.book-row' + (found ? '.found' : '') + (top ? '.top' : '') + (highlighted ? '.focus' : ''), {
      role: 'button', tabindex: '0', 'aria-label': `${name}、${i + 1}段目、${fmt(t.points)} 点${t.gain ? `、+${t.gain}びょう` : ''}。${detail}`,
    },
    art,
    h('div.book-info', null,
      // 名前と点は、横の札〈何段目・+45びょう〉の分を空けて縮める（iOS の minimumScaleFactor）。縮めても入らない狭い画面では札が次の行へ回る
      h('div.book-name-line', null, fits(h('span.book-name', { text: name }), top ? 19 : 17, 0.7), h('span.book-tier', { text: `${i + 1}段目` })),
      h('div.book-pts-line', null,
        fits(h('span.book-pts', { text: `${fmt(t.points)} 点` }), top ? 20 : 17, 0.6),
        t.gain > 0 ? h('span.book-gain', { text: `+${t.gain}びょう` }) : null),
      h('div.size-bar', null,
        h('div.size-track', null, h('div.size-fill', { style: { width: `max(6px, ${(t.widthRatio * 100).toFixed(1)}%)`, background: swatch } })),
        h('span.size-text', { text: `びんの ${Math.round(t.widthRatio * 100)}%` })),
      h('div.book-detail', { text: detail })));
    const bounce = () => {
      // ぷるん: 横に伸びて縦に縮んでから、ばねで戻る（spring 0.42 / 0.32。CloudArt）
      animate(art.firstChild, [{ transform: 'scale(1.14, 0.86)' }, { transform: 'scale(1, 1)' }], { spring: [0.42, 0.32], fill: 'none' });
    };
    row.addEventListener('click', bounce);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bounce(); } });
    return row;
  }

  /** その行が真ん中に来るまで、0.5 秒の easeInOut でなめらかに送る */
  scrollTo(row) {
    const box = this.body;
    const from = box.scrollTop;
    const target = Math.max(0, Math.min(box.scrollHeight - box.clientHeight,
      row.offsetTop - box.offsetTop - (box.clientHeight - row.offsetHeight) / 2));
    const t0 = performance.now();
    const step = (now) => {
      const u = Math.min(1, (now - t0) / 500);
      box.scrollTop = from + (target - from) * EASE.inOut(u);
      if (u < 1 && this.isOpen) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

// ---- ランキングの入れ物 ----

/** ランキングのシート（RankingSheet の外枠: 王冠の絵と見出しと×だけ）。中身は親（ranking.js）が slot に入れる。
 *  閉じたら slot に 'rankingclose' の出来事を送る（親が読み込みを止められるように） */
export class RankingSheet extends Sheet {
  constructor(layer) {
    super(layer, { title: 'ランキング', titleImg: IMG.crown, cls: 'ranking', onClose: () => this.slot.dispatchEvent(new CustomEvent('rankingclose')) });
    this.slot = h('div.ranking-slot');
    this.body.append(this.slot);
  }
}
