import { ALL_SPELLS, ITEMS, SPELLS, type SpellId } from '../config';
import { assets } from '../assets/store';

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
      const a = Math.max(0, 1 - d - (n - 0.5) * 0.8);
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

type IconPainter = (g: CanvasRenderingContext2D, s: number) => void;

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

const ICONS: Partial<Record<SpellId, IconPainter>> = {
  fireball: (g, s) => {
    bg(g, s, '#5a1200', '#120200');
    g.save();
    g.translate(s * 0.58, s * 0.42);
    g.rotate(Math.PI * 0.75);
    for (let i = 0; i < 6; i++) {
      g.fillStyle = `rgba(255,${80 + i * 25},0,${0.35 - i * 0.04})`;
      g.beginPath();
      g.ellipse(0, s * (0.08 + i * 0.05), s * (0.2 - i * 0.022), s * (0.24 + i * 0.03), 0, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    glowBall(g, s * 0.58, s * 0.42, s * 0.24, [[0, '#fffbe0'], [0.3, '#ffd040'], [0.7, '#ff6a00'], [1, 'rgba(160,20,0,0)']]);
  },
  lightning: (g, s) => {
    bg(g, s, '#1a3a8a', '#020818');
    const pts = [[0.62, 0.05], [0.38, 0.45], [0.55, 0.47], [0.3, 0.95], [0.72, 0.4], [0.52, 0.38], [0.7, 0.05]];
    g.shadowColor = '#9cf';
    g.shadowBlur = s * 0.15;
    g.fillStyle = '#e8f6ff';
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)));
    g.closePath();
    g.fill();
    g.shadowBlur = 0;
  },
  homing: (g, s) => {
    bg(g, s, '#2c5410', '#040a02');
    g.strokeStyle = 'rgba(160,255,90,0.55)';
    g.lineWidth = s * 0.07;
    g.beginPath();
    g.moveTo(s * 0.12, s * 0.85);
    g.bezierCurveTo(s * 0.2, s * 0.3, s * 0.6, s * 0.9, s * 0.66, s * 0.38);
    g.stroke();
    glowBall(g, s * 0.68, s * 0.33, s * 0.22, [[0, '#ffffff'], [0.3, '#d6ff6a'], [0.7, '#4fc010'], [1, 'rgba(20,80,0,0)']]);
  },
  boomerang: (g, s) => {
    bg(g, s, '#6a5030', '#120a04');
    g.save();
    g.translate(s / 2, s / 2);
    g.rotate(-0.5);
    const blade = g.createLinearGradient(-s * 0.4, 0, s * 0.4, 0);
    blade.addColorStop(0, '#d8d8e0');
    blade.addColorStop(0.5, '#8a8a98');
    blade.addColorStop(1, '#f0f0ff');
    g.fillStyle = blade;
    g.strokeStyle = '#222';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(-s * 0.38, s * 0.12);
    g.quadraticCurveTo(0, -s * 0.45, s * 0.38, s * 0.12);
    g.quadraticCurveTo(0, -s * 0.18, -s * 0.38, s * 0.12);
    g.fill();
    g.stroke();
    g.restore();
  },
  meteor: (g, s) => {
    bg(g, s, '#2a1030', '#050208');
    g.save();
    g.translate(s * 0.6, s * 0.62);
    g.rotate(-Math.PI * 0.25);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = `rgba(255,${120 + i * 20},20,${0.5 - i * 0.08})`;
      g.beginPath();
      g.ellipse(0, -s * (0.12 + i * 0.07), s * (0.17 - i * 0.02), s * (0.2 + i * 0.05), 0, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    glowBall(g, s * 0.6, s * 0.62, s * 0.17, [[0, '#ffd27a'], [0.5, '#7a3410'], [1, '#2a1004']]);
  },
  gravity: (g, s) => {
    bg(g, s, '#3a0a5a', '#050008');
    g.strokeStyle = '#d090ff';
    g.lineWidth = s * 0.045;
    g.shadowColor = '#b060ff';
    g.shadowBlur = s * 0.1;
    for (let arm = 0; arm < 3; arm++) {
      g.beginPath();
      for (let t = 0; t < 1; t += 0.02) {
        const a = arm * ((Math.PI * 2) / 3) + t * 5;
        const r = s * 0.42 * t;
        const x = s / 2 + Math.cos(a) * r;
        const y = s / 2 + Math.sin(a) * r;
        if (t === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.shadowBlur = 0;
    glowBall(g, s / 2, s / 2, s * 0.12, [[0, '#000'], [0.7, '#100018'], [1, 'rgba(200,120,255,0.6)']]);
  },
  link: (g, s) => {
    bg(g, s, '#505058', '#0c0c10');
    g.lineWidth = s * 0.07;
    for (let i = 0; i < 4; i++) {
      const x = s * (0.2 + i * 0.2);
      const y = s * (0.8 - i * 0.2);
      g.strokeStyle = i % 2 ? '#9a9aa8' : '#d8d8e4';
      g.beginPath();
      g.ellipse(x, y, s * 0.13, s * 0.07, -Math.PI / 4 + (i % 2 ? Math.PI / 2 : 0), 0, Math.PI * 2);
      g.stroke();
    }
  },
  displacement: (g, s) => {
    bg(g, s, '#0a5a5a', '#010c0c');
    g.strokeStyle = '#aaffff';
    g.fillStyle = '#aaffff';
    g.lineWidth = s * 0.07;
    g.shadowColor = '#4ff';
    g.shadowBlur = s * 0.1;
    for (const dir of [1, -1]) {
      g.beginPath();
      g.arc(s / 2, s / 2, s * 0.28, dir > 0 ? Math.PI * 1.1 : Math.PI * 0.1, dir > 0 ? Math.PI * 1.85 : Math.PI * 0.85);
      g.stroke();
      const a = dir > 0 ? Math.PI * 1.85 : Math.PI * 0.85;
      const x = s / 2 + Math.cos(a) * s * 0.28;
      const y = s / 2 + Math.sin(a) * s * 0.28;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * s * 0.12, y + Math.sin(a) * s * 0.12);
      g.lineTo(x - Math.cos(a) * s * 0.12, y - Math.sin(a) * s * 0.12);
      g.lineTo(x + Math.cos(a + Math.PI / 2) * s * 0.14, y + Math.sin(a + Math.PI / 2) * s * 0.14);
      g.fill();
    }
    g.shadowBlur = 0;
  },
  teleport: (g, s) => {
    bg(g, s, '#1a40a0', '#02040e');
    g.fillStyle = '#ffffff';
    g.shadowColor = '#8cf';
    g.shadowBlur = s * 0.15;
    g.save();
    g.translate(s / 2, s / 2);
    for (let i = 0; i < 8; i++) {
      g.rotate(Math.PI / 4);
      g.beginPath();
      g.moveTo(0, -s * (i % 2 ? 0.22 : 0.4));
      g.lineTo(s * 0.04, 0);
      g.lineTo(-s * 0.04, 0);
      g.fill();
    }
    g.restore();
    glowBall(g, s / 2, s / 2, s * 0.14, [[0, '#fff'], [1, 'rgba(120,180,255,0)']]);
    g.shadowBlur = 0;
  },
  thrust: (g, s) => {
    bg(g, s, '#6a2a10', '#100402');
    g.strokeStyle = 'rgba(255,220,160,0.6)';
    g.lineWidth = s * 0.03;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.moveTo(s * 0.08, s * (0.3 + i * 0.12));
      g.lineTo(s * 0.45, s * (0.3 + i * 0.12));
      g.stroke();
    }
    g.fillStyle = '#ffe0a0';
    g.strokeStyle = '#3a1800';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(s * 0.4, s * 0.35);
    g.lineTo(s * 0.68, s * 0.35);
    g.lineTo(s * 0.68, s * 0.2);
    g.lineTo(s * 0.92, s * 0.5);
    g.lineTo(s * 0.68, s * 0.8);
    g.lineTo(s * 0.68, s * 0.65);
    g.lineTo(s * 0.4, s * 0.65);
    g.closePath();
    g.fill();
    g.stroke();
  },
  shield: (g, s) => {
    bg(g, s, '#1a3a6a', '#02060c');
    const grd = g.createLinearGradient(0, s * 0.15, 0, s * 0.9);
    grd.addColorStop(0, '#e0f0ff');
    grd.addColorStop(1, '#3070c0');
    g.fillStyle = grd;
    g.strokeStyle = '#ffd860';
    g.lineWidth = s * 0.05;
    g.beginPath();
    g.moveTo(s * 0.5, s * 0.12);
    g.lineTo(s * 0.82, s * 0.24);
    g.quadraticCurveTo(s * 0.82, s * 0.7, s * 0.5, s * 0.9);
    g.quadraticCurveTo(s * 0.18, s * 0.7, s * 0.18, s * 0.24);
    g.closePath();
    g.fill();
    g.stroke();
  },
  windwalk: (g, s) => {
    bg(g, s, '#3a5a5a', '#060a0a');
    g.strokeStyle = 'rgba(220,255,250,0.85)';
    g.lineWidth = s * 0.05;
    g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const y = s * (0.3 + i * 0.2);
      g.beginPath();
      g.moveTo(s * 0.12, y);
      g.bezierCurveTo(s * 0.4, y - s * 0.12, s * 0.6, y + s * 0.12, s * (0.72 + i * 0.05), y);
      g.arc(s * (0.72 + i * 0.05), y - s * 0.06, s * 0.06, Math.PI / 2, -Math.PI / 2, true);
      g.stroke();
    }
  },
};

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
    bg(g, size, `hsl(${hue},45%,28%)`, `hsl(${hue},50%,6%)`);
    glowBall(g, size / 2, size / 2, size * 0.3, [[0, '#fff'], [0.4, `hsl(${hue},80%,65%)`], [1, 'rgba(0,0,0,0)']]);
    g.fillStyle = '#fff6d0';
    g.font = `bold ${Math.floor(size * 0.24)}px serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name.replace(/[^A-Z]/g, '').slice(0, 2) || name.slice(0, 2), size / 2, size / 2);
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
    const paint = ICONS[id] ?? ((gg: CanvasRenderingContext2D, s: number) => {
      bg(gg, s, '#2a1f45', '#05030a');
      glowBall(gg, s / 2, s / 2, s * 0.34, [[0, '#fff'], [0.35, '#ffd060'], [0.75, '#8040ff'], [1, 'rgba(0,0,0,0)']]);
      gg.fillStyle = '#fff6b0';
      gg.font = `bold ${Math.floor(s * 0.22)}px serif`;
      gg.textAlign = 'center';
      gg.textBaseline = 'middle';
      gg.fillText(id.slice(0, 2).toUpperCase(), s / 2, s / 2);
    });
    paint(g, size);
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
