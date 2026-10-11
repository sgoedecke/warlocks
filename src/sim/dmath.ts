// Deterministic transcendental functions for the lockstep sim.
// ECMAScript leaves Math.sin/cos/atan2/hypot implementation-defined, so
// browsers can disagree in the last bit and desync multiplayer games. These
// use only + - * / and sqrt (IEEE correctly rounded everywhere), following
// the fdlibm kernels.

const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_1T = 6.07710050650619224932e-11;
const INV_PIO2 = 6.36619772367581382433e-01;

const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

function ksin(x: number) {
  const z = x * x;
  return x + z * x * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}
function kcos(x: number) {
  const z = x * x;
  return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

function reduce(x: number): [number, number] {
  const n = Math.round(x * INV_PIO2);
  return [(x - n * PIO2_1) - n * PIO2_1T, ((n % 4) + 4) % 4];
}

export function dsin(x: number) {
  const [r, q] = reduce(x);
  return q === 0 ? ksin(r) : q === 1 ? kcos(r) : q === 2 ? -ksin(r) : -kcos(r);
}

export function dcos(x: number) {
  const [r, q] = reduce(x);
  return q === 0 ? kcos(r) : q === 1 ? -ksin(r) : q === 2 ? -kcos(r) : ksin(r);
}

const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
  3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
  9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
  4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02,
];

export function datan(v: number) {
  if (v !== v) return v;
  const neg = v < 0;
  let x = neg ? -v : v;
  let id = -1;
  if (x >= 7.378697629483821e19) return neg ? -1.5707963267948966 : 1.5707963267948966;
  if (x < 0.4375) {
    if (x < 3.725290298461914e-9) return v;
  } else if (x < 1.1875) {
    if (x < 0.6875) { id = 0; x = (2 * x - 1) / (2 + x); } else { id = 1; x = (x - 1) / (x + 1); }
  } else if (x < 2.4375) { id = 2; x = (x - 1.5) / (1 + 1.5 * x); } else { id = 3; x = -1 / x; }
  const z = x * x, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return neg ? -(x - x * (s1 + s2)) : x - x * (s1 + s2);
  const r = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
  return neg ? -r : r;
}

export function datan2(y: number, x: number) {
  if (x !== x || y !== y) return NaN;
  if (x === 0) return y > 0 ? Math.PI / 2 : y < 0 ? -Math.PI / 2 : (Object.is(x, -0) ? (Object.is(y, -0) ? -Math.PI : Math.PI) : y);
  const a = datan(y / x);
  if (x > 0) return a;
  return y < 0 || Object.is(y, -0) ? a - Math.PI : a + Math.PI;
}

export function dhypot(x: number, y: number) {
  return Math.sqrt(x * x + y * y);
}
