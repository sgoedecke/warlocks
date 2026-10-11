import { joinRoom, selfId, type JsonValue, type Room, type TurnServerConfig } from 'trystero/nostr';
import { BOT_NAMES, PLAYER_COLORS } from '../config';
import type { Difficulty } from '../ai/bot';
import type { Command, PlayerSetup, SimRules } from '../sim/types';
import { Lockstep, sanitizeCommand } from './lockstep';
import { workerInterval } from './timer';

const APP_ID = 'warlocks-088b-browser';
/** Bumped whenever the sim or protocol changes in a way that would desync older builds. */
export const PROTOCOL_VERSION = 1;
export const MAX_PLAYERS = 10;
const CONNECT_TIMEOUT_MS = 20000;
/** WebRTC can take half a minute to notice a vanished peer, so peers ping and drop silent ones sooner. */
const SILENCE_TIMEOUT_MS = 10000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type NetRules = Pick<SimRules, 'mode' | 'rounds' | 'pointLimit' | 'teams' | 'arenaShape' | 'startingGold'>;

export interface LobbySlot { peer: string | null; name: string; color: number }
export interface LobbyState { slots: LobbySlot[]; rules: NetRules; difficulty: Difficulty }
export interface StartInfo { seed: number; rules: NetRules; difficulty: Difficulty; players: PlayerSetup[]; peers: (string | null)[] }

type Msg =
  | { k: 'hello'; v: number; name: string; color: number }
  | { k: 'lobby'; s: LobbyState }
  | { k: 'reject'; reason: string }
  | { k: 'start'; info: StartInfo }
  | { k: 'cmd'; c: Command }
  | { k: 'turn'; n: number; c: Command[] }
  | { k: 'hash'; t: number; h: number }
  | { k: 'chat'; text: string; pid?: number }
  | { k: 'kick'; reason: string }
  | { k: 'ping' };

/**
 * STUN (Trystero's defaults: Google and Cloudflare) gets most home connections through NAT.
 * Symmetric NATs, CGNAT and strict corporate networks need a TURN relay; there's no reliable
 * keyless public one, so it's opt-in through build-time env vars.
 */
function turnConfig(): TurnServerConfig[] | undefined {
  const urls = import.meta.env.VITE_TURN_URL as string | undefined;
  if (!urls) return undefined;
  return [{
    urls: urls.split(',').map((u) => u.trim()).filter(Boolean),
    username: import.meta.env.VITE_TURN_USERNAME as string | undefined,
    credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
  }];
}
export const hasTurn = () => !!turnConfig();

export function makeRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normalizeCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

const NO_CONNECTION = 'Could not connect to the host. Check the room code; if it is right, your network '
  + 'or the host\'s may block direct peer-to-peer connections (strict NAT, mobile hotspot, VPN or office network). '
  + (hasTurn() ? '' : 'Setting up a TURN relay (see README) fixes this.');

export interface SessionEvents {
  onLobby?: (s: LobbyState) => void;
  onStart?: (info: StartInfo, lockstep: Lockstep) => void;
  onChat?: (pid: number, text: string) => void;
  /** The session is over (host left, kicked, rejected, could not connect). */
  onClosed?: (reason: string) => void;
  /** A player dropped out of a running game. */
  onPlayerLeft?: (pid: number) => void;
}

/** A multiplayer session: a Trystero room plus the lobby and lockstep protocol on top of it. */
export class NetSession {
  readonly selfId = selfId;
  hostId: string | null;
  lobby: LobbyState | null = null;
  lockstep: Lockstep | null = null;
  start: StartInfo | null = null;
  events: SessionEvents = {};
  closed = false;
  private room: Room;
  private send: (m: Msg, target?: string | string[] | null) => Promise<void>;
  private connectTimer = 0;
  private bots = 0;
  private lastError = '';
  private lastHeard = new Map<string, number>();
  private stopBeat: () => void;
  private onPageHide = () => this.close();

  private constructor(readonly code: string, readonly isHost: boolean, private me: { name: string; color: number }) {
    this.hostId = isHost ? selfId : null;
    this.room = joinRoom({ appId: APP_ID, password: code, turnConfig: turnConfig() }, code, {
      // Failures can come from any peer in the room's mesh, not only the host, so only remember them.
      onJoinError: (e) => {
        this.lastError = e.error;
      },
    });
    const action = this.room.makeAction<JsonValue>('m');
    this.send = (m, target) => action.send(m as unknown as JsonValue, target ? { target } : undefined).catch(() => {});
    action.onMessage = (m, ctx) => this.onMessage(m as unknown as Msg, ctx.peerId);
    this.room.onPeerJoin = (peer) => this.onPeerJoin(peer);
    this.room.onPeerLeave = (peer) => this.onPeerLeave(peer);
    this.stopBeat = workerInterval(1000, () => this.beat());
    window.addEventListener('pagehide', this.onPageHide);
    if (!isHost) {
      this.connectTimer = window.setTimeout(() => {
        if (!this.hostId) this.close(NO_CONNECTION + (this.lastError ? ` (${this.lastError})` : ''));
      }, CONNECT_TIMEOUT_MS);
    }
  }

