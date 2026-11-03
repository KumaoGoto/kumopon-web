// ブラウザ版くもぽんの入口。WebAssembly（物理と決まり）・描画・音・振動・画面をつなぐ（iOS の AppRoot と GameHost の外側の役）。
//
//   1 フレーム: engine.frame（固定ステップで進めて場面・命令・上の表示を作る）→ 命令を音と振動へ → 描く → 上の表示と画面の切り替え
//   入力: 画面のどこを横になぞっても、びんが回る（iOS と同じ）。座標は論理キャンバス（360×720）に直して渡す
//   保存: storage.js（ベスト・この端末の記録・くもずかん・設定）。ランキングは ranking.js

import { Engine } from './engine.js';
import { Renderer } from './render/renderer.js';
import { makeWarmUpScene } from './render/warmup.js';
import { AudioEngine } from './audio.js';
import { Haptics } from './haptics.js';
import { FeelDispatch } from './feel.js';
import { UI } from './ui/ui.js';
import * as store from './storage.js';
import { Ranking } from './ranking.js';
import { shareResult } from './share.js';

const SCREEN = { menu: 0, playing: 1, result: 2 };

/** 端末の見分け（iPhone・iPad は App Store 版を勧める帯。Android は全画面と振動） */
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** 描く重さの段（安い端末では解像度を下げる。フレームが続けて遅れたら 1 段ずつ下げる。2026-11-03 に描画の担当が M4 で測った:
 *  雲 20 こを 750×1624 で 1 回 MSAA あり 1.6ms・なし 0.6ms。雲・カプセル・文字はシェーダーで縁をなめらかにしているので、
 *  MSAA を切って変わるのは多角形〈空のにじ・ダイヤル〉の縁くらい） */
const QUALITY = [
  { renderScale: 1, msaa: true },
  { renderScale: 1, msaa: false },
  { renderScale: 0.75, msaa: false },
  { renderScale: 0.55, msaa: false },
];
/** 最初の段: Android は MSAA なし・描く高さを 1600px ほどまで（多くの Android は dpr 2.6〜3.5 で、そのままだと 2400px を超える）。
 *  パソコンと iPhone は高い段から */
function startQuality() {
  if (!isAndroid) return 0;
  const h = innerHeight * Math.min(devicePixelRatio || 1, 3);
  return h > 1700 ? 2 : 1;
}
/** タイトルの間に測るフレームの間隔の数（多いほど 1 回の引っかかりに引きずられない）と、物差しにするのに要る最少の数 */
const IDLE_SAMPLES = 90;
const IDLE_MIN = 20;

function qualityFor(level) {
  const q = { ...QUALITY[level] };
  if (level === 2) q.renderScale = Math.min(1, 1600 / Math.max(1, innerHeight * Math.min(devicePixelRatio || 1, 3)));
  return q;
}

