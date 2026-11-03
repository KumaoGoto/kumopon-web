// 音のエンジン（ブラウザ版）。iOS の FeelAudioEngine（App/Feel/FeelAudio.swift）を Web Audio で作り直したもの。
// あわせて、iOS では FeelDirector（App/Feel/FeelDirector.swift）が持っている「音・BGM の設定」「鳴らしたい曲」
// 「始めた連続チャンネルとその値」もここで覚える（親の feel.js は命令をそのまま渡すだけなので）。
// 数値は App/Feel/FeelTuning.swift から写した（下の T。どの値をどこから写したかを横に書く）。
// 素材は Web/tools/make_audio.py が書き出す（assets/sounds/*.wav・assets/music/bgm_*.m4a・assets/audio.json）。
//
// グラフ:
//   単発の声  = AudioBufferSourceNode（音程 = playbackRate 2^(半音/12)）→ GainNode（音量）→ StereoPannerNode（パン）─┐
//   ループの声 = AudioBufferSourceNode（loop）→ GainNode → StereoPannerNode（真ん中）───────────────────────┤
//     sfxBus（masterVolume）→ DynamicsCompressor（ピークリミッター）→ 補正（compressor が勝手に足す持ち上げを打ち消す）→ out
//   BGM の台 ×2 = AudioBufferSourceNode（loopStart〜loopEnd）→ GainNode（等パワー）→ musicBus（musicVolume × duck × quiet）→ out
//   out（止める・戻すときの短いフェード）→ destination
// iOS は 24 個の AVAudioPlayerNode を使い回すが、AudioBufferSourceNode は 1 回しか鳴らせないので、鳴らすたびに作り、
// 鳴っている声を表（voices）で数える。同時発音の上限・奪う声の選び方・鳴らし直しの間隔は iOS と同じ。
// パンは iOS の AVAudioMixerNode もモノラルの入力に等パワー（真ん中で 0.707）をかける（macOS で測った: pan 0 で L=R=0.707、
// pan −0.6 で L 0.951・R 0.309）。StereoPannerNode と同じ式なので、そのまま使う。
//
// 使い方（親の main.js・feel.js）:
//   const audio = new AudioEngine({ base: 'assets/' });
//   await audio.load();                  // 効果音を全部読む（AudioContext は要らない）。タイトルの曲も取りに行き始める
//   audio.unlock();                      // ユーザーの操作の中で。何度呼んでもよい（鳴らせる状態になっていれば何もしない）
//   audio.setEnabled({ sound, music });  // 設定の「音」「BGM」
//   audio.play('merge_body', 12, 0.7, -0.3, 0); audio.loopBegin(2, 'squeeze_loop', 0); audio.music('play', 0.8) …
//   audio.suspend() / audio.resume();    // タブが裏に回った・戻った

/** FeelTuning.swift・FeelAudio.swift から写した数（変えるときは iOS の側も見る） */
const T = {
  /** 単発の声の数（FeelTuning.voiceCount）。ループの声はこの外 */
  voiceCount: 24,
  /** 同じ音を同じ高さで鳴らし直すときの最小間隔（秒。FeelTuning.retriggerGap） */
  retriggerGap: 0.03,
  /** 全体の音量（FeelTuning.masterVolume。この後ろにピークリミッター） */
  masterVolume: 0.9,
  /** BGM の音量（FeelTuning.musicVolume。曲は -16 LUFS にそろえてある） */
  musicVolume: 0.38,
  /** 一時停止の間の BGM の倍率（FeelTuning.musicQuiet）と、そこへ動かす時間（秒。FeelAudio.swift の stepMusic の 0.4） */
  musicQuiet: 0.35,
  quietTime: 0.4,
  /** BGM を下げる速さ・戻す速さ（秒。FeelTuning.musicDuckDown・musicDuckUp。倍率 1 ぶん動くのにかける時間） */
  musicDuckDown: 0.12,
  musicDuckUp: 0.8,
  /** BGM のフェードのいちばん短い時間（FeelAudio.swift の playMusic・stepMusic の max(fade, 0.05)） */
  musicMinFade: 0.05,
  /** BGM の刻みの dt の上限（FeelAudio.swift の stepMusic の min(dt, 0.1)） */
  musicMaxStep: 0.1,
  /** 音・BGM を入れ直したときの BGM のフェード（FeelDirector の soundEnabled・musicEnabled の 0.6） */
  musicToggleFade: 0.6,
  /** merge_body.wav, merge_body_2.wav … の基準の高さ（C4 からの半音。FeelTuning.bodyBands） */
  bodyBands: [19, 12, 4, -3],
  /** ループの音量と音程のなめらかさ（時定数・秒。FeelTuning.loopSmoothing・loopFallSmoothing・loopRelease） */
  loopSmoothing: 0.04,
  loopFallSmoothing: 0.018,
  loopRelease: 0.05,
  /** 止めているループがこの音量より小さくなったら止める（FeelAudio.swift の LoopVoice.step の 0.002 = −54dB） */
  loopStopLevel: 0.002,
  /** 同じ音の上限を超えたとき・声を奪うときのフェード（秒。FeelAudio.swift の Voice.fadeTime） */
  fadeTime: 0.03,
  /** BGM の刻みの間隔（ms。FeelDirector.ensureTicker の Task.sleep(16ms)） */
  tickMs: 16,
};

/** 音ごとの同時発音の上限（FeelTuning.polyphony。research 3.2: 合体 6、衝突 4） */
function polyphony(id) {
  switch (id) {
    case 'merge_body': case 'squelch': case 'sparkle': return 6;
    case 'plop': return 4;
    case 'tick': case 'heartbeat': return 2;
    default: return 4;
  }
}

/** 高さが違っても同じ音として 30ms 空ける音（FeelTuning.retriggerAnyPitch。衝突の「ぽふ」だけ） */
const retriggerAnyPitch = (id) => id === 'plop';

/** wav の素の高さ（FeelTuning.sampleBasePitch。<id>.wav が 0 番。merge_body だけ帯ごとに違い、ほかは変種なので 0） */
function sampleBasePitch(id, index) {
  return id === 'merge_body' && index < T.bodyBands.length ? T.bodyBands[index] : 0;
}

/** 再生レート（FeelAudio.swift の rate: 2^(半音/12) を 0.25〜4 に） */
const rateOf = (semitones) => Math.min(Math.max(2 ** (semitones / 12), 0.25), 4);
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const finite = Number.isFinite;
/** Swift の rounded()（0.5 は 0 から遠いほうへ）。Math.round は −2.5 を −2 にするので合わせる */
const roundAway = (x) => Math.sign(x) * Math.round(Math.abs(x));
const wallClock = () => performance.now() / 1000;

