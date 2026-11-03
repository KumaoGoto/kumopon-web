// ブラウザ版くもぽんの画面（iOS の App/Shell の SwiftUI の画面を HTML と CSS に写したもの）。main.js はこの UI だけを呼ぶ。
//
//   タイトル（TitleView.swift）: 空の絵・流れる雲・弾むロゴと光の筋・「さいこう N 点」・右上の歯車・［はじめる］［ランキング］［くもずかん］・
//                                 初めての人への説明のカード（ModeIntroCard）・iPhone の人への App Store の帯・記録が残らない端末の注意
//   遊ぶ画面の上の帯（HUDView.swift → hud.js）・一時停止（PauseView）・結果（ResultView.swift）
//   シート（sheets.js）: せってい・くもずかん・ランキングの入れ物（中身は親）
//   画面の切り替えの雲（CloudWipe.swift → wipe.js）
//
// 遊んでいる間は、びんを回す指を下の <canvas id="game"> が取る。#ui は指を通し（pointer-events: none）、ボタンだけが指を受ける。
// ボタンを押したら、まず handlers.tap()（親が小さな音と振動を鳴らす。最初の一押しで音を起こす）、それから各 handler を呼ぶ。
// start・restart・menu の切り替えの雲は親が ui.wipe で回す（この UI からは wipe を呼ばない）
//
//   const ui = new UI(document.getElementById('ui'), { start, pause, resume, restart, menu, openRanking, settingsChanged, tap });
//   ui.showTitle({ best, book, isIOS, storageOK }) / ui.showPlaying() / ui.hud(h) / ui.showPause(h) / ui.hidePause()
//   ui.showResult(result, { isNewBest, records, addedId, bookNew }) / ui.setRunRank(text|null)
//   ui.openSettings(settings) / ui.openBook(book, tierNames) / ui.wipe(midway) / ui.rankingSlot()

import { C, h, icon, img, outlined, chunky, squishy, fmt, fitText, fitAll, fits, animate, installSprings, CSS_EASE, EASE, IMG, LINKS, TIERS, DEFAULT_RULES, ENDLESS_INTRO, local } from './parts.js';
import { HUD } from './hud.js';
import { CloudWipe } from './wipe.js';
import { SettingsSheet, BookSheet, RankingSheet, rulesBox, introGoals } from './sheets.js';
import { loadSettings, loadBook } from '../storage.js';

/** タイトルの空を流れる雲（DriftingClouds）: 帯の中の高さの割合・大きさ・速さ（px/秒）・位相・段（くもずかんの絵。にじ雲は見せ場なので流さない） */
const DRIFT = [
  { y: 0.12, size: 64, speed: 13, phase: 0.1, tier: 1 },
  { y: 0.42, size: 40, speed: 21, phase: 0.6, tier: 5 },
  { y: 0.66, size: 56, speed: 16, phase: 0.35, tier: 4 },
  { y: 0.92, size: 34, speed: 26, phase: 0.85, tier: 2 },
  { y: 0.28, size: 30, speed: 19, phase: 0.2, tier: 3 },
  { y: 0.80, size: 46, speed: 11, phase: 0.55, tier: 0 },
];
/** 絵の雲の一辺は size の 1.55 倍（丸いので、前の横長の白い雲〈幅 1.6×size〉と同じくらいに見える） */
const ART_SCALE = 1.55;

/** 初めての説明を見たか（GameSettings.introSeen。画面だけが使う鍵） */
const INTRO_KEY = 'intro.endless';

/** アドレスバーの色（iOS の AppRoot.stripColor にあたる: タイトルは空の絵の上の色、遊ぶ間は場面の空の上の色、結果は夕方の空の上の色。
 *  JarModeV4.Tuning.skyTop・duskTop） */
const THEME = { title: '#98d0f9', playing: '#b2dbfd', result: '#b5c2fb' };

