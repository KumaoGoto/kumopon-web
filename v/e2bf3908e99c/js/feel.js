// ゲームが 1 フレームごとに出す「音と振動の命令」（Web/Engine/Sources/KumoponWeb/WebFeel.swift の先頭の並び）を読んで、
// 音（audio.js の AudioEngine）と振動（haptics.js の Haptics）に渡す。音と振動は同じフレームで鳴らす（iOS と同じ決まり）。

export class FeelDispatch {
  /** engine: engine.js の Engine（音と曲の名前の表を持つ）、audio: AudioEngine か null、haptics: Haptics */
  constructor(engine, audio, haptics) {
    this.soundNames = engine.soundNames;
    this.musicNames = engine.musicNames;
    this.audio = audio;
    this.haptics = haptics;
    /** 確かめ用の数（このページを開いてから） */
    this.counts = { sound: 0, vibe: 0, loop: 0, music: 0, cont: 0 };
  }

  /** このフレームの命令（Float32Array）を全部鳴らす */
  run(c, now = performance.now()) {
    const a = this.audio;
    for (let i = 0; i < c.length;) {
      switch (c[i]) {
        case 1: // 音 [1, 音の番号, 高さ, 音量, パン, 遅れ]
          if (a) a.play(this.soundNames[c[i + 1]], c[i + 2], c[i + 3], c[i + 4], c[i + 5]);
          this.counts.sound++;
          i += 6;
          break;
        case 2: { // 振動 [2, k, 長さ…]
          const k = c[i + 1];
          this.haptics.play(Array.from(c.subarray(i + 2, i + 2 + k)), now);
          this.counts.vibe++;
          i += 2 + k;
          break;
        }
        case 3: // ループ始め [3, チャンネル, 音の番号, 高さ]
          if (a) a.loopBegin(c[i + 1], this.soundNames[c[i + 2]], c[i + 3]);
          this.counts.loop++;
          i += 4;
          break;
        case 4: // ループ値 [4, チャンネル, 高さ, 音量]
          if (a) a.loopSet(c[i + 1], c[i + 2], c[i + 3]);
          i += 4;
          break;
        case 5: // ループ終わり [5, チャンネル]
          if (a) a.loopEnd(c[i + 1]);
          i += 2;
          break;
        case 6: { // BGM [6, 曲の番号 or -1, フェード]
          const k = c[i + 1];
          if (a) a.music(k >= 0 ? this.musicNames[k] : null, c[i + 2]);
          this.counts.music++;
          i += 3;
          break;
        }
        case 7: // BGM を下げる [7, 倍率, 秒]
          if (a) a.duck(c[i + 1], c[i + 2]);
          i += 3;
          break;
        case 8: // BGM を小さく [8, 0/1]
          if (a) a.quiet(c[i + 1] !== 0);
          i += 2;
          break;
        case 9: // 続く振動 [9, チャンネル, 強さ]
          this.haptics.continuous(c[i + 1], c[i + 2], now);
          this.counts.cont++;
          i += 3;
          break;
        default:
          // 知らない命令（wasm と JavaScript の版がずれた）。このフレームの残りは読めないので捨てる
          console.warn('[feel] 知らない命令', c[i], 'の位置', i);
          return;
      }
    }
  }
}