/** MusicCue の rawValue（App/Feel/FeelAPI.swift の enum MusicCue と同じ順）。decode しておく順も同じ（タイトルが先） */
export const MUSIC_CUES = ['title', 'play', 'last', 'result'];

/**
 * ピークリミッター（iOS は Apple の PeakLimiter）。DynamicsCompressorNode をいちばん強い比で使う。
 * −1dBFS を超えた所だけを 20:1 で抑える。立ち上がり 3ms（Chrome は 6ms 先読みもする）、戻り 50ms
 */
export const LIMITER = { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.05 };

/**
 * DynamicsCompressorNode は、しきい値より小さい音も勝手に持ち上げる（Web Audio の仕様の makeup gain:
 * (1 / 0dBFS の入力に対する出力)^0.6）。iOS のリミッターはしきい値より下では素通しなので、その分を後ろで下げる。
 * −1dB・20:1 なら 0dBFS の入力が −0.95dB になり、持ち上げは +0.57dB（audio_test.html で実測して確かめる）
 */
export function limiterMakeup({ threshold, ratio } = LIMITER) {
  const outAtFull = threshold + (0 - threshold) / ratio; // dB（0dBFS を入れたときの出力）
  return 10 ** ((-outAtFull * 0.6) / 20);
}

export class AudioEngine {
  /**
   * base: 素材の置き場所の URL の頭（例 'assets/'）
   * musicCacheSeconds: decode した BGM を覚えておく長さの合計（秒）。130 秒の曲は 48kHz で約 50MB になるので、
   *   メモリの少ない端末で絞れるようにした。既定の 400 なら 4 曲（359 秒・約 140MB）を全部覚える。
   *   超えたら、台に乗っていない曲を古い順に捨てる（次に鳴らすときに decode し直す）
   * sessionType: iPhone の Safari（17 から）の navigator.audioSession.type。iOS 版と同じ 'ambient'
   *   （他のアプリの音と混ぜる・消音スイッチで消える。FeelAudio.swift の configureSession の .ambient）。
   *   消音スイッチでも鳴らしたいなら 'playback'（そのかわり他のアプリの音楽を止める）。null で触らない
   */
  constructor({ base = 'assets/', musicCacheSeconds = 400, sessionType = 'ambient' } = {}) {
    this.base = base.endsWith('/') ? base : base + '/';
    this.musicCacheSeconds = musicCacheSeconds;
    this.sessionType = sessionType;
    /** 診断用の数（FeelAudio.swift の Stats と同じ並び） */
    this.stats = { played: 0, stolen: 0, faded: 0, skippedRetrigger: 0, decoded: 0, evicted: 0, lastError: null };

    this.ctx = null;
    this.manifest = null;
    /** SoundID → [{ buffer, basePitch }]（変種を含む） */
    this.samples = new Map();
    this.roundRobin = new Map();
    /** 鳴っている単発の声 { id, src, gain, startAt, endsAt, fading } */
    this.voices = [];
    this.lastTrigger = new Map();
    this.unknown = new Set();

    // ---- 設定（FeelDirector の soundEnabled・musicEnabled）と、タブが裏にいるか ----
    this.soundOn = true;
    this.musicOn = true;
    this.hidden = false;

    // ---- 連続チャンネル ----
    /** 始めたチャンネルと最後の値（FeelDirector の activeChannels・channelValues）。音を切っても覚えておき、戻したら鳴らし直す */
    this.loopStates = new Map();
    /** チャンネルごとのループの声（FeelAudio.swift の loops。止めている途中に begin が来たら、同じ声を戻す） */
    this.loopVoices = new Map();

    // ---- BGM ----
    /** ゲームが鳴らしたい曲（FeelDirector の wantedMusic。BGM を切っている間も覚える） */
    this.wantedMusic = null;
    /** 鳴らす曲（FeelAudio.swift の musicCue）とフェード */
    this.musicCue = null;
    this.musicFade = 0.8;
    /** 2 つの台（切りかえるときに重ねる）。g は 0〜1（音量は等パワーの sin）、target と fadeTime はそこへ向かう先と秒 */
    this.decks = [0, 1].map(() => ({ cue: null, src: null, gain: null, g: 0, target: 0, fadeTime: 0.8 }));
    this.duckLevel = 1;
    this.duckTarget = 1;
    this.duckUntil = 0;
    this.quietLevel = 1;
    this.quietTarget = 1;
    /** 取りに行った曲（ArrayBuffer の Promise）・decode した曲・decode している曲 */
    this.musicBytes = new Map();
    this.musicDecoded = new Map();
    this.musicDecoding = new Map();
    this.tickTimer = 0;
    this.lastTick = 0;

    /** unlock で AudioContext を作ったら解ける（decode は AudioContext が要る） */
    this.ctxReady = new Promise((resolve) => { this.resolveCtx = resolve; });
    this.resumeRequestedAt = -1;
    this.suspendToken = 0;
    this.unlockArmed = false;
    this.predecodeStarted = false;
    this.loading = null;
  }

  // MARK: - 読み込み