export class UI {
  constructor(root, handlers) {
    this.root = root;
    this.handlers = handlers;
    this.screen = null;
    this.lastHud = null;
    this.book = null;
    this.isIOS = false;
    this.storageOK = true;
    this.starting = false;
    installSprings();
    root.classList.add('ui', 'fonts-pending');
    // iPhone の Safari は、触れたときの出来事を聞いている所がないと :active（押した形）にならない
    document.addEventListener('touchstart', () => {}, { passive: true });

    this.titleEl = h('section.screen.title-screen', { hidden: true, 'aria-label': 'タイトル' });
    this.hudEl = h('section.screen.hud', { hidden: true, 'aria-label': 'あそぶ画面' });
    this.pauseEl = h('section.overlay.pause-layer', { hidden: true });
    this.resultEl = h('section.overlay.result-layer', { hidden: true });
    this.introEl = h('section.overlay.intro-layer', { hidden: true });
    this.sheetLayer = h('div.sheets');
    root.append(this.titleEl, this.hudEl, this.pauseEl, this.resultEl, this.introEl, this.sheetLayer);
    this.wiper = new CloudWipe(root);

    this.hudView = new HUD(this.hudEl, { onPause: () => this.press(() => this.handlers.pause()) });
    this.settingsSheet = new SettingsSheet(this.sheetLayer, {
      onChange: (s) => this.handlers.settingsChanged?.(s),
      onTap: () => this.handlers.tap?.(),
      getRules: () => this.lastHud?.pauseRules,
    });
    this.bookSheet = new BookSheet(this.sheetLayer, { onTap: () => this.handlers.tap?.() });
    this.rankingSheet = new RankingSheet(this.sheetLayer);
    this.buildTitle();

    // 長押しのメニュー・絵の引っぱり・文字の選択を止める（CSS でも止めている。ここは右クリックのメニュー）
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('dragstart', (e) => e.preventDefault());
    addEventListener('keydown', (e) => this.onKey(e));
    addEventListener('resize', () => this.onResize());
    this.waitFonts();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ======== 親が呼ぶもの ========

  /** タイトルを出す（book は storage.js の loadBook() の形） */
  showTitle({ best = 0, book = null, isIOS = false, storageOK = true } = {}) {
    this.screen = 'title';
    this.starting = false;
    this.book = book;
    this.isIOS = isIOS;
    this.storageOK = storageOK;
    this.hideOverlay(this.pauseEl, false);
    this.hideOverlay(this.resultEl, false);
    this.hideOverlay(this.introEl, false);
    this.hudEl.hidden = true;
    this.hudView.reset();
    // 「さいこう N 点」（0 点なら出さない。場所は空けておく）
    this.bestPill.textContent = best > 0 ? `さいこう ${fmt(best)} 点` : ' ';
    this.bestPill.classList.toggle('empty', !(best > 0));
    this.iosBand.hidden = !isIOS;
    this.storageNote.hidden = storageOK;
    this.titleEl.hidden = false;
    this.setTheme(THEME.title);
    this.appearTitle();
    requestAnimationFrame(() => this.measureBand());
  }

  /** 遊ぶ画面へ（親が切り替えの雲の裏で呼ぶ） */
  showPlaying() {
    this.screen = 'playing';
    this.starting = false;
    this.titleEl.hidden = true;
    this.hideOverlay(this.introEl, false);
    this.hideOverlay(this.pauseEl, false);
    this.hideOverlay(this.resultEl, false);
    this.closeSheets();
    this.hudView.reset();
    this.hudView.setFinished(false);
    this.hudEl.hidden = false;
    this.setTheme(THEME.playing);
  }

  /** 上の表示（WebAssembly の HUD の JSON。変わったときだけ来る） */
  hud(hd) {
    if (!hd) return;
    this.lastHud = hd;
    if (this.screen === 'playing') this.hudView.update(hd);
  }

  /** 一時停止の画面（決まりの説明は h.pauseRules） */
  showPause(hd) {
    if (hd) this.lastHud = hd;
    this.hudView.setPaused(true);
    this.buildPause(this.lastHud);
    this.showOverlay(this.pauseEl);
  }

  hidePause() {
    this.hudView.setPaused(false);
    this.hideOverlay(this.pauseEl, true);
  }

  /** 結果（result は WebJSON.swift の result、extra は { isNewBest, records, addedId, bookNew }） */
  showResult(result, extra = {}) {
    this.screen = 'result';
    this.hudView.setFinished(true);
    this.hideOverlay(this.pauseEl, false);
    this.buildResult(result, extra);
    this.resultEl.hidden = false;
    this.resultEl.classList.add('shown');
    fitAll(this.resultEl);   // 見えてから（幅が決まってから）字を箱に収める
    this.setTheme(THEME.result);
  }

  /** 結果の順位の行（送ったあとで少し遅れて来る）。text は「きょう 3い・こんしゅう 5い」や「ランキングに おくれませんでした（あとで おくります）」。null で消す */
  setRunRank(text) {
    const line = this.rankLine;
    if (!line) return;
    if (!text) {
      line.replaceChildren();
      line.hidden = true;
      return;
    }
    line.hidden = false;
    line.replaceChildren(this.rankContent(String(text)));
    fitAll(line);
    animate(line.firstChild, [{ transform: 'scale(0.8)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { spring: [0.4, 0.7] });
  }

  /** せっていのシート（settings は storage.js の DEFAULT_SETTINGS の形）。変えたら handlers.settingsChanged(新しい settings) */
  openSettings(settings) {
    this.settingsSheet.show({ ...(settings || loadSettings()) }, { storageOK: this.storageOK, isIOS: this.isIOS });
  }

  /** くもずかんのシート（focus は目立たせる段。結果の「そだてた雲」から） */
  openBook(book, tierNames = null, focus = null) {
    this.bookSheet.show(book || this.readBook(), tierNames, focus);
  }

  /** 切り替えの雲で覆い、覆ったところで midway() を呼び、晴らす */
  wipe(midway) {
    this.wiper.run(midway);
  }

  /** ランキングのシートの中身を入れる要素（中身は親が作る。閉じると 'rankingclose' の出来事が来る） */
  rankingSlot() {
    return this.rankingSheet.slot;
  }

  // ======== タイトル ========

  buildTitle() {
    const bg = img(IMG.titleBg, 'title-bg');
    this.drift = h('div.drift', { 'aria-hidden': 'true' });
    this.driftClouds = DRIFT.map((c) => {
      const el = img(IMG.cloud(c.tier), 'drift-cloud');
      this.drift.append(el);
      return { ...c, el };
    });

    // 右上の歯車（せってい）
    const gear = h('button.press.gear-btn', { type: 'button', 'aria-label': 'せってい', onclick: () => this.press(() => this.openSettings(loadSettings())) }, icon('gear', 22));
    // iPhone で開いた人への帯（依頼者の決定: 遊べるようにしたまま、App Store 版を勧める）
    this.iosBand = h('a.ios-band', { href: LINKS.appStore, target: '_blank', rel: 'noopener', hidden: true, onclick: () => this.handlers.tap?.() },
      h('span.band-text', null, h('span', { text: 'iPhone は アプリ版が おすすめ' }), h('span.band-sub', { text: 'App Store・振動つき・同じ あそびかた' })),
      icon('chevron', 13, 'band-chev'));
    const top = h('div.title-top', null, this.iosBand, h('div.spacer'), gear);

    // ロゴ（弾んで出て、上下にゆれる）と、後ろの光の筋（ゆっくり振れる）
    this.rays = this.buildRays();
    this.logo = img(IMG.titleLogo, 'title-logo', 'くもぽん');
    this.logoBob = h('div.logo-bob', null, this.logo);
    this.logoPop = h('div.logo-pop', null, this.logoBob);
    this.bestPill = h('div.best-pill.empty', { text: ' ' });
    this.logoBlock = h('div.logo-block', null, h('div.logo-frame', null, this.rays, this.logoPop), this.bestPill);

    // ［はじめる］＝エンドレス（唯一の遊び方）。金の［ランキング］と空色の［くもずかん］を横に
    const start = chunky('はじめる', { color: C.pink, edge: C.pinkDeep, size: 28, depth: 7, hPad: 40, vPad: 16, minWidth: 236, onClick: () => this.onStart() });
    const ranking = chunky('ランキング', { color: C.gold, edge: C.goldDeep, text: C.ink, size: 17, depth: 6, hPad: 16, vPad: 12, minWidth: 152, iconName: 'crown', onClick: () => this.press(() => this.openRanking()) });
    const book = chunky('くもずかん', { color: C.bookBlue, edge: C.bookBlueDeep, text: C.ink, size: 17, depth: 6, hPad: 16, vPad: 12, minWidth: 152, iconName: 'book', onClick: () => this.press(() => this.openBook(this.readBook())) });
    this.titleButtons = h('div.title-buttons', null, start, h('div.title-row', null, ranking, book));
    this.storageNote = h('div.storage-note', { hidden: true, text: 'この端末に 記録が のこりません（シークレットのタブなど）' });
    const col = h('div.col.title-col', null,
      top,
      h('div.title-gap'),
      this.logoBlock,
      h('div.title-flex'),
      this.titleButtons,
      h('div.title-bottom', null, this.storageNote));
    this.titleEl.append(bg, this.drift, col);
  }

  /** ロゴの後ろの光の筋（TitleRays）: 中心から 14 本、±0.1 rad を 9 秒で 1 往復（折り返しは easeInOut）。
   *  中心から離れるほど薄く、横長の楕円に消える。iOS は Canvas で毎フレーム描く。ここは SVG を 1 度描いて CSS で回す */
  buildRays() {
    const reach = Math.min(520, 300 / 0.62) * 0.5;
    const R = reach * 1.6;
    const n = 14;
    let wedges = '';
    for (let i = 0; i < n; i++) {
      const a0 = (2 * Math.PI * i) / n;
      const a1 = a0 + (Math.PI / n) * 0.9;
      wedges += `<path d="M0 0L${(Math.cos(a0) * R).toFixed(1)} ${(Math.sin(a0) * R).toFixed(1)}L${(Math.cos(a1) * R).toFixed(1)} ${(Math.sin(a1) * R).toFixed(1)}Z"/>`;
    }
    const svg = `<svg class="rays-svg" viewBox="${-R} ${-R} ${2 * R} ${2 * R}" width="${2 * R}" height="${2 * R}" style="left:${-R}px;top:${-R}px">
      <defs>
        <radialGradient id="rays-g" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${reach}">
          <stop offset="0" stop-color="#fff" stop-opacity="0.42"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.168"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="rays-c" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${reach * 0.8}">
          <stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <g class="rays-rot" fill="url(#rays-g)">${wedges}</g>
      <circle r="${reach * 0.8}" fill="url(#rays-c)"/>
    </svg>`;
    return h('div.rays', { 'aria-hidden': 'true' }, h('div.rays-squash', { html: svg }));
  }

  /** タイトルが出るたびに: ロゴは 0.6 から easeOutBack で弾み（0.52 秒）、透明度は別の easeOut（0.22 秒）。
   *  ボタンは下から 30px、ばね（0.6 / 0.7）で 0.15 秒遅れて */
  appearTitle() {
    animate(this.logoPop, [{ transform: 'scale(0.6)' }, { transform: 'scale(1)' }], { duration: 520, easing: CSS_EASE.outBack });
    animate(this.logoPop, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: CSS_EASE.out, fill: 'none' });
    animate(this.bestPill, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: CSS_EASE.out, fill: 'none' });
    animate(this.titleButtons, [{ transform: 'translateY(30px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { spring: [0.6, 0.7], delay: 150 });
  }

  /** 雲が通る帯（ロゴとさいこう点の下から［はじめる］の上まで）を測る */
  measureBand() {
    if (this.titleEl.hidden) return;
    const a = this.logoBlock.getBoundingClientRect();
    const b = this.titleButtons.getBoundingClientRect();
    const o = this.titleEl.getBoundingClientRect();
    const top = a.bottom - o.top, bottom = b.top - o.top;
    this.band = bottom - top > 40 ? { top, bottom } : { top: o.height * 0.45, bottom: o.height * 0.68 };
  }

  /** 流れる雲を置く（時間で位置を決めるだけの飾り。横は一定の速さで流れ、上下のゆれ・傾き・つぶれは sin で。iOS と同じ式） */
  driftTick(now) {
    if (!this.band) return;
    this.drift.classList.add('placed');
    const t = now / 1000;
    const W = this.titleEl.clientWidth;
    const height = this.band.bottom - this.band.top;
    for (const c of this.driftClouds) {
      // 帯の半分より大きくしない。上下のゆれ（±4）と余白を見込む
      const size = Math.min(c.size, Math.max(20, height * 0.5));
      const half = (size * ART_SCALE) / 2 + 8;
      const span = W + size * 3;
      const x = ((t * c.speed + c.phase * span) % span) - size * 1.5;
      const bob = Math.sin(t * 0.8 + c.phase * 6) * 4;
      const y = this.band.top + half + c.y * Math.max(0, height - 2 * half);
      const wob = Math.sin(t * 1.3 + c.phase * 9);
      const rot = 4 * Math.sin(t * 0.7 + c.phase * 5);
      const s = size * ART_SCALE;
      c.el.style.width = s + 'px';
      // ぷるん: 傾き ±4°・横に伸びて縦に縮む ±4%（下を支点に）
      c.el.style.transform = `translate(${(x - s / 2).toFixed(1)}px, ${(y + bob - s / 2).toFixed(1)}px) rotate(${rot.toFixed(2)}deg) scale(${(1 + 0.04 * wob).toFixed(3)}, ${(1 - 0.04 * wob).toFixed(3)})`;
    }
  }

  onStart() {
    if (this.starting) return;
    this.handlers.tap?.();
    if (local.get(INTRO_KEY)) {
      this.starting = true;
      this.handlers.start();
    } else {
      this.showIntro();
    }
  }

  /** 初めての人への説明（ModeIntroCard。［はじめる］から出すときの見出しは「はじめての かたへ」「あそびかた」） */
  showIntro() {
    const card = h('div.card.intro-card', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'あそびかた' },
      h('div.kicker', { text: 'はじめての かたへ' }),
      outlined('あそびかた', 28, C.ink),
      introGoals(),
      h('div.intro-lines', null, ...ENDLESS_INTRO.map((line) => h('div.intro-line', null, h('span.dot', { style: { background: C.modeEndless } }), h('span', { text: line })))),
      squishy('はじめる', C.modeEndless, () => {
        if (this.starting) return;
        this.starting = true;
        local.set(INTRO_KEY, '1');
        this.handlers.tap?.();
        this.handlers.start();
      }),
      h('button.text-btn', { type: 'button', text: 'もどる', onclick: () => this.press(() => this.hideOverlay(this.introEl, true)) }));
    this.introEl.replaceChildren(h('div.dim'), h('div.center', null, card));
    this.showOverlay(this.introEl, card);
  }

  // ======== 一時停止 ========

  /** 一時停止の重ね画面。［つづける］を大きく真ん中に、［やりなおす］をその下に、［タイトルへ］はいちばん下に小さく離す
   *  （つづけるの近くに、ランを捨てるボタンを置かない。タイトルへは確認なし） */
  buildPause(hd) {
    const rules = (hd && hd.pauseRules) || DEFAULT_RULES;
    const card = h('div.card.pause-card', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'ひとやすみ' },
      h('div.pause-title', { text: 'ひとやすみ' }),
      h('div.pause-mode', { text: 'エンドレス' }),
      rulesBox(rules),
      h('button.press.book-chip', { type: 'button', onclick: () => this.press(() => this.openBook(this.readBook())) }, icon('book', 14), h('span', { text: '雲の点数（くもずかん）' })),
      squishy('つづける', C.mint, () => this.press(() => this.handlers.resume())),
      h('button.press.retry-btn', { type: 'button', onclick: () => this.press(() => this.handlers.restart()) }, icon('retry', 17), h('span', { text: 'やりなおす' })),
      h('button.text-btn.to-title', { type: 'button', text: 'タイトルへ', onclick: () => this.press(() => this.handlers.menu()) }));
    // 後ろのびんは止めた所のまま見せる。後ろを押しても何も起きない
    this.pauseEl.replaceChildren(h('div.dim'), h('div.center', null, card));
  }

  // ======== 結果 ========

  /** 結果のカード: 点は 0.25 秒待って 0.8 秒で数え上げ（最初速く最後ゆっくり）、数え終わった頃（1.1 秒）に級の札が落ちて弾む。
   *  後ろの空（お祝いの空の絵）は暗くしない。カードの後ろにだけ白い薄い幕 */
  buildResult(r, extra) {
    const { isNewBest = !!r.isNewBest, records = [], bookNew = [] } = extra || {};
    const score = outlined('0', 56, C.ink);
    score.classList.add('result-score');
    const best = Math.max(r.best || 0, records && records[0] ? records[0].score : 0);
    const bestEl = isNewBest ? h('div.new-best', { text: 'ベスト こうしん!' })
      : best > 0 ? h('div.best-line', { text: `ベスト ${fmt(best)}` }) : null;
    const note = r.bestNote ? h('div.best-note', { text: r.bestNote }) : null;

    // 級（にじ雲の数。事実だけ）と、届かなかった回の一言（飾らない。ニアミスを祝わない）
    let grade = null;
    if (r.grade) grade = this.gradeBadge(r);
    else if (r.cheer) grade = h('div.cheer', { text: r.cheer });

    const stats = (r.customStats && r.customStats.length ? r.customStats : [
      { label: 'にじ雲', value: `${r.rainbows}こ` },
      { label: 'いっぺんに', value: r.maxRainbowsPerSqueeze >= 2 ? `${r.maxRainbowsPerSqueeze}こ` : '—' },
      { label: 'しぼった', value: `${r.squeezed}こ` },
    ]).map((s) => {
      if (s.label === 'そだてた雲') {
        // 押すと くもずかん（その雲の行を目立たせる）
        return h('button.press.stat.link', { type: 'button', onclick: () => this.press(() => this.openBook(this.readBook(), null, r.maxTier)) },
          fits(h('div.stat-value', { text: s.value }), 18, 0.5), fits(h('div.stat-label', null, h('span', { text: s.label }), icon('book', 9)), 11, 0.8));
      }
      // 箱の幅に収める（iOS の lineLimit(1)・minimumScaleFactor。「にゅうどう雲」が箱からはみ出さない。Android の大きな文字の設定でも
      // 読めるよう、数字の箱は iOS の 0.6 より小さい 0.5 まで縮める）
      return h('div.stat', null, fits(h('div.stat-value', { text: s.value }), 18, 0.5), fits(h('div.stat-label', { text: s.label }), 11, 0.8));
    });

    // 「ずかんに のった! にゅうどう雲」（はじめて出会った雲。押すと くもずかん）
    let fresh = null;
    const news = (bookNew || []).filter((t) => t >= 0 && t < TIERS.length);
    if (news.length) {
      const text = news.length >= 3 ? `ずかんに ${news.length}しゅるい のった!` : `ずかんに のった! ${news.map((t) => TIERS[t].name).join('・')}`;
      fresh = fits(h('button.press.book-chip.fresh', { type: 'button', onclick: () => this.press(() => this.openBook(this.readBook(), null, r.maxTier)) }, icon('book', 12), h('span', { text })), 13, 0.7);
    }

    this.rankLine = h('div.rank-line', { hidden: true });
    // ［シェア］（iOS の ResultView と同じく、3 つのボタンの上に小さく。文と URL は js/share.js）
    const share = h('button.press.share-btn', { type: 'button', onclick: () => this.press(() => this.handlers.share?.(r)) },
      icon('share', 15), h('span', { text: 'シェア' }));
    const buttons = h('div.result-buttons', null,
      chunky('ランキング', { color: '#fff', edge: 'rgba(140,112,133,0.45)', text: C.ink, size: 15, depth: 5, hPad: 6, vPad: 12, fill: true, onClick: () => this.press(() => this.openRanking()) }),
      chunky('もう一度', { color: C.pink, edge: C.pinkDeep, size: 17, depth: 5, hPad: 6, vPad: 12, fill: true, onClick: () => this.press(() => this.handlers.restart()) }),
      chunky('タイトルへ', { color: C.blush, edge: 'rgba(255,133,158,0.55)', text: C.ink, size: 15, depth: 5, hPad: 6, vPad: 12, fill: true, onClick: () => this.press(() => this.handlers.menu()) }));

    const card = h('div.card.result-card', { role: 'dialog', 'aria-label': `けっか ${fmt(r.score)} 点` },
      h('div.result-mode', { text: 'エンドレス' }),
      h('div.score-box', null, score),
      bestEl, note, grade,
      h('div.stats', null, ...stats),
      fresh,
      this.rankLine,
      share,
      buttons);
    // にじ雲を作った回は、カードの右上の角に にじ雲の絵（級の札と一緒に落ちてきて、ゆっくり上下にゆれる）
    let sticker = null;
    if (r.grade && r.rainbows > 0) {
      sticker = h('div.sticker', null, img(IMG.nijiBig, 'sticker-img'));
      card.append(sticker);
    }
    const wrap = h('div.result-wrap', null, h('div.result-glow'), card);
    this.resultEl.replaceChildren(h('div.center', null, wrap));

    // 出る: ばね（0.42 / 0.62）で 0.7 倍から
    animate(wrap, [{ transform: 'scale(0.7)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { spring: [0.42, 0.62] });
    // 数え上げ
    this.count = { el: score, target: r.score || 0, t0: performance.now() + 250, shown: -1, digits: 0 };
    // 級の札とシール: 1.1 秒で 1.9 倍・上 26px から「どん」と落ちて弾む（ばね 0.38 / 0.52）
    if (grade && r.grade) {
      animate(grade, [{ transform: 'translateY(-26px) scale(1.9)', opacity: 0 }, { transform: 'translateY(0) scale(1)', opacity: 1 }], { spring: [0.38, 0.52], delay: 1100 });
    }
    if (sticker) {
      animate(sticker, [{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { spring: [0.38, 0.52], delay: 1100 });
    }
  }

  /** 級の札: バッジの絵（にじ雲 1 こ プロ級・2 こ ランカー級・3 こ以上 でんせつ級）の帯に級の名前、横に「にじ雲 ×N」。絵が読めなければ 7 色の帯の札 */
  gradeBadge(r) {
    const n = r.rainbows >= 3 ? 3 : r.rainbows === 2 ? 2 : 1;
    const name = n === 3 ? 'でんせつ級' : n === 2 ? 'ランカー級' : 'プロ級';
    const pic = img(IMG.badge(n), 'badge-img');
    const el = h('div.grade', { role: 'img', 'aria-label': r.grade },
      h('div.badge', null, pic, h('span.badge-name', { text: name })),
      h('div.grade-text', null, h('div.grade-name', { text: name }), h('div.grade-sub', { text: `にじ雲 ×${r.rainbows}` })));
    pic.addEventListener('error', () => {
      el.replaceChildren(h('div.grade-band', { text: r.grade }));
    }, { once: true });
    return el;
  }

  /** 順位の行の中身: 「きょう 3い・こんしゅう 5い」の形なら札を並べ（RankChip。いちばん左は金。数は大きい数から自分の順位へ数え下ろす）、
   *  ほかの文はそのまま小さく */
  rankContent(text) {
    const parts = text.split(/[・、]/).map((s) => s.trim()).filter(Boolean);
    const chips = parts.map((p) => p.match(/^(.+?)\s*(\d[\d,]*)\s*(い|位)$/));
    if (parts.length && chips.every(Boolean)) {
      const row = h('button.press.rank-chips', { type: 'button', 'aria-label': text, onclick: () => this.press(() => this.openRanking()) });
      chips.forEach((m, i) => {
        const rank = Number(m[2].replace(/,/g, ''));
        const num = fits(h('div.chip-rank', { text: `${rank}位` }), 16, 0.6);
        row.append(h('div.rank-chip' + (i === 0 ? '.gold' : ''), null, fits(h('div.chip-title', { text: m[1] }), 10, 0.8), num));
        // 0.6 秒で数え下ろす（最後ゆっくり）
        const start = Math.max(rank * 3, rank + 20);
        const t0 = performance.now();
        const step = (now) => {
          const u = Math.min(1, (now - t0) / 600);
          num.textContent = `${start - Math.round((start - rank) * EASE.outCubic(u))}位`;
          if (u < 1 && num.isConnected) requestAnimationFrame(step);
          else if (num.isConnected) fitAll(row);   // 数え終わった数で収め直す
        };
        requestAnimationFrame(step);
      });
      return row;
    }
    return h('button.press.rank-text', { type: 'button', onclick: () => this.press(() => this.openRanking()) }, icon('crown', 12, 'rank-crown'), h('span', { text }));
  }

  // ======== 小さな道具 ========

  /** ボタンの手応え（親の tap）を鳴らしてから動かす */
  press(fn) {
    this.handlers.tap?.();
    fn();
  }

  setTheme(color) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
  }

  openRanking() {
    this.rankingSheet.open();
    this.handlers.openRanking?.();
  }

  /** くもずかんの最新（結果のあとはタイトルを通らずに［もう一度］で遊ぶので、開くたびに保存から読む） */
  readBook() {
    try {
      return loadBook();
    } catch {
      return this.book || TIERS.map(() => ({ made: 0, first: null }));
    }
  }

  closeSheets() {
    for (const s of [this.settingsSheet, this.bookSheet, this.rankingSheet]) if (s.isOpen) s.close();
  }

  /** 重ね画面を出す（後ろの幕は easeOut 0.18 秒。カードはばね 0.35 / 0.8 で 0.94 倍から） */
  showOverlay(el, card = el.querySelector('.card')) {
    el.hidden = false;
    el.classList.add('shown');
    el.getAnimations?.({ subtree: false }).forEach((a) => a.cancel());
    animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: CSS_EASE.out, fill: 'none' });
    if (card) animate(card, [{ transform: 'scale(0.94)' }, { transform: 'scale(1)' }], { spring: [0.35, 0.8], fill: 'none' });
    const first = card && card.querySelector('.squishy, .chunky');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
  }

  hideOverlay(el, animated) {
    if (el.hidden) return;
    el.classList.remove('shown');
    if (!animated) {
      el.getAnimations?.().forEach((a) => a.cancel());
      el.hidden = true;
      el.replaceChildren();
      return;
    }
    const a = animate(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: CSS_EASE.out, fill: 'forwards' });
    const done = () => {
      if (el.classList.contains('shown')) return;
      el.hidden = true;
      el.replaceChildren();
      a?.cancel();
    };
    if (a) a.onfinish = done; else done();
  }

  /** パソコン: Esc でシートを閉じる・説明から戻る・遊んでいる間は一時停止と再開 */
  onKey(e) {
    if (e.key !== 'Escape') return;
    const open = [this.rankingSheet, this.bookSheet, this.settingsSheet].find((s) => s.isOpen);
    if (open) return open.close();
    if (!this.introEl.hidden) return this.hideOverlay(this.introEl, true);
    if (this.screen === 'playing') {
      if (!this.pauseEl.hidden) this.press(() => this.handlers.resume());
      else if (!this.hudView.pauseBtn.classList.contains('off')) this.press(() => this.handlers.pause());
    }
  }

  onResize() {
    this.measureBand();
    fitAll(this.root);   // 字を箱に収め直す（向きを変えた・文字の大きさを変えた）
    if (this.screen === 'playing') fitText(this.hudView.score, 38);
    if (this.count && this.count.el.isConnected) fitText(this.count.el, 56);
  }

  /** 字体を読み込んでから画面を見せる（読み込む前の別の字体のちらつきを出さない。3 秒で読めなければ、そのまま出す） */
  waitFonts() {
    const show = () => this.root.classList.remove('fonts-pending');
    if (!document.fonts || !document.fonts.load) return show();
    const sample = 'くもぽん はじめる 0123456789';
    Promise.race([
      Promise.all([document.fonts.load(`900 16px KumoponRounded`, sample), document.fonts.load(`700 16px KumoponRounded`, sample)]),
      new Promise((r) => setTimeout(r, 3000)),
    ]).then(() => {
      show();
      this.measureBand();
      if (this.screen === 'playing') fitText(this.hudView.score, 38);
    }, show);
  }

  /** 毎フレーム: タイトルの流れる雲・遊ぶ画面の数え上げ・結果の数え上げ */
  loop(now) {
    requestAnimationFrame(this.loop);
    if (this.screen === 'title' && !this.titleEl.hidden) this.driftTick(now);
    if (this.screen === 'playing') this.hudView.tick(now);
    const c = this.count;
    if (c && this.screen === 'result' && c.shown !== c.target) {
      const u = Math.max(0, Math.min(1, (now - c.t0) / 800));
      const v = u >= 1 ? c.target : Math.round(c.target * EASE.outCubic(u));
      if (v !== c.shown) {
        c.shown = v;
        c.el.textContent = fmt(v);
        const d = c.el.textContent.length;
        if (d !== c.digits) {
          c.digits = d;
          fitText(c.el, 56);
        }
      }
    }
  }
}
