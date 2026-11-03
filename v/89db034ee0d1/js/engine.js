// くもぽんの心臓（物理と決まり。Swift を WebAssembly にしたもの kumopon.wasm）を読み込んで包む。
// WebAssembly は WASI（Swift の標準ライブラリが使う OS の呼び出し）を少しだけ使うので、ここに小さな代わりを置く
// （ファイルは無い・時計と乱数とコンソールへの出力だけ）。入口の関数は Web/Engine/Sources/KumoponWeb/WebExports.swift。

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_NOSYS = 52;

/** WASI preview1 のうち、くもぽんが呼ぶものの代わり */
function makeWasi(getMemory) {
  const dec = new TextDecoder();
  const lines = { 1: '', 2: '' };
  const view = () => new DataView(getMemory().buffer);
  const nosys = () => ERRNO_NOSYS;
  const badf = () => ERRNO_BADF;
  return {
    args_sizes_get(argc, bufSize) { const v = view(); v.setUint32(argc, 0, true); v.setUint32(bufSize, 0, true); return ERRNO_SUCCESS; },
    args_get() { return ERRNO_SUCCESS; },
    environ_sizes_get(count, bufSize) { const v = view(); v.setUint32(count, 0, true); v.setUint32(bufSize, 0, true); return ERRNO_SUCCESS; },
    environ_get() { return ERRNO_SUCCESS; },
    clock_res_get(id, out) { view().setBigUint64(out, 1000n, true); return ERRNO_SUCCESS; },
    clock_time_get(id, precision, out) {
      // 0 = 実時間（1970 からの ns）、ほか = 単調な時計
      const ns = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6));
      view().setBigUint64(out, ns, true);
      return ERRNO_SUCCESS;
    },
    fd_write(fd, iovs, iovsLen, nwritten) {
      const v = view();
      const mem = new Uint8Array(getMemory().buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const p = v.getUint32(iovs + i * 8, true);
        const n = v.getUint32(iovs + i * 8 + 4, true);
        if (fd === 1 || fd === 2) {
          lines[fd] += dec.decode(mem.subarray(p, p + n));
          let k;
          while ((k = lines[fd].indexOf('\n')) >= 0) {
            (fd === 2 ? console.warn : console.log)('[kumopon]', lines[fd].slice(0, k));
            lines[fd] = lines[fd].slice(k + 1);
          }
        }
        total += n;
      }
      v.setUint32(nwritten, total, true);
      return fd === 1 || fd === 2 ? ERRNO_SUCCESS : ERRNO_BADF;
    },
    fd_read: badf, fd_close: badf, fd_seek: badf, fd_sync: badf, fd_pread: badf, fd_readdir: badf,
    fd_fdstat_get(fd, out) {
      if (fd > 2) return ERRNO_BADF;
      const v = view();
      v.setUint8(out, 2);   // 文字の装置
      v.setUint16(out + 2, 0, true);
      v.setBigUint64(out + 8, 0n, true);
      v.setBigUint64(out + 16, 0n, true);
      return ERRNO_SUCCESS;
    },
    fd_fdstat_set_flags: badf, fd_filestat_get: badf, fd_filestat_set_times: badf,
    // 開いておくフォルダは無い（BADF で「もう無い」を知らせる）
    fd_prestat_get: badf, fd_prestat_dir_name: badf,
    path_create_directory: nosys, path_filestat_get: nosys, path_filestat_set_times: nosys, path_link: nosys,
    path_open: nosys, path_readlink: nosys, path_remove_directory: nosys, path_rename: nosys, path_symlink: nosys,
    path_unlink_file: nosys, poll_oneoff: nosys,
    proc_exit(code) { throw new Error(`kumopon.wasm が終わった（${code}）`); },
    random_get(p, n) { crypto.getRandomValues(new Uint8Array(getMemory().buffer, p, n)); return ERRNO_SUCCESS; },
  };
}

/** 0 で区切った UTF-8 の並びを文字列の配列に */
function splitStrings(bytes) {
  const out = [];
  const dec = new TextDecoder();
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) { out.push(dec.decode(bytes.subarray(start, i))); start = i + 1; }
  }
  return out;
}