  /** 効果音を全部読む（wav を自前で読んで AudioBuffer にする。AudioContext は要らない）。タイトルの曲も取りに行き始める */
  load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const res = await fetch(this.base + 'audio.json');
      if (!res.ok) throw new Error(`音: ${this.base}audio.json を読めない（${res.status}）。Web/tools/make_audio.py を回す`);
      this.manifest = await res.json();
      // タイトルの曲は先に取りに行く（decode は unlock のあと）。ほかの曲は unlock のあとに順に
      this.fetchMusic('title').catch(() => {});
      const jobs = [];
      const loaded = new Map();
      for (const [id, files] of Object.entries(this.manifest.sounds)) {
        const list = [];
        files.forEach((file, index) => {
          jobs.push(this.fetchWav(this.base + 'sounds/' + file)
            .then((buffer) => { list[index] = { buffer, basePitch: sampleBasePitch(id, index) }; })
            .catch((e) => this.report(`${file} を読めない: ${e.message}`)));
        });
        loaded.set(id, list);
      }
      await Promise.all(jobs);
      let files = 0;
      for (const [id, list] of loaded) {
        // 読めなかった変種を詰める（basePitch は番号で決めてあるので、詰めても高さの帯はずれない。FeelAudio.swift の loadBuffers と同じ）
        const ok = list.filter(Boolean);
        if (ok.length) this.samples.set(id, ok);
        files += ok.length;
      }
      const bodies = this.samples.get('merge_body')?.length ?? 0;
      if (bodies !== T.bodyBands.length) {
        this.report(`merge_body の wav が ${bodies} 本（bodyBands は ${T.bodyBands.length} 帯）`);
      }
      return { sounds: this.samples.size, files };
    })();
    return this.loading;
  }

  async fetchWav(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    return parseWav(await res.arrayBuffer());
  }

  // MARK: - 起こす・止める

  /**
   * ユーザーの操作の中で呼ぶ。AudioContext を作る（または resume する）。何度呼んでもよい。
   * タッチの pointerdown・touchstart はブラウザが「操作」と数えない（Chrome と Safari は pointerup・touchend・click から）ので、
   * 最初に呼ばれたら自分でも pointerup・touchend・click・keydown を聞いて、鳴らせるようになるまで起こし直す。
   * iPhone の Safari: タップの中で 1 サンプルの無音を鳴らす（古い iOS は音を 1 つ鳴らさないと解除されない）
   */
  unlock() {
    this.armUnlock();
    const activation = navigator.userActivation;
    if (!this.ctx) {
      // 操作の外で作ると Chrome が「AudioContext was not allowed to start」と警告して止まったままになる。操作の中まで待つ
      if (activation && !activation.isActive) return false;
      if (!this.createContext()) return false;
    }
    const ctx = this.ctx;
    if (this.wantsRunning() && ctx.state !== 'running' && ctx.state !== 'closed') {
      this.resumeRequestedAt = performance.now();
      ctx.resume?.().catch((e) => this.report(`resume に失敗: ${e.message}`));
      try {
        const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
        const s = ctx.createBufferSource();
        s.buffer = silent;
        s.connect(ctx.destination);
        s.start(0);
      } catch { /* 古いブラウザで失敗しても resume のほうで起きる */ }
    }
    if (!this.predecodeStarted) {
      this.predecodeStarted = true;
      this.predecode();
    }
    return ctx.state === 'running';
  }

  /** 鳴らせる状態か（AudioContext が動いている） */
  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  armUnlock() {
    if (this.unlockArmed) return;
    this.unlockArmed = true;
    const handler = () => {
      if (this.ctx && this.ctx.state === 'running') return;
      this.unlock();
    };
    for (const type of ['pointerup', 'touchend', 'click', 'keydown']) {
      addEventListener(type, handler, { capture: true, passive: true });
    }
  }

  createContext() {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) {
      this.report('このブラウザは Web Audio が使えない');
      return false;
    }
    try {
      if (this.sessionType && navigator.audioSession) navigator.audioSession.type = this.sessionType;
    } catch { /* audioSession の無いブラウザ */ }
    let ctx;
    try {
      ctx = new C({ latencyHint: 'interactive' });
    } catch {
      ctx = new C();
    }
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    // 効果音: sfxBus → リミッター → 持ち上げの打ち消し → out
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = T.masterVolume;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = LIMITER.threshold;
    lim.knee.value = LIMITER.knee;
    lim.ratio.value = LIMITER.ratio;
    lim.attack.value = LIMITER.attack;
    lim.release.value = LIMITER.release;
    const makeup = ctx.createGain();
    makeup.gain.value = 1 / limiterMakeup();
    this.sfxBus.connect(lim);
    lim.connect(makeup);
    makeup.connect(this.out);
    this.limiter = lim;
    // BGM: 台 → musicBus → out（効果音のリミッターは通さない。iOS と同じ）
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = T.musicVolume * this.duckLevel * this.quietLevel;
    this.musicBus.connect(this.out);
    ctx.onstatechange = () => this.stateChanged();
    // 音を切っているなら止めておく（操作の中で作ると、Chrome はすぐ動き出す）
    if (!this.wantsRunning()) this.suspendContext();
    this.resolveCtx(ctx);
    return true;
  }

  wantsRunning() { return this.soundOn && !this.hidden; }

  /** AudioContext が動き出した・止まった。動き出したら、覚えているループと曲を鳴らし直す（iOS の startPlayers にあたる） */
  stateChanged() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (!this.wantsRunning()) {
      // 止めると決めたあとで動き出した（作った直後の動き出しが遅れた）: 止め直す
      this.suspendContext();
      return;
    }
    this.restoreLoops();
    if (this.musicOn && this.musicCue && !this.decks.some((d) => d.cue === this.musicCue)) {
      this.playMusic(this.musicCue, this.musicFade);
    }
  }

  /** 設定の「音」「BGM」。音を切れば BGM も鳴らない（FeelDirector の soundEnabled・musicEnabled と同じ） */
  setEnabled({ sound, music } = {}) {
    if (typeof sound === 'boolean' && sound !== this.soundOn) {
      this.soundOn = sound;
      if (sound) {
        if (this.musicOn) this.playMusic(this.wantedMusic, T.musicToggleFade);
        if (!this.hidden) this.resumeContext();
        this.restoreLoops();
      } else {
        // iOS の pause: 鳴っている音・ループ・曲を止めてエンジンを休ませる。ループの値と鳴らしたい曲は覚えておく
        this.silenceVoices();
        for (const deck of this.decks) this.stopDeck(deck);
        this.suspendContext();
      }
    }
    if (typeof music === 'boolean' && music !== this.musicOn) {
      this.musicOn = music;
      if (this.soundOn) this.playMusic(music ? this.wantedMusic : null, T.musicToggleFade);
    }
  }

  /**
   * タブが裏に回った。単発とループの声を止め（ループの値は覚えておく）、AudioContext を止める。
   * BGM の台は止めない: AudioContext ごと止まるので、戻すと続きから鳴る（iOS はエンジンを止めると予約が消えるので、
   * 戻ったときに曲を頭から入れ直す。ブラウザはその必要が無い）
   */
  suspend() {
    this.hidden = true;
    this.silenceVoices();
    this.suspendContext();
  }

  /** タブが戻った */
  resume() {
    this.hidden = false;
    if (this.soundOn) {
      this.resumeContext();
      if (this.running) this.restoreLoops();
    }
  }

  /** 出口を 10ms ほどで絞ってから AudioContext を止める（いきなり止めるとプチッと鳴る） */
  suspendContext() {
    const ctx = this.ctx;
    if (!ctx) return;
    const token = ++this.suspendToken;
    const now = ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(0, now, 0.01);
    setTimeout(() => {
      if (token === this.suspendToken && !this.wantsRunning() && ctx.state === 'running') {
        ctx.suspend().catch(() => {});
      }
    }, 60);
  }

  resumeContext() {
    const ctx = this.ctx;
    if (!ctx) return;
    ++this.suspendToken;
    const now = ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(1, now, 0.015);
    if (ctx.state !== 'running') {
      this.resumeRequestedAt = performance.now();
      // 操作の外だと失敗することがある（iPhone で電話のあとなど）。そのときは次のタップの unlock で起きる
      ctx.resume().catch(() => {});
    }
  }

  /** 単発の声とループの声を止める（すぐ止めず 20ms で消す）。ループの状態（loopStates）は残す */
  silenceVoices() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const v of this.voices) {
      if (!v.fading) this.fadeVoice(v, now, 0.02);
    }
    this.voices = [];
    for (const lv of this.loopVoices.values()) this.loopStopNow(lv, 0.02);
  }

  // MARK: - 単発

  /**
   * 音を 1 つ鳴らす（FeelAudio.swift の play と同じ）。name は SoundID の rawValue、pitch は素の高さからの半音、
   * gain は 0〜1、pan は −1〜1、delay 秒後に鳴らすこともできる（和音のずらし）
   */
  play(name, pitch = 0, gain = 1, pan = 0, delay = 0) {
    if (!finite(pitch) || !finite(gain) || !finite(pan) || gain <= 0.0001) return;
    if (!this.wantsRunning()) return;
    const ctx = this.ctx;
    if (!ctx) return;
    // 動いていないときは鳴らさない（止まった AudioContext に積むと、動き出したときにまとめて鳴る）。
    // ただし resume を頼んだ直後（最初のタップの「カチッ」）は、動き出しに合わせて鳴るように積む
    if (ctx.state !== 'running' && !(ctx.state === 'suspended' && performance.now() - this.resumeRequestedAt < 300)) return;
    const list = this.samples.get(name);
    if (!list) {
      if (!this.unknown.has(name)) {
        this.unknown.add(name);
        this.report(`${name} の wav が無い`);
      }
      return;
    }
    const wait = finite(delay) && delay > 0 ? delay : 0;
    // 同じ音・同じ高さは 30ms 空ける。衝突（plop）は高さが違っても 30ms 空ける（research 3.2）。
    // 時計は performance.now（ctx.currentTime は Android で 10〜20ms ずつ進むことがあり、30ms を測るには粗い）
    const wall = wallClock();
    const key = name + ':' + (retriggerAnyPitch(name) ? 0 : roundAway(pitch * 4));
    if (wait === 0) {
      const last = this.lastTrigger.get(key);
      if (last !== undefined && wall - last < T.retriggerGap) {
        this.stats.skippedRetrigger++;
        return;
      }
    }
    const sample = this.pickSample(name, list, pitch);
    this.lastTrigger.set(key, wall);
    const now = ctx.currentTime;
    const rate = rateOf(pitch - sample.basePitch);
    this.makeRoom(name, now);

    const src = ctx.createBufferSource();
    src.buffer = sample.buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    // 新しく作った GainNode の値はすぐ効く（iOS は声を使い回すので、前の音の音量が頭にかからないよう EQ の利得で付けていた）
    g.gain.value = Math.min(gain, 1);
    src.connect(g);
    let tail = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      tail = p;
    }
    tail.connect(this.sfxBus);
    const startAt = now + wait;
    src.start(startAt);
    const voice = { id: name, src, gain: g, tail, startAt, endsAt: startAt + sample.buffer.duration / rate, fading: false };
    src.onended = () => {
      voice.done = true;
      tail.disconnect();
    };
    this.voices.push(voice);
    this.stats.played++;
  }

  /**
   * 鳴らす前に場所を空ける（FeelAudio.swift の pickVoice と同じ決まり）。
   * ① この音の同時発音の上限なら、その音で鳴り終わりのいちばん近い声を 30ms でフェードして消す（research 3.2「古い音から止める」）
   * ② 全体で 24 声が鳴っていれば、鳴り終わりのいちばん近い声を消す。iOS はこのとき声を途中で切る（プチッと鳴りうる）が、
   *    ここは声を毎回作るので、奪う声も 30ms でフェードする
   */
  makeRoom(name, now) {
    this.voices = this.voices.filter((v) => !v.done && v.endsAt > now);
    let busy = 0;
    let sameBusy = 0;
    let sameNearest = null;
    for (const v of this.voices) {
      if (v.fading) continue;
      busy++;
      if (v.id === name) {
        sameBusy++;
        if (!sameNearest || v.endsAt < sameNearest.endsAt) sameNearest = v;
      }
    }
    if (sameNearest && sameBusy >= polyphony(name)) {
      this.stats.faded++;
      this.fadeVoice(sameNearest, now, T.fadeTime);
      busy--;
    }
    if (busy >= T.voiceCount) {
      let nearest = null;
      for (const v of this.voices) {
        if (!v.fading && (!nearest || v.endsAt < nearest.endsAt)) nearest = v;
      }
      if (nearest) {
        this.stats.stolen++;
        this.fadeVoice(nearest, now, T.fadeTime);
      }
    }
  }

  fadeVoice(v, now, time) {
    v.fading = true;
    try {
      if (v.startAt > now) {
        // まだ鳴り始めていない（ずらした和音）: 取り消すだけ（鳴らないまま終わるので、ここで外す）
        v.src.stop();
        v.tail.disconnect();
        v.done = true;
      } else {
        const gp = v.gain.gain;
        gp.cancelScheduledValues(now);
        gp.setValueAtTime(gp.value, now);
        gp.linearRampToValueAtTime(0, now + time);
        v.src.stop(now + time + 0.005);
      }
    } catch { /* もう止まっている */ }
    v.endsAt = Math.min(v.endsAt, now + time);
  }

  /** 鳴らす wav を選ぶ（FeelAudio.swift の pickSample）: 素の高さがいちばん近いもの。同じ近さが複数あれば順番に（音色の変種） */
  pickSample(name, list, pitch) {
    if (list.length === 1) return list[0];
    let best = Infinity;
    for (const s of list) best = Math.min(best, Math.abs(s.basePitch - pitch));
    const candidates = list.filter((s) => Math.abs(s.basePitch - pitch) <= best + 0.01);
    if (candidates.length === 1) return candidates[0];
    const k = this.roundRobin.get(name) ?? 0;
    this.roundRobin.set(name, k + 1);
    return candidates[k % candidates.length];
  }

  // MARK: - ループ（連続チャンネル）

  /**
   * 連続チャンネルを始める（くもぽんは口でしぼる「むにゅ〜」squeeze_loop）。始めた直後の音量は 0 で、loopSet で上げる。
   * すでに始めているチャンネルなら、鳴っていなければ鳴らし直すだけ（値はそのまま）
   */
  loopBegin(channel, name, pitch = 0) {
    let st = this.loopStates.get(channel);
    if (!st) {
      st = { name, pitch: 0, gain: 0 };
      this.loopStates.set(channel, st);
    }
    st.name = name;
    st.pitch = finite(pitch) ? pitch : 0;
    if (this.wantsRunning() && this.ctx) this.loopVoiceBegin(channel, st);
  }

  /** 音程（半音）と音量（0〜1）の目標を変える。毎フレーム呼んでよい。始めていないチャンネルは無視（FeelDirector.continuousUpdate） */
  loopSet(channel, pitch, gain) {
    const st = this.loopStates.get(channel);
    if (!st || !finite(pitch) || !finite(gain)) return;
    st.pitch = pitch;
    st.gain = clamp(gain, 0, 1);
    const lv = this.loopVoices.get(channel);
    if (lv && lv.active && !lv.releasing) this.loopRetarget(lv, st.gain, rateOf(st.pitch - lv.basePitch));
  }

  /** 止める（loopRelease の時定数でフェード）。何度呼んでもよい */
  loopEnd(channel) {
    if (!this.loopStates.delete(channel)) return;
    const lv = this.loopVoices.get(channel);
    if (lv) this.loopRelease(lv);
  }

  /** 覚えているチャンネルのうち、声が止まっているものを鳴らし直す（音を入れ直した・タブが戻った・動き出した） */
  restoreLoops() {
    if (!this.ctx || !this.wantsRunning()) return;
    for (const [channel, st] of this.loopStates) {
      const lv = this.loopVoices.get(channel);
      if (!lv || !lv.active || lv.releasing) this.loopVoiceBegin(channel, st);
    }
  }

  /** FeelAudio.swift の loopBegin（LoopVoice.begin）と、続く FeelDirector の setLoop */
  loopVoiceBegin(channel, st) {
    const ctx = this.ctx;
    const sample = this.samples.get(st.name)?.[0];
    if (!sample) return;
    let lv = this.loopVoices.get(channel);
    if (!lv) {
      lv = { active: false, releasing: false, src: null, gain: null, basePitch: 0, gm: null, rm: null, stopTimer: 0 };
      this.loopVoices.set(channel, lv);
    }
    const rate = rateOf(st.pitch - sample.basePitch);
    clearTimeout(lv.stopTimer);
    lv.releasing = false;
    if (!lv.active) {
      const now = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = sample.buffer;
      src.loop = true;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      let tail = g;
      // 真ん中（pan 0）でも単発と同じ等パワーの 0.707 をかける（iOS のループの声も submix の pan 0 を通る）
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = 0;
        g.connect(p);
        tail = p;
      }
      tail.connect(this.sfxBus);
      src.start(now);
      src.onended = () => tail.disconnect();
      Object.assign(lv, {
        active: true, src, gain: g, basePitch: sample.basePitch,
        gm: { v0: 0, t0: now, target: 0, tau: T.loopSmoothing },
        rm: { v0: rate, t0: now, target: rate, tau: T.loopSmoothing },
      });
    }
    this.loopRetarget(lv, st.gain, rate);
  }

  /**
   * 音量と音程を目標へ指数的に寄せる（FeelAudio.swift の LoopVoice.step: 止めるときは loopRelease、下げるときは速め
   * loopFallSmoothing、上げるときは loopSmoothing。音程も同じ時定数）。
   * iOS は 16ms ごとの刻みで 1 − e^(−dt/τ) ずつ寄せる。ここは AudioParam の setTargetAtTime（同じ式を標本ごとに）で
   * 寄せるので、刻みは要らない。目標が変わったときだけ、今の値（同じ式で JS でも計算しておく）から寄せ直す
   */
  loopRetarget(lv, gain, rate) {
    const now = this.ctx.currentTime;
    const g = evalTarget(lv.gm, now);
    const r = evalTarget(lv.rm, now);
    const tau = lv.releasing ? T.loopRelease : gain < g ? T.loopFallSmoothing : T.loopSmoothing;
    if (lv.gm.target === gain && lv.rm.target === rate && lv.gm.tau === tau) return;
    setTarget(lv.gain.gain, g, gain, tau, now);
    setTarget(lv.src.playbackRate, r, rate, tau, now);
    lv.gm = { v0: g, t0: now, target: gain, tau };
    lv.rm = { v0: r, t0: now, target: rate, tau };
  }

  /** 止める: 音量を 0 へ（loopRelease）。−54dB（loopStopLevel）まで下がったら止める。その前に begin が来たら同じ声を戻す */
  loopRelease(lv) {
    if (!lv.active || lv.releasing) return;
    lv.releasing = true;
    this.loopRetarget(lv, 0, lv.rm.target);
    const g = evalTarget(lv.gm, this.ctx.currentTime);
    const after = g > T.loopStopLevel ? T.loopRelease * Math.log(g / T.loopStopLevel) : 0;
    clearTimeout(lv.stopTimer);
    lv.stopTimer = setTimeout(() => {
      if (lv.releasing) this.loopStopNow(lv, 0.005);
    }, after * 1000 + 20);
  }

  /** すぐ止める（fade 秒で 0 まで線形に下げてから。FeelAudio.swift の LoopVoice.stopNow） */
  loopStopNow(lv, fade) {
    clearTimeout(lv.stopTimer);
    if (!lv.active) return;
    const now = this.ctx.currentTime;
    try {
      const gp = lv.gain.gain;
      gp.cancelScheduledValues(now);
      gp.setValueAtTime(evalTarget(lv.gm, now), now);
      gp.linearRampToValueAtTime(0, now + fade);
      lv.src.stop(now + fade + 0.005);
    } catch { /* もう止まっている */ }
    lv.gm = { v0: 0, t0: now, target: 0, tau: T.loopSmoothing };
    lv.active = false;
    lv.releasing = false;
  }

  // MARK: - BGM

  /**
   * BGM を切りかえる（null で止める）。fade 秒で 2 つの台を等パワーで重ねて入れかえる。同じ曲なら何もしない（フェードを戻すだけ）。
   * 音・BGM を切っている間は覚えておき、戻したときに鳴らす（FeelDirector.music）
   */
  music(cue, fade = 0.8) {
    const c = typeof cue === 'number' ? MUSIC_CUES[cue] ?? null : cue || null;
    this.wantedMusic = c;
    if (!this.soundOn || !this.musicOn) return;
    this.playMusic(c, fade);
  }

  /** BGM を一時だけ下げる（level 倍。0〜1）。hold 秒たったら戻す（下げるのは速く musicDuckDown、戻すのはゆっくり musicDuckUp） */
  duck(level, hold) {
    if (!finite(level) || !finite(hold)) return;
    this.duckTarget = Math.min(this.duckTarget, clamp(level, 0, 1));
    this.duckUntil = Math.max(this.duckUntil, wallClock() + Math.max(hold, 0));
    this.ensureTicker();
  }

  /** 一時停止の間、BGM を小さくする（musicQuiet 倍へ 0.4 秒で） */
  quiet(on) {
    this.quietTarget = on ? T.musicQuiet : 1;
    this.ensureTicker();
  }

  /** FeelAudio.swift の playMusic */
  playMusic(cue, fade) {
    this.musicCue = cue;
    this.musicFade = Math.max(finite(fade) ? fade : 0.8, T.musicMinFade);
    const onDeck = cue ? this.decks.find((d) => d.cue === cue) : null;
    if (cue && !onDeck && !this.musicDecoded.has(cue)) {
      // まだ decode できていない: 今の曲はそのまま鳴らしておき、できたら切りかえる
      // （iOS はファイルを開くだけなので待たない。ここは decode に 0.1〜1 秒かかるので、その間を無音にしない）
      this.decodeMusic(cue).then(
        () => { if (this.musicCue === cue && this.soundOn && this.musicOn) this.playMusic(cue, this.musicFade); },
        (e) => {
          this.report(`BGM ${cue} を読めない: ${e.message}`);
          if (this.musicCue === cue) this.playMusic(null, this.musicFade);
        },
      );
      return;
    }
    for (const d of this.decks) {
      if (d.cue && d.cue !== cue) {
        d.target = 0;
        d.fadeTime = this.musicFade;
      }
    }
    if (onDeck) {
      onDeck.target = 1;
      onDeck.fadeTime = this.musicFade;
    } else if (cue && this.ctx && this.wantsRunning()) {
      this.startDeck(cue, this.musicFade);
    }
    this.ensureTicker();
  }

  /** 空いている台（無ければ小さいほう）で、曲をループの頭から鳴らし始める（0 から fade 秒で上げる） */
  startDeck(cue, fade) {
    const info = this.musicDecoded.get(cue);
    const ctx = this.ctx;
    if (!info || !ctx) return;
    const deck = this.decks.find((d) => !d.cue) ?? this.decks.reduce((a, b) => (a.g <= b.g ? a : b));
    this.stopDeck(deck);
    const src = ctx.createBufferSource();
    src.buffer = info.buffer;
    src.loop = true;
    src.loopStart = info.loopStart;
    src.loopEnd = info.loopEnd;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g);
    g.connect(this.musicBus);
    src.start(ctx.currentTime, info.loopStart);
    src.onended = () => g.disconnect();
    Object.assign(deck, { cue, src, gain: g, g: 0, target: 1, fadeTime: fade });
    info.lastUsed = performance.now();
  }

  /** 台を止める。iOS は player.stop（途中ならプチッと鳴りうる）。ここは 10ms で絞ってから止める */
  stopDeck(deck) {
    if (deck.src && this.ctx) {
      const now = this.ctx.currentTime;
      try {
        deck.gain.gain.cancelScheduledValues(now);
        deck.gain.gain.setTargetAtTime(0, now, 0.01);
        deck.src.stop(now + 0.06);
      } catch { /* もう止まっている */ }
    }
    Object.assign(deck, { cue: null, src: null, gain: null, g: 0, target: 0 });
  }

  ensureTicker() {
    if (this.tickTimer) return;
    this.lastTick = performance.now();
    this.tickTimer = setTimeout(() => this.tick(), T.tickMs);
  }

  tick() {
    this.tickTimer = 0;
    const now = performance.now();
    const busy = this.stepMusic((now - this.lastTick) / 1000);
    if (busy) {
      this.lastTick = now;
      this.tickTimer = setTimeout(() => this.tick(), T.tickMs);
    }
  }

  /**
   * 台の音量の重ね（等パワー）・下げる・一時停止の小ささを進める（FeelAudio.swift の stepMusic と同じ式）。動いている間は true。
   * 値は 16ms ごとに setTargetAtTime（時定数 12ms）で入れる（iOS の player.volume・outputVolume も 16〜25ms かけて滑らかに動く）。
   * iOS と違い、下げたまま hold を待っている間も刻みを止めない（iOS は Director の刻みがループや触覚でも回るので、ふつうは戻れる。
   * ここは BGM のためだけに回すので、止めると戻す時刻が来ても誰も戻さない）
   */
  stepMusic(dt) {
    const d = Math.min(Math.max(dt, 0), T.musicMaxStep);
    let busy = false;
    for (const deck of this.decks) {
      if (!deck.cue) continue;
      if (deck.g !== deck.target) {
        const step = d / Math.max(deck.fadeTime, T.musicMinFade);
        deck.g = deck.g < deck.target ? Math.min(deck.target, deck.g + step) : Math.max(deck.target, deck.g - step);
        busy = true;
      }
      this.smooth(deck.gain.gain, Math.sin((deck.g * Math.PI) / 2));
      if (deck.target === 0 && deck.g === 0) this.stopDeck(deck);
    }
    const wall = wallClock();
    if (wall >= this.duckUntil) this.duckTarget = 1;
    else if (this.duckTarget < 1) busy = true;
    if (this.duckLevel !== this.duckTarget) {
      const step = d / (this.duckLevel > this.duckTarget ? T.musicDuckDown : T.musicDuckUp);
      this.duckLevel = this.duckLevel > this.duckTarget
        ? Math.max(this.duckTarget, this.duckLevel - step)
        : Math.min(this.duckTarget, this.duckLevel + step);
      busy = true;
    }
    if (this.quietLevel !== this.quietTarget) {
      const step = d / T.quietTime;
      this.quietLevel = this.quietLevel > this.quietTarget
        ? Math.max(this.quietTarget, this.quietLevel - step)
        : Math.min(this.quietTarget, this.quietLevel + step);
      busy = true;
    }
    if (this.musicBus) this.smooth(this.musicBus.gain, T.musicVolume * this.duckLevel * this.quietLevel);
    return busy;
  }

  smooth(param, value) {
    if (!this.ctx) return;
    param.setTargetAtTime(value, this.ctx.currentTime, 0.012);
  }

  // ---- 曲の取りよせと decode ----

  fetchMusic(cue) {
    let p = this.musicBytes.get(cue);
    if (p) return p;
    p = (async () => {
      await this.load();
      const m = this.manifest.music?.[cue];
      if (!m) throw new Error(`audio.json に ${cue} が無い`);
      const res = await fetch(this.base + 'music/' + m.file);
      if (!res.ok) throw new Error(`${m.file} を取れない（${res.status}）`);
      return res.arrayBuffer();
    })();
    this.musicBytes.set(cue, p);
    p.catch(() => this.musicBytes.delete(cue));
    return p;
  }

  /** 曲を decode してループの位置を決める（AudioContext ができるまで待つ）。同じ曲を同時に頼まれても 1 回だけ */
  decodeMusic(cue) {
    const have = this.musicDecoded.get(cue);
    if (have) return Promise.resolve(have);
    let p = this.musicDecoding.get(cue);
    if (p) return p;
    p = (async () => {
      const ctx = await this.ctxReady;
      const bytes = await this.fetchMusic(cue);
      const t0 = performance.now();
      // decodeAudioData は渡した ArrayBuffer を使えなくするので、写しを渡す（捨てたあとで decode し直せるように）
      const buffer = await decodeAudio(ctx, bytes.slice(0));
      const info = this.loopPoints(cue, buffer);
      info.decodeMs = performance.now() - t0;
      info.lastUsed = performance.now();
      this.musicDecoded.set(cue, info);
      this.stats.decoded++;
      this.evictMusic();
      return info;
    })();
    this.musicDecoding.set(cue, p);
    const done = () => this.musicDecoding.delete(cue);
    p.then(done, done);
    return p;
  }

  /**
   * ループの位置（秒）を決める。m4a は Web/tools/make_audio.py が「前にループの尻 0.5 秒・後ろにループの頭 0.5 秒」を足してあり、
   * どこから L（ループの長さ）だけ切っても同じループになる。decode した長さから AAC の詰め物（priming・remainder）が
   * 残っているかを見て、頭に残っていれば loopStart を priming ぶん後ろへずらす。見分けられなくても 0.5 秒の余白の中なので、
   * 継ぎ目は出ない（曲の頭が数十 ms ずれるだけ）。
   * 最後に、継ぎ目の手前 0.1 秒を「跳んだ先の手前（前に足した尻）」へなめらかに寄せる。跳んだ先とそのまま続く音は同じ曲だが、
   * AAC の符号化のゆらぎが別々なので、継ぎ目で波形が −25dB ほどの差で入れかわる。寄せておけば、跳ぶ前と跳んだ後が
   * 同じ流れの音になり、継ぎ目の段差が 0 になる
   */
  loopPoints(cue, buffer) {
    const m = this.manifest.music[cue];
    const sr = buffer.sampleRate;
    const got = (buffer.length * m.rate) / sr; // decode した長さ（48kHz のフレームに直す）
    const extra = Math.round(got - m.frames);
    const tol = 2 + Math.ceil(m.rate / sr) * 2;
    const near = (x) => Math.abs(extra - x) <= tol;
    let lead = 0;
    let verdict;
    if (near(0)) verdict = '詰め物は取り除かれている';
    else if (near(m.remainder)) verdict = '尻の詰め物だけ残っている';
    else if (near(m.priming + m.remainder)) { lead = m.priming; verdict = '頭と尻の詰め物が残っている'; }
    else if (near(m.priming)) { lead = m.priming; verdict = '頭の詰め物が残っている'; }
    else verdict = `見分けられない（${extra} フレーム多い）。頭はずらさない`;
    let loopStart = (m.loopStart + lead) / m.rate;
    let loopEnd = loopStart + m.loopFrames / m.rate;
    if (loopEnd > buffer.duration - 0.01) {
      // 思ったより短い（壊れた decode）。足した余白の中で収まる所へ戻す
      loopStart = m.loopStart / m.rate;
      loopEnd = loopStart + m.loopFrames / m.rate;
      verdict += '・短いので頭のずらしをやめた';
    }
    smoothSeam(buffer, loopStart, loopEnd, 0.1);
    return {
      cue, buffer, loopStart, loopEnd, lead, extra, verdict,
      decodedFrames: buffer.length, sampleRate: sr, expectedFrames: Math.round((m.frames * sr) / m.rate),
      seconds: buffer.duration,
    };
  }

  /** decode した曲の合計がしきいを超えたら、台に乗っていない曲を古い順に捨てる */
  evictMusic() {
    const total = () => [...this.musicDecoded.values()].reduce((s, i) => s + i.seconds, 0);
    if (total() <= this.musicCacheSeconds) return;
    const idle = [...this.musicDecoded.values()]
      .filter((i) => i.cue !== this.musicCue && !this.decks.some((d) => d.cue === i.cue))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const info of idle) {
      if (total() <= this.musicCacheSeconds) break;
      this.musicDecoded.delete(info.cue);
      this.stats.evicted++;
    }
  }

  /** unlock のあと、曲を順に decode しておく（タイトル → 遊ぶ → ラスト → 結果。覚えておける長さの中で） */
  async predecode() {
    try {
      await this.load();
    } catch {
      return;
    }
    for (const cue of MUSIC_CUES) {
      const m = this.manifest.music?.[cue];
      if (!m) continue;
      const used = [...this.musicDecoded.values()].reduce((s, i) => s + i.seconds, 0);
      if (!this.musicDecoded.has(cue) && used + m.frames / m.rate > this.musicCacheSeconds) continue;
      try {
        await this.decodeMusic(cue);
      } catch (e) {
        this.report(`BGM ${cue} を decode できない: ${e.message}`);
      }
    }
  }

  // MARK: - 確かめ用

  /** 今の様子（audio_test.html が表に出す） */
  info() {
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
    return {
      state: ctx ? ctx.state : 'まだ作っていない',
      sampleRate: ctx?.sampleRate,
      baseLatency: ctx?.baseLatency,
      outputLatency: ctx?.outputLatency,
      busyVoices: this.voices.filter((v) => !v.done && !v.fading && v.endsAt > now).length,
      loops: [...this.loopVoices.entries()].map(([ch, lv]) => ({
        channel: ch, active: lv.active, releasing: lv.releasing,
        gain: lv.gm ? evalTarget(lv.gm, now) : 0, rate: lv.rm ? evalTarget(lv.rm, now) : 1,
      })),
      decks: this.decks.map((d) => ({ cue: d.cue, g: d.g, target: d.target })),
      duck: this.duckLevel,
      quiet: this.quietLevel,
      musicCue: this.musicCue,
      decodedMusic: [...this.musicDecoded.keys()],
      stats: { ...this.stats },
    };
  }

  /** 曲を decode して、ループの位置などを返す（確かめ用） */
  debugMusic(cue) { return this.decodeMusic(cue); }

  /** 鳴っている曲を、継ぎ目の before 秒前から鳴らし直す（継ぎ目を耳で確かめる用） */
  debugSeekMusic(before = 3) {
    const deck = this.decks.find((d) => d.cue && d.target > 0);
    const info = deck && this.musicDecoded.get(deck.cue);
    if (!info || !this.ctx) return false;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = info.buffer;
    src.loop = true;
    src.loopStart = info.loopStart;
    src.loopEnd = info.loopEnd;
    src.connect(deck.gain);
    const now = ctx.currentTime;
    deck.src.stop(now);
    src.start(now, Math.max(info.loopStart, info.loopEnd - before));
    deck.src = src;
    return true;
  }

  report(message) {
    this.stats.lastError = message;
    console.warn('音: ' + message);
  }
}

