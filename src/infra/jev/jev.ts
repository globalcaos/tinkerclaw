/**
 * Jev client (design doc §1 C4–C6, C9): one HTTP call answers every uncached question of a situation.
 * Redaction is injected (`buildState`); the API key is read per call and never leaves the Authorization header.
 */
import { randomUUID } from "node:crypto";
import { CircuitBreaker } from "./breaker.js";
import { TtlLru, cacheKey } from "./cache.js";
import type { JevQuestion, JevSituation, JevVerdict } from "./types.js";

export interface JevTransport {
  post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ status: number; json: unknown; ms: number }>;
}

function namedError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

export const fetchTransport: JevTransport = {
  async post(url, body, headers, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      return { status: res.status, json, ms: Date.now() - t0 };
    } catch (err) {
      // Never forward the original error: its text may echo request details.
      if (ctl.signal.aborted) throw namedError("TimeoutError", "jev request timed out");
      void err;
      throw namedError("NetworkError", "jev network error");
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * The values of the situation fields a question declares, for its cache key. A declared field the situation does not carry
 * reads as empty and never throws: the plugin's standalone situation carries fewer fields than the amygdala's, and a
 * throw here surfaced as a silent "no answer" for every step and outcome read (phase H).
 */
export function fieldValues(s: JevSituation, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const n of names) {
    out[n] =
      (s as unknown as Record<string, { value?: unknown } | null | undefined>)[n]?.value ?? "";
  }
  return out;
}

export function toEntry(q: JevQuestion): Record<string, unknown> {
  const c = q.criteria;
  if (q.type === "choice") {
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      throw new Error(`question ${q.id}: choice criteria must be an option map`);
    }
    return { type: "choice", instructions: q.instructions, criteria: c };
  }
  if (q.type === "score") {
    if (!Array.isArray(c) || c.length < 2 || c.length > 10) {
      throw new Error(`question ${q.id}: score criteria must be a list of 2-10 levels`);
    }
    return { type: "score", instructions: q.instructions, criteria: c };
  }
  const entry: Record<string, unknown> = { type: "noul", instructions: q.instructions };
  if (c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length > 0) {
    entry.criteria = c;
  }
  return entry;
}

export interface JevClientOptions<
  S extends JevSituation = JevSituation,
  Q extends JevQuestion = JevQuestion,
> {
  transport?: JevTransport;
  apiKey: () => string | undefined;
  baseUrl: string;
  model: string;
  /** Injected redaction (B4). May throw an Error whose name === "SendBlocked". */
  buildState: (s: S, qs: Q[]) => Record<string, unknown>;
  cache?: TtlLru<JevVerdict>;
  breaker?: CircuitBreaker;
  now?: () => number;
  usdPerMTokIn?: number;
  idGen?: () => string;
  /** How Jev answered (the availability source's `report`): a token arms on the first good answer, 401/403 refuses it. */
  report?: (r: { ok: true } | { ok: false; status?: number }) => void;
  /** The breaker's state after each call, with when it lets a probe through (the availability source's `noteBreaker`). */
  onBreaker?: (open: boolean, until?: number) => void;
}

