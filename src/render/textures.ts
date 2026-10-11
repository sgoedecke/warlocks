import { ALL_SPELLS, ITEMS, SPELLS, type SpellId } from '../config';
import { assets } from '../assets/store';
import { paintOpenIcon } from './opentex/icons';

// ---------- noise helpers ----------
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number, period: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const w = (i: number) => ((i % period) + period) % period;
  const a = hash(w(xi), w(yi), seed);
  const b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed);
  const d = hash(w(xi + 1), w(yi + 1), seed);
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Tileable fractal noise; x,y in [0,1)
function fbm(x: number, y: number, seed: number, baseFreq: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = baseFreq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * f, y * f, seed + o * 17, f);
    f *= 2;
    amp *= 0.5;
  }
  return sum;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

// ---------- terrain ----------

export function makeGlowTexture(size = 64, hardness = 0): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25 + hardness * 0.4, 'rgba(255,255,255,0.75)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

export function makeShadowTexture(size = 64): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(0,0,0,0.75)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.5)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

export function makeScorchTexture(size = 128): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = x / size - 0.5;
      const dy = y / size - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const n = fbm(x / size, y / size, 91, 6, 4);
      const a = Math.max(0, 1 - d - (n - 0.5) * 0.8) * Math.min(1, Math.max(0, (1 - d) * 3));
      const i = (y * size + x) * 4;
      img.data[i] = 15;
      img.data[i + 1] = 10;
      img.data[i + 2] = 8;
      img.data[i + 3] = Math.min(255, a * 1.6 * 255);
    }
  g.putImageData(img, 0, 0);
  return c;
}

// WC3 style selection circle: a thin bright ring.
export function makeRingTexture(size = 128, width = 0.08): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  g.strokeStyle = 'white';
  g.lineWidth = size * width;
  g.shadowColor = 'white';
  g.shadowBlur = size * 0.04;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - size * width, 0, Math.PI * 2);
  g.stroke();
  return c;
}

// ---------- icons ----------

function bg(g: CanvasRenderingContext2D, s: number, inner: string, outer: string) {
  const grd = g.createRadialGradient(s * 0.45, s * 0.4, 2, s / 2, s / 2, s * 0.75);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
}

