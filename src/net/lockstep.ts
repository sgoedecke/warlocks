import { ALL_SPELLS, ITEMS, type ProductId, type SpellId } from '../config';
import type { Command } from '../sim/types';

/** Commands are gathered into turns of this many sim ticks (2 × 30 ms), as WC3 batched orders. */
export const TURN_TICKS = 2;
/** Every this many ticks, clients report a state hash so the host can spot desyncs. */
export const HASH_EVERY = 64;
/** Clients try to keep this many received-but-unplayed ticks queued to absorb network jitter. */
export const BUFFER_TICKS = TURN_TICKS + 1;

const PRODUCTS = new Set<string>([...ALL_SPELLS, 'rangeMastery', 'aoeMastery', 'lifestealMastery', 'inventory', ...Object.keys(ITEMS)]);
const SPELLS = new Set<string>(ALL_SPELLS);

const coord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e5;

/**
 * Validates a command from the network and stamps it with the sender's player id, so a peer
 * can neither act for someone else nor crash every client with a malformed order.
 */
export function sanitizeCommand(raw: unknown, pid: number): Command | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case 'move': return coord(r.x) && coord(r.y) ? { pid, type: 'move', x: r.x, y: r.y } : null;
    case 'stop': return { pid, type: 'stop' };
    case 'ready': return { pid, type: 'ready' };
    case 'cast': return typeof r.spell === 'string' && SPELLS.has(r.spell) && coord(r.x) && coord(r.y) ? { pid, type: 'cast', spell: r.spell as SpellId, x: r.x, y: r.y } : null;
    case 'buy': return typeof r.product === 'string' && PRODUCTS.has(r.product) ? { pid, type: 'buy', product: r.product as ProductId } : null;
    case 'sell': return Number.isInteger(r.slot) && (r.slot as number) >= 0 && (r.slot as number) < 6 ? { pid, type: 'sell', slot: r.slot as number } : null;
    case 'toggle': return r.spell === 'firespray' || r.spell === 'splitter' ? { pid, type: 'toggle', spell: r.spell } : null;
    default: return null;
  }
}

/** 32-bit FNV-1a, enough to compare sim states between peers. */
export function hashString(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface LockstepTransport {
  /** Host: send a closed turn to every client. */
  broadcastTurn(turn: number, cmds: Command[]): void;
  /** Client: send a local order to the host. */
  sendCommand(cmd: Command): void;
  /** Client: report a state hash to the host. */
  sendHash(tick: number, hash: number): void;
}

/**
 * WC3-style lockstep with the host as the clock. Clients send orders to the host; at each turn
 * boundary the host bundles everything it has received into that turn, broadcasts it and plays it
 * straight away. Clients play a turn only once it has arrived, so every peer applies identical
 * commands on identical ticks and the deterministic sim stays in step. The host never waits.
 */
export class Lockstep {
  private turns = new Map<number, Command[]>();
  private inbox: Command[] = [];
  /** Highest turn received (clients) or closed (host). */
  private lastTurn = -1;
  private hostHashes = new Map<number, number>();
  private earlyHashes: { pid: number; tick: number; hash: number }[] = [];
  onDesync: ((pid: number) => void) | null = null;

  /** `startTick`: the sim tick this peer starts on, which is later than 0 when joining a game in progress. */
  constructor(readonly isHost: boolean, readonly localId: number, private transport: LockstepTransport, startTick = 0) {
    this.lastTurn = Math.ceil(startTick / TURN_TICKS) - 1;
  }

  /** Queue an order from the local player. */
  submit(cmd: Command) {
    if (this.isHost) this.inbox.push(cmd);
    else this.transport.sendCommand(cmd);
  }

  /** Host: an order (already sanitised) from a client, or a leave injected by the host. */
  receive(cmd: Command) {
    if (this.isHost) this.inbox.push(cmd);
  }

  /** Client: a turn from the host. */
  receiveTurn(turn: number, cmds: Command[]) {
    if (this.isHost || turn <= this.lastTurn) return;
    this.turns.set(turn, cmds);
    while (this.turns.has(this.lastTurn + 1)) this.lastTurn++;
  }

  /** How many ticks starting at `tick` can be played now. */
  available(tick: number) {
    return this.isHost ? Infinity : (this.lastTurn + 1) * TURN_TICKS - tick;
  }

  /** Commands to apply on `tick`. Clients may only call this while available(tick) > 0. */
  commandsFor(tick: number): Command[] {
    if (tick % TURN_TICKS !== 0) return [];
    const turn = tick / TURN_TICKS;
    if (this.isHost) {
      const cmds = this.inbox;
      this.inbox = [];
      this.lastTurn = turn;
      this.transport.broadcastTurn(turn, cmds);
      return cmds;
    }
    const cmds = this.turns.get(turn) ?? [];
    this.turns.delete(turn);
    return cmds;
  }

  /** Record the local state hash after `tick`. */
  hash(tick: number, hash: number) {
    if (!this.isHost) {
      this.transport.sendHash(tick, hash);
      return;
    }
    this.hostHashes.set(tick, hash);
    this.hostHashes.delete(tick - HASH_EVERY * 64);
    this.earlyHashes = this.earlyHashes.filter((c) => !this.check(c.pid, c.tick, c.hash));
  }

  /** Host: a client's hash report. Clients run behind the host, but one may report first after a host stall. */
  receiveHash(pid: number, tick: number, hash: number) {
    if (!this.check(pid, tick, hash) && this.earlyHashes.length < 64) this.earlyHashes.push({ pid, tick, hash });
  }

  private check(pid: number, tick: number, hash: number) {
    const mine = this.hostHashes.get(tick);
    if (mine === undefined) return false;
    if (mine !== hash) this.onDesync?.(pid);
    return true;
  }
}