  static host(me: { name: string; color: number }, rules: NetRules, difficulty: Difficulty, bots: number) {
    const s = new NetSession(makeRoomCode(), true, me);
    s.bots = bots;
    s.lobby = { slots: [], rules, difficulty };
    s.rebuildLobby([{ peer: selfId, name: me.name, color: me.color }]);
    return s;
  }

  static join(code: string, me: { name: string; color: number }) {
    return new NetSession(normalizeCode(code), false, me);
  }

  get inGame() {
    return !!this.lockstep;
  }

  /** Close the session and leave the room. */
  close(reason = '') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    this.stopBeat();
    window.removeEventListener('pagehide', this.onPageHide);
    void this.room.leave();
    this.events.onClosed?.(reason);
  }

  // ---------- host lobby controls ----------

  setBots(n: number) {
    if (!this.isHost || this.inGame || !this.lobby) return;
    this.bots = Math.max(0, n);
    this.rebuildLobby(this.lobby.slots.filter((s) => s.peer));
  }

  setDifficulty(d: Difficulty) {
    if (!this.isHost || !this.lobby) return;
    this.lobby.difficulty = d;
    this.broadcastLobby();
  }

  get botCount() {
    return this.lobby?.slots.filter((s) => !s.peer).length ?? 0;
  }

  /** Host: start the game for everyone in the lobby. */
  startGame() {
    if (!this.isHost || !this.lobby || this.inGame) return;
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    let bot = 0;
    const players: PlayerSetup[] = this.lobby.slots.map((s) => ({ name: s.peer ? s.name : names[bot++ % names.length], color: s.color, isBot: !s.peer }));
    const info: StartInfo = {
      seed: (Math.random() * 2 ** 31) | 0, rules: this.lobby.rules, difficulty: this.lobby.difficulty,
      players, peers: this.lobby.slots.map((s) => s.peer),
    };
    this.send({ k: 'start', info });
    this.begin(info);
  }

  /** Host: the game ended and everyone may play again; drop players who left and reopen the lobby. */
  reopenLobby() {
    if (!this.isHost || !this.lobby) return;
    this.lockstep = null;
    this.start = null;
    const peers = new Set(Object.keys(this.room.getPeers()));
    this.rebuildLobby(this.lobby.slots.filter((s) => s.peer && (s.peer === selfId || peers.has(s.peer))));
  }

  /** Client: back from a finished game to the lobby. */
  leaveGame() {
    if (this.isHost) return;
    this.lockstep = null;
    this.start = null;
    if (this.lobby) this.events.onLobby?.(this.lobby);
  }

  // ---------- in-game ----------

  chat(text: string) {
    text = text.trim().slice(0, 120);
    if (!text || !this.lockstep) return;
    if (this.isHost) {
      this.send({ k: 'chat', text, pid: this.lockstep.localId });
      this.events.onChat?.(this.lockstep.localId, text);
    } else if (this.hostId) {
      this.send({ k: 'chat', text }, this.hostId);
      this.events.onChat?.(this.lockstep.localId, text);
    }
  }

  // ---------- internals ----------

  private pidOf(peer: string) {
    return this.start ? this.start.peers.indexOf(peer) : -1;
  }

  private rebuildLobby(humans: LobbySlot[]) {
    const used = new Set<number>();
    const slots: LobbySlot[] = [];
    const free = () => PLAYER_COLORS.findIndex((_, i) => !used.has(i));
    for (const h of humans.slice(0, MAX_PLAYERS)) {
      const color = used.has(h.color) || !(h.color >= 0 && h.color < PLAYER_COLORS.length) ? free() : h.color;
      used.add(color);
      slots.push({ ...h, color });
    }
    this.bots = Math.min(this.bots, MAX_PLAYERS - slots.length);
    for (let i = 0; i < this.bots; i++) {
      const color = free();
      used.add(color);
      slots.push({ peer: null, name: 'Computer', color });
    }
    this.lobby = { ...this.lobby!, slots };
    this.broadcastLobby();
  }

  private broadcastLobby() {
    if (!this.lobby) return;
    this.send({ k: 'lobby', s: this.lobby });
    this.events.onLobby?.(this.lobby);
  }

  private begin(info: StartInfo) {
    this.start = info;
    const localId = info.peers.indexOf(selfId);
    const ls = new Lockstep(this.isHost, localId, {
      broadcastTurn: (n, c) => this.send({ k: 'turn', n, c }),
      sendCommand: (c) => this.hostId && this.send({ k: 'cmd', c }, this.hostId),
      sendHash: (t, h) => this.hostId && this.send({ k: 'hash', t, h }, this.hostId),
    });
    if (this.isHost) {
      ls.onDesync = (pid) => {
        const peer = info.peers[pid];
        if (peer) this.send({ k: 'kick', reason: 'Your game fell out of sync with the host.' }, peer);
        this.dropPlayer(pid);
      };
    }
    this.lockstep = ls;
    this.events.onStart?.(info, ls);
  }

  private dropPlayer(pid: number) {
    if (!this.lockstep || !this.start) return;
    this.start.peers[pid] = null;
    this.lockstep.receive({ pid, type: 'leave' });
    this.events.onPlayerLeft?.(pid);
  }

  private beat() {
    if (this.closed) return;
    const now = performance.now();
    if (!this.isHost) {
      if (!this.hostId) return;
      this.send({ k: 'ping' }, this.hostId);
      if (now - (this.lastHeard.get(this.hostId) ?? now) > SILENCE_TIMEOUT_MS) this.close('Lost the connection to the host.');
      return;
    }
    // Turns already flow to clients during a game.
    if (!this.inGame) this.send({ k: 'ping' });
    const players = this.inGame ? this.start!.peers : this.lobby?.slots.map((x) => x.peer) ?? [];
    for (const peer of players) {
      if (peer && peer !== selfId && now - (this.lastHeard.get(peer) ?? now) > SILENCE_TIMEOUT_MS) {
        this.lastHeard.delete(peer);
        this.onPeerLeave(peer);
      }
    }
  }

  private onPeerJoin(peer: string) {
    this.lastHeard.set(peer, performance.now());
    if (!this.isHost) this.send({ k: 'hello', v: PROTOCOL_VERSION, name: this.me.name, color: this.me.color }, peer);
  }

  private onPeerLeave(peer: string) {
    if (this.closed) return;
    if (!this.isHost) {
      if (peer === this.hostId) this.close('The host has left the game.');
      return;
    }
    if (this.inGame) {
      const pid = this.pidOf(peer);
      if (pid >= 0) this.dropPlayer(pid);
    } else if (this.lobby?.slots.some((s) => s.peer === peer)) {
      this.rebuildLobby(this.lobby.slots.filter((s) => s.peer && s.peer !== peer));
    }
  }

  private onMessage(m: Msg, from: string) {
    if (this.closed || !m || typeof m !== 'object') return;
    this.lastHeard.set(from, performance.now());
    if (this.isHost) this.onHostMessage(m, from);
    else this.onClientMessage(m, from);
  }

  private onHostMessage(m: Msg, from: string) {
    switch (m.k) {
      case 'hello': {
        if (m.v !== PROTOCOL_VERSION) return void this.send({ k: 'reject', reason: 'The host is running a different version of the game. Reload the page to update.' }, from);
        if (this.inGame) return void this.send({ k: 'reject', reason: 'That game has already started.' }, from);
        const humans = this.lobby!.slots.filter((s) => s.peer && s.peer !== from);
        if (humans.length >= MAX_PLAYERS) return void this.send({ k: 'reject', reason: 'That game is full.' }, from);
        const name = String(m.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Player';
        this.bots = Math.min(this.bots, MAX_PLAYERS - humans.length - 1);
        this.rebuildLobby([...humans, { peer: from, name, color: Number(m.color) | 0 }]);
        return;
      }
      case 'cmd': {
        const pid = this.pidOf(from);
        const c = pid >= 0 ? sanitizeCommand(m.c, pid) : null;
        if (c) this.lockstep?.receive(c);
        return;
      }
      case 'hash': {
        const pid = this.pidOf(from);
        if (pid >= 0 && Number.isInteger(m.t) && typeof m.h === 'number') this.lockstep?.receiveHash(pid, m.t, m.h);
        return;
      }
      case 'chat': {
        const pid = this.pidOf(from);
        const text = String(m.text ?? '').trim().slice(0, 120);
        if (pid < 0 || !text) return;
        const others = Object.keys(this.room.getPeers()).filter((p) => p !== from);
        if (others.length) this.send({ k: 'chat', text, pid }, others);
        this.events.onChat?.(pid, text);
        return;
      }
      default:
        return;
    }
  }

  private onClientMessage(m: Msg, from: string) {
    // Only the host speaks with authority; the first peer to send a lobby is the host.
    if (m.k === 'lobby' && !this.hostId) {
      this.hostId = from;
      clearTimeout(this.connectTimer);
    }
    if (from !== this.hostId) return;
    switch (m.k) {
      case 'lobby':
        this.lobby = m.s;
        if (!this.inGame) this.events.onLobby?.(m.s);
        return;
      case 'reject':
        this.close(m.reason);
        return;
      case 'kick':
        this.close(m.reason);
        return;
      case 'start':
        if (m.info.peers.includes(selfId)) this.begin(m.info);
        else if (!this.inGame) this.close('The game started before you joined.');
        return;
      case 'turn':
        this.lockstep?.receiveTurn(m.n, m.c);
        return;
      case 'chat':
        if (typeof m.pid === 'number') this.events.onChat?.(m.pid, String(m.text).slice(0, 120));
        return;
      default:
        return;
    }
  }
}
