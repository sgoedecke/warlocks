import * as THREE from 'three';
import { MODEL_PATHS, PLAYER_COLORS, SPELLS, WARLOCK_RADIUS } from '../config';
import type { Sim } from '../sim/game';
import type { GameEvent, Obstacle, Projectile, ProjectileKind, Warlock } from '../sim/types';
import { ParticleSystem, type ParticleSpec } from './particles';
import { openTextureCanvas } from './opentex/particles';
import { makeGlowTexture, makeRingTexture, makeScorchTexture, makeShadowTexture } from './textures';
import { ModelLibrary } from './models';
import type { MdxInstance } from './mdx';
import { TerrainView } from './terrain';
import { obstacleModel } from './obstacleModels';
import { WarlockModel } from './unitModel';

// WC3 default game camera: angle of attack 304 (56 degrees down), distance 1650.
const CAM_PITCH = (56 * Math.PI) / 180;
const CAM_FOV = 48;
// Missile art is attached to the e000 dummy, whose fly height is 65.
const PROJ_HEIGHT = 65;
// h000 'Warlock': BloodelfWizard.mdl at usca 0.92.
const WARLOCK_MODEL = 'BloodelfWizard.mdl';
const WARLOCK_SCALE = 0.92;
// WC3 heroes are drawn noticeably larger than their collision size.
const UNIT_SCALE = 1.45;

function sim2three(x: number, y: number, h = 0): THREE.Vector3 {
  return new THREE.Vector3(x, h, -y);
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

function disposeObj(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    // Sprites share one global geometry, so only their materials are owned.
    if (m.geometry && !(o instanceof THREE.Sprite)) m.geometry.dispose();
    const mat = m.material as THREE.Material | undefined;
    if (mat) mat.dispose();
  });
}

interface UnitView {
  model: WarlockModel;
  mdx: MdxInstance | null;
  seq: string;
  spellT: number;
  shadow: THREE.Mesh;
  bubble: THREE.Mesh;
  moving: number;
  casting: number;
  knocked: number;
  flash: number;
  deadT: number;
  emitCarry: number;
  wasAlive: boolean;
}

interface ProjView {
  obj: THREE.Group;
  mdx: MdxInstance | null;
  kind: ProjectileKind;
  carry: number;
  chain?: THREE.Mesh;
}

interface Transient {
  obj: THREE.Object3D;
  life: number;
  max: number;
  update?: (t: number, dt: number) => void;
}

export interface GraphicsOptions {
  /** Upper bound on the device pixel ratio used for rendering. */
  pixelRatio: number;
  antialias: boolean;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  camX = 0;
  camY = 0;
  camDist = 1650;
  private shake = 0;
  private terrain = new TerrainView();
  readonly lib: ModelLibrary;
  private obstacleViews: { obs: Obstacle; obj: THREE.Object3D; mdx: boolean }[] = [];
  private obstacleSet: Obstacle[] | null = null;
  private units = new Map<number, UnitView>();
  private projs = new Map<number, ProjView>();
  private transients: Transient[] = [];
  private linkBeams = new Map<number, THREE.Mesh>();
  private fx: ParticleSystem;
  /** Additive billowing flame puffs (8x8 cloud flipbook). */
  private fire: ParticleSystem;
  private smoke: ParticleSystem;
  private tex: Record<string, THREE.Texture> = {};
  private time = 0;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private aoe: THREE.Mesh;
  private selection: THREE.Mesh;
  private portraitScene = new THREE.Scene();
  private portraitCam = new THREE.PerspectiveCamera(32, 1, 1, 1000);
  private portraitModel: WarlockModel | null = null;
  private portraitMdx: MdxInstance | null = null;
  private portraitSeq = '';
  private portraitColor = -1;
  private portraitRenderer: THREE.WebGLRenderer;
  private portraitEl: HTMLElement | null = null;

  constructor(private container: HTMLElement, private sim: Sim, public localId: number, gfx: GraphicsOptions = { pixelRatio: 2, antialias: true }) {
    this.renderer = new THREE.WebGLRenderer({ antialias: gfx.antialias, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, gfx.pixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    // The portrait sits inside the opaque console, so it gets its own small canvas.
    this.portraitRenderer = new THREE.WebGLRenderer({ antialias: gfx.antialias, powerPreference: 'low-power' });
    this.portraitRenderer.setPixelRatio(Math.min(window.devicePixelRatio, gfx.pixelRatio));
    this.portraitRenderer.outputColorSpace = THREE.SRGBColorSpace;
    this.portraitRenderer.domElement.style.display = 'block';
    this.camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 10, 9000);

    const canvasTex = (c: HTMLCanvasElement, repeat = false) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      return t;
    };
    this.tex.glow = canvasTex(makeGlowTexture(64));
    this.tex.hardGlow = canvasTex(makeGlowTexture(64, 1));
    this.tex.shadow = canvasTex(makeShadowTexture());
    this.tex.scorch = canvasTex(makeScorchTexture());
    this.tex.ring = canvasTex(makeRingTexture(128, 0.06));
    this.tex.thickRing = canvasTex(makeRingTexture(128, 0.1));
    this.tex.beam = (() => {
      const c = document.createElement('canvas');
      c.width = 4;
      c.height = 64;
      const g = c.getContext('2d')!;
      const grd = g.createLinearGradient(0, 0, 0, 64);
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(0.5, 'rgba(255,255,255,1)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 4, 64);
      return canvasTex(c);
    })();

    this.scene.background = new THREE.Color(0x0a0302);
    this.scene.fog = new THREE.Fog(0x140502, 3200, 6500);

    // Lighting: WC3 style warm sun from the upper left, plus lava bounce.
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
    sun.position.set(-600, 1000, 500);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xb8b0c8, 0xff5a10, 1.1));
    this.scene.add(new THREE.AmbientLight(0x403030, 0.8));

