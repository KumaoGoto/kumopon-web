// 振動（Android の Chrome の navigator.vibrate）。
// ゲーム（kumopon.wasm の WebFeel・WebVibe）が、iOS と同じ触覚のパターンを「震える・止まる」の長さの並びにして渡してくる。
// navigator.vibrate は呼ぶたびに前の並びを打ち切って新しい並びを始めるので、ここで「これから震える区間」を時刻で持ち、
// 新しい要求が来たら重ねて（つないで）、今からの並びを作り直して渡す。続く振動（口でしぼる「むにゅ〜」）は
// 刻みごとに強さの割合だけ震える区間を、少し先まで足し続ける。
// 刻み・つなぐすき間・先に足す長さなどの数はここに書かない。ゲームの FeelTuning.Web（WebVibe.swift）を engine.vibeTuning() で受け取る。
//
// iPhone の Safari とパソコンには navigator.vibrate が無い（呼んでも何も起きない）。最初に画面を触るまでは震えない（ブラウザの決まり）。
// 毎フレーム呼ばれるので、震えていない間は何も作らない（安い Android で、細かいゴミの片付けでフレームが引っかからないように）。

const TUNING_KEYS = ['window', 'minOn', 'solid', 'join', 'lookahead', 'refill', 'levelStep', 'resend'];

/** ブラウザが振動を許しているか（一度も画面を触っていないうちは、呼んでも震えず、Chrome がエラーを出す） */
function activated() {
  const ua = navigator.userActivation;
  return !ua || ua.hasBeenActive;
}

export class Haptics {
  /** tuning: engine.vibeTuning()（FeelTuning.Web の window・minOn・solid・join・lookahead・refill・levelStep・resend） */
  constructor(tuning) {
    for (const k of TUNING_KEYS) {
      if (!Number.isFinite(tuning?.[k])) throw new Error(`haptics: 振動の数 ${k} が無い（kumopon.wasm と js の版がずれている）`);
    }
    this.t = tuning;
    this.supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
    this.enabled = true;
    /** これから震える区間 [始まり, 終わり]（performance.now の ms）。続く振動の区間は .channel を持つ */
    this.spans = [];
    /** 続く振動のチャンネル → { level, until（ここまで区間を足した） } */
    this.channels = new Map();
    this.lastSent = -1e9;
    this.lastSentKey = '';
    /** 確かめ用: 渡した数と、渡した並び（最後のいくつか） */
    this.sentCount = 0;
    this.log = [];
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.stop();
  }

  /** 1 つの要求（長さの並び ms: 震える・止まる・震える…）を今から重ねる */
  play(pattern, now = performance.now()) {
    if (!this.enabled || !this.supported) return;
    let t = now;
    for (let i = 0; i < pattern.length; i++) {
      const d = pattern[i];
      if (i % 2 === 0 && d > 0) this.spans.push([t, t + d]);
      t += d;
    }
    this.flush(now, true);
  }

  /** 続く振動の強さ（0〜1。0 で止める）。ゲームが 30Hz ほどで送ってくる */
  continuous(channel, level, now = performance.now()) {
    if (level <= 0.001) {
      if (this.channels.has(channel)) {
        this.channels.delete(channel);
        // 先に足しておいた区間は消す（離したらすぐ止まる）
        this.dropAhead(channel, now);
        this.flush(now, true);
      }
      return;
    }
    const c = this.channels.get(channel);
    if (!c) {
      this.channels.set(channel, { level, until: now });
    } else if (Math.abs(c.level - level) >= this.t.levelStep) {
      // 強さが変わった: 先に足した区間を捨てて、今の刻みから作り直す（次の tick で）
      c.level = level;
      this.dropAhead(channel, now);
      c.until = now;
    }
  }

  /** 毎フレーム呼ぶ: 続く振動の区間を先まで足し、要れば並びを渡し直す */
  tick(now = performance.now()) {
    if (!this.enabled || !this.supported) return;
    if (this.spans.length === 0 && this.channels.size === 0) return;   // 何も震えていない
    const { window: win, minOn, solid, lookahead, refill } = this.t;
    let changed = false;
    for (const [channel, c] of this.channels) {
      if (c.until < now) c.until = now;
      if (c.until >= now + refill) continue;
      while (c.until < now + lookahead) {
        const a = c.until;
        const on = win * c.level;
        if (c.level >= solid) this.pushSpan(a, a + win, channel);
        else if (on >= minOn) this.pushSpan(a, a + on, channel);
        c.until = a + win;
        changed = true;
      }
    }
    this.flush(now, changed);
  }

  pushSpan(a, b, channel) {
    const s = [a, b];
    s.channel = channel;
    this.spans.push(s);
  }

  /** そのチャンネルの、まだ始まっていない区間を捨てる（並びはその場で詰める） */
  dropAhead(channel, now) {
    let k = 0;
    for (const s of this.spans) if (s[0] <= now || s.channel !== channel) this.spans[k++] = s;
    this.spans.length = k;
  }

  /** 全部止める（タブが裏に回った・振動を切った・一時停止） */
  stop() {
    this.spans.length = 0;
    this.channels.clear();
    if (this.supported && activated()) navigator.vibrate(0);
    this.lastSentKey = '';
  }

  /** 今からの並びを作って渡す（変わったとき・長い区間の途中で渡し直すとき） */
  flush(now, changed) {
    // 終わった区間を捨てる（その場で詰める）
    let k = 0;
    for (const s of this.spans) if (s[1] > now) this.spans[k++] = s;
    this.spans.length = k;
    if (k === 0) {
      if (changed && this.lastSentKey !== '') {
        navigator.vibrate(0);
        this.lastSentKey = '';
      }
      return;
    }
    if (!changed && now - this.lastSent < this.t.resend) return;
    if (!activated()) return;   // まだ画面を触っていない（区間は持ったまま。触ったら続きから震える）
    const join = this.t.join;
    const list = this.spans.map((s) => [Math.max(s[0], now), s[1]]).sort((p, q) => p[0] - q[0]);
    const joined = [];
    for (const s of list) {
      const last = joined[joined.length - 1];
      if (last && s[0] <= last[1] + join) last[1] = Math.max(last[1], s[1]);
      else joined.push([s[0], s[1]]);
    }
    const pattern = [];
    let cursor = now;
    for (const [a, b] of joined) {
      const off = Math.round(a - cursor);
      if (pattern.length === 0) {
        if (off > 0) pattern.push(0, off);
      } else {
        pattern.push(off);
      }
      pattern.push(Math.max(1, Math.round(b - a)));
      cursor = b;
    }
    const key = pattern.join(',');
    // 同じ並びの渡し直しは、長い区間の途中のときだけ（毎フレーム呼ぶと、端末によってはモーターがつっかえる）
    if (key === this.lastSentKey && now - this.lastSent < this.t.resend) return;
    navigator.vibrate(pattern);
    this.lastSent = now;
    this.lastSentKey = key;
    this.sentCount++;
    this.log.push(pattern);
    if (this.log.length > 20) this.log.shift();
  }
}