export class Engine {
  /** kumopon.wasm を読み込む。場所の既定は、このファイル（js/engine.js）の隣の箱の kumopon.wasm
   *  （手元の site/ でも、公開の形〈版ごとの箱 v/<版>/。tools/stage.py〉でも、同じ版の wasm を読む） */
  static async load(url = new URL('../kumopon.wasm', import.meta.url)) {
    let memory = null;
    const imports = { wasi_snapshot_preview1: makeWasi(() => memory) };
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} を読めない（${res.status}）`);
    let instance;
    if (WebAssembly.instantiateStreaming && (res.headers.get('content-type') || '').includes('application/wasm')) {
      ({ instance } = await WebAssembly.instantiateStreaming(res, imports));
    } else {
      ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), imports));
    }
    memory = instance.exports.memory;
    instance.exports._initialize();
    instance.exports.kp_init();
    return new Engine(instance);
  }

  constructor(instance) {
    this.x = instance.exports;
    this.dec = new TextDecoder();
    this.hudSerial = -1;
    this.soundNames = splitStrings(this.bytes(this.x.kp_sound_names_ptr(), this.x.kp_sound_names_len()));
    this.musicNames = splitStrings(this.bytes(this.x.kp_music_names_ptr(), this.x.kp_music_names_len()));
  }

  get memory() { return this.x.memory.buffer; }
  bytes(ptr, len) { return new Uint8Array(this.memory, ptr, len); }
  floats(ptr, len) { return new Float32Array(this.memory, ptr, len); }

  settings({ spinReversed, shake, haptics, strength, sound }) {
    this.x.kp_settings(spinReversed ? 1 : 0, shake ? 1 : 0, haptics ? 1 : 0, strength, sound ? 1 : 0);
  }
  setBest(best) { this.x.kp_set_best(best); }

  /** エンドレスを始める（種は 64 ビットの乱数） */
  start() {
    const r = new Uint32Array(2);
    crypto.getRandomValues(r);
    this.x.kp_start(r[0] | 0, r[1] | 0);
  }
  /** 描画の確かめ用の自動プレイ */
  demo(seed, bot = 0) { this.x.kp_demo_start(seed | 0, bot); }

  /** 1 フレーム進める。{ screen: 0 タイトル・1 遊ぶ・2 結果, paused } */
  frame(dt, now) {
    const r = this.x.kp_frame(dt, now);
    return { screen: r & 15, paused: (r & 16) !== 0 };
  }

  touch(phase, id, x, y, time) { this.x.kp_touch(phase, id, x, y, time); }
  pause() { return this.x.kp_pause() !== 0; }
  resume() { this.x.kp_resume(); }
  menu() { this.x.kp_menu(); }
  suspendFeel() { this.x.kp_suspend_feel(); }
  /** 画面のボタンの手応え（小さな音と短い振動。iOS の uiTap と同じ組み立てで、次のフレームで鳴る） */
  uiTap() { this.x.kp_ui_tap(); }

  /** 振動の写し方の数（Swift の FeelTuning.Web。haptics.js に渡す。数は Swift の 1 か所だけに書く） */
  vibeTuning() {
    return JSON.parse(this.dec.decode(this.bytes(this.x.kp_vibe_tuning_ptr(), this.x.kp_vibe_tuning_len())));
  }
  /** 強さ 0〜1 に今の「振動のつよさ」を通した値（HapticPatterns.level） */
  hapticLevel(i) { return this.x.kp_haptic_level(i); }
  /** エンドレスのいちばん上の段（0 始まり。にじ雲） */
  tierTop() { return this.x.kp_tier_top(); }
  /** その段の合体の強さの倍率（ゲームが合体の触覚に掛ける JarModeV4.Tuning.bandLevel） */
  mergeLevel(tier) { return this.x.kp_merge_level(tier); }

  /** このフレームの場面（Float32Array と文字の表）。次の frame を呼ぶまで有効 */
  scene() {
    // 文字の表は前のフレームとたいてい同じ（擬音・点・案内の字）。同じバイトなら前の配列を使い回す（毎フレームの小さなゴミを出さない）
    const b = this.bytes(this.x.kp_strings_ptr(), this.x.kp_strings_len());
    const last = this.lastStringBytes;
    let same = last && last.length === b.length;
    for (let i = 0; same && i < b.length; i++) same = last[i] === b[i];
    if (!same) {
      this.lastStringBytes = b.slice();
      this.lastStrings = splitStrings(b);
    }
    return { f: this.floats(this.x.kp_scene_ptr(), this.x.kp_scene_len()), strings: this.lastStrings };
  }
  /** このフレームの音と振動の命令（Float32Array）。次の frame を呼ぶまで有効 */
  feel() { return this.floats(this.x.kp_feel_ptr(), this.x.kp_feel_len()); }

  /** 上の表示が変わっていれば、その JSON（オブジェクト）。変わっていなければ null */
  hudIfChanged() {
    const s = this.x.kp_hud_serial();
    if (s === this.hudSerial) return null;
    this.hudSerial = s;
    // タイトルの間（まだランを始めていない）は JSON が空
    const n = this.x.kp_hud_len();
    return n > 0 ? JSON.parse(this.dec.decode(this.bytes(this.x.kp_hud_ptr(), n))) : null;
  }
  /** 結果（結果の画面になったら。無ければ null） */
  result() {
    const n = this.x.kp_result_len();
    return n > 0 ? JSON.parse(this.dec.decode(this.bytes(this.x.kp_result_ptr(), n))) : null;
  }
}
