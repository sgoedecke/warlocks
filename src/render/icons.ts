/*
 * Original procedural command-button artworks, MIT-licensed with the project.
 * These canvas paintings are inspired by the subjects of the Warcraft III icons
 * they replace, but are not copied, traced, or derived from Blizzard artwork.
 */

type IconPainter = (g: CanvasRenderingContext2D, s: number) => void;

type Stop = [number, string];

const BTN = 'replaceabletextures\\commandbuttons\\';
const PAS = 'replaceabletextures\\passivebuttons\\';
const TAU = Math.PI * 2;

function norm(path: string): string {
  return path.toLowerCase().replace(/\//g, '\\');
}

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number, period: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const w = (i: number) => ((i % period) + period) % period;
  const a = hash(w(xi), w(yi), seed);
  const b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed);
  const d = hash(w(xi + 1), w(yi + 1), seed);
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, seed: number, baseFreq: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = baseFreq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * f, y * f, seed + o * 17, f);
    f *= 2;
    amp *= 0.5;
  }
  return sum;
}

function bg(g: CanvasRenderingContext2D, s: number, inner: string, outer: string, seed = 1) {
  const grd = g.createRadialGradient(s * 0.42, s * 0.34, s * 0.04, s * 0.52, s * 0.56, s * 0.78);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.65, outer);
  grd.addColorStop(1, '#020103');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);

  const cells = 18;
  g.globalAlpha = 0.13;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const n = fbm(x / cells, y / cells, seed, 5, 3);
      g.fillStyle = n > 0.52 ? '#ffffff' : '#000000';
      g.fillRect((x * s) / cells, (y * s) / cells, s / cells + 1, s / cells + 1);
    }
  }
  g.globalAlpha = 1;
  vignette(g, s, 'rgba(0,0,0,0.72)');
}

function vignette(g: CanvasRenderingContext2D, s: number, col = 'rgba(0,0,0,0.65)') {
  const grd = g.createRadialGradient(s / 2, s / 2, s * 0.2, s / 2, s / 2, s * 0.74);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(1, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
}

function glowBall(g: CanvasRenderingContext2D, x: number, y: number, r: number, stops: Stop[]) {
  const grd = g.createRadialGradient(x, y, 0, x, y, r);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
}

function ellipseGlow(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot: number, col: string, alpha = 1) {
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.globalAlpha = alpha;
  g.fillStyle = col;
  g.translate(x, y);
  g.rotate(rot);
  g.beginPath();
  g.ellipse(0, 0, rx, ry, 0, 0, TAU);
  g.fill();
  g.restore();
}

function strokePath(g: CanvasRenderingContext2D, col: string, width: number, glow = 0, glowCol = col) {
  g.save();
  if (glow) {
    g.shadowColor = glowCol;
    g.shadowBlur = glow;
  }
  g.strokeStyle = col;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.stroke();
  g.restore();
}

function fillPath(g: CanvasRenderingContext2D, fill: string | CanvasGradient, stroke = '#120804', width = 1.5) {
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = width;
  g.lineJoin = 'round';
  g.strokeStyle = stroke;
  g.stroke();
}

function poly(g: CanvasRenderingContext2D, pts: [number, number][], close = true) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  if (close) g.closePath();
}

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number, col = '#fff6b0') {
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.shadowColor = col;
  g.shadowBlur = r * 1.8;
  g.fillStyle = col;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 4;
    const rr = i % 2 ? r * 0.32 : r;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
  g.fill();
  g.restore();
}

function flameTongue(g: CanvasRenderingContext2D, s: number, x: number, y: number, r: number, rot: number, col: string) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = col;
  g.beginPath();
  g.moveTo(0, -r * 1.2);
  g.bezierCurveTo(r * 0.9, -r * 0.45, r * 0.45, r * 0.75, 0, r);
  g.bezierCurveTo(-r * 0.5, r * 0.45, -r * 0.9, -r * 0.35, 0, -r * 1.2);
  g.fill();
  g.restore();
}

function crescent(g: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, cut: string, rot = 0) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.fillStyle = col;
  g.shadowColor = col;
  g.shadowBlur = r * 0.35;
  g.beginPath();
  g.arc(0, 0, r, 0, TAU);
  g.fill();
  g.shadowBlur = 0;
  g.fillStyle = cut;
  g.beginPath();
  g.arc(r * 0.36, -r * 0.1, r * 0.92, 0, TAU);
  g.fill();
  g.restore();
}

function runeCircle(g: CanvasRenderingContext2D, s: number, x = 0.5, y = 0.5, r = 0.33, col = '#8fd7ff') {
  const cx = s * x, cy = s * y, rr = s * r;
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = col;
  g.shadowColor = col;
  g.shadowBlur = s * 0.09;
  g.lineWidth = s * 0.035;
  g.beginPath();
  g.arc(cx, cy, rr, 0, TAU);
  g.stroke();
  g.lineWidth = s * 0.018;
  for (let i = 0; i < 8; i++) {
    const a = (i * TAU) / 8;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * rr * 0.8, cy + Math.sin(a) * rr * 0.8);
    g.lineTo(cx + Math.cos(a) * rr * 1.15, cy + Math.sin(a) * rr * 1.15);
    g.stroke();
  }
  g.restore();
}

function hoodedFigure(g: CanvasRenderingContext2D, s: number, x: number, y: number, scale: number, robe: string, glow: string) {
  g.save();
  g.translate(x, y);
  g.scale(scale, scale);
  g.shadowColor = glow;
  g.shadowBlur = s * 0.05;
  const grd = g.createLinearGradient(0, -s * 0.23, 0, s * 0.34);
  grd.addColorStop(0, robe);
  grd.addColorStop(1, '#080507');
  g.fillStyle = grd;
  g.strokeStyle = '#050303';
  g.lineWidth = s * 0.025;
  g.beginPath();
  g.moveTo(0, -s * 0.34);
  g.bezierCurveTo(s * 0.27, -s * 0.25, s * 0.33, s * 0.08, s * 0.2, s * 0.34);
  g.lineTo(-s * 0.22, s * 0.34);
  g.bezierCurveTo(-s * 0.34, s * 0.05, -s * 0.25, -s * 0.25, 0, -s * 0.34);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = '#030204';
  g.beginPath();
  g.ellipse(0, -s * 0.12, s * 0.13, s * 0.16, 0, 0, TAU);
  g.fill();
  g.fillStyle = glow;
  g.shadowColor = glow;
  g.shadowBlur = s * 0.06;
  g.beginPath();
  g.ellipse(-s * 0.045, -s * 0.12, s * 0.018, s * 0.012, 0, 0, TAU);
  g.ellipse(s * 0.045, -s * 0.12, s * 0.018, s * 0.012, 0, 0, TAU);
  g.fill();
  g.restore();
}

