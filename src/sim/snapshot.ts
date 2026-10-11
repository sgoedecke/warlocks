/**
 * JSON that round-trips every number the sim can hold. Plain JSON turns -0 into 0 (which flips the
 * sign of atan2 on the negative x-axis) and NaN/Infinity into null, either of which would desync a
 * restored game.
 */
export function encodeState(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'number' && (!Number.isFinite(x) || Object.is(x, -0)) ? { '~': String(x) } : x));
}

export function decodeState<T>(s: string): T {
  return JSON.parse(s, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) && typeof x['~'] === 'string' && Object.keys(x).length === 1 ? Number(x['~']) : x)) as T;
}
