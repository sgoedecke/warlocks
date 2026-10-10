// Open texture pack: skins for unit models, baked onto the model's own UV layout.
//
// Unit textures (robes, armour, hoods...) only make sense in the UV layout of the model
// that uses them. Instead of shipping painted copies of Blizzard's skins, we rasterise each
// geoset's triangles into texture space and colour every texel procedurally from its 3D
// bind-pose position, normal, height and distance to the UV island edge. The result is our
// own artwork that lines up with whatever model the player loads.
import { clamp01, fbm3, hex, mix, ridged3, smooth, type RGB } from './noise';
import { openTextureKey } from './particles';

interface GeosetLike { vertices: Float32Array; normals: Float32Array; uvSets: Float32Array[]; faces: Uint16Array | Uint32Array; materialId: number }
interface LayerLike { textureId: number; filterMode: number }
interface ModelLike {
  geosets: GeosetLike[];
  materials: { layers: LayerLike[] }[];
  textures: { replaceableId: number; path: string }[];
}

/** Everything a skin recipe knows about one texel. */
export interface Texel {
  /** Bind-pose model-space position (WC3: x forward, y left, z up). */
  p: [number, number, number];
  /** Unit normal. */
  n: [number, number, number];
  /** Height, 0 at the model's feet and 1 at the top of its opaque geometry. */
  h: number;
  /** Distance in texels (at 512px) to the edge of the UV island. */
  edge: number;
  /** Baked light term, ~0.35..1.15. */
  light: number;
  /** True when this layer is drawn over team colour, so alpha reveals the team colour. */
  overlay: boolean;
  geoset: number;
}

type Recipe = (t: Texel) => [number, number, number, number];

const SIZE = 512;
const LIGHT = (() => {
  const v = [0.45, 0.25, 0.86];
  const l = Math.hypot(v[0], v[1], v[2]);
  return v.map((x) => x / l);
})();

const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const blend = (a: RGB, b: RGB, t: number): RGB => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const rgba = (c: RGB, a = 1): [number, number, number, number] => [c[0], c[1], c[2], a];

// ---------- material building blocks ----------

/** Folded cloth: vertical folds that follow the angle around the body axis. */
function cloth(t: Texel, base: RGB, seed: number): RGB {
  const [x, y, z] = t.p;
  const theta = Math.atan2(y, x);
  const fold = fbm3(theta * 2.6 + 9, z * 0.022, seed, 4, seed);
  const weave = fbm3(x * 0.4, y * 0.4, z * 0.4, 2, seed + 3);
  const k = (0.62 + fold * 0.62) * (0.92 + weave * 0.12) * t.light;
  return scale(base, k);
}

/** Polished metal: strong light response with a little tarnish. */
function metal(t: Texel, base: RGB, hi: RGB, seed: number): RGB {
  const [x, y, z] = t.p;
  const tarnish = fbm3(x * 0.15, y * 0.15, z * 0.15, 3, seed);
  const spec = Math.pow(clamp01(t.light - 0.55) / 0.6, 2);
  return blend(scale(base, 0.45 + t.light * 0.55 - tarnish * 0.18), hi, clamp01(spec));
}

/** Embroidered filigree: thin bright lines from ridged noise in model space. */
function filigree(t: Texel, seed: number, density = 0.08): number {
  const [x, y, z] = t.p;
  const r = ridged3(x * density, y * density, z * density, 2, seed);
  return smooth(0.82, 0.92, r);
}

/** A trim band along UV island edges (hems, cuffs, collar). */
const trim = (t: Texel, width: number) => smooth(width, width * 0.6, t.edge);

const CRIMSON = hex('#8c1424');
const WINE = hex('#4c0c18');
const GOLD = hex('#d8a43c');
const GOLD_HI = hex('#fff0b0');
const DARK = hex('#1a0c10');
const LEATHER = hex('#3a2a20');

