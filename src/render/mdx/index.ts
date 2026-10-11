import * as THREE from 'three';
import { assets, type MdlxModel as ParsedMdlxModel } from '../../assets/store';
import { canvasTexture, getFallbackTexture, makeTeamColorTexture } from './fallbackTextures';
import { bakeSkin, hasSkinRecipe } from '../opentex/bake';
import { hasOpenTexture } from '../opentex/particles';

type TrackValue = Float32Array | Uint32Array;
type AnimationTrack = { name: string; interpolationType: number; globalSequenceId: number; frames: number[]; values: TrackValue[]; inTans: TrackValue[]; outTans: TrackValue[] };
type AnimatedLike = { animations: AnimationTrack[] };
type GenericLike = AnimatedLike & { name: string; objectId: number; parentId: number; flags: number };
type LayerLike = AnimatedLike & { filterMode: number; flags: number; textureId: number; textureAnimationId: number; coordId: number; alpha: number };
type TextureLike = { replaceableId: number; path: string; wrapMode: number };
type GeosetLike = { vertices: Float32Array; normals: Float32Array; faces: Uint16Array; vertexGroups: Uint8Array; matrixGroups: Uint32Array; matrixIndices: Uint32Array; materialId: number; uvSets: Float32Array[] };
type GeosetAnimLike = AnimatedLike & { alpha: number; flags: number; color: Float32Array; geosetId: number };
type SequenceLike = { name: string; interval: Uint32Array; nonLooping: number; rarity: number };
type ParticleEmitter2Like = GenericLike & { speed: number; variation: number; latitude: number; gravity: number; lifeSpan: number; emissionRate: number; width: number; length: number; filterMode: number; rows: number; columns: number; headOrTail: number; tailLength: number; timeMiddle: number; segmentColors: Float32Array[]; segmentAlphas: Uint8Array; segmentScaling: Float32Array; headIntervals: Uint32Array[]; tailIntervals: Uint32Array[]; textureId: number; squirt: number; priorityPlane: number; replaceableId: number };
type RibbonEmitterLike = GenericLike & { heightAbove: number; heightBelow: number; alpha: number; color: Float32Array; lifeSpan: number; textureSlot: number; emissionRate: number; rows: number; columns: number; materialId: number; gravity: number };

type AnyModel = ParsedMdlxModel & {
  sequences: SequenceLike[];
  globalSequences: number[];
  textures: TextureLike[];
  geosets: GeosetLike[];
  materials: { layers: LayerLike[]; flags: number }[];
  geosetAnimations: GeosetAnimLike[];
  textureAnimations: AnimatedLike[];
  pivotPoints: Float32Array[];
  bones: GenericLike[];
  helpers: GenericLike[];
  attachments: (GenericLike & { path: string; attachmentId: number })[];
  particleEmitters: GenericLike[];
  particleEmitters2: ParticleEmitter2Like[];
  ribbonEmitters: RibbonEmitterLike[];
  eventObjects: GenericLike[];
  collisionShapes: GenericLike[];
};

const modelCache = new Map<string, Promise<MdxModel | null>>();
const convertMatrix = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const convertMatrixInv = convertMatrix.clone().invert();
const tempV = new THREE.Vector3();
const tempQ = new THREE.Quaternion();
const tempS = new THREE.Vector3();
const tempM = new THREE.Matrix4();
const tempM2 = new THREE.Matrix4();
const tempT = new THREE.Vector3();
const tempSc = new THREE.Vector3();
const tempR = new THREE.Quaternion();
const tempColor = new THREE.Color();
const tempEuler = new THREE.Euler();
const identity = new THREE.Matrix4();
const setupCamera = new THREE.PerspectiveCamera();
const defaultTeam = new THREE.Color(0xc03030);

interface TextureSlot {
  texture: THREE.Texture;
  path: string;
  replaceableId: number;
}

interface LayerSlot {
  layer: LayerLike;
  texture: TextureSlot;
  baseMaterial: THREE.MeshBasicMaterial;
}

interface GeosetPrepared {
  geoset: GeosetLike;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
  /** Per vertex: index into the model's deduplicated matrix groups. */
  vertexGroups: Float32Array;
  layers: LayerSlot[];
  geosetAnimation: GeosetAnimLike | null;
  /** Bind-pose geometry shared by every instance of the model; skinned in the vertex shader. */
  geometry?: THREE.BufferGeometry;
}

interface NodeInfo {
  object: GenericLike;
  pivot: THREE.Vector3;
  parentObjectId: number;
}

interface NodeState extends NodeInfo {
  parent: NodeState | null;
  local: THREE.Matrix4;
  world: THREE.Matrix4;
  worldConverted: THREE.Matrix4;
  visible: number;
}

interface MeshSlot {
  geoset: GeosetPrepared;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  layer: LayerSlot;
  mapWasCloned: boolean;
}

/** Per instance: the matrix-group palette every geoset's vertex shader skins with. */
interface SkinPalette {
  /** Per matrix group: the top three rows of the average of its bones' world matrices. */
  data: Float32Array;
  /** Only for models with more groups than fit in vertex uniforms. */
  texture: THREE.DataTexture | null;
}

interface SkinSlot {
  geoset: GeosetPrepared;
  layers: MeshSlot[];
}

interface Particle2 {
  location: THREE.Vector3;
  velocity: THREE.Vector3;
  health: number;
  life: number;
  tail: boolean;
  gravity: number;
  scale: number;
  cellOffset: number;
}

interface RibbonPoint {
  above: THREE.Vector3;
  below: THREE.Vector3;
  health: number;
  life: number;
  color: THREE.Color;
  alpha: number;
  slot: number;
}

function trackMap(object: AnimatedLike): Map<string, AnimationTrack> {
  const keyed = object as AnimatedLike & { __mdxTrackMap?: Map<string, AnimationTrack> };
  if (!keyed.__mdxTrackMap) keyed.__mdxTrackMap = new Map(object.animations.map((a) => [a.name, a]));
  return keyed.__mdxTrackMap;
}

const scratch = [new Float32Array(0), new Float32Array(1), new Float32Array(2), new Float32Array(3), new Float32Array(4)];
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
type RangeCache = Map<number, number>;