// MARK: - 部品

/** setTargetAtTime の式（v(t) = target + (v0 − target)·e^(−(t − t0)/τ)）。AudioParam と同じ値を JS でも持つ */
function evalTarget(m, t) {
  if (!m) return 0;
  return m.target + (m.v0 - m.target) * Math.exp(-Math.max(t - m.t0, 0) / m.tau);
}

/** 今の値 from から、時定数 tau で to へ寄せ直す */
function setTarget(param, from, to, tau, now) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  param.setTargetAtTime(to, now, tau);
}

/**
 * ループの継ぎ目の手前 seconds 秒を、跳んだ先の手前（loopStart の前。ファイルの前に足したループの尻）へ線形に寄せる。
 * 2 つは同じ曲の同じ所なので、線形に寄せても音量は落ちない。終わりで「跳んだ先の手前」と同じになるので、継ぎ目に段差が無い。
 * 継ぎ目が標本の間に来る（44.1kHz で decode して端数が出た）ときは、跳ぶ直前に次の標本との間を補間して読むので、
 * 継ぎ目の後ろの 2 標本も寄せきっておく
 */
function smoothSeam(buffer, loopStart, loopEnd, seconds) {
  const sr = buffer.sampleRate;
  const n = Math.round(seconds * sr);
  const end = Math.floor(loopEnd * sr);
  const shift = (loopEnd - loopStart) * sr; // ループの長さ（フレーム。44.1kHz で decode すると端数が出る）
  const from = end - n;
  const to = Math.min(end + 2, buffer.length);
  if (from - shift < 1) return;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let j = from; j < to; j++) {
      const s = j - shift;
      const a = Math.floor(s);
      const f = s - a;
      const v = d[a] * (1 - f) + d[a + 1] * f;
      const w = Math.min((j - from + 1) / n, 1);
      d[j] = d[j] * (1 - w) + v * w;
    }
  }
}

