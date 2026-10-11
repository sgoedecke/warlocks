// Procedural 8x8 cloud flipbooks for the fire and smoke particles.
import { clamp01, fbm3, smooth } from './noise';

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

/** An 8x8 billowing cloud sprite sheet (64px cells). `fade` thins out over the frames, for smoke. */
export function cloudFlipbook(kind: 'white' | 'fade'): HTMLCanvasElement {
  return flipbook(8, 8, 64, (u, v, t, i) => {
    const seed = (i % 7) * 0.13 + 1;
    const p = puff(u, v, t, seed, 0.25, kind === 'fade' ? 0.5 : 0.3);
    const shadeN = fbm3(u * 6, v * 6, seed + t * 2, 3, 2);
    const lum = 185 + shadeN * 70 - smooth(0.2, 0.9, v) * 25;
    const a = p * (kind === 'fade' ? Math.pow(1 - t, 0.8) : 0.95);
    return [lum, lum, lum * 1.02, a];
  });
}
