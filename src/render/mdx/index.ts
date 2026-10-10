import * as THREE from 'three';
import { assets, type MdlxModel as ParsedMdlxModel } from '../../assets/store';
import { getFallbackTexture, makeTeamColorTexture } from './fallbackTextures';

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
const tempV2 = new THREE.Vector3();
const tempQ = new THREE.Quaternion();
const tempS = new THREE.Vector3();
const tempM = new THREE.Matrix4();
const tempM2 = new THREE.Matrix4();
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
  groupOffsets: Uint32Array;
  layers: LayerSlot[];
  geosetAnimation: GeosetAnimLike | null;
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
  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  positionAttr: THREE.BufferAttribute;
  normalAttr: THREE.BufferAttribute;
  material: THREE.MeshBasicMaterial;
  layer: LayerSlot;
  mapWasCloned: boolean;
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

function modelToThree(v: THREE.Vector3): THREE.Vector3 {
  return v.set(v.x, v.z, -v.y);
}

function directionToThree(v: THREE.Vector3): THREE.Vector3 {
  return v.set(v.x, v.z, -v.y);
}

function trackMap(object: AnimatedLike): Map<string, AnimationTrack> {
  const keyed = object as AnimatedLike & { __mdxTrackMap?: Map<string, AnimationTrack> };
  if (!keyed.__mdxTrackMap) keyed.__mdxTrackMap = new Map(object.animations.map((a) => [a.name, a]));
  return keyed.__mdxTrackMap;
}

function scalarDefault(name: string, fallback: number): Float32Array {
  if (name === 'KMTA' || name === 'KGAO' || name === 'KP2V' || name === 'KRVS') return new Float32Array([1]);
  return new Float32Array([fallback]);
}