function bladeGradient(g: CanvasRenderingContext2D, s: number, x0 = 0.2, y0 = 0.1, x1 = 0.82, y1 = 0.9) {
  const grd = g.createLinearGradient(s * x0, s * y0, s * x1, s * y1);
  grd.addColorStop(0, '#f7fbff');
  grd.addColorStop(0.22, '#9eb7c8');
  grd.addColorStop(0.5, '#f4ffff');
  grd.addColorStop(1, '#52606e');
  return grd;
}

function paintFireball(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#692100', '#170300', 11);
  g.save();
  g.translate(s * 0.61, s * 0.43);
  g.rotate(Math.PI * 0.72);
  for (let i = 0; i < 7; i++) {
    ellipseGlow(g, 0, s * (0.09 + i * 0.055), s * (0.24 - i * 0.022), s * (0.27 + i * 0.035), 0, `rgba(255,${75 + i * 23},0,${0.33 - i * 0.032})`);
  }
  g.restore();
  flameTongue(g, s, s * 0.44, s * 0.48, s * 0.18, -0.9, 'rgba(255,70,0,0.65)');
  glowBall(g, s * 0.62, s * 0.42, s * 0.29, [[0, '#fffde8'], [0.26, '#ffd452'], [0.58, '#ff6500'], [1, 'rgba(100,10,0,0)']]);
  glowBall(g, s * 0.55, s * 0.39, s * 0.1, [[0, '#ffffff'], [0.7, 'rgba(255,230,110,0.7)'], [1, 'rgba(255,150,0,0)']]);
}

function paintCloakFlames(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#532008', '#100302', 12);
  hoodedFigure(g, s, s * 0.5, s * 0.57, 0.88, '#351414', '#ff8030');
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = '#ffb030';
  g.shadowColor = '#ff4a00';
  g.shadowBlur = s * 0.12;
  g.lineWidth = s * 0.06;
  g.beginPath();
  g.ellipse(s * 0.5, s * 0.58, s * 0.36, s * 0.31, -0.15, 0.08, TAU * 0.9);
  g.stroke();
  for (let i = 0; i < 8; i++) flameTongue(g, s, s * (0.18 + i * 0.09), s * (0.74 - (i % 2) * 0.08), s * 0.075, (i - 3) * 0.25, 'rgba(255,145,0,0.65)');
  g.restore();
}

function paintLightning(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#153b96', '#020818', 13);
  for (let i = 0; i < 3; i++) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = `rgba(90,180,255,${0.25 - i * 0.05})`;
    g.lineWidth = s * (0.09 + i * 0.02);
    g.beginPath();
    g.moveTo(s * (0.16 + i * 0.06), s * 0.87);
    g.bezierCurveTo(s * 0.36, s * 0.52, s * 0.65, s * 0.66, s * (0.84 - i * 0.04), s * 0.13);
    g.stroke();
    g.restore();
  }
  const pts: [number, number][] = [[0.64, 0.04], [0.35, 0.43], [0.52, 0.45], [0.29, 0.95], [0.74, 0.37], [0.55, 0.38], [0.71, 0.04]].map(([x, y]) => [x * s, y * s]);
  poly(g, pts);
  g.shadowColor = '#a9e8ff';
  g.shadowBlur = s * 0.16;
  fillPath(g, '#edfaff', '#77c6ff', s * 0.02);
  g.shadowBlur = 0;
}

function paintHoming(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#28570d', '#030b02', 14);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(160,255,80,0.62)';
  g.shadowColor = '#9cff48';
  g.shadowBlur = s * 0.11;
  g.lineWidth = s * 0.065;
  g.beginPath();
  g.moveTo(s * 0.12, s * 0.84);
  g.bezierCurveTo(s * 0.12, s * 0.26, s * 0.61, s * 0.93, s * 0.67, s * 0.37);
  g.stroke();
  g.lineWidth = s * 0.025;
  g.beginPath();
  g.arc(s * 0.68, s * 0.34, s * 0.28, -0.3, TAU * 0.72);
  g.stroke();
  g.restore();
  glowBall(g, s * 0.69, s * 0.32, s * 0.25, [[0, '#ffffff'], [0.26, '#d8ff62'], [0.65, '#56c61b'], [1, 'rgba(15,80,0,0)']]);
  poly(g, [[s * 0.74, s * 0.16], [s * 0.88, s * 0.26], [s * 0.71, s * 0.28]]);
  fillPath(g, '#eaffb6', '#204608', s * 0.015);
}

function paintGlaive(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#5d4f2e', '#130904', 15);
  g.save();
  g.translate(s / 2, s / 2);
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(115,210,255,0.5)';
  g.lineWidth = s * 0.04;
  g.shadowColor = '#60d8ff';
  g.shadowBlur = s * 0.1;
  g.beginPath();
  g.arc(0, 0, s * 0.31, 0, TAU);
  g.stroke();
  for (let i = 0; i < 3; i++) {
    g.rotate(TAU / 3);
    const grd = g.createLinearGradient(-s * 0.06, -s * 0.43, s * 0.2, -s * 0.1);
    grd.addColorStop(0, '#f6fdff');
    grd.addColorStop(0.45, '#7eb4c8');
    grd.addColorStop(1, '#192a34');
    g.fillStyle = grd;
    g.strokeStyle = '#08141a';
    g.lineWidth = s * 0.018;
    g.beginPath();
    g.moveTo(0, -s * 0.09);
    g.quadraticCurveTo(s * 0.24, -s * 0.35, s * 0.06, -s * 0.46);
    g.quadraticCurveTo(-s * 0.07, -s * 0.26, -s * 0.05, -s * 0.09);
    g.closePath();
    g.fill();
    g.stroke();
  }
  g.restore();
  glowBall(g, s * 0.5, s * 0.5, s * 0.11, [[0, '#ffffff'], [0.55, '#7ee7ff'], [1, 'rgba(30,90,110,0)']]);
}

