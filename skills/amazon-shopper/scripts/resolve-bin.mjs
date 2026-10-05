// resolve-bin.mjs — turn a fixed, allowlisted program name into the absolute
// path that gets spawned.
//
// Handing a bare name to spawn() lets the OS search PATH at exec time, which
// trusts every PATH entry equally — including "", "." and relative entries that
// resolve against whatever directory the agent happens to be in, and directories
// anyone can write to. This resolver walks PATH itself. PATH only decides WHICH
// trusted copy of an allowlisted name runs; it cannot make an untrusted copy run.
//
// A candidate `<entry>/<name>` is accepted only if:
//
//   * the PATH entry is ABSOLUTE (empty, "." and relative entries are skipped);
//   * the path is resolved component by component, following every symlink
//     (in the entry itself, in the candidate, and in any link the candidate
//     points to, up to 40 hops), and EVERY directory walked through on the way
//     to the real file — from "/" down, for the link locations and for the real
//     location — is owned by root or the current user and is not writable by
//     others, nor by a group other than root or your own primary group (the
//     per-user private group most Linux distributions create; this mirrors
//     Debian OpenSSH's user-group-modes rule);
//   * the real file is a regular, executable file, owned by root or the current
//     user, and not group- or world-writable.
//
// So a /usr/local/bin/claude symlink into /tmp, or into any directory another
// account can write to, is refused, as is a binary whose real location sits
// under such a directory. The first candidate passing every check is spawned by
// its absolute path. The allowlist of names lives with each caller (llm.mjs,
// image-hash.mjs) and is not configurable.

import { accessSync, lstatSync, readlinkSync, constants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";

const MAX_LINK_HOPS = 40;

function ownerOk(st, uid) {
  return uid === null || st.uid === 0 || st.uid === uid;
}

const OWN_GID = typeof process.getgid === "function" ? process.getgid() : null;

function dirTrusted(st, uid) {
  if (!st.isDirectory() || !ownerOk(st, uid)) return false;
  if (st.mode & 0o002) return false;
  if (st.mode & 0o020 && st.gid !== 0 && !(uid !== null && st.uid === uid && st.gid === OWN_GID)) {
    return false;
  }
  return true;
}

// Walk an absolute path from "/" one component at a time. Every directory
// entered must be trusted; every symlink met is re-resolved from the directory
// that holds it (which is itself trusted by construction). Returns the lstat of
// the final non-link object, or null when any step fails a check. With
// `onRefuse`, the first refused path and the reason are reported to it.
export function walkTrusted(
  absPath,
  {
    uid = typeof process.getuid === "function" ? process.getuid() : null,
    onRefuse = () => {},
  } = {},
) {
  if (!isAbsolute(absPath)) return null;
  let current = sep;
  try {
    if (!dirTrusted(lstatSync(current), uid)) {
      onRefuse(current, "directory writable by others or not owned by root/you");
      return null;
    }
  } catch {
    return null;
  }
  let queue = absPath.split(sep).filter(Boolean);
  let hops = 0;
  while (queue.length) {
    const part = queue.shift();
    if (part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let st;
    try {
      st = lstatSync(next);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) {
      if (++hops > MAX_LINK_HOPS) return null;
      let target;
      try {
        target = readlinkSync(next);
      } catch {
        return null;
      }
      if (isAbsolute(target)) current = sep;
      queue = target.split(sep).filter(Boolean).concat(queue);
      continue;
    }
    if (st.isDirectory()) {
      if (!dirTrusted(st, uid)) {
        onRefuse(next, "directory writable by others or not owned by root/you");
        return null;
      }
      current = next;
      continue;
    }
    if (queue.length) return null; // a non-directory in the middle of the path
    return { path: next, stat: st };
  }
  return null; // the path named a directory, not a file
}

export function resolveTrustedBin(
  name,
  { pathEnv = process.env.PATH || "", onRefuse = () => {} } = {},
) {
  const bin = String(name || "");
  if (!bin || bin !== basename(bin) || bin === "." || bin === "..") {
    throw new Error(`refusing to resolve '${bin}': a bare program name is required`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const dir of String(pathEnv).split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, bin);
    let exists = true;
    try {
      lstatSync(candidate);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    const real = walkTrusted(candidate, {
      uid,
      onRefuse: (p, why) => onRefuse(candidate, `${p}: ${why}`),
    });
    if (!real) continue;
    const st = real.stat;
    if (!st.isFile() || st.mode & 0o022 || !ownerOk(st, uid)) {
      onRefuse(
        candidate,
        `${real.path}: not a regular file owned by root/you with no group/world write`,
      );
      continue;
    }
    try {
      accessSync(real.path, constants.X_OK);
    } catch {
      onRefuse(candidate, `${real.path}: not executable`);
      continue;
    }
    return candidate;
  }
  return null;
}
