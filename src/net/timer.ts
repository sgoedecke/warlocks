/**
 * Calls `fn` every `ms` from a dedicated worker. Page timers in hidden tabs are throttled to once a
 * second (and later once a minute), which would stall a lockstep game; worker timers aren't.
 */
export function workerInterval(ms: number, fn: () => void) {
  const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  w.onmessage = fn;
  return () => w.terminate();
}
