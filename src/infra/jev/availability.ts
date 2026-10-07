/**
 * Jev availability: the ONE place that says whether Jev can be asked at all, and the only code that reads the token.
 *
 * Why it exists: Jev is a paid, optional judge. A fresh clone has no token, and every capability that needs Jev must then
 * stay off by itself (no question, no error row, no log line per call) and switch on by itself when a token turns up.
 * Before this, a keyless client answered every question with an `error` verdict and each consumer read `TYPESAFE_API_KEY`
 * on its own.
 *
 * States: `dormant` (no token), `unverified` (a token exists, Jev has not answered with it yet), `armed` (Jev answered),
 * `rejected` (Jev refused the token, 401/403: off until the token changes). `on` is true for unverified and armed.
 *
 * Token sources, first one wins: the environment (`TYPESAFE_API_KEY`, read at process start, so changing it needs a
 * restart) and the key file `<state dir>/jev/token` (re-read when its mtime changes, no restart). There is no config
 * secret on purpose: `openclaw.json` can sit in a git repo with a remote. The snapshot never carries the token.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../../config/paths.js";

export type JevState = "dormant" | "unverified" | "armed" | "rejected";
export type JevKeySource = "env" | "file";
export type JevReason = "no-token" | "checking" | "ok" | "token-rejected";

export interface JevAvailability {
  state: JevState;
  /** Consumers ask Jev only when this is true. */
  on: boolean;
  keySource: JevKeySource | null;
  reason: JevReason;
  /** When the state last changed (ms). */
  since: number;
  lastProbe: { ts: number; ok: boolean; status?: number } | null;
  /** At least one client's circuit breaker is open: asks are paused for a moment, the token is fine. */
  breakerOpen: boolean;
  /** What switches on with a token. */
  enables: readonly string[];
  tokenFile: string;
  /** Where to get a token; only present when the owner configured one (`jev.tokenHelpUrl`). */
  tokenHelpUrl?: string;
  /** The one-line status the chat chip and the CLI show. */
  line: string;
}

export interface JevAvailabilityDeps {
  env?: () => Record<string, string | undefined>;
  tokenFile?: () => string;
  /** The file's text, or undefined when it does not exist. */
  readFile?: (path: string) => string | undefined;
  /** The file's mtime in ms, or undefined when it does not exist. */
  statFile?: (path: string) => number | undefined;
  tokenHelpUrl?: () => string | undefined;
  now?: () => number;
  logger?: { info(message: string): void; warn(message: string): void };
}

export type JevReport = { ok: true } | { ok: false; status?: number };

export const JEV_ENABLES: readonly string[] = ["safety checks", "routing reads", "recipe ranking"];
const PROBE_COOLDOWN_MS = 5 * 60_000;