/** Gold-trimmed cloth used by the blood elf robes. */
function robe(t: Texel, base: RGB, seed: number, trimWidth = 7): [number, number, number, number] {
  let c = cloth(t, base, seed);
  c = blend(c, metal(t, GOLD, GOLD_HI, seed + 1), filigree(t, seed + 2) * 0.55);
  const hem = smooth(0.1, 0.06, t.h);
  const tr = Math.max(trim(t, trimWidth), hem);
  c = blend(c, metal(t, GOLD, GOLD_HI, seed + 4), tr);
  c = blend(c, DARK, smooth(1.6, 0.4, t.edge) * 0.7);
  return rgba(c);
}

/** Overlay for a team-coloured panel: shading and trim on top, team colour shows elsewhere. */
function teamPanel(t: Texel, trimCol: RGB, seed: number, trimWidth = 8): [number, number, number, number] {
  const tr = trim(t, trimWidth);
  const fig = filigree(t, seed, 0.11) * 0.8;
  const shadow = clamp01(1.15 - t.light) * 0.9 + smooth(16, 3, t.edge) * 0.3;
  const fold = fbm3(t.p[0] * 0.08, t.p[1] * 0.08, t.p[2] * 0.08, 3, seed) * 0.35;
  const gold = Math.max(tr, fig);
  const c = blend(DARK, metal(t, trimCol, GOLD_HI, seed), clamp01(gold * 1.6));
  return rgba(c, Math.max(gold, clamp01(shadow + fold - 0.15)));
}

// ---------- recipes by original texture path ----------

const RECIPES: Record<string, Recipe> = {
  // Blood elf hero robes: crimson cloth, gold hems and filigree; pauldrons over team colour.
  'textures\\hero_bloodelf.blp': (t) => (t.overlay ? teamPanel(t, GOLD, 11, 12) : robe(t, CRIMSON, 11)),
  // Dark wine mantle across the shoulders and back.
  'units\\creeps\\medivh\\medivh.blp': (t) => robe(t, WINE, 13, 6),
  // Priest vestments over the torso, with a gold stripe down the front.
  'textures\\bloodpriest.blp': (t) => {
    const out = robe(t, CRIMSON, 17, 6);
    const stripe = smooth(5, 3, Math.abs(t.p[1])) * smooth(-2, 2, t.p[0]);
    const c = blend([out[0], out[1], out[2]], metal(t, GOLD, GOLD_HI, 18), stripe);
    return rgba(c);
  },
  // Hood: team-coloured cloth with dark leather lining and trim.
  'units\\creeps\\sylvanuswindrunner\\sylvanuswindrunner.blp': (t) => {
    if (t.overlay) return teamPanel(t, hex('#b48a3c'), 19, 7);
    const c = blend(cloth(t, LEATHER, 19), metal(t, GOLD, GOLD_HI, 20), trim(t, 6));
    return rgba(c);
  },
  // Tabard and sash: team colour with gold borders.
  'textures\\bloodelf-spellthief.blp': (t) => (t.overlay ? teamPanel(t, GOLD, 23, 9) : robe(t, CRIMSON, 23)),
  // Chest plate.
  'ui\\glues\\singleplayer\\alliance_exp\\be_armorpads.blp': (t) => {
    const c = blend(metal(t, GOLD, GOLD_HI, 29), DARK, smooth(2.5, 0.5, t.edge) * 0.8);
    return rgba(c);
  },
  // Eagle feathers (only shown in an alternate death animation).
  'units\\creeps\\wareagle\\wareagle.blp': (t) => {
    const [x, y, z] = t.p;
    const barbs = fbm3(Math.hypot(x, y) * 0.25, z * 0.05, 3, 3, 31);
    const c = blend(hex('#3c2414'), hex('#9a7048'), barbs);
    return rgba(scale(blend(c, hex('#f0ece0'), smooth(0.8, 0.9, t.h)), t.light));
  },
};

function genericRecipe(path: string): Recipe {
  const p = path.toLowerCase();
  if (/metal|armor|armour|sword|blade|helm|plate|copper|steel/.test(p)) return (t) => rgba(metal(t, hex('#8a8f9a'), hex('#f0f4ff'), 41));
  if (/wood|staff|handle|bark/.test(p)) return (t) => rgba(cloth(t, hex('#6a4426'), 43));
  return (t) => (t.overlay ? teamPanel(t, GOLD, 47) : robe(t, hex('#5a4a6a'), 47));
}

