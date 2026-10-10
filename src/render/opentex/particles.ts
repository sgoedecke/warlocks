// Open texture pack: our own procedural stand-ins for the Warcraft III base-game textures
// that the Warlock map's models reference (particle flipbooks, glows, shockwaves, stars,
// surface materials...). Everything here is generated from code, so it is open source
// with the project; nothing is derived from Blizzard's image data. Each generator is keyed
// by the original file path so models pick it up automatically when the real file is absent.
import { clamp01, fbm3, hex, mix, noise3, ramp, ridged3, smooth, type RGB } from './noise';

type Pixel = (u: number, v: number, x: number, y: number) => [number, number, number, number];

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** Runs a per-pixel function (u,v in 0..1) and returns the canvas. Colours 0..255, alpha 0..1. */
function shade(w: number, h: number, fn: Pixel): HTMLCanvasElement {
  const [c, g] = canvas(w, h);
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, gg, b, a] = fn((x + 0.5) / w, (y + 0.5) / h, x, y);
      const i = (y * w + x) * 4;
      d[i] = r;
      d[i + 1] = gg;
      d[i + 2] = b;
      d[i + 3] = clamp01(a) * 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}

/** A rows x columns sprite sheet; `fn` gets cell-local u,v plus frame progress t (0..1) and index. */
function flipbook(rows: number, cols: number, cell: number, fn: (u: number, v: number, t: number, i: number) => [number, number, number, number]): HTMLCanvasElement {
  const n = rows * cols;
  return shade(cols * cell, rows * cell, (_u, _v, x, y) => {
    const col = Math.floor(x / cell);
    const row = Math.floor(y / cell);
    const i = row * cols + col;
    return fn(((x % cell) + 0.5) / cell, ((y % cell) + 0.5) / cell, n > 1 ? i / (n - 1) : 0, i);
  });
}

const polar = (u: number, v: number): [number, number] => {
  const dx = u * 2 - 1, dy = v * 2 - 1;
  return [Math.sqrt(dx * dx + dy * dy), Math.atan2(dy, dx)];
};

// ---------- clouds, smoke, fire ----------

/** Puff density for a cloud sprite: irregular edge, internal billows, evolving with t. */
function puff(u: number, v: number, t: number, seed: number, spread = 0.25, holes = 0.35): number {
  const [r] = polar(u, v);
  const wob = fbm3(u * 3.2, v * 3.2, seed * 1.7 + t * 2.4, 4, seed);
  const radius = 0.62 + spread * t;
  const edge = smooth(radius, radius * 0.35, r + (wob - 0.5) * 0.55);
  const billow = fbm3(u * 5 + seed, v * 5, t * 3.1 + seed * 0.37, 4, seed + 5);
  const density = smooth(holes * t, holes * t + 0.45, billow);
  return edge * density;
}

function clouds(rows: number, cols: number, kind: 'white' | 'fade' | 'fire' | 'mod' | 'swirl'): HTMLCanvasElement {
  return flipbook(rows, cols, 64, (u, v, t, i) => {
    const seed = (i % 7) * 0.13 + 1;
    if (kind === 'fire') {
      const p = puff(u, v, t * 0.85, seed, 0.15, 0.55);
      const lick = ridged3(u * 4, v * 4 + t * 3, seed + t * 2, 3, 9);
      const heat = clamp01(p * (1.25 - t * 0.75) * (0.75 + lick * 0.55));
      const c = ramp([[0, hex('#000000')], [0.18, hex('#5a0800')], [0.4, hex('#c42c00')], [0.62, hex('#ff8a10')], [0.82, hex('#ffd25a')], [1, hex('#fff6d8')]], heat);
      return [c[0], c[1], c[2], clamp01(heat * 1.6)];
    }
    if (kind === 'swirl') {
      const [r, a] = polar(u, v);
      const sw = fbm3(Math.cos(a + r * 3 + t * 4) * 1.5 + 2, Math.sin(a + r * 3 + t * 4) * 1.5 + 2, r * 2 + t * 2, 4, 3);
      const m = smooth(0.95, 0.2, r) * smooth(0.35 + t * 0.2, 0.75, sw + 0.25);
      const lum = 200 + sw * 55;
      return [lum, lum, lum, m * (1 - t * 0.5)];
    }
    if (kind === 'mod') {
      const p = puff(u, v, t, seed, 0.2, 0.25);
      const wisp = ridged3(u * 3, v * 3, seed + t * 2.5, 4, 4);
      const lum = 150 + wisp * 90;
      return [lum, lum, lum, clamp01(p * (0.55 + wisp * 0.6))];
    }
    const p = puff(u, v, t, seed, 0.25, kind === 'fade' ? 0.5 : 0.3);
    const shadeN = fbm3(u * 6, v * 6, seed + t * 2, 3, 2);
    const lum = 185 + shadeN * 70 - smooth(0.2, 0.9, v) * 25;
    const a = p * (kind === 'fade' ? Math.pow(1 - t, 0.8) : 0.95);
    return [lum, lum, lum * 1.02, a];
  });
}