/** The first usable line of a key file: a raw token, or `TYPESAFE_API_KEY=...`, with optional quotes. */
export function parseTokenText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    line = line.replace(/^(?:export\s+)?TYPESAFE_API_KEY\s*=\s*/, "");
    line = line.replace(/^(["'])(.*)\1$/, "$2").trim();
    return line === "" ? undefined : line;
  }
  return undefined;
}

export function createJevAvailability(d: JevAvailabilityDeps = {}) {
  const env = d.env ?? (() => process.env);
  const tokenFile = d.tokenFile ?? (() => join(resolveStateDir(), "jev", "token"));
  const readFile =
    d.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    });
  const statFile =
    d.statFile ??
    ((p: string) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return undefined;
      }
    });
  const now = d.now ?? Date.now;
  const log = d.logger;

  let token: string | undefined;
  let keySource: JevKeySource | null = null;
  let state: JevState = "dormant";
  let since = now();
  let lastProbe: JevAvailability["lastProbe"] = null;
  let fileMtime: number | undefined;
  let fileToken: string | undefined;
  let announced = false;
  const probes = new Map<string, () => Promise<unknown>>();
  let lastProbeAt = -Infinity;
  const breakers = new Map<string, { open: boolean; until?: number }>();
  const listeners = new Set<(s: JevAvailability) => void>();
  let lastSig = "";

  const readFileToken = (): string | undefined => {
    const path = tokenFile();
    const m = statFile(path);
    if (m === undefined) {
      fileMtime = undefined;
      fileToken = undefined;
      return undefined;
    }
    if (m !== fileMtime) {
      fileMtime = m;
      fileToken = parseTokenText(readFile(path));
    }
    return fileToken;
  };

  // An open breaker closes by itself after its reset time; `until` keeps an idle chip from saying "paused" forever.
  const breakerOpen = (): boolean =>
    [...breakers.values()].some((b) => b.open && (b.until === undefined || now() < b.until));

  const lineOf = (): string => {
    if (state === "dormant") {
      return `Jev: off — no token (enables: ${JEV_ENABLES.join(", ")})`;
    }
    if (state === "rejected") {
      return "Jev: off — the token was rejected by Jev";
    }
    if (breakerOpen()) {
      return "Jev: on — paused for a moment after errors";
    }
    if (state === "unverified") {
      return "Jev: on — token not checked yet";
    }
    return "Jev: on";
  };

  const snapshot = (): JevAvailability => {
    const help = d.tokenHelpUrl?.();
    return {
      state,
      on: state === "unverified" || state === "armed",
      keySource,
      reason:
        state === "dormant"
          ? "no-token"
          : state === "rejected"
            ? "token-rejected"
            : state === "armed"
              ? "ok"
              : "checking",
      since,
      lastProbe,
      breakerOpen: breakerOpen(),
      enables: JEV_ENABLES,
      tokenFile: tokenFile(),
      ...(help ? { tokenHelpUrl: help } : {}),
      line: lineOf(),
    };
  };

  const emitIfChanged = (): void => {
    const sig = `${state}|${keySource ?? ""}|${breakerOpen()}`;
    if (sig === lastSig) {
      return;
    }
    lastSig = sig;
    const s = snapshot();
    for (const fn of listeners) {
      try {
        fn(s);
      } catch {
        /* a listener never breaks the source */
      }
    }
  };

  const setState = (next: JevState): void => {
    if (next === state) {
      return;
    }
    state = next;
    since = now();
  };

  const maybeProbe = (): void => {
    const probe = probes.values().next().value;
    if (!probe || state !== "unverified") {
      return;
    }
    const t = now();
    if (t - lastProbeAt < PROBE_COOLDOWN_MS) {
      return;
    }
    lastProbeAt = t;
    // The probe asks Jev one synthetic question through the normal client; the client reports the outcome itself.
    void Promise.resolve()
      .then(() => probe())
      .catch(() => undefined);
  };

  const refresh = (quiet = false): void => {
    const e = env();
    const fromEnv = e.TYPESAFE_API_KEY?.trim() || undefined;
    const fromFile = fromEnv ? undefined : readFileToken();
    const next = fromEnv ?? fromFile;
    const nextSource: JevKeySource | null = fromEnv ? "env" : fromFile ? "file" : null;
    const hadToken = token !== undefined;
    const changed = next !== token || nextSource !== keySource;
    if (changed) {
      token = next;
      keySource = nextSource;
      if (next === undefined) {
        setState("dormant");
        if (!quiet && hadToken) {
          log?.info("[jev] token removed: dormant, nothing is asked until a token exists again");
        }
      } else {
        // A new or changed token starts unverified, and clears an earlier rejection.
        setState("unverified");
        lastProbeAt = -Infinity;
        if (!quiet) {
          log?.info(`[jev] token found (${nextSource}): checking it with Jev`);
        }
      }
    }
    if (!quiet) {
      emitIfChanged();
    } else {
      lastSig = `${state}|${keySource ?? ""}|${breakerOpen()}`;
    }
    maybeProbe();
  };

  refresh(true);

  return {
    snapshot,
    /** The token, for the one client option that needs it. Undefined while dormant or rejected. */
    token(): string | undefined {
      return state === "dormant" || state === "rejected" ? undefined : token;
    },
    refresh: () => refresh(false),
    report(r: JevReport): void {
      lastProbe = {
        ts: now(),
        ok: r.ok,
        ...(r.ok ? {} : r.status !== undefined ? { status: r.status } : {}),
      };
      if (state !== "unverified" && state !== "armed") {
        return;
      }
      if (r.ok) {
        if (state !== "armed") {
          setState("armed");
          log?.info("[jev] armed: Jev answered, its checks and reads are on");
        }
      } else if (r.status === 401 || r.status === 403) {
        setState("rejected");
        log?.warn(`[jev] Jev rejected the token (HTTP ${r.status}): off until the token changes`);
      }
      emitIfChanged();
    },
    noteBreaker(owner: string, open: boolean, until?: number): void {
      breakers.set(owner, { open, ...(until !== undefined ? { until } : {}) });
      emitIfChanged();
    },
    onChange(fn: (s: JevAvailability) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** One synthetic question per owner; the first one registered runs. Undefined removes the owner's. */
    setProbe(fn: (() => Promise<unknown>) | undefined, owner = "default"): void {
      if (fn) {
        probes.set(owner, fn);
      } else {
        probes.delete(owner);
      }
      maybeProbe();
    },
    /** The one start line, whoever starts first: what is dormant and why. Silent for every later caller. */
    announce(owner: string): void {
      if (announced) {
        return;
      }
      announced = true;
      const s = snapshot();
      if (s.state === "dormant") {
        const help = s.tokenHelpUrl ? ` Get a token: ${s.tokenHelpUrl}.` : "";
        log?.info(
          `[jev] dormant, no token (${owner} started): off until one exists: ${JEV_ENABLES.join(", ")}. ` +
            `Everything else works. Put the token in ${s.tokenFile} (picked up without a restart) or set TYPESAFE_API_KEY (needs a restart).${help}`,
        );
      } else {
        log?.info(`[jev] token present (${s.keySource}), ${owner} may ask Jev`);
      }
    },
  };
}

