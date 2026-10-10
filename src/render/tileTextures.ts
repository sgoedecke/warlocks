// Procedural stand-ins for WC3 ground tile textures, laid out exactly like the real
// TerrainArt BLPs (512x256 "extended" atlas: left 4x4 cells are corner-blend variants
// indexed by bitset BR=1 BL=2 TR=4 TL=8, right 4x4 cells are full-tile variations).
// Each 64px cell is one 128-unit tile. RGB is kept even where alpha is 0, because the
// bottom layer of a tile is drawn ignoring alpha.

export const ATLAS_W = 512;
export const ATLAS_H = 256;
const CELL = 64;

type RGB = [number, number, number];

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise that wraps with the given lattice period, so a cell tiles seamlessly. */
function pnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const w = (v: number) => ((v % period) + period) % period;
  const a = hash2(w(xi), w(yi), seed), b = hash2(w(xi + 1), w(yi), seed);
  const c = hash2(w(xi), w(yi + 1), seed), d = hash2(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

// Number of tiles one (u,v) unit spans. 1 for atlas cells; larger for the world-space
// texture, which keeps the same feature size but only repeats every SPAN tiles.
let SPAN = 1;

/** Periodic fbm over a cell; (u,v) in [0,1). */
function pfbm(u: number, v: number, base: number, oct: number, seed: number): number {
  let s = 0, a = 0.5, n = 0, p = base * SPAN;
  for (let i = 0; i < oct; i++) {
    s += a * pnoise(u * p, v * p, p, seed + i * 31);
    n += a;
    a *= 0.5;
    p *= 2;
  }
  return s / n;
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const hex = (h: number): RGB => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

/** Shade function: (u,v) within a tile in [0,1), variation index (0 = plain). */
type Shader = (u: number, v: number, variation: number) => RGB;

function crackField(u: number, v: number, seed: number, scale: number): number {
  // Ridged periodic noise gives vein-like cracks.
  const n = pfbm(u, v, scale, 3, seed);
  return 1 - Math.abs(n - 0.5) * 2;
}

const SHADERS: Record<string, Shader> = {
  // Dungeon - Lava: molten orange with drifting dark crust.
  Dlav: (u, v, k) => {
    const n = pfbm(u, v, 1, 5, 11 + k * 3);
    const swirl = pfbm(u + n * 0.15, v - n * 0.15, 2, 4, 13 + k);
    const veins = Math.pow(crackField(u, v, 17 + k, 2), 6);
    let c = mix(hex(0xe85a0c), hex(0xffb030), sstep(0.3, 0.75, swirl));
    c = mix(c, hex(0xffe27a), veins * 0.6);
    return mix(c, hex(0x7a2006), sstep(0.58, 0.78, n) * 0.6);
  },
  // Dungeon - Lava Cracks: dark basalt split by glowing seams.
  Dlvc: (u, v, k) => {
    const n = pfbm(u, v, 2, 4, 21 + k);
    const cr = Math.pow(crackField(u, v, 29 + k * 5, 2), 10);
    const rock = mix(hex(0x2d2622), hex(0x4a3e36), n);
    return mix(rock, hex(0xff7a10), Math.min(1, cr * 1.6));
  },
  // Underground - Lava Cracks: brown rock with thinner red cracks.
  Glvc: (u, v, k) => {
    const n = pfbm(u, v, 2, 4, 41 + k);
    const cr = Math.pow(crackField(u, v, 47 + k * 5, 2), 14);
    const rock = mix(hex(0x3a2a1e), hex(0x5c4430), n);
    return mix(rock, hex(0xe8400c), Math.min(1, cr * 1.8));
  },
  // Felwood - Poison: green toxic sludge.
  Cpos: (u, v, k) => {
    const n = pfbm(u, v, 2, 4, 61 + k);
    const b = Math.pow(crackField(u, v, 67 + k, 3), 6);
    let c = mix(hex(0x3d6a12), hex(0x8ec22a), n);
    return mix(c, hex(0xb8e050), b * 0.45);
  },
  // Ashenvale - Rough Dirt.
  Adrd: (u, v, k) => {
    const n = pfbm(u, v, 2, 5, 81 + k);
    let c = mix(hex(0x4e3a26), hex(0x7a5c3c), n);
    const peb = pfbm(u, v, 8, 2, 89 + k);
    return mix(c, hex(0x9a8064), sstep(0.68, 0.72, peb) * 0.7);
  },
  // Ashenvale - Lumpy Grass.
  Agrd: (u, v, k) => {
    const n = pfbm(u, v, 2, 5, 101 + k);
    const lumps = pfbm(u, v, 4, 2, 107 + k);
    let c = mix(hex(0x24401a), hex(0x4a6e2a), n);
    return mix(c, hex(0x1a2c12), sstep(0.55, 0.75, lumps) * 0.5);
  },
  // Ashenvale - Grass.
  Agrs: (u, v, k) => {
    const n = pfbm(u, v, 2, 5, 121 + k);
    const blades = pfbm(u, v, 16, 2, 127 + k);
    return mix(mix(hex(0x2e5420), hex(0x5a8434), n), hex(0x7aa048), sstep(0.6, 0.8, blades) * 0.5);
  },
  // Northrend - Grass: dull olive with snow-bleached patches.
  Ngrs: (u, v, k) => {
    const n = pfbm(u, v, 2, 5, 141 + k);
    const dry = pfbm(u, v, 4, 3, 147 + k);
    return mix(mix(hex(0x46502a), hex(0x6e7444), n), hex(0x8c8a66), sstep(0.6, 0.75, dry) * 0.6);
  },
  // Outland - Rough Dirt: cracked red earth.
  Odtr: (u, v, k) => {
    const n = pfbm(u, v, 2, 5, 161 + k);
    const cr = Math.pow(crackField(u, v, 167 + k, 2), 16);
    return mix(mix(hex(0x6a3f26), hex(0x9a643c), n), hex(0x3a2014), cr * 0.8);
  },
  // Dalaran Ruins - White Marble: 2x2 pale slabs per tile with dark grout.
  Jwmb: (u, v, k) => {
    const n = pfbm(u, v, 2, 5, 181 + k);
    const vein = Math.pow(crackField(u, v, 187 + k, 2), 18);
    const su = (u * 2 * SPAN) % 1, sv = (v * 2 * SPAN) % 1;
    const grout = Math.min(su, 1 - su, sv, 1 - sv);
    const slab = hash2(Math.floor(u * 2 * SPAN), Math.floor(v * 2 * SPAN), 191 + k);
    let c = mix(hex(0xa8a39a), hex(0xd2cec4), n * 0.7 + slab * 0.3);
    c = mix(c, hex(0x8a857c), vein * 0.6);
    c = mix(hex(0x4a463e), c, sstep(0.015, 0.05, grout));
    return c;
  },
  // Icecrown - Dark Ice.
  Idki: (u, v, k) => {
    const n = pfbm(u, v, 2, 5, 201 + k);
    const streak = Math.pow(crackField(u * 0.5 + v * 0.5, v, 207 + k, 2), 12);
    return mix(mix(hex(0x1c3a5c), hex(0x3a6890), n), hex(0xb8d8f0), streak * 0.7);
  },
};

/** Alpha for a corner-blend variant; continuous across tile borders. */
function cornerAlpha(bits: number, u: number, v: number, seed: number): number {
  if (bits === 0 || bits === 15) return 1;
  // image space: TL(0,0)=8, TR(1,0)=4, BL(0,1)=2, BR(1,1)=1
  const tl = bits & 8 ? 1 : 0, tr = bits & 4 ? 1 : 0, bl = bits & 2 ? 1 : 0, br = bits & 1 ? 1 : 0;
  const m = tl * (1 - u) * (1 - v) + tr * u * (1 - v) + bl * (1 - u) * v + br * u * v;
  const wob = (pfbm(u, v, 3, 3, seed) - 0.5) * 0.55 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
  return sstep(0.44, 0.56, m + wob);
}

const atlasCache = new Map<string, Uint8Array>();

/** 512x256 RGBA atlas in WC3 extended tile layout. Unknown codes get a neutral dirt. */
export function proceduralTileAtlas(code: string): Uint8Array {
  const hit = atlasCache.get(code);
  if (hit) return hit;
  const shade = SHADERS[code] ?? SHADERS.Adrd;
  const seed = [...code].reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7);
  const out = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 8; cx++) {
    const extended = cx >= 4;
    const bits = extended ? -1 : cy * 4 + cx;
    const variation = extended ? cy * 4 + (cx - 4) : 0;
    // Extended variations are the plain tile with a little extra interior detail, so they
    // never seam against their neighbours.
    const detail = extended && variation % 4 === 3 ? variation + 1 : 0;
    for (let py = 0; py < CELL; py++) for (let px = 0; px < CELL; px++) {
      const u = (px + 0.5) / CELL, v = (py + 0.5) / CELL;
      let [r, g, b] = shade(u, v, 0);
      if (detail) {
        const m = 1 - 0.22 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * sstep(0.5, 0.7, pfbm(u, v, 4, 2, seed + detail));
        r *= m; g *= m; b *= m;
      }
      const a = extended ? 1 : cornerAlpha(bits, u, v, seed);
      const i = ((cy * CELL + py) * ATLAS_W + cx * CELL + px) * 4;
      out[i] = Math.max(0, Math.min(255, r));
      out[i + 1] = Math.max(0, Math.min(255, g));
      out[i + 2] = Math.max(0, Math.min(255, b));
      out[i + 3] = Math.round(a * 255);
    }
  }
  atlasCache.set(code, out);
  return out;
}

