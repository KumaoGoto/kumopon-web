// 遊ぶ画面の上の帯（App/Shell/HUDView.swift のうち、エンドレスで出るもの）:
// 左上の一時停止・上の真ん中の点・右上の時計の輪（のびた秒「+15」）・その下の段のはしご（LadderView）・返しの数え上げ（TallyView）・
// READY の字・残りわずかの画面のふちの桃色の光（HurryGlow）。
// 「のこり 10びょう!」の札と 5 秒からの大きな数字は、iOS と同じく描画（RenderScene の字）の側が出す。
// HUD の JSON は WebAssembly から変わったときだけ 15Hz ほどで来る（Web/Engine/Sources/KumoponWeb/WebJSON.swift の hud）。
// 時計の輪・点の数え上げは、その間を requestAnimationFrame でなめらかにつなぐ

import { C, RAINBOW, h, icon, outlined, fmt, fitText, animate, EASE, rgba } from './parts.js';

const RING_R = 29;
const RING_LEN = 2 * Math.PI * RING_R;

export class HUD {
  /** el: HUD を入れる要素。onPause: 一時停止のボタン */
  constructor(el, { onPause }) {
    this.el = el;
    this.onPause = onPause;
    this.build();
    this.reset();
  }

  build() {
    // 画面のふちの桃色の光（残りわずかの間。遊ぶ列の左右と画面の上下のふち）
    this.glow = h('div.hurry-glow', null, h('div.pulse'));
    this.pauseBtn = h('button.press.pause-btn', { type: 'button', 'aria-label': 'いちじていし', onclick: () => this.onPause() }, icon('pause', 21));
    this.score = outlined('0', 38, C.ink);
    this.score.classList.add('score');
    this.rain = h('div.rain-pill', { text: 'にじ ×0' });
    this.mid = h('div.hud-mid', null, h('div.score-box', null, this.score), this.rain);
    this.timer = this.buildTimer();
    this.ladder = h('div.ladder', { role: 'img' });
    this.tallyRow = h('div.tally-row');
    this.banner = h('div.banner-layer');
    this.col = h('div.col.hud-col', null,
      h('div.hud-row', null, this.pauseBtn, h('div.spacer'), this.mid, h('div.spacer'), this.timer.root),
      this.ladder,
      this.tallyRow);
    this.el.append(this.glow, this.col, this.banner);
  }

