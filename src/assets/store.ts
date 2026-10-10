// Runtime asset store. Nothing from the original map (or Blizzard's game data) is shipped
// with this project; instead the player supplies their own copy of the map file and,
// optionally, classic Warcraft III archives (war3.mpq / War3x.mpq / War3Patch.mpq).
// Files are looked up in the archives in priority order; callers fall back to procedural
// assets when a file is missing.
import * as THREE from 'three';
import * as blpNs from 'mdx-m3-viewer/dist/cjs/parsers/blp/image';
import * as mdlxNs from 'mdx-m3-viewer/dist/cjs/parsers/mdlx/model';
import type MdlxModelType from 'mdx-m3-viewer/dist/cjs/parsers/mdlx/model';
import { MpqArchive, blobSource, bufferSource } from './mpq';

// CommonJS interop differs between bundlers; dig out the actual classes.
type AnyNs = { default?: unknown; [k: string]: unknown };
const unwrap = (ns: AnyNs, key: string): unknown => {
  const d = ns.default as AnyNs | undefined;
  const dd = d?.default as AnyNs | undefined;
  return [ns[key], d?.[key], dd?.[key], d].find((c) => typeof c === 'function');
};
const BlpImage = unwrap(blpNs as unknown as AnyNs, 'BlpImage') as typeof blpNs.BlpImage;
const MdlxModel = unwrap(mdlxNs as unknown as AnyNs, 'default') as typeof MdlxModelType;
export type MdlxModel = MdlxModelType;

export function normalizePath(path: string): string {
  return path.replace(/\//g, '\\').replace(/^\\+/, '');
}

export class AssetStore {
  private archives: { name: string; mpq: MpqArchive }[] = [];
  private files = new Map<string, Promise<Uint8Array | null>>();
  private textures = new Map<string, Promise<THREE.Texture | null>>();
  private models = new Map<string, Promise<MdlxModel | null>>();
  private audio = new Map<string, Promise<AudioBuffer | null>>();

  get archiveNames(): string[] {
    return this.archives.map((a) => a.name);
  }

  get empty(): boolean {
    return this.archives.length === 0;
  }

  clear(): void {
    this.archives = [];
    this.files.clear();
    this.textures.clear();
    this.models.clear();
    this.audio.clear();
  }

  /** Adds an archive. Later archives are searched first (map overrides patch overrides base). */
  async addArchive(name: string, data: Blob | Uint8Array): Promise<void> {
    const mpq = await MpqArchive.open(data instanceof Uint8Array ? bufferSource(data) : blobSource(data));
    this.archives.unshift({ name, mpq });
    this.files.clear();
    this.textures.clear();
    this.models.clear();
    this.audio.clear();
  }

  has(path: string): boolean {
    const p = normalizePath(path);
    return this.archives.some((a) => a.mpq.has(p));
  }

  file(path: string): Promise<Uint8Array | null> {
    const p = normalizePath(path);
    const key = p.toLowerCase();
    let f = this.files.get(key);
    if (!f) {
      f = (async () => {
        for (const a of this.archives) {
          try {
            const data = await a.mpq.read(p);
            if (data) return data;
          } catch (e) {
            console.warn(`[assets] ${a.name}: failed to read ${p}:`, e);
          }
        }
        return null;
      })();
      this.files.set(key, f);
    }
    return f;
  }

  /** Decodes a BLP texture (top mip level) into a THREE texture, or null if missing. */
  texture(path: string): Promise<THREE.Texture | null> {
    const key = normalizePath(path).toLowerCase();
    let t = this.textures.get(key);
    if (!t) {
      t = (async () => {
        const data = await this.file(path);
        if (!data) return null;
        try {
          const blp = new BlpImage();
          blp.load(data);
          const img = blp.getMipmap(0) as ImageData;
          const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.magFilter = THREE.LinearFilter;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.generateMipmaps = true;
          tex.flipY = false;
          tex.needsUpdate = true;
          tex.name = path;
          return tex;
        } catch (e) {
          console.warn(`[assets] bad BLP ${path}:`, e);
          return null;
        }
      })();
      this.textures.set(key, t);
    }
    return t;
  }

  /** Parses an MDX model. `.mdl` paths are mapped to `.mdx` like the game does. */
  model(path: string): Promise<MdlxModel | null> {
    const p = normalizePath(path).replace(/\.mdl$/i, '.mdx');
    const key = p.toLowerCase();
    let m = this.models.get(key);
    if (!m) {
      m = (async () => {
        const data = await this.file(p);
        if (!data) return null;
        try {
          const model = new MdlxModel();
          model.load(data);
          return model;
        } catch (e) {
          console.warn(`[assets] bad MDX ${p}:`, e);
          return null;
        }
      })();
      this.models.set(key, m);
    }
    return m;
  }

  sound(path: string, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
    const key = normalizePath(path).toLowerCase();
    let s = this.audio.get(key);
    if (!s) {
      s = (async () => {
        const data = await this.file(path);
        if (!data) return null;
        try {
          return await ctx.decodeAudioData(data.slice().buffer);
        } catch (e) {
          console.warn(`[assets] cannot decode ${path}:`, e);
          return null;
        }
      })();
      this.audio.set(key, s);
    }
    return s;
  }
}

export const assets = new AssetStore();