export type JevAvailabilityRegistry = ReturnType<typeof createJevAvailability>;

// --- the process-wide instance -------------------------------------------------------------------------------------
// The plugin SDK may be bundled once per plugin, and the gateway loads plugins more than once in one process, so the
// instance lives on globalThis: every copy of this module reads and writes the same one.

type Settings = {
  logger?: { info(m: string): void; warn(m: string): void };
  /** Per plugin: the owner's token pointer. The first non-empty one wins. */
  tokenHelpUrls: Map<string, () => string | undefined>;
};
type Slot = {
  registry: JevAvailabilityRegistry;
  settings: Settings;
  lastRefresh: number;
  watchers: number;
  timer?: NodeJS.Timeout;
};
const SLOT = Symbol.for("openclaw.jev.availability");
const REFRESH_EVERY_MS = 2_000;
const WATCH_EVERY_MS = 10_000;

const firstOf = (m: Map<string, () => string | undefined>): string | undefined => {
  for (const fn of m.values()) {
    const v = fn();
    if (v) {
      return v;
    }
  }
  return undefined;
};

function slot(): Slot {
  const g = globalThis as { [SLOT]?: Slot };
  if (!g[SLOT]) {
    const settings: Settings = { tokenHelpUrls: new Map() };
    g[SLOT] = {
      settings,
      lastRefresh: 0,
      watchers: 0,
      registry: createJevAvailability({
        logger: {
          info: (m) => settings.logger?.info(m),
          warn: (m) => settings.logger?.warn(m),
        },
        tokenHelpUrl: () => firstOf(settings.tokenHelpUrls),
      }),
    };
  }
  return g[SLOT];
}

function fresh(): JevAvailabilityRegistry {
  const s = slot();
  const t = Date.now();
  if (t - s.lastRefresh >= REFRESH_EVERY_MS) {
    s.lastRefresh = t;
    s.registry.refresh();
  }
  return s.registry;
}

/** What a plugin tells the process-wide source: where to log and the owner's token pointer. */
export function configureJev(o: {
  owner: string;
  logger?: { info(m: string): void; warn(m: string): void };
  tokenHelpUrl?: () => string | undefined;
}): void {
  const st = slot().settings;
  if (o.logger) {
    st.logger = o.logger;
  }
  if (o.tokenHelpUrl) {
    st.tokenHelpUrls.set(o.owner, o.tokenHelpUrl);
  }
}

/** Re-read the sources now, ignoring the few-second throttle (for status calls and tests). */
export function refreshJevNow(): void {
  const s = slot();
  s.lastRefresh = Date.now();
  s.registry.refresh();
}

/** The state of Jev right now: the one answer every consumer reads. */
export function jevAvailability(): JevAvailability {
  return fresh().snapshot();
}

/** True when Jev may be asked (a token exists and Jev has not refused it). */
export function jevOn(): boolean {
  return fresh().snapshot().on;
}

/** The token for the Jev client's `apiKey` option; nothing else reads it. */
export function jevToken(): string | undefined {
  return fresh().token();
}

export function reportJevResult(r: JevReport): void {
  slot().registry.report(r);
}

export function noteJevBreaker(owner: string, open: boolean, until?: number): void {
  slot().registry.noteBreaker(owner, open, until);
}

export function onJevChange(fn: (s: JevAvailability) => void): () => void {
  return slot().registry.onChange(fn);
}

export function setJevProbe(fn: (() => Promise<unknown>) | undefined, owner?: string): void {
  slot().registry.setProbe(fn, owner);
}

export function announceJev(owner: string): void {
  slot().registry.announce(owner);
}

/** Re-read the sources every few seconds (a key file that appears arms Jev without a restart). Returns the stopper. */
export function startJevWatch(): () => void {
  const s = slot();
  s.watchers += 1;
  if (!s.timer) {
    s.timer = setInterval(() => {
      s.lastRefresh = Date.now();
      s.registry.refresh();
    }, WATCH_EVERY_MS);
    s.timer.unref?.();
  }
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    s.watchers -= 1;
    if (s.watchers <= 0 && s.timer) {
      clearInterval(s.timer);
      s.timer = undefined;
      s.watchers = 0;
    }
  };
}

/** Tests only: drop the process-wide instance. */
export function resetJevAvailabilityForTests(): void {
  const g = globalThis as { [SLOT]?: Slot };
  const s = g[SLOT];
  if (s?.timer) {
    clearInterval(s.timer);
  }
  delete g[SLOT];
}
