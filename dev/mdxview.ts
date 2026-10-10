import * as THREE from 'three';
import { assets } from '../src/assets/store';
import { loadMdxModel, type MdxInstance } from '../src/render/mdx';

const hud = document.getElementById('hud')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070304);
scene.fog = new THREE.Fog(0x090405, 1600, 4300);
const camera = new THREE.PerspectiveCamera(48, 1, 10, 9000);
scene.add(new THREE.HemisphereLight(0xb8b0d0, 0x3a1208, 1.45));
const sun = new THREE.DirectionalLight(0xffeed8, 2.2);
sun.position.set(-600, 1100, 500);
scene.add(sun);

const groundMat = new THREE.MeshBasicMaterial({ color: 0x180b09 });
const ground = new THREE.Mesh(new THREE.CircleGeometry(1900, 96), groundMat);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const grid = new THREE.GridHelper(3800, 38, 0x5c2a19, 0x2b1510);
grid.position.y = 1;
scene.add(grid);

const params = new URLSearchParams(location.search);
const focus = params.get('focus');
const names = focus ? focus.split(',') : [
  'BloodelfWizard.mdx', 'fb2.mdx', 'LGH_FB.mdx', 'epicexplosion1.mdx', 'epicexplosion2.mdx', 'ExplosionBIG.mdx',
  'ArcaneGlaive.mdx', 'ArcaneExplosion.mdx', 'Nova_yellow.mdx', 'shield.mdx', 'sword.mdx', 'Thunderclap_nosplat.mdx', 'Blue_WarStompCaster.mdx',
];
const teamColors = [0xff2020, 0x2080ff, 0x20d050, 0xa050ff, 0xffb020, 0x20d8e8];
const instances: MdxInstance[] = [];
const labels: THREE.Sprite[] = [];
const positions: [number, number][] = focus ? names.map((_, i) => [i * 300 - (names.length - 1) * 150, 0]) : [
  [0, -120],
  [520, -220],
  [930, -220],
  [1180, 520],
  [1000, 920],
  [-1150, 700],
  [-520, -340],
  [0, 620],
  [560, 650],
  [-720, -540],
  [-1040, -280],
  [-900, 260],
  [-460, 760],
];

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

function label(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(0,0,0,.5)';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffd88a';
  g.font = '18px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(text, c.width / 2, 30);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set(220, 42, 1);
  return s;
}

function chooseSequence(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('bloodelf')) return 'walk';
  if (n.includes('shield') || n.includes('sword') || n.includes('glaive')) return 'stand';
  return 'birth';
}

async function main() {
  const bytes = new Uint8Array(await (await fetch('/reference/Warlock088bhotfix.w3m')).arrayBuffer());
  await assets.addArchive('warlock088b', bytes);
  hud.textContent = 'Archive loaded. Preparing models…';
  const cols = 5;
  for (let i = 0; i < names.length; i++) {
    const model = await loadMdxModel(names[i]);
    if (!model) {
      hud.textContent += `\nMissing ${names[i]}`;
      continue;
    }
    const inst = model.createInstance();
    const [x, z] = positions[i] ?? [(i % cols - (cols - 1) / 2) * 520, (Math.floor(i / cols) - 1) * 520];
    inst.position.set(x, 0, z);
    inst.teamColor = new THREE.Color(teamColors[i % teamColors.length]);
    inst.setSequence(params.get('seq') ?? chooseSequence(names[i]), true);
    if (names[i] === 'BloodelfWizard.mdx' && !focus) inst.scale.setScalar(2.2);
    if (/explosion|warstomp|thunderclap/i.test(names[i])) inst.scale.setScalar(1.4);
    scene.add(inst);
    instances.push(inst);
    const l = label(names[i].replace('.mdx', ''));
    l.position.set(x, 260, z);
    if (!focus) scene.add(l);
    labels.push(l);
  }
  // Small perf group: 12 extra warlocks hidden behind the camera target, updated every frame.
  const warlock = focus ? null : await loadMdxModel('BloodelfWizard.mdx');
  if (warlock) {
    for (let i = 0; i < 12; i++) {
      const w = warlock.createInstance();
      w.position.set(-1200 + (i % 6) * 120, 0, 1150 + Math.floor(i / 6) * 120);
      w.scale.setScalar(1.2);
      w.teamColor = new THREE.Color(teamColors[i % teamColors.length]);
      w.setSequence(i % 2 ? 'stand' : 'walk', true);
      w.visible = false;
      scene.add(w);
      instances.push(w);
    }
  }
  (window as unknown as { __ready: boolean }).__ready = true;
  hud.textContent = `Loaded ${names.length} models. Window.__ready = true.\nWarlock animates Walk; effect models loop Birth/Stand. Click to cycle the hero sequence.`;
}

let sequenceCycle = 0;
addEventListener('click', () => {
  const hero = instances.find((i) => i.name.includes('BloodelfWizard'));
  if (hero) hero.setSequence(['stand', 'walk', 'spell', 'attack', 'death'][++sequenceCycle % 5], sequenceCycle % 5 !== 4);
});

let last = performance.now();
let perfMs = 0;
let perfFrames = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (focus) {
    const d = +(params.get('d') ?? 420);
    const yaw = +(params.get('yaw') ?? 30) * Math.PI / 180;
    const h = +(params.get('h') ?? 80);
    camera.position.set(Math.sin(yaw) * d, h + d * 0.35, Math.cos(yaw) * d);
    camera.lookAt(0, h, 0);
  } else {
    camera.position.set(1500, 1280, 1780);
    camera.lookAt(0, 80, 80);
  }
  const before = performance.now();
  const at = params.get('at');
  for (const inst of instances) inst.update(at && inst.globalMs >= +at ? 0 : Math.min(dt, at ? +at - inst.globalMs : dt), camera);
  perfMs += performance.now() - before;
  perfFrames++;
  if (perfFrames === 60) {
    (window as unknown as { __mdxPerfMs: number }).__mdxPerfMs = perfMs / perfFrames;
    perfMs = 0;
    perfFrames = 0;
  }
  renderer.render(scene, camera);
}

main().catch((e) => {
  console.error(e);
  hud.textContent = String(e?.stack ?? e);
});
requestAnimationFrame(frame);
