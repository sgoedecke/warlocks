import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { fbm3, ridged3, clamp01 } from './opentex/noise';
import type { Obstacle } from '../sim/types';
import columnUrl from './models3d/statue_column.glb?url';
import columnDamagedUrl from './models3d/statue_columnDamaged.glb?url';
import obeliskUrl from './models3d/statue_obelisk.glb?url';
import stoneCUrl from './models3d/stone_tallC.glb?url';
import stoneFUrl from './models3d/stone_tallF.glb?url';
import stoneGUrl from './models3d/stone_tallG.glb?url';
import treePlateauUrl from './models3d/tree_plateau.glb?url';

// Obstacle doodads from Kenney's Nature Kit (CC0), recoloured and given painted
// detail textures so they read closer to the WC3 doodads they replace.

type Detail = 'stone' | 'bark' | 'leaf';
type Palette = Partial<Record<string, [number, Detail]>>;

interface Kind {
  url: string;
  /** Sim-unit size of one model unit (before the obstacle's own scale). */
  size: number;
  palette: Palette;
}

const CITY: Palette = { stone: [0xc4bba6, 'stone'], stoneDark: [0xa39a86, 'stone'] };
const BARRENS: Palette = { stone: [0xa88462, 'stone'] };
const TREE: Palette = { woodBark: [0x6e4d30, 'bark'], leafsGreen: [0x7f8f3a, 'leaf'] };
const RUINS: Palette = { stone: [0x8f9488, 'stone'], stoneDark: [0x6f7a5e, 'stone'] };
const OUTLAND: Palette = { stone: [0x7a4c3e, 'stone'] };

const KINDS: Kind[] = [
  { url: columnDamagedUrl, size: 240, palette: CITY },
  { url: columnUrl, size: 240, palette: CITY },
  { url: stoneCUrl, size: 190, palette: BARRENS },
  { url: stoneGUrl, size: 165, palette: BARRENS },
  { url: treePlateauUrl, size: 130, palette: TREE },
  { url: treePlateauUrl, size: 105, palette: TREE },
  { url: obeliskUrl, size: 175, palette: RUINS },
  { url: columnUrl, size: 165, palette: RUINS },
  { url: stoneGUrl, size: 185, palette: OUTLAND },
  { url: stoneFUrl, size: 210, palette: OUTLAND },
];

interface Part { geometry: THREE.BufferGeometry; material: THREE.Material }
const prototypes: Part[][] = [];

const DETAIL_SIZE = 128;
const details = new Map<Detail, THREE.Texture>();

function detailTexture(kind: Detail): THREE.Texture {
  let tex = details.get(kind);
  if (tex) return tex;
  const n = DETAIL_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x / n) * 4, v = (y / n) * 4;
      let s: number;
      if (kind === 'stone') {
        const base = fbm3(u, v, 0, 4, 3, 4, 4);
        const crack = ridged3(u * 0.75, v * 0.75, 1, 3, 9, 3, 3);
        s = 0.62 + 0.42 * base - 0.3 * clamp01((crack - 0.62) * 4);
      } else if (kind === 'bark') {
        const streak = fbm3(u * 3, v * 0.35, 0, 3, 5, 12, 1.4);
        s = 0.55 + 0.5 * streak - 0.25 * clamp01((0.45 - streak) * 6);
      } else {
        const clump = fbm3(u * 1.5, v * 1.5, 2, 4, 7, 6, 6);
        const fleck = fbm3(u * 6, v * 6, 4, 2, 11, 24, 24);
        s = 0.5 + 0.55 * clump + 0.18 * (fleck - 0.5);
      }
      const c = Math.round(255 * clamp01(s));
      const i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 2;
  details.set(kind, tex);
  return tex;
}

/** Box-projected UVs (tiling ~3x per model unit) and a ground-contact darkening baked into vertex colours. */
function decorate(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position as THREE.BufferAttribute;
  if (!g.attributes.normal) g.computeVertexNormals();
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  const col = new Float32Array(pos.count * 3);
  const T = 3;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    const [a, b] = ay >= ax && ay >= az ? [x, z] : ax >= az ? [z, y] : [x, y];
    uv[i * 2] = a * T;
    uv[i * 2 + 1] = b * T;
    const shade = 0.55 + 0.45 * clamp01(y / 0.25);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Loads and prepares all obstacle models. Call once before rendering obstacles. */
export async function loadObstacleModels(): Promise<void> {
  if (prototypes.length) return;
  const loader = new GLTFLoader();
  const byUrl = new Map<string, Promise<THREE.Object3D>>();
  const scenes = await Promise.all(KINDS.map((k) => {
    if (!byUrl.has(k.url)) byUrl.set(k.url, loader.loadAsync(k.url).then((g) => g.scene));
    return byUrl.get(k.url)!;
  }));
  const geoCache = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  KINDS.forEach((kind, i) => {
    const parts: Part[] = [];
    const scene = scenes[i];
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const name = (m.material as THREE.Material).name;
      const paint = kind.palette[name];
      if (!paint) return;
      let geo = geoCache.get(m.geometry);
      if (!geo) {
        geo = decorate(m.geometry.clone().applyMatrix4(m.matrixWorld));
        geoCache.set(m.geometry, geo);
      }
      const material = new THREE.MeshLambertMaterial({ color: paint[0], map: detailTexture(paint[1]), vertexColors: true });
      parts.push({ geometry: geo, material });
    });
    prototypes[i] = parts;
  });
}

/** A new obstacle object. Geometry and materials are shared; don't dispose them. */
export function obstacleModel(o: Obstacle): THREE.Object3D {
  const type = Number(o.variant.slice(3)) || 0;
  const g = new THREE.Group();
  for (const p of prototypes[type] ?? prototypes[0]) g.add(new THREE.Mesh(p.geometry, p.material));
  g.scale.setScalar(KINDS[type].size * o.scale);
  g.rotation.y = o.facing;
  g.position.set(o.x, 0, -o.y);
  g.userData.shared = true;
  return g;
}