class App {
  async boot() {
    const canvas = document.getElementById('game');
    this.settings = store.loadSettings();
    this.engine = await Engine.load();
    this.renderer = new Renderer(canvas, { assetsBase: 'assets/' });
    // BGM は decode すると 130 秒の曲で約 50MB。遊んでいる間に要る「ゲーム中」と「ラスト」（130＋76 秒）だけを覚えておき、
    // タイトルと結果の曲は切りかえるたびに decode し直す（メモリの少ない Android で、4 曲 140MB を抱えないように）
    this.audio = new AudioEngine({ base: 'assets/', musicCacheSeconds: 220 });
    this.haptics = new Haptics(this.engine.vibeTuning());
    this.feel = new FeelDispatch(this.engine, this.audio, this.haptics);
    this.ranking = new Ranking();
    this.ui = new UI(document.getElementById('ui'), {
      start: () => this.start(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      restart: () => this.restart(),
      menu: () => this.menu(),
      openRanking: () => this.ranking.open(this.ui.rankingSlot()),
      settingsChanged: (s) => this.applySettings(s),
      tap: () => this.tap(),
      share: (result) => shareResult(result),
    });
    this.ranking.onRunStatus = (text) => this.ui.setRunRank?.(text);
    this.applySettings(this.settings, false);
    this.engine.setBest(store.loadBest());

    this.quality = startQuality();
    this.renderer.setQuality(qualityFor(this.quality));
    /** タイトルの間に測ったフレームの間隔（ms。新しいものから IDLE_SAMPLES 個）と、ランの間の物差し（watchSpeed） */
    this.idleDts = [];
    this.runCadence = null;
    this.watchedFrames = 0;
    this.slowFrames = 0;
    this.last = 0;
    this.screen = SCREEN.menu;
    this.paused = false;
    this.unlocked = false;

    await Promise.all([this.renderer.load(), this.audio.load().catch((e) => console.warn('[audio]', e))]);
    this.resize();
    this.warmUp();
    addEventListener('resize', () => this.resize());
    this.bindInput(canvas);
    this.bindLifecycle();
    this.showTitle();
    document.documentElement.classList.add('ready');
    this.keepSaves();
    requestAnimationFrame((t) => this.loop(t));
  }

  // ---- 画面の切り替え ----

  showTitle() {
    this.ui.showTitle({ best: store.loadBest(), book: store.loadBook(), isIOS, storageOK: store.storageWorks() });
  }

  start() {
    this.unlock();
    this.ui.wipe(() => {
      this.engine.setBest(store.loadBest());
      this.engine.start();
      this.screen = SCREEN.playing;
      this.paused = false;
      this.runCadence = this.cadence();
      this.watchedFrames = 0;
      this.slowFrames = 0;
      this.ui.showPlaying();
      this.keepAwake(true);
    });
    // Android のブラウザで開いているときは全画面にする（アドレスバーの分だけ広く。ホーム画面から開いたときは初めから全画面）
    if (isAndroid && !standalone && document.fullscreenEnabled && !document.fullscreenElement) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' })
        .then(() => screen.orientation?.lock?.('portrait').catch(() => {}))
        .catch(() => {});
    }
  }

  restart() {
    this.start();
  }

  menu() {
    this.ui.wipe(() => {
      this.engine.menu();
      this.screen = SCREEN.menu;
      this.paused = false;
      this.keepAwake(false);
      this.showTitle();
    });
  }

  pause() {
    if (this.engine.pause()) {
      this.paused = true;
      this.haptics.stop();
      this.ui.showPause(this.lastHud);
    }
  }

  resume() {
    this.engine.resume();
    this.paused = false;
    this.ui.hidePause();
  }

  /** ボタンの手応え（iOS の uiTap: 小さな音と短い振動）。音量と強さはゲームの FeelTuning（WebFeel.uiTap）が決め、
   *  設定の音・振動の切り替えもゲームの側で見る。ボタンの手応えはここだけで鳴らす（ゲームの開始・再開では鳴らさない） */
  tap() {
    this.unlock();
    this.engine.uiTap();
  }

  applySettings(s, save = true) {
    this.settings = { ...store.DEFAULT_SETTINGS, ...s };
    if (save) store.saveSettings(this.settings);
    this.engine.settings(this.settings);
    this.audio?.setEnabled({ sound: this.settings.sound, music: this.settings.music });
    this.haptics.setEnabled(this.settings.haptics);
  }

