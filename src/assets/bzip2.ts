// Minimal bzip2 decompressor (MPQ compression type 0x10).

export function bunzip2(src: Uint8Array, sizeHint = 0): Uint8Array {
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;
  const bits = (n: number): number => {
    while (bitCount < n) {
      bitBuf = ((bitBuf << 8) | (src[pos++] ?? 0)) >>> 0;
      bitCount += 8;
    }
    bitCount -= n;
    return (bitBuf >>> bitCount) & ((1 << n) - 1);
  };

  if (bits(8) !== 0x42 || bits(8) !== 0x5a || bits(8) !== 0x68) throw new Error('bzip2: bad signature');
  const level = bits(8) - 0x30;
  if (level < 1 || level > 9) throw new Error('bzip2: bad block size');
  const blockSize = level * 100000;

  let out = new Uint8Array(Math.max(sizeHint, 1024));
  let outLen = 0;
  const push = (b: number) => {
    if (outLen >= out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[outLen++] = b;
  };

  const tt = new Uint32Array(blockSize);
  for (;;) {
    const m1 = bits(24);
    const m2 = bits(24);
    if (m1 === 0x177245 && m2 === 0x385090) break;
    if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bzip2: bad block magic');
    bits(16);
    bits(16); // block CRC
    if (bits(1)) throw new Error('bzip2: randomised blocks unsupported');
    const origPtr = bits(24);

    const seqToUnseq: number[] = [];
    const used16 = bits(16);
    for (let i = 0; i < 16; i++) {
      if (used16 & (0x8000 >> i)) {
        const b = bits(16);
        for (let j = 0; j < 16; j++) if (b & (0x8000 >> j)) seqToUnseq.push(i * 16 + j);
      }
    }
    if (!seqToUnseq.length) throw new Error('bzip2: no symbols');
    const alphaSize = seqToUnseq.length + 2;
    const nGroups = bits(3);
    const nSelectors = bits(15);
    if (nGroups < 2 || nGroups > 6 || nSelectors < 1) throw new Error('bzip2: bad tables');
    const groupMtf = [0, 1, 2, 3, 4, 5].slice(0, nGroups);
    const selectors = new Uint8Array(nSelectors);
    for (let i = 0; i < nSelectors; i++) {
      let j = 0;
      while (bits(1)) if (++j >= nGroups) throw new Error('bzip2: bad selector');
      const v = groupMtf[j];
      groupMtf.splice(j, 1);
      groupMtf.unshift(v);
      selectors[i] = v;
    }

    interface Table { firstCode: Int32Array; firstIndex: Int32Array; count: Int32Array; perm: Uint16Array; minLen: number; maxLen: number }
    const tables: Table[] = [];
    for (let t = 0; t < nGroups; t++) {
      const len = new Uint8Array(alphaSize);
      let curr = bits(5);
      for (let s = 0; s < alphaSize; s++) {
        for (;;) {
          if (curr < 1 || curr > 20) throw new Error('bzip2: bad code length');
          if (!bits(1)) break;
          curr += bits(1) ? -1 : 1;
        }
        len[s] = curr;
      }
      let minLen = 32;
      let maxLen = 0;
      for (const l of len) {
        if (l < minLen) minLen = l;
        if (l > maxLen) maxLen = l;
      }
      const count = new Int32Array(maxLen + 2);
      for (const l of len) count[l]++;
      const perm = new Uint16Array(alphaSize);
      let p = 0;
      for (let l = minLen; l <= maxLen; l++) for (let s = 0; s < alphaSize; s++) if (len[s] === l) perm[p++] = s;
      const firstCode = new Int32Array(maxLen + 2);
      const firstIndex = new Int32Array(maxLen + 2);
      let code = 0;
      let idx = 0;
      for (let l = 1; l <= maxLen; l++) {
        firstCode[l] = code;
        firstIndex[l] = idx;
        code = (code + count[l]) << 1;
        idx += count[l];
      }
      tables.push({ firstCode, firstIndex, count, perm, minLen, maxLen });
    }

    const mtf = new Uint8Array(256);
    for (let i = 0; i < 256; i++) mtf[i] = i;
    const unzftab = new Int32Array(256);
    const eob = alphaSize - 1;
    let count = 0;
    let groupIdx = -1;
    let groupLeft = 0;
    let table = tables[0];
    let run = 0;
    let runShift = 0;
    for (;;) {
      if (groupLeft === 0) {
        if (++groupIdx >= nSelectors) throw new Error('bzip2: selector overflow');
        groupLeft = 50;
        table = tables[selectors[groupIdx]];
      }
      groupLeft--;
      let code = 0;
      let sym = -1;
      for (let l = 1; l <= table.maxLen; l++) {
        code = (code << 1) | bits(1);
        const off = code - table.firstCode[l];
        if (l >= table.minLen && off >= 0 && off < table.count[l]) {
          sym = table.perm[table.firstIndex[l] + off];
          break;
        }
      }
      if (sym < 0) throw new Error('bzip2: bad huffman code');
      if (sym <= 1) {
        run += (sym + 1) << runShift;
        runShift++;
        continue;
      }
      if (run > 0) {
        const b = seqToUnseq[mtf[0]];
        unzftab[b] += run;
        if (count + run > blockSize) throw new Error('bzip2: block overflow');
        while (run--) tt[count++] = b;
        run = 0;
        runShift = 0;
      }
      if (sym === eob) break;
      const i = sym - 1;
      const v = mtf[i];
      mtf.copyWithin(1, 0, i);
      mtf[0] = v;
      const b = seqToUnseq[v];
      unzftab[b]++;
      if (count >= blockSize) throw new Error('bzip2: block overflow');
      tt[count++] = b;
    }
    if (origPtr >= count) throw new Error('bzip2: bad origPtr');

    const cftab = new Int32Array(256);
    for (let i = 0, sum = 0; i < 256; i++) {
      cftab[i] = sum;
      sum += unzftab[i];
    }
    for (let i = 0; i < count; i++) {
      const b = tt[i] & 0xff;
      tt[cftab[b]++] |= i << 8;
    }

    let p = tt[origPtr] >>> 8;
    let last = -1;
    let runLen = 0;
    for (let i = 0; i < count; i++) {
      const e = tt[p];
      const b = e & 0xff;
      p = e >>> 8;
      if (runLen === 4) {
        for (let k = 0; k < b; k++) push(last);
        runLen = 0;
        last = -1;
        continue;
      }
      if (b === last) runLen++;
      else {
        runLen = 1;
        last = b;
      }
      push(b);
    }
    // Clear the high bits for the next block.
    tt.fill(0, 0, count);
  }
  return out.subarray(0, outLen);
}