    this.scene.add(this.terrain.mesh);
    this.lib = new ModelLibrary(this.scene);
    this.lib.preload([WARLOCK_MODEL, 'fb2.mdl', ...Object.values(MODEL_PATHS), ...Object.values(SPELLS).map((s) => s.modelPath)]);

    this.fx = new ParticleSystem(3000, this.tex.glow, true);
    this.fire = new ParticleSystem(2000, canvasTex(openTextureCanvas('textures\\clouds8x8.blp', 8, 8)!), true, 8);
    this.smoke = new ParticleSystem(2000, canvasTex(openTextureCanvas('textures\\clouds8x8fade.blp', 8, 8)!), false, 8);
    this.scene.add(this.fx.points, this.fire.points, this.smoke.points);

    this.aoe = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.tex.thickRing, color: 0x40ff40, transparent: true, depthWrite: false, opacity: 0.9 }),
    );
    this.aoe.rotation.x = -Math.PI / 2;
    this.aoe.visible = false;
    this.aoe.renderOrder = 5;
    this.scene.add(this.aoe);

    this.selection = new THREE.Mesh(
      new THREE.PlaneGeometry(WARLOCK_RADIUS * 2.9, WARLOCK_RADIUS * 2.9),
      new THREE.MeshBasicMaterial({ map: this.tex.ring, color: 0x20ff20, transparent: true, depthWrite: false }),
    );
    this.selection.rotation.x = -Math.PI / 2;
    this.selection.renderOrder = 4;
    this.scene.add(this.selection);

    // Portrait
    this.portraitScene.background = new THREE.Color(0x050403);
    const pl = new THREE.DirectionalLight(0xffeedd, 2.4);
    pl.position.set(100, 120, 60);
    this.portraitScene.add(pl, new THREE.HemisphereLight(0x8888aa, 0x442200, 1.2));
    this.portraitCam.position.set(85, 82, 18);
    this.portraitCam.lookAt(0, 68, 0);

    for (const p of sim.players) this.createUnit(p);
    this.resize();
    window.addEventListener('resize', this.onResize);
    this.centerOn(sim.players[localId].x, sim.players[localId].y);
  }

  private onResize = () => this.resize();

  dispose() {
    window.removeEventListener('resize', this.onResize);
    this.portraitObserver?.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.portraitRenderer.dispose();
    this.portraitRenderer.domElement.remove();
  }

  attachPortrait(el: HTMLElement) {
    this.portraitEl = el;
    el.appendChild(this.portraitRenderer.domElement);
    this.portraitObserver?.disconnect();
    this.portraitSize = { w: el.clientWidth, h: el.clientHeight };
    this.portraitObserver = new ResizeObserver(() => (this.portraitSize = { w: el.clientWidth, h: el.clientHeight }));
    this.portraitObserver.observe(el);
  }

  // Cached so per-frame screen projections don't force a synchronous layout after HUD writes.
  private viewRect = { left: 0, top: 0, width: 1, height: 1 };
  private portraitSize = { w: 0, h: 0 };
  private portraitObserver?: ResizeObserver;

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    const r = this.renderer.domElement.getBoundingClientRect();
    this.viewRect = { left: r.left, top: r.top, width: r.width || 1, height: r.height || 1 };
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const ph = h * this.renderer.getPixelRatio();
    this.fx.setScale(ph, CAM_FOV);
    this.fire.setScale(ph, CAM_FOV);
    this.smoke.setScale(ph, CAM_FOV);
  }

  centerOn(x: number, y: number) {
    this.camX = x;
    this.camY = y;
  }

  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    const r = this.viewRect;
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    return { x: hit.x, y: -hit.z };
  }

  worldToScreen(x: number, y: number, h: number): { x: number; y: number; visible: boolean } {
    const v = sim2three(x, y, h).project(this.camera);
    const r = this.viewRect;
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height, visible: v.z < 1 };
  }

  // Ground-plane corners of the view, for the minimap frustum.
  viewCorners(): { x: number; y: number }[] {
    const r = this.viewRect;
    const out: { x: number; y: number }[] = [];
    for (const [sx, sy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const p = this.pick(r.left + sx * r.width, r.top + sy * r.height * 0.999);
      if (p) out.push(p);
    }
    return out;
  }

  setAoe(x: number, y: number, radius: number | null, valid = true) {
    this.aoe.visible = radius !== null;
    if (radius === null) return;
    this.aoe.position.set(x, 1.5, -y);
    this.aoe.scale.set(radius * 2.1, radius * 2.1, 1);
    (this.aoe.material as THREE.MeshBasicMaterial).color.setHex(valid ? 0x40ff40 : 0xff4040);
  }

  // ---------- units ----------

  private createUnit(p: Warlock) {
    const col = new THREE.Color(PLAYER_COLORS[p.color].css);
    const model = new WarlockModel(col);
    model.root.scale.setScalar(UNIT_SCALE);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(WARLOCK_RADIUS * 4, WARLOCK_RADIUS * 4),
      new THREE.MeshBasicMaterial({ map: this.tex.shadow, transparent: true, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 3;
    const bubble = new THREE.Mesh(
      new THREE.SphereGeometry(40, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x60a0ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    bubble.visible = false;
    this.scene.add(model.root, shadow, bubble);
    this.units.set(p.id, { model, mdx: null, seq: '', spellT: 0, shadow, bubble, moving: 0, casting: 0, knocked: 0, flash: 0, deadT: 0, emitCarry: 0, wasAlive: true });
  }

  private updateUnits(alpha: number, dt: number) {
    for (const p of this.sim.players) {
      const v = this.units.get(p.id)!;
      const x = p.px + (p.x - p.px) * alpha;
      const y = p.py + (p.y - p.py) * alpha;
      const facing = lerpAngle(p.pfacing, p.facing, alpha);
      const m = v.model;
      if (p.left) {
        m.root.visible = false;
        if (v.mdx) v.mdx.visible = false;
        v.shadow.visible = v.bubble.visible = false;
        continue;
      }
      if (p.alive && !v.wasAlive) {
        v.deadT = 0;
        m.root.rotation.set(0, 0, 0);
      }
      v.wasAlive = p.alive;
      const k = 1 - Math.exp(-dt * 12);
      const moveSpeed = Math.hypot(p.mvx, p.mvy) / 0.03;
      v.moving += ((moveSpeed > 20 && !p.thrust ? 1 : 0) - v.moving) * k;
      const casting = p.cast || this.sim.time - p.lastCastTime < 0.3 || p.thrust ? 1 : 0;
      v.casting += (casting - v.casting) * k * 1.5;
      const kbSpeed = Math.hypot(p.vx, p.vy) / 0.03;
      v.knocked += (Math.min(1, kbSpeed / 450) - v.knocked) * k;
      v.flash = Math.max(0, v.flash - dt * 5);

      if (!v.mdx) {
        v.mdx = this.lib.instance(WARLOCK_MODEL);
        if (v.mdx) {
          v.mdx.scale.setScalar(WARLOCK_SCALE);
          v.mdx.teamColor = new THREE.Color(PLAYER_COLORS[p.color].css);
          this.scene.add(v.mdx);
          v.seq = '';
        }
      }
      m.root.position.set(x, p.inLava ? -6 : 0, -y);
      m.root.rotation.y = facing;
      if (v.mdx) {
        m.root.visible = false;
        v.spellT -= dt;
        const want = !p.alive ? 'death' : v.spellT > 0 ? 'spell' : v.moving > 0.5 || p.thrust ? 'walk' : 'stand';
        if (want !== v.seq) {
          v.mdx.setSequence(want, want === 'stand' || want === 'walk');
          v.seq = want;
        }
        v.mdx.position.set(x, 0, -y);
        v.mdx.rotation.y = facing;
      } else {
        m.update({ moving: v.moving, casting: v.casting, knocked: v.knocked, dead: !p.alive, dt });
      }

      let opacity = 1;
      let visible = true;
      if (!p.alive) {
        v.deadT += dt;
        m.root.position.y -= v.deadT * (p.diedInLava ? 25 : 6);
        opacity = Math.max(0, 1 - Math.max(0, v.deadT - 1.2) / 1.5);
        visible = opacity > 0.01;
      } else if (p.windwalk > 0) {
        if (p.id === this.localId) opacity = 0.4;
        else visible = false;
      }
      if (v.mdx) {
        v.mdx.visible = visible;
        v.mdx.opacity = p.alive ? opacity : 1;
      } else {
        m.root.visible = visible;
        m.setOpacity(opacity);
      }
      if (p.inLava && p.alive) m.setTint(new THREE.Color(1, 0.3, 0.05), 0.35 + 0.15 * Math.sin(this.time * 12));
      else if (v.flash > 0) m.setTint(new THREE.Color(1, 1, 1), v.flash * 0.6);
      else if (!p.alive) m.setTint(new THREE.Color(0.1, 0.05, 0.05), Math.min(1, v.deadT));
      else m.setTint(new THREE.Color(1, 1, 1), 0);

      v.shadow.visible = visible && p.alive && !p.inLava;
      v.shadow.position.set(x, 0.8, -y);
      v.bubble.position.set(x, 32 * UNIT_SCALE, -y);
      v.bubble.visible = p.alive && p.shield > 0;
      if (v.bubble.visible) {
        const s = 1 + Math.sin(this.time * 10) * 0.04;
        v.bubble.scale.set(s, s, s);
        (v.bubble.material as THREE.MeshBasicMaterial).opacity = 0.18 + 0.08 * Math.sin(this.time * 6) + (p.shield < 0.5 ? -0.1 : 0);
      }

      // Continuous effects
      if (p.alive && visible) {
        v.emitCarry += dt;
        while (v.emitCarry > 1 / 30) {
          v.emitCarry -= 1 / 30;
          if (p.inLava) {
            this.fx.emit({ x: x + rand(-20, 20), y: rand(0, 20), z: -y + rand(-20, 20), vy: rand(60, 140), life: rand(0.4, 0.8), size: rand(14, 26), endSize: 4, color: 0xffa030, endColor: 0xff2000, gravity: -20 });
            if (Math.random() < 0.4) this.smoke.emit({ x: x + rand(-15, 15), y: 40, z: -y + rand(-15, 15), vy: rand(40, 80), life: 1.2, size: 30, endSize: 70, color: 0x201510, alpha: 0.5 });
          }
          if (kbSpeed > 220 && !p.inLava) {
            this.smoke.emit({ x: x + rand(-12, 12), y: 5, z: -y + rand(-12, 12), vy: rand(10, 40), life: 0.7, size: 24, endSize: 55, color: 0x8a7458, alpha: 0.55 });
          }
          if (p.thrust) {
            this.fx.emit({ x, y: 45, z: -y, life: 0.3, size: 50, endSize: 20, color: 0xffd080, endColor: 0xff6020, alpha: 0.5 });
            this.smoke.emit({ x, y: 5, z: -y, vy: 20, life: 0.6, size: 30, endSize: 60, color: 0x8a7458, alpha: 0.5 });
          }
          if (p.shield > 0 && Math.random() < 0.4) {
            const a = rand(0, Math.PI * 2);
            this.fx.emit({ x: x + Math.cos(a) * 50, y: rand(10, 80), z: -y + Math.sin(a) * 50, vy: 20, life: 0.5, size: 12, color: 0x80c0ff });
          }
        }
      }

      if (p.id === this.localId) {
        this.selection.visible = p.alive && visible;
        this.selection.position.set(x, 1.2, -y);
      }
    }
  }

  // ---------- projectiles ----------

  private sprite(color: number, size: number, tex = this.tex.glow, opacity = 1): THREE.Sprite {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity }));
    s.scale.set(size, size, 1);
    return s;
  }

  private makeRibbonGeo(points: THREE.Vector3[], width: number): THREE.BufferGeometry {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[Math.max(0, i - 1)];
      const b = points[Math.min(points.length - 1, i + 1)];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      const nx = (-dz / l) * width * 0.5;
      const nz = (dx / l) * width * 0.5;
      const p = points[i];
      pos.push(p.x + nx, p.y, p.z + nz, p.x - nx, p.y, p.z - nz);
      const u = i / (points.length - 1);
      uv.push(u, 0, u, 1);
      if (i < points.length - 1) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  private beamMat(color: number, additive = true, opacity = 1) {
    return new THREE.MeshBasicMaterial({
      map: this.tex.beam, color, transparent: true, depthWrite: false, opacity, side: THREE.DoubleSide, forceSinglePass: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
  }

  private createProj(pr: Projectile): ProjView {
    const g = new THREE.Group();
    const v: ProjView = { obj: g, kind: pr.kind, carry: 0, mdx: null };
    const mdx = this.lib.instance(pr.modelPath);
    if (mdx) {
      // The missile art is an effect on the dummy's origin; it loops Stand (or Birth if that's all it has).
      v.mdx = mdx;
      mdx.scale.setScalar(pr.scale || 1);
      mdx.setSequence(mdx.model.hasSequence('stand') ? 'stand' : 'birth', true);
      g.add(mdx);
      if (pr.kind === 'link') {
        v.chain = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0x707080, side: THREE.DoubleSide }));
        this.scene.add(v.chain);
      }
      this.scene.add(g);
      return v;
    }
    switch (pr.kind) {
      case 'fireball':
        g.add(this.sprite(0xff6010, 90), this.sprite(0xffc040, 44), this.sprite(0xffffff, 18, this.tex.hardGlow));
        break;
      case 'homing':
        g.add(this.sprite(0x50ff20, 80), this.sprite(0xc0ff80, 34), this.sprite(0xffffff, 14, this.tex.hardGlow));
        break;
      case 'displacement':
        g.add(this.sprite(0x20c0ff, 70), this.sprite(0xc0ffff, 28, this.tex.hardGlow));
        break;
      case 'gravity': {
        const core = new THREE.Mesh(new THREE.SphereGeometry(15, 16, 12), new THREE.MeshBasicMaterial({ color: 0x050008 }));
        g.add(this.sprite(0x9030ff, 150, this.tex.glow, 0.85), core, this.sprite(0xd090ff, 50, this.tex.ring, 0.9));
        break;
      }
      case 'boomerang': {
        const blade = new THREE.Mesh(
          new THREE.TorusGeometry(16, 3.2, 4, 14, Math.PI * 1.25),
          new THREE.MeshLambertMaterial({ color: 0xd8d8e8, emissive: 0x303040 }),
        );
        blade.rotation.x = Math.PI / 2;
        const spin = new THREE.Group();
        spin.add(blade);
        spin.name = 'spin';
        g.add(spin, this.sprite(0xa0b0ff, 50, this.tex.glow, 0.5));
        break;
      }
      case 'link': {
        const hook = new THREE.Mesh(new THREE.ConeGeometry(6, 18, 6), new THREE.MeshLambertMaterial({ color: 0x9090a0, emissive: 0x202030 }));
        hook.rotation.z = -Math.PI / 2;
        hook.name = 'hook';
        g.add(hook, this.sprite(0xc080ff, 40, this.tex.glow, 0.6));
        v.chain = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0x707080, side: THREE.DoubleSide }));
        this.scene.add(v.chain);
        break;
      }
    }
    if (g.children.length === 0) {
      const path = pr.modelPath.toLowerCase();
      const color = path.includes('freezing') || path.includes('frost') ? 0x90d8ff
        : path.includes('deathcoil') || path.includes('illidan') || path.includes('shadow') ? 0x7cff70
          : path.includes('absorb') || path.includes('spirit') ? 0x80a0ff
            : path.includes('dragon') || path.includes('fire') ? 0xff8020
              : 0xd0b0ff;
      g.add(this.sprite(color, 52 * (pr.scale || 1)), this.sprite(0xffffff, 16 * (pr.scale || 1), this.tex.hardGlow, 0.85));
    }
    this.scene.add(g);
    return v;
  }

  private updateProjectiles(alpha: number, dt: number) {
    const seen = new Set<number>();
    for (const pr of this.sim.projectiles) {
      seen.add(pr.id);
      let v = this.projs.get(pr.id);
      if (!v) {
        v = this.createProj(pr);
        this.projs.set(pr.id, v);
      }
      const x = pr.px + (pr.x - pr.px) * alpha;
      const y = pr.py + (pr.y - pr.py) * alpha;
      const h = pr.kind === 'gravity' ? 50 : PROJ_HEIGHT;
      v.obj.position.set(x, h, -y);
      const heading = Math.atan2(pr.vy, pr.vx);
      v.obj.rotation.y = heading;
      if (v.mdx) v.obj.rotation.y = heading;
      const spin = v.obj.getObjectByName('spin');
      if (spin) spin.rotation.y += dt * 28;
      if (pr.kind === 'gravity' && !v.mdx) v.obj.children[0].scale.setScalar(150 + Math.sin(this.time * 8) * 15);

      if (v.chain) {
        const owner = this.sim.players[pr.owner];
        const a = sim2three(owner.x, owner.y, 55);
        const b = new THREE.Vector3(x, h, -y);
        v.chain.geometry.dispose();
        v.chain.geometry = this.makeRibbonGeo([a, b], 5);
      }

      v.carry += dt;
      const z = -y;
      if (v.mdx) v.carry = 0;
      while (v.carry > 1 / 60) {
        v.carry -= 1 / 60;
        const jx = rand(-5, 5);
        const jz = rand(-5, 5);
        switch (pr.kind) {
          case 'fireball':
            this.fire.emit({ x: x + jx, y: h + rand(-5, 5), z: z + jz, vx: rand(-20, 20), vy: rand(10, 40), vz: rand(-20, 20), life: rand(0.3, 0.5), size: rand(44, 60), endSize: 14, color: 0xffb030, endColor: 0xc02000 });
            if (Math.random() < 0.3) this.smoke.emit({ x, y: h, z, vy: 30, life: 0.9, size: 22, endSize: 50, color: 0x2a2220, alpha: 0.45 });
            break;
          case 'homing':
            this.fire.emit({ x: x + jx, y: h, z: z + jz, life: rand(0.3, 0.5), size: 40, endSize: 10, color: 0xa0ff50, endColor: 0x206000 });
            if (Math.random() < 0.3) this.smoke.emit({ x, y: h, z, vy: 20, life: 1, size: 18, endSize: 40, color: 0x404838, alpha: 0.4 });
            break;
          case 'displacement':
            this.fx.emit({ x: x + jx * 2, y: h + rand(-8, 8), z: z + jz * 2, life: 0.4, size: 16, endSize: 2, color: 0xa0ffff, endColor: 0x0060ff });
            break;
          case 'gravity': {
            if (Math.random() < 0.5) {
              const a = rand(0, Math.PI * 2);
              const r = rand(70, 150);
              this.fx.emit({ x: x + Math.cos(a) * r, y: h + rand(-30, 30), z: z + Math.sin(a) * r, vx: -Math.cos(a) * r * 1.6 - Math.sin(a) * 120, vz: -Math.sin(a) * r * 1.6 + Math.cos(a) * 120, life: 0.55, size: 14, endSize: 4, color: 0xd0a0ff, endColor: 0x6000c0, drag: 1 });
            }
            break;
          }
          case 'boomerang':
            if (Math.random() < 0.4) this.fx.emit({ x, y: h, z, life: 0.25, size: 26, endSize: 8, color: 0x8090c0, alpha: 0.5 });
            break;
          case 'link':
            break;
        }
      }
    }
    for (const [id, v] of this.projs) {
      if (!seen.has(id)) {
        if (v.mdx) {
          // DestroyEffect on the missile art plays its Death animation where it was.
          const pos = v.mdx.getWorldPosition(new THREE.Vector3());
          const m = v.mdx;
          this.lib.release(m);
          if (m.model.hasSequence('death')) this.lib.spawnEffect(m.model.path, pos, { scale: m.scale.x, facing: v.obj.rotation.y, sequence: 'death', ttl: 3 });
        }
        this.scene.remove(v.obj);
        disposeObj(v.obj);
        if (v.chain) {
          this.scene.remove(v.chain);
          v.chain.geometry.dispose();
        }
        this.projs.delete(id);
      }
    }
  }

  private updateLinks() {
    const active = new Set<number>();
    for (const p of this.sim.players) {
      if (!p.link || !p.alive) continue;
      const t = this.sim.players[p.link.target];
      active.add(p.id);
      let m = this.linkBeams.get(p.id);
      if (!m) {
        m = new THREE.Mesh(new THREE.BufferGeometry(), this.beamMat(0xc070ff));
        this.scene.add(m);
        this.linkBeams.set(p.id, m);
      }
      const a = sim2three(p.x, p.y, 55);
      const b = sim2three(t.x, t.y, 50);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 12; i++) {
        const q = a.clone().lerp(b, i / 12);
        q.y += Math.sin(i * 1.3 + this.time * 25) * 4;
        pts.push(q);
      }
      m.geometry.dispose();
      m.geometry = this.makeRibbonGeo(pts, 14);
      if (Math.random() < 0.5) {
        const q = a.clone().lerp(b, Math.random());
        this.fx.emit({ x: q.x, y: q.y, z: q.z, vy: 30, life: 0.4, size: 14, color: 0xe0b0ff, endColor: 0x6020a0 });
      }
    }
    for (const [id, m] of this.linkBeams) {
      if (!active.has(id)) {
        this.scene.remove(m);
        m.geometry.dispose();
        this.linkBeams.delete(id);
      }
    }
  }

  // ---------- one-shot effects ----------

  private addTransient(obj: THREE.Object3D, life: number, update?: (t: number, dt: number) => void) {
    this.scene.add(obj);
    this.transients.push({ obj, life, max: life, update });
  }

  private burst(x: number, y: number, h: number, n: number, spec: Partial<ParticleSpec> & { speed: number; color: number }, sys = this.fx) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const e = rand(-0.3, 1);
      const s = spec.speed * rand(0.3, 1);
      sys.emit({
        life: 0.6, size: 30, endSize: 6, ...spec,
        x: x + rand(-4, 4), y: h + rand(-4, 4), z: -y + rand(-4, 4),
        vx: Math.cos(a) * s * Math.cos(e), vy: Math.sin(e) * s + (spec.vy ?? 0), vz: Math.sin(a) * s * Math.cos(e),
      });
    }
  }

  private flash(x: number, y: number, h: number, color: number, size: number, life = 0.25) {
    const s = this.sprite(color, size);
    s.position.copy(sim2three(x, y, h));
    this.addTransient(s, life, (t) => {
      (s.material as THREE.SpriteMaterial).opacity = 1 - t;
      s.scale.setScalar(size * (1 + t * 0.5));
    });
  }

  private scorch(x: number, y: number, size: number) {
    if (!this.sim.isSafePoint(x, y)) return;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: this.tex.scorch, transparent: true, depthWrite: false, opacity: 0.85 }),
    );
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * Math.PI * 2;
    m.position.set(x, 0.5, -y);
    m.renderOrder = 2;
    this.addTransient(m, 9, (t) => {
      (m.material as THREE.MeshBasicMaterial).opacity = 0.85 * Math.min(1, (1 - t) * 3);
    });
  }

  addMoveMarker(x: number, y: number) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.tex.thickRing, color: 0x30ff30, transparent: true, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 1.5, -y);
    m.renderOrder = 6;
    this.addTransient(m, 0.45, (t) => {
      const s = 70 * (1 - t) + 12;
      m.scale.set(s, s, 1);
      (m.material as THREE.MeshBasicMaterial).opacity = 1 - t * t;
    });
  }

  private lightningBolt(x1: number, y1: number, x2: number, y2: number) {
    const a = sim2three(x1, y1, 50);
    const b = sim2three(x2, y2, 46);
    const len = a.distanceTo(b);
    const n = Math.max(4, Math.round(len / 28));
    const make = () => {
      const pts: THREE.Vector3[] = [];
      const dir = b.clone().sub(a).normalize();
      const perp = new THREE.Vector3(-dir.z, 0, dir.x);
      for (let i = 0; i <= n; i++) {
        const q = a.clone().lerp(b, i / n);
        if (i > 0 && i < n) {
          q.addScaledVector(perp, rand(-22, 22));
          q.y += rand(-12, 12);
        }
        pts.push(q);
      }
      return pts;
    };
    const group = new THREE.Group();
    const variants: THREE.Group[] = [];
    for (let k = 0; k < 3; k++) {
      const pts = make();
      const vg = new THREE.Group();
      vg.add(new THREE.Mesh(this.makeRibbonGeo(pts, 34), this.beamMat(0x3a70ff, true, 0.9)));
      vg.add(new THREE.Mesh(this.makeRibbonGeo(pts, 9), this.beamMat(0xffffff)));
      vg.visible = k === 0;
      variants.push(vg);
      group.add(vg);
    }
    let last = 0;
    this.addTransient(group, 0.32, (t) => {
      const idx = Math.floor(t * 10) % 3;
      if (idx !== last) {
        variants.forEach((v, i) => (v.visible = i === idx));
        last = idx;
      }
      for (const v of variants)
        for (const c of v.children) ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - t * t;
    });
    this.burst(x2, y2, 46, 18, { speed: 260, color: 0xc0e0ff, endColor: 0x2040ff, size: 14, endSize: 2, life: 0.4 });
    this.flash(x2, y2, 46, 0x6090ff, 120, 0.2);
  }

  private meteorFall(x: number, y: number, delay: number) {
    const target = sim2three(x, y, 0);
    const start = target.clone().add(new THREE.Vector3(-500, 1500, 260));
    const rock = new THREE.Group();
    const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(30, 0), new THREE.MeshLambertMaterial({ color: 0x3a2418, emissive: 0x802000 }));
    rock.add(stone, this.sprite(0xff6010, 160), this.sprite(0xffd060, 60));
    this.addTransient(rock, delay, (t, dt) => {
      const e = t * t;
      rock.position.lerpVectors(start, target, e);
      stone.rotation.x += dt * 4;
      stone.rotation.y += dt * 3;
      for (let i = 0; i < 3; i++) {
        this.fire.emit({ x: rock.position.x + rand(-15, 15), y: rock.position.y + rand(-15, 15), z: rock.position.z + rand(-15, 15), life: 0.5, size: 75, endSize: 20, color: 0xffa030, endColor: 0xa01000 });
      }
      this.smoke.emit({ x: rock.position.x, y: rock.position.y, z: rock.position.z, life: 1.4, size: 50, endSize: 110, color: 0x1a1210, alpha: 0.6 });
    });
    const r = 220;
    const ring = new THREE.Mesh(
      new THREE.PlaneGeometry(r * 2, r * 2),
      new THREE.MeshBasicMaterial({ map: this.tex.thickRing, color: 0xff5010, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 1.6, -y);
    ring.renderOrder = 5;
    this.addTransient(ring, delay, (t) => {
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.35 * Math.sin(t * 30);
    });
  }

  private meteorImpact(x: number, y: number, radius: number) {
    this.burst(x, y, 20, 90, { speed: radius * 3.2, color: 0xffc040, endColor: 0xb01000, size: 75, endSize: 20, life: 0.7, drag: 2.5, vy: 80 }, this.fire);
    this.burst(x, y, 70, 40, { speed: radius * 1.5, color: 0x2a1e18, size: 70, endSize: 160, life: 1.8, drag: 2, vy: 90, alpha: 0.7 }, this.smoke);
    this.burst(x, y, 20, 25, { speed: 400, color: 0x281810, size: 14, endSize: 10, life: 1.0, gravity: 900, vy: 300, alpha: 1 }, this.smoke);
    this.flash(x, y, 40, 0xff8020, radius * 3.5, 0.35);
    this.scorch(x, y, radius * 2.2);
    const d = Math.hypot(x - this.camX, y - this.camY);
    this.shake = Math.max(this.shake, 22 * Math.max(0, 1 - d / 1500));
  }

  /** Plays the event's real WC3 effect model if it's loaded; false means draw the procedural fallback. */
  private modelFx(e: GameEvent): boolean {
    const at = (path: string, x: number, y: number, h = 0, scale = 1) => this.lib.spawnEffect(path, sim2three(x, y, h), { scale }) !== null;
    switch (e.t) {
      case 'effect':
        if (e.name === 'shield') return false;
        if (e.name === 'thrustAfterimage' || e.name === 'timeshiftDummy') {
          const inst = this.lib.spawnEffect(e.modelPath, sim2three(e.x, e.y, 0), { scale: e.scale, sequence: 'walk', fade: e.name === 'thrustAfterimage' ? 0.4 : 1.5 });
          if (inst) inst.opacity = 0.5;
          return inst !== null;
        }
        return at(e.modelPath, e.x, e.y, 0, e.scale);
      case 'explode':
        return at(e.modelPath, e.x, e.y, 0, e.scale);
      case 'teleport':
        return at(e.modelPath, e.fx, e.fy) && at(e.modelPath, e.tx, e.ty);
      case 'swap':
        return at(e.modelPath, e.ax, e.ay) && at(e.modelPath, e.bx, e.by);
      case 'meteorImpact':
      case 'thrustHit':
      case 'death':
        return at(e.modelPath, e.x, e.y);
      case 'reflect':
        return at(e.modelPath, e.x, e.y, PROJ_HEIGHT);
      default:
        return false;
    }
  }

  onEvent(e: GameEvent) {
    if (e.t === 'cast') {
      const v = this.units.get(e.pid);
      if (v) {
        v.spellT = 0.6;
        v.seq = '';
      }
    }
    if (this.modelFx(e)) {
      if (e.t === 'meteorImpact') {
        const d = Math.hypot(e.x - this.camX, e.y - this.camY);
        this.shake = Math.max(this.shake, 22 * Math.max(0, 1 - d / 1500));
      }
      return;
    }
    switch (e.t) {
      case 'cast': {
        const p = this.sim.players[e.pid];
        if (e.spell === 'windwalk') {
          this.burst(p.x, p.y, 40, 25, { speed: 120, color: 0xb0b0b0, size: 40, endSize: 90, life: 1, drag: 2, alpha: 0.5 }, this.smoke);
        } else if (e.spell === 'shield') {
          this.burst(p.x, p.y, 45, 30, { speed: 200, color: 0xa0d0ff, endColor: 0x2050ff, size: 18, endSize: 4, life: 0.5 });
        } else if (e.spell === 'thrust') {
          this.burst(p.x, p.y, 10, 16, { speed: 140, color: 0x8a7458, size: 30, endSize: 70, life: 0.8, drag: 3, alpha: 0.6 }, this.smoke);
        } else if (p.windwalk <= 0 || p.id === this.localId) {
          const hx = p.x + Math.cos(p.facing) * 30;
          const hy = p.y + Math.sin(p.facing) * 30;
          const col = e.spell === 'homing' ? 0x80ff40 : e.spell === 'gravity' || e.spell === 'link' ? 0xa060ff : e.spell === 'displacement' || e.spell === 'teleport' || e.spell === 'lightning' ? 0x60a0ff : 0xff8020;
          this.flash(hx, hy, 70, col, 60, 0.2);
        }
        break;
      }
      case 'explode': {
        const colors: Record<string, [number, number]> = {
          fireball: [0xffc040, 0xc02000], homing: [0xc0ff60, 0x208000], boomerang: [0xe0e0ff, 0x4040a0],
          gravity: [0xd090ff, 0x4000a0], link: [0xc0a0ff, 0x4000a0], displacement: [0xa0ffff, 0x0060ff], clash: [0xffffff, 0xff6000],
        };
        const [c0, c1] = colors[e.kind] ?? [0xffc040, 0x8040ff];
        const big = e.kind === 'fireball' || e.kind === 'homing' || e.kind === 'clash';
        this.burst(e.x, e.y, PROJ_HEIGHT, big ? 34 : 16, { speed: big ? 330 : 200, color: c0, endColor: c1, size: big ? 52 : 20, endSize: big ? 14 : 6, life: 0.5, drag: 3 }, big ? this.fire : this.fx);
        if (big) {
          this.burst(e.x, e.y, PROJ_HEIGHT, 10, { speed: 90, color: 0x2a2220, size: 40, endSize: 90, life: 1.1, drag: 2, vy: 40, alpha: 0.55 }, this.smoke);
          this.flash(e.x, e.y, PROJ_HEIGHT, c0, 170, 0.22);
          this.scorch(e.x, e.y, 70);
        }
        if (e.kind === 'gravity') this.flash(e.x, e.y, 50, 0x8030ff, 260, 0.4);
        break;
      }
      case 'hit': {
        const v = this.units.get(e.pid);
        if (v) v.flash = 1;
        break;
      }
      case 'lightning':
        this.lightningBolt(e.x1, e.y1, e.x2, e.y2);
        break;
      case 'teleport':
        for (const [x, y] of [[e.fx, e.fy], [e.tx, e.ty]]) {
          this.burst(x, y, 50, 40, { speed: 160, color: 0xc0e0ff, endColor: 0x2050ff, size: 22, endSize: 4, life: 0.6, vy: 120 });
          this.flash(x, y, 50, 0x6090ff, 150, 0.35);
          for (let i = 0; i < 14; i++)
            this.fx.emit({ x: x + rand(-20, 20), y: rand(0, 20), z: -y + rand(-20, 20), vy: rand(250, 500), life: 0.6, size: 26, endSize: 6, color: 0xa0d0ff, endColor: 0x2040ff });
        }
        break;
      case 'swap':
        for (const [x, y] of [[e.ax, e.ay], [e.bx, e.by]]) {
          this.burst(x, y, 50, 30, { speed: 180, color: 0xa0ffff, endColor: 0x0060ff, size: 22, endSize: 4, life: 0.6 });
          this.flash(x, y, 50, 0x20c0ff, 140, 0.3);
        }
        break;
      case 'meteorFall':
        this.meteorFall(e.x, e.y, e.delay);
        break;
      case 'meteorImpact':
        this.meteorImpact(e.x, e.y, e.radius);
        break;
      case 'death':
        if (e.inLava) {
          for (let i = 0; i < 40; i++)
            this.fire.emit({ x: e.x + rand(-25, 25), y: rand(0, 30), z: -e.y + rand(-25, 25), vy: rand(150, 400), vx: rand(-40, 40), vz: rand(-40, 40), life: rand(0.6, 1.1), size: rand(40, 64), endSize: 12, color: 0xffb040, endColor: 0xa01000 });
          this.burst(e.x, e.y, 30, 20, { speed: 60, color: 0x201810, size: 50, endSize: 120, life: 2, vy: 90, alpha: 0.6 }, this.smoke);
        } else {
          this.burst(e.x, e.y, 40, 30, { speed: 160, color: 0x701010, endColor: 0x200000, size: 22, endSize: 6, life: 0.8, gravity: 300, alpha: 0.9 }, this.smoke);
        }
        break;
      case 'reflect':
        this.burst(e.x, e.y, PROJ_HEIGHT, 20, { speed: 260, color: 0xd0f0ff, endColor: 0x2060ff, size: 16, endSize: 3, life: 0.4 });
        this.flash(e.x, e.y, PROJ_HEIGHT, 0x80b0ff, 120, 0.2);
        break;
      case 'thrustHit':
        this.burst(e.x, e.y, 40, 26, { speed: 260, color: 0xffe0a0, endColor: 0xff6000, size: 20, endSize: 4, life: 0.4 });
        this.burst(e.x, e.y, 10, 12, { speed: 120, color: 0x8a7458, size: 30, endSize: 70, life: 0.9, drag: 3, alpha: 0.6 }, this.smoke);
        this.shake = Math.max(this.shake, 6);
        break;
      case 'linkHit': {
        const t = this.sim.players[e.target];
        this.burst(t.x, t.y, 50, 20, { speed: 200, color: 0xe0c0ff, endColor: 0x6020c0, size: 18, endSize: 4, life: 0.5 });
        break;
      }
      default:
        break;
    }
  }

  // ---------- obstacles ----------

  private obstacleObject(o: Obstacle): { obj: THREE.Object3D; mdx: boolean } {
    const inst = this.lib.instance(o.modelPath);
    if (inst) {
      inst.setSequence('stand', true);
      inst.scale.setScalar(o.scale);
      inst.rotation.y = o.facing;
      inst.position.set(o.x, 0, -o.y);
      return { obj: inst, mdx: true };
    }
    return { obj: obstacleModel(o), mdx: false };
  }

  private updateObstacles() {
    if (this.obstacleSet !== this.sim.obstacles) {
      for (const v of this.obstacleViews) this.removeObstacleView(v);
      this.obstacleSet = this.sim.obstacles;
      this.obstacleViews = this.sim.obstacles.map((obs) => {
        const v = { obs, ...this.obstacleObject(obs) };
        this.scene.add(v.obj);
        return v;
      });
    }
    for (const v of this.obstacleViews) {
      if (v.mdx || !this.lib.get(v.obs.modelPath)) continue;
      this.removeObstacleView(v);
      Object.assign(v, this.obstacleObject(v.obs));
      this.scene.add(v.obj);
    }
  }

  private removeObstacleView(v: { obj: THREE.Object3D; mdx: boolean }) {
    if (v.mdx) this.lib.release(v.obj as MdxInstance);
    else {
      this.scene.remove(v.obj);
      if (!v.obj.userData.shared) disposeObj(v.obj);
    }
  }

  // ---------- frame ----------

  render(alpha: number, dt: number) {
    this.time += dt;
    this.terrain.update(this.sim);

    this.updateUnits(alpha, dt);
    this.updateProjectiles(alpha, dt);
    this.updateLinks();
    for (const t of this.transients) {
      t.life -= dt;
      t.update?.(1 - Math.max(0, t.life) / t.max, dt);
      if (t.life <= 0) {
        this.scene.remove(t.obj);
        disposeObj(t.obj);
      }
    }
    this.transients = this.transients.filter((t) => t.life > 0);
    this.fx.update(dt);
    this.fire.update(dt);
    this.smoke.update(dt);
    this.updateObstacles();

    // Camera
    this.shake = Math.max(0, this.shake - dt * 40);
    const sx = (Math.random() - 0.5) * this.shake;
    const sy = (Math.random() - 0.5) * this.shake;
    const target = sim2three(this.camX + sx, this.camY + sy, 0);
    this.camera.position.set(target.x, Math.sin(CAM_PITCH) * this.camDist, target.z + Math.cos(CAM_PITCH) * this.camDist);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
    this.lib.update(dt, this.camera);

    this.renderer.render(this.scene, this.camera);
    this.portraitDt += dt;
    // The portrait is a small second WebGL canvas; 30 fps is plenty for an idle bust.
    if (this.portraitDt >= 1 / 30 - 0.002 || dt === 0) {
      this.renderPortrait(this.portraitDt);
      this.portraitDt = 0;
    }
  }

  private portraitDt = 0;

  private renderPortrait(dt: number) {
    const el = this.portraitEl;
    if (!el) return;
    const { w, h } = this.portraitSize;
    if (w < 4 || h < 4) return;
    const pr = this.portraitRenderer;
    const cur = pr.getSize(new THREE.Vector2());
    if (cur.x !== w || cur.y !== h) {
      pr.setSize(w, h);
      this.portraitCam.aspect = w / h;
      this.portraitCam.updateProjectionMatrix();
    }
    const p = this.sim.players[this.localId];
    const v = this.units.get(p.id)!;
    if (!this.portraitMdx) {
      const model = this.lib.get(WARLOCK_MODEL);
      if (model) {
        // No BloodelfWizard_portrait in the map, so like WC3 we frame the unit model's head.
        this.portraitMdx = model.createInstance();
        this.portraitMdx.rotation.y = 0.5;
        this.portraitScene.add(this.portraitMdx);
        if (this.portraitModel) this.portraitModel.root.visible = false;
        this.portraitColor = -1;
      }
    }
    if (this.portraitMdx) {
      const pm = this.portraitMdx;
      if (this.portraitColor !== p.color) {
        pm.teamColor = new THREE.Color(PLAYER_COLORS[p.color].css);
        this.portraitColor = p.color;
        // BloodelfWizard's head sits at ~118 model units and it faces +X.
        this.portraitCam.position.set(95, 124, 0);
        this.portraitCam.fov = 30;
        this.portraitCam.updateProjectionMatrix();
        this.portraitCam.lookAt(0, 112, 0);
      }
      const want = !p.alive ? 'death' : v.seq === 'spell' ? 'spell' : 'stand';
      if (want !== this.portraitSeq) {
        pm.setSequence(want, want === 'stand');
        this.portraitSeq = want;
      }
      pm.update(dt, this.portraitCam);
      pr.render(this.portraitScene, this.portraitCam);
      return;
    }
    if (this.portraitColor !== p.color) {
      if (this.portraitModel) this.portraitScene.remove(this.portraitModel.root);
      this.portraitModel = new WarlockModel(new THREE.Color(PLAYER_COLORS[p.color].css));
      this.portraitModel.root.rotation.y = 0.35;
      this.portraitScene.add(this.portraitModel.root);
      this.portraitColor = p.color;
    }
    const m = this.portraitModel!;
    m.update({ moving: 0, casting: v.casting, knocked: 0, dead: !p.alive, dt });
    pr.render(this.portraitScene, this.portraitCam);
  }
}
