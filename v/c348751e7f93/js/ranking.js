// ランキング（iOS と同じ表。依頼者の決定 2026-11-07）。サーバーは iOS と同じ（server/。ブラウザが名乗れるのは版 w6 だけで、サーバーが e6 の一覧に向ける）。
// 送り方は iOS の OnlineSync（App/Online/OnlineSync.swift）と同じ:
// - 名前を決めるまでは何も送らない。参加は「利用規約に同意して名前を決める」＝ /v1/register が通ったとき。uid はそのとき作る
// - 結果が出たら毎回送る（サーバーは今日・今週・全期間で点を下げないので、低い回を送っても害がなく、今の順位が返る）
// - 送れなかった回は、その日（日本時間）のいちばん良い回だけを取っておき、次の結果・一覧を開いた時・読み込んだ時に古い順に送る。
//   送り直すのは 429・5xx・圏外のときだけ。400 は送り直しても同じなので捨てる。409（知らない人）は覚えている名前で登録し直して 1 回だけ送り直す
// 画面は iOS の RankingSheet（App/Shell/RankingSheet.swift）の中身を、画面の担当が用意した口（ui.rankingSlot()）に組む。

import * as store from './storage.js';
import { fitAll } from './ui/parts.js';

const API = 'https://kumopon-ranking.saikyo-eigo.workers.dev';
/** ブラウザ版の版（サーバーの WEB_VERS。決まりは iOS の e6 と同じで、一覧も e6 と同じ。サーバーの WEB_SHARED_VER） */
const VER = 'w6';
const TERMS_VERSION = 2;
const NAME_MAX = 10;
const BOARD_SIZE = 30;
const TIMEOUT_MS = 8000;
/** 利用規約（iOS の RankingConfig.termsLines と同じ文。ブラウザ版に合わせて、アプリを消す → ブラウザのデータを消す、に言いかえた） */
const TERMS = [
  'ランキングには、決めた名前と点数・にじ雲の数が表示されます。',
  '人を傷つける言葉、性的な言葉、他人の権利を侵す名前は使わないでください。見つけたものは予告なく非表示・変更することがあります。',
  'ふさわしくない名前やありえない点は「通報」できます。通報した人は、あなたの画面に出なくなります。運営が確かめて、ふさわしくないものはみんなの画面からも消します。',
  '「表示しない」にした人は、あなたの画面に出なくなります。',
  '「名前を変える」の「ランキングをやめて記録を消す」で、名前と記録をいつでもサーバーから消せます。',
  'このブラウザのデータを消すと、同じ名前でも別の人として数えられます（前の記録はサーバーに残るので、消すときは先に上の操作を）。',
  'ランキングは App Store 版（iPhone）と同じ表です。運営が用意した参加者（Bot）も載ります。',
  'お問い合わせ: support.kumaogoto@gmail.com',
];
const TABS = [
  { id: 'today', title: '今日' },
  { id: 'week', title: '今週' },
  { id: 'all', title: '全期間' },
  { id: 'local', title: 'この端末' },
];

/** 日本時間の "yyyy-MM-dd"（サーバーと同じ区切り） */
function jstDay(d = new Date()) {
  const t = new Date(d.getTime() + 9 * 3600_000);
  return t.toISOString().slice(0, 10);
}

/** 名前の掃除（OnlineSync.clean・サーバーの cleanName と同じ: 制御文字・零幅・向きの制御を落とし、前後の空白を取り、見た目 10 文字まで） */
function cleanName(s) {
  const drop = /[\u0000-\u001f\u007f-\u009f​‌‎‏﻿‪-‮⁦-⁩]/g;
  const t = String(s || '').replace(drop, '').trim();
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(t), (x) => x.segment) : Array.from(t);
  return seg.slice(0, NAME_MAX).join('');
}

function graphemes(s) {
  return typeof Intl !== 'undefined' && Intl.Segmenter ? Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(s)).length : Array.from(s).length;
}