function paintMeteor(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#321342', '#050208', 16);
  g.save();
  g.translate(s * 0.6, s * 0.62);
  g.rotate(-Math.PI * 0.24);
  for (let i = 0; i < 6; i++) {
    ellipseGlow(g, 0, -s * (0.13 + i * 0.07), s * (0.2 - i * 0.023), s * (0.22 + i * 0.055), 0, `rgba(255,${95 + i * 23},15,${0.45 - i * 0.055})`);
  }
  g.restore();
  glowBall(g, s * 0.6, s * 0.63, s * 0.19, [[0, '#ffe8a0'], [0.38, '#a14d1a'], [0.75, '#4a2110'], [1, 'rgba(0,0,0,0)']]);
  for (let i = 0; i < 5; i++) star(g, s * (0.18 + i * 0.13), s * (0.17 + (i % 2) * 0.11), s * 0.025, '#ffb85a');
}

function paintSplitter(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#17415d', '#02060a', 17);
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 10; i++) {
    const a = (i * TAU) / 10 + 0.2;
    const r1 = s * 0.14;
    const r2 = s * (0.33 + (i % 3) * 0.035);
    poly(g, [[s * 0.5 + Math.cos(a - 0.12) * r1, s * 0.5 + Math.sin(a - 0.12) * r1], [s * 0.5 + Math.cos(a) * r2, s * 0.5 + Math.sin(a) * r2], [s * 0.5 + Math.cos(a + 0.12) * r1, s * 0.5 + Math.sin(a + 0.12) * r1]]);
    g.fillStyle = i % 2 ? 'rgba(160,255,255,0.72)' : 'rgba(80,180,255,0.62)';
    g.shadowColor = '#82f4ff';
    g.shadowBlur = s * 0.08;
    g.fill();
  }
  g.restore();
  glowBall(g, s * 0.5, s * 0.5, s * 0.22, [[0, '#ffffff'], [0.4, '#84fbff'], [0.8, '#2279c8'], [1, 'rgba(0,40,90,0)']]);
}

function paintWindWalk(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#315c5b', '#050b0b', 18);
  hoodedFigure(g, s, s * 0.52, s * 0.55, 0.78, 'rgba(90,150,150,0.45)', '#dffff8');
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const y = s * (0.22 + i * 0.17);
    g.beginPath();
    g.moveTo(s * 0.1, y);
    g.bezierCurveTo(s * 0.34, y - s * 0.14, s * 0.58, y + s * 0.12, s * (0.82 - i * 0.04), y - s * 0.02);
    strokePath(g, `rgba(225,255,248,${0.78 - i * 0.08})`, s * (0.045 - i * 0.004), s * 0.08, '#dffff8');
  }
  g.restore();
}

function paintTeleport(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#183f9b', '#02040e', 19);
  runeCircle(g, s, 0.5, 0.54, 0.34, '#93d9ff');
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.translate(s / 2, s / 2);
  g.shadowColor = '#9fd8ff';
  g.shadowBlur = s * 0.12;
  g.fillStyle = '#eefdff';
  for (let i = 0; i < 10; i++) {
    g.rotate(TAU / 10);
    poly(g, [[0, -s * 0.43], [s * 0.045, -s * 0.1], [0, -s * 0.01], [-s * 0.045, -s * 0.1]]);
    g.fill();
  }
  g.restore();
  glowBall(g, s / 2, s / 2, s * 0.14, [[0, '#fff'], [1, 'rgba(80,160,255,0)']]);
}

function paintThrust(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#672a0d', '#110401', 20);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,220,150,0.55)';
  g.lineWidth = s * 0.03;
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.moveTo(s * 0.08, s * (0.25 + i * 0.12));
    g.lineTo(s * (0.45 + i * 0.02), s * (0.25 + i * 0.12));
    g.stroke();
  }
  g.restore();
  const grd = g.createLinearGradient(s * 0.34, s * 0.25, s * 0.92, s * 0.75);
  grd.addColorStop(0, '#fff4ca');
  grd.addColorStop(0.45, '#f7b442');
  grd.addColorStop(1, '#7a2800');
  poly(g, [[s * 0.34, s * 0.36], [s * 0.66, s * 0.36], [s * 0.66, s * 0.2], [s * 0.93, s * 0.5], [s * 0.66, s * 0.8], [s * 0.66, s * 0.64], [s * 0.34, s * 0.64]]);
  g.shadowColor = '#ffd078';
  g.shadowBlur = s * 0.06;
  fillPath(g, grd, '#351300', s * 0.025);
  g.shadowBlur = 0;
}

function paintWand(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#085a62', '#010c0d', 21);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = '#aaffff';
  g.lineWidth = s * 0.045;
  g.shadowColor = '#4ff';
  g.shadowBlur = s * 0.1;
  g.beginPath();
  g.arc(s * 0.52, s * 0.45, s * 0.25, Math.PI * 0.2, Math.PI * 1.75);
  g.stroke();
  g.beginPath();
  g.arc(s * 0.52, s * 0.45, s * 0.13, Math.PI * 1.2, Math.PI * 0.7);
  g.stroke();
  g.restore();
  g.save();
  g.translate(s * 0.42, s * 0.68);
  g.rotate(-0.82);
  const grd = g.createLinearGradient(0, -s * 0.33, 0, s * 0.28);
  grd.addColorStop(0, '#f3ffff');
  grd.addColorStop(0.45, '#a06cff');
  grd.addColorStop(1, '#4b260e');
  g.fillStyle = grd;
  g.strokeStyle = '#120808';
  g.lineWidth = s * 0.022;
  g.fillRect(-s * 0.035, -s * 0.32, s * 0.07, s * 0.62);
  g.strokeRect(-s * 0.035, -s * 0.32, s * 0.07, s * 0.62);
  g.restore();
  glowBall(g, s * 0.66, s * 0.28, s * 0.12, [[0, '#fff'], [0.5, '#bfffff'], [1, 'rgba(80,255,255,0)']]);
}