/** decodeAudioData を Promise で（古い Safari は戻り値が Promise でなく、成功・失敗の関数だけを呼ぶ） */
function decodeAudio(ctx, bytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (b) => { if (!settled) { settled = true; resolve(b); } };
    const ng = (e) => { if (!settled) { settled = true; reject(e || new Error('decodeAudioData に失敗')); } };
    const r = ctx.decodeAudioData(bytes, ok, ng);
    if (r && typeof r.then === 'function') r.then(ok, ng);
  });
}

let offlineForBuffers = null;
function makeBuffer(channels, length, sampleRate) {
  try {
    return new AudioBuffer({ numberOfChannels: channels, length, sampleRate });
  } catch {
    // AudioBuffer を直接作れない古い Safari（14.0 まで）
    const C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    offlineForBuffers ??= new C(1, 1, 44100);
    return offlineForBuffers.createBuffer(channels, length, sampleRate);
  }
}

/**
 * wav を自前で読んで AudioBuffer にする（整数 PCM 8/16/24/32bit と float 32bit。WAVE_FORMAT_EXTENSIBLE も）。
 * decodeAudioData を使わないのは、AudioContext を作る前（最初のタップの前）に読み終えたいから。
 * 44.1kHz のまま入れる（AudioContext が 48kHz なら、鳴らすときに AudioBufferSourceNode が合わせる。音程の再生レートと同じ仕組み）
 */
