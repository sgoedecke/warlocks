// Read-only MPQ archive reader (Warcraft III maps and classic game archives).
// Tolerates the "protected map" tricks used by map optimizers: wiped listfiles,
// bogus header sizes and sector offsets that wrap around 2^32.
import { unzlibSync, inflateSync } from 'fflate';
import { bunzip2 } from './bzip2';

export interface RandomAccess {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bufferSource(buf: Uint8Array): RandomAccess {
  return { size: buf.length, read: async (o, l) => buf.subarray(o, Math.min(buf.length, o + l)) };
}

export function blobSource(blob: Blob): RandomAccess {
  return {
    size: blob.size,
    read: async (o, l) => new Uint8Array(await blob.slice(o, o + l).arrayBuffer()),
  };
}

const CRYPT = (() => {
  const t = new Uint32Array(0x500);
  let seed = 0x00100001;
  for (let i = 0; i < 0x100; i++) {
    for (let j = 0, k = i; j < 5; j++, k += 0x100) {
      seed = (seed * 125 + 3) % 0x2aaaab;
      const a = (seed & 0xffff) << 16;
      seed = (seed * 125 + 3) % 0x2aaaab;
      t[k] = (a | (seed & 0xffff)) >>> 0;
    }
  }
  return t;
})();

export function hashString(name: string, type: number): number {
  let seed1 = 0x7fed7fed;
  let seed2 = 0xeeeeeeee;
  const s = name.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i) & 0xff;
    seed1 = (CRYPT[type * 256 + ch] ^ ((seed1 + seed2) >>> 0)) >>> 0;
    seed2 = (ch + seed1 + seed2 + ((seed2 << 5) >>> 0) + 3) >>> 0;
  }
  return seed1;
}

function decrypt(src: Uint8Array, key: number): Uint8Array {
  const out = src.slice();
  const n = out.length >> 2;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let seed = 0xeeeeeeee;
  key >>>= 0;
  for (let i = 0; i < n; i++) {
    seed = (seed + CRYPT[0x400 + (key & 0xff)]) >>> 0;
    const ch = (dv.getUint32(i * 4, true) ^ ((key + seed) >>> 0)) >>> 0;
    key = ((((~key << 21) >>> 0) + 0x11111111) | (key >>> 11)) >>> 0;
    seed = (ch + seed + ((seed << 5) >>> 0) + 3) >>> 0;
    dv.setUint32(i * 4, ch, true);
  }
  return out;
}

const F_IMPLODE = 0x100;
const F_COMPRESS = 0x200;
const F_ENCRYPTED = 0x10000;
const F_FIX_KEY = 0x20000;
const F_SINGLE_UNIT = 0x1000000;
const F_EXISTS = 0x80000000;

interface Block { offset: number; compressedSize: number; normalSize: number; flags: number }

function decompress(data: Uint8Array, want: number): Uint8Array {
  let mask = data[0];
  let buf = data.subarray(1);
  if (mask & 0x10) {
    buf = bunzip2(buf, want);
    mask &= ~0x10;
  }
  if (mask & 0x08) throw new Error('MPQ: PKWARE implode unsupported');
  if (mask & 0x02) {
    buf = unzlibSync(buf);
    mask &= ~0x02;
  }
  if (mask) throw new Error(`MPQ: unsupported compression 0x${mask.toString(16)}`);
  return buf;
}

export class MpqArchive {
  private hashTable!: Uint32Array;
  private blocks: Block[] = [];
  private headerOffset = 0;
  private sectorSize = 4096;

  private constructor(private src: RandomAccess) {}

  static async open(src: RandomAccess): Promise<MpqArchive> {
    const a = new MpqArchive(src);
    await a.init();
    return a;
  }

