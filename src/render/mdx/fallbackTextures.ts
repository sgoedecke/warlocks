import * as THREE from 'three';
import { openTextureCanvas } from '../opentex/particles';

const cache = new Map<string, THREE.Texture>();

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function putRadial(g: CanvasRenderingContext2D, x: number, y: number, r: number, stops: [number, string][]): void {
  const grd = g.createRadialGradient(x, y, 0, x, y, r);
  for (const [p, c] of stops) grd.addColorStop(p, c);
  g.fillStyle = grd;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

export function canvasTexture(canvas: HTMLCanvasElement, name: string, repeat = true): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = name;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function drawPuff(g: CanvasRenderingContext2D, x: number, y: number, s: number, fire: boolean, dust = false): void {
  const hot = fire ? 'rgba(255,240,120,0.95)' : dust ? 'rgba(210,170,120,0.75)' : 'rgba(210,210,220,0.72)';
  const mid = fire ? 'rgba(255,95,0,0.55)' : dust ? 'rgba(120,90,55,0.35)' : 'rgba(110,110,120,0.38)';
  const out = fire ? 'rgba(70,8,0,0)' : 'rgba(50,50,55,0)';
  putRadial(g, x, y, s * 0.48, [[0, hot], [0.28, mid], [1, out]]);
  for (let i = 0; i < 10; i++) {
    const a = hash(i, 2, x + y) * Math.PI * 2;
    const rr = s * (0.08 + hash(i, 4, x) * 0.25);
    const d = s * hash(i, 7, y) * 0.25;
    putRadial(g, x + Math.cos(a) * d, y + Math.sin(a) * d, rr, [[0, mid], [1, 'rgba(0,0,0,0)']]);
  }
}

function cloudAtlas(rows: number, columns: number, fire: boolean, dust = false): HTMLCanvasElement {
  const cell = 64;
  const c = makeCanvas(columns * cell, rows * cell);
  const g = c.getContext('2d')!;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < columns; col++) {
      const x = col * cell + cell / 2;
      const y = r * cell + cell / 2;
      g.save();
      g.globalAlpha = 0.85 - ((r * columns + col) / Math.max(1, rows * columns - 1)) * 0.35;
      drawPuff(g, x, y, cell, fire, dust);
      g.restore();
    }
  }
  return c;
}

function glow(color: string, star = false): HTMLCanvasElement {
  const s = 128;
  const c = makeCanvas(s, s);
  const g = c.getContext('2d')!;
  putRadial(g, s / 2, s / 2, s / 2, [[0, 'rgba(255,255,255,0.72)'], [0.22, color], [0.72, color.replace(/, ?[^,]+\)$/, ',0.12)')], [1, 'rgba(0,0,0,0)']]);
  if (star) {
    g.strokeStyle = color;
    g.globalAlpha = 0.38;
    g.lineWidth = 2;
    g.shadowColor = color;
    g.shadowBlur = 6;
    for (let i = 0; i < 4; i++) {
      g.save();
      g.translate(s / 2, s / 2);
      g.rotate((i * Math.PI) / 4);
      g.beginPath();
      g.moveTo(-s * 0.32, 0);
      g.lineTo(s * 0.32, 0);
      g.stroke();
      g.restore();
    }
    g.globalAlpha = 1;
  }
  return c;
}

function ring(color: string): HTMLCanvasElement {
  const s = 128;
  const c = makeCanvas(s, s);
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.62, color);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return c;
}