type Skip = NonNullable<JevVerdict["skipped"]>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export class JevClient<S extends JevSituation = JevSituation, Q extends JevQuestion = JevQuestion> {
  private readonly transport: JevTransport;
  private readonly cache: TtlLru<JevVerdict>;
  private readonly breaker: CircuitBreaker;
  private readonly now: () => number;
  private readonly rate: number;
  private readonly idGen: () => string;

  constructor(private readonly o: JevClientOptions<S, Q>) {
    this.transport = o.transport ?? fetchTransport;
    this.now = o.now ?? Date.now;
    this.cache = o.cache ?? new TtlLru<JevVerdict>({ now: this.now });
    this.breaker = o.breaker ?? new CircuitBreaker({ now: this.now });
    this.rate = o.usdPerMTokIn ?? 0.042;
    this.idGen = o.idGen ?? randomUUID;
  }

  private skipped(s: S, q: Q, why: Skip): JevVerdict {
    return {
      id: this.idGen(),
      situationId: s.id,
      questionId: q.id,
      questionVersion: q.version,
      type: q.type,
      answer: q.type === "choice" ? "" : 0,
      prob: 0,
      confidence: 0,
      cacheHit: false,
      latencyMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      skipped: why,
      ts: this.now(),
    };
  }

  private breakerNote(): void {
    const until = this.breaker.retryAt;
    this.o.onBreaker?.(this.breaker.state === "open", until ?? undefined);
  }

  async ask(s: S, qs: Q[], o: { budgetMs?: number } = {}): Promise<JevVerdict[]> {
    const all = (why: Skip): JevVerdict[] => qs.map((q) => this.skipped(s, q, why));
    const key = this.o.apiKey();
    if (!key) return all("error");

    let state: Record<string, unknown>;
    try {
      state = this.o.buildState(s, qs);
    } catch (err) {
      if (err instanceof Error && err.name === "SendBlocked") return all("not-allowed");
      return all("error");
    }
    if (this.breaker.isOpen()) return all("breaker-open");

    const out: (JevVerdict | undefined)[] = new Array(qs.length).fill(undefined);
    const keys: string[] = [];
    const pending: number[] = [];
    qs.forEach((q, i) => {
      const k = cacheKey(q, fieldValues(s, q.fields));
      keys.push(k);
      const hit = this.cache.get(k);
      if (hit) {
        out[i] = {
          ...hit,
          id: this.idGen(),
          situationId: s.id,
          cacheHit: true,
          latencyMs: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          ts: this.now(),
        };
      } else {
        pending.push(i);
      }
    });
    if (pending.length === 0) return out as JevVerdict[];

    const fill = (why: Skip): void => {
      for (const i of pending) out[i] = this.skipped(s, qs[i], why);
    };

    const questions: Record<string, unknown> = {};
    for (const i of pending) questions[qs[i].id] = toEntry(qs[i]);
    const body = { model: this.o.model, state, questions };
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

    let res: { status: number; json: unknown; ms: number };
    try {
      res = await this.transport.post(
        `${this.o.baseUrl.replace(/\/+$/, "")}/v1/systemone`,
        body,
        headers,
        o.budgetMs ?? 2000,
      );
    } catch (err) {
      // Only the error's name is inspected; its message is never propagated (it could echo the key).
      this.breaker.recordFailure();
      this.breakerNote();
      this.o.report?.({ ok: false });
      fill(err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error");
      return out as JevVerdict[];
    }

    const json = res.json;
    const answers = isRecord(json) && isRecord(json.answers) ? json.answers : undefined;
    if (res.status !== 200 || !answers) {
      this.breaker.recordFailure();
      this.breakerNote();
      this.o.report?.({ ok: false, status: res.status });
      fill("error");
      return out as JevVerdict[];
    }

    const usage = isRecord(json) && isRecord(json.usage) ? json.usage : {};
    const tin = numOr0(usage.input_tokens) / pending.length;
    const tout = numOr0(usage.output_tokens) / pending.length;
    let anyMissing = false;
    for (const i of pending) {
      const q = qs[i];
      const v = this.toVerdict(s, q, answers[q.id], res.ms, tin, tout);
      if (!v) {
        anyMissing = true;
        out[i] = this.skipped(s, q, "error");
        continue;
      }
      out[i] = v;
      this.cache.set(keys[i], v);
    }
    if (anyMissing) this.breaker.recordFailure();
    else this.breaker.recordSuccess();
    this.breakerNote();
    this.o.report?.(anyMissing ? { ok: false, status: res.status } : { ok: true });
    return out as JevVerdict[];
  }

  private toVerdict(
    s: S,
    q: Q,
    a: unknown,
    ms: number,
    tokensIn: number,
    tokensOut: number,
  ): JevVerdict | undefined {
    if (!isRecord(a)) return undefined;
    let answer: string | number;
    let prob: number;
    let probs: Record<string, number> | undefined;
    if (q.type === "noul") {
      if (typeof a.noul !== "number") return undefined;
      answer = a.noul;
      prob = a.noul;
    } else if (q.type === "score") {
      if (typeof a.score !== "number" || !Array.isArray(q.criteria)) return undefined;
      answer = a.score;
      prob = a.score / (q.criteria.length - 1);
    } else {
      if (typeof a.choice !== "string") return undefined;
      answer = a.choice;
      probs = isRecord(a.probabilities) ? (a.probabilities as Record<string, number>) : undefined;
      prob = numOr0(probs?.[a.choice]);
    }
    const v: JevVerdict = {
      id: this.idGen(),
      situationId: s.id,
      questionId: q.id,
      questionVersion: q.version,
      type: q.type,
      answer,
      prob,
      confidence: numOr0(a.confidence),
      cacheHit: false,
      latencyMs: ms,
      tokensIn,
      tokensOut,
      costUsd: (tokensIn * this.rate) / 1e6,
      ts: this.now(),
    };
    if (probs) v.probs = probs;
    return v;
  }
}