function sampleTrack(instance: MdxInstance, object: AnimatedLike, name: string, fallback: TrackValue): TrackValue {
  const track = trackMap(object).get(name);
  if (!track || instance.sequenceIndex < 0) return fallback;
  let start = 0;
  let end = 0;
  let frame = instance.frameMs;
  if (track.globalSequenceId !== -1 && instance.model.source.globalSequences[track.globalSequenceId] !== undefined) {
    end = instance.model.source.globalSequences[track.globalSequenceId];
    frame = end > 0 ? instance.globalMs % end : 0;
  } else {
    const interval = instance.sequence?.interval;
    if (!interval) return fallback;
    start = interval[0];
    end = interval[1];
  }
  const frames = track.frames;
  const keyIndices: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (track.globalSequenceId !== -1 || (f >= start && f <= end)) keyIndices.push(i);
  }
  if (keyIndices.length === 0) return fallback;
  if (keyIndices.length === 1 || frame < frames[keyIndices[0]]) return track.values[keyIndices[0]];
  let a = keyIndices[keyIndices.length - 1];
  let b = keyIndices[0];
  for (let i = 1; i < keyIndices.length; i++) {
    const idx = keyIndices[i];
    if (frames[idx] > frame) {
      a = keyIndices[i - 1];
      b = idx;
      break;
    }
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

function interpolateTrack(track: AnimationTrack, a: number, b: number, t: number): TrackValue {
  const av = track.values[a];
  const bv = track.values[b];
  if (av.length === 1) {
    const out = new Float32Array(1);
    const at = av[0];
    const bt = bv[0];
    if (track.interpolationType === 2 || track.interpolationType === 3) {
      out[0] = hermite(at, track.outTans[a]?.[0] ?? at, track.inTans[b]?.[0] ?? bt, bt, t);
    } else out[0] = THREE.MathUtils.lerp(at, bt, t);
    return out;
  }
  if (av.length === 4) {
    const qa = new THREE.Quaternion(av[0], av[1], av[2], av[3]).normalize();
    const qb = new THREE.Quaternion(bv[0], bv[1], bv[2], bv[3]).normalize();
    qa.slerp(qb, t);
    return new Float32Array([qa.x, qa.y, qa.z, qa.w]);
  }
  const out = new Float32Array(av.length);
  for (let i = 0; i < av.length; i++) out[i] = THREE.MathUtils.lerp(av[i], bv[i], t);
  return out;
}

function hermite(a: number, at: number, bt: number, b: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * at + (-2 * t3 + 3 * t2) * b + (t3 - t2) * bt;
}

function sampleScalar(instance: MdxInstance, object: AnimatedLike, name: string, fallback: number): number {
  return sampleTrack(instance, object, name, scalarDefault(name, fallback))[0];
}

function sampleVector(instance: MdxInstance, object: AnimatedLike, name: string, fallback: THREE.Vector3): THREE.Vector3 {
  const v = sampleTrack(instance, object, name, new Float32Array([fallback.x, fallback.y, fallback.z]));
  return tempV.set(v[0], v[1], v[2]);
}

function sampleQuat(instance: MdxInstance, object: AnimatedLike, name: string): THREE.Quaternion {
  const v = sampleTrack(instance, object, name, new Float32Array([0, 0, 0, 1]));
  return tempQ.set(v[0], v[1], v[2], v[3]).normalize();
}

function colorFromArray(a: Float32Array | Uint32Array, fallback: THREE.Color, bgr = false): THREE.Color {
  if (a.length < 3) return fallback;
  return bgr ? new THREE.Color(a[2], a[1], a[0]) : new THREE.Color(a[0], a[1], a[2]);
}

function layerMaterial(layer: LayerLike, texture: THREE.Texture): THREE.MeshBasicMaterial {
  const transparent = layer.filterMode > 1 || layer.alpha < 1;
  const mat = new THREE.MeshBasicMaterial({ map: texture, transparent, depthTest: (layer.flags & 64) === 0, depthWrite: (layer.flags & 128) === 0 && layer.filterMode <= 1, side: (layer.flags & 16) !== 0 ? THREE.DoubleSide : THREE.FrontSide, alphaTest: layer.filterMode === 1 ? 0.75 : 0, vertexColors: false });
  mat.name = `mdx-layer-${layer.filterMode}`;
  if (layer.filterMode === 3 || layer.filterMode === 4) mat.blending = THREE.AdditiveBlending;
  else if (layer.filterMode === 5 || layer.filterMode === 6) {
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.DstColorFactor;
    mat.blendDst = layer.filterMode === 6 ? THREE.SrcColorFactor : THREE.ZeroFactor;
  } else mat.blending = THREE.NormalBlending;
  return mat;
}

function particleMaterial(filterMode: number, texture: THREE.Texture): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, vertexColors: true });
  if (filterMode === 1) mat.blending = THREE.AdditiveBlending;
  else if (filterMode === 2 || filterMode === 3) {
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.DstColorFactor;
    mat.blendDst = filterMode === 3 ? THREE.SrcColorFactor : THREE.ZeroFactor;
  } else mat.blending = THREE.NormalBlending;
  mat.alphaTest = filterMode === 4 ? 0.75 : 0.01;
  return mat;
}

async function resolveTexture(tex: TextureLike, rows = 1, columns = 1): Promise<TextureSlot> {
  if (tex.replaceableId === 1 || tex.replaceableId === 2) return { texture: getFallbackTexture(tex.replaceableId === 1 ? 'team-color' : 'team-glow', rows, columns), path: tex.path, replaceableId: tex.replaceableId };
  const real = tex.path ? await assets.texture(tex.path) : null;
  const texture = real ?? getFallbackTexture(tex.path || `replaceable-${tex.replaceableId}`, rows, columns);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, path: tex.path, replaceableId: tex.replaceableId };
}

