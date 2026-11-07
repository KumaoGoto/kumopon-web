// くもぽんの描画のシェーダー（GLSL ES 3.00 / WebGL2）。iOS の App/Render/Shaders.metal を写したもの。
// 定数・式・名前は Metal のものをそのまま使う。見た目を変えるときは Shaders.metal と一緒に直す（片方だけ変えない）。
//
// 座標は論理キャンバス（u、y は下向き）。色はリニアで計算し、乗算済みアルファで出す。
// アルファチャンネルは「影の溜め場」に使う（普段は 1。影を描くと 1-濃さ になり、resolve で色に混ぜて 1 に戻す）。
//
// Metal との違い（WebGL2 に無いものの代わり）:
// - device バッファの読み出し（vertex pulling）の代わりに、RGBA32F のテクスチャを texelFetch で読む
//   （粒 = 1 テクセル〈pos.xy, uv.xy〉、ブロブ 1 つ = 13 テクセル〈BlobInstance の並びそのまま〉。幅 1024 で折り返す）
// - baseInstance と vertexStart は無いので、uBaseInstance・uFirstVertex を gl_InstanceID・gl_VertexID に足す
// - カプセル・波紋・火花は、インスタンスごとの頂点属性（divisor 1）で受け、フラグメントには flat の varying で渡す
// - 文字は 1 つずつ uniform で渡す（Metal の setVertexBytes と同じ）
// - Uniforms と RainbowTable は std140 の uniform block（並びは Metal の struct とバイト単位で同じ）

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define saturate(x) clamp((x), 0.0, 1.0)

// RenderGPUTypes.swift の FrameUniforms と同じ並び（std140 でも 144 バイトで、ずれない）
layout(std140) uniform Frame {
    vec2 worldX; vec2 worldY; vec2 worldT;
    vec2 fitScale; vec2 fitOffset;
    vec2 worldDown;
    vec2 viewSizePx;
    vec2 canvasSize;
    float zoom; float pxPerUnit; float time; float dotIntensity;
    vec2 dotDrift; vec2 bgImage;   // bgImage: x 絵を敷く(1)・y 2 枚目へ移る割合
    vec4 bgTop; vec4 bgBottom; vec4 shadowColor;
} u;

// ===== 見た目の定数（u） =====

const float kFanIn = 0.6;          // 体の扇は輪郭（inflate）より少し内側まで。縁の帯の下に隠れる
const float kRimIn = 2.0;          // 縁の帯: inflate-2.0 〜 inflate+0.4（幅 2.4u）
const float kRimOut = 0.4;
const float kShadowSpread = 3.4;   // 影のぼかし幅
const vec2 kShadowShift = vec2(2.0, 4.0);
const float kShadowStrength = 0.24;

// ===== 共通 =====