  private async init() {
    const { src } = this;
    let off = -1;
    for (let o = 0; o < Math.min(src.size, 1 << 24); o += 512) {
      const h = await src.read(o, 4);
      if (h[0] === 0x4d && h[1] === 0x50 && h[2] === 0x51 && h[3] === 0x1a) {
        off = o;
        break;
      }
    }
    if (off < 0) throw new Error('Not an MPQ archive');
    this.headerOffset = off;
    const hdr = new DataView((await src.read(off, 32)).slice().buffer);
    this.sectorSize = 512 << hdr.getUint16(14, true);
    const hashPos = this.abs(hdr.getUint32(16, true));
    const blockPos = this.abs(hdr.getUint32(20, true));
    const hashCount = hdr.getUint32(24, true);
    const blockCount = Math.min(hdr.getUint32(28, true), Math.floor((src.size - blockPos) / 16));
    const ht = decrypt(await this.readPadded(hashPos, hashCount * 16), hashString('(hash table)', 3));
    this.hashTable = new Uint32Array(ht.buffer, ht.byteOffset, hashCount * 4);
    const bt = decrypt(await this.readPadded(blockPos, blockCount * 16), hashString('(block table)', 3));
    const bv = new DataView(bt.buffer, bt.byteOffset, bt.byteLength);
    for (let i = 0; i < blockCount; i++) {
      this.blocks.push({
        offset: bv.getUint32(i * 16, true),
        compressedSize: bv.getUint32(i * 16 + 4, true),
        normalSize: bv.getUint32(i * 16 + 8, true),
        flags: bv.getUint32(i * 16 + 12, true),
      });
    }
  }

  /** Converts an archive-relative offset to a file offset (wrapping like a 32-bit pointer). */
  private abs(rel: number): number {
    return (this.headerOffset + rel) >>> 0;
  }

  private async readPadded(offset: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    if (offset < this.src.size) out.set(await this.src.read(offset, length));
    return out;
  }

  private findBlock(name: string): Block | null {
    const n = this.hashTable.length / 4;
    if (!n) return null;
    const a = hashString(name, 1);
    const b = hashString(name, 2);
    let i = hashString(name, 0) % n;
    for (let tries = 0; tries < n; tries++) {
      const e = i * 4;
      const blockIndex = this.hashTable[e + 3];
      if (blockIndex === 0xffffffff) return null;
      if (this.hashTable[e] === a && this.hashTable[e + 1] === b && blockIndex !== 0xfffffffe) {
        const block = this.blocks[blockIndex];
        if (block && block.flags & F_EXISTS) return block;
      }
      i = (i + 1) % n;
    }
    return null;
  }

  has(name: string): boolean {
    return this.findBlock(name) !== null;
  }

  async read(name: string): Promise<Uint8Array | null> {
    const block = this.findBlock(name);
    if (!block) return null;
    const { src } = this;
    const base = this.abs(block.offset);
    const raw = await src.read(base, block.compressedSize);
    const enc = (block.flags & F_ENCRYPTED) !== 0;
    let key = 0;
    if (enc) {
      const baseName = name.replace(/^.*[\\/]/, '');
      key = hashString(baseName, 3);
      if (block.flags & F_FIX_KEY) key = ((key + block.offset) ^ block.normalSize) >>> 0;
    }
    if (block.flags & F_IMPLODE) throw new Error('MPQ: PKWARE implode unsupported');
    if (!(block.flags & F_COMPRESS)) return enc ? decrypt(raw, key) : raw.slice();
    if (block.flags & F_SINGLE_UNIT) {
      const s = enc ? decrypt(raw, key) : raw;
      return block.compressedSize < block.normalSize ? decompress(s, block.normalSize) : s.slice();
    }
    const nSectors = Math.ceil(block.normalSize / this.sectorSize);
    let table = raw.subarray(0, (nSectors + 1) * 4);
    if (enc) table = decrypt(table, (key - 1) >>> 0);
    const tv = new DataView(table.slice().buffer);
    const out = new Uint8Array(block.normalSize);
    let written = 0;
    for (let i = 0; i < nSectors; i++) {
      const start = this.abs((block.offset + tv.getUint32(i * 4, true)) >>> 0);
      const end = this.abs((block.offset + tv.getUint32(i * 4 + 4, true)) >>> 0);
      // Usually the sector lies inside the block we already read; fall back to a fresh read.
      let s = start >= base && end <= base + raw.length ? raw.subarray(start - base, end - base) : await src.read(start, end - start);
      if (enc) s = decrypt(s, (key + i) >>> 0);
      const want = Math.min(this.sectorSize, block.normalSize - written);
      if (s.length < want) s = decompress(s, want);
      out.set(s.subarray(0, want), written);
      written += want;
    }
    return out;
  }
}

export { inflateSync };
