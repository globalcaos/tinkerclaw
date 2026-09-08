import { createHash } from "node:crypto";

// bencode.mjs — minimal bencode decoder, no dependencies.
//
// Exists so that inspecting a .torrent file needs NOTHING beyond node: we
// fetch the metadata over plain HTTP, decode it here, and read the real file
// list without ever contacting a peer, a tracker or the DHT.

/**
 * @param {Buffer} buf
 * @returns {{value:any, infoRange:[number,number]|null}}
 */
export function decode(buf) {
  let i = 0;
  let infoRange = null;

  function readInt(end) {
    const start = i;
    while (buf[i] !== end) i += 1;
    const n = Number(buf.toString("ascii", start, i));
    i += 1;
    return n;
  }

  function parse(parentKeyWasInfo = false) {
    const c = buf[i];
    if (c === 0x69) {
      // 'i'
      i += 1;
      return readInt(0x65); // 'e'
    }
    if (c === 0x6c) {
      // 'l'
      i += 1;
      const out = [];
      while (buf[i] !== 0x65) out.push(parse());
      i += 1;
      return out;
    }
    if (c === 0x64) {
      // 'd'
      i += 1;
      const out = {};
      while (buf[i] !== 0x65) {
        const key = parse();
        const keyStr = Buffer.isBuffer(key) ? key.toString("utf8") : String(key);
        const valueStart = i;
        const value = parse(keyStr === "info");
        if (keyStr === "info" && infoRange === null) infoRange = [valueStart, i];
        out[keyStr] = value;
      }
      i += 1;
      return out;
    }
    // byte string: <len>:<bytes>
    const len = readInt(0x3a); // ':'
    const slice = buf.subarray(i, i + len);
    i += len;
    return slice;
  }

  const value = parse();
  return { value, infoRange };
}

const asStr = (v) => (Buffer.isBuffer(v) ? v.toString("utf8") : v === undefined ? null : String(v));

/**
 * Turn a decoded .torrent into the flat shape the scorer wants.
 * @param {Buffer} buf raw .torrent bytes
 */
export function readTorrent(buf) {
  // A torrent file ALWAYS starts with a bencoded dict. Without this guard an
  // HTML error page (a 404, a Cloudflare block, a login redirect) decodes to
  // nonsense and the caller reports a clean, empty, entirely fictional torrent
  // — the worst possible failure for a tool whose whole job is verification.
  if (!Buffer.isBuffer(buf) || buf.length < 16 || buf[0] !== 0x64) {
    const head = Buffer.isBuffer(buf)
      ? buf.subarray(0, 40).toString("utf8").replace(/\s+/g, " ")
      : String(buf).slice(0, 40);
    throw new Error(
      `not a torrent file (expected bencoded dict, got ${buf?.length ?? 0} bytes starting "${head}")`,
    );
  }
  const { value: meta, infoRange } = decode(buf);
  if (!meta || typeof meta !== "object" || !meta.info) {
    throw new Error("decoded, but no `info` dictionary — not a valid torrent");
  }
  const info = meta.info || {};
  const name = asStr(info.name);
  const files = [];

  if (Array.isArray(info.files)) {
    for (const f of info.files) {
      const parts = (f.path || []).map((p) => asStr(p));
      files.push({ path: [name, ...parts].join("/"), sizeBytes: Number(f.length) || 0 });
    }
  } else if (info.length !== undefined) {
    files.push({ path: name, sizeBytes: Number(info.length) || 0 });
  }

  let infoHash = null;
  if (infoRange) {
    infoHash = createHash("sha1").update(buf.subarray(infoRange[0], infoRange[1])).digest("hex");
  }

  const announce = [];
  if (meta.announce) announce.push(asStr(meta.announce));
  for (const tier of meta["announce-list"] || []) {
    for (const t of tier || []) {
      const s = asStr(t);
      if (s && !announce.includes(s)) announce.push(s);
    }
  }

  return {
    name,
    infoHash,
    files,
    totalBytes: files.reduce((a, f) => a + f.sizeBytes, 0),
    pieceLength: Number(info["piece length"]) || null,
    pieceCount: info.pieces ? Math.floor(info.pieces.length / 20) : null,
    private: info.private === 1,
    announce,
    webSeeds: (meta["url-list"]
      ? Array.isArray(meta["url-list"])
        ? meta["url-list"]
        : [meta["url-list"]]
      : []
    ).map(asStr),
    comment: asStr(meta.comment),
    createdBy: asStr(meta["created by"]),
    creationDate: meta["creation date"]
      ? new Date(Number(meta["creation date"]) * 1000).toISOString()
      : null,
  };
}
