// Less data on the wire (2026-11-11). Pure helpers, no DOM: offline.js and autoreload.js use them, and
// test/delta.mjs runs them under node against the real server.
//   - A save sends only what pdf.js appended to the file (crc32 lets the server prove the result).
//   - A changed PDF is rebuilt here from the copy on this device plus the parts that are new: this side
//     sends a table of its copy's chunks, the server answers "copy these ranges, here are the new bytes".
// The chunk rule must stay byte for byte the same as server.py pdf_chunks(): a cut after each
// "endstream", "endobj" or "stream" + newline, accepted when the chunk is at least MIN_CHUNK long.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b, start = 0, end = b.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function adler32(b, start = 0, end = b.length) {
  let a = 1, s = 0;
  for (let i = start; i < end;) {
    const stop = Math.min(end, i + 3800);
    for (; i < stop; i++) { a += b[i]; s += a; }
    a %= 65521;
    s %= 65521;
  }
  return ((s << 16) | a) >>> 0;
}

export const MIN_CHUNK = 32;

/** End of a cut word starting at i, or 0: "endstream", "endobj", "stream\n", "stream\r\n". */
function cutEnd(b, i) {
  const c = b[i];
  if (c === 0x65) { // e
    if (b[i + 1] !== 0x6e || b[i + 2] !== 0x64) return 0; // nd
    if (b[i + 3] === 0x73 && b[i + 4] === 0x74 && b[i + 5] === 0x72 && b[i + 6] === 0x65 && b[i + 7] === 0x61 && b[i + 8] === 0x6d) return i + 9; // stream
    if (b[i + 3] === 0x6f && b[i + 4] === 0x62 && b[i + 5] === 0x6a) return i + 6; // obj
    return 0;
  }
  if (c === 0x73) { // s
    if (b[i + 1] !== 0x74 || b[i + 2] !== 0x72 || b[i + 3] !== 0x65 || b[i + 4] !== 0x61 || b[i + 5] !== 0x6d) return 0; // tream
    if (b[i + 6] === 0x0a) return i + 7;
    if (b[i + 6] === 0x0d && b[i + 7] === 0x0a) return i + 8;
  }
  return 0;
}

/** [start, end) of every chunk, flat: [s0, e0, s1, e1, ...]. */
export function chunkBounds(b) {
  const out = [];
  let p = 0;
  const n = b.length;
  for (let i = 0; i < n;) {
    const c = b[i];
    if (c !== 0x65 && c !== 0x73) { i++; continue; }
    const e = cutEnd(b, i);
    if (!e || e > n) { i++; continue; }
    if (e - p >= MIN_CHUNK) { out.push(p, e); p = e; }
    i = e;
  }
  if (p < n) out.push(p, n);
  return out;
}

/** What the server needs to know about the copy here: length, crc32 and adler32 of each chunk, in order. */
export function chunkTable(b) {
  const bounds = chunkBounds(b);
  const t = new Uint32Array((bounds.length / 2) * 3);
  for (let i = 0, k = 0; i < bounds.length; i += 2) {
    const s = bounds[i], e = bounds[i + 1];
    t[k++] = e - s;
    t[k++] = crc32(b, s, e);
    t[k++] = adler32(b, s, e);
  }
  return t;
}

const MAGIC = 0x314c4450; // "PDL1", little endian

/** Rebuild the server's file from the copy here (`old`) and its answer. Throws when the result is not the file. */
export function applyDelta(old, buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 16 || dv.getUint32(0, true) !== MAGIC) throw new Error("not a delta answer");
  const newLen = dv.getUint32(4, true), crc = dv.getUint32(8, true), ops = dv.getUint32(12, true);
  const out = new Uint8Array(newLen);
  let o = 0, p = 16, copied = 0;
  for (let k = 0; k < ops; k++) {
    const kind = buf[p++];
    if (kind === 0) {
      const off = dv.getUint32(p, true), len = dv.getUint32(p + 4, true);
      p += 8;
      if (off + len > old.length || o + len > newLen) throw new Error("delta copies outside the file");
      out.set(old.subarray(off, off + len), o);
      o += len;
      copied += len;
    } else if (kind === 1) {
      const len = dv.getUint32(p, true);
      p += 4;
      if (p + len > buf.length || o + len > newLen) throw new Error("delta data runs past its end");
      out.set(buf.subarray(p, p + len), o);
      p += len;
      o += len;
    } else {
      throw new Error("unknown delta step");
    }
  }
  if (o !== newLen || crc32(out) !== crc) throw new Error("the rebuilt file is not the server's file");
  return { bytes: out, copied };
}