export function parseWav(ab) {
  const dv = new DataView(ab);
  const tag4 = (p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
  if (dv.byteLength < 12 || tag4(0) !== 'RIFF' || tag4(8) !== 'WAVE') throw new Error('wav でない');
  let p = 12;
  let fmt = null;
  let dataAt = -1;
  let dataLen = 0;
  while (p + 8 <= dv.byteLength) {
    const id = tag4(p);
    const size = dv.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // 拡張形式は SubFormat の頭
      fmt = { format, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      dataAt = body;
      dataLen = Math.min(size, dv.byteLength - body);
    }
    p = body + size + (size & 1);
  }
  if (!fmt || dataAt < 0) throw new Error('fmt か data が無い');
  const { format, channels, rate, bits } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(dataLen / (channels * bytes));
  if (!frames) throw new Error('中身が無い');
  const buffer = makeBuffer(channels, frames, rate);
  const read =
    format === 3 && bits === 32 ? (q) => dv.getFloat32(q, true)
    : format === 1 && bits === 16 ? (q) => dv.getInt16(q, true) / 32768
    : format === 1 && bits === 24 ? (q) => ((dv.getUint8(q) | (dv.getUint8(q + 1) << 8) | (dv.getInt8(q + 2) << 16)) / 8388608)
    : format === 1 && bits === 32 ? (q) => dv.getInt32(q, true) / 2147483648
    : format === 1 && bits === 8 ? (q) => (dv.getUint8(q) - 128) / 128
    : null;
  if (!read) throw new Error(`読めない書式（形式 ${format}・${bits}bit）`);
  for (let c = 0; c < channels; c++) {
    const out = new Float32Array(frames);
    for (let i = 0, q = dataAt + c * bytes; i < frames; i++, q += channels * bytes) out[i] = read(q);
    buffer.getChannelData(c).set(out);
  }
  return buffer;
}