/** Index range [lo, hi] of keys inside [start, end]; frames are sorted, so binary search and cache per sequence. */
function keyRange(track: AnimationTrack & { __ranges?: RangeCache }, start: number, end: number): number {
  const cache = (track.__ranges ??= new Map());
  const id = start * 1048576 + end;
  let r = cache.get(id);
  if (r === undefined) {
    const f = track.frames;
    let lo = 0;
    while (lo < f.length && f[lo] < start) lo++;
    let hi = lo - 1;
    while (hi + 1 < f.length && f[hi + 1] <= end) hi++;
    r = lo * 65536 + (hi - lo + 1);
    cache.set(id, r);
  }
  return r;
}

/**
 * Samples an animation track at the instance's current frame. Returns null when the track doesn't
 * apply. The result may be a shared scratch array, so read it before sampling again.
 */
function sampleRaw(instance: MdxInstance, object: AnimatedLike, name: string): TrackValue | null {
  const track = trackMap(object).get(name);
  if (!track || instance.sequenceIndex < 0) return null;
  let start = 0;
  let end = 0;
  let frame = instance.frameMs;
  const frames = track.frames;
  let lo: number;
  let n: number;
  if (track.globalSequenceId !== -1 && instance.model.source.globalSequences[track.globalSequenceId] !== undefined) {
    end = instance.model.source.globalSequences[track.globalSequenceId];
    frame = end > 0 ? instance.globalMs % end : 0;
    lo = 0;
    n = frames.length;
  } else {
    const interval = instance.sequence?.interval;
    if (!interval) return null;
    start = interval[0];
    end = interval[1];
    if (track.globalSequenceId !== -1) {
      lo = 0;
      n = frames.length;
    } else {
      const r = keyRange(track, start, end);
      lo = Math.floor(r / 65536);
      n = r % 65536;
    }
  }
  if (n === 0) return null;
  if (n === 1 || frame < frames[lo]) return track.values[lo];
  const hi = lo + n - 1;
  let a = hi;
  let b = lo;
  if (frame < frames[hi]) {
    let l = lo + 1;
    let h = hi;
    while (l < h) {
      const m = (l + h) >> 1;
      if (frames[m] > frame) h = m;
      else l = m + 1;
    }
    a = l - 1;
    b = l;
  }
  let fa = frames[a];
  const fb = frames[b];
  let span = fb - fa;
  if (span < 0) {
    span += end - start;
    if (frame < fa) fa = fb;
  }
  const t = span === 0 ? 0 : THREE.MathUtils.clamp((frame - fa) / span, 0, 1);
  if (track.interpolationType === 0 || name === 'KP2V' || name === 'KRVS') return track.values[a];
  return interpolateTrack(track, a, b, t);
}

function sampleTrack(instance: MdxInstance, object: AnimatedLike, name: string, fallback: TrackValue): TrackValue {
  return sampleRaw(instance, object, name) ?? fallback;
}

function interpolateTrack(track: AnimationTrack, a: number, b: number, t: number): TrackValue {
  const av = track.values[a];
  const bv = track.values[b];
  if (av.length === 1) {
    const out = scratch[1];
    const at = av[0];
    const bt = bv[0];
    if (track.interpolationType === 2 || track.interpolationType === 3) {
      out[0] = hermite(at, track.outTans[a]?.[0] ?? at, track.inTans[b]?.[0] ?? bt, bt, t);
    } else out[0] = THREE.MathUtils.lerp(at, bt, t);
    return out;
  }
  if (av.length === 4) {
    qa.set(av[0], av[1], av[2], av[3]).normalize();
    qb.set(bv[0], bv[1], bv[2], bv[3]).normalize();
    qa.slerp(qb, t);
    const out = scratch[4];
    out[0] = qa.x;
    out[1] = qa.y;
    out[2] = qa.z;
    out[3] = qa.w;
    return out;
  }
  const out = scratch[av.length] ?? new Float32Array(av.length);
  for (let i = 0; i < av.length; i++) out[i] = THREE.MathUtils.lerp(av[i], bv[i], t);
  return out;
}

function hermite(a: number, at: number, bt: number, b: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * at + (-2 * t3 + 3 * t2) * b + (t3 - t2) * bt;
}

function sampleScalar(instance: MdxInstance, object: AnimatedLike, name: string, fallback: number): number {
  const v = sampleRaw(instance, object, name);
  if (v) return v[0];
  return name === 'KMTA' || name === 'KGAO' || name === 'KP2V' || name === 'KRVS' ? 1 : fallback;
}

/** Writes the sampled vector (or the fallback) into `out`. */
function sampleVector(instance: MdxInstance, object: AnimatedLike, name: string, fx: number, fy: number, fz: number, out: THREE.Vector3): THREE.Vector3 {
  const v = sampleRaw(instance, object, name);
  return v ? out.set(v[0], v[1], v[2]) : out.set(fx, fy, fz);
}

function sampleQuat(instance: MdxInstance, object: AnimatedLike, name: string, out: THREE.Quaternion): THREE.Quaternion {
  const v = sampleRaw(instance, object, name);
  return v ? out.set(v[0], v[1], v[2], v[3]).normalize() : out.set(0, 0, 0, 1);
}

function colorFromArray(a: Float32Array | Uint32Array, fallback: THREE.Color, bgr = false): THREE.Color {
  if (a.length < 3) return fallback;
  return bgr ? new THREE.Color(a[2], a[1], a[0]) : new THREE.Color(a[0], a[1], a[2]);
}

function layerMaterial(layer: LayerLike, texture: THREE.Texture): THREE.MeshBasicMaterial {
  const transparent = layer.filterMode > 1 || layer.alpha < 1;
  const mat = new THREE.MeshBasicMaterial({ map: texture, transparent, depthTest: (layer.flags & 64) === 0, depthWrite: (layer.flags & 128) === 0 && layer.filterMode <= 1, side: (layer.flags & 16) !== 0 ? THREE.DoubleSide : THREE.FrontSide, alphaTest: layer.filterMode === 1 ? 0.75 : 0, vertexColors: false });
  mat.name = `mdx-layer-${layer.filterMode}`;
  // WC3 draws two-sided layers in one pass; three's default two-pass path also re-checks programs every draw.
  mat.forceSinglePass = true;
  if (layer.filterMode === 3 || layer.filterMode === 4) mat.blending = THREE.AdditiveBlending;
  else if (layer.filterMode === 5 || layer.filterMode === 6) {
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.DstColorFactor;
    mat.blendDst = layer.filterMode === 6 ? THREE.SrcColorFactor : THREE.ZeroFactor;
  } else mat.blending = THREE.NormalBlending;
  return mat;
}