function paintDrain(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#1e3d12', '#08020a', 22);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(130,255,70,0.68)';
  g.lineWidth = s * 0.04;
  g.shadowColor = '#78ff38';
  g.shadowBlur = s * 0.08;
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.moveTo(s * (0.22 + i * 0.05), s * 0.74);
    g.bezierCurveTo(s * 0.45, s * (0.48 - i * 0.08), s * 0.55, s * 0.43, s * 0.78, s * (0.2 + i * 0.12));
    g.stroke();
  }
  g.restore();
  g.fillStyle = '#b7d46a';
  g.strokeStyle = '#182204';
  g.lineWidth = s * 0.022;
  g.beginPath();
  g.moveTo(s * 0.23, s * 0.78);
  g.quadraticCurveTo(s * 0.18, s * 0.51, s * 0.36, s * 0.47);
  for (let i = 0; i < 5; i++) {
    g.lineTo(s * (0.35 + i * 0.06), s * (0.25 - (i % 2) * 0.05));
    g.lineTo(s * (0.38 + i * 0.06), s * 0.5);
  }
  g.quadraticCurveTo(s * 0.54, s * 0.68, s * 0.23, s * 0.78);
  g.fill();
  g.stroke();
  glowBall(g, s * 0.72, s * 0.32, s * 0.16, [[0, '#eaffc0'], [0.5, '#7fff40'], [1, 'rgba(95,0,120,0)']]);
}

function paintRainOfFire(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#3c163a', '#050208', 23);
  for (let i = 0; i < 6; i++) {
    const x = s * (0.18 + i * 0.13);
    const y = s * (0.18 + (i % 2) * 0.12);
    g.save();
    g.translate(x, y + s * 0.2);
    g.rotate(-0.7);
    ellipseGlow(g, 0, -s * 0.14, s * 0.07, s * 0.22, 0, 'rgba(255,80,0,0.52)');
    g.restore();
    glowBall(g, x + s * 0.08, y + s * 0.23, s * 0.07, [[0, '#fff5c0'], [0.5, '#ff9200'], [1, 'rgba(120,20,0,0)']]);
  }
  g.fillStyle = 'rgba(80,20,0,0.8)';
  g.fillRect(s * 0.12, s * 0.78, s * 0.76, s * 0.07);
}

function paintBanish(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#3d5010', '#060802', 24);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = '#d7ff6b';
  g.lineWidth = s * 0.035;
  g.shadowColor = '#bfff40';
  g.shadowBlur = s * 0.12;
  g.beginPath();
  g.ellipse(s * 0.5, s * 0.53, s * 0.35, s * 0.23, -0.45, 0, TAU);
  g.stroke();
  g.beginPath();
  g.ellipse(s * 0.5, s * 0.53, s * 0.23, s * 0.35, 0.7, 0, TAU);
  g.stroke();
  g.restore();
  hoodedFigure(g, s, s * 0.5, s * 0.58, 0.68, 'rgba(120,180,80,0.42)', '#efff9a');
  glowBall(g, s * 0.5, s * 0.5, s * 0.18, [[0, 'rgba(255,255,210,0.85)'], [0.5, 'rgba(180,255,70,0.55)'], [1, 'rgba(40,80,0,0)']]);
}

function paintShield(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#123f78', '#02060c', 25);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(120,220,255,0.5)';
  g.lineWidth = s * 0.035;
  g.beginPath();
  g.arc(s * 0.5, s * 0.5, s * 0.39, 0.3, Math.PI * 1.75);
  g.stroke();
  g.restore();
  const grd = g.createLinearGradient(0, s * 0.15, 0, s * 0.9);
  grd.addColorStop(0, '#ecfbff');
  grd.addColorStop(0.52, '#3887dd');
  grd.addColorStop(1, '#123f86');
  poly(g, [[s * 0.5, s * 0.1], [s * 0.82, s * 0.24], [s * 0.78, s * 0.64], [s * 0.5, s * 0.91], [s * 0.22, s * 0.64], [s * 0.18, s * 0.24]]);
  g.shadowColor = '#84dfff';
  g.shadowBlur = s * 0.08;
  fillPath(g, grd, '#f2d76c', s * 0.045);
  g.shadowBlur = 0;
}

function paintCrystalBall(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#25145e', '#04020a', 26);
  runeCircle(g, s, 0.5, 0.48, 0.27, '#b998ff');
  glowBall(g, s * 0.5, s * 0.42, s * 0.27, [[0, '#ffffff'], [0.25, '#bfffff'], [0.55, '#7b6cff'], [0.88, 'rgba(80,35,150,0.8)'], [1, 'rgba(0,0,0,0)']]);
  g.fillStyle = '#c89342';
  g.strokeStyle = '#331606';
  g.lineWidth = s * 0.025;
  g.beginPath();
  g.ellipse(s * 0.5, s * 0.76, s * 0.22, s * 0.07, 0, 0, TAU);
  g.fill();
  g.stroke();
  g.fillRect(s * 0.45, s * 0.6, s * 0.1, s * 0.17);
  star(g, s * 0.43, s * 0.34, s * 0.035, '#fff');
}

function paintMassTeleport(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#052b68', '#01030a', 27);
  runeCircle(g, s, 0.5, 0.62, 0.34, '#58caff');
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(130,230,255,0.72)';
  g.lineWidth = s * 0.055;
  g.shadowColor = '#7bdcff';
  g.shadowBlur = s * 0.12;
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.moveTo(s * (0.25 + i * 0.12), s * 0.78);
    g.lineTo(s * (0.38 + i * 0.04), s * 0.18);
    g.stroke();
  }
  g.restore();
  glowBall(g, s * 0.5, s * 0.58, s * 0.2, [[0, '#fff'], [0.45, '#62d8ff'], [1, 'rgba(0,70,160,0)']]);
}

function paintFreeze(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#0f4f72', '#02070b', 28);
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 5; i++) {
    const y = s * (0.28 + i * 0.1);
    g.beginPath();
    g.moveTo(s * 0.14, y);
    g.bezierCurveTo(s * 0.34, y - s * 0.14, s * 0.55, y + s * 0.1, s * 0.86, y - s * 0.04);
    strokePath(g, 'rgba(175,240,255,0.68)', s * 0.035, s * 0.08, '#a8f4ff');
  }
  g.restore();
  poly(g, [[s * 0.18, s * 0.57], [s * 0.42, s * 0.45], [s * 0.62, s * 0.56], [s * 0.43, s * 0.61]]);
  fillPath(g, '#e7fbff', '#4aaad0', s * 0.02);
  for (let i = 0; i < 6; i++) star(g, s * (0.28 + i * 0.1), s * (0.18 + (i % 3) * 0.2), s * 0.03, '#dffaff');
}

