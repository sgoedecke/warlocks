import { joinRoom, selfId, type JsonValue, type Room } from 'trystero/nostr';
import { PLAYER_COLORS, shuffledBotNames } from '../config';
import type { Difficulty } from '../ai/bot';
import type { Command, PlayerSetup, SimRules } from '../sim/types';
import { Lockstep, sanitizeCommand } from './lockstep';
import { workerInterval } from './timer';

const APP_ID = 'warlocks-088b-browser';
/** Bumped whenever the sim or protocol changes in a way that would desync older builds. */
export const PROTOCOL_VERSION = 2;
export const MAX_PLAYERS = 10;
const CONNECT_TIMEOUT_MS = 20000;
/** Public rooms: how long to look for a host before hosting, and how many busy rooms to skip past. */
const PUBLIC_HOST_WAIT_MS = 3000;
/** Bots a Quick Play host's lobby starts with. */
const PUBLIC_BOTS = 3;
const PUBLIC_REJECTED_WAIT_MS = 1500;
export const PUBLIC_ROOMS = 20;
/** WebRTC can take half a minute to notice a vanished peer, so peers ping and drop silent ones sooner. */
const SILENCE_TIMEOUT_MS = 10000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type NetRules = Pick<SimRules, 'mode' | 'rounds' | 'pointLimit' | 'teams' | 'arenaShape' | 'startingGold'>;

export interface LobbySlot { peer: string | null; name: string; color: number }
export interface LobbyState { slots: LobbySlot[]; rules: NetRules; difficulty: Difficulty }
export interface StartInfo { seed: number; rules: NetRules; difficulty: Difficulty; players: PlayerSetup[]; peers: (string | null)[] }

type Msg =
  | { k: 'hello'; v: number; name: string; color: number }
  | { k: 'bye' }
  | { k: 'lobby'; s: LobbyState }
  | { k: 'reject'; reason: string }
  | { k: 'start'; info: StartInfo }
  | { k: 'cmd'; c: Command }
  | { k: 'turn'; n: number; c: Command[] }
  | { k: 'hash'; t: number; h: number }
  | { k: 'chat'; text: string; pid?: number }
  | { k: 'kick'; reason: string }
  | { k: 'ping' };

export function makeRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normalizeCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

const NO_CONNECTION = 'Could not connect to the host. Check the room code. If it is right, your network or the host\'s '
  + 'may block direct peer-to-peer connections (strict NAT, mobile hotspot, VPN or office network).';

export interface SessionEvents {
  onLobby?: (s: LobbyState) => void;
  onStart?: (info: StartInfo, lockstep: Lockstep) => void;
  onChat?: (pid: number, text: string) => void;
  /** The session is over (host left, kicked, rejected, could not connect). `retry`: try the next public room. */
  onClosed?: (reason: string, retry: boolean) => void;
  /** This peer became, or stopped being, the lobby host (public rooms only). */
  onRole?: () => void;
  /** A player dropped out of a running game. */
  onPlayerLeft?: (pid: number) => void;
}

/**
 * A multiplayer session: a Trystero room plus the lobby and lockstep protocol on top of it.
 *
 * Private rooms have a random code and a fixed host. Public rooms ("Quick Play") are numbered and
 * self-organising: a newcomer joins the open lobby if there is one, moves on to the next room if the
 * game there has started, and otherwise hosts. If two lobbies form in one room (two people arrived
 * together), the host with the smaller peer id wins and the other host and its players move over.
 */
export class NetSession {
  readonly selfId = selfId;
  isHost: boolean;
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
  private rejected = '';
  private helloSent = false;
  private lastHeard = new Map<string, number>();
  private stopBeat: () => void;
  private onPageHide = () => this.close();