  /** 最初に画面を触ったとき: 音を鳴らせるようにする（ブラウザは触るまで音も振動も止めている） */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.audio.unlock();
  }

  // ---- 1 フレーム ----

  loop(t) {
    requestAnimationFrame((t2) => this.loop(t2));
    const measured = this.last !== 0;
    const dtMs = measured ? Math.min(t - this.last, 100) : 1000 / 60;
    this.last = t;
    const w0 = performance.now();
    const r = this.engine.frame(dtMs / 1000, t / 1000);
    this.feel.run(this.engine.feel(), t);
    this.haptics.tick(t);
    if (r.screen === SCREEN.menu && this.screen === SCREEN.menu) {
      // タイトルの間は盤面がタイトルの絵（.title-screen は不透明）の下に隠れているので描かない（電池を使わない）。
      // その間のフレームの間隔で、この端末の「いつもの 1 フレーム」を測る（watchSpeed の物差し）
      if (measured) this.noteIdleFrame(dtMs);
    } else {
      this.renderer.draw(this.engine.scene(), t / 1000);
    }
    const hud = this.engine.hudIfChanged();
    if (hud) {
      this.lastHud = hud;
      if (this.screen === SCREEN.playing) this.ui.hud(hud);
    }
    if (r.screen === SCREEN.result && this.screen === SCREEN.playing) this.finishRun();
    this.watchSpeed(performance.now() - w0, dtMs);
  }

  /** 結果が出た: 記録・ベスト・くもずかんに入れて、結果の画面を出す（GameHost.recordForRanking と同じ） */
  finishRun() {
    this.screen = SCREEN.result;
    this.keepAwake(false);
    this.haptics.stop();
    const result = this.engine.result();
    if (!result) return;
    const prevBest = store.loadBest();
    const isNewBest = result.score > prevBest;
    if (isNewBest) store.saveBest(result.score);
    const added = store.addRecord({
      score: result.score, rainbows: result.rainbows, maxTier: result.maxTier, cloud: result.cloud, seconds: result.playSeconds ?? 0,
    });
    const bookNew = store.addToBook(result.madeByTier || [], result.maxTier);
    this.ui.showResult(result, { isNewBest, records: store.loadRecords(), addedId: added?.id ?? null, bookNew });
    this.ranking.afterRun(result);
    this.keepSaves();
  }

  /** 保存を消されにくくしてもらう（storage.js の requestPersistence。画面には何も出さない）。残してもらえたら、もう頼まない */
  keepSaves() {
    if (this.savesKept) return;
    store.requestPersistence().then((kept) => {
      this.savesKept = kept;
      console.info('[main] 保存を消されにくくする:', kept ? '残してもらえる' : 'まだ（ふつうの保存）');
    });
  }

  /** タイトルの間の 1 フレームの間隔を覚える（新しいものから IDLE_SAMPLES 個） */
  noteIdleFrame(dtMs) {
    if (document.hidden) return;
    if (this.idleDts.length >= IDLE_SAMPLES) this.idleDts.shift();
    this.idleDts.push(dtMs);
  }

  /** この端末の「いつもの 1 フレーム」（ms）: タイトルの間の間隔の真ん中。省電力で 30Hz に抑えられていれば 33ms になる。
   *  ただし 60Hz より細かくは求めない（120Hz の端末で 60fps 出ていれば十分。物理は固定の刻みなので点は変わらない）。
   *  タイトルを短くしか見ていなくて測れていなければ null */
  cadence() {
    if (this.idleDts.length < IDLE_MIN) return null;
    const sorted = this.idleDts.slice().sort((a, b) => a - b);
    return Math.max(sorted[sorted.length >> 1], 1000 / 60);
  }

  /** 遅い端末の見張り: 描く重さを 1 段ずつ下げる（物理の決まりは変えない。点が変わらないように絵の側で軽くする）。
   *  物差しは、ランの始めに決めた「この端末のいつもの 1 フレーム」（runCadence）。省電力で 30Hz に抑えられた端末を重いと見ない
   *  （解像度を下げても 30Hz の上限は変わらず、絵が荒くなるだけなので） */
  watchSpeed(workMs, dtMs) {
    if (this.screen !== SCREEN.playing || this.paused || document.hidden) return;
    const base = this.runCadence ?? 1000 / 60;
    // 遅いフレーム: 仕事がいつもの 85% を超えた、または（物差しを測れていれば）間隔がいつもの 1.5 倍を超えた。
    // 物差しが無いときは間隔を見ない（30Hz の端末を 60Hz の物差しで測ってしまうので）
    const slowFrame = workMs > 0.85 * base || (this.runCadence !== null && dtMs > 1.5 * base);
    this.watchedFrames++;
    if (slowFrame) this.slowFrames++;
    // 2 秒ぶん（いつもの刻みで数えて）のうち、半分を超えるフレームが遅ければ下げる
    if (this.watchedFrames < Math.round(2000 / base)) return;
    const slow = this.slowFrames / this.watchedFrames;
    this.watchedFrames = 0;
    this.slowFrames = 0;
    if (slow > 0.5 && this.quality < QUALITY.length - 1) {
      this.quality++;
      this.renderer.setQuality(qualityFor(this.quality));
      this.resize();
      console.info('[main] 描く重さを下げた', qualityFor(this.quality));
    }
  }

  /** 描き方の慣らし（render/warmup.js）: 全部の描き方を読み込みの間に一度ずつ通す。遊んでいる途中で初めての形が出て
   *  1 フレームが止まらないように。文字は 1 フレームに焼く数を絞っているので、数回描く */
  warmUp() {
    const t0 = performance.now();
    const scene = makeWarmUpScene();
    for (let k = 0; k < 3; k++) this.renderer.draw(scene, 0);
    const folded = (this.renderer.backLayer?.folded ?? 0) + (this.renderer.frontLayer?.folded ?? 0);
    // 慣らしの絵を残さない（タイトルの間は描かないので、字の読み込みを待つ間に見えてしまう）。今の場面（まだ空）で描き直す
    this.renderer.draw(this.engine.scene(), 0);
    this.renderer.gl?.finish();
    console.info(`[main] 描き方の慣らし ${(performance.now() - t0).toFixed(0)} ms（裏返る輪 ${folded}）`);
  }

  resize() {
    this.renderer.resize(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, 3));
  }

  // ---- 入力 ----

  bindInput(canvas) {
    const send = (phase, e) => {
      if (this.screen !== SCREEN.playing || this.paused) return;
      const [x, y] = this.renderer.canvasPoint(e.clientX, e.clientY);
      this.engine.touch(phase, e.pointerId, x, y, e.timeStamp / 1000);
    };
    // 押している指（マウスなら押しているボタン）だけを渡す。パソコンのマウスは押していなくても pointermove が来るので、
    // それを渡すと、びんが「押していない指」を掴んで回ってしまう（JarModeV4.touchMoved は掴んでいなければ掴む）
    const down = new Set();
    canvas.addEventListener('pointerdown', (e) => {
      this.unlock();
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // 右・中のボタンは使わない
      down.add(e.pointerId);
      // つかめなくても（ブラウザがもうその指を知らない）指の始まりは渡す
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* つかまずに続ける */ }
      send(0, e);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!down.has(e.pointerId)) return;
      // 指の細かい動きも拾う（120Hz で動かす指に、60Hz の画面でもついていく）
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (list.length > 1) for (const c of list) send(1, c);
      else send(1, e);
    });
    const end = (phase) => (e) => {
      if (down.delete(e.pointerId)) send(phase, e);
    };
    canvas.addEventListener('pointerup', end(2));
    canvas.addEventListener('pointercancel', end(3));
    // 離したのを取り逃したとき（つかみが外れた）も、離したことにする（離したあとにも来るが、そのときはもう down に無い）
    canvas.addEventListener('lostpointercapture', end(3));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // どこかを触ったら音を起こす（タイトルのボタンを押す前に画面を触った人も）
    addEventListener('pointerdown', () => this.unlock(), { capture: true });
  }

  bindLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // 裏に回った: 遊んでいる間なら一時停止（戻っても勝手に進めない。iOS と同じ）。音と振動を止める
        if (this.screen === SCREEN.playing && !this.paused) this.pause();
        this.engine.suspendFeel();
        this.haptics.stop();
        this.audio.suspend();
      } else {
        this.audio.resume();
        this.last = 0;
        if (this.screen === SCREEN.playing) this.keepAwake(true);
      }
    });
  }

  /** 遊んでいる間は画面を暗くしない（Wake Lock。使えないブラウザでは何もしない） */
  async keepAwake(on) {
    try {
      if (on && !this.wakeLock && navigator.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      } else if (!on && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {
      this.wakeLock = null;
    }
  }
}

// ホーム画面に置ける形（PWA）: 通信がなくても遊べるように、ファイルを手元に置く（sw.js）
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[sw]', e));
}

const app = new App();
window.kumopon = app;   // 確かめ用（コンソールから app の様子を見る）
app.boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('boot-error');
  if (el) {
    el.textContent = 'くもぽんを よみこめませんでした。ページを よみこみなおしてください。（' + (e && e.message ? e.message : e) + '）';
    el.hidden = false;
  }
});