function paintStarfall(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#160a55', '#010108', 29);
  for (let i = 0; i < 7; i++) {
    const x = s * (0.18 + ((i * 19) % 63) / 100);
    const y = s * (0.14 + ((i * 31) % 65) / 100);
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgba(190,150,255,0.45)';
    g.lineWidth = s * 0.025;
    g.beginPath();
    g.moveTo(x - s * 0.14, y - s * 0.12);
    g.lineTo(x, y);
    g.stroke();
    g.restore();
    star(g, x, y, s * (0.035 + (i % 2) * 0.018), i % 2 ? '#ffd98a' : '#e6d7ff');
  }
  glowBall(g, s * 0.5, s * 0.62, s * 0.17, [[0, '#05010a'], [0.55, '#120024'], [1, 'rgba(190,100,255,0.7)']]);
  g.strokeStyle = '#b987ff';
  g.lineWidth = s * 0.025;
  g.beginPath();
  g.arc(s * 0.5, s * 0.62, s * 0.26, 0.1, TAU * 0.9);
  g.stroke();
}

function paintMoonLink(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#33394f', '#05060a', 30);
  crescent(g, s * 0.32, s * 0.31, s * 0.19, '#e8efff', '#171a2a', -0.25);
  crescent(g, s * 0.68, s * 0.68, s * 0.17, '#fff1b8', '#151208', Math.PI);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = '#d8e7ff';
  g.lineWidth = s * 0.055;
  g.shadowColor = '#9fc7ff';
  g.shadowBlur = s * 0.1;
  g.beginPath();
  g.moveTo(s * 0.34, s * 0.41);
  g.bezierCurveTo(s * 0.5, s * 0.38, s * 0.51, s * 0.62, s * 0.66, s * 0.58);
  g.stroke();
  g.restore();
}

function paintBoots(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#3b2212', '#080302', 31);
  const grd = g.createLinearGradient(s * 0.2, s * 0.2, s * 0.82, s * 0.8);
  grd.addColorStop(0, '#c89b54');
  grd.addColorStop(0.55, '#6a3718');
  grd.addColorStop(1, '#2b1008');
  for (const off of [0, 0.18]) {
    g.save();
    g.translate(s * off, s * (off ? -0.04 : 0.05));
    poly(g, [[s * 0.24, s * 0.25], [s * 0.47, s * 0.3], [s * 0.45, s * 0.58], [s * 0.68, s * 0.66], [s * 0.74, s * 0.78], [s * 0.45, s * 0.77], [s * 0.27, s * 0.61]]);
    g.shadowColor = '#ffce72';
    g.shadowBlur = s * 0.05;
    fillPath(g, grd, '#130704', s * 0.02);
    g.restore();
  }
  star(g, s * 0.19, s * 0.25, s * 0.035, '#ffd66c');
}

function paintPendant(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#33204a', '#06030b', 32);
  g.save();
  g.strokeStyle = '#d7b05b';
  g.lineWidth = s * 0.035;
  g.shadowColor = '#ffd97a';
  g.shadowBlur = s * 0.04;
  g.beginPath();
  g.arc(s * 0.5, s * 0.28, s * 0.25, Math.PI * 0.05, Math.PI * 0.95);
  g.stroke();
  g.restore();
  poly(g, [[s * 0.5, s * 0.32], [s * 0.7, s * 0.51], [s * 0.61, s * 0.78], [s * 0.39, s * 0.78], [s * 0.3, s * 0.51]]);
  const grd = g.createLinearGradient(s * 0.35, s * 0.36, s * 0.66, s * 0.78);
  grd.addColorStop(0, '#fff');
  grd.addColorStop(0.25, '#ff6eff');
  grd.addColorStop(0.6, '#822bc0');
  grd.addColorStop(1, '#270a4a');
  g.shadowColor = '#d35cff';
  g.shadowBlur = s * 0.11;
  fillPath(g, grd, '#d6b15c', s * 0.035);
  g.shadowBlur = 0;
}

function paintHelm(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#342045', '#070408', 33);
  g.save();
  g.translate(s * 0.52, s * 0.23);
  g.rotate(-0.2);
  for (let i = 0; i < 5; i++) {
    flameTongue(g, s, s * (0.02 * (i - 2)), s * (-0.02 * i), s * (0.08 + i * 0.01), i * 0.08, 'rgba(190,80,255,0.55)');
  }
  g.restore();
  const grd = g.createLinearGradient(s * 0.22, s * 0.25, s * 0.78, s * 0.8);
  grd.addColorStop(0, '#f5f0ff');
  grd.addColorStop(0.35, '#9a7dc0');
  grd.addColorStop(1, '#2e2538');
  g.beginPath();
  g.moveTo(s * 0.21, s * 0.55);
  g.quadraticCurveTo(s * 0.27, s * 0.22, s * 0.52, s * 0.19);
  g.quadraticCurveTo(s * 0.8, s * 0.26, s * 0.82, s * 0.6);
  g.lineTo(s * 0.68, s * 0.8);
  g.lineTo(s * 0.36, s * 0.8);
  g.closePath();
  fillPath(g, grd, '#180d20', s * 0.025);
  g.fillStyle = '#120914';
  g.fillRect(s * 0.36, s * 0.53, s * 0.32, s * 0.09);
}

function paintCloak(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#123b1b', '#030803', 34);
  const grd = g.createLinearGradient(s * 0.28, s * 0.12, s * 0.72, s * 0.9);
  grd.addColorStop(0, '#8fe078');
  grd.addColorStop(0.35, '#226b31');
  grd.addColorStop(1, '#0c1c11');
  g.beginPath();
  g.moveTo(s * 0.5, s * 0.12);
  g.bezierCurveTo(s * 0.2, s * 0.22, s * 0.14, s * 0.64, s * 0.21, s * 0.88);
  g.quadraticCurveTo(s * 0.5, s * 0.76, s * 0.79, s * 0.88);
  g.bezierCurveTo(s * 0.86, s * 0.55, s * 0.78, s * 0.22, s * 0.5, s * 0.12);
  fillPath(g, grd, '#061006', s * 0.025);
  g.strokeStyle = '#b7ff86';
  g.lineWidth = s * 0.02;
  g.beginPath();
  g.moveTo(s * 0.5, s * 0.18);
  g.bezierCurveTo(s * 0.43, s * 0.42, s * 0.44, s * 0.62, s * 0.36, s * 0.82);
  g.stroke();
}