const fmt = (n) => Number(n || 0).toLocaleString('ja-JP');
const fmtSeconds = (s) => `${Math.floor(s / 60)}ふん${s % 60}びょう`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class HttpError extends Error {
  constructor(status, code) {
    super(code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

export class Ranking {
  constructor() {
    // 確かめ用: ?ranking=local で手元の wrangler dev（server/ の npm run dev:test。127.0.0.1:8791）に当てる
    this.api = new URLSearchParams(location.search).get('ranking') === 'local' ? 'http://127.0.0.1:8791' : API;
    this.state = store.loadRanking();
    this.pending = store.loadPending();
    this.pushing = null;
    this.leaving = false;
    /** 結果の画面に順位を出す（main.js が ui.setRunRank をつなぐ） */
    this.onRunStatus = null;
    this.tab = 'today';
    this.slot = null;
    ensureStyle();
    // 読み込んだ時: 参加していれば、送れていない分を送る
    if (this.joined) this.push().catch(() => {});
  }

  get joined() { return !!(this.state.joined && this.state.uid && this.state.name); }

  // ---- 通信 ----

  async call(method, path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(this.api + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
        cache: 'no-store',
      });
      let json = {};
      try { json = await res.json(); } catch {}
      if (!res.ok) throw new HttpError(res.status, json.error);
      return json;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(0, 'offline');
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 参加・名前・やめる ----

  async join(rawName) {
    const name = cleanName(rawName);
    if (!name) return 'なまえを いれてください';
    const uid = this.state.uid || store.newUid();
    try {
      const r = await this.call('POST', '/v1/register', { uid, name, terms: TERMS_VERSION });
      this.state = { joined: true, name: r.name || name, uid, pid: r.pid || '' };
      store.saveRanking(this.state);
      // この端末の最近の記録（今日・今週に入る 3 日の中のいちばん良い回と、自己ベスト）を送る
      const recs = store.loadRecords();
      const days = new Set([0, 1, 2].map((k) => jstDay(new Date(Date.now() - k * 86400_000))));
      for (const r0 of recs) {
        const day = jstDay(new Date(r0.date));
        if (days.has(day) || r0 === recs[0]) this.enqueue({ score: r0.score, rainbows: r0.rainbows, seconds: Math.max(60, r0.seconds | 0), day });
      }
      this.push().catch(() => {});
      return null;
    } catch (e) {
      if (e.code === 'ng name') return 'その なまえは つかえません';
      if (e.code === 'bad name') return 'その なまえは つかえません（見える 文字を いれてください）';
      if (e.status === 429) return 'すこし 時間を おいて ためしてください';
      return 'つながりませんでした';
    }
  }

  async leave() {
    if (!this.joined) return null;
    this.leaving = true;
    try {
      if (this.pushing) await this.pushing.catch(() => {});
      await this.call('POST', '/v1/leave', { uid: this.state.uid });
      this.state = { joined: false, name: '', uid: '', pid: '' };
      store.saveRanking(this.state);
      this.pending = [];
      store.savePending(this.pending);
      return null;
    } catch {
      return 'つながりませんでした。もう一度 ためしてください';
    } finally {
      this.leaving = false;
    }
  }

  // ---- 送る ----

  /** 結果が出たとき: 参加していれば送り、結果の画面に順位を出す */
  afterRun(result) {
    if (!this.joined || this.leaving) return;
    this.enqueue({ score: result.score, rainbows: result.rainbows, seconds: Math.max(60, result.playSeconds | 0), day: jstDay() });
    this.push()
      .then((ranks) => {
        if (!this.onRunStatus) return;
        if (!ranks) { this.onRunStatus('ランキングに おくれませんでした（あとで おくります）'); return; }
        if (ranks.hidden) { this.onRunStatus('あなたの名前は運営が確認中です'); return; }
        const parts = [];
        if (ranks.today) parts.push(`今日 ${ranks.today}位`);
        if (ranks.week) parts.push(`今週 ${ranks.week}位`);
        if (ranks.all) parts.push(`全期間 ${ranks.all}位`);
        this.onRunStatus(parts.length ? parts.join('・') : null);
      })
      .catch(() => {});
  }

  /** 取っておく: 同じ日の回はいちばん良い 1 つだけ */
  enqueue(run) {
    const i = this.pending.findIndex((p) => p.day === run.day);
    if (i >= 0) {
      const p = this.pending[i];
      if (run.score > p.score || (run.score === p.score && run.rainbows > p.rainbows)) this.pending[i] = run;
    } else {
      this.pending.push(run);
    }
    this.pending.sort((a, b) => (a.day < b.day ? -1 : 1));
    store.savePending(this.pending);
  }

  /** 送れていない回を古い順に送る。全部送れたら最後に返った順位を、送れなければ null */
  push() {
    if (this.pushing) return this.pushing.then(() => (this.pending.length ? this.push() : this.lastRanks));
    this.pushing = (async () => {
      let ranks = null;
      let reRegistered = false;
      while (this.pending.length && this.joined && !this.leaving) {
        const run = this.pending[0];
        try {
          const r = await this.call('POST', '/v1/submit', { uid: this.state.uid, ver: VER, ...run });
          ranks = { ...r.ranks, hidden: !!r.hidden };
          this.pending.shift();
        } catch (e) {
          if (e.status === 409 && !reRegistered) {
            // サーバーが知らない人: 覚えている名前で登録し直して、1 回だけ送り直す
            reRegistered = true;
            try { await this.call('POST', '/v1/register', { uid: this.state.uid, name: this.state.name, terms: TERMS_VERSION }); continue; } catch { return null; }
          }
          if (e.status === 0 || e.status === 429 || e.status >= 500) return null;  // あとで送り直す
          this.pending.shift();   // 400 など: 送り直しても同じ
        }
        store.savePending(this.pending);
      }
      this.lastRanks = ranks;
      return ranks;
    })().finally(() => { this.pushing = null; store.savePending(this.pending); });
    return this.pushing;
  }

  // ---- 画面 ----

  /** シートの中身を slot に組む（タブ・参加・一覧・名前を変える） */
  open(slot) {
    if (!slot) return;
    this.slot = slot;
    this.render();
  }

  render() {
    const s = this.slot;
    if (!s) return;
    s.innerHTML = '';
    const root = el('div', 'kr');
    root.append(el('div', 'kr-note', 'App Store 版と おなじ ランキングです'));
    const tabs = el('div', 'kr-tabs');
    for (const t of TABS) {
      const b = el('button', 'kr-tab' + (t.id === this.tab ? ' on' : ''), t.title);
      b.onclick = () => { this.tab = t.id; this.render(); };
      tabs.append(b);
    }
    root.append(tabs);
    const body = el('div', 'kr-body');
    root.append(body);
    s.append(root);
    if (this.tab === 'local') this.renderLocal(body);
    else if (!this.joined) this.renderJoin(body);
    else this.renderBoard(body, this.tab);
  }

  renderLocal(body) {
    const recs = store.loadRecords();
    if (!recs.length) { body.append(el('div', 'kr-empty', 'まだ記録がありません')); return; }
    const list = el('ol', 'kr-list');
    recs.forEach((r, i) => {
      const li = el('li', 'kr-row');
      li.innerHTML = `<span class="kr-rank">${i + 1}</span><span class="kr-name" data-fit="15" data-fit-min="0.75">${esc(r.cloud || '')}<small>${esc(new Date(r.date).toLocaleDateString('ja-JP'))}</small></span>`
        + `<span class="kr-score">${fmt(r.score)} 点<small>${r.rainbows ? `にじ雲 ${r.rainbows}こ・` : ''}${r.seconds ? fmtSeconds(r.seconds) : ''}</small></span>`;
      list.append(li);
    });
    body.append(list);
    fitAll(list);
  }

  renderJoin(body, renaming = false) {
    const box = el('div', 'kr-join');
    box.append(el('div', 'kr-lead', renaming ? '新しい名前' : 'ランキングに出る名前を決めてください'));
    if (!renaming) box.append(el('div', 'kr-small', '名前を決めると、今日・今週・全期間のランキングに点がのります。'));
    const input = el('input', 'kr-input');
    input.type = 'text';
    input.maxLength = 40;
    input.placeholder = 'なまえ';
    input.value = renaming ? this.state.name : '';
    input.autocomplete = 'off';
    const count = el('div', 'kr-count', `0 / ${NAME_MAX} 文字`);
    const upd = () => { count.textContent = `${graphemes(cleanName(input.value))} / ${NAME_MAX} 文字`; };
    input.oninput = upd;
    upd();
    box.append(input, count);
    const terms = el('div', 'kr-terms');
    terms.append(el('div', 'kr-terms-title', '利用規約'));
    const ul = el('ul');
    for (const t of TERMS) ul.append(el('li', null, t));
    terms.append(ul);
    box.append(terms);
    const agreeRow = el('label', 'kr-agree');
    const agree = el('input');
    agree.type = 'checkbox';
    agreeRow.append(agree, document.createTextNode(' 利用規約に同意する'));
    box.append(agreeRow);
    const msg = el('div', 'kr-error');
    const go = el('button', 'kr-btn', renaming ? 'この名前にする' : 'この名前で参加');
    go.onclick = async () => {
      if (!agree.checked) { msg.textContent = '利用規約に同意してください'; return; }
      go.disabled = true;
      go.textContent = renaming ? 'かえています…' : 'とうろく中…';
      const err = await this.join(input.value);
      if (err) {
        msg.textContent = err;
        go.disabled = false;
        go.textContent = renaming ? 'この名前にする' : 'この名前で参加';
        return;
      }
      this.render();
    };
    box.append(msg, go);
    if (renaming) {
      const back = el('button', 'kr-link', 'もどす');
      back.onclick = () => this.render();
      const leave = el('button', 'kr-danger', 'ランキングをやめて記録を消す');
      leave.onclick = async () => {
        if (!confirm('ランキングをやめて、名前と記録を消しますか？\n名前と、ランキングに送った記録をサーバーから消します。この端末の記録・くもずかんはそのままです。')) return;
        leave.disabled = true;
        leave.textContent = '消しています…';
        const err = await this.leave();
        if (err) { msg.textContent = err; leave.disabled = false; leave.textContent = 'ランキングをやめて記録を消す'; return; }
        this.render();
      };
      box.append(back, el('div', 'kr-small', '今日・今週・全期間のランキングから消えます。また参加するときは、名前を決め直します。'), leave);
      if (this.state.uid) box.append(el('div', 'kr-id', `ユーザーID（問い合わせのときに使います）: ${this.state.uid}`));
    }
    body.append(box);
  }

  async renderBoard(body, kind) {
    body.append(el('div', 'kr-empty', '読み込み中…'));
    try {
      await this.push().catch(() => {});
      const q = new URLSearchParams({ ver: VER, board: kind, uid: this.state.uid, limit: String(BOARD_SIZE) });
      const r = await this.call('GET', `/v1/board?${q}`);
      if (this.tab !== kind) return;
      body.innerHTML = '';
      const head = el('div', 'kr-head');
      head.append(el('span', null, `参加 ${fmt(r.total)} 人`));
      // el は textContent で入れるので esc しない（esc すると「&」が「&amp;」と見える）
      const me = el('button', 'kr-link', `${this.state.name}（名前を変える）`);
      me.onclick = () => { body.innerHTML = ''; this.renderJoin(body, true); };
      head.append(me);
      body.append(head);
      if (r.mine && r.mine.hidden) body.append(el('div', 'kr-small', 'あなたの名前は運営が確認中のため、ほかの人には表示されていません'));
      if (!r.top.length) {
        body.append(el('div', 'kr-empty', kind === 'today' ? '今日は まだ誰の記録もありません\nいちばん乗りの チャンス!' : 'まだ誰の記録もありません'));
      } else {
        const list = el('ol', 'kr-list');
        for (const e of r.top) {
          const mine = !!e.mine;   // サーバーが自分の行に付ける印
          const li = el('li', 'kr-row' + (mine ? ' mine' : ''));
          li.innerHTML = `<span class="kr-rank">${e.rank}</span><span class="kr-name" data-fit="15" data-fit-min="0.75">${esc(e.name)}${mine ? '<small>あなた</small>' : ''}</span>`
            + `<span class="kr-score">${fmt(e.score)} 点<small>${e.rainbows ? `にじ雲 ${e.rainbows}こ・` : ''}${e.seconds ? fmtSeconds(e.seconds) : ''}</small></span>`;
          if (!mine) li.onclick = () => this.rowMenu(li, e);
          list.append(li);
        }
        body.append(list);
        fitAll(list);
        body.append(el('div', 'kr-small', '名前を押すと、通報・表示しない ができます'));
      }
      if (!r.top.some((e) => e.mine)) {
        body.append(el('div', 'kr-mine', r.myRank ? `あなたは ${r.myRank} 位（${fmt(r.mine.score)} 点）` : 'あなたの記録はまだありません'));
      }
    } catch {
      if (this.tab !== kind) return;
      body.innerHTML = '';
      body.append(el('div', 'kr-empty', 'つながりませんでした'));
      const again = el('button', 'kr-btn', 'もう一度読む');
      again.onclick = () => this.render();
      body.append(again);
    }
  }

  /** 行のメニュー: 表示しない・通報する（通報は同時に表示しないにもなる。iOS と同じ） */
  rowMenu(li, e) {
    if (li.querySelector('.kr-menu')) { li.querySelector('.kr-menu').remove(); return; }
    const m = el('div', 'kr-menu');
    const hide = el('button', null, 'この人を表示しない');
    hide.onclick = async (ev) => {
      ev.stopPropagation();
      try { await this.call('POST', '/v1/block', { uid: this.state.uid, pid: e.pid }); toast(`「${e.name}」を表示しないにしました`); this.render(); } catch { toast('つながりませんでした'); }
    };
    m.append(hide);
    for (const [reason, label] of [['name', '通報する（名前）'], ['cheat', '通報する（ありえない点）'], ['other', '通報する（そのほか）']]) {
      const b = el('button', null, label);
      b.onclick = async (ev) => {
        ev.stopPropagation();
        try { await this.call('POST', '/v1/report', { uid: this.state.uid, pid: e.pid, reason }); toast('通報しました。ありがとうございます'); this.render(); } catch { toast('つながりませんでした'); }
      };
      m.append(b);
    }
    li.append(m);
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function toast(text) {
  const t = el('div', 'kr-toast', text);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 2200);
}

/** ランキングの画面の見た目（画面の担当の app.css の色に合わせる。Theme.swift の ink・pink・cream） */
function ensureStyle() {
  if (document.getElementById('kr-style')) return;
  const st = document.createElement('style');
  st.id = 'kr-style';
  st.textContent = `
.kr { font-family: 'KumoponRounded', system-ui, sans-serif; color: rgb(92 64 84); display: flex; flex-direction: column; gap: 10px; }
.kr-note, .kr-small { font-size: 12px; color: rgb(140 112 133); text-align: center; white-space: pre-line; }
.kr-tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.kr-tab { font: inherit; font-weight: 900; font-size: 15px; padding: 10px 0; border: 0; border-radius: 999px; background: rgb(255 245 232); color: rgb(140 112 133); min-height: 44px; }
.kr-tab.on { background: rgb(255 133 158); color: #fff; }
.kr-body { min-height: 200px; }
.kr-empty { text-align: center; padding: 28px 0; white-space: pre-line; color: rgb(140 112 133); }
.kr-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; margin-bottom: 6px; }
.kr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.kr-row { position: relative; display: grid; grid-template-columns: 36px 1fr auto; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 16px; background: rgb(255 255 255 / 0.85); }
.kr-row.mine { background: rgb(255 219 224); }
.kr-rank { font-weight: 900; font-size: 18px; text-align: center; }
.kr-name { font-size: 15px; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kr-name small, .kr-score small { display: block; font-size: 11px; font-weight: 700; color: rgb(140 112 133); }
.kr-score { font-weight: 900; text-align: right; }
.kr-menu { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; }
.kr-menu button, .kr-link { font: inherit; font-weight: 800; font-size: 13px; border: 0; border-radius: 999px; padding: 8px 12px; background: rgb(255 245 232); color: rgb(92 64 84); min-height: 36px; }
.kr-link { background: none; text-decoration: underline; padding: 6px 4px; }
.kr-join { display: flex; flex-direction: column; gap: 8px; }
.kr-lead { font-weight: 900; font-size: 18px; text-align: center; }
.kr-input { font: inherit; font-weight: 800; font-size: 20px; padding: 12px 16px; border-radius: 16px; border: 2px solid rgb(255 219 224); background: #fff; color: rgb(92 64 84); }
.kr-count { font-size: 12px; text-align: right; color: rgb(140 112 133); }
.kr-terms { font-size: 12px; background: rgb(255 255 255 / 0.7); border-radius: 14px; padding: 8px 12px; max-height: 30vh; overflow: auto; }
.kr-terms-title { font-weight: 900; margin-bottom: 4px; }
.kr-terms ul { margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: 4px; }
.kr-agree { font-weight: 800; display: flex; align-items: center; gap: 6px; min-height: 44px; }
.kr-agree input { width: 22px; height: 22px; }
.kr-error { color: rgb(235 97 128); font-weight: 800; font-size: 13px; min-height: 1em; text-align: center; }
.kr-btn { font: inherit; font-weight: 900; font-size: 18px; border: 0; border-radius: 999px; padding: 14px 20px; background: rgb(255 133 158); color: #fff; box-shadow: 0 5px 0 rgb(235 97 128); min-height: 48px; }
.kr-btn:disabled { opacity: 0.6; }
.kr-danger { font: inherit; font-weight: 800; font-size: 14px; border: 2px solid rgb(235 97 128); color: rgb(235 97 128); background: #fff; border-radius: 999px; padding: 10px 16px; min-height: 44px; }
.kr-mine { text-align: center; font-weight: 900; margin-top: 8px; }
.kr-id { font-size: 10px; color: rgb(140 112 133); word-break: break-all; user-select: text; -webkit-user-select: text; }
.kr-toast { position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translate(-50%, 20px); opacity: 0; background: rgb(92 64 84 / 0.92); color: #fff; font-family: 'KumoponRounded', system-ui, sans-serif; font-weight: 800; padding: 10px 18px; border-radius: 999px; z-index: 1000; transition: transform 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.35s ease-out; }
.kr-toast.show { transform: translate(-50%, 0); opacity: 1; }
`;
  document.head.append(st);
}