function makeGeometry(geoset: GeosetPrepared): MeshSlot['geometry'] {
  const g = new THREE.BufferGeometry();
  const count = geoset.positions.length / 3;
  const p = new Float32Array(count * 3);
  const n = new Float32Array(count * 3);
  const pos = new THREE.BufferAttribute(p, 3).setUsage(THREE.DynamicDrawUsage);
  const nor = new THREE.BufferAttribute(n, 3).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', pos);
  g.setAttribute('normal', nor);
  g.setAttribute('uv', new THREE.BufferAttribute(geoset.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(geoset.indices, 1));
  g.computeBoundingSphere();
  return g;
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
    for (const tex of this.source.textures) this.textures.push(await resolveTexture(tex));
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
    for (let i = 0; i < this.source.geosets.length; i++) {
      const geoset = this.source.geosets[i];
      const material = this.source.materials[geoset.materialId];
      const groupOffsets = new Uint32Array(geoset.matrixGroups.length + 1);
      for (let g = 0; g < geoset.matrixGroups.length; g++) groupOffsets[g + 1] = groupOffsets[g] + geoset.matrixGroups[g];
      const layers: LayerSlot[] = [];
      for (const layer of material?.layers ?? []) {
        const tex = this.textures[layer.textureId] ?? { texture: getFallbackTexture('unknown'), path: 'unknown', replaceableId: 0 };
        layers.push({ layer, texture: tex, baseMaterial: layerMaterial(layer, tex.texture) });
      }
      const gsa = this.source.geosetAnimations.find((a) => a.geosetId === i) ?? this.source.geosetAnimations.find((a) => a.geosetId === -1) ?? null;
      this.geosets.push({ geoset, positions: geoset.vertices, normals: geoset.normals, uvs: geoset.uvSets[0] ?? new Float32Array((geoset.vertices.length / 3) * 2), indices: geoset.faces, groupOffsets, layers, geosetAnimation: gsa });
    }
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
  private readonly attachments = new Map<string, THREE.Object3D>();
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
    this.update(0, new THREE.PerspectiveCamera());
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
    for (const m of this.meshes) {
      m.geometry.dispose();
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
    for (const geoset of this.model.geosets) {
      for (const layer of geoset.layers) {
        const geometry = makeGeometry(geoset);
        const material = layer.baseMaterial.clone();
        let mapWasCloned = false;
        if (layer.layer.textureAnimationId >= 0 && material.map) {
          material.map = material.map.clone();
          material.map.needsUpdate = true;
          mapWasCloned = true;
        }
        if (layer.texture.replaceableId === 1) material.map = this.teamColorTexture;
        else if (layer.texture.replaceableId === 2) material.map = this.teamGlowTexture;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        this.add(mesh);
        this.meshes.push({ geoset, geometry, mesh, positionAttr: geometry.getAttribute('position') as THREE.BufferAttribute, normalAttr: geometry.getAttribute('normal') as THREE.BufferAttribute, material, layer, mapWasCloned });
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
      const t = sampleVector(this, obj, 'KGTR', new THREE.Vector3());
      const r = sampleQuat(this, obj, 'KGRT');
      const s = sampleVector(this, obj, 'KGSC', new THREE.Vector3(1, 1, 1));
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
    for (const att of this.model.source.attachments) {
      const node = this.nodesById.get(att.objectId);
      const obj = this.attachments.get(normalizedAttachmentName(att.name));
      if (node && obj) {
        obj.visible = node.visible > 0.01;
        obj.matrix.copy(node.worldConverted);
        obj.matrixWorldNeedsUpdate = true;
      }
    }
  }

  private updateGeosets(): void {
    for (const slot of this.meshes) {
      const geoset = slot.geoset;
      const source = geoset.geoset;
      const pos = slot.positionAttr.array as Float32Array;
      const nor = slot.normalAttr.array as Float32Array;
      const original = geoset.positions;
      const originalN = geoset.normals;
      for (let i = 0, l = original.length / 3; i < l; i++) {
        const group = source.vertexGroups[i] ?? 0;
        const start = geoset.groupOffsets[group] ?? 0;
        const end = geoset.groupOffsets[group + 1] ?? start;
        const count = Math.max(1, end - start);
        tempV.set(0, 0, 0);
        tempV2.set(0, 0, 0);
        for (let j = start; j < end; j++) {
          const objectId = source.matrixIndices[j];
          const node = this.nodesById.get(objectId);
          const m = node?.world ?? tempM.identity();
          const v = new THREE.Vector3(original[i * 3], original[i * 3 + 1], original[i * 3 + 2]).applyMatrix4(m);
          tempV.add(v);
          const n = new THREE.Vector3(originalN[i * 3] || 0, originalN[i * 3 + 1] || 0, originalN[i * 3 + 2] || 1).transformDirection(m);
          tempV2.add(n);
        }
        tempV.multiplyScalar(1 / count);
        tempV2.multiplyScalar(1 / count).normalize();
        modelToThree(tempV);
        directionToThree(tempV2).normalize();
        pos[i * 3] = tempV.x;
        pos[i * 3 + 1] = tempV.y;
        pos[i * 3 + 2] = tempV.z;
        nor[i * 3] = tempV2.x;
        nor[i * 3 + 1] = tempV2.y;
        nor[i * 3 + 2] = tempV2.z;
      }
      slot.positionAttr.needsUpdate = true;
      slot.normalAttr.needsUpdate = true;
      slot.geometry.computeBoundingSphere();
      this.updateMaterial(slot);
    }
  }

  private updateMaterial(slot: MeshSlot): void {
    const layer = slot.layer.layer;
    const geoa = slot.geoset.geosetAnimation;
    const layerAlpha = sampleScalar(this, layer, 'KMTA', layer.alpha);
    const geosetAlpha = geoa ? sampleScalar(this, geoa, 'KGAO', geoa.alpha) : 1;
    const colorTrack = geoa ? sampleTrack(this, geoa, 'KGAC', geoa.color) : null;
    const color = colorTrack ? colorFromArray(colorTrack, new THREE.Color(1, 1, 1), true) : new THREE.Color(1, 1, 1);
    const replaceableScale = slot.layer.texture.replaceableId === 2 ? 0.38 : 1;
    slot.material.opacity = THREE.MathUtils.clamp(layerAlpha * geosetAlpha * this.opacity * replaceableScale, 0, 1);
    slot.material.transparent = slot.material.opacity < 0.999 || layer.filterMode > 1;
    slot.material.color.copy(color);
    if (layer.textureAnimationId >= 0 && slot.material.map) this.updateTextureTransform(slot.material.map, this.model.source.textureAnimations[layer.textureAnimationId]);
  }

  private updateTextureTransform(texture: THREE.Texture, tx: AnimatedLike | undefined): void {
    if (!tx) return;
    const t = sampleVector(this, tx, 'KTAT', new THREE.Vector3());
    const r = sampleQuat(this, tx, 'KTAR');
    const s = sampleVector(this, tx, 'KTAS', new THREE.Vector3(1, 1, 1));
    texture.offset.set(t.x, t.y);
    texture.repeat.set(s.x || 1, s.y || 1);
    texture.rotation = new THREE.Euler().setFromQuaternion(r).z;
  }
}

class ParticleEmitter2View {
  private readonly particles: Particle2[] = [];
  private readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private emission = 0;
  private lastKey = -1;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly texture: THREE.Texture;
  private readonly texturePath: string;
  private readonly warmEffect: boolean;
  private readonly sizeScale: number;
  private readonly alphaScale: number;

  constructor(private readonly instance: MdxInstance, private readonly emitter: ParticleEmitter2Like) {
    const modelTex = instance.model.textures[emitter.textureId];
    this.texturePath = modelTex?.path ?? emitter.name;
    this.warmEffect = /(?:lgh_fb|fb2|epicexplosion|explosionbig)/i.test(instance.model.path);
    const pointStar = /(?:star|eyeglow|eye|sparkle)/i.test(this.texturePath) && !/(?:shockwave|flare|glow64|clouds)/i.test(this.texturePath);
    this.sizeScale = pointStar ? 0.16 : 1;
    this.alphaScale = pointStar ? 0.55 : 1;
    const baseTex = emitter.replaceableId === 1 ? instance['teamColorTexture'] : emitter.replaceableId === 2 ? instance['teamGlowTexture'] : modelTex?.texture;
    this.texture = baseTex?.name.startsWith('fallback:')
      ? getFallbackTexture(modelTex?.path ?? emitter.name, emitter.rows, emitter.columns)
      : (baseTex ?? getFallbackTexture(modelTex?.path ?? emitter.name, emitter.rows, emitter.columns));
    this.material = particleMaterial(emitter.filterMode, this.texture);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = emitter.filterMode === 1 ? 30 : 20;
    instance.add(this.mesh);
  }

  clear(): void {
    this.particles.length = 0;
    this.emission = 0;
    this.lastKey = -1;
    this.rebuild(new THREE.PerspectiveCamera());
  }

  dispose(): void {
    this.geometry.dispose();
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
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.health -= dt;
      if (p.health <= 0) this.particles.splice(i, 1);
      else {
        p.velocity.z -= p.gravity * dt;
        p.location.addScaledVector(p.velocity, dt);
      }
    }
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
    const positions = new Float32Array(count * 12);
    const uvs = new Float32Array(count * 8);
    const colors = new Float32Array(count * 16);
    const indices = new Uint16Array(count * 6);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    this.instance.updateWorldMatrix(true, false);
    const inv = this.instance.matrixWorld.clone().invert();
    right.transformDirection(inv).normalize();
    up.transformDirection(inv).normalize();
    for (let i = 0; i < count; i++) {
      const p = this.particles[i];
      const age = 1 - p.health / Math.max(0.001, p.life);
      const scale = this.segmentScale(age) * this.sizeScale;
      const col = this.segmentColor(age);
      const loc = modelToThree(p.location.clone());
      const half = Math.max(1, scale * 0.5);
      const tailDir = p.tail ? directionToThree(p.velocity.clone()).normalize().multiplyScalar(this.emitter.tailLength * 0.35) : new THREE.Vector3();
      let quadRight = right;
      let quadUp = up;
      if (this.emitter.flags & 1048576) {
        const facing = Math.atan2(p.velocity.y, p.velocity.x);
        quadRight = new THREE.Vector3(Math.cos(facing), 0, -Math.sin(facing));
        quadUp = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing));
      }
      const r = quadRight.clone().multiplyScalar(half);
      const u = quadUp.clone().multiplyScalar(half);
      const verts = [loc.clone().sub(r).sub(u), loc.clone().add(r).sub(u), loc.clone().add(r).add(u).sub(tailDir), loc.clone().sub(r).add(u).sub(tailDir)];
      for (let v = 0; v < 4; v++) {
        positions.set([verts[v].x, verts[v].y, verts[v].z], i * 12 + v * 3);
        colors.set([col.r, col.g, col.b, col.a], i * 16 + v * 4);
      }
      const [u0, v0, u1, v1] = this.uvFor(p, age);
      uvs.set([u0, v1, u1, v1, u1, v0, u0, v0], i * 8);
      const b = i * 4;
      indices.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.computeBoundingSphere();
  }

  private segmentColor(t: number): THREE.Color & { a: number } {
    const middle = THREE.MathUtils.clamp(this.emitter.timeMiddle, 0.001, 0.999);
    const i0 = t < middle ? 0 : 1;
    const i1 = t < middle ? 1 : 2;
    const f = t < middle ? t / middle : (t - middle) / (1 - middle);
    const c0 = this.emitter.segmentColors[i0];
    const c1 = this.emitter.segmentColors[i1];
    const c = new THREE.Color(THREE.MathUtils.lerp(c0[0], c1[0], f), THREE.MathUtils.lerp(c0[1], c1[1], f), THREE.MathUtils.lerp(c0[2], c1[2], f)) as THREE.Color & { a: number };
    if (this.warmEffect) {
      const warmR = Math.max(c.r, c.b * 0.95);
      const warmG = Math.max(c.g * 0.72, c.b * 0.72);
      c.r = warmR;
      c.g = Math.min(1, warmG);
      c.b *= 0.18;
    }
    c.a = THREE.MathUtils.lerp(this.emitter.segmentAlphas[i0] / 255, this.emitter.segmentAlphas[i1] / 255, f) * this.instance.opacity * this.alphaScale * (this.warmEffect && this.emitter.filterMode === 0 ? 0.45 : 1);
    return c;
  }

  private segmentScale(t: number): number {
    const middle = THREE.MathUtils.clamp(this.emitter.timeMiddle, 0.001, 0.999);
    const i0 = t < middle ? 0 : 1;
    const i1 = t < middle ? 1 : 2;
    const f = t < middle ? t / middle : (t - middle) / (1 - middle);
    return THREE.MathUtils.lerp(this.emitter.segmentScaling[i0], this.emitter.segmentScaling[i1], f);
  }

  private uvFor(p: Particle2, t: number): [number, number, number, number] {
    const intervals = p.tail ? this.emitter.tailIntervals : this.emitter.headIntervals;
    const interval = t < this.emitter.timeMiddle ? intervals[0] : intervals[1];
    const start = interval?.[0] ?? 0;
    const end = interval?.[1] ?? start;
    const cell = Math.floor(THREE.MathUtils.lerp(start, end, t) + p.cellOffset) % Math.max(1, this.emitter.rows * this.emitter.columns);
    const col = cell % Math.max(1, this.emitter.columns);
    const row = Math.floor(cell / Math.max(1, this.emitter.columns));
    const cw = 1 / Math.max(1, this.emitter.columns);
    const ch = 1 / Math.max(1, this.emitter.rows);
    return [col * cw, row * ch, (col + 1) * cw, (row + 1) * ch];
  }
}

class RibbonEmitterView {
  private readonly points: RibbonPoint[] = [];
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.Mesh;
  private emission = 0;

  constructor(private readonly instance: MdxInstance, private readonly emitter: RibbonEmitterLike) {
    const mat = instance.model.source.materials[emitter.materialId]?.layers[0];
    const slot = mat ? instance.model.textures[mat.textureId] : undefined;
    const tex = slot?.texture.name.startsWith('fallback:') ? getFallbackTexture(slot.path, emitter.rows, emitter.columns) : slot?.texture;
    this.material = particleMaterial(mat?.filterMode ?? 2, tex ?? getFallbackTexture(emitter.name, emitter.rows, emitter.columns));
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 25;
    instance.add(this.mesh);
  }

  clear(): void {
    this.points.length = 0;
    this.rebuild();
  }

  dispose(): void {
    this.geometry.dispose();
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
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i];
      p.health -= dt;
      p.above.z -= this.emitter.gravity * dt * dt;
      p.below.z -= this.emitter.gravity * dt * dt;
      if (p.health <= 0) this.points.splice(i, 1);
    }
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
    const segments = Math.max(0, this.points.length - 1);
    const positions = new Float32Array(this.points.length * 6);
    const uvs = new Float32Array(this.points.length * 4);
    const colors = new Float32Array(this.points.length * 8);
    const indices = new Uint16Array(segments * 6);
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const a = modelToThree(p.above.clone());
      const b = modelToThree(p.below.clone());
      positions.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
      const u = i / Math.max(1, this.points.length - 1);
      const row = Math.floor(p.slot / Math.max(1, this.emitter.columns));
      const col = p.slot % Math.max(1, this.emitter.columns);
      const cw = 1 / Math.max(1, this.emitter.columns);
      const ch = 1 / Math.max(1, this.emitter.rows);
      uvs.set([col * cw + u * cw, row * ch, col * cw + u * cw, (row + 1) * ch], i * 4);
      const alpha = p.alpha * (p.health / p.life) * this.instance.opacity;
      colors.set([p.color.r, p.color.g, p.color.b, alpha, p.color.r, p.color.g, p.color.b, alpha], i * 8);
      if (i < this.points.length - 1) {
        const v = i * 2;
        indices.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6);
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.computeBoundingSphere();
  }
}

export type { ParsedMdlxModel as MdlxModelData };