function paintMask(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#2b2632', '#050405', 35);
  const grd = g.createLinearGradient(s * 0.2, s * 0.2, s * 0.8, s * 0.78);
  grd.addColorStop(0, '#d5d0c8');
  grd.addColorStop(0.5, '#6d6770');
  grd.addColorStop(1, '#1a171b');
  g.beginPath();
  g.moveTo(s * 0.5, s * 0.15);
  g.bezierCurveTo(s * 0.78, s * 0.2, s * 0.82, s * 0.58, s * 0.6, s * 0.84);
  g.lineTo(s * 0.5, s * 0.73);
  g.lineTo(s * 0.4, s * 0.84);
  g.bezierCurveTo(s * 0.18, s * 0.58, s * 0.22, s * 0.2, s * 0.5, s * 0.15);
  fillPath(g, grd, '#080608', s * 0.025);
  g.fillStyle = '#090505';
  g.beginPath();
  g.ellipse(s * 0.39, s * 0.44, s * 0.08, s * 0.06, -0.35, 0, TAU);
  g.ellipse(s * 0.61, s * 0.44, s * 0.08, s * 0.06, 0.35, 0, TAU);
  g.fill();
  g.fillStyle = '#e8e0d0';
  for (let i = 0; i < 4; i++) g.fillRect(s * (0.42 + i * 0.045), s * 0.64, s * 0.025, s * 0.1);
}

function paintStaff(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#3b2110', '#080302', 36);
  g.save();
  g.translate(s * 0.46, s * 0.58);
  g.rotate(0.55);
  const grd = g.createLinearGradient(0, -s * 0.42, 0, s * 0.36);
  grd.addColorStop(0, '#ffe4a0');
  grd.addColorStop(1, '#5a2a0c');
  g.fillStyle = grd;
  g.strokeStyle = '#170804';
  g.lineWidth = s * 0.025;
  g.fillRect(-s * 0.04, -s * 0.42, s * 0.08, s * 0.76);
  g.strokeRect(-s * 0.04, -s * 0.42, s * 0.08, s * 0.76);
  g.restore();
  glowBall(g, s * 0.3, s * 0.24, s * 0.18, [[0, '#ffffff'], [0.32, '#ffe260'], [0.7, '#ff7a20'], [1, 'rgba(160,20,0,0)']]);
  runeCircle(g, s, 0.3, 0.24, 0.14, '#ffd36a');
}

function paintRing(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#143914', '#020702', 37);
  g.save();
  g.shadowColor = '#ffdb6a';
  g.shadowBlur = s * 0.07;
  g.strokeStyle = '#e8bd48';
  g.lineWidth = s * 0.09;
  g.beginPath();
  g.ellipse(s * 0.5, s * 0.55, s * 0.25, s * 0.2, -0.2, 0, TAU);
  g.stroke();
  g.restore();
  poly(g, [[s * 0.5, s * 0.22], [s * 0.64, s * 0.36], [s * 0.56, s * 0.52], [s * 0.44, s * 0.52], [s * 0.36, s * 0.36]]);
  const grd = g.createLinearGradient(s * 0.38, s * 0.24, s * 0.62, s * 0.52);
  grd.addColorStop(0, '#edffd8');
  grd.addColorStop(0.45, '#3dff5c');
  grd.addColorStop(1, '#09591a');
  g.shadowColor = '#4dff70';
  g.shadowBlur = s * 0.12;
  fillPath(g, grd, '#f1c95e', s * 0.025);
  g.shadowBlur = 0;
}

function paintSword(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#56100d', '#080101', 38);
  g.save();
  g.translate(s * 0.52, s * 0.5);
  g.rotate(0.73);
  poly(g, [[0, -s * 0.43], [s * 0.075, s * 0.08], [0, s * 0.22], [-s * 0.075, s * 0.08]]);
  g.shadowColor = '#ff4040';
  g.shadowBlur = s * 0.08;
  fillPath(g, bladeGradient(g, s, 0.42, 0.06, 0.58, 0.82), '#210303', s * 0.02);
  g.fillStyle = '#d2a046';
  g.fillRect(-s * 0.18, s * 0.18, s * 0.36, s * 0.06);
  g.fillStyle = '#4a180a';
  g.fillRect(-s * 0.035, s * 0.2, s * 0.07, s * 0.22);
  g.restore();
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,30,30,0.65)';
  g.lineWidth = s * 0.045;
  g.beginPath();
  g.moveTo(s * 0.18, s * 0.2);
  g.bezierCurveTo(s * 0.36, s * 0.6, s * 0.67, s * 0.45, s * 0.84, s * 0.82);
  g.stroke();
  g.restore();
}

function paintAegis(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#49380c', '#080501', 39);
  const grd = g.createLinearGradient(0, s * 0.12, 0, s * 0.92);
  grd.addColorStop(0, '#fff0a0');
  grd.addColorStop(0.42, '#c07720');
  grd.addColorStop(1, '#4a1f0b');
  poly(g, [[s * 0.5, s * 0.11], [s * 0.83, s * 0.26], [s * 0.76, s * 0.66], [s * 0.5, s * 0.9], [s * 0.24, s * 0.66], [s * 0.17, s * 0.26]]);
  g.shadowColor = '#ffd76a';
  g.shadowBlur = s * 0.08;
  fillPath(g, grd, '#ffe38a', s * 0.045);
  g.shadowBlur = 0;
  g.strokeStyle = '#fff1a6';
  g.lineWidth = s * 0.035;
  g.beginPath();
  g.moveTo(s * 0.5, s * 0.2);
  g.lineTo(s * 0.5, s * 0.76);
  g.moveTo(s * 0.28, s * 0.34);
  g.lineTo(s * 0.72, s * 0.34);
  g.stroke();
}

