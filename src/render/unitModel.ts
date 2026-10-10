import * as THREE from 'three';

export interface AnimInput {
  moving: number; // 0..1 walk blend
  casting: number; // 0..1 staff raised
  knocked: number; // 0..1 lean back
  time: number;
}

const ROBE = 0x2a1d30;
const ROBE_DARK = 0x160e1a;
const METAL = 0x5a5560;
const SKIN = 0x6a7a3a; // orcish green hands
const WOOD = 0x4a2e18;

// A procedurally built hooded warlock, built facing +X. Rough WC3 hero proportions (~95 units tall).
export class WarlockModel {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private rArm = new THREE.Group();
  private lArm = new THREE.Group();
  private cape: THREE.Mesh;
  private materials: THREE.Material[] = [];
  readonly orb: THREE.Mesh;
  readonly orbGlow: THREE.Sprite;
  private baseColors = new Map<THREE.Material, THREE.Color>();

  constructor(teamColor: THREE.Color, glowTex: THREE.Texture) {
    const lam = (color: number | THREE.Color, opts: THREE.MeshLambertMaterialParameters = {}) => {
      const m = new THREE.MeshLambertMaterial({ color, ...opts });
      this.materials.push(m);
      this.baseColors.set(m, m.color.clone());
      return m;
    };
    const robeMat = lam(ROBE);
    const darkMat = lam(ROBE_DARK);
    const teamMat = lam(teamColor.clone().multiplyScalar(0.85));
    const metalMat = lam(METAL);
    const skinMat = lam(SKIN);
    const woodMat = lam(WOOD);

    this.root.add(this.body);

    // Robe
    const profile = [
      [0, 0], [25, 0], [24, 4], [20, 18], [16, 34], [13, 46], [12, 54], [8, 58], [0, 59],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const robe = new THREE.Mesh(new THREE.LatheGeometry(profile, 14), robeMat);
    this.body.add(robe);

    const hem = new THREE.Mesh(new THREE.TorusGeometry(23.5, 2.2, 6, 18), teamMat);
    hem.rotation.x = Math.PI / 2;
    hem.position.y = 4;
    this.body.add(hem);

    const sash = new THREE.Mesh(new THREE.TorusGeometry(16.5, 2.4, 6, 16), teamMat);
    sash.rotation.x = Math.PI / 2;
    sash.position.y = 33;
    this.body.add(sash);

    // Front robe panel (team colour tabard)
    const tabard = new THREE.Mesh(new THREE.PlaneGeometry(10, 30), teamMat);
    tabard.position.set(17.6, 18, 0);
    tabard.rotation.y = Math.PI / 2;
    tabard.rotation.z = -0.24;
    tabard.rotation.order = 'YZX';
    this.body.add(tabard);

    // Shoulders
    for (const side of [-1, 1]) {
      const pad = new THREE.Mesh(new THREE.SphereGeometry(8.5, 10, 8), teamMat);
      pad.scale.set(1.05, 0.65, 1);
      pad.position.set(0, 56, side * 13);
      this.body.add(pad);
      for (let k = 0; k < 2; k++) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(2, 9, 5), metalMat);
        spike.position.set(-2 + k * 5, 61, side * (14 + k));
        spike.rotation.x = side * 0.5;
        this.body.add(spike);
      }
    }

