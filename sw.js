// ホーム画面に置ける形（PWA）のための手元の置き場（Service Worker）。初めて開いたときに遊ぶのに要るファイルを手元に置き、
// 次からは通信がなくても遊べる。BGM は大きいので、初めて鳴らしたときに置く。
// VERSION と PRECACHE は Web/build.sh（Web/tools/make_sw.py）が書く。中身が変わると VERSION が変わり、古い置き場を捨てて置き直す。
// 公開の形（Web/tools/stage.py）では、プログラムは版ごとの箱 v/<VERSION>/ に入り、PRECACHE もその場所に書き換わる。

const VERSION = '9355a30d5ada';
const PRECACHE = [
  './',
  'v/9355a30d5ada/app.css',
  'assets/audio.json',
  'assets/fonts/OFL.txt',
  'assets/fonts/kumopon-rounded-black.woff',
  'assets/fonts/kumopon-rounded-bold.woff',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/favicon-32.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/img/badge_1.png',
  'assets/img/badge_2.png',
  'assets/img/badge_3.png',
  'assets/img/cloud_1.png',
  'assets/img/cloud_2.png',
  'assets/img/cloud_3.png',
  'assets/img/cloud_4.png',
  'assets/img/cloud_5.png',
  'assets/img/cloud_6.png',
  'assets/img/cloud_7.png',
  'assets/img/cloud_8.png',
  'assets/img/crown.png',
  'assets/img/index.json',
  'assets/img/medal_1.png',
  'assets/img/medal_2.png',
  'assets/img/medal_3.png',
  'assets/img/niji_big.png',
  'assets/img/nyudo_big.png',
  'assets/img/play_bg.jpg',
  'assets/img/result_bg.jpg',
  'assets/img/title_bg.jpg',
  'assets/img/title_logo.png',
  'assets/img/trophy.png',
  'assets/sounds/boing.wav',
  'assets/sounds/chime.wav',
  'assets/sounds/clatter.wav',
  'assets/sounds/clink.wav',
  'assets/sounds/creak_loop.wav',
  'assets/sounds/dim.wav',
  'assets/sounds/drip.wav',
  'assets/sounds/heartbeat.wav',
  'assets/sounds/hiss.wav',
  'assets/sounds/hum_loop.wav',
  'assets/sounds/merge_body.wav',
  'assets/sounds/merge_body_2.wav',
  'assets/sounds/merge_body_3.wav',
  'assets/sounds/merge_body_4.wav',
  'assets/sounds/pad.wav',
  'assets/sounds/plop.wav',
  'assets/sounds/pon.wav',
  'assets/sounds/pop.wav',
  'assets/sounds/rumble_loop.wav',
  'assets/sounds/sparkle.wav',
  'assets/sounds/sparkle_2.wav',
  'assets/sounds/sparkle_3.wav',
  'assets/sounds/spawn.wav',
  'assets/sounds/squeeze_loop.wav',
  'assets/sounds/squelch.wav',
  'assets/sounds/squelch_2.wav',
  'assets/sounds/squelch_3.wav',
  'assets/sounds/squelch_4.wav',
  'assets/sounds/squirt.wav',
  'assets/sounds/thunder.wav',
  'assets/sounds/tick.wav',
  'assets/sounds/wake.wav',
  'assets/sounds/whoosh.wav',
  'index.html',
  'v/9355a30d5ada/js/audio.js',
  'v/9355a30d5ada/js/engine.js',
  'v/9355a30d5ada/js/feel.js',
  'v/9355a30d5ada/js/haptics.js',
  'v/9355a30d5ada/js/main.js',
  'v/9355a30d5ada/js/ranking.js',
  'v/9355a30d5ada/js/render/color.js',
  'v/9355a30d5ada/js/render/ear_clipper.js',
  'v/9355a30d5ada/js/render/renderer.js',
  'v/9355a30d5ada/js/render/scene_reader.js',
  'v/9355a30d5ada/js/render/shaders.js',
  'v/9355a30d5ada/js/render/text_cache.js',
  'v/9355a30d5ada/js/render/warmup.js',
  'v/9355a30d5ada/js/share.js',
  'v/9355a30d5ada/js/storage.js',
  'v/9355a30d5ada/js/ui/hud.js',
  'v/9355a30d5ada/js/ui/parts.js',
  'v/9355a30d5ada/js/ui/sheets.js',
  'v/9355a30d5ada/js/ui/ui.js',
  'v/9355a30d5ada/js/ui/wipe.js',
  'v/9355a30d5ada/js/version.js',
  'v/9355a30d5ada/kumopon.wasm',
  'manifest.webmanifest',
];
// @@PRECACHE_END

const CACHE = `kumopon-${VERSION}`;

self.addEventListener('install', (e) => {
  // 置き場には、ブラウザの HTTP の置き場（GitHub Pages は 10 分置かせる）を通さず、いまサイトにある物を取りに行って置く
  // （通すと、新しい版の名前の置き場に古いファイルを入れてしまい、次の版まで新旧が混ざって動く）
  const fresh = PRECACHE.map((u) => new Request(u, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('kumopon-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** ゲームのページ（置き場の頭か index.html）を開く要求か。ほかのページ（vibe_test.html・bench.html）はそのページのまま返す */
function isGamePage(req, url) {
  if (req.mode !== 'navigate') return false;
  const scope = new URL(self.registration.scope).pathname;
  return url.pathname === scope || url.pathname === `${scope}index.html`;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // ランキング（別の場所の API）と POST は手元に置かない
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const game = isGamePage(req, url);
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ゲームのページは手元の index.html を先に（通信がなくても開ける。?ranking=local などの後ろは見ない）
    const hit = await cache.match(game ? 'index.html' : req, { ignoreSearch: game });
    if (hit) return hit;
    const res = await fetch(req);
    // BGM・確かめのページなど、初めて読んだものも置いておく（次は通信なしで使える）。置き終わるまで Service Worker を止めさせない
    if (res.ok && res.type === 'basic') e.waitUntil(cache.put(req, res.clone()));
    return res;
  })());
});