function paintPackBeast(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#45331d', '#080503', 40);
  const body = g.createLinearGradient(s * 0.16, s * 0.35, s * 0.82, s * 0.75);
  body.addColorStop(0, '#a8743a');
  body.addColorStop(1, '#3c2010');
  g.beginPath();
  g.ellipse(s * 0.48, s * 0.58, s * 0.31, s * 0.2, 0.02, 0, TAU);
  fillPath(g, body, '#150904', s * 0.025);
  g.beginPath();
  g.ellipse(s * 0.74, s * 0.43, s * 0.15, s * 0.13, 0.3, 0, TAU);
  fillPath(g, body, '#150904', s * 0.02);
  g.fillStyle = '#314b23';
  g.strokeStyle = '#0b1408';
  for (const x of [0.33, 0.52]) {
    g.fillRect(s * x, s * 0.32, s * 0.17, s * 0.25);
    g.strokeRect(s * x, s * 0.32, s * 0.17, s * 0.25);
  }
  g.strokeStyle = '#dbc06a';
  g.lineWidth = s * 0.025;
  g.beginPath();
  g.moveTo(s * 0.8, s * 0.35);
  g.quadraticCurveTo(s * 0.94, s * 0.2, s * 0.88, s * 0.52);
  g.stroke();
}

function passiveOverlay(g: CanvasRenderingContext2D, s: number) {
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(120,90,35,0.55)';
  g.lineWidth = Math.max(1, s * 0.035);
  g.strokeRect(s * 0.06, s * 0.06, s * 0.88, s * 0.88);
}

function paintTrueShot(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#17364a', '#020608', 41);
  runeCircle(g, s, 0.56, 0.5, 0.25, '#ffdb66');
  g.save();
  g.translate(s * 0.46, s * 0.52);
  g.rotate(-0.7);
  g.fillStyle = '#d9a64a';
  g.strokeStyle = '#110904';
  g.lineWidth = s * 0.02;
  g.fillRect(-s * 0.35, -s * 0.025, s * 0.58, s * 0.05);
  g.strokeRect(-s * 0.35, -s * 0.025, s * 0.58, s * 0.05);
  poly(g, [[s * 0.23, 0], [s * 0.04, -s * 0.11], [s * 0.07, 0], [s * 0.04, s * 0.11]]);
  fillPath(g, '#f5f3d0', '#110904', s * 0.014);
  g.restore();
  passiveOverlay(g, s);
}

function paintMagicImmunity(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#50200d', '#080202', 42);
  hoodedFigure(g, s, s * 0.5, s * 0.58, 0.76, '#5a2414', '#ffd257');
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = '#ffd257';
  g.lineWidth = s * 0.045;
  g.shadowColor = '#ff5a20';
  g.shadowBlur = s * 0.1;
  g.beginPath();
  g.arc(s * 0.5, s * 0.52, s * 0.35, 0, TAU);
  g.stroke();
  g.strokeStyle = 'rgba(255,40,40,0.65)';
  g.beginPath();
  g.arc(s * 0.5, s * 0.52, s * 0.25, Math.PI * 0.35, Math.PI * 1.72);
  g.stroke();
  g.restore();
  passiveOverlay(g, s);
}

function paintScatterRockets(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#3f2916', '#070302', 43);
  for (let i = 0; i < 4; i++) {
    const x = s * (0.2 + i * 0.16);
    const y = s * (0.25 + (i % 2) * 0.2);
    g.save();
    g.translate(x, y);
    g.rotate(-0.5 + i * 0.35);
    g.fillStyle = '#d8d0b0';
    g.strokeStyle = '#1a0b05';
    g.lineWidth = s * 0.014;
    g.fillRect(-s * 0.025, -s * 0.12, s * 0.05, s * 0.22);
    g.strokeRect(-s * 0.025, -s * 0.12, s * 0.05, s * 0.22);
    poly(g, [[0, -s * 0.18], [s * 0.06, -s * 0.1], [-s * 0.06, -s * 0.1]]);
    fillPath(g, '#c43a24', '#1a0b05', s * 0.012);
    g.restore();
    glowBall(g, x - s * 0.04, y + s * 0.12, s * 0.07, [[0, '#fff4a0'], [0.45, '#ff7a00'], [1, 'rgba(120,20,0,0)']]);
  }
  glowBall(g, s * 0.7, s * 0.72, s * 0.15, [[0, '#fff3a0'], [0.45, '#ff8a00'], [1, 'rgba(150,20,0,0)']]);
  passiveOverlay(g, s);
}

function paintAcolyte(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#231035', '#050207', 44);
  hoodedFigure(g, s, s * 0.5, s * 0.57, 0.95, '#322042', '#b676ff');
  glowBall(g, s * 0.5, s * 0.56, s * 0.12, [[0, 'rgba(230,180,255,0.55)'], [1, 'rgba(60,0,100,0)']]);
}

function paintNecromancer(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#152035', '#030408', 45);
  hoodedFigure(g, s, s * 0.5, s * 0.58, 0.92, '#18233f', '#65dfff');
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = '#7ce8ff';
  g.lineWidth = s * 0.035;
  g.beginPath();
  g.moveTo(s * 0.18, s * 0.78);
  g.bezierCurveTo(s * 0.34, s * 0.54, s * 0.62, s * 0.54, s * 0.82, s * 0.24);
  g.stroke();
  g.restore();
}

function paintTome(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#473115', '#080402', 46);
  g.save();
  g.translate(s * 0.5, s * 0.53);
  g.rotate(-0.12);
  const grd = g.createLinearGradient(-s * 0.28, -s * 0.25, s * 0.28, s * 0.28);
  grd.addColorStop(0, '#b7382a');
  grd.addColorStop(0.55, '#6e1e22');
  grd.addColorStop(1, '#2c1016');
  g.fillStyle = grd;
  g.strokeStyle = '#1b0805';
  g.lineWidth = s * 0.025;
  g.fillRect(-s * 0.3, -s * 0.25, s * 0.6, s * 0.5);
  g.strokeRect(-s * 0.3, -s * 0.25, s * 0.6, s * 0.5);
  g.strokeStyle = '#e0b956';
  g.lineWidth = s * 0.025;
  g.strokeRect(-s * 0.21, -s * 0.16, s * 0.42, s * 0.32);
  star(g, 0, 0, s * 0.055, '#ffd65c');
  g.restore();
}

