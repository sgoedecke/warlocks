import * as THREE from 'three';

export interface ParticleSpec {
  x: number;
  y: number; // height
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size: number;
  endSize?: number;
  color: number;
  endColor?: number;
  alpha?: number;
  gravity?: number;
  drag?: number;
}

const VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
attribute float aFrame;
varying vec4 vColor;
varying float vFrame;
uniform float uScale;
void main() {
  vColor = aColor;
  vFrame = aFrame;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform float uGrid;
varying vec4 vColor;
varying float vFrame;
void main() {
  vec2 cell = vec2(mod(vFrame, uGrid), floor(vFrame / uGrid));
  vec2 uv = (cell + gl_PointCoord) / uGrid;
  vec4 t = texture2D(uTex, vec2(uv.x, 1.0 - uv.y));
  gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  if (gl_FragColor.a < 0.003) discard;
}`;

// A single fixed-capacity point-sprite particle pool.
export class ParticleSystem {
  readonly points: THREE.Points;
  private cap: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  private a0: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private frame: Float32Array;
  private frame0: Float32Array;
  private frames: number;
  private next = 0;
  private material: THREE.ShaderMaterial;
  private tmpA = new THREE.Color();
  private tmpB = new THREE.Color();

  /** `grid` > 1 treats the texture as a grid×grid flipbook played over each particle's life. */
  constructor(cap: number, texture: THREE.Texture, additive: boolean, grid = 1) {
    this.cap = cap;
    this.frames = grid * grid;
    this.frame = new Float32Array(cap);
    this.frame0 = new Float32Array(cap);
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.c0 = new Float32Array(cap * 3);
    this.c1 = new Float32Array(cap * 3);
    this.a0 = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aFrame', new THREE.BufferAttribute(this.frame, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTex: { value: texture }, uScale: { value: 800 }, uGrid: { value: grid } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 20 : 10;
  }

  setScale(viewportHeight: number, fovDeg: number) {
    this.material.uniforms.uScale.value = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(p: ParticleSpec) {
    const i = this.next;
    this.next = (this.next + 1) % this.cap;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = p.vx ?? 0;
    this.vel[i * 3 + 1] = p.vy ?? 0;
    this.vel[i * 3 + 2] = p.vz ?? 0;
    this.life[i] = this.maxLife[i] = p.life;
    this.s0[i] = p.size;
    this.s1[i] = p.endSize ?? p.size;
    this.tmpA.setHex(p.color);
    this.tmpB.setHex(p.endColor ?? p.color);
    this.c0.set([this.tmpA.r, this.tmpA.g, this.tmpA.b], i * 3);
    this.c1.set([this.tmpB.r, this.tmpB.g, this.tmpB.b], i * 3);
    this.a0[i] = p.alpha ?? 1;
    this.grav[i] = p.gravity ?? 0;
    this.drag[i] = p.drag ?? 0;
    // Start somewhere in the first quarter so neighbouring puffs don't look identical.
    this.frame0[i] = Math.floor(Math.random() * this.frames * 0.25);
  }

  update(dt: number) {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        this.col[i * 4 + 3] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      if (this.frames > 1) this.frame[i] = Math.min(this.frames - 1, this.frame0[i] + Math.floor(t * this.frames * 0.75));
      for (let k = 0; k < 3; k++) this.col[i * 4 + k] = this.c0[i * 3 + k] + (this.c1[i * 3 + k] - this.c0[i * 3 + k]) * t;
      // quick fade in, smooth fade out
      this.col[i * 4 + 3] = this.a0[i] * Math.min(1, t * 8) * (1 - t * t);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    if (this.frames > 1) g.attributes.aFrame.needsUpdate = true;
  }
}
