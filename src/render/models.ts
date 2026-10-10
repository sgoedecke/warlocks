import * as THREE from 'three';
import { loadMdxModel, type MdxInstance, type MdxModel } from './mdx';

type Entry = { model: MdxModel | null; ready: boolean };

/** Synchronous view over async MDX loading: callers get a model once it's ready, or null meanwhile. */
export class ModelLibrary {
  private entries = new Map<string, Entry>();
  private live = new Set<MdxInstance>();
  private effects: { inst: MdxInstance; ttl: number; fade: number; age: number }[] = [];
  private epoch = 0;

  constructor(private scene: THREE.Scene) {}

  get(path: string | undefined | null): MdxModel | null {
    if (!path) return null;
    const key = path.toLowerCase().replace(/\//g, '\\').replace(/\.mdl$/, '.mdx');
    let e = this.entries.get(key);
    if (!e) {
      e = { model: null, ready: false };
      this.entries.set(key, e);
      const epoch = this.epoch;
      const entry = e;
      loadMdxModel(path)
        .then((m) => {
          if (epoch === this.epoch) {
            entry.model = m;
            entry.ready = true;
          }
        })
        .catch(() => (entry.ready = true));
    }
    return e.model;
  }

  preload(paths: Iterable<string | undefined>) {
    for (const p of paths) this.get(p);
  }

  /** Waits until everything requested so far has resolved (used before the first frame). */
  async settle(timeoutMs = 4000): Promise<void> {
    const t0 = performance.now();
    while ([...this.entries.values()].some((e) => !e.ready) && performance.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  /** Called when the asset archives change. */
  reset() {
    this.epoch++;
    this.entries.clear();
  }

  instance(path: string | undefined | null): MdxInstance | null {
    const m = this.get(path);
    if (!m) return null;
    const inst = m.createInstance();
    this.live.add(inst);
    return inst;
  }

  release(inst: MdxInstance) {
    this.live.delete(inst);
    inst.removeFromParent();
    inst.dispose();
  }

  /**
   * Plays a fire-and-forget special effect like DestroyEffect(AddSpecialEffect(...)):
   * its Death animation if it has one, otherwise Birth, otherwise Stand, once.
   * Returns false when the model isn't available so the caller can draw a fallback.
   */
  spawnEffect(path: string | undefined | null, pos: THREE.Vector3, opts: { scale?: number; facing?: number; sequence?: string; fade?: number; ttl?: number; color?: THREE.Color } = {}): MdxInstance | null {
    const m = this.get(path);
    if (!m) return null;
    const inst = m.createInstance();
    this.live.add(inst);
    inst.position.copy(pos);
    inst.rotation.y = opts.facing ?? 0;
    inst.scale.setScalar(opts.scale ?? 1);
    if (opts.color) inst.teamColor = opts.color;
    const seq = opts.sequence ?? (['death', 'birth', 'stand'].find((s) => m.hasSequence(s)) ?? 0);
    inst.setSequence(seq, false);
    this.scene.add(inst);
    this.effects.push({ inst, ttl: opts.ttl ?? 6, fade: opts.fade ?? 0, age: 0 });
    return inst;
  }

  update(dt: number, camera: THREE.Camera) {
    for (const e of this.effects) {
      e.age += dt;
      if (e.fade > 0) e.inst.opacity = Math.max(0, 1 - e.age / e.fade);
    }
    // Let particles spawned near the end of a sequence drift out before removal.
    const done = this.effects.filter((e) => e.age > e.ttl || (e.inst.sequenceEnded && (e.inst.userData.endAge ??= e.age) + 1.2 < e.age) || (e.fade > 0 && e.age >= e.fade));
    for (const e of done) this.release(e.inst);
    if (done.length) this.effects = this.effects.filter((e) => !done.includes(e));
    for (const inst of this.live) inst.update(dt, camera);
  }
}