function particleMaterial(filterMode: number, texture: THREE.Texture): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, vertexColors: true, forceSinglePass: true });
  if (filterMode === 1) mat.blending = THREE.AdditiveBlending;
  else if (filterMode === 2 || filterMode === 3) {
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.DstColorFactor;
    mat.blendDst = filterMode === 3 ? THREE.SrcColorFactor : THREE.ZeroFactor;
  } else mat.blending = THREE.NormalBlending;
  mat.alphaTest = filterMode === 4 ? 0.75 : 0.01;
  return mat;
}

async function resolveTexture(model: AnyModel, index: number): Promise<TextureSlot> {
  const tex = model.textures[index];
  if (tex.replaceableId === 1 || tex.replaceableId === 2) return { texture: getFallbackTexture(tex.replaceableId === 1 ? 'team-color' : 'team-glow'), path: tex.path, replaceableId: tex.replaceableId };
  const real = tex.path ? await assets.texture(tex.path) : null;
  // Missing originals come from the open texture pack: hand-written generators for effect
  // textures, or a skin baked onto this model's UV layout for unit textures.
  let texture = real;
  if (!texture && tex.path && (hasSkinRecipe(tex.path) || !hasOpenTexture(tex.path))) {
    const baked = bakeSkin(model as unknown as Parameters<typeof bakeSkin>[0], index);
    if (baked) texture = canvasTexture(baked, `fallback:baked:${tex.path}`);
  }
  texture ??= getFallbackTexture(tex.path || `replaceable-${tex.replaceableId}`);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, path: tex.path, replaceableId: tex.replaceableId };
}