function glowBall(g: CanvasRenderingContext2D, x: number, y: number, r: number, stops: [number, string][]) {
  const grd = g.createRadialGradient(x, y, 0, x, y, r);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

function bevel(g: CanvasRenderingContext2D, s: number) {
  // WC3 icon frame: thin dark outline with light top-left and dark bottom-right bevel.
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.beginPath();
  g.moveTo(1.5, s - 1.5);
  g.lineTo(1.5, 1.5);
  g.lineTo(s - 1.5, 1.5);
  g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.beginPath();
  g.moveTo(s - 1.5, 1.5);
  g.lineTo(s - 1.5, s - 1.5);
  g.lineTo(1.5, s - 1.5);
  g.stroke();
  g.lineWidth = 1;
  g.strokeStyle = '#000';
  g.strokeRect(0.5, 0.5, s - 1, s - 1);
}

const iconCache = new Map<string, string>();

const realIcons = new Map<string, HTMLCanvasElement>();
const iconKey = (path: string) => path.toLowerCase().replace(/\//g, '\\');

/** Loads the original BTN icons that are present in the user's archives. */
export async function loadRealIcons(extraPaths: string[] = []): Promise<void> {
  realIcons.clear();
  iconCache.clear();
  const paths = new Set([...ALL_SPELLS.map((id) => SPELLS[id].icon), ...Object.values(ITEMS).map((i) => i.icon), ...extraPaths]);
  await Promise.all([...paths].map(async (path) => {
    if (!assets.has(path)) return;
    const tex = await assets.texture(path);
    const img = tex?.image as { data: Uint8ClampedArray | Uint8Array; width: number; height: number } | undefined;
    if (!img?.data) return;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    realIcons.set(iconKey(path), c);
  }));
  iconCache.clear();
}

function realIconUrl(path: string, size: number): string | null {
  const real = realIcons.get(iconKey(path));
  if (!real) return null;
  const key = `${iconKey(path)}:${size}`;
  let url = iconCache.get(key);
  if (!url) {
    const [c, g] = makeCanvas(size, size);
    g.drawImage(real, 0, 0, size, size);
    url = c.toDataURL();
    iconCache.set(key, url);
  }
  return url;
}

/** A command button icon by its WC3 path: the original if loaded, else a generic stand-in. */
export function btnIcon(path: string, size = 64): string {
  const real = realIconUrl(path, size);
  if (real) return real;
  const key = `btn:${iconKey(path)}:${size}`;
  let url = iconCache.get(key);
  if (!url) {
    const name = (path.split('\\').pop() ?? '').replace(/^(PAS)?BTN|\.blp$/gi, '');
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = h % 360;
    const [c, g] = makeCanvas(size, size);
    if (!paintOpenIcon(path, g, size)) {
      bg(g, size, `hsl(${hue},45%,28%)`, `hsl(${hue},50%,6%)`);
      glowBall(g, size / 2, size / 2, size * 0.3, [[0, '#fff'], [0.4, `hsl(${hue},80%,65%)`], [1, 'rgba(0,0,0,0)']]);
      g.fillStyle = '#fff6d0';
      g.font = `bold ${Math.floor(size * 0.24)}px serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(name.replace(/[^A-Z]/g, '').slice(0, 2) || name.slice(0, 2), size / 2, size / 2);
    }
    bevel(g, size);
    url = c.toDataURL();
    iconCache.set(key, url);
  }
  return url;
}

export function spellIcon(id: SpellId, size = 64): string {
  const real = realIconUrl(SPELLS[id].icon, size);
  if (real) return real;
  const key = `${id}:${size}`;
  let url = iconCache.get(key);
  if (!url) {
    const [c, g] = makeCanvas(size, size);
    if (!paintOpenIcon(SPELLS[id].icon, g, size)) {
      bg(g, size, '#2a1f45', '#05030a');
      glowBall(g, size / 2, size / 2, size * 0.34, [[0, '#fff'], [0.35, '#ffd060'], [0.75, '#8040ff'], [1, 'rgba(0,0,0,0)']]);
      g.fillStyle = '#fff6b0';
      g.font = `bold ${Math.floor(size * 0.22)}px serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(id.slice(0, 2).toUpperCase(), size / 2, size / 2);
    }
    bevel(g, size);
    url = c.toDataURL();
    iconCache.set(key, url);
  }
  return url;
}

// ---------- cursors ----------

export function makeCursor(kind: 'normal' | 'target' | 'targetEnemy'): string {
  const s = 32;
  const [c, g] = makeCanvas(s, s);
  if (kind === 'normal') {
    // Golden gauntlet-ish pointer.
    g.beginPath();
    g.moveTo(2, 2);
    g.lineTo(22, 12);
    g.lineTo(14, 15);
    g.lineTo(20, 26);
    g.lineTo(16, 28);
    g.lineTo(10, 17);
    g.lineTo(4, 22);
    g.closePath();
    const grd = g.createLinearGradient(0, 0, 24, 28);
    grd.addColorStop(0, '#fff6c0');
    grd.addColorStop(0.5, '#d4a020');
    grd.addColorStop(1, '#6a4808');
    g.fillStyle = grd;
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = '#1a1000';
    g.stroke();
    return `url(${c.toDataURL()}) 2 2, default`;
  }
  const col = kind === 'target' ? '#30ff30' : '#ff3030';
  g.strokeStyle = '#000';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(16, 16, 10, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = col;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(16, 16, 10, 0, Math.PI * 2);
  g.stroke();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    g.strokeStyle = '#000';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(16 + dx * 6, 16 + dy * 6);
    g.lineTo(16 + dx * 15, 16 + dy * 15);
    g.stroke();
    g.strokeStyle = col;
    g.lineWidth = 2;
    g.stroke();
  }
  return `url(${c.toDataURL()}) 16 16, crosshair`;
}

export function goldIcon(): string {
  const [c, g] = makeCanvas(32, 32);
  glowBall(g, 16, 16, 12, [[0, '#fff6b0'], [0.5, '#e0b020'], [0.9, '#7a5000'], [1, '#3a2400']]);
  g.strokeStyle = '#5a3a00';
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(16, 16, 7, 0, Math.PI * 2);
  g.stroke();
  return c.toDataURL();
}