/** Soft dusty blob (single sprite). */
function dust(seed: number, size = 128, hardness = 0.35, tint: RGB = [235, 228, 215]): HTMLCanvasElement {
  return shade(size, size, (u, v) => {
    const p = puff(u, v, 0.15, seed, 0.1, 0.25 + hardness * 0.2);
    const n = fbm3(u * 8, v * 8, seed, 3, 6);
    return [tint[0] * (0.82 + n * 0.25), tint[1] * (0.82 + n * 0.25), tint[2] * (0.82 + n * 0.25), p];
  });
}

/** Tileable billowy cloud (for textures wrapped around spheres). */
function cloudTile(seed: number, size = 256, tint: RGB = [240, 236, 230]): HTMLCanvasElement {
  return shade(size, size, (u, v) => {
    const n = fbm3(u * 4, v * 4, seed, 5, seed, 4, 4);
    const a = smooth(0.38, 0.75, n);
    return [tint[0] * (0.75 + n * 0.3), tint[1] * (0.75 + n * 0.3), tint[2] * (0.75 + n * 0.3), a];
  });
}

// ---------- glows, flares, stars ----------

function glow(color: RGB, size = 128, falloff = 2.2, core = 0.35): HTMLCanvasElement {
  return shade(size, size, (u, v) => {
    const [r] = polar(u, v);
    const i = Math.pow(clamp01(1 - r), falloff) + core * Math.exp(-r * r * 40);
    return [mix(color[0], 255, clamp01(i - 0.6)), mix(color[1], 255, clamp01(i - 0.6)), mix(color[2], 255, clamp01(i - 0.6)), clamp01(i)];
  });
}

function star(points: number, color: RGB, opts: { size?: number; spike?: number; halo?: number; diag?: number; core?: number } = {}): HTMLCanvasElement {
  const { size = 128, spike = 0.012, halo = 0.35, diag = 0, core = 1 } = opts;
  return shade(size, size, (u, v) => {
    const dx = u * 2 - 1, dy = v * 2 - 1;
    const r = Math.sqrt(dx * dx + dy * dy);
    let i = core * Math.exp(-r * r * 90) + halo * Math.pow(clamp01(1 - r), 3);
    for (let k = 0; k < points; k++) {
      const a = (k / points) * Math.PI;
      const along = Math.abs(dx * Math.cos(a) + dy * Math.sin(a));
      const perp = Math.abs(-dx * Math.sin(a) + dy * Math.cos(a));
      const strength = diag && k % 2 === 1 ? diag : 1;
      i += strength * Math.exp(-(perp * perp) / (spike * (1 - along * 0.9) + 1e-5)) * Math.pow(clamp01(1 - along), 2);
    }
    i = clamp01(i);
    const w = clamp01(i * 1.4 - 0.4);
    return [mix(color[0], 255, w), mix(color[1], 255, w), mix(color[2], 255, w), i];
  });
}