  private constructor(
    readonly code: string,
    isHost: boolean,
    private me: { name: string; color: number },
    readonly publicRoom: number,
    private hostSettings: { rules: NetRules; difficulty: Difficulty; bots: number },
  ) {
    this.isHost = isHost;
    this.hostId = isHost ? selfId : null;
    this.room = joinRoom({ appId: APP_ID, password: code }, code, {
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
    if (isHost) this.becomeHost();
    else this.waitForHost(this.isPublic ? PUBLIC_HOST_WAIT_MS : CONNECT_TIMEOUT_MS);
  }

  static host(me: { name: string; color: number }, rules: NetRules, difficulty: Difficulty, bots: number) {
    return new NetSession(makeRoomCode(), true, me, 0, { rules, difficulty, bots });
  }

  static join(code: string, me: { name: string; color: number }) {
    return new NetSession(normalizeCode(code), false, me, 0, { rules: {} as NetRules, difficulty: 'normal', bots: 0 });
  }

  /** Public room `n` (1-based). If nobody is hosting there, this peer hosts with these settings and a few bots. */
  static public(n: number, me: { name: string; color: number }, rules: NetRules, difficulty: Difficulty) {
    return new NetSession(`PUBLIC${n}`, false, me, n, { rules, difficulty, bots: PUBLIC_BOTS });
  }

  get isPublic() {
    return this.publicRoom > 0;
  }

  get inGame() {
    return !!this.lockstep;
  }

  /** Close the session and leave the room. */
  close(reason = '', retry = false) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    this.stopBeat();
    window.removeEventListener('pagehide', this.onPageHide);
    void this.room.leave();
    this.events.onClosed?.(reason, retry);
  }

  // ---------- host lobby controls ----------

  setBots(n: number) {
    if (!this.isHost || this.inGame || !this.lobby) return;
    this.bots = Math.max(0, n);
    this.rebuildLobby(this.lobby.slots.filter((s) => s.peer));
  }

  get botCount() {
    return this.lobby?.slots.filter((s) => !s.peer).length ?? 0;
  }

  /** Host: start the game for everyone in the lobby. */
  startGame() {
    if (!this.isHost || !this.lobby || this.inGame) return;
    const names = shuffledBotNames();
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

  // ---------- roles ----------

  private waitForHost(ms: number) {
    clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => this.hostWaitOver(), ms);
  }

  private hostWaitOver() {
    if (this.closed || this.hostId) return;
    if (!this.isPublic) this.close(this.rejected || NO_CONNECTION + (this.lastError ? ` (${this.lastError})` : ''));
    else if (this.rejected) this.close(this.rejected, true);
    else {
      this.becomeHost();
      this.events.onRole?.();
    }
  }

  private becomeHost() {
    this.isHost = true;
    this.hostId = selfId;
    this.bots = this.hostSettings.bots;
    this.lobby = { slots: [], rules: this.hostSettings.rules, difficulty: this.hostSettings.difficulty };
    this.rebuildLobby([{ peer: selfId, name: this.me.name, color: this.me.color }]);
  }

  /** Follow `peer` as host: on first contact, or when a lobby with a better claim to the room turns up. */
  private followHost(peer: string) {
    if (this.hostId && this.hostId !== peer) this.send({ k: 'bye' }, this.hostId);
    const wasHost = this.isHost;
    this.isHost = false;
    this.hostId = peer;
    this.helloSent = false;
    this.lobby = null;
    clearTimeout(this.connectTimer);
    if (wasHost) this.events.onRole?.();
  }

  /** The lobby host went away. In a public room, look for (or become) the next one. */
  private hostLost(reason: string) {
    if (!this.isPublic || this.inGame) {
      this.close(reason);
      return;
    }
    this.hostId = null;
    this.lobby = null;
    this.rejected = '';
    this.events.onRole?.();
    this.waitForHost(1000 + Math.random() * 1000);
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
      if (now - (this.lastHeard.get(this.hostId) ?? now) > SILENCE_TIMEOUT_MS) this.hostLost('Lost the connection to the host.');
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
    // Hosts introduce themselves; clients answer the lobby with a hello.
    if (!this.isHost) return;
    if (this.inGame) this.send({ k: 'reject', reason: 'That game has already started.' }, peer);
    else if (this.lobby) this.send({ k: 'lobby', s: this.lobby }, peer);
  }

  private onPeerLeave(peer: string) {
    if (this.closed) return;
    if (!this.isHost) {
      if (peer === this.hostId) this.hostLost('The host has left the game.');
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
    // Two lobbies in one room: everyone in a lobby follows the host with the smallest peer id.
    if (m.k === 'lobby' && !this.inGame && from !== this.hostId && (!this.hostId || from < this.hostId)) this.followHost(from);
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
      case 'bye':
        if (!this.inGame) this.onPeerLeave(from);
        return;
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
    if (m.k === 'reject' && !this.hostId) {
      // Before we have a host, a refusal comes from a game in progress (or a full or newer one).
      // Public rooms wait briefly in case an open lobby also answers, then move on.
      this.rejected = String(m.reason ?? 'Could not join that game.');
      if (!this.isPublic) this.close(this.rejected);
      else this.waitForHost(PUBLIC_REJECTED_WAIT_MS);
      return;
    }
    // Only the host speaks with authority.
    if (from !== this.hostId) return;
    switch (m.k) {
      case 'lobby':
        this.lobby = m.s;
        if (!this.inGame) this.events.onLobby?.(m.s);
        if (!this.helloSent && !m.s.slots.some((s) => s.peer === selfId)) {
          this.helloSent = true;
          this.send({ k: 'hello', v: PROTOCOL_VERSION, name: this.me.name, color: this.me.color }, from);
        }
        return;
      case 'reject':
      case 'kick':
        this.close(m.reason, this.isPublic && !this.inGame);
        return;
      case 'start':
        if (m.info.peers.includes(selfId)) this.begin(m.info);
        else if (!this.inGame) this.close('The game started before you joined.', this.isPublic);
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