vec2 toScreen(vec2 p) { return u.worldX * p.x + u.worldY * p.y + u.worldT; }
vec4 toClip(vec2 q) { return vec4(q * u.fitScale + u.fitOffset, 0.0, 1.0); }
float fillAA(float d, float px) { return saturate(0.5 - d / max(px, 1e-6)); }
vec2 rot2(vec2 p, float c, float s) { return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
vec3 lin(vec3 c) { return pow((c + 0.055) / 1.055, vec3(2.4)); }

// 楕円のおおよその符号付き距離（iq の近似）
float sdEllipse(vec2 p, vec2 r) {
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / max(k1, 1e-6);
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = saturate(dot(pa, ba) / max(dot(ba, ba), 1e-8));
    return length(pa - ba * h);
}

// 下が太く上が細いカプセル（y 上向き。下の円の中心が原点、上の円は (0,h)）
float sdUnevenCapsule(vec2 p, float r1, float r2, float h) {
    p.x = abs(p.x);
    float b = (r1 - r2) / h;
    float a = sqrt(1.0 - b * b);
    float k = dot(p, vec2(-b, a));
    if (k < 0.0) return length(p) - r1;
    if (k > a * h) return length(p - vec2(0.0, h)) - r2;
    return dot(p, vec2(a, b)) - r1;
}

// 五芒星（y 上向き）
float sdStar5(vec2 p, float r, float rf) {
    const vec2 k1 = vec2(0.809016994375, -0.587785252292);
    const vec2 k2 = vec2(-k1.x, k1.y);
    p.x = abs(p.x);
    p -= 2.0 * max(dot(k1, p), 0.0) * k1;
    p -= 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= r;
    vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
    float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

// ハート（y 上向き。下の先が原点、上端はおよそ 1.1）
float sdHeart(vec2 p) {
    p.x = abs(p.x);
    if (p.y + p.x > 1.0) return length(p - vec2(0.25, 0.75)) - 0.35355339;
    vec2 q1 = p - vec2(0.0, 1.0);
    vec2 q2 = p - 0.5 * max(p.x + p.y, 0.0);
    return sqrt(min(dot(q1, q1), dot(q2, q2))) * sign(p.x - p.y);
}
`;

// ===== 全画面（背景・影の resolve・閃光・画面への書き出し） =====

export const fullscreenVS = HEADER + `
out vec2 vClip;
void main() {
    int vid = gl_VertexID;
    vec2 p = vec2(float((vid << 1) & 2), float(vid & 2)) * 2.0 - 1.0;
    gl_Position = vec4(p, 0.0, 1.0);
    vClip = p;
}
`;

export const backgroundFS = HEADER + `
in vec2 vClip;
out vec4 fragColor;
uniform sampler2D imageA;
uniform sampler2D imageB;

// 背景の絵を画面いっぱいに縦横の比を保って敷くときの uv（はみ出しは左右か上下を同じだけ切る）
vec2 fillUV(vec2 px, vec2 view, sampler2D t) {
    vec2 ts = vec2(max(textureSize(t, 0), ivec2(1)));
    float s = max(view.x / ts.x, view.y / ts.y);
    return (px - view * 0.5) / (s * ts) + 0.5;
}

void main() {
    vec2 q = (vClip - u.fitOffset) / u.fitScale;   // 画面に固定したキャンバス座標（余白にも続く）
    float fy = saturate(0.5 - vClip.y * 0.5);       // 画面の上 0 → 下 1
    vec3 c = mix(u.bgTop.rgb, u.bgBottom.rgb, smoothstep(0.0, 1.0, fy));
    if (u.bgImage.x > 0.5) {
        // 背景の絵（sRGB のテクスチャなので、読むとリニアの色）。2 枚目へは bgImage.y の割合で移る
        vec2 px = vec2(vClip.x * 0.5 + 0.5, 0.5 - vClip.y * 0.5) * u.viewSizePx;
        vec3 a = texture(imageA, fillUV(px, u.viewSizePx, imageA)).rgb;
        vec3 b = texture(imageB, fillUV(px, u.viewSizePx, imageB)).rgb;
        c = mix(a, b, saturate(u.bgImage.y));
    }
    // 上の方にやわらかい光だまり
    vec2 lp = (q - vec2(u.canvasSize.x * 0.5, u.canvasSize.y * 0.12)) / u.canvasSize.x;
    c += (1.0 - c) * 0.22 * exp(-dot(lp, lp) * 3.0);
    // ゆっくり流れる水玉（1行ごとに半分ずらす）
    vec2 p = q - u.dotDrift * u.time;
    const float spacing = 34.0;
    vec2 cell = p / spacing;
    float row = floor(cell.y);
    cell.x += 0.5 * (row - 2.0 * floor(row * 0.5));
    vec2 f = fract(cell) - 0.5;
    float d = length(f) * spacing - 6.0;
    float w = fwidth(d);
    float dotA = saturate(0.5 - d / max(w, 1e-4)) * saturate(u.dotIntensity * 7.0);
    c = mix(c, c * vec3(0.90, 0.84, 0.86) + vec3(0.0, 0.0, 0.01), dotA);
    fragColor = vec4(c, 1.0);
}
`;

// 溜めた影（アルファ = 1-濃さ）を影の色で混ぜ、アルファを 1 に戻す
export const shadowResolveFS = HEADER + `
in vec2 vClip;
out vec4 fragColor;
void main() { fragColor = vec4(u.shadowColor.rgb, 1.0); }
`;

export const flashFS = HEADER + `
in vec2 vClip;
out vec4 fragColor;
uniform float uFlash;
void main() { fragColor = vec4(uFlash); }
`;

// 画面への書き出し（iOS には無い段）。iOS は sRGB の描画先（bgra8Unorm_srgb）にリニアで混ぜ、ハードが sRGB に戻して画面に出す。
// WebGL2 の画面（既定のフレームバッファ）は sRGB の書き込みをしないので、SRGB8_ALPHA8 の裏の絵に描いて（読むとリニア）、
// ここで sRGB の式で戻してから画面へ書く。1 画素ずつ写すだけ（拡大は CSS に任せる）
export const presentFS = HEADER + `
in vec2 vClip;
out vec4 fragColor;
uniform sampler2D uScene;
vec3 toSrgb(vec3 c) {
    c = saturate(c);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
    vec3 c = texelFetch(uScene, ivec2(gl_FragCoord.xy), 0).rgb;
    fragColor = vec4(toSrgb(c), 1.0);
}
`;

// ===== 多角形 =====

export const polyVS = HEADER + `
in vec2 aPos;
in vec4 aColor;   // 乗算済みアルファのリニア色
out vec4 vColor;
void main() {
    gl_Position = toClip(toScreen(aPos));
    vColor = aColor;
}
`;

export const polyFS = HEADER + `
in vec4 vColor;
out vec4 fragColor;
void main() { fragColor = vColor; }
`;

// ===== ブロブ =====
// 頂点はシェーダーが粒から作る（vertex pulling）。インスタンス1つ = ブロブ1つ。
// 体と縁: [扇 3*stride][縁の帯 6*stride]。影: [扇 3*stride][ぼかしの帯 6*stride]。
// stride はそのバッチの最大の分割点数（粒の数×3）。自分の点数を超える三角形は面積0にして捨てる。

const BLOB_DATA = `
// 粒（1 テクセル = pos.xy, uv.xy）とブロブ（13 テクセル = BlobInstance の並び）。幅 1024 で折り返す
uniform sampler2D uBlobs;
vec4 blobTexel(int i) { return texelFetch(uBlobs, ivec2(i & 1023, i >> 10), 0); }

struct BlobInstance {
    vec4 body, rim, highlight, cheek, eye;
    vec2 center, centerUV, uvRot, look;
    vec4 uvM;     // folded のときだけ: uv = uvM.xy * dx + uvM.zw * dy + centerUV
    int pointStart, pointCount;
    float inflate, restRadius, eyeOpen, squint, faceScale, mouth, sweat, glow, alpha, orient, faceVisible, shadow, folded, rainbow;
    vec2 rainbowDir;   // 7色が灯り始める向き（画面の向き。長さ 0 なら上から弧に沿って）
    float mood, rimScale;  // 気分（−1〜1）と縁の帯の太さの倍率
};

BlobInstance loadBlob(int i) {
    int k = i * 13;
    BlobInstance b;
    b.body = blobTexel(k);
    b.rim = blobTexel(k + 1);
    b.highlight = blobTexel(k + 2);
    b.cheek = blobTexel(k + 3);
    b.eye = blobTexel(k + 4);
    vec4 t5 = blobTexel(k + 5), t6 = blobTexel(k + 6);
    b.center = t5.xy; b.centerUV = t5.zw; b.uvRot = t6.xy; b.look = t6.zw;
    b.uvM = blobTexel(k + 7);
    vec4 t8 = blobTexel(k + 8), t9 = blobTexel(k + 9), t10 = blobTexel(k + 10), t11 = blobTexel(k + 11), t12 = blobTexel(k + 12);
    b.pointStart = int(t8.x + 0.5); b.pointCount = int(t8.y + 0.5); b.inflate = t8.z; b.restRadius = t8.w;
    b.eyeOpen = t9.x; b.squint = t9.y; b.faceScale = t9.z; b.mouth = t9.w;
    b.sweat = t10.x; b.glow = t10.y; b.alpha = t10.z; b.orient = t10.w;
    b.faceVisible = t11.x; b.shadow = t11.y; b.folded = t11.z; b.rainbow = t11.w;
    b.rainbowDir = t12.xy; b.mood = t12.z; b.rimScale = t12.w;
    return b;
}
`;

const BLOB_VERTEX = HEADER + BLOB_DATA + `
uniform sampler2D uPoints;
uniform int uFirstVertex;    // Metal の vertexStart の代わり
uniform int uBaseInstance;   // Metal の baseInstance の代わり

out vec2 vUV;      // restUV（uvRotation で回したもの）
out vec2 vRel;     // 重心からのずれ / restRadius（画面の向き。y が画面の下）
out float vT;      // 扇: 中心 0 → 縁 1。帯: 内側 0 → 外側 1
flat out int vInst;
flat out int vLayer;  // 0 = 扇、1 = 帯

// Catmull-Rom（一様）の t = 0, 1/3, 2/3 の重み
const vec4 kCRW[3] = vec4[3](
    vec4(0.0, 1.0, 0.0, 0.0),
    vec4(-2.0 / 27.0, 7.0 / 9.0, 1.0 / 3.0, -1.0 / 27.0),
    vec4(-1.0 / 27.0, 1.0 / 3.0, 7.0 / 9.0, -2.0 / 27.0)
);

struct RingPt { vec2 pos; vec2 uv; vec2 n; float oMax; };

vec4 pointTexel(int i) { return texelFetch(uPoints, ivec2(i & 1023, i >> 10), 0); }

// 粒 k の外向きの法線（前後の粒の差）。粒が重なって差が 0 なら1つ外の粒、それでも決まらなければ中心から外向き。
// 粒ごとに決まる値なので、隣の区間から見ても同じ向きになる（スプラインの微分は重なった粒で裏返るので使わない）
vec2 vertexNormal(vec2 a2, vec2 a1, vec2 p, vec2 b1, vec2 b2, vec2 center, float orient) {
    vec2 tg = b1 - a1;
    if (dot(tg, tg) < 1e-8) tg = b2 - a2;
    if (dot(tg, tg) < 1e-8) {
        vec2 aw = p - center;
        return aw / max(length(aw), 1e-5);
    }
    return vec2(tg.y, -tg.x) * (orient * inversesqrt(dot(tg, tg)));
}

// 凹んだ区間で外へずらしすぎると輪郭が折り返す（燕尾）。折り返さないずらしの上限（凸なら無制限）
float concaveLimit(vec2 pa, vec2 pb, vec2 na, vec2 nb, float orient) {
    float cr = (na.x * nb.y - na.y * nb.x) * orient;
    if (cr >= 0.0) return 1e9;
    return 0.9 * length(pb - pa) / max(length(nb - na), 1e-6);
}

// 分割点 j（粒 i の t = (j%3)/3）の位置・uv・外向きの法線・ずらしの上限
RingPt ringPoint(BlobInstance b, int j) {
    int n = b.pointCount;
    int i = j / 3;
    int s = j - i * 3;
    i = i % n;
    int base = b.pointStart;
    // 粒 i-3 〜 i+3
    vec2 q[7];
    vec2 uv[4];
    for (int k = 0; k < 7; k++) {
        vec4 bp = pointTexel(base + (i + 3 * n + k - 3) % n);
        q[k] = bp.xy;
        if (k >= 2 && k <= 5) uv[k - 2] = bp.zw;
    }
    vec4 w = kCRW[s];
    RingPt r;
    r.pos = q[2] * w.x + q[3] * w.y + q[4] * w.z + q[5] * w.w;
    r.uv = uv[0] * w.x + uv[1] * w.y + uv[2] * w.z + uv[3] * w.w;
    float o = b.orient;
    vec2 nPrev = vertexNormal(q[0], q[1], q[2], q[3], q[4], b.center, o);
    vec2 nCur = vertexNormal(q[1], q[2], q[3], q[4], q[5], b.center, o);
    vec2 nNext = vertexNormal(q[2], q[3], q[4], q[5], q[6], b.center, o);
    vec2 nm = mix(nCur, nNext, float(s) / 3.0);
    float l = length(nm);
    r.n = l > 1e-4 ? nm / l : nCur;
    float lim = concaveLimit(q[3], q[4], nCur, nNext, o);
    if (s == 0) lim = min(lim, concaveLimit(q[2], q[3], nPrev, nCur, o));
    r.oMax = lim;
    return r;
}

// 外向きのずらし（凹んだ所では折り返さない所まで）
vec2 offsetPoint(RingPt r, float off) { return r.pos + r.n * min(off, r.oMax); }

void degenerateBlob(int iid) {
    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
    vUV = vec2(0.0); vRel = vec2(0.0); vT = 0.0;
    vInst = iid; vLayer = 0;
}

void finishBlob(BlobInstance b, vec2 pos, vec2 uv, float t, int iid, int layer, vec2 screenShift) {
    gl_Position = toClip(toScreen(pos) + screenShift);
    // 裏返る輪は扇の三角形が重なる。三角形ごとの補間だと顔が継ぎ目で切れるので、uv を位置の1次式にする
    if (b.folded > 0.5) {
        vec2 d = pos - b.center;
        uv = b.uvM.xy * d.x + b.uvM.zw * d.y + b.centerUV;
    }
    vUV = rot2(uv, b.uvRot.x, b.uvRot.y);
    vec2 rel = (pos - b.center) / max(b.restRadius, 1e-3);
    vec2 right = vec2(u.worldDown.y, -u.worldDown.x);
    vRel = vec2(dot(rel, right), dot(rel, u.worldDown));
    vT = t;
    vInst = iid;
    vLayer = layer;
}
`;

export const blobVS = BLOB_VERTEX + `
uniform int uStride;
void main() {
    int vid = gl_VertexID + uFirstVertex;
    int iid = gl_InstanceID + uBaseInstance;
    BlobInstance b = loadBlob(iid);
    int m = b.pointCount * 3;
    int fanCount = uStride * 3;
    if (vid < fanCount) {
        int j = vid / 3, k = vid - j * 3;
        if (j >= m) { degenerateBlob(iid); return; }
        if (k == 0) { finishBlob(b, b.center, b.centerUV, 0.0, iid, 0, vec2(0.0)); return; }
        RingPt r = ringPoint(b, j + k - 1);
        finishBlob(b, offsetPoint(r, b.inflate - kFanIn), r.uv, 1.0, iid, 0, vec2(0.0));
        return;
    }
    int v = vid - fanCount;
    int j = v / 6, k = v - j * 6;
    if (j >= m) { degenerateBlob(iid); return; }
    bool next = (k == 2 || k == 3 || k == 5);
    bool outer = (k == 1 || k == 4 || k == 5);
    RingPt r = ringPoint(b, j + (next ? 1 : 0));
    // 縁の帯の内側は rimScale で太らせる（成熟雲の「できた」縁。外の輪郭は変えない）
    float off = outer ? b.inflate + kRimOut : b.inflate - kRimIn * clamp(b.rimScale, 0.5, 3.0);
    finishBlob(b, offsetPoint(r, off), r.uv, outer ? 1.0 : 0.0, iid, 1, vec2(0.0));
}
`;

// cfg = (uStride, uShadowMode)。mode 0 = まとめて描く（裏返る輪の扇は飛ばす）、1 = 扇だけ（裏返る輪をステンシルで塗る）
export const blobShadowVS = BLOB_VERTEX + `
uniform int uStride;
uniform int uShadowMode;
void main() {
    int vid = gl_VertexID + uFirstVertex;
    int iid = gl_InstanceID + uBaseInstance;
    BlobInstance b = loadBlob(iid);
    if (b.shadow < 0.5) { degenerateBlob(iid); return; }
    int m = b.pointCount * 3;
    int fanCount = uStride * 3;
    vec2 shift = kShadowShift * u.zoom;
    if (vid < fanCount) {
        int j = vid / 3, k = vid - j * 3;
        if (j >= m || (uShadowMode == 0 && b.folded > 0.5)) { degenerateBlob(iid); return; }
        if (k == 0) { finishBlob(b, b.center, b.centerUV, 0.0, iid, 0, shift); return; }
        RingPt r = ringPoint(b, j + k - 1);
        finishBlob(b, offsetPoint(r, b.inflate - kFanIn), r.uv, 1.0, iid, 0, shift);
        return;
    }
    int v = vid - fanCount;
    int j = v / 6, k = v - j * 6;
    if (j >= m) { degenerateBlob(iid); return; }
    bool next = (k == 2 || k == 3 || k == 5);
    bool outer = (k == 1 || k == 4 || k == 5);
    RingPt r = ringPoint(b, j + (next ? 1 : 0));
    float off = outer ? b.inflate + kShadowSpread : b.inflate - kFanIn;
    finishBlob(b, offsetPoint(r, off), r.uv, outer ? 1.0 : 0.0, iid, 1, shift);
}
`;

const BLOB_FRAGMENT_IN = `
in vec2 vUV;
in vec2 vRel;
in float vT;
flat in int vInst;
flat in int vLayer;
out vec4 fragColor;
`;

// 影の溜め（アルファの min で重なっても濃くならない）
export const blobShadowFS = HEADER + BLOB_DATA + BLOB_FRAGMENT_IN + `
void main() {
    float k = 1.0;
    if (vLayer == 1) {
        float s = 1.0 - saturate(vT);
        k = s * s * (3.0 - 2.0 * s);
    }
    float a = kShadowStrength * blobTexel(vInst * 13 + 10).z * k;   // .z = alpha
    fragColor = vec4(0.0, 0.0, 0.0, 1.0 - a);
}
`;

// 輪の向きが裏返る形（強く凹んだ形）用: ステンシルに巻き数だけ書く（色は書かない）
export const stencilOnlyFS = HEADER + `
out vec4 fragColor;
void main() { fragColor = vec4(0.0); }
`;

export const blobFS = HEADER + BLOB_DATA + BLOB_FRAGMENT_IN + `
// にじ雲の帯の表（RenderGPUTypes.swift の RainbowGPU と同じ並び。値は RainbowLook）
layout(std140) uniform RainbowTable {
    vec4 body[7];   // 体の色（リニア）: 赤・橙・黄・緑・青・藍・紫
    vec4 rim[7];    // 縁の色（同じ色相の濃い色）
    vec4 p0;        // (弧の中心 xy, restUV 1 あたりの帯の数, 流れる速さ 帯/秒)
    vec4 p1;        // (境のぼかし, 上端の弧の距離, 芯の白さ, -)
    vec4 p2;        // (変わる途中の境のぼかし, 境の光, -, -)
} rt;

// にじ雲の帯の色。restUV の中の弧（中心は体の下）に沿って7色が並び、時間でゆっくり上へ流れる。
// 帯は restUV で決まるので、体がつぶれると帯も一緒につぶれる。rim なら縁の色
vec3 rainbowColor(vec2 uv, bool rim) {
    float d = length(uv - rt.p0.xy);
    // 帯 i は s の [i, i+1)。k は帯の真ん中から測る（f = 0 で帯 i の真ん中、0.5 で境、1 で次の帯の真ん中）
    float s = (rt.p1.y - d) * rt.p0.z + u.time * rt.p0.w;
    float k = s - 0.5;
    float fi = floor(k);
    float f = k - fi;
    float m = smoothstep(0.5 - rt.p1.x, 0.5 + rt.p1.x, f);
    int i0 = clamp(int(fi - 7.0 * floor(fi / 7.0)), 0, 6);
    int i1 = i0 == 6 ? 0 : i0 + 1;
    vec3 a = rim ? rt.rim[i0].rgb : rt.body[i0].rgb;
    vec3 c = rim ? rt.rim[i1].rgb : rt.body[i1].rgb;
    return mix(a, c, m);
}

// 帯の色の効き（0〜1）。rainbow が 0〜1 の間は、帯の弧に沿って上（赤）から下へ順に7色が広がる。
// dir（画面の向き）があるときは、体の実際の形（rel）でその側から順に灯る（口をくぐる変身の予兆。首へ伸びた所から色づく）。
// front は広がる先の境の光（0〜1）。単色と帯の色を全体で混ぜると補色どうしで灰色ににごるので、境で塗り分ける
float rainbowWeight(vec2 uv, vec2 rel, float rb, vec2 dir, out float front) {
    front = 0.0;
    if (rb >= 0.999) return 1.0;
    if (rb <= 0.001) return 0.0;
    float w = rt.p2.x;
    float dl = length(dir);
    if (dl > 0.5) {
        // 体の dir の側の端（+1.15。伸びた所はもっと外）から反対の端（−1.15）へ
        float s = dot(rel, dir / dl);
        float edgeS = mix(1.15 + w, -1.15 - w, rb);
        front = 1.0 - smoothstep(0.0, 1.5 * w, abs(s - edgeS));
        return smoothstep(edgeS - w, edgeS + w, s);
    }
    float d = length(uv - rt.p0.xy);
    // 体の上端の弧（rt.p1.y）から下端の弧（2 内側）まで。端は少し外から始めて外で終える
    float edge = mix(rt.p1.y + 0.1 + w, rt.p1.y - 2.1 - w, rb);
    front = 1.0 - smoothstep(0.0, 1.5 * w, abs(d - edge));
    return smoothstep(edge - w, edge + w, d);
}

// 体の色（中心やや明るく、縁へわずかに暗く、下は濃く上は明るく）。base は体の地の色（にじ雲なら帯の色）
vec3 blobBodyColor(BlobInstance b, vec3 base, float coreWhite) {
    float t = saturate(vT);
    // 裏返る輪は扇の t が三角形ごとに食い違う（継ぎ目の筋が出る）ので、uv の半径で代える。縁の内側の光は消す
    float edgeK = 1.0;
    if (b.folded > 0.5) {
        t = saturate(length(vUV));
        edgeK = 0.0;
    }
    float ny = clamp(vRel.y, -1.3, 1.3);
    vec3 deep = base * base * 0.92;   // 同系色の濃い色（リニアで2乗すると彩度が上がる）
    vec3 c = base;
    c = mix(c, deep, 0.30 * smoothstep(0.55, 1.0, t));
    c = mix(c, deep, 0.32 * smoothstep(0.0, 1.0, ny));
    float lift = (0.20 + coreWhite) * (1.0 - smoothstep(0.0, 0.85, t)) + 0.12 * smoothstep(0.0, 1.0, -ny);
    c += (1.0 - c) * lift;
    // 下の縁の内側の照り返し（ゼリーの透け感）
    float bounce = smoothstep(0.80, 0.97, t) * smoothstep(0.35, 0.95, ny);
    c += (1.0 - c) * 0.12 * bounce * edgeK;
    // 右下の縁のすぐ内側に細い光の三日月（縁からの距離 u で幅をそろえる）
    float rl = length(vRel);
    float edgeU = rl * b.restRadius * (1.0 - t) / max(t, 0.05);
    vec2 dir = vRel / max(rl, 1e-4);
    float side = smoothstep(0.25, 0.85, dot(dir, vec2(0.45, 0.89)));
    float crescent = smoothstep(1.3, 2.1, edgeU) * (1.0 - smoothstep(2.6, 4.6, edgeU)) * side;
    c += (1.0 - c) * 0.30 * crescent * edgeK;
    c = mix(c, vec3(1.0), 0.55 * saturate(b.glow));
    return c;
}

// 顔（restUV 空間。体と一緒につぶれる）
vec3 blobFace(vec3 c, vec2 uv, float px, BlobInstance b) {
    float s = max(b.faceScale, 0.05);
    vec2 p = uv / s;
    float pf = px / s;
    if (abs(p.x) > 0.95 || p.y < -0.62 || p.y > 0.5) return c;

    // 頬（芯は濃いめ。緑や青の体でも濁らないように少し明るいピンクで重ねる）
    for (int i = 0; i < 2; i++) {
        float side = i == 0 ? -1.0 : 1.0;
        vec2 q = (p - vec2(side * 0.52, 0.16)) / vec2(0.15, 0.085);
        float a = saturate(b.cheek.a * 1.5) * (1.0 - smoothstep(0.3, 1.0, length(q)));
        c = mix(c, mix(b.cheek.rgb, vec3(1.0), 0.12), a);
    }

    // 目
    // squint: 0〜0.5 で目が少しつぶれ、0.4〜0.6 の短い間に「> <」へ切り替わる（途中の形を長く見せない）
    float sq = saturate(b.squint);
    float sqA = smoothstep(0.4, 0.6, sq);
    float open = saturate(b.eyeOpen) * (1.0 - 0.65 * smoothstep(0.0, 0.5, sq));
    float roundA = smoothstep(0.06, 0.28, open);
    float glintVis = smoothstep(0.5, 0.85, open) * (1.0 - sqA);
    vec2 look = b.look / s * (1.0 - sqA);
    float eyeA = 0.0, glintA = 0.0;
    for (int i = 0; i < 2; i++) {
        float side = i == 0 ? -1.0 : 1.0;
        vec2 e = p - vec2(side * 0.30, -0.06) - look;
        const float r = 0.10;
        // 丸い目（縦につぶれて線になる）
        float dOpen = sdEllipse(e, vec2(r * (1.0 + 0.1 * (1.0 - open)), r * max(open, 0.03)));
        float aOpen = fillAA(dOpen, pf) * roundA * (1.0 - sqA);
        // 閉じた目「‿」
        vec2 el = vec2(e.x, e.y - (0.022 - 2.2 * e.x * e.x));
        float dLine = sdSegment(el, vec2(-r * 0.92, 0.0), vec2(r * 0.92, 0.0)) - 0.024;
        float aLine = fillAA(dLine, pf) * (1.0 - roundA) * (1.0 - sqA);
        // ぎゅっと閉じた「> <」（先が顔の内側を向く）
        vec2 ch = vec2(e.x * side, e.y);
        float dCh = min(sdSegment(ch, vec2(-0.07, 0.0), vec2(0.065, -0.068)),
                        sdSegment(ch, vec2(-0.07, 0.0), vec2(0.065, 0.068))) - 0.026;
        float aCh = fillAA(dCh, pf) * sqA;
        eyeA = max(eyeA, max(max(aOpen, aLine), aCh));
        // 目の光（大小2つ）
        float g1 = fillAA(length(e - vec2(-0.034, -0.040 * open)) - 0.034, pf);
        float g2 = fillAA(length(e - vec2(0.038, 0.040 * open)) - 0.016, pf);
        glintA = max(glintA, max(g1, g2) * glintVis);
    }
    c = mix(c, b.eye.rgb, eyeA * b.eye.a);
    c = mix(c, vec3(1.0), glintA * 0.95);

    // 気分（mood）: − で困り眉（目の上で、内側が上がり外側が下がる）と「︵」の口、+ で「‿」の口。
    // しょんぼりは静かに（涙や大きな口は描かない）
    float worry = saturate(-b.mood);
    if (worry > 0.01) {
        float browA = 0.0;
        for (int i = 0; i < 2; i++) {
            float side = i == 0 ? -1.0 : 1.0;
            vec2 q = p - look * 0.6;
            q.x *= side;   // 右の眉の向きにそろえる（x > 0 が外側）
            float d = sdSegment(q, vec2(0.16, -0.245 - 0.055 * worry), vec2(0.42, -0.205 + 0.035 * worry)) - 0.021;
            browA = max(browA, fillAA(d, pf));
        }
        c = mix(c, b.eye.rgb, browA * worry * 0.9 * b.eye.a);
    }
    float moodA = smoothstep(0.2, 0.7, abs(b.mood));
    if (b.mouth <= 0.001 && moodA > 0.01) {
        const float hw = 0.075, bend = 0.036;
        float sgn = b.mood > 0.0 ? 1.0 : -1.0;   // + は真ん中が下がる「‿」、− は真ん中が上がる「︵」
        vec2 mp = p - vec2(0.0, 0.185) - look * 0.5;
        float uu = mp.x / hw;
        vec2 ml = vec2(mp.x, mp.y - sgn * bend * (0.5 - uu * uu));
        float d = sdSegment(ml, vec2(-hw, 0.0), vec2(hw, 0.0)) - 0.02;
        c = mix(c, b.eye.rgb, fillAA(d, pf) * moodA * b.eye.a);
    }

    // 口「o」
    if (b.mouth > 0.001) {
        float m = b.mouth;
        vec2 mp = p - vec2(0.0, 0.20);
        float aM = fillAA(sdEllipse(mp, vec2(m * 0.8, m)), pf);
        float aT = fillAA(sdEllipse(mp - vec2(0.0, m * 0.45), vec2(m * 0.52, m * 0.40)), pf);
        vec3 mc = mix(b.eye.rgb, lin(vec3(0.93, 0.42, 0.48)), aT * 0.85);
        c = mix(c, mc, aM);
    }

    // 汗（右上の水滴）
    if (b.sweat > 0.001) {
        vec2 sp = p - vec2(0.70, -0.38);
        float d = sdUnevenCapsule(vec2(sp.x, -sp.y) + vec2(0.0, 0.05), 0.07, 0.012, 0.13);
        float a = fillAA(d, pf) * saturate(b.sweat);
        float edge = fillAA(abs(d + 0.013) - 0.013, pf);
        vec3 wc = mix(lin(vec3(0.62, 0.86, 1.0)), lin(vec3(0.30, 0.58, 0.92)), edge);
        wc = mix(wc, vec3(1.0), fillAA(length(sp - vec2(-0.022, 0.03)) - 0.017, pf));
        c = mix(c, wc, a);
    }
    return c;
}

// つや（restUV の左上に傾いた楕円と、小さな点）
vec3 blobGloss(vec3 c, vec2 uv, float px, BlobInstance b) {
    // 左上にひろい柔らかな照り（濡れた感じ）
    vec2 sh = rot2(uv - vec2(-0.30, -0.36), 0.766, 0.643) / vec2(0.50, 0.34);
    c = mix(c, b.highlight.rgb, 0.16 * b.highlight.a * (1.0 - smoothstep(0.2, 1.0, length(sh))));
    vec2 h = rot2(uv - vec2(-0.38, -0.45), 0.766, 0.643);   // 40° 傾けて体の丸みに沿わせる
    float d = sdEllipse(h, vec2(0.22, 0.115));
    float a = fillAA(d, px) * (0.72 + 0.28 * smoothstep(0.0, -0.07, d));
    float d2 = length(uv - vec2(-0.08, -0.66)) - 0.05;
    a = max(a, fillAA(d2, px) * 0.85);
    return mix(c, b.highlight.rgb, a * b.highlight.a);
}

void main() {
    // 微分は分岐の前に取る
    vec2 dx = dFdx(vUV), dy = dFdy(vUV);
    float px = max(0.5 * (length(dx) + length(dy)), 1e-5);   // uv 空間での 1 ピクセル
    float tw = fwidth(vT);
    BlobInstance b = loadBlob(vInst);
    // にじ雲: 体と縁の地の色を7色の帯にする（rainbow が 0〜1 の間は、上から順に帯が広がる）
    float front = 0.0;
    float rw = rainbowWeight(vUV, vRel, saturate(b.rainbow), b.rainbowDir, front);
    vec3 body = b.body.rgb;
    if (rw > 0.001) body = mix(body, rainbowColor(vUV, false), rw);

    if (vLayer == 1) {
        // 縁の帯: 内側はやわらかく体に溶け、外側はピクセル単位でなめらかに切る
        float t = vT;
        float outer = saturate((1.0 - t) / max(tw, 1e-5));
        float inner = smoothstep(0.0, 0.45, t);
        vec3 c = b.rim.rgb;
        if (rw > 0.001) c = mix(c, rainbowColor(vUV, true), rw);
        float up = saturate(-vRel.y);
        c = mix(c, body, 0.25 * up * up);
        c = mix(c, vec3(1.0), 0.5 * saturate(b.glow));
        float a = inner * outer * b.rim.a * b.alpha;
        fragColor = vec4(c * a, a);
        return;
    }

    vec3 c = blobBodyColor(b, body, rt.p1.z * rw);
    c += (1.0 - c) * rt.p2.y * front;
    if (b.faceVisible > 0.5) c = blobFace(c, vUV, px, b);
    c = blobGloss(c, vUV, px, b);
    float a = b.body.a * b.alpha;
    fragColor = vec4(c * a, a);
}
`;

// ===== カプセル・波紋・火花 =====
// インスタンス 1 つ = 四角形 1 枚（三角形の帯 4 頂点）。ShapeInstanceGPU と同じ並び（24 個の float）を頂点属性で受ける

export const shapeVS = HEADER + `
in vec4 aColor;
in vec4 aColor2;    // カプセルの縁の色
in vec4 aAB;        // a.xy, b.xy
in vec4 aClip;      // clipA.xy, clipB.xy（カプセルの端がつながっているときの切り口〈内向きの法線〉。0 ならつながっていない）
in vec4 aParams;    // radius, thickness, rotation, gloss
in float aKind;     // 0 カプセル・1 波紋・2 丸・3 星・4 ハート・5 しずく
uniform int uPass;  // 0 = そのまま、1 = 影の溜め、2 = カプセルの縁だけ、3 = カプセルの中身だけ

out vec2 vP;        // カプセル・波紋: ワールド座標。火花: 形のローカル座標（半径 1）
flat out vec4 vColor;
flat out vec4 vColor2;
flat out vec4 vAB;
flat out vec4 vClip;
flat out vec4 vParams;
flat out int vKind;

void main() {
    int vid = gl_VertexID;
    vec2 corner = vec2((vid & 1) != 0 ? 1.0 : -1.0, (vid & 2) != 0 ? 1.0 : -1.0);
    int kind = int(aKind + 0.5);
    vec2 a = aAB.xy, b = aAB.zw;
    float radius = aParams.x, thickness = aParams.y, rotation = aParams.z;
    vec2 world;
    vec2 shift = vec2(0.0);
    if (kind == 0) {
        vec2 d = b - a;
        float L = length(d);
        vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
        vec2 nrm = vec2(-dir.y, dir.x);
        float pad = 1.5;
        if (uPass == 1) { pad += kShadowSpread; shift = kShadowShift * u.zoom; }
        vec2 c = (a + b) * 0.5;
        world = c + dir * (corner.x * (L * 0.5 + radius + pad)) + nrm * (corner.y * (radius + pad));
        vP = world;
    } else if (kind == 1) {
        world = a + corner * (radius + thickness * 0.5 + 1.5);
        vP = world;
    } else {
        vec2 local = corner * 1.2;
        world = a + rot2(local, cos(rotation), sin(rotation)) * (radius * 0.5);
        vP = local;
    }
    gl_Position = toClip(toScreen(world) + shift);
    vColor = aColor; vColor2 = aColor2; vAB = aAB; vClip = aClip; vParams = aParams; vKind = kind;
}
`;

const SHAPE_FRAGMENT_IN = `
in vec2 vP;
flat in vec4 vColor;
flat in vec4 vColor2;
flat in vec4 vAB;
flat in vec4 vClip;
flat in vec4 vParams;
flat in int vKind;
out vec4 fragColor;
`;

// pass: 0 = そのまま、1 = 影の溜め、2 = カプセルの縁だけ、3 = カプセルの中身だけ
// （つないだカプセルの継ぎ目が出ないよう、縁を全部描いてから中身を全部描く）
export const shapeFS = HEADER + SHAPE_FRAGMENT_IN + `
uniform int uPass;
void main() {
    vec2 dpx = fwidth(vP);
    float px = max(0.5 * (dpx.x + dpx.y), 1e-5);
    vec2 sa = vAB.xy, sb = vAB.zw;
    vec2 clipA = vClip.xy, clipB = vClip.zw;
    float radius = vParams.x, thickness = vParams.y, gloss = vParams.w;

    if (vKind == 0) {
        // カプセル: 同系色の縁、上は明るく下は濃く、光の側に細いつや
        vec2 ba = sb - sa;
        float h = saturate(dot(vP - sa, ba) / max(dot(ba, ba), 1e-8));
        vec2 off = vP - (sa + ba * h);
        float r = max(radius, 1e-3);
        float d = length(off) - r;
        float cov = fillAA(d, px);
        vec3 c = vColor.rgb;
        vec2 n = off / r;
        float ny = dot(n, u.worldDown);
        c = mix(c, c * c * 0.9, 0.35 * saturate(ny));
        c += (1.0 - c) * 0.14 * saturate(-ny);
        // つながった端は角の二等分線で切る（重なった所はどちらか一方だけが描く。継ぎ目の丸が出ない）
        bool joinA = any(notEqual(clipA, vec2(0.0))), joinB = any(notEqual(clipB, vec2(0.0)));
        if (joinA && dot(vP - sa, clipA) < 0.0) cov = 0.0;
        if (joinB && dot(vP - sb, clipB) < 0.0) cov = 0.0;
        float rimW = min(2.0, r * 0.4);
        float rimMix = smoothstep(-rimW - 0.5, -rimW + 0.3, d);
        if (uPass == 2) {
            // 縁だけ（上側は少し明るく）
            vec3 rc = mix(vColor2.rgb, vColor.rgb, 0.25 * saturate(-ny));
            float a = cov * vColor.a;
            fragColor = vec4(rc * a, a);
            return;
        }
        if (uPass == 3) {
            // 中身だけ（縁へやわらかく溶ける）
            cov = min(cov, 1.0 - rimMix);
        } else {
            c = mix(c, vColor2.rgb, rimMix);
        }
        // つや: 光（画面の左上）の側へずらした細いカプセル
        float L = sqrt(dot(ba, ba));
        vec2 dir = L > 1e-4 ? ba / L : vec2(1.0, 0.0);
        vec2 side = vec2(-dir.y, dir.x);
        vec2 right = vec2(u.worldDown.y, -u.worldDown.x);
        vec2 light = normalize(-0.45 * right - u.worldDown);
        float facing = dot(side, light);
        side *= facing >= 0.0 ? 1.0 : -1.0;
        // つないだ端ではつやを端まで通す（隣へ続く）。光に対して横向きのときは消す（側が入れ替わる所で跳ばない）
        float inset = min(r * 0.7, L * 0.5);
        vec2 ga = sa + dir * (joinA ? 0.0 : inset) + side * r * 0.42;
        vec2 gb = sb - dir * (joinB ? 0.0 : inset) + side * r * 0.42;
        float dg = sdSegment(vP, ga, gb) - r * 0.17;
        float gA = fillAA(dg, px) * gloss * (0.55 + 0.45 * abs(facing)) * smoothstep(0.05, 0.35, abs(facing));
        c = mix(c, vec3(1.0), gA);
        float a = cov * vColor.a;
        fragColor = vec4(c * a, a);
        return;
    }
    if (vKind == 1) {
        float d = abs(length(vP - sa) - radius) - thickness * 0.5;
        float a = fillAA(d, px) * vColor.a;
        fragColor = vec4(vColor.rgb * a, a);
        return;
    }
    // 火花（ローカル座標、半径 1。y は下向きなので上向きの形は y を反転して使う）
    vec2 p = vP;
    float d;
    float core = 0.0;
    if (vKind == 2) {
        d = length(p) - 0.9;
        core = 1.0 - smoothstep(0.0, 0.55, length(p));
    } else if (vKind == 3) {
        d = sdStar5(vec2(p.x, -p.y), 0.85, 0.48) - 0.08;
        core = 1.0 - smoothstep(0.0, 0.4, length(p));
    } else if (vKind == 4) {
        d = (sdHeart(vec2(p.x, -p.y) * 0.62 + vec2(0.0, 0.55)) - 0.03) / 0.62;
        core = 0.0;
    } else {
        d = sdUnevenCapsule(vec2(p.x, -p.y) + vec2(0.0, 0.42), 0.5, 0.04, 1.2);
        core = 0.0;
    }
    float a = fillAA(d, px) * vColor.a;
    vec3 c = mix(vColor.rgb, vec3(1.0), 0.6 * core);
    // 形の中の上側に小さなつや
    if (vKind >= 4) {
        float g = fillAA(length(p - vec2(-0.28, vKind == 4 ? -0.32 : 0.05)) - 0.16, px);
        c = mix(c, vec3(1.0), 0.7 * g);
    }
    fragColor = vec4(c * a, a);
}
`;

// カプセルの影の溜め
export const shapeShadowFS = HEADER + SHAPE_FRAGMENT_IN + `
void main() {
    float d = sdSegment(vP, vAB.xy, vAB.zw) - vParams.x;
    float k = 1.0 - smoothstep(-1.0, kShadowSpread, d);
    fragColor = vec4(0.0, 0.0, 0.0, 1.0 - kShadowStrength * k * vColor.a);
}
`;

// ===== 文字（R = 字の形、G = 縁取り込みの形） =====

export const textVS = HEADER + `
uniform vec2 uCenter;   // 画面に固定したキャンバス座標での中心
uniform vec2 uAxisX;    // 半分の大きさのベクトル
uniform vec2 uAxisY;
out vec2 vTexUV;
void main() {
    int vid = gl_VertexID;
    vec2 corner = vec2((vid & 1) != 0 ? 1.0 : -1.0, (vid & 2) != 0 ? 1.0 : -1.0);
    gl_Position = toClip(uCenter + uAxisX * corner.x + uAxisY * corner.y);
    vTexUV = corner * 0.5 + 0.5;
}
`;

// テクスチャの端は焼いたときの余白（0）なので、Metal の clamp_to_zero の代わりに clamp_to_edge で同じになる
export const textFS = HEADER + `
in vec2 vTexUV;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uShadowUV;  // 影をずらす量（テクスチャの uv 単位）
uniform vec4 uFill;
uniform vec4 uOutline;
uniform float uAlpha;
void main() {
    vec2 m = texture(uTex, vTexUV).rg;
    float sh = texture(uTex, vTexUV - uShadowUV).g * 0.22 * uOutline.a;
    float fa = m.r * uFill.a;
    float oa = m.g * uOutline.a;
    vec3 rgb = uFill.rgb * fa + uOutline.rgb * oa * (1.0 - fa);
    float a = fa + oa * (1.0 - fa);
    // 縁取りの下に薄い影
    vec3 shc = lin(vec3(0.45, 0.25, 0.30));
    rgb += shc * sh * (1.0 - a);
    a += sh * (1.0 - a);
    fragColor = vec4(rgb, a) * uAlpha;
}
`;