function flare(): HTMLCanvasElement {
  return shade(128, 128, (u, v) => {
    const [r, a] = polar(u, v);
    const rays = Math.pow(Math.abs(Math.cos(a * 3)), 24) * 0.5 + Math.pow(Math.abs(Math.cos(a * 4 + 0.4)), 40) * 0.3;
    const streak = noise3(a * 6 + 10, 0.5, 2, 4) * 0.25;
    const i = clamp01(Math.exp(-r * r * 60) + 0.45 * Math.pow(clamp01(1 - r), 2.5) + (rays + streak * 0.6) * Math.pow(clamp01(1 - r), 1.5));
    return [255, 255, 255, i];
  });
}

// ---------- rings ----------

function ring(color: RGB, opts: { radius?: number; width?: number; inner?: number; noise?: number; double?: boolean; ice?: boolean; size?: number } = {}): HTMLCanvasElement {
  const { radius = 0.78, width = 0.11, inner = 0.18, noise = 0.25, double = false, ice = false, size = 256 } = opts;
  return shade(size, size, (u, v) => {
    const [r, a] = polar(u, v);
    const n = fbm3(Math.cos(a) * 3 + 3, Math.sin(a) * 3 + 3, r * 4, 4, 11);
    let i = Math.exp(-Math.pow((r - radius) / width, 2)) * (1 - noise + noise * n * 2);
    if (double) i += 0.6 * Math.exp(-Math.pow((r - radius * 0.72) / (width * 0.6), 2));
    i += inner * smooth(radius, 0, r) * (0.5 + n * 0.5);
    if (ice) {
      const cr = ridged3(Math.cos(a) * 6 + 6, Math.sin(a) * 6 + 6, r * 3, 3, 13);
      i = i * (0.55 + cr * 0.9) + smooth(radius + 0.05, radius - 0.15, r) * smooth(radius - 0.4, radius - 0.1, r) * Math.pow(cr, 4) * 0.8;
    }
    i = clamp01(i) * smooth(1, 0.94, r);
    const w = clamp01(i * 1.2 - 0.5);
    return [mix(color[0], 255, w), mix(color[1], 255, w), mix(color[2], 255, w), i];
  });
}

// ---------- energy ----------