export const WORLD_TILES = 8;
export const WORLD_PX = 512;
const worldCache = new Map<string, Uint8Array>();

/**
 * Seamless texture covering WORLD_TILES x WORLD_TILES tiles. Without the real tile art the
 * terrain takes its colour from this, so the procedural pattern doesn't visibly repeat on
 * every 128-unit tile; the atlas still supplies WC3's corner-blend shapes.
 */
export function proceduralWorldTexture(code: string): Uint8Array {
  const hit = worldCache.get(code);
  if (hit) return hit;
  const shade = SHADERS[code] ?? SHADERS.Adrd;
  const out = new Uint8Array(WORLD_PX * WORLD_PX * 4);
  SPAN = WORLD_TILES;
  try {
    for (let py = 0; py < WORLD_PX; py++) for (let px = 0; px < WORLD_PX; px++) {
      const [r, g, b] = shade((px + 0.5) / WORLD_PX, (py + 0.5) / WORLD_PX, 0);
      const i = (py * WORLD_PX + px) * 4;
      out[i] = Math.max(0, Math.min(255, r));
      out[i + 1] = Math.max(0, Math.min(255, g));
      out[i + 2] = Math.max(0, Math.min(255, b));
      out[i + 3] = 255;
    }
  } finally {
    SPAN = 1;
  }
  worldCache.set(code, out);
  return out;
}
