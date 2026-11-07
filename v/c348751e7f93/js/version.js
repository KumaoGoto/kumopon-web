// ブラウザ版の版（人が読む番号）。上げるのはここだけで、上げたら Web/CHANGELOG.md に書く。
// iOS の版（project.yml の MARKETING_VERSION）とは別に数える（ゲームの中身〈決まり e6〉は同じ）。
// 組みの印（公開のフォルダ名 v/<印>/。sw.js の VERSION と同じ）は、このファイルの場所から読む（手で書かない）。

export const WEB_VERSION = '1.0.2';

/** 組みの印（公開の形なら v/<印>/ の印。手元の Web/site/ で動かしているときは 'dev'） */
export const BUILD = (import.meta.url.match(/\/v\/([0-9a-f]{12})\//) || [])[1] || 'dev';

/** 画面に出す形: 「1.0.0（a9004de4）」。手元では「1.0.0（手元）」 */
export const VERSION_LABEL = `${WEB_VERSION}（${BUILD === 'dev' ? '手元' : BUILD.slice(0, 8)}）`;