function zap(): HTMLCanvasElement {
  return shade(128, 128, (u, v) => {
    const [r, a] = polar(u, v);
    let i = 0;
    for (let k = 0; k < 5; k++) {
      const base = (k / 5) * Math.PI * 2 + 0.6;
      const jag = (fbm3(r * 6, k * 3.1, 1, 3, 21) - 0.5) * 1.2 * r;
      let d = Math.abs(((a - base - jag + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      d *= r * 6;
      i += Math.exp(-d * d * 40) * smooth(0.95, 0.4, r);
    }
    i = clamp01(i + Math.exp(-r * r * 30) * 0.8);
    const w = clamp01(i * 1.3 - 0.3);
    return [mix(120, 255, w), mix(170, 255, w), 255, i];
  });
}

function electricTile(size: number, stretchU: number, stretchV: number, color: RGB, seed: number): HTMLCanvasElement {
  return shade(size, size, (u, v) => {
    const n = ridged3(u * stretchU, v * stretchV, seed, 4, seed, stretchU, stretchV);
    const i = clamp01(Math.pow(n, 6) * 2.2 + Math.pow(n, 2) * 0.15);
    const w = clamp01(i * 1.2 - 0.4);
    return [mix(color[0], 255, w), mix(color[1], 255, w), mix(color[2], 255, w), i];
  });
}

function streaks(size: number, color: RGB, seed: number, alpha = 0.85): HTMLCanvasElement {
  return shade(size, size, (u, v) => {
    const n = fbm3(u * 8, v * 1.5, seed, 4, seed, 8, 1.5 > 0 ? 0 : 0);
    const s = fbm3(u * 16, v * 2, seed + 3, 3, seed + 3, 16, 2);
    const i = clamp01(smooth(0.35, 0.8, n * 0.7 + s * 0.5) * alpha);
    return [color[0], color[1], color[2], i];
  });
}

function ribbon(color: RGB): HTMLCanvasElement {
  return shade(128, 64, (u, v) => {
    const across = Math.exp(-Math.pow((v - 0.5) * 3.2, 2));
    const n = fbm3(u * 6, v * 3, 7, 3, 7, 6, 0);
    const i = clamp01(across * (0.6 + n * 0.6));
    const w = clamp01(across * 1.4 - 0.7);
    return [mix(color[0], 255, w), mix(color[1], 255, w), mix(color[2], 255, w), i];
  });
}

function foam(): HTMLCanvasElement {
  const [c, g] = canvas(128, 128);
  g.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 46; k++) {
    const x = 64 + (noise3(k * 3.3, 1, 0, 41) - 0.5) * 100;
    const y = 64 + (noise3(k * 3.3, 7, 0, 43) - 0.5) * 100;
    const r = 3 + noise3(k * 1.7, 3, 0, 47) * 9;
    const d = Math.hypot(x - 64, y - 64) / 64;
    const a = 0.65 * (1 - d * 0.8);
    const grd = g.createRadialGradient(x, y, r * 0.5, x, y, r);
    grd.addColorStop(0, `rgba(255,255,255,${a * 0.55})`);
    grd.addColorStop(0.7, `rgba(255,255,255,${a * 0.8})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

function flame(): HTMLCanvasElement {
  return shade(64, 128, (u, v) => {
    const y = 1 - v;
    const width = 0.42 * Math.pow(Math.sin(Math.PI * Math.min(1, y * 1.05)), 0.8) * (1 - y * 0.55);
    const x = Math.abs(u - 0.5 + (fbm3(y * 3, 0, 4, 3, 51) - 0.5) * 0.25 * y);
    const n = fbm3(u * 4, v * 6, 2, 4, 52);
    const heat = clamp01(smooth(width, width * 0.2, x) * (1.1 - y * 0.6) * (0.75 + n * 0.5));
    const c = ramp([[0, hex('#000000')], [0.25, hex('#8a1400')], [0.55, hex('#ff7a10')], [0.8, hex('#ffd060')], [1, hex('#fff8e0')]], heat);
    return [c[0], c[1], c[2], clamp01(heat * 1.5)];
  });
}

// ---------- surfaces ----------

function water(): HTMLCanvasElement {
  return shade(256, 256, (u, v) => {
    const c1 = ridged3(u * 4, v * 4, 1.3, 3, 61, 4, 4);
    const c2 = ridged3(u * 4 + 0.37, v * 4 + 0.61, 4.1, 3, 62, 4, 4);
    const caustic = Math.pow(Math.max(c1, c2), 5);
    const base = ramp([[0, hex('#06204a')], [0.5, hex('#1258a0')], [1, hex('#38a8e8')]], fbm3(u * 3, v * 3, 2, 4, 63, 3, 3));
    return [mix(base[0], 220, caustic), mix(base[1], 250, caustic), mix(base[2], 255, caustic), 0.92];
  });
}

function frost(seed: number, alpha = 0.85): HTMLCanvasElement {
  return shade(256, 256, (u, v) => {
    const cracks = ridged3(u * 5, v * 5, seed, 4, seed, 5, 5);
    const n = fbm3(u * 3, v * 3, seed + 2, 4, seed + 1, 3, 3);
    const c = ramp([[0, hex('#3a78b8')], [0.5, hex('#9cd4f4')], [1, hex('#ffffff')]], clamp01(n * 0.6 + Math.pow(cracks, 3) * 0.7));
    return [c[0], c[1], c[2], alpha * (0.55 + n * 0.45)];
  });
}

function rock(): HTMLCanvasElement {
  return shade(128, 128, (u, v) => {
    const n = fbm3(u * 6, v * 6, 3, 5, 71, 6, 6);
    const crack = Math.pow(ridged3(u * 4, v * 4, 5, 3, 72, 4, 4), 6);
    const l = 60 + n * 110 - crack * 50;
    return [l * 1.02, l * 0.96, l * 0.88, 1];
  });
}

function crackSplat(): HTMLCanvasElement {
  return shade(256, 256, (u, v) => {
    const [r, a] = polar(u, v);
    const cr = Math.pow(ridged3(Math.cos(a) * 4 + 4, Math.sin(a) * 4 + 4, r * 6, 4, 81), 5);
    const i = clamp01(cr * smooth(1, 0.2, r) * 1.5 + smooth(0.5, 0, r) * 0.35);
    return [40, 30, 22, i];
  });
}

function metal(base: RGB, hi: RGB, seed: number, bands = 0): HTMLCanvasElement {
  return shade(128, 128, (u, v) => {
    const brushed = fbm3(u * 2, v * 24, seed, 3, seed, 2, 24);
    const blot = fbm3(u * 4, v * 4, seed + 4, 4, seed + 4, 4, 4);
    let t = 0.35 + brushed * 0.35 + blot * 0.3;
    if (bands) {
      const b = Math.abs(((v * bands) % 1) - 0.5);
      t -= smooth(0.08, 0.02, Math.abs(b - 0.45)) * 0.45;
      t += smooth(0.06, 0.0, Math.abs(b - 0.38)) * 0.3;
    }
    const c = ramp([[0, [base[0] * 0.35, base[1] * 0.35, base[2] * 0.35]], [0.55, base], [1, hi]], clamp01(t));
    return [c[0], c[1], c[2], 1];
  });
}

function stone(base: RGB, vein: RGB, seed: number): HTMLCanvasElement {
  return shade(128, 128, (u, v) => {
    const n = fbm3(u * 4, v * 4, seed, 5, seed, 4, 4);
    const vn = Math.pow(ridged3(u * 3, v * 3, seed + 1, 3, seed + 1, 3, 3), 8);
    const l = 0.55 + n * 0.6;
    return [mix(base[0] * l, vein[0], vn), mix(base[1] * l, vein[1], vn), mix(base[2] * l, vein[2], vn), 1];
  });
}

function lionEmblem(): HTMLCanvasElement {
  return shade(128, 128, (u, v) => {
    const [r, a] = polar(u, v);
    const field = ramp([[0, hex('#20366e')], [1, hex('#0a1430')]], r);
    const mane = smooth(0.9, 0.85, r) * smooth(0.45, 0.5, r + Math.cos(a * 14) * 0.05);
    const face = smooth(0.5, 0.45, Math.hypot(u - 0.5, (v - 0.53) * 1.1) * 2);
    const eyes = smooth(0.06, 0.03, Math.min(Math.hypot(u - 0.41, v - 0.47), Math.hypot(u - 0.59, v - 0.47)));
    const nose = smooth(0.06, 0.03, Math.hypot((u - 0.5) * 1.4, v - 0.6));
    const rim = smooth(0.03, 0, Math.abs(r - 0.94));
    const gold = clamp01(mane + face + rim);
    const n = fbm3(u * 8, v * 8, 2, 3, 91);
    const g = ramp([[0, hex('#5a3a08')], [0.6, hex('#c89a2c')], [1, hex('#ffe9a0')]], clamp01(0.4 + n * 0.5 - r * 0.2));
    const c: RGB = [mix(field[0], g[0], gold), mix(field[1], g[1], gold), mix(field[2], g[2], gold)];
    const dark = clamp01(eyes + nose);
    return [c[0] * (1 - dark * 0.8), c[1] * (1 - dark * 0.8), c[2] * (1 - dark * 0.8), 1];
  });
}

function rune(color: RGB): HTMLCanvasElement {
  const [c, g] = canvas(128, 128);
  g.strokeStyle = `rgb(${color.join(',')})`;
  g.shadowColor = `rgb(${color.join(',')})`;
  g.shadowBlur = 10;
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(64, 64, 46, 0, Math.PI * 2);
  g.moveTo(64, 22);
  g.lineTo(64, 106);
  g.moveTo(64, 46);
  g.lineTo(88, 30);
  g.moveTo(64, 70);
  g.lineTo(40, 54);
  g.moveTo(64, 86);
  g.lineTo(86, 98);
  g.stroke();
  return c;
}

function black(): HTMLCanvasElement {
  const [c, g] = canvas(32, 32);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 32, 32);
  return c;
}

function eyes(): HTMLCanvasElement {
  return shade(128, 64, (u, v) => {
    let i = 0;
    for (const cx of [0.33, 0.67]) {
      const dx = (u - cx) / 0.13, dy = (v - 0.5) / 0.09;
      const d = Math.sqrt(dx * dx + dy * dy * (1 + Math.abs(dx) * 0.6));
      i += Math.exp(-d * d * 1.6) + 0.35 * Math.exp(-d * d * 0.25);
    }
    i = clamp01(i);
    const w = clamp01(i * 1.5 - 0.6);
    return [mix(150, 255, w), 255, mix(120, 230, w), i];
  });
}

function gradient2d(): HTMLCanvasElement {
  return shade(128, 128, (u, v) => {
    const [r] = polar(u, v);
    const i = smooth(1, 0, r);
    return [255, 255, 255, i * i];
  });
}

// ---------- registry ----------

type Gen = (rows: number, cols: number) => HTMLCanvasElement;

const WHITE: RGB = [255, 255, 255];
const BLUE: RGB = [70, 150, 255];

const GENERATORS: Record<string, Gen> = {
  'textures\\clouds8x8.blp': (r, c) => clouds(r || 8, c || 8, 'white'),
  'replaceabletextures\\weather\\clouds8x8.blp': (r, c) => clouds(r || 8, c || 8, 'white'),
  'textures\\clouds8x8fade.blp': (r, c) => clouds(r || 8, c || 8, 'fade'),
  'textures\\clouds8x8fire.blp': (r, c) => clouds(r || 8, c || 8, 'fire'),
  'textures\\clouds8x8mod.blp': (r, c) => clouds(r || 8, c || 8, 'mod'),
  'textures\\clouds32_anim.blp': (r, c) => clouds(r || 8, c || 8, 'swirl'),
  'textures\\dust3.blp': () => dust(3),
  'textures\\dust3x.blp': () => cloudTile(3),
  'textures\\dust5a.blp': () => dust(5, 128, 0.6, [220, 225, 240]),
  'textures\\dust6.blp': () => dust(6, 128, 0.2),
  'textures\\flare.blp': flare,
  'textures\\genericglow64.blp': () => glow(WHITE, 64),
  'textures\\genericglowx.blp': () => glow(WHITE, 128, 1.6),
  'textures\\genericglow1.blp': () => glow(WHITE, 64, 2.6),
  'units\\creeps\\medivh\\genericglow2_mip1.blp': () => glow(WHITE, 64, 2),
  'textures\\green_glow3.blp': () => glow([60, 255, 90], 64, 1.8),
  'textures\\blue_glow2.blp': () => glow(BLUE, 64, 1.8),
  'textures\\shockwave10.blp': () => ring(WHITE, { radius: 0.8, width: 0.12, inner: 0.12 }),
  'textures\\shockwave1.blp': () => ring([255, 230, 170], { radius: 0.78, width: 0.1 }),
  'textures\\shockwave1white.blp': () => ring(WHITE, { radius: 0.78, width: 0.1 }),
  'textures\\shockwave1b.blp': () => ring([180, 210, 255], { radius: 0.8, width: 0.08 }),
  'textures\\shockwave4.blp': () => ring([255, 220, 150], { radius: 0.82, width: 0.06, double: true }),
  'textures\\shockwave4white.blp': () => ring(WHITE, { radius: 0.82, width: 0.06, double: true }),
  'textures\\shockwave9.blp': () => ring(WHITE, { radius: 0.7, width: 0.2, inner: 0.25, noise: 0.45 }),
  'textures\\shockwave11.blp': () => ring(WHITE, { radius: 0.85, width: 0.07, noise: 0.5 }),
  'textures\\shockwave_blue.blp': () => ring(BLUE, { radius: 0.8, width: 0.1 }),
  'textures\\shockwave_ice1.blp': () => ring([150, 210, 255], { radius: 0.78, width: 0.14, ice: true }),
  'textures\\shockwavewater1.blp': () => ring([90, 170, 255], { radius: 0.8, width: 0.12, noise: 0.5 }),
  'textures\\star2.blp': () => star(2, WHITE, { halo: 0.2 }),
  'textures\\star4.blp': () => star(2, WHITE, { spike: 0.02, halo: 0.45 }),
  'textures\\star7b.blp': () => star(4, WHITE, { diag: 0.45, halo: 0.3 }),
  'textures\\blue_star2.blp': () => star(2, BLUE, { halo: 0.35 }),
  'textures\\yellow_star_dim.blp': () => star(2, [255, 220, 90], { halo: 0.25, core: 0.6 }),
  'ui\\glues\\singleplayer\\nightelf_exp\\star10_alpha.blp': () => star(4, WHITE, { diag: 0.3, halo: 0.25 }),
  'textures\\white_64_foam1.blp': foam,
  'textures\\flame4.blp': flame,
  'textures\\zap1.blp': zap,
  'textures\\lightningball.blp': () => electricTile(256, 4, 4, [110, 170, 255], 101),
  'abilities\\spells\\human\\thunderclap\\lightning2b.blp': () => electricTile(256, 2, 6, [140, 190, 255], 103),
  'textures\\tornado2b.blp': () => streaks(128, [235, 240, 255], 105),
  'textures\\ribbonne1_blue.blp': () => ribbon(BLUE),
  'textures\\frost2.blp': () => frost(107),
  'textures\\frost3.blp': () => frost(109, 0.7),
  'textures\\grad2d.blp': gradient2d,
  'replaceabletextures\\splats\\thunderclapubersplat.blp': crackSplat,
  'textures\\rock64.blp': rock,
  'textures\\black32.blp': black,
  'abilities\\spells\\nightelf\\shadowstrike\\eyes.blp': eyes,
  'replaceabletextures\\water\\c_water00.blp': water,
  'ui\\glues\\singleplayer\\humancampaign3d\\anyhandlecoppermetal.blp': () => metal([150, 78, 38], [255, 190, 120], 111, 6),
  'ui\\glues\\singleplayer\\humancampaign3d\\humancampaignlionhead.blp': lionEmblem,
  'doodads\\dungeon\\props\\azsharastatue\\azshara.blp': () => stone([70, 128, 120], [220, 190, 110], 113),
  'ui\\glues\\singleplayer\\undead3d_exp\\frostmorne.blp': () => metal([120, 140, 165], [235, 245, 255], 115),
  'abilities\\spells\\human\\massteleport\\rune1.blp': () => rune([110, 190, 255]),
  'textures\\trollsymbol1.blp': () => rune([255, 200, 90]),
  'textures\\glaivethrower.blp': () => metal([150, 160, 190], [240, 245, 255], 117),
};

export const openTextureKey = (path: string) => path.toLowerCase().replace(/\//g, '\\').replace(/\.(tga|dds|png)$/, '.blp');

/** True when the pack has a hand-written generator for this original path. */
export function hasOpenTexture(path: string): boolean {
  return openTextureKey(path) in GENERATORS;
}

/** Generates the open replacement for an original texture path, or null if the pack has none. */
export function openTextureCanvas(path: string, rows = 1, cols = 1): HTMLCanvasElement | null {
  const gen = GENERATORS[openTextureKey(path)];
  return gen ? gen(rows > 1 ? rows : 0, cols > 1 ? cols : 0) : null;
}

/** All original paths covered by the generators (for the dev gallery). */
export const OPEN_TEXTURE_PATHS = Object.keys(GENERATORS);
