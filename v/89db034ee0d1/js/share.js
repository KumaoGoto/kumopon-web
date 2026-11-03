// 結果のシェア（2026-11-03 依頼者「リザルト画面で X などに共有」）。文は iOS の ResultView.shareText と同じで、
// 付ける URL はブラウザ版（iPhone で開いた人には App Store 版の帯が出る）。
// 端末のシェアの窓（Web Share。Android の Chrome・iPhone の Safari・Windows の Chrome など）があれば、それで X・LINE などを選んでもらう。
// 無いブラウザ（パソコンの Firefox など）では、X の投稿の画面を新しいタブで開く。こちらから何かを送ることはない（選んだアプリが送る）。

/** シェアに付ける URL（ブラウザ版） */
export const SHARE_URL = 'https://kumopon.kumao.app/';

/** シェアの文（字だけ。iOS と同じ）: 「くもぽん エンドレスで 123,450 点！（1:30） そだてた雲: にゅうどう雲 にじ雲×1 #くもぽん」と、次の行に URL。
 *  にじ雲 0 こは書かない。r は WebJSON.swift の result */
export function shareText(r) {
  const stat = (label) => (r.customStats || []).find((s) => s.label === label)?.value;
  const score = Number(r.score || 0).toLocaleString('ja-JP');
  const time = stat('あそんだ時間');
  let s = time ? `くもぽん エンドレスで ${score} 点！（${time}）` : `くもぽんで ${score} 点！`;
  const cloud = stat('そだてた雲');
  if (cloud) s += ` そだてた雲: ${cloud}`;
  if (r.rainbows > 0) s += ` にじ雲×${r.rainbows}`;
  return `${s} #くもぽん\n${SHARE_URL}`;
}

/** X の投稿の画面（シェアの窓が無いブラウザで使う） */
export function xPostURL(text) {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

/** シェアする（ボタンを押した中で呼ぶ。シェアの窓を閉じただけなら何もしない） */
export async function shareResult(r) {
  const text = shareText(r);
  const data = { text };
  if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
    try {
      await navigator.share(data);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // シェアの窓を閉じた
      // それ以外（このブラウザでは出せなかった）は X の画面へ
    }
  }
  window.open(xPostURL(text), '_blank', 'noopener,noreferrer');
}
