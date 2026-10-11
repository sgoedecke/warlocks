// Small deterministic noise toolkit for the procedural textures.

export function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);
const wrap = (i: number, p: number) => (p > 0 ? ((i % p) + p) % p : i);

/** Value noise in [0,1). Optional periods make it tile on x/y. */
export function noise3(x: number, y: number, z: number, seed = 0, px = 0, py = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const x0 = wrap(xi, px), x1 = wrap(xi + 1, px), y0 = wrap(yi, py), y1 = wrap(yi + 1, py);
  const s = seed * 7919;
  const c = (a: number, b: number, cc: number) => hash3(a + s, b - s, cc);
  const l0 = c(x0, y0, zi) + (c(x1, y0, zi) - c(x0, y0, zi)) * u;
  const l1 = c(x0, y1, zi) + (c(x1, y1, zi) - c(x0, y1, zi)) * u;
  const l2 = c(x0, y0, zi + 1) + (c(x1, y0, zi + 1) - c(x0, y0, zi + 1)) * u;
  const l3 = c(x0, y1, zi + 1) + (c(x1, y1, zi + 1) - c(x0, y1, zi + 1)) * u;
  const a = l0 + (l1 - l0) * v;
  const b = l2 + (l3 - l2) * v;
  return a + (b - a) * w;
}

/** Fractal value noise, roughly in [0,1). With periods, x/y tile at `px`/`py` base cells. */
export function fbm3(x: number, y: number, z: number, octaves = 4, seed = 0, px = 0, py = 0): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise3(x * f, y * f, z * f, seed + o * 31, px * f, py * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Ridged noise: sharp bright creases, good for electricity, cracks and ice. */
export function ridged3(x: number, y: number, z: number, octaves = 4, seed = 0, px = 0, py = 0): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise3(x * f, y * f, z * f, seed + o * 31, px * f, py * f) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