function paintDust(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#473311', '#080502', 47);
  const grd = g.createLinearGradient(s * 0.25, s * 0.28, s * 0.72, s * 0.86);
  grd.addColorStop(0, '#c89652');
  grd.addColorStop(1, '#4a260d');
  g.beginPath();
  g.moveTo(s * 0.36, s * 0.28);
  g.quadraticCurveTo(s * 0.49, s * 0.38, s * 0.64, s * 0.28);
  g.lineTo(s * 0.76, s * 0.78);
  g.quadraticCurveTo(s * 0.5, s * 0.93, s * 0.24, s * 0.78);
  g.closePath();
  fillPath(g, grd, '#170904', s * 0.025);
  g.strokeStyle = '#e5c36c';
  g.lineWidth = s * 0.035;
  g.beginPath();
  g.moveTo(s * 0.33, s * 0.35);
  g.quadraticCurveTo(s * 0.5, s * 0.43, s * 0.67, s * 0.35);
  g.stroke();
  for (let i = 0; i < 7; i++) star(g, s * (0.22 + ((i * 17) % 57) / 100), s * (0.13 + ((i * 29) % 35) / 100), s * 0.025, '#ffe58a');
}

function paintFlag(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#17324d', '#020508', 48);
  g.strokeStyle = '#d0a65c';
  g.lineWidth = s * 0.05;
  g.beginPath();
  g.moveTo(s * 0.32, s * 0.18);
  g.lineTo(s * 0.32, s * 0.88);
  g.stroke();
  const grd = g.createLinearGradient(s * 0.34, s * 0.22, s * 0.82, s * 0.55);
  grd.addColorStop(0, '#f4e6b0');
  grd.addColorStop(0.45, '#ca2f24');
  grd.addColorStop(1, '#65120e');
  g.beginPath();
  g.moveTo(s * 0.34, s * 0.2);
  g.bezierCurveTo(s * 0.54, s * 0.12, s * 0.64, s * 0.36, s * 0.84, s * 0.27);
  g.lineTo(s * 0.76, s * 0.56);
  g.bezierCurveTo(s * 0.6, s * 0.63, s * 0.49, s * 0.42, s * 0.34, s * 0.5);
  g.closePath();
  fillPath(g, grd, '#210807', s * 0.02);
}

function paintHire(g: CanvasRenderingContext2D, s: number) {
  bg(g, s, '#4a3513', '#080502', 49);
  g.save();
  g.translate(s * 0.55, s * 0.56);
  g.rotate(-0.17);
  g.fillStyle = '#e6d6a7';
  g.strokeStyle = '#2a1506';
  g.lineWidth = s * 0.025;
  g.fillRect(-s * 0.25, -s * 0.24, s * 0.46, s * 0.48);
  g.strokeRect(-s * 0.25, -s * 0.24, s * 0.46, s * 0.48);
  g.strokeStyle = '#734322';
  g.lineWidth = s * 0.018;
  for (let i = 0; i < 4; i++) {
    g.beginPath();
    g.moveTo(-s * 0.17, -s * (0.12 - i * 0.08));
    g.lineTo(s * 0.12, -s * (0.12 - i * 0.08));
    g.stroke();
  }
  g.restore();
  glowBall(g, s * 0.28, s * 0.35, s * 0.16, [[0, '#fff4a0'], [0.5, '#e0a820'], [0.9, '#744600'], [1, 'rgba(0,0,0,0)']]);
  g.fillStyle = '#6a4100';
  g.font = `bold ${Math.floor(s * 0.18)}px serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('$', s * 0.28, s * 0.35);
}

const PAINTERS: Record<string, IconPainter> = {
  [`${BTN}btnfirebolt.blp`]: paintFireball,
  [`${BTN}btncloakofflames.blp`]: paintCloakFlames,
  [`${BTN}btnchainlightning.blp`]: paintLightning,
  [`${BTN}btnmanaflare.blp`]: paintHoming,
  [`${BTN}btnupgrademoonglaive.blp`]: paintGlaive,
  [`${BTN}btnfire.blp`]: paintMeteor,
  [`${BTN}btnwispsplode.blp`]: paintSplitter,
  [`${BTN}btnwindwalkon.blp`]: paintWindWalk,
  [`${BTN}btnunsummonbuilding.blp`]: paintTeleport,
  [`${BTN}btninvisibility.blp`]: paintThrust,
  [`${BTN}btnwandofneutralization.blp`]: paintWand,
  [`${BTN}btncripple.blp`]: paintDrain,
  [`${BTN}btnspell_shadow_rainoffire.blp`]: paintRainOfFire,
  [`${BTN}btnbanish.blp`]: paintBanish,
  [`${BTN}btnneutralmanashield.blp`]: paintShield,
  [`${BTN}btncrystalball.blp`]: paintCrystalBall,
  [`${BTN}btnmassteleport.blp`]: paintMassTeleport,
  [`${BTN}btnbreathoffrost.blp`]: paintFreeze,
  [`${BTN}btnstarfall.blp`]: paintStarfall,
  [`${BTN}btnadvancedstrengthofthemoon.blp`]: paintMoonLink,

  [`${BTN}btnslippersofagility.blp`]: paintBoots,
  [`${BTN}btn3m1.blp`]: paintPendant,
  [`${BTN}btnhelmutpurple.blp`]: paintHelm,
  [`${BTN}btncloak.blp`]: paintCloak,
  [`${BTN}btnmaskofdeath.blp`]: paintMask,
  [`${BTN}btnstaffofsanctuary.blp`]: paintStaff,
  [`${BTN}btnringgreen.blp`]: paintRing,
  [`${BTN}btnthoriummelee.blp`]: paintSword,
  [`${BTN}btnhumanarmorupthree.blp`]: paintAegis,

  [`${BTN}btnpackbeast.blp`]: paintPackBeast,
  [`${PAS}pasbtntrueshot.blp`]: paintTrueShot,
  [`${PAS}pasbtnmagicimmunity.blp`]: paintMagicImmunity,
  [`${PAS}pasbtnscatterrockets.blp`]: paintScatterRockets,

  [`${BTN}btnacolyte.blp`]: paintAcolyte,
  [`${BTN}btnnecromanceradept.blp`]: paintNecromancer,
  [`${BTN}btntomeofretraining.blp`]: paintTome,
  [`${BTN}btndust.blp`]: paintDust,

  [`${BTN}btnhumancaptureflag.blp`]: paintFlag,
  [`${BTN}btnhire.blp`]: paintHire,
};

export function paintOpenIcon(path: string, g: CanvasRenderingContext2D, size: number): boolean {
  const paint = PAINTERS[norm(path)];
  if (!paint) return false;
  g.save();
  paint(g, size);
  g.restore();
  return true;
}