  /** 残り時間の輪（TimerPill）: 白い丸・薄い溝・残りの弧（上から時計回り）・秒の数と「びょう」。のびた秒の「+15」は左下に浮かぶ */
  buildTimer() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 68 68');
    svg.setAttribute('class', 'ring');
    svg.innerHTML = `<circle cx="34" cy="34" r="34" fill="rgba(255,255,255,0.92)"/>
      <circle cx="34" cy="34" r="${RING_R}" fill="none" stroke="rgba(92,64,84,0.08)" stroke-width="8"/>
      <circle class="arc" cx="34" cy="34" r="${RING_R}" fill="none" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${RING_LEN.toFixed(2)}" transform="rotate(-90 34 34)"/>`;
    const arc = svg.querySelector('.arc');
    const num = h('div.t-num', { text: '60' });
    const unit = h('div.t-unit', { text: 'びょう' });
    const beat = h('div.t-beat', null, svg, h('div.t-text', null, num, unit));
    const pop = h('div.t-pop', null, beat);
    const bonus = h('div.t-bonus');
    const root = h('div.timer', { role: 'timer', 'aria-label': 'のこり時間' }, pop, bonus);
    return { root, pop, beat, arc, num, bonus };
  }

  /** 新しいランの初め（showPlaying）: 前のランの表示を消す */
  reset() {
    this.h = null;
    this.shownScore = 0;
    this.scoreFrom = 0;
    this.scoreTo = 0;
    this.scoreT0 = 0;
    this.frac = 1;
    this.fracFrom = 1;
    this.fracTo = 1;
    this.fracT0 = 0;
    this.timeInt = null;
    this.bonusSerial = undefined;
    this.tallySerial = null;
    this.tallyStart = 0;
    this.tallyData = null;
    this.ladderBuilt = 0;
    this.reached = -1;
    this.bannerText = null;
    this.finished = false;
    this.paused = false;
    this.score.textContent = '0';
    fitText(this.score, 38);
    this.scoreDigits = 1;
    this.rain.hidden = true;
    this.ladder.replaceChildren();
    this.ladder.hidden = true;
    this.tallyRow.replaceChildren();
    this.banner.replaceChildren();
    this.timer.num.textContent = '60';
    this.timer.arc.style.strokeDashoffset = '0';
    this.setRingColor(false, 60);
    this.el.classList.remove('finished');
    this.glow.classList.remove('on');
    this.pauseBtn.classList.add('off');
  }

  // ---- 来た HUD を写す ----

  update(hd, now = performance.now()) {
    if (!hd) return;
    this.h = hd;
    // 点: 前の数から新しい数へ 0.35 秒で数える（iOS は数字の入れ替え〈numericText〉とばね 0.25）
    if (hd.score !== this.scoreTo) {
      this.scoreFrom = this.shownScore;
      this.scoreTo = hd.score;
      this.scoreT0 = now;
    }
    // にじ ×N（エンドレスは出さない遊び方。showRainbows の遊び方だけ）
    this.rain.hidden = !hd.showRainbows;
    if (hd.showRainbows) this.rain.textContent = `にじ ×${hd.rainbows}`;
    // 時計の輪: 新しい割合へ easeOut 0.25 秒（TimerPill の .animation(.easeOut(duration: 0.25), value: frac)）
    const frac = Math.max(0, Math.min(1, hd.timeLeft / Math.max(hd.timeTotal, 1)));
    if (frac !== this.fracTo) {
      this.fracFrom = this.frac;
      this.fracTo = frac;
      this.fracT0 = now;
    }
    const secs = Math.ceil(hd.timeLeft - 1e-4);
    if (secs !== this.timeInt) {
      const down = this.timeInt != null && secs < this.timeInt;
      this.timeInt = secs;
      const n = this.timer.num;
      n.textContent = String(Math.max(0, secs));
      n.classList.toggle('small', secs >= 100);
      // 数え下ろしの字の入れ替え（numericText(countsDown:)。新しい字が上から少し下りて現れる）
      if (down) animate(n, [{ transform: 'translateY(-5px)', opacity: 0.25 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0, 0, 0.58, 1)', fill: 'none' });
    }
    this.setRingColor(hd.hurry, hd.timeLeft);
    // 残りわずかの脈: 0.5 秒ごとに 1.08 倍（Int(timeLeft × 2) の偶奇）
    this.timer.beat.classList.toggle('beat', hd.hurry && Math.floor(hd.timeLeft * 2) % 2 === 0);
    this.timer.root.classList.toggle('hurry', !!hd.hurry);
    this.glow.classList.toggle('on', !!hd.hurry && !this.finished && !this.paused);
    // のびた秒（serial が変わるたびに 1 回）。ランの最初の HUD に前からの値があっても弾ませない
    const b = hd.timeBonus;
    if (this.bonusSerial === undefined) this.bonusSerial = b ? b.serial : null;
    else if (b && b.serial !== this.bonusSerial) {
      this.bonusSerial = b.serial;
      this.showBonus(b.seconds);
    }
    // 一時停止のボタン（READY と本番の間だけ。止めている間と終わった後は消す）
    this.pauseBtn.classList.toggle('off', !(hd.canPause && !this.paused && !this.finished));
    if (hd.ladder) this.updateLadder(hd.ladder);
    this.updateTally(hd.tally, now);
    this.updateBanner(hd.banner || null);
  }

  setRingColor(hurry, timeLeft) {
    const color = hurry ? C.pinkDeep : timeLeft <= 20 ? C.lemon : C.mint;
    this.timer.arc.setAttribute('stroke', color);
    this.timer.num.style.color = hurry ? C.pinkDeep : C.ink;
  }

  /** 「+15」が左下へ浮かんで消え、輪が弾む（pop はばね 0.32 / 0.42、浮かぶのは easeOut 0.9 秒、消えるのは 0.6 秒後から easeIn 0.45 秒） */
  showBonus(seconds) {
    const t = h('div.bonus-text', { text: `+${seconds}` });
    t.style.fontSize = (seconds >= 15 ? 22 : 17) + 'px';
    this.timer.bonus.replaceChildren(t);
    animate(this.timer.pop, [{ transform: 'scale(1.22)' }, { transform: 'scale(1)' }], { spring: [0.32, 0.42], fill: 'none' });
    animate(t, [{ transform: 'translateY(0)' }, { transform: 'translateY(-26px)' }], { duration: 900, easing: 'cubic-bezier(0, 0, 0.58, 1)' });
    const fade = animate(t, [{ opacity: 1 }, { opacity: 0 }], { duration: 450, delay: 600, easing: 'cubic-bezier(0.42, 0, 1, 1)', fill: 'forwards' });
    if (fade) fade.onfinish = () => t.remove();
  }

  // ---- 段のはしご（LadderView）----

  /** はしごの雲の形（丸 3 つと平らな底。LadderCloud）を SVG の道に。どの丸も時計回りに描いて、重なりを 1 枚に塗る */
  static cloudPath(x, y, w, hh) {
    const ell = (ex, ey, ew, eh) => {
      const rx = ew / 2, ry = eh / 2, cx = ex + rx, cy = ey + ry;
      return `M${(cx - rx).toFixed(2)} ${cy.toFixed(2)}a${rx.toFixed(2)} ${ry.toFixed(2)} 0 1 1 ${(2 * rx).toFixed(2)} 0a${rx.toFixed(2)} ${ry.toFixed(2)} 0 1 1 ${(-2 * rx).toFixed(2)} 0Z`;
    };
    const rr = (rx, ry, rw, rh, c) => `M${rx + c} ${ry}H${rx + rw - c}A${c} ${c} 0 0 1 ${rx + rw} ${ry + c}V${ry + rh - c}A${c} ${c} 0 0 1 ${rx + rw - c} ${ry + rh}H${rx + c}A${c} ${c} 0 0 1 ${rx} ${ry + rh - c}V${ry + c}A${c} ${c} 0 0 1 ${rx + c} ${ry}Z`;
    return ell(x, y + hh * 0.38, w * 0.42, hh * 0.58)
      + ell(x + w * 0.22, y, w * 0.52, hh * 0.8)
      + ell(x + w * 0.56, y + hh * 0.3, w * 0.44, hh * 0.64)
      + rr(x + w * 0.12, y + hh * 0.55, w * 0.76, hh * 0.45, hh * 0.22);
  }

  buildLadder(l) {
    const n = l.body.length;
    this.ladderBuilt = n;
    this.steps = [];
    this.ladder.replaceChildren();
    for (let k = 0; k < n; k++) {
      // 小さい段ほど小さく（19〜28px）。8 こで 200px ほどなので、360px の幅でも収まる
      const size = 19 + (9 * k) / Math.max(n - 1, 1);
      const w = size + 3, hh = size * 0.72 + 3;
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${w.toFixed(2)} ${hh.toFixed(2)}`);
      svg.setAttribute('width', w.toFixed(2));
      svg.setAttribute('height', hh.toFixed(2));
      const isRainbow = k === n - 1;
      const gid = `ladder-rainbow-${Math.random().toString(36).slice(2, 8)}`;
      svg.innerHTML = (isRainbow ? `<defs><linearGradient id="${gid}" x1="0" x2="1" y1="0" y2="0">${RAINBOW.map((c, i) => `<stop offset="${(i / (RAINBOW.length - 1)).toFixed(3)}" stop-color="${c}"/>`).join('')}</linearGradient></defs>` : '')
        // 縁は、少し大きい同じ形を縁の色で後ろに敷く（丸の重なりの中に線が出ないように）
        + `<path class="rim" d="${HUD.cloudPath(0, 0, w, hh)}"/>`
        + `<path class="body" d="${HUD.cloudPath(1.5, 1.5, size, size * 0.72)}"/>`;
      const art = h('div.step-art', null, svg);
      const badge = isRainbow ? h('div.step-badge', { hidden: true, style: { left: `${(w / 2 + size * 0.42).toFixed(1)}px`, top: `${(hh / 2 - size * 0.36).toFixed(1)}px` } }) : null;
      if (badge) art.append(badge);
      const dot = h('div.step-dot');
      const el = h('div.step', null, art, dot);
      this.ladder.append(el);
      this.steps.push({ el, art, svg, dot, badge, isRainbow, gid, rim: svg.querySelector('.rim'), body: svg.querySelector('.body') });
    }
  }

  updateLadder(l) {
    if (this.ladderBuilt !== l.body.length) this.buildLadder(l);
    this.ladder.hidden = false;
    for (let k = 0; k < this.steps.length; k++) {
      const s = this.steps[k];
      const reached = k <= l.reached;
      const inJar = (l.inJar & (1 << k)) !== 0;
      s.art.style.opacity = reached ? '1' : '0.55';
      s.body.setAttribute('fill', !reached ? 'rgba(255,255,255,0.75)' : s.isRainbow ? `url(#${s.gid})` : rgba(l.body[k]));
      s.rim.setAttribute('fill', reached ? rgba(l.rim[k]) : 'rgba(140,112,133,0.3)');
      s.dot.classList.toggle('on', inJar);
      if (s.badge) {
        s.badge.hidden = !(l.rainbows > 0);
        s.badge.textContent = `×${l.rainbows}`;
      }
      // 新しい段に届いた: 大きくしてから、行き過ぎて戻る（ばね 0.18 / 0.5 で 1.3 倍 → 0.22 秒後に 0.35 / 0.55 で戻る）
      if (reached && k > this.reached) {
        const up = animate(s.art, [{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }], { spring: [0.18, 0.5], fill: 'forwards' });
        setTimeout(() => {
          up?.cancel();
          animate(s.art, [{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { spring: [0.35, 0.55], fill: 'none' });
        }, 220);
      }
    }
    this.reached = l.reached;
    this.ladder.setAttribute('aria-label', l.reached >= 0 ? `いちばん大きな雲 ${l.names[l.reached]}` : 'まだ 雲は ありません');
  }

  // ---- 返しの数え上げ（TallyView）----

  updateTally(t, now) {
    if (!t) return;
    if (t.serial === this.tallySerial) return;
    this.tallySerial = t.serial;
    this.tallyData = t;
    this.tallyStart = now;
    const label = h('span.tally-tag', { text: t.mult >= 2 ? `×${t.mult} コンボ` : `${t.count}こ` });
    this.tallyNum = h('span.tally-num', { text: '+0' });
    this.tallyEl = h('div.tally', null, label, this.tallyNum);
    this.tallyRow.replaceChildren(this.tallyEl);
  }

  /** 毎フレーム: 点の数え上げ・輪の割合・返しの数え上げ */
  tick(now) {
    // 点
    if (this.shownScore !== this.scoreTo) {
      const u = Math.min(1, (now - this.scoreT0) / 350);
      this.shownScore = u >= 1 ? this.scoreTo : Math.round(this.scoreFrom + (this.scoreTo - this.scoreFrom) * EASE.outCubic(u));
      this.score.textContent = fmt(this.shownScore);
      const digits = this.score.textContent.length;
      if (digits !== this.scoreDigits) {
        this.scoreDigits = digits;
        fitText(this.score, 38);
      }
    }
    // 輪
    if (this.frac !== this.fracTo) {
      const u = Math.min(1, (now - this.fracT0) / 250);
      this.frac = u >= 1 ? this.fracTo : this.fracFrom + (this.fracTo - this.fracFrom) * EASE.out(u);
      this.timer.arc.style.strokeDashoffset = (RING_LEN * (1 - this.frac)).toFixed(2);
      // 0 のときは丸い端だけの点も消す
      this.timer.arc.style.visibility = this.frac <= 0.001 ? 'hidden' : 'visible';
    }
    // 返しの数え上げ: countTime 秒で 0 から（最初速く最後ゆっくり）。数え終わって holdTime 秒で 0.3 秒かけて消える。最初の 0.18 秒は少し大きく
    const t = this.tallyData;
    if (t && this.tallyEl) {
      const s = (now - this.tallyStart) / 1000;
      const u = Math.min(1, Math.max(0, s / Math.max(t.countTime, 0.01)));
      const eased = 1 - Math.pow(1 - u, 3);
      this.tallyNum.textContent = '+' + fmt(t.points * eased);
      const fade = s > t.countTime + t.holdTime ? Math.max(0, 1 - (s - t.countTime - t.holdTime) / 0.3) : 1;
      this.tallyEl.style.opacity = String(EASE.out(fade));
      this.tallyEl.style.transform = `scale(${1 + 0.12 * Math.max(0, 1 - s / 0.18)})`;
      if (fade <= 0) {
        this.tallyEl.remove();
        this.tallyEl = null;
        this.tallyData = null;
      }
    }
  }

  // ---- READY ----

  updateBanner(text) {
    if (text === this.bannerText) return;
    const old = this.banner.firstChild;
    if (old) {
      const a = animate(old, [{ transform: 'translate(-50%, -50%) scale(1)', opacity: 1 }, { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0 }], { spring: [0.35, 0.6], fill: 'forwards' });
      if (a) a.onfinish = () => old.remove(); else old.remove();
    }
    this.bannerText = text;
    if (!text) return;
    // READY は真ん中より 60px 上に大きく、ほかの一言（終盤の一言の遊び方）は 230px 上に
    const ready = text === 'READY';
    const el = outlined(text, ready ? 44 : 26, this.h?.hurry && !ready ? C.pinkDeep : C.ink);
    el.classList.add('banner');
    el.style.top = `calc(50% - ${ready ? 60 : 230}px)`;
    this.banner.append(el);
    animate(el, [{ transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 }], { spring: [0.35, 0.6] });
  }

  // ---- 状態 ----

  setPaused(on) {
    this.paused = on;
    this.pauseBtn.classList.toggle('off', on || this.finished || !this.h?.canPause);
    this.glow.classList.toggle('on', !!this.h?.hurry && !this.finished && !on);
  }

  /** 結果を出している間: 点・時計・はしごを消す（結果のカードと二重になる。easeOut 0.3 秒） */
  setFinished(on) {
    this.finished = on;
    this.el.classList.toggle('finished', on);
    this.pauseBtn.classList.add('off');
    this.glow.classList.remove('on');
    if (on) this.updateBanner(null);
  }
}

