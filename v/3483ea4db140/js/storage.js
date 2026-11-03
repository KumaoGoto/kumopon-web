// この端末のブラウザに残すもの（localStorage）: 設定・ベスト・この端末の記録（上位 10 件）・くもずかん・ランキングの登録。
// iOS の GameSettings・LocalRecords（App/Online/LocalRecords.swift）・CloudBook（App/Online/CloudBook.swift）と同じ中身と並び。
// ブラウザの保存は消えることがある（ブラウザのデータを消した・容量が足りない・シークレットのタブ）。読めなければ初めの値で動く。

const PREFIX = 'kumopon.';
/** 決まりの版（iOS の ModeKind.endlessRulesVersion と同じ。ベスト・記録の鍵を版で分ける） */
export const RULES_VERSION = 'e6';
const TIER_COUNT = 8;
const RECORD_LIMIT = 10;

function read(key, fallback) {
  try {
    const s = localStorage.getItem(PREFIX + key);
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** 設定（iOS の初めの値と同じ: 振動は つよい・びんは指と同じ向き） */
export const DEFAULT_SETTINGS = Object.freeze({
  spinReversed: false,
  shake: true,
  haptics: true,
  /** 振動のつよさ 0 よわい・1 ふつう・2 つよい（FeelTuning.defaultHapticStrength = strong） */
  strength: 2,
  sound: true,
  music: true,
});

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read('settings', {}) };
}

export function saveSettings(s) {
  write('settings', s);
}

export function loadBest() {
  return Number(read(`best.${RULES_VERSION}`, 0)) || 0;
}

export function saveBest(v) {
  write(`best.${RULES_VERSION}`, Math.max(0, Math.floor(v)));
}

// ---- この端末の記録（上位 10 件。並びは 点数 → にじ雲 → 先に出した方。オンラインの一覧と同じ）----

function sortRecords(list) {
  return list.slice().sort((a, b) => b.score - a.score || b.rainbows - a.rainbows || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function loadRecords() {
  const list = read(`records.${RULES_VERSION}`, []);
  return Array.isArray(list) ? sortRecords(list.filter((r) => r && Number.isFinite(r.score))) : [];
}

/** ランの結果を入れる。上位 10 件に入ったら、その記録（id つき）を返す。入らなければ null */
export function addRecord({ score, rainbows, maxTier, cloud, seconds }) {
  const r = {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random(),
    score, rainbows, maxTier, cloud, seconds,
    date: new Date().toISOString(),
  };
  const next = sortRecords([...loadRecords(), r]).slice(0, RECORD_LIMIT);
  if (!next.some((x) => x.id === r.id)) return null;
  write(`records.${RULES_VERSION}`, next);
  return r;
}

// ---- くもずかん（段ごとに育てた数と、はじめて出会った日）----

export function loadBook() {
  const saved = read(`book.v4.${TIER_COUNT}`, []);
  const entries = [];
  for (let t = 0; t < TIER_COUNT; t++) {
    const e = Array.isArray(saved) ? saved[t] : null;
    entries.push({ made: (e && Number(e.made)) || 0, first: (e && e.first) || null });
  }
  return entries;
}

/** ランの結果を入れる（CloudBook.add と同じ: 育った数を足し、その回のいちばん大きな雲までの段に「出会った」を付ける）。
 *  はじめて出会った段の並びを返す */
export function addToBook(madeByTier, maxTier) {
  const entries = loadBook();
  const fresh = [];
  const now = new Date().toISOString();
  for (let t = 0; t < TIER_COUNT; t++) {
    if (Array.isArray(madeByTier) && t < madeByTier.length) entries[t].made += Math.max(0, madeByTier[t] | 0);
    if (t <= maxTier && !entries[t].first) {
      entries[t].first = now;
      fresh.push(t);
    }
  }
  write(`book.v4.${TIER_COUNT}`, entries);
  return fresh;
}

// ---- ランキング（ブラウザ版だけの表）の登録 ----

/** ランキングの参加の様子: 名前を決めたか・名前・この端末の ID（uid。32 桁の 16 進の乱数。名前を決めたときに作る。サーバーの形と同じ）・
 *  サーバーが作った見せる ID（pid）。iOS の OnlineSync と同じく、uid は端末だけが知っている */
export function loadRanking() {
  return { joined: false, name: '', uid: '', pid: '', ...read('ranking', {}) };
}

export function newUid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 送れていない回（日ごとにいちばん良い回だけ） */
export function loadPending() {
  const list = read('ranking.pending', []);
  return Array.isArray(list) ? list : [];
}

export function savePending(list) {
  write('ranking.pending', list);
}

export function saveRanking(r) {
  write('ranking', r);
}

/** 保存できるか（シークレットのタブなどで書けないとき、画面に「記録が残らない」と出す） */
export function storageWorks() {
  try {
    const k = PREFIX + 'probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/**
 * この端末の保存（ベスト・記録・ずかん・設定・ランキングの ID と、手元に置いたゲームのファイル）を、ブラウザに「消されにくく」してもらう
 * （navigator.storage.persist。2026-11-03 依頼者「プレイヤーに影響がないなら」）。画面には何も出さない:
 * - Chrome・Edge・Android の Chrome・Safari は、聞く窓を出さずに、ブラウザが様子（よく開くか・ホーム画面に置いたか など）を見て決める
 * - Firefox は「保存を続けてよいか」を聞く窓を出すので頼まない（遊ぶ人に何も聞かない）
 * 断られても今までどおり動く（ふつうの保存のまま。容量が足りないときにブラウザが消すことがある）。
 * 何度頼んでもよい（よく遊ぶほど通りやすくなるので、main.js が読み込みのときとランの終わりに頼む）。返り値は残してもらえるか
 */
export async function requestPersistence() {
  try {
    const s = navigator.storage;
    if (!s || typeof s.persist !== 'function' || typeof s.persisted !== 'function') return false;
    if (await s.persisted()) return true;
    if (/\bFirefox\//.test(navigator.userAgent)) return false;
    return await s.persist();
  } catch {
    return false;
  }
}