function geosetGeometry(geoset: GeosetPrepared): THREE.BufferGeometry {
  if (geoset.geometry) return geoset.geometry;
  const g = new THREE.BufferGeometry();
  // Layers are unlit, so there are no normals; meshes aren't frustum culled, so no bounds.
  g.setAttribute('position', new THREE.BufferAttribute(geoset.positions, 3));
  g.setAttribute('mdxGroup', new THREE.BufferAttribute(geoset.vertexGroups, 1));
  g.setAttribute('uv', new THREE.BufferAttribute(geoset.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(geoset.indices, 1));
  geoset.geometry = g;
  return g;
}

/** Groups that fit in WebGL2's guaranteed 256 vertex uniform vectors at three vec4s each, leaving room for three.js's own. */
const MAX_UNIFORM_GROUPS = 76;

/**
 * WC3 skinning: each vertex belongs to one matrix group, whose matrix is the plain average of its bones'.
 * The averaged palette is uploaded as uniforms (a float texture for very large models; per-frame texture
 * uploads are much dearer than uniforms through ANGLE). The shader also converts model space (z up) to three.js (y up).
 */
function enableGpuSkinning(material: THREE.MeshBasicMaterial, palette: SkinPalette): void {
  const groups = palette.data.length / 12;
  const key = palette.texture ? 'tex' : String(groups);
  material.defines = palette.texture ? { MDX_SKIN_TEX: '' } : { MDX_SKIN_ROWS: groups * 3 };
  material.onBeforeCompile = (shader) => {
    if (palette.texture) shader.uniforms.mdxSkin = { value: palette.texture };
    else shader.uniforms.mdxBones = { value: palette.data };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `#ifdef MDX_SKIN_TEX
uniform highp sampler2D mdxSkin;
vec4 mdxRow(int i) { return texelFetch(mdxSkin, ivec2(i, 0), 0); }
#else
uniform vec4 mdxBones[MDX_SKIN_ROWS];
vec4 mdxRow(int i) { return mdxBones[i]; }
#endif
attribute float mdxGroup;
void main() {`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        int b = int(mdxGroup + 0.5) * 3;
        vec4 p = vec4(transformed, 1.0);
        transformed = vec3(dot(mdxRow(b), p), dot(mdxRow(b + 2), p), -dot(mdxRow(b + 1), p));
      }`);
  };
  material.customProgramCacheKey = () => `mdx-skin-${key}`;
}

function normalizedAttachmentName(name: string): string {
  return name.toLowerCase().replace(/\bref\b/g, '').replace(/alternate/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Forgets prepared models, e.g. after archives were added so missing textures can resolve. */
export function clearMdxCache(): void {
  modelCache.clear();
}

/** Loads and prepares a Warcraft III MDX model through the project asset store. */
export async function loadMdxModel(path: string): Promise<MdxModel | null> {
  const key = path.replace(/\//g, '\\').replace(/\.mdl$/i, '.mdx').toLowerCase();
  let promise = modelCache.get(key);
  if (!promise) {
    promise = (async () => {
      const source = (await assets.model(path)) as AnyModel | null;
      if (!source) return null;
      const model = new MdxModel(path, source);
      await model.prepare();
      return model;
    })();
    modelCache.set(key, promise);
  }
  return promise;
}

/** Shared prepared MDX data. Create renderable Object3D instances with createInstance(). */
export class MdxModel {
  readonly textures: TextureSlot[] = [];
  readonly geosets: GeosetPrepared[] = [];
  readonly nodes: NodeInfo[] = [];
  readonly nodeByObjectId = new Map<number, NodeInfo>();
  /** Matrix groups deduplicated across geosets (they mostly share the same bones): offsets into groupBones. */
  groupOffsets = new Uint32Array(1);
  /** Object IDs of each group's bones. */
  groupBones = new Uint32Array(0);

  constructor(readonly path: string, readonly source: AnyModel) {}

  /** True if the model has a sequence whose first word matches `name` (case-insensitive). */
  hasSequence(name: string): boolean {
    const n = name.toLowerCase();
    return this.source.sequences.some((s) => s.name.toLowerCase().split(/\s|-/, 1)[0] === n);
  }

  /** Creates an animated three.js Object3D instance of this model. */
  createInstance(): MdxInstance {
    return new MdxInstance(this);
  }

  async prepare(): Promise<void> {
    for (let i = 0; i < this.source.textures.length; i++) this.textures.push(await resolveTexture(this.source, i));
    this.prepareNodes();
    this.prepareGeosets();
  }

  dispose(): void {
    for (const t of this.textures) if (t.texture.name.startsWith('fallback:')) t.texture.dispose();
  }

  private prepareNodes(): void {
    const all: GenericLike[] = [
      ...this.source.bones,
      ...this.source.helpers,
      ...this.source.attachments,
      ...this.source.particleEmitters,
      ...this.source.particleEmitters2,
      ...this.source.ribbonEmitters,
      ...this.source.eventObjects,
      ...this.source.collisionShapes,
    ];
    const byId = new Map<number, GenericLike>();
    for (const o of all) byId.set(o.objectId, o);
    const visited = new Set<number>();
    const visit = (o: GenericLike): void => {
      if (visited.has(o.objectId)) return;
      const parent = byId.get(o.parentId);
      if (parent && parent.objectId !== o.objectId) visit(parent);
      visited.add(o.objectId);
      const p = this.source.pivotPoints[o.objectId] ?? new Float32Array([0, 0, 0]);
      const node = { object: o, pivot: new THREE.Vector3(p[0], p[1], p[2]), parentObjectId: o.parentId === o.objectId ? -1 : o.parentId };
      this.nodes.push(node);
      this.nodeByObjectId.set(o.objectId, node);
    };
    for (const o of all) visit(o);
  }

  private prepareGeosets(): void {
    const groupIds = new Map<string, number>();
    const offsets = [0];
    const bones: number[] = [];
    const groupId = (ids: number[]): number => {
      const key = ids.length ? [...ids].sort((a, b) => a - b).join(',') : 'none';
      let id = groupIds.get(key);
      if (id === undefined) {
        id = offsets.length - 1;
        groupIds.set(key, id);
        bones.push(...ids);
        offsets.push(bones.length);
      }
      return id;
    };
    for (let i = 0; i < this.source.geosets.length; i++) {
      const geoset = this.source.geosets[i];
      const material = this.source.materials[geoset.materialId];
      const remap: number[] = [];
      for (let g = 0, j = 0; g < geoset.matrixGroups.length; j += geoset.matrixGroups[g], g++) remap.push(groupId(Array.from(geoset.matrixIndices.subarray(j, j + geoset.matrixGroups[g]))));
      const count = geoset.vertices.length / 3;
      const vertexGroups = new Float32Array(count);
      for (let v = 0; v < count; v++) vertexGroups[v] = remap[geoset.vertexGroups[v] ?? 0] ?? groupId([]);
      const layers: LayerSlot[] = [];
      for (const layer of material?.layers ?? []) {
        const tex = this.textures[layer.textureId] ?? { texture: getFallbackTexture('unknown'), path: 'unknown', replaceableId: 0 };
        layers.push({ layer, texture: tex, baseMaterial: layerMaterial(layer, tex.texture) });
      }
      const gsa = this.source.geosetAnimations.find((a) => a.geosetId === i) ?? this.source.geosetAnimations.find((a) => a.geosetId === -1) ?? null;
      this.geosets.push({ geoset, positions: geoset.vertices, normals: geoset.normals, uvs: geoset.uvSets[0] ?? new Float32Array((geoset.vertices.length / 3) * 2), indices: geoset.faces, vertexGroups, layers, geosetAnimation: gsa });
    }
    this.groupOffsets = Uint32Array.from(offsets);
    this.groupBones = Uint32Array.from(bones);
  }
}

/** A renderable, animated MDX instance. Update it once per frame with dt and camera. */
export class MdxInstance extends THREE.Object3D {
  sequenceIndex = -1;
  frameMs = 0;
  globalMs = 0;
  sequenceEnded = false;
  onSequenceEnd?: (instance: MdxInstance) => void;
  opacity = 1;
  readonly nodeStates: NodeState[] = [];
  private readonly nodesById = new Map<number, NodeState>();
  private readonly meshes: MeshSlot[] = [];
  private readonly skins: SkinSlot[] = [];
  private palette!: SkinPalette;
  /** World matrix elements of each entry in model.groupBones (identity for missing bones). */
  private groupBoneElems: number[][] = [];
  private readonly attachments = new Map<string, THREE.Object3D>();
  private readonly attachmentLinks: { node: NodeState; obj: THREE.Object3D }[] = [];
  private readonly pe2: ParticleEmitter2View[] = [];
  private readonly ribbons: RibbonEmitterView[] = [];
  private _teamColor = defaultTeam.clone();
  private teamColorTexture = makeTeamColorTexture(defaultTeam, false);
  private teamGlowTexture = makeTeamColorTexture(defaultTeam, true);
  private loop = true;

  constructor(readonly model: MdxModel) {
    super();
    this.name = `MdxInstance:${model.path}`;
    this.buildNodes();
    this.buildMeshes();
    this.buildAttachments();
    this.buildEmitters();
    this.setSequence(0, true);
  }

  get sequence(): SequenceLike | null {
    return this.sequenceIndex >= 0 ? this.model.source.sequences[this.sequenceIndex] : null;
  }

  get teamColor(): THREE.Color {
    return this._teamColor;
  }

  set teamColor(color: THREE.Color) {
    this._teamColor.copy(color);
    this.teamColorTexture.dispose();
    this.teamGlowTexture.dispose();
    this.teamColorTexture = makeTeamColorTexture(color, false);
    this.teamGlowTexture = makeTeamColorTexture(color, true);
    this.refreshTeamTextures();
  }

  /** Selects an animation by index or by the first word of its name; variants are chosen randomly like WC3. */
  setSequence(nameOrIndex: string | number, loop?: boolean): void {
    const seqs = this.model.source.sequences;
    if (typeof nameOrIndex === 'number') this.sequenceIndex = THREE.MathUtils.clamp(Math.floor(nameOrIndex), 0, Math.max(0, seqs.length - 1));
    else {
      const needle = nameOrIndex.toLowerCase();
      const wantsAlternate = /\balternate\b/.test(needle);
      const matches = seqs.map((s, i) => ({ s, i })).filter(({ s }) => {
        const name = s.name.toLowerCase();
        if (!wantsAlternate && /\balternate\b/.test(name)) return false;
        if (wantsAlternate && !/\balternate\b/.test(name)) return false;
        return name.split(/\s|-/, 1)[0] === needle.split(/\s+/, 1)[0] || name.startsWith(needle);
      });
      this.sequenceIndex = matches.length ? matches[Math.floor(Math.random() * matches.length)].i : (seqs.length ? 0 : -1);
    }
    const seq = this.sequence;
    this.frameMs = seq ? seq.interval[0] : 0;
    this.sequenceEnded = false;
    this.loop = loop ?? (seq ? !seq.nonLooping : true);
    for (const e of this.pe2) e.clear();
    for (const r of this.ribbons) r.clear();
    this.update(0, setupCamera);
  }

  /** Advances animation, node transforms, skinning, particle emitters, ribbons, and attachments. */
  update(dtSeconds: number, camera: THREE.Camera): void {
    const seq = this.sequence;
    this.globalMs += dtSeconds * 1000;
    if (seq && !this.sequenceEnded) {
      this.frameMs += dtSeconds * 1000;
      const start = seq.interval[0];
      const end = seq.interval[1];
      const length = Math.max(1, end - start);
      if (this.frameMs > end) {
        if (this.loop) this.frameMs = start + ((this.frameMs - start) % length);
        else {
          this.frameMs = end;
          this.sequenceEnded = true;
          this.onSequenceEnd?.(this);
        }
      }
    }
    this.updateNodes(camera);
    this.updateAttachments();
    this.updateGeosets();
    const spawn = !this.sequenceEnded || this.loop;
    for (const e of this.pe2) e.update(dtSeconds, camera, spawn);
    for (const r of this.ribbons) r.update(dtSeconds, spawn);
  }

  /** Returns an Object3D following an MDX attachment such as 'hand right', 'origin', or 'overhead'. */
  getAttachment(name: string): THREE.Object3D | null {
    return this.attachments.get(normalizedAttachmentName(name)) ?? null;
  }

  dispose(): void {
    this.palette.texture?.dispose();
    for (const m of this.meshes) {
      if (m.mapWasCloned) m.material.map?.dispose();
      m.material.dispose();
    }
    for (const e of this.pe2) e.dispose();
    for (const r of this.ribbons) r.dispose();
    this.teamColorTexture.dispose();
    this.teamGlowTexture.dispose();
  }

  private buildNodes(): void {
    for (const info of this.model.nodes) {
      const state: NodeState = { ...info, parent: null, local: new THREE.Matrix4(), world: new THREE.Matrix4(), worldConverted: new THREE.Matrix4(), visible: 1 };
      this.nodeStates.push(state);
      this.nodesById.set(info.object.objectId, state);
    }
    for (const node of this.nodeStates) node.parent = this.nodesById.get(node.parentObjectId) ?? null;
  }

  private buildMeshes(): void {
    const model = this.model;
    const groups = Math.max(1, model.groupOffsets.length - 1);
    // Round up so models share a few program variants.
    const slots = groups <= 8 ? 8 : groups <= 32 ? 32 : groups <= MAX_UNIFORM_GROUPS ? MAX_UNIFORM_GROUPS : groups;
    const data = new Float32Array(slots * 12);
    this.palette = { data, texture: slots > MAX_UNIFORM_GROUPS ? new THREE.DataTexture(data, slots * 3, 1, THREE.RGBAFormat, THREE.FloatType) : null };
    this.groupBoneElems = Array.from(model.groupBones, (id) => (this.nodesById.get(id)?.world ?? identity).elements);
    for (const geoset of this.model.geosets) {
      if (!geoset.layers.length) continue;
      const geometry = geosetGeometry(geoset);
      const skin: SkinSlot = { geoset, layers: [] };
      this.skins.push(skin);
      for (const layer of geoset.layers) {
        const material = layer.baseMaterial.clone();
        let mapWasCloned = false;
        if (layer.layer.textureAnimationId >= 0 && material.map) {
          material.map = material.map.clone();
          material.map.needsUpdate = true;
          mapWasCloned = true;
        }
        if (layer.texture.replaceableId === 1) material.map = this.teamColorTexture;
        else if (layer.texture.replaceableId === 2) material.map = this.teamGlowTexture;
        enableGpuSkinning(material, this.palette);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        this.add(mesh);
        const slot: MeshSlot = { geoset, mesh, material, layer, mapWasCloned };
        this.meshes.push(slot);
        skin.layers.push(slot);
      }
    }
  }

  private buildAttachments(): void {
    for (const att of this.model.source.attachments) {
      const obj = new THREE.Object3D();
      obj.name = `Attachment:${att.name}`;
      obj.matrixAutoUpdate = false;
      this.add(obj);
      this.attachments.set(normalizedAttachmentName(att.name), obj);
    }
    for (const att of this.model.source.attachments) {
      const node = this.nodesById.get(att.objectId);
      const obj = this.attachments.get(normalizedAttachmentName(att.name));
      if (node && obj) this.attachmentLinks.push({ node, obj });
    }
  }

  private buildEmitters(): void {
    for (const pe of this.model.source.particleEmitters2) this.pe2.push(new ParticleEmitter2View(this, pe));
    for (const re of this.model.source.ribbonEmitters) this.ribbons.push(new RibbonEmitterView(this, re));
  }

  private refreshTeamTextures(): void {
    for (const slot of this.meshes) {
      if (slot.layer.texture.replaceableId === 1) slot.material.map = this.teamColorTexture;
      if (slot.layer.texture.replaceableId === 2) slot.material.map = this.teamGlowTexture;
      slot.material.needsUpdate = true;
    }
  }

  private updateNodes(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    for (const node of this.nodeStates) {
      const obj = node.object;
      const t = sampleVector(this, obj, 'KGTR', 0, 0, 0, tempT);
      const r = sampleQuat(this, obj, 'KGRT', tempR);
      const s = sampleVector(this, obj, 'KGSC', 1, 1, 1, tempSc);
      tempM.makeTranslation(node.pivot.x + t.x, node.pivot.y + t.y, node.pivot.z + t.z);
      tempM.multiply(tempM2.makeRotationFromQuaternion(r));
      tempM.scale(s);
      tempM.multiply(tempM2.makeTranslation(-node.pivot.x, -node.pivot.y, -node.pivot.z));
      node.local.copy(tempM);
      if (node.parent) {
        tempM2.copy(node.parent.world);
        if ((obj.flags & 1) || (obj.flags & 2) || (obj.flags & 4)) {
          tempM2.decompose(tempV, tempQ, tempS);
          if (obj.flags & 1) tempV.set(0, 0, 0);
          if (obj.flags & 4) tempQ.identity();
          if (obj.flags & 2) tempS.set(1, 1, 1);
          tempM2.compose(tempV, tempQ, tempS);
        }
        node.world.multiplyMatrices(tempM2, node.local);
      } else node.world.copy(node.local);
      if (obj.flags & 8) {
        node.world.decompose(tempV, tempQ, tempS);
        tempQ.copy(camera.quaternion);
        node.world.compose(tempV, tempQ, tempS);
      }
      node.worldConverted.multiplyMatrices(convertMatrix, node.world).multiply(convertMatrixInv);
      if ('attachmentId' in obj) node.visible = sampleScalar(this, obj, 'KATV', 1);
      else if ('emissionRate' in obj && 'lifeSpan' in obj) node.visible = sampleScalar(this, obj, 'KP2V', 1);
      else node.visible = 1;
    }
  }

  private updateAttachments(): void {
    for (const { node, obj } of this.attachmentLinks) {
      obj.visible = node.visible > 0.01;
      obj.matrix.copy(node.worldConverted);
      obj.matrixWorldNeedsUpdate = true;
    }
  }

  private updateGeosets(): void {
    let shown = false;
    for (const skin of this.skins) {
      for (const slot of skin.layers) {
        this.updateMaterial(slot);
        slot.mesh.visible = slot.material.opacity > 0.002;
        shown ||= slot.mesh.visible;
      }
    }
    if (shown && this.visible) this.updatePalette();
  }

  private updatePalette(): void {
    const offsets = this.model.groupOffsets;
    const bones = this.groupBoneElems;
    const pal = this.palette.data;
    for (let g = 0, groups = offsets.length - 1; g < groups; g++) {
      const start = offsets[g];
      const end = offsets[g + 1];
      const o = g * 12;
      if (end === start) {
        pal.fill(0, o, o + 12);
        pal[o] = pal[o + 5] = pal[o + 10] = 1;
        continue;
      }
      // Column-major source; row r of the palette entry is (e[r], e[4 + r], e[8 + r], e[12 + r]).
      const inv = 1 / (end - start);
      let e = bones[start];
      for (let r = 0; r < 3; r++) {
        pal[o + r * 4] = e[r];
        pal[o + r * 4 + 1] = e[4 + r];
        pal[o + r * 4 + 2] = e[8 + r];
        pal[o + r * 4 + 3] = e[12 + r];
      }
      if (end - start === 1) continue;
      for (let j = start + 1; j < end; j++) {
        e = bones[j];
        for (let r = 0; r < 3; r++) {
          pal[o + r * 4] += e[r];
          pal[o + r * 4 + 1] += e[4 + r];
          pal[o + r * 4 + 2] += e[8 + r];
          pal[o + r * 4 + 3] += e[12 + r];
        }
      }
      for (let k = 0; k < 12; k++) pal[o + k] *= inv;
    }
    if (this.palette.texture) this.palette.texture.needsUpdate = true;
  }

  private updateMaterial(slot: MeshSlot): void {
    const layer = slot.layer.layer;
    const geoa = slot.geoset.geosetAnimation;
    const layerAlpha = sampleScalar(this, layer, 'KMTA', layer.alpha);
    const geosetAlpha = geoa ? sampleScalar(this, geoa, 'KGAO', geoa.alpha) : 1;
    const colorTrack = geoa ? sampleTrack(this, geoa, 'KGAC', geoa.color) : null;
    const color = colorTrack && colorTrack.length >= 3 ? tempColor.setRGB(colorTrack[2], colorTrack[1], colorTrack[0]) : tempColor.setRGB(1, 1, 1);
    const replaceableScale = slot.layer.texture.replaceableId === 2 ? 0.38 : 1;
    slot.material.opacity = THREE.MathUtils.clamp(layerAlpha * geosetAlpha * this.opacity * replaceableScale, 0, 1);
    slot.material.transparent = slot.material.opacity < 0.999 || layer.filterMode > 1;
    slot.material.color.copy(color);
    if (layer.textureAnimationId >= 0 && slot.material.map) this.updateTextureTransform(slot.material.map, this.model.source.textureAnimations[layer.textureAnimationId]);
  }

  private updateTextureTransform(texture: THREE.Texture, tx: AnimatedLike | undefined): void {
    if (!tx) return;
    const t = sampleVector(this, tx, 'KTAT', 0, 0, 0, tempT);
    const r = sampleQuat(this, tx, 'KTAR', tempR);
    const s = sampleVector(this, tx, 'KTAS', 1, 1, 1, tempSc);
    texture.offset.set(t.x, t.y);
    texture.repeat.set(s.x || 1, s.y || 1);
    texture.rotation = tempEuler.setFromQuaternion(r).z;
  }
}

/**
 * Growable vertex buffers for camera-facing quads or ribbon strips. Buffers are reused between
 * frames and only the used range is uploaded, instead of reallocating GPU buffers every frame.
 */
class DynamicMesh {
  readonly geometry = new THREE.BufferGeometry();
  positions = new Float32Array(0);
  uvs = new Float32Array(0);
  colors = new Float32Array(0);
  private cap = 0;

  constructor(private readonly kind: 'quads' | 'strip') {}

  /** Makes room for `n` quads (or `n` strip points). */
  ensure(n: number): void {
    if (n <= this.cap) return;
    const cap = Math.max(16, 2 ** Math.ceil(Math.log2(n)));
    const verts = this.kind === 'quads' ? cap * 4 : cap * 2;
    this.geometry.dispose();
    this.positions = new Float32Array(verts * 3);
    this.uvs = new Float32Array(verts * 2);
    this.colors = new Float32Array(verts * 4);
    const index = new Uint16Array(this.kind === 'quads' ? cap * 6 : Math.max(0, cap - 1) * 6);
    for (let i = 0; i * 6 < index.length; i++) {
      const b = this.kind === 'quads' ? i * 4 : i * 2;
      if (this.kind === 'quads') index.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
      else index.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6);
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.cap = cap;
  }

  /** Uploads the first `verts` vertices and draws `indices` indices. */
  commit(verts: number, indices: number): void {
    this.geometry.setDrawRange(0, indices);
    if (verts === 0) return;
    for (const name of ['position', 'uv', 'color']) {
      const attr = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, verts * attr.itemSize);
      attr.needsUpdate = true;
    }
  }
}

class ParticleEmitter2View {
  private readonly particles: Particle2[] = [];
  private readonly mesh: THREE.Mesh;
  private readonly buffers = new DynamicMesh('quads');
  private emission = 0;
  private lastKey = -1;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly texture: THREE.Texture;

  constructor(private readonly instance: MdxInstance, private readonly emitter: ParticleEmitter2Like) {
    const modelTex = instance.model.textures[emitter.textureId];
    const baseTex = emitter.replaceableId === 1 ? instance['teamColorTexture'] : emitter.replaceableId === 2 ? instance['teamGlowTexture'] : modelTex?.texture;
    this.texture = baseTex?.name.startsWith('fallback:')
      ? getFallbackTexture(modelTex?.path ?? emitter.name, emitter.rows, emitter.columns)
      : (baseTex ?? getFallbackTexture(modelTex?.path ?? emitter.name, emitter.rows, emitter.columns));
    this.material = particleMaterial(emitter.filterMode, this.texture);
    this.mesh = new THREE.Mesh(this.buffers.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = emitter.filterMode === 1 ? 30 : 20;
    instance.add(this.mesh);
  }

  clear(): void {
    this.particles.length = 0;
    this.emission = 0;
    this.lastKey = -1;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.buffers.geometry.dispose();
    this.material.dispose();
  }

  update(dt: number, camera: THREE.Camera, allowSpawn: boolean): void {
    const visibility = sampleScalar(this.instance, this.emitter, 'KP2V', 1);
    if (allowSpawn && visibility > 0.01 && dt > 0) {
      const key = this.emitter.squirt ? Math.floor(this.instance.frameMs) : -1;
      const rate = Math.max(0, sampleScalar(this.instance, this.emitter, 'KP2E', this.emitter.emissionRate));
      if (this.emitter.squirt) {
        if (key !== this.lastKey) this.emission += rate;
        this.lastKey = key;
      } else this.emission += rate * dt;
      const emitCount = Math.min(80, Math.floor(this.emission));
      this.emission -= emitCount;
      for (let i = 0; i < emitCount; i++) this.emit();
    }
    let live = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.health -= dt;
      if (p.health > 0) {
        p.velocity.z -= p.gravity * dt;
        p.location.addScaledVector(p.velocity, dt);
        this.particles[live++] = p;
      }
    }
    this.particles.length = live;
    this.rebuild(camera);
  }

  private emit(): void {
    if (this.particles.length > 700) this.particles.splice(0, this.particles.length - 700);
    const headOrTail = this.emitter.headOrTail;
    if (headOrTail === 0 || headOrTail === 2) this.spawn(false);
    if (headOrTail === 1 || headOrTail === 2) this.spawn(true);
  }

  private spawn(tail: boolean): void {
    const node = this.instance['nodesById'].get(this.emitter.objectId);
    if (!node) return;
    const width = sampleScalar(this.instance, this.emitter, 'KP2N', this.emitter.width) * 0.5;
    const length = sampleScalar(this.instance, this.emitter, 'KP2W', this.emitter.length) * 0.5;
    const speed = sampleScalar(this.instance, this.emitter, 'KP2S', this.emitter.speed);
    const variation = sampleScalar(this.instance, this.emitter, 'KP2R', this.emitter.variation);
    const latitude = THREE.MathUtils.degToRad(sampleScalar(this.instance, this.emitter, 'KP2L', this.emitter.latitude));
    const gravity = sampleScalar(this.instance, this.emitter, 'KP2G', this.emitter.gravity);
    const location = node.pivot.clone().add(new THREE.Vector3(THREE.MathUtils.randFloat(-width, width), THREE.MathUtils.randFloat(-length, length), 0));
    const dir = new THREE.Vector3(0, 0, 1);
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.randFloat(-latitude, latitude));
    dir.applyAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.randFloat(-latitude, latitude));
    if ((this.emitter.flags & 524288) === 0) {
      location.applyMatrix4(node.world);
      node.world.decompose(tempV, tempQ, tempS);
      dir.applyQuaternion(tempQ).multiply(tempS);
    }
    dir.normalize().multiplyScalar(speed * (1 + THREE.MathUtils.randFloat(-variation, variation)));
    this.particles.push({ location, velocity: dir, health: this.emitter.lifeSpan, life: this.emitter.lifeSpan, tail, gravity, scale: 1, cellOffset: Math.floor(Math.random() * this.emitter.rows * this.emitter.columns) });
  }

  private rebuild(camera: THREE.Camera): void {
    const count = this.particles.length;
    this.mesh.visible = count > 0;
    if (count === 0) return;
    const buf = this.buffers;
    buf.ensure(count);
    const positions = buf.positions;
    const uvs = buf.uvs;
    const colors = buf.colors;
    this.instance.updateWorldMatrix(true, false);
    const inv = tempM.copy(this.instance.matrixWorld).invert();
    const right = tempT.set(1, 0, 0).applyQuaternion(camera.quaternion).transformDirection(inv);
    const up = tempSc.set(0, 1, 0).applyQuaternion(camera.quaternion).transformDirection(inv);
    const e = this.emitter;
    const middle = THREE.MathUtils.clamp(e.timeMiddle, 0.001, 0.999);
    const fade = this.instance.opacity;
    const facingQuads = (e.flags & 1048576) !== 0;
    const tailLen = e.tailLength * 0.35;
    for (let i = 0; i < count; i++) {
      const p = this.particles[i];
      const age = 1 - p.health / Math.max(0.001, p.life);
      const second = age >= middle;
      const i0 = second ? 1 : 0;
      const f = second ? (age - middle) / (1 - middle) : age / middle;
      const half = Math.max(1, THREE.MathUtils.lerp(e.segmentScaling[i0], e.segmentScaling[i0 + 1], f) * 0.5);
      const c0 = e.segmentColors[i0];
      const c1 = e.segmentColors[i0 + 1];
      const cr = c0[0] + (c1[0] - c0[0]) * f;
      const cg = c0[1] + (c1[1] - c0[1]) * f;
      const cb = c0[2] + (c1[2] - c0[2]) * f;
      const ca = THREE.MathUtils.lerp(e.segmentAlphas[i0] / 255, e.segmentAlphas[i0 + 1] / 255, f) * fade;
      // Model (z up) to three.js (y up).
      const lx = p.location.x;
      const ly = p.location.z;
      const lz = -p.location.y;
      let rx = right.x * half, ry = right.y * half, rz = right.z * half;
      let ux = up.x * half, uy = up.y * half, uz = up.z * half;
      if (facingQuads) {
        const facing = Math.atan2(p.velocity.y, p.velocity.x);
        const cs = Math.cos(facing);
        const sn = Math.sin(facing);
        rx = cs * half; ry = 0; rz = -sn * half;
        ux = sn * half; uy = 0; uz = cs * half;
      }
      let tx = 0, ty = 0, tz = 0;
      if (p.tail) {
        const vx = p.velocity.x, vy = p.velocity.z, vz = -p.velocity.y;
        const len = Math.hypot(vx, vy, vz) || 1;
        tx = (vx / len) * tailLen; ty = (vy / len) * tailLen; tz = (vz / len) * tailLen;
      }
      const o = i * 12;
      positions[o] = lx - rx - ux; positions[o + 1] = ly - ry - uy; positions[o + 2] = lz - rz - uz;
      positions[o + 3] = lx + rx - ux; positions[o + 4] = ly + ry - uy; positions[o + 5] = lz + rz - uz;
      positions[o + 6] = lx + rx + ux - tx; positions[o + 7] = ly + ry + uy - ty; positions[o + 8] = lz + rz + uz - tz;
      positions[o + 9] = lx - rx + ux - tx; positions[o + 10] = ly - ry + uy - ty; positions[o + 11] = lz - rz + uz - tz;
      for (let v = 0, c = i * 16; v < 4; v++, c += 4) {
        colors[c] = cr;
        colors[c + 1] = cg;
        colors[c + 2] = cb;
        colors[c + 3] = ca;
      }
      const cell = this.cellFor(p, age);
      const cols = Math.max(1, e.columns);
      const rows = Math.max(1, e.rows);
      const u0 = (cell % cols) / cols;
      const v0 = Math.floor(cell / cols) / rows;
      const u1 = u0 + 1 / cols;
      const v1 = v0 + 1 / rows;
      const q = i * 8;
      uvs[q] = u0; uvs[q + 1] = v1;
      uvs[q + 2] = u1; uvs[q + 3] = v1;
      uvs[q + 4] = u1; uvs[q + 5] = v0;
      uvs[q + 6] = u0; uvs[q + 7] = v0;
    }
    buf.commit(count * 4, count * 6);
  }

  /** Sprite-sheet cell for a particle at life fraction t, as WC3 picks it (see mdx-m3-viewer's getCell). */
  private cellFor(p: Particle2, t: number): number {
    const cols = Math.max(1, this.emitter.columns);
    const rows = Math.max(1, this.emitter.rows);
    let cell: number;
    if (this.emitter.replaceableId === 1) cell = p.cellOffset;
    else {
      const middle = this.emitter.timeMiddle;
      const second = t >= middle;
      const f = Math.min(1, second ? (t - middle) / Math.max(1e-6, 1 - middle) : t / Math.max(1e-6, middle));
      const intervals = p.tail ? this.emitter.tailIntervals : this.emitter.headIntervals;
      const interval = intervals[second ? 1 : 0];
      const start = interval?.[0] ?? 0;
      const count = (interval?.[1] ?? start) - start;
      const repeat = interval?.[2] ?? 1;
      cell = count > 0 ? Math.min(start + (Math.floor(count * repeat * f) % count), rows * cols - 1) : start;
    }
    return cell;
  }
}

class RibbonEmitterView {
  private readonly points: RibbonPoint[] = [];
  private readonly buffers = new DynamicMesh('strip');
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.Mesh;
  private emission = 0;

  constructor(private readonly instance: MdxInstance, private readonly emitter: RibbonEmitterLike) {
    const mat = instance.model.source.materials[emitter.materialId]?.layers[0];
    const slot = mat ? instance.model.textures[mat.textureId] : undefined;
    const tex = slot?.texture.name.startsWith('fallback:') ? getFallbackTexture(slot.path, emitter.rows, emitter.columns) : slot?.texture;
    this.material = particleMaterial(mat?.filterMode ?? 2, tex ?? getFallbackTexture(emitter.name, emitter.rows, emitter.columns));
    this.mesh = new THREE.Mesh(this.buffers.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 25;
    instance.add(this.mesh);
  }

  clear(): void {
    this.points.length = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.buffers.geometry.dispose();
    this.material.dispose();
  }

  update(dt: number, allowSpawn: boolean): void {
    if (allowSpawn && sampleScalar(this.instance, this.emitter, 'KRVS', 1) > 0.01) {
      this.emission += this.emitter.emissionRate * dt;
      if (this.emission >= 1) {
        this.emission %= 1;
        this.spawn();
      }
    }
    let live = 0;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      p.health -= dt;
      p.above.z -= this.emitter.gravity * dt * dt;
      p.below.z -= this.emitter.gravity * dt * dt;
      if (p.health > 0) this.points[live++] = p;
    }
    this.points.length = live;
    this.rebuild();
  }

  private spawn(): void {
    const node = this.instance['nodesById'].get(this.emitter.objectId);
    if (!node) return;
    const above = sampleScalar(this.instance, this.emitter, 'KRHA', this.emitter.heightAbove);
    const below = sampleScalar(this.instance, this.emitter, 'KRHB', this.emitter.heightBelow);
    const alpha = sampleScalar(this.instance, this.emitter, 'KRAL', this.emitter.alpha);
    const color = colorFromArray(sampleTrack(this.instance, this.emitter, 'KRCO', this.emitter.color), new THREE.Color(1, 1, 1));
    const slot = sampleScalar(this.instance, this.emitter, 'KRTX', this.emitter.textureSlot);
    const high = node.pivot.clone().add(new THREE.Vector3(0, above, 0)).applyMatrix4(node.world);
    const low = node.pivot.clone().add(new THREE.Vector3(0, -below, 0)).applyMatrix4(node.world);
    this.points.push({ above: high, below: low, health: this.emitter.lifeSpan, life: this.emitter.lifeSpan, color, alpha, slot });
  }

  private rebuild(): void {
    const n = this.points.length;
    this.mesh.visible = n > 1;
    if (n < 2) return;
    const buf = this.buffers;
    buf.ensure(n);
    const { positions, uvs, colors } = buf;
    const cols = Math.max(1, this.emitter.columns);
    const cw = 1 / cols;
    const ch = 1 / Math.max(1, this.emitter.rows);
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const o = i * 6;
      positions[o] = p.above.x; positions[o + 1] = p.above.z; positions[o + 2] = -p.above.y;
      positions[o + 3] = p.below.x; positions[o + 4] = p.below.z; positions[o + 5] = -p.below.y;
      const u = i / (n - 1);
      const row = Math.floor(p.slot / cols);
      const col = p.slot % cols;
      const q = i * 4;
      uvs[q] = col * cw + u * cw; uvs[q + 1] = row * ch;
      uvs[q + 2] = col * cw + u * cw; uvs[q + 3] = (row + 1) * ch;
      const alpha = p.alpha * (p.health / p.life) * this.instance.opacity;
      const c = i * 8;
      colors[c] = colors[c + 4] = p.color.r;
      colors[c + 1] = colors[c + 5] = p.color.g;
      colors[c + 2] = colors[c + 6] = p.color.b;
      colors[c + 3] = colors[c + 7] = alpha;
    }
    buf.commit(n * 2, (n - 1) * 6);
  }
}

export type { ParsedMdlxModel as MdlxModelData };
