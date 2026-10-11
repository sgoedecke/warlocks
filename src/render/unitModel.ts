import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import wizardUrl from './models3d/wizard.glb?url';

export interface AnimInput {
  moving: number; // 0..1 walk blend
  casting: number; // 0..1 staff raised
  knocked: number; // 0..1 lean back
  dead: boolean;
  dt: number;
}

/** Model height in sim units before UNIT_SCALE, matching the old procedural warlock. */
const HEIGHT = 95;
const TEX_SIZE = 512;

interface Base {
  scene: THREE.Object3D;
  clips: Record<'idle' | 'run' | 'spell' | 'hit' | 'death', THREE.AnimationClip>;
  image: CanvasImageSource;
  scale: number;
}

let base: Base | null = null;
const teamTextures = new Map<number, THREE.Texture>();

/** Loads the warlock model ("Animated Wizard" by Quaternius, CC-BY 3.0). Call once before creating any WarlockModel. */
export async function loadUnitModels(): Promise<void> {
  if (base) return;
  const gltf = await new GLTFLoader().loadAsync(wizardUrl);
  const clip = (name: string) => gltf.animations.find((a) => a.name.endsWith(`|${name}`))!;
  let image: CanvasImageSource | null = null;
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !image) image = ((m.material as THREE.MeshStandardMaterial).map?.image as CanvasImageSource) ?? null;
  });
  const box = new THREE.Box3().setFromObject(gltf.scene);
  base = {
    scene: gltf.scene,
    clips: { idle: clip('Idle'), run: clip('Run'), spell: clip('Spell1'), hit: clip('RecieveHit'), death: clip('Death') },
    image: image!,
    scale: HEIGHT / (box.max.y - box.min.y),
  };
}

/** The model's texture with its blue robe repainted in a player's colour, like WC3's team colour. */
function teamTexture(color: THREE.Color): THREE.Texture {
  const key = color.getHex();
  let tex = teamTextures.get(key);
  if (tex) return tex;
  const c = document.createElement('canvas');
  c.width = c.height = TEX_SIZE;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(base!.image, 0, 0, TEX_SIZE, TEX_SIZE);
  const img = g.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
  const d = img.data;
  const tr = color.r * 255;
  const tg = color.g * 255;
  const tb = color.b * 255;
  const hsl = { h: 0, s: 0, l: 0 };
  const px = new THREE.Color();
  for (let i = 0; i < d.length; i += 4) {
    px.setRGB(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, THREE.LinearSRGBColorSpace).getHSL(hsl, THREE.LinearSRGBColorSpace);
    const hue = Math.abs(hsl.h * 360 - 228);
    const w = smooth(40, 22, hue) * smooth(0.22, 0.4, hsl.s);
    if (w <= 0) continue;
    // Keep the painted shading: scale the team colour by the pixel's brightness relative to the robe's midtone.
    const v = Math.min(1.6, Math.max(d[i], d[i + 1], d[i + 2]) / 150);
    d[i] += (Math.min(255, tr * v) - d[i]) * w;
    d[i + 1] += (Math.min(255, tg * v) - d[i + 1]) * w;
    d[i + 2] += (Math.min(255, tb * v) - d[i + 2]) * w;
  }
  g.putImageData(img, 0, 0);
  tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  teamTextures.set(key, tex);
  return tex;
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

type State = keyof Base['clips'];

/** A warlock: the skinned wizard model in team colour, facing +X like the sim. */
export class WarlockModel {
  readonly root = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private actions: Record<State, THREE.AnimationAction>;
  private state: State | null = null;
  private wasCasting = false;
  private materials: THREE.MeshLambertMaterial[] = [];

  constructor(teamColor: THREE.Color) {
    if (!base) throw new Error('loadUnitModels() first');
    const model = cloneSkinned(base.scene);
    model.scale.setScalar(base.scale);
    model.rotation.y = Math.PI / 2;
    const map = teamTexture(teamColor);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = new THREE.MeshLambertMaterial({ map });
      this.materials.push(mat);
      m.material = mat;
      m.frustumCulled = false;
    });
    this.root.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    const a = (c: THREE.AnimationClip) => this.mixer.clipAction(c);
    this.actions = { idle: a(base.clips.idle), run: a(base.clips.run), spell: a(base.clips.spell), hit: a(base.clips.hit), death: a(base.clips.death) };
    for (const s of ['spell', 'hit', 'death'] as State[]) {
      this.actions[s].setLoop(THREE.LoopOnce, 1);
      this.actions[s].clampWhenFinished = true;
    }
    this.actions.spell.timeScale = 1.6;
    this.play('idle', 0);
  }

  private play(s: State, fade = 0.15) {
    if (s === this.state) return;
    const next = this.actions[s];
    for (const act of Object.values(this.actions)) if (act !== next && act.enabled && act.getEffectiveWeight() > 0) act.fadeOut(fade);
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    this.state = s;
  }

  update(a: AnimInput) {
    const cast = a.casting > 0.5;
    if (cast && !this.wasCasting && !a.dead) {
      this.state = null;
      this.play('spell', 0.08);
    }
    this.wasCasting = cast;
    const want: State = a.dead ? 'death'
      : this.state === 'spell' && !this.actions.spell.paused ? 'spell'
        : a.knocked > 0.4 ? 'hit'
          : a.moving > 0.5 ? 'run' : 'idle';
    this.play(want, want === 'death' ? 0.1 : 0.15);
    this.mixer.update(a.dt);
  }

  setOpacity(o: number) {
    for (const m of this.materials) {
      m.transparent = o < 0.999;
      m.opacity = o;
      m.depthWrite = o > 0.5;
    }
  }

  /** Blend toward a colour (burning in lava, hit flash, charred when dead). */
  setTint(color: THREE.Color, amount: number) {
    const bright = color.r + color.g + color.b > 1;
    for (const m of this.materials) {
      m.color.setRGB(1, 1, 1).lerp(color, bright ? amount * 0.4 : amount);
      m.emissive.copy(color).multiplyScalar(bright ? amount * 0.6 : 0);
    }
  }
}