/** True when a texture is a unit skin we can bake (it must be used by model geometry). */
export function hasSkinRecipe(path: string): boolean {
  return openTextureKey(path) in RECIPES;
}

/**
 * Bakes an open skin for `textureId` onto the model's UV layout. Returns null if no geoset
 * uses the texture.
 */
export function bakeSkin(model: ModelLike, textureId: number): HTMLCanvasElement | null {
  const path = model.textures[textureId]?.path ?? '';
  const recipe = RECIPES[openTextureKey(path)] ?? genericRecipe(path);
  const users: { gi: number; overlay: boolean }[] = [];
  model.geosets.forEach((g, gi) => {
    const layers = model.materials[g.materialId]?.layers ?? [];
    layers.forEach((l, li) => {
      if (l.textureId !== textureId) return;
      const under = li > 0 ? model.textures[layers[0].textureId] : undefined;
      users.push({ gi, overlay: li > 0 && !!under && under.replaceableId === 1 });
    });
  });
  if (!users.length) return null;

  // Height range from the opaque, non-replaceable geometry so glows/auras don't stretch it.
  let zMin = Infinity, zMax = -Infinity;
  model.geosets.forEach((g) => {
    const layers = model.materials[g.materialId]?.layers ?? [];
    if (!layers.some((l) => l.filterMode <= 2 && model.textures[l.textureId]?.replaceableId === 0)) return;
    for (let i = 2; i < g.vertices.length; i += 3) {
      zMin = Math.min(zMin, g.vertices[i]);
      zMax = Math.max(zMax, g.vertices[i]);
    }
  });
  if (!isFinite(zMin)) { zMin = 0; zMax = 1; }

  const N = SIZE * SIZE;
  const owner = new Int16Array(N).fill(-1);
  const pos = new Float32Array(N * 3);
  const nor = new Float32Array(N * 3);
  const over = new Uint8Array(N);

  for (const { gi, overlay } of users) {
    const g = model.geosets[gi];
    const uv = g.uvSets[0];
    const vc = g.vertices.length / 3;
    if (!uv) continue;
    for (let f = 0; f + 2 < g.faces.length; f += 3) {
      const a = g.faces[f], b = g.faces[f + 1], c = g.faces[f + 2];
      if (a >= vc || b >= vc || c >= vc) continue;
      const ax = uv[a * 2] * SIZE, ay = uv[a * 2 + 1] * SIZE;
      const bx = uv[b * 2] * SIZE, by = uv[b * 2 + 1] * SIZE;
      const cx = uv[c * 2] * SIZE, cy = uv[c * 2 + 1] * SIZE;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-6) continue;
      const x0 = Math.floor(Math.min(ax, bx, cx)), x1 = Math.ceil(Math.max(ax, bx, cx));
      const y0 = Math.floor(Math.min(ay, by, cy)), y1 = Math.ceil(Math.max(ay, by, cy));
      for (let py = y0; py <= y1; py++)
        for (let px = x0; px <= x1; px++) {
          const sx = px + 0.5, sy = py + 0.5;
          let w0 = ((bx - sx) * (cy - sy) - (by - sy) * (cx - sx)) / area;
          let w1 = ((cx - sx) * (ay - sy) - (cy - sy) * (ax - sx)) / area;
          let w2 = 1 - w0 - w1;
          // Half-texel tolerance so thin slivers still land on a texel.
          const tol = 0.9 / Math.sqrt(Math.abs(area));
          if (w0 < -tol || w1 < -tol || w2 < -tol) continue;
          w0 = clamp01(w0); w1 = clamp01(w1); w2 = clamp01(w2);
          const s = w0 + w1 + w2;
          w0 /= s; w1 /= s; w2 /= s;
          const tx = ((px % SIZE) + SIZE) % SIZE, ty = ((py % SIZE) + SIZE) % SIZE;
          const i = ty * SIZE + tx;
          owner[i] = gi;
          over[i] = overlay ? 1 : 0;
          for (let k = 0; k < 3; k++) {
            pos[i * 3 + k] = g.vertices[a * 3 + k] * w0 + g.vertices[b * 3 + k] * w1 + g.vertices[c * 3 + k] * w2;
            nor[i * 3 + k] = g.normals[a * 3 + k] * w0 + g.normals[b * 3 + k] * w1 + g.normals[c * 3 + k] * w2;
          }
        }
    }
  }

  const edge = distanceToEdge(owner);
  const out = new Uint8ClampedArray(N * 4);
  const texel: Texel = { p: [0, 0, 0], n: [0, 0, 1], h: 0, edge: 0, light: 1, overlay: false, geoset: 0 };
  for (let i = 0; i < N; i++) {
    if (owner[i] < 0) continue;
    const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
    const nl = Math.hypot(nx, ny, nz) || 1;
    texel.p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    texel.n = [nx / nl, ny / nl, nz / nl];
    texel.h = (texel.p[2] - zMin) / (zMax - zMin || 1);
    texel.edge = edge[i];
    const lambert = texel.n[0] * LIGHT[0] + texel.n[1] * LIGHT[1] + texel.n[2] * LIGHT[2];
    texel.light = (0.5 + 0.55 * Math.max(0, lambert)) * (0.72 + 0.28 * smooth(0, 0.5, texel.h));
    texel.overlay = over[i] === 1;
    texel.geoset = owner[i];
    const [r, g, b, a] = recipe(texel);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = clamp01(a) * 255;
  }
  dilate(out, owner, 6);

  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  c.getContext('2d')!.putImageData(new ImageData(out, SIZE, SIZE), 0, 0);
  return c;
}

