import * as THREE from 'three';
import { assets } from '../assets/store';
import { ICE_TILE, MAP_MAX, TERRAIN_MIN, TILE_COUNT, TILE_SIZE } from '../config';
import type { Sim } from '../sim/game';
import { ATLAS_H, ATLAS_W, WORLD_PX, WORLD_TILES, proceduralTileAtlas, proceduralWorldTexture } from './tileTextures';

// WC3 ground rendering, ported from the game's (and mdx-m3-viewer's) tile shader:
// every tile looks at the ground types on its four corner vertices, draws the lowest
// type as an opaque base and blends each higher type using the atlas cell selected
// by the bitset of corners that carry it. Layer order follows the map's tile list, in
// which the lava tile precedes Idki and the runtime-added safe tile comes last.

const VERT = /* glsl */ `
varying vec2 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = vec2(w.x, -w.z);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uCorners;
uniform sampler2D uAtlas;
uniform sampler2D uWorld;
uniform float uExt[3];
uniform float uProc[3];
uniform float uBounds;
uniform vec3 uLight;
varying vec2 vW;

vec4 samp(int type, float variation, float ext, vec2 f) {
  vec2 cell = variation < 16.0
    ? vec2(mod(variation, 4.0), floor(variation / 4.0))
    : vec2(4.0 + mod(variation - 16.0, 4.0), floor((variation - 16.0) / 4.0));
  vec2 cs = vec2(ext > 0.5 ? 0.125 : 0.25, 0.25);
  vec2 uv = vec2(f.x, 1.0 - f.y);
  vec2 px = vec2(0.5 / ${ATLAS_W}.0, 0.5 / ${ATLAS_H}.0);
  uv = clamp((cell + uv) * cs, cell * cs + px, (cell + 1.0) * cs - px);
  uv.y = (float(type) + uv.y) / 3.0;
  vec4 t = texture2D(uAtlas, uv);
  if (uProc[type] > 0.5) {
    vec2 w = fract(vW / ${(WORLD_TILES * TILE_SIZE).toFixed(1)});
    vec2 wp = vec2(0.5 / ${WORLD_PX}.0);
    w = clamp(vec2(w.x, 1.0 - w.y), wp, 1.0 - wp);
    t.rgb = texture2D(uWorld, vec2(w.x, (float(type) + w.y) / 3.0)).rgb;
  }
  return t;
}

float baseVariation(float v, float ext) {
  if (ext > 0.5) return v < 16.0 ? 16.0 + v : (v < 16.5 ? 15.0 : 0.0);
  return v < 0.5 ? 0.0 : 15.0;
}

void main() {
  vec2 g = (vW - ${TERRAIN_MIN.toFixed(1)}) / ${TILE_SIZE.toFixed(1)};
  vec2 c = clamp(floor(g), 0.0, ${(TILE_COUNT - 2).toFixed(1)});
  vec2 f = clamp(g - c, 0.0, 1.0);
  const float N = ${TILE_COUNT.toFixed(1)};
  vec4 bl = texture2D(uCorners, (c + vec2(0.5, 0.5)) / N);
  vec4 br = texture2D(uCorners, (c + vec2(1.5, 0.5)) / N);
  vec4 tl = texture2D(uCorners, (c + vec2(0.5, 1.5)) / N);
  vec4 tr = texture2D(uCorners, (c + vec2(1.5, 1.5)) / N);
  float tBL = floor(bl.r * 255.0 + 0.5), tBR = floor(br.r * 255.0 + 0.5);
  float tTL = floor(tl.r * 255.0 + 0.5), tTR = floor(tr.r * 255.0 + 0.5);
  vec4 color = vec4(0.0);
  bool first = true;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float bits = (tBR == fk ? 1.0 : 0.0) + (tBL == fk ? 2.0 : 0.0) + (tTR == fk ? 4.0 : 0.0) + (tTL == fk ? 8.0 : 0.0);
    if (bits < 0.5) continue;
    if (first) {
      color = samp(k, baseVariation(floor(bl.g * 255.0 + 0.5), uExt[k]), uExt[k], f);
      first = false;
    } else {
      vec4 t = samp(k, bits, uExt[k], f);
      color.rgb = mix(color.rgb, t.rgb, t.a);
    }
  }
  vec3 col = color.rgb * uLight;
  // Outside the playable area WC3 draws the black map boundary.
  if (abs(vW.x) > uBounds || abs(vW.y) > uBounds) col *= 0.0;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

/** Minimal SYLK reader for TerrainArt\\Terrain.slk: returns rows of column-name -> value. */
function parseSlk(text: string): Record<string, string>[] {
  const cells = new Map<number, Map<number, string>>();
  let x = 0, y = 0, maxY = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('C;') && !line.startsWith('F;')) continue;
    let val: string | undefined;
    for (const part of line.split(';').slice(1)) {
      const k = part[0], v = part.slice(1);
      if (k === 'X') x = +v;
      else if (k === 'Y') y = +v;
      else if (k === 'K') val = v.replace(/^"|"$/g, '');
    }
    if (line.startsWith('C;') && val !== undefined) {
      if (!cells.has(y)) cells.set(y, new Map());
      cells.get(y)!.set(x, val);
      maxY = Math.max(maxY, y);
    }
  }
  const head = cells.get(1);
  if (!head) return [];
  const rows: Record<string, string>[] = [];
  for (let r = 2; r <= maxY; r++) {
    const row = cells.get(r);
    if (!row) continue;
    const o: Record<string, string> = {};
    for (const [cx, name] of head) o[name] = row.get(cx) ?? '';
    rows.push(o);
  }
  return rows;
}

let slkRows: Promise<Map<string, string> | null> | null = null;
let slkEpoch = -1;

/** Resolves a tile code to its BLP path through Terrain.slk if the base game data is loaded. */
async function tilePath(code: string): Promise<string | null> {
  if (!slkRows || slkEpoch !== assets.archiveNames.length) {
    slkEpoch = assets.archiveNames.length;
    slkRows = (async () => {
      const data = await assets.file('TerrainArt\\Terrain.slk');
      if (!data) return null;
      const m = new Map<string, string>();
      for (const r of parseSlk(new TextDecoder('latin1').decode(data))) if (r.tileID) m.set(r.tileID, `${r.dir}\\${r.file}.blp`);
      return m;
    })();
  }
  return (await slkRows)?.get(code) ?? null;
}

/** Copies a real tile texture into an atlas strip, nearest-resampling to 64px cells. */
function blitTile(img: { data: ArrayLike<number>; width: number; height: number }, dst: Uint8Array, strip: number): boolean {
  const extended = img.width > img.height;
  const cols = extended ? 8 : 4;
  const sw = img.width / cols, sh = img.height / 4;
  for (let y = 0; y < ATLAS_H; y++) for (let x = 0; x < (extended ? ATLAS_W : ATLAS_W / 2); x++) {
    const cx = Math.floor(x / 64), cy = Math.floor(y / 64);
    const sx = Math.floor(cx * sw + ((x % 64) + 0.5) * (sw / 64));
    const sy = Math.floor(cy * sh + ((y % 64) + 0.5) * (sh / 64));
    const si = (sy * img.width + sx) * 4;
    const di = ((strip * ATLAS_H + y) * ATLAS_W + x) * 4;
    dst[di] = img.data[si];
    dst[di + 1] = img.data[si + 1];
    dst[di + 2] = img.data[si + 2];
    dst[di + 3] = img.data[si + 3];
  }
  return extended;
}

export class TerrainView {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private corners: THREE.DataTexture;
  private cornerData: Uint8Array;
  private atlas: THREE.DataTexture;
  private atlasData: Uint8Array;
  private world: THREE.DataTexture;
  private worldData: Uint8Array;
  private version = -1;
  private atlasKey = '';
  private variations: Uint8Array;

  constructor() {
    this.cornerData = new Uint8Array(TILE_COUNT * TILE_COUNT * 4);
    this.corners = new THREE.DataTexture(this.cornerData, TILE_COUNT, TILE_COUNT, THREE.RGBAFormat);
    this.corners.magFilter = this.corners.minFilter = THREE.NearestFilter;
    this.atlasData = new Uint8Array(ATLAS_W * ATLAS_H * 3 * 4);
    this.atlas = new THREE.DataTexture(this.atlasData, ATLAS_W, ATLAS_H * 3, THREE.RGBAFormat);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.magFilter = this.atlas.minFilter = THREE.LinearFilter;
    this.atlas.generateMipmaps = false;
    this.worldData = new Uint8Array(WORLD_PX * WORLD_PX * 3 * 4);
    this.world = new THREE.DataTexture(this.worldData, WORLD_PX, WORLD_PX * 3, THREE.RGBAFormat);
    this.world.colorSpace = THREE.SRGBColorSpace;
    this.world.magFilter = this.world.minFilter = THREE.LinearFilter;
    this.world.generateMipmaps = false;
    // Ground variation per vertex, as random as the editor/SetTerrainType(-1) would make it.
    this.variations = new Uint8Array(TILE_COUNT * TILE_COUNT);
    for (let i = 0; i < this.variations.length; i++) {
      const h = Math.imul(i ^ 0x9e3779b9, 2654435761) >>> 0;
      this.variations[i] = h % 100 < 70 ? 0 : (h >>> 8) % 17;
    }
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCorners: { value: this.corners },
        uAtlas: { value: this.atlas },
        uWorld: { value: this.world },
        uExt: { value: [1, 1, 1] },
        uProc: { value: [1, 1, 1] },
        uBounds: { value: MAP_MAX },
        uLight: { value: new THREE.Vector3(1, 1, 1) },
      },
    });
    const size = TILE_SIZE * (TILE_COUNT - 1);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(TERRAIN_MIN + size / 2, 0, -(TERRAIN_MIN + size / 2));
  }

  update(sim: Sim) {
    const key = `${sim.theme.lava}|${ICE_TILE}|${sim.theme.safe}|${assets.archiveNames.join(',')}`;
    if (key !== this.atlasKey) {
      this.atlasKey = key;
      void this.buildAtlas([sim.theme.lava, ICE_TILE, sim.theme.safe], key);
    }
    if (this.version === sim.terrainVersion) return;
    this.version = sim.terrainVersion;
    const { lava, safe } = sim.theme;
    for (let i = 0; i < TILE_COUNT * TILE_COUNT; i++) {
      const code = sim.terrainTiles[i];
      const type = code === lava ? 0 : code === ICE_TILE ? 1 : code === safe ? 2 : 0;
      this.cornerData[i * 4] = type;
      // Lava is painted with random variation, the safe and ice brushes with variation 0.
      this.cornerData[i * 4 + 1] = type === 0 ? this.variations[i] : 0;
    }
    this.corners.needsUpdate = true;
  }

  private async buildAtlas(codes: string[], key: string) {
    const ext = [1, 1, 1];
    const proc = [1, 1, 1];
    codes.forEach((c, i) => {
      this.atlasData.set(proceduralTileAtlas(c), i * ATLAS_W * ATLAS_H * 4);
      this.worldData.set(proceduralWorldTexture(c), i * WORLD_PX * WORLD_PX * 4);
    });
    this.mat.uniforms.uExt.value = ext.slice();
    this.mat.uniforms.uProc.value = proc.slice();
    this.atlas.needsUpdate = true;
    this.world.needsUpdate = true;
    if (assets.empty) return;
    let changed = false;
    for (let i = 0; i < codes.length; i++) {
      const path = await tilePath(codes[i]);
      const tex = path ? await assets.texture(path) : null;
      if (this.atlasKey !== key) return;
      const img = tex?.image as { data: ArrayLike<number>; width: number; height: number } | undefined;
      if (!img?.data) continue;
      ext[i] = blitTile(img, this.atlasData, i) ? 1 : 0;
      proc[i] = 0;
      changed = true;
    }
    if (changed) {
      this.mat.uniforms.uExt.value = ext;
      this.mat.uniforms.uProc.value = proc;
      this.atlas.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.corners.dispose();
    this.atlas.dispose();
    this.world.dispose();
  }
}