function unitTexture(path: string): HTMLCanvasElement {
  const s = 256;
  const c = makeCanvas(s, s);
  const g = c.getContext('2d')!;
  const p = path.toLowerCase();
  const base = p.includes('blood') || p.includes('medivh') || p.includes('spellthief') ? ['#210817', '#7b1420', '#c9973a']
    : p.includes('frost') || p.includes('metal') || p.includes('armor') || p.includes('handle') ? ['#41444d', '#9a9ca2', '#b78334']
      : p.includes('azshara') ? ['#2b4752', '#8ba7a8', '#b8874d']
        : ['#2d2438', '#7f6f92', '#c8b077'];
  const grd = g.createLinearGradient(0, 0, s, s);
  grd.addColorStop(0, base[0]);
  grd.addColorStop(0.55, base[1]);
  grd.addColorStop(1, base[0]);
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const img = g.getImageData(0, 0, s, s);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const n = (hash(x >> 2, y >> 2, 5) - 0.5) * 22;
      img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
      img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
      img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
    }
  g.putImageData(img, 0, 0);
  g.strokeStyle = base[2];
  g.lineWidth = 3;
  g.globalAlpha = 0.55;
  for (let x = 18; x < s; x += 72) {
    g.beginPath();
    g.moveTo(x, 0);
    g.bezierCurveTo(x - 18, s * 0.32, x + 24, s * 0.68, x - 8, s);
    g.stroke();
  }
  g.globalAlpha = 1;
  if (p.includes('hero') || p.includes('medivh') || p.includes('bloodpriest')) {
    g.fillStyle = 'rgba(235,205,185,0.35)';
    g.beginPath();
    g.ellipse(s * 0.18, s * 0.18, s * 0.055, s * 0.075, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(215,215,225,0.28)';
    g.beginPath();
    g.ellipse(s * 0.78, s * 0.22, s * 0.05, s * 0.16, 0, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

function proceduralCanvas(path: string, rows: number, columns: number): HTMLCanvasElement {
  const p = path.toLowerCase();
  if (p.includes('black32')) {
    const c = makeCanvas(32, 32);
    c.getContext('2d')!.fillRect(0, 0, 32, 32);
    return c;
  }
  if (p.includes('splat') || p.includes('ubersplat')) return ring('rgba(120,210,255,0.45)');
  if (p.includes('clouds8x8fire') || p.includes('flame')) return cloudAtlas(rows || 8, columns || 8, true);
  if (p.includes('clouds8x8') || p.includes('clouds32') || p.includes('dust')) return cloudAtlas(rows || (p.includes('dust') ? 4 : 8), columns || (p.includes('dust') ? 4 : 8), false, p.includes('dust'));
  if (p.includes('shockwave')) return ring(p.includes('blue') || p.includes('ice') ? 'rgba(80,170,255,0.72)' : 'rgba(255,220,120,0.72)');
  if (p.includes('lightning') || p.includes('zap')) return glow('rgba(90,180,255,0.75)', true);
  if (p.includes('frost') || p.includes('blue_glow') || p.includes('ribbonne1_blue')) return glow('rgba(90,190,255,0.72)', true);
  if (p.includes('water')) return glow('rgba(110,150,255,0.55)');
  if (p.includes('green_glow')) return glow('rgba(80,255,120,0.7)');
  if (p.includes('eyes')) return glow('rgba(140,255,140,0.8)');
  if (p.includes('glow') || p.includes('flare') || p.includes('star') || p.includes('yellow_star')) return glow(p.includes('yellow') ? 'rgba(255,220,80,0.75)' : 'rgba(255,255,255,0.72)', true);
  if (p.includes('tornado') || p.includes('foam')) return cloudAtlas(rows || 4, columns || 4, false);
  return unitTexture(path);
}

export function getFallbackTexture(path: string, rows = 1, columns = 1): THREE.Texture {
  const key = `${path.toLowerCase()}|${rows}|${columns}`;
  let tex = cache.get(key);
  if (!tex) {
    tex = canvasTexture(openTextureCanvas(path, rows, columns) ?? proceduralCanvas(path, rows, columns), `fallback:${path}`);
    cache.set(key, tex);
  }
  return tex;
}

export function makeTeamColorTexture(color: THREE.Color, glow = false): THREE.Texture {
  const s = 64;
  const c = makeCanvas(s, s);
  const g = c.getContext('2d')!;
  if (glow) {
    const css = `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},0.32)`;
    putRadial(g, s / 2, s / 2, s / 2, [[0, 'rgba(255,255,255,0.42)'], [0.35, css], [1, 'rgba(0,0,0,0)']]);
  } else {
    g.fillStyle = `rgb(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)})`;
    g.fillRect(0, 0, s, s);
  }
  return canvasTexture(c, glow ? 'team-glow' : 'team-color');
}