    // Hood
    const hood = new THREE.Mesh(new THREE.SphereGeometry(10.5, 12, 10), darkMat);
    hood.scale.set(1.05, 1.1, 0.95);
    hood.position.set(0, 68, 0);
    this.body.add(hood);
    const peak = new THREE.Mesh(new THREE.ConeGeometry(8.5, 17, 8), darkMat);
    peak.position.set(-4, 78, 0);
    peak.rotation.z = 0.55;
    this.body.add(peak);
    const face = new THREE.Mesh(new THREE.CircleGeometry(6.2, 12), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    face.position.set(9.6, 67, 0);
    face.rotation.y = Math.PI / 2;
    this.body.add(face);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(1.3, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffb030 }));
      eye.position.set(10.2, 68, side * 2.6);
      this.body.add(eye);
    }

    // Cape
    const capeGeo = new THREE.PlaneGeometry(26, 46, 2, 4);
    capeGeo.translate(0, -23, 0);
    this.cape = new THREE.Mesh(capeGeo, lam(teamColor.clone().multiplyScalar(0.55), { side: THREE.DoubleSide }));
    this.cape.position.set(-11, 58, 0);
    this.cape.rotation.y = Math.PI / 2;
    this.cape.rotation.order = 'YXZ';
    this.body.add(this.cape);

    // Arms (pivot at shoulder, hang down -Y)
    const makeArm = (g: THREE.Group, side: number) => {
      g.position.set(1, 54, side * 15);
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 6, 24, 8), robeMat);
      sleeve.position.y = -11;
      g.add(sleeve);
      const cuff = new THREE.Mesh(new THREE.TorusGeometry(5.6, 1.4, 5, 10), teamMat);
      cuff.rotation.x = Math.PI / 2;
      cuff.position.y = -22;
      g.add(cuff);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(3.6, 8, 6), skinMat);
      hand.position.y = -26;
      g.add(hand);
      this.body.add(g);
    };
    makeArm(this.rArm, 1);
    makeArm(this.lArm, -1);
    this.lArm.rotation.z = 0.25;

    // Staff in the right hand
    const staff = new THREE.Group();
    staff.position.set(0, -26, 0);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.8, 100, 6), woodMat);
    shaft.position.y = 12;
    staff.add(shaft);
    const prongs = new THREE.Group();
    prongs.position.y = 62;
    for (let k = 0; k < 3; k++) {
      const pr = new THREE.Mesh(new THREE.ConeGeometry(1.4, 12, 4), metalMat);
      const a = (k / 3) * Math.PI * 2;
      pr.position.set(Math.cos(a) * 4, 2, Math.sin(a) * 4);
      pr.rotation.set(Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4);
      prongs.add(pr);
    }
    staff.add(prongs);
    this.orb = new THREE.Mesh(new THREE.SphereGeometry(4.2, 10, 8), new THREE.MeshBasicMaterial({ color: teamColor.clone().lerp(new THREE.Color(1, 1, 1), 0.35) }));
    this.orb.position.y = 65;
    staff.add(this.orb);
    this.orbGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: teamColor, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9,
    }));
    this.orbGlow.scale.set(26, 26, 1);
    this.orbGlow.position.y = 65;
    staff.add(this.orbGlow);
    this.rArm.add(staff);
  }

  update(a: AnimInput) {
    const t = a.time;
    const walk = a.moving;
    const bob = Math.abs(Math.sin(t * 9)) * 3 * walk;
    this.body.position.y = bob + Math.sin(t * 2) * 0.6 * (1 - walk);
    this.body.rotation.z = -0.12 * walk + 0.28 * a.knocked;
    const swing = Math.sin(t * 9) * 0.5 * walk;
    this.rArm.rotation.z = swing * 0.6 + a.casting * 1.7 + 0.1;
    this.rArm.rotation.x = -0.1 - a.casting * 0.2;
    this.lArm.rotation.z = -swing + 0.25 + a.casting * 0.6;
    this.lArm.rotation.x = 0.15;
    this.cape.rotation.z = 0.15 + 0.35 * walk + Math.sin(t * 7) * 0.06 * (0.3 + walk) + 0.3 * a.knocked;
  }

  setOpacity(o: number) {
    for (const m of this.materials) {
      m.transparent = o < 0.999;
      m.opacity = o;
      m.depthWrite = o > 0.5;
    }
    (this.orbGlow.material as THREE.SpriteMaterial).opacity = 0.9 * o;
  }

  // Blend toward a colour (burning in lava, hit flash)
  setTint(color: THREE.Color, amount: number) {
    for (const m of this.materials) {
      const base = this.baseColors.get(m)!;
      (m as THREE.MeshLambertMaterial).color.copy(base).lerp(color, amount);
    }
  }
}