/** Chamfer distance (in texels) from each covered texel to the nearest uncovered one. */
function distanceToEdge(owner: Int16Array): Float32Array {
  const N = SIZE * SIZE;
  const d = new Float32Array(N);
  const BIG = 1e6;
  for (let i = 0; i < N; i++) d[i] = owner[i] < 0 ? 0 : BIG;
  const D = 1, D2 = Math.SQRT2;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + D);
      if (y > 0) {
        v = Math.min(v, d[i - SIZE] + D);
        if (x > 0) v = Math.min(v, d[i - SIZE - 1] + D2);
        if (x < SIZE - 1) v = Math.min(v, d[i - SIZE + 1] + D2);
      }
      if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) v = Math.min(v, 6);
      d[i] = v;
    }
  for (let y = SIZE - 1; y >= 0; y--)
    for (let x = SIZE - 1; x >= 0; x--) {
      const i = y * SIZE + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x < SIZE - 1) v = Math.min(v, d[i + 1] + D);
      if (y < SIZE - 1) {
        v = Math.min(v, d[i + SIZE] + D);
        if (x < SIZE - 1) v = Math.min(v, d[i + SIZE + 1] + D2);
        if (x > 0) v = Math.min(v, d[i + SIZE - 1] + D2);
      }
      d[i] = v;
    }
  return d;
}

/** Bleeds island colours outward so bilinear filtering and mipmaps don't pull in black. */
function dilate(px: Uint8ClampedArray, owner: Int16Array, passes: number): void {
  const filled = new Uint8Array(owner.length);
  for (let i = 0; i < owner.length; i++) filled[i] = owner[i] >= 0 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const add: number[] = [];
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const i = y * SIZE + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= SIZE || yy >= SIZE) continue;
          const j = yy * SIZE + xx;
          if (!filled[j]) continue;
          r += px[j * 4]; g += px[j * 4 + 1]; b += px[j * 4 + 2]; a += px[j * 4 + 3]; n++;
        }
        if (!n) continue;
        px[i * 4] = r / n; px[i * 4 + 1] = g / n; px[i * 4 + 2] = b / n; px[i * 4 + 3] = a / n;
        add.push(i);
      }
    for (const i of add) filled[i] = 1;
  }
}
