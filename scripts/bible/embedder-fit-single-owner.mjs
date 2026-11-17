#!/usr/bin/env node
/**
 * TINKER_UI_DESIGN_BIBLE/embedder-fit.md, Don't regress, made executable: the per-machine
 * embedding decision keeps one owner, and the code paths the 2026-10-28 backlog loop ran through
 * keep the shape that closed it.
 *
 * The optic EXPLAINS the decision, its thresholds and the governor; this file CHECKS that the
 * source still has the shape the optic describes (FOUNDATION.md, Three different jobs, three
 * different homes). The optic's verify: entries are one-line pointers here. When the two
 * disagree, the optic is right and this file is the bug.
 *
 * One check per rule, lettered as in the optic:
 *   (a) fit-core          src/fork/embedder-fit.ts exports decideEmbedderFit, applyEmbedderFit and
 *                         EMBEDDER_LADDER: one decision, one seam, one home of model names.
 *   (b) seam              resolveMemorySearchConfig returns only null or applyEmbedderFit(...).
 *   (c) runner-literal    the embedded runner names no ladder model and builds no ENGRAM embedding
 *                         worker. The ladder's names are read from the fit core, never listed here.
 *   (d) ollama-batch      the Ollama provider posts to /api/embed and calls no Promise.all.
 *   (e) no-id-deadline    the core index compares no provider id with local and keeps none of the
 *                         local/remote timeout constants.
 *   (f) governed-factory  the core provider factory imports and calls governEmbeddingProvider.
 *   (g) cache-seed        no prepare(...).all() reads the embedding cache, and the vectorDims
 *                         clause of needsFullReindex requires a provider.
 *   (h) prefrontal-off    the prefrontal embed RPC imports and calls isEmbeddingOff.
 *   (i) slot-settle       the governor frees a slot through releaseWhenSettled, and dispatch holds
 *                         the slot of a call it gave up on until the provider settles (holdSlot).
 *   (j) abort-not-failure a caller's own abort is counted as aborted and never reaches the
 *                         failure block that moves the breaker.
 *   (k) endpoint-url      the core factory hands the governor its client's base URL for every HTTP
 *                         provider, and skill search and the prefrontal RPC pass the resolver's.
 *   (l) fit-endpoint      fitBudgetFor requires an endpointKey and the governor passes its own.
 *   (m) adapter-signal    every core HTTP embedding adapter and the Ollama extension forward the
 *                         call's abort signal to their request.
 *
 * Usage:
 *   node scripts/bible/embedder-fit-single-owner.mjs                         # every check
 *   node scripts/bible/embedder-fit-single-owner.mjs --check=seam,cache-seed # some checks
 *   node scripts/bible/embedder-fit-single-owner.mjs --list                  # what each asserts
 *   node scripts/bible/embedder-fit-single-owner.mjs --self-test             # prove each goes RED
 *
 * Dependency-free (node builtins only). Every check prints what it SAW, and a file it cannot read
 * fails the check. Whole-line comments are blanked to spaces before matching, so offsets still map
 * onto the file and a comment that names the old shape does not count as the shape. These are text
 * checks: they hold a shape in place, and the unit tests of each module hold its behaviour.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const FIT = "src/fork/embedder-fit.ts";
const SEAM = "src/agents/memory-search.ts";
const RUNNER = "src/agents/embedded-agent-runner/extensions.ts";
const OLLAMA = "src/memory/embeddings-ollama.ts";
const EMBED_OPS = "src/memory/manager-embedding-ops.ts";
const FACTORY = "src/memory/embeddings.ts";
const SYNC_OPS = "src/memory/manager-sync-ops.ts";
const PREFRONTAL = "src/fork/prefrontal-state-rpc.ts";
const GOVERNOR = "src/fork/embedder-governor.ts";
const SKILL = "src/memory/engram/skill-embed.ts";
const POST_JSON = "src/memory/post-json.ts";
const REMOTE_FETCH = "src/memory/embeddings-remote-fetch.ts";
const REMOTE_PROVIDER = "src/memory/embeddings-remote-provider.ts";
const VOYAGE = "src/memory/embeddings-voyage.ts";
const GEMINI = "src/memory/embeddings-gemini.ts";
const OLLAMA_EXT = "extensions/ollama/src/embedding-provider.ts";
const FILES = [
  FIT,
  SEAM,
  RUNNER,
  OLLAMA,
  EMBED_OPS,
  FACTORY,
  SYNC_OPS,
  PREFRONTAL,
  GOVERNOR,
  SKILL,
  POST_JSON,
  REMOTE_FETCH,
  REMOTE_PROVIDER,
  VOYAGE,
  GEMINI,
  OLLAMA_EXT,
];

/**
 * The source with whole-line comments (line comments, JSDoc lines, block comments that start a
 * line) blanked to spaces of the same length, so an offset into the result is an offset into the
 * file. A comment after code on the same line is kept; the formatter puts prose on its own lines.
 */
function codeOnly(text) {
  let inBlock = false;
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      const blank = " ".repeat(line.length);
      if (inBlock) {
        if (t.includes("*/")) {
          inBlock = false;
        }
        return blank;
      }
      if (t.startsWith("/*")) {
        inBlock = !t.includes("*/");
        return blank;
      }
      return t.startsWith("//") || t.startsWith("*") ? blank : line;
    })
    .join("\n");
}

function count(text, re) {
  return (text.match(re) ?? []).length;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** An import of `name`, alone or among others, from a module path ending in `file`. */
function importRe(name, file) {
  const tail = file.replaceAll(".", String.raw`\.`);
  return new RegExp(
    String.raw`import\s*\{[^}]*\b${name}\b[^}]*\}\s*from\s*["'][^"']*${tail}["'];?`,
  );
}

function gone(rel) {
  return { ok: false, saw: `MISSING ${rel}: gone or unreadable, so re-derive this check` };
}

/** A class method's text, from `signature` to its closing brace at two-space indent. */
function methodBody(code, signature) {
  const at = code.indexOf(signature);
  if (at < 0) {
    return undefined;
  }
  const end = code.indexOf("\n  }\n", at);
  return code.slice(at, end < 0 ? undefined : end);
}

/** The ladder's model names, read from the LADDER array of the fit core: never a list kept here. */
function ladderModels(fitSource) {
  if (fitSource === undefined) {
    return [];
  }
  const c = codeOnly(fitSource);
  const start = /const LADDER\b[^=]*=\s*\[/.exec(c);
  if (!start) {
    return [];
  }
  const end = c.indexOf("\n];", start.index);
  const block = c.slice(start.index, end < 0 ? undefined : end);
  return [...block.matchAll(/^\s*model:\s*"([^"]+)"/gm)].map((m) => m[1]);
}

/**
 * The parenthesised clause of `const needsFullReindex = ...` that mentions vectorDims, with its
 * offsets, or the reason it cannot be found.
 */
function vectorDimsClause(code) {
  const at = code.indexOf("const needsFullReindex =");
  if (at < 0) {
    return { error: "no `const needsFullReindex =` expression" };
  }
  const semi = code.indexOf(";", at);
  const end = semi < 0 ? code.length : semi;
  const dims = code.indexOf("vectorDims", at);
  if (dims < 0 || dims > end) {
    return { error: "needsFullReindex has no vectorDims clause" };
  }
  let depth = 0;
  let open = -1;
  for (let i = dims; i > at; i--) {
    if (code[i] === ")") {
      depth += 1;
    } else if (code[i] === "(") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth -= 1;
    }
  }
  if (open < 0) {
    return { error: "the vectorDims clause of needsFullReindex is not parenthesised" };
  }
  depth = 0;
  for (let i = open; i < end; i++) {
    if (code[i] === "(") {
      depth += 1;
    } else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return { start: open, end: i + 1, text: code.slice(open, i + 1).replace(/\s+/g, " ") };
      }
    }
  }
  return { error: "the vectorDims clause of needsFullReindex is not closed" };
}

/** `text` with `snippet` inserted right after the `{` that opens the body following `marker`. */
function insertAfterOpen(text, marker, snippet) {
  const at = text.indexOf(marker);
  const open = at < 0 ? -1 : text.indexOf("{\n", at);
  return open < 0 ? text : `${text.slice(0, open + 1)}${snippet}${text.slice(open + 1)}`;
}

/**
 * Each check returns {ok, saw}. Every mutant rewrites the sources the way a regression would and
 * MUST turn its check red: that is what --self-test proves.
 */
const CHECKS = {
  "fit-core": {
    letter: "a",
    title: `${FIT} exports decideEmbedderFit, applyEmbedderFit and EMBEDDER_LADDER`,
    run(src) {
      if (src[FIT] === undefined) {
        return gone(FIT);
      }
      const c = codeOnly(src[FIT]);
      const want = [
        ["decideEmbedderFit", /^export function decideEmbedderFit\(/m],
        ["applyEmbedderFit", /^export function applyEmbedderFit\b/m],
        ["EMBEDDER_LADDER", /^export const EMBEDDER_LADDER\b/m],
      ];
      const absent = want.filter(([, re]) => !re.test(c)).map(([name]) => name);
      return {
        ok: absent.length === 0,
        saw:
          absent.length === 0
            ? `${FIT} exports ${want.map(([name]) => name).join(", ")}`
            : `${FIT} no longer exports ${absent.join(", ")}`,
      };
    },
    why:
      "the decision, the seam every consumer reads it through and the ladder of measured models " +
      "live in one module (design principle #18). If one moves, embedder-fit.md points at a module " +
      "that no longer owns it, and the next change writes a second decision.",
    mutants: [
      (src) => ({
        ...src,
        [FIT]: src[FIT].replace(
          "export function decideEmbedderFit(",
          "function decideEmbedderFit(",
        ),
      }),
      (src) => ({
        ...src,
        [FIT]: src[FIT].replace("export function applyEmbedderFit", "export function applyFit"),
      }),
      (src) => ({
        ...src,
        [FIT]: src[FIT].replace("export const EMBEDDER_LADDER", "const EMBEDDER_LADDER"),
      }),
    ],
  },

  seam: {
    letter: "b",
    title: "resolveMemorySearchConfig returns only null or applyEmbedderFit(...)",
    run(src) {
      if (src[SEAM] === undefined) {
        return gone(SEAM);
      }
      const c = codeOnly(src[SEAM]);
      const imported = importRe("applyEmbedderFit", "embedder-fit.js").test(c);
      const start = c.indexOf("export function resolveMemorySearchConfig(");
      if (start < 0) {
        return { ok: false, saw: `${SEAM}: export function resolveMemorySearchConfig not found` };
      }
      const end = c.indexOf("\n}\n", start);
      const body = c.slice(start, end < 0 ? undefined : end);
      const returns = [...body.matchAll(/\breturn\b([^;]*);/g)].map((m) => m[1].trim());
      const through = returns.filter((r) => r.startsWith("applyEmbedderFit("));
      const other = returns.filter((r) => r !== "null" && !r.startsWith("applyEmbedderFit("));
      return {
        ok: imported && through.length > 0 && other.length === 0,
        saw:
          `${SEAM}: applyEmbedderFit imported from the fit core: ${imported}; ` +
          `resolveMemorySearchConfig returns [${returns.join(" | ")}]`,
      };
    },
    why:
      "applyEmbedderFit is the single seam: an unset or auto provider becomes the fit's choice, or " +
      "none, before any factory sees it. A return that skips it hands auto to the factories, whose " +
      "own auto branches pick the first keyed remote provider, so memory text would leave the " +
      "machine with no consent.",
    mutants: [
      (src) => ({
        ...src,
        [SEAM]: src[SEAM].replace("return applyEmbedderFit(resolved);", "return resolved;"),
      }),
      (src) => ({
        ...src,
        [SEAM]: src[SEAM].replace(importRe("applyEmbedderFit", "embedder-fit.js"), ""),
      }),
      (src) => ({
        ...src,
        [SEAM]: insertAfterOpen(
          src[SEAM],
          "export function resolveMemorySearchConfig(",
          `\n  if (agentId === "probe") {\n    return mergeConfig(cfg, undefined, undefined, agentId);\n  }`,
        ),
      }),
    ],
  },

  "runner-literal": {
    letter: "c",
    title: "the embedded runner names no ladder model and builds no ENGRAM embedding worker",
    run(src) {
      if (src[RUNNER] === undefined) {
        return gone(RUNNER);
      }
      const models = ladderModels(src[FIT]);
      if (models.length === 0) {
        return { ok: false, saw: `${FIT}: no model names readable from its LADDER array` };
      }
      const c = codeOnly(src[RUNNER]);
      const named = models.filter((m) => c.includes(m));
      const workers = count(c, /\bcreateEmbeddingWorker\b/g);
      return {
        ok: named.length === 0 && workers === 0,
        saw:
          `${RUNNER}: ladder model literals [${named.join(", ")}] of ${models.length} on the ` +
          `ladder; createEmbeddingWorker references ${workers}`,
      };
    },
    why:
      "the runner built an ENGRAM embedding worker with a literal mxbai-embed-large: a second " +
      "embedder on the live host whose vectors nothing read, and 907 log lines saying hybrid " +
      "retrieval was active. A consumer takes its model from the fit, never from a literal.",
    mutants: [
      (src) => ({
        ...src,
        [RUNNER]: `${src[RUNNER]}\nconst legacyModel = "${ladderModels(src[FIT])[0]}";\n`,
      }),
      (src) => ({
        ...src,
        [RUNNER]: `import { createEmbeddingWorker } from "../../memory/engram/embedding-worker.js";\n${src[RUNNER]}`,
      }),
    ],
  },

  "ollama-batch": {
    letter: "d",
    title: "the Ollama provider posts to /api/embed and calls no Promise.all",
    run(src) {
      if (src[OLLAMA] === undefined) {
        return gone(OLLAMA);
      }
      const c = codeOnly(src[OLLAMA]);
      const batchUrl = /\/api\/embed[`"']/.test(c);
      const fanOut = count(c, /\bPromise\.all(?:Settled)?\(/g);
      return {
        ok: batchUrl && fanOut === 0,
        saw: `${OLLAMA}: an /api/embed request URL: ${batchUrl}; Promise.all or allSettled calls: ${fanOut}`,
      };
    },
    why:
      "on 2026-10-28 the provider sent one /api/embeddings request per text, all at once: about 5 " +
      "per batch times 4 files, about 20 in flight into a server with one slot, and served " +
      "latencies up to 1,560 s. One POST /api/embed carries a whole batch, and the governor keeps " +
      "one request in flight per local server.",
    mutants: [
      (src) => ({
        ...src,
        [OLLAMA]: src[OLLAMA].replace(/\/api\/embed(?=[`"'])/g, "/api/embeddings"),
      }),
      (src) => ({
        ...src,
        [OLLAMA]: `${src[OLLAMA]}\nconst fanOut = (texts, embedOne) => Promise.all(texts.map(embedOne));\n`,
      }),
    ],
  },

  "no-id-deadline": {
    letter: "e",
    title: "the core index keys no deadline on provider id",
    run(src) {
      if (src[EMBED_OPS] === undefined) {
        return gone(EMBED_OPS);
      }
      const c = codeOnly(src[EMBED_OPS]);
      // Both spellings of the rule, either way round: `this.provider?.id === "local"` (the core
      // index until 2026-10-29) and `providerId === "local"` (memory-core's declared twin).
      const idRule = count(
        c,
        /(?:\.id|\bproviderId)\s*[!=]==\s*["']local["']|["']local["']\s*[!=]==\s*[\w$.?]*(?:\.id|providerId)\b/g,
      );
      const split = count(c, /\bEMBEDDING_(?:QUERY|BATCH)_TIMEOUT_(?:LOCAL|REMOTE)_MS\b/g);
      return {
        ok: idRule === 0 && split === 0,
        saw:
          `${EMBED_OPS}: comparisons of a provider id with local ${idRule}; references to the ` +
          `local/remote timeout constants ${split}`,
      };
    },
    why:
      "isLocal, the provider id compared with local, counted only in-process node-llama-cpp as " +
      "local, so Ollama on loopback got the 120 s remote race, and the race never aborted anything. " +
      "The governor derives every deadline (requestDeadlineMs), and an endpoint is classified by " +
      "classifyEmbeddingEndpoint, never by its provider id.",
    mutants: [
      (src) => ({
        ...src,
        [EMBED_OPS]: `${src[EMBED_OPS]}\nconst isLocal = this.provider?.id === "local";\n`,
      }),
      (src) => ({
        ...src,
        [EMBED_OPS]: `${src[EMBED_OPS]}\nconst EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;\n`,
      }),
      (src) => ({
        ...src,
        [EMBED_OPS]: `${src[EMBED_OPS]}\nconst batchMs = params.providerId === "local" ? 600_000 : 120_000;\n`,
      }),
    ],
  },

  "governed-factory": {
    letter: "f",
    title: "the core provider factory imports and calls governEmbeddingProvider",
    run(src) {
      if (src[FACTORY] === undefined) {
        return gone(FACTORY);
      }
      const c = codeOnly(src[FACTORY]);
      const imported = importRe("governEmbeddingProvider", "embedder-governor.js").test(c);
      const calls = count(c, /\bgovernEmbeddingProvider\(/g);
      return {
        ok: imported && calls > 0,
        saw: `${FACTORY}: governEmbeddingProvider imported from the governor: ${imported}; calls ${calls}`,
      };
    },
    why:
      "every provider createEmbeddingProvider returns, auto, primary or fallback, goes through its " +
      "endpoint's queue, deadline and breaker. An ungoverned provider is a producer the queue cannot " +
      "see: on 2026-10-28 a second producer held the one Ollama slot for 148 to 1,550 s per call.",
    mutants: [
      (src) => ({
        ...src,
        [FACTORY]: src[FACTORY].replace(/\bgovernEmbeddingProvider\(/g, "keepEmbeddingProvider("),
      }),
      (src) => ({
        ...src,
        [FACTORY]: src[FACTORY].replace(
          importRe("governEmbeddingProvider", "embedder-governor.js"),
          "",
        ),
      }),
    ],
  },

  "cache-seed": {
    letter: "g",
    title:
      "no prepare(...).all() reads the embedding cache, and the vectorDims reindex clause requires a provider",
    run(src) {
      if (src[SYNC_OPS] === undefined) {
        return gone(SYNC_OPS);
      }
      const c = codeOnly(src[SYNC_OPS]);
      const reads = [];
      for (const m of c.matchAll(
        /\.prepare\(\s*(`[^`]*`|"[^"\n]*"|'[^'\n]*')\s*,?\s*\)\s*\.all\(/g,
      )) {
        if (/EMBEDDING_CACHE_TABLE|embedding_cache/.test(m[1])) {
          reads.push(lineOf(c, m.index));
        }
      }
      const clause = vectorDimsClause(c);
      const gated =
        clause.error === undefined &&
        /provider/i.test(clause.text.replace(/\bmeta\??\.provider\w*/g, ""));
      return {
        ok: reads.length === 0 && gated,
        saw:
          `${SYNC_OPS}: prepare(...).all() reads of the embedding cache ${reads.length}` +
          `${reads.length > 0 ? ` (line ${reads.join(", ")})` : ""}; the vectorDims reindex ` +
          `clause ${clause.error ?? clause.text} requires a provider: ${gated}`,
      };
    },
    why:
      "the reindex seed read the whole embedding cache (about 171k rows, an estimated 4.3 GB of " +
      "JSON) with one synchronous .all() on the gateway's main thread; the matching rows are copied " +
      "inside SQLite instead. And (vectorReady && !meta?.vectorDims) on its own makes a word-only or " +
      "dormant index rebuild itself on every sync, because such an index never writes vectorDims.",
    mutants: [
      (src) => ({
        ...src,
        [SYNC_OPS]:
          src[SYNC_OPS] +
          "\nconst rows = sourceDb.prepare(`SELECT provider, model, hash, embedding FROM embedding_cache`).all();\n",
      }),
      (src) => {
        const clause = vectorDimsClause(codeOnly(src[SYNC_OPS]));
        if (clause.error !== undefined) {
          return src;
        }
        const t = src[SYNC_OPS];
        return {
          ...src,
          [SYNC_OPS]: `${t.slice(0, clause.start)}(vectorReady && !meta?.vectorDims)${t.slice(clause.end)}`,
        };
      },
    ],
  },

  "prefrontal-off": {
    letter: "h",
    title: "the prefrontal embed RPC imports and calls isEmbeddingOff",
    run(src) {
      if (src[PREFRONTAL] === undefined) {
        return gone(PREFRONTAL);
      }
      const c = codeOnly(src[PREFRONTAL]);
      const imported = importRe("isEmbeddingOff", "embedder-fit.js").test(c);
      const calls = count(c, /\bisEmbeddingOff\(/g);
      return {
        ok: imported && calls > 0,
        saw: `${PREFRONTAL}: isEmbeddingOff imported from the fit core: ${imported}; calls ${calls}`,
      };
    },
    why:
      "a machine whose decision is none makes no embedding call and builds no provider: the RPC " +
      "answers armed false at once. Without the check, provider none reaches the adapter registry, " +
      "which throws Unknown memory embedding provider: none on every weak-lexical turn.",
    mutants: [
      (src) => ({
        ...src,
        [PREFRONTAL]: src[PREFRONTAL].replace(/\bisEmbeddingOff\(/g, "isEmbeddingOn("),
      }),
      (src) => ({
        ...src,
        [PREFRONTAL]: src[PREFRONTAL].replace(importRe("isEmbeddingOff", "embedder-fit.js"), ""),
      }),
    ],
  },

  "slot-settle": {
    letter: "i",
    title: "the governor frees a slot only once its call settles, holding a given-up call's slot",
    run(src) {
      if (src[GOVERNOR] === undefined) {
        return gone(GOVERNOR);
      }
      const c = codeOnly(src[GOVERNOR]);
      const runBody = methodBody(c, "async run<T>(");
      const dispatch = methodBody(c, "private async dispatch<T>(");
      if (runBody === undefined || dispatch === undefined) {
        return { ok: false, saw: `${GOVERNOR}: run() or dispatch() not found` };
      }
      const settles = runBody.includes("this.releaseWhenSettled(slot)");
      const direct = count(runBody, /this\.release\(slot\)/g);
      const holds = count(dispatch, /this\.holdSlot\(slot, running,/g);
      return {
        ok: settles && direct === 0 && holds > 0,
        saw:
          `${GOVERNOR}: run() frees its slot through releaseWhenSettled: ${settles}; direct ` +
          `release(slot) calls in run(): ${direct}; holdSlot calls in dispatch(): ${holds}`,
      };
    },
    why:
      "a call given up at its deadline or by its caller may still be running at the provider. " +
      "Freeing its slot when the caller is answered lets the next call start beside it, so more " +
      "requests run than the endpoint's concurrency (review finding 1, reproduced with two " +
      "timed-out calls at once on concurrency 1). The slot is freed when the provider settles, or " +
      "one more deadline later.",
    mutants: [
      (src) => ({
        ...src,
        [GOVERNOR]: src[GOVERNOR].replace("this.releaseWhenSettled(slot);", "this.release(slot);"),
      }),
      (src) => ({
        ...src,
        [GOVERNOR]: src[GOVERNOR].replace("this.holdSlot(slot, running, holdMs);", "void holdMs;"),
      }),
    ],
  },

  "abort-not-failure": {
    letter: "j",
    title: "a caller's own abort is counted as aborted and never reaches the failure block",
    run(src) {
      if (src[GOVERNOR] === undefined) {
        return gone(GOVERNOR);
      }
      const dispatch = methodBody(codeOnly(src[GOVERNOR]), "private async dispatch<T>(") ?? "";
      const guard = /if \(([^)]*)isEndpointFailure\(err\)\)/.exec(dispatch);
      const branch = /else if \(callerAborted\) \{([^}]*)\}/.exec(dispatch);
      const counted = branch !== null && /\.aborted \+= 1;/.test(branch[1]);
      const leaves =
        branch !== null && /throw err;/.test(branch[1]) && !/noteFailure\(/.test(branch[1]);
      const clean = guard !== null && !guard[1].includes("callerAborted");
      return {
        ok: counted && leaves && clean,
        saw:
          `${GOVERNOR}: the failure test in dispatch() is [${guard ? `${guard[1]}isEndpointFailure(err)` : "not found"}]; ` +
          `the callerAborted branch counts aborted: ${counted}, throws before the failure block: ${leaves}`,
      };
    },
    why:
      "a caller that gives up says nothing about the endpoint. Counting its abort as a failure let " +
      "five cancelled searches open a healthy local breaker for every consumer, and a cancelled " +
      "half-open probe reopen it with a doubled cool-down (review finding 5). The abort is counted " +
      "apart and leaves the breaker as it was.",
    mutants: [
      (src) => ({
        ...src,
        [GOVERNOR]: src[GOVERNOR].replace(
          "if (expired || isEndpointFailure(err)) {",
          "if (expired || callerAborted || isEndpointFailure(err)) {",
        ),
      }),
      (src) => ({
        ...src,
        [GOVERNOR]: src[GOVERNOR].replace(
          "this.today(env.now()).aborted += 1;\n        throw err;",
          "this.today(env.now()).aborted += 1;",
        ),
      }),
    ],
  },

  "endpoint-url": {
    letter: "k",
    title: "every governed HTTP provider is handed the base URL it calls",
    run(src) {
      for (const rel of [SKILL, PREFRONTAL, FACTORY]) {
        if (src[rel] === undefined) {
          return gone(rel);
        }
      }
      const skillCalls = count(codeOnly(src[SKILL]), /\bresolveEmbeddingEndpointBaseUrl\(/g);
      const prefrontalCalls = count(
        codeOnly(src[PREFRONTAL]),
        /\bresolveEmbeddingEndpointBaseUrl\(/g,
      );
      const factory = codeOnly(src[FACTORY]);
      const pick = /const client =\s*([^;]*);/.exec(factory);
      const clients = ["openAi", "gemini", "voyage", "mistral", "ollama"];
      const missing = pick
        ? clients.filter((k) => !new RegExp(String.raw`\bcreated\.${k}\b`).test(pick[1]))
        : clients;
      const passed = /baseUrl: client\.baseUrl/.test(factory);
      return {
        ok: skillCalls > 0 && prefrontalCalls > 0 && missing.length === 0 && passed,
        saw:
          `${SKILL}: resolveEmbeddingEndpointBaseUrl calls ${skillCalls}; ${PREFRONTAL}: ` +
          `${prefrontalCalls}; ${FACTORY}: the client URL comes from ` +
          `[${pick ? pick[1].replace(/\s+/g, " ").trim() : "no const client"}], missing ` +
          `${missing.join(", ") || "none"}, handed to the governor: ${passed}`,
      };
    },
    why:
      "the governor keys its queue and classifies the endpoint by the base URL it is handed. When " +
      "only Ollama passed one, a loopback OpenAI-compatible server was classed remote (4 in " +
      "flight, no breaker, no idle gate) and two servers of one provider shared one queue (review " +
      "finding 2). Every consumer of one server must land on one key.",
    mutants: [
      (src) => ({
        ...src,
        [SKILL]: src[SKILL].replace(
          "resolveEmbeddingEndpointBaseUrl({",
          "resolveOllamaEmbeddingBaseUrl({",
        ),
      }),
      (src) => ({
        ...src,
        [PREFRONTAL]: src[PREFRONTAL].replace(
          "resolveEmbeddingEndpointBaseUrl({",
          "resolveOllamaEmbeddingBaseUrl({",
        ),
      }),
      (src) => ({
        ...src,
        [FACTORY]: src[FACTORY].replace("created.openAi ?? created.gemini ?? ", ""),
      }),
    ],
  },

  "fit-endpoint": {
    letter: "l",
    title: "fitBudgetFor requires an endpointKey and the governor passes its own",
    run(src) {
      for (const rel of [FIT, GOVERNOR]) {
        if (src[rel] === undefined) {
          return gone(rel);
        }
      }
      const sig = /export function fitBudgetFor\(\s*p:\s*\{([^}]*)\}/.exec(codeOnly(src[FIT]));
      const required = sig !== null && /\bendpointKey:\s*string\b/.test(sig[1]);
      const calls = [...codeOnly(src[GOVERNOR]).matchAll(/fitBudgetFor\(\s*\{([^}]*)\}/g)].map(
        (m) => m[1].replace(/\s+/g, " ").trim(),
      );
      const passing = calls.filter((a) => /\bendpointKey:\s*this\.endpointKey\b/.test(a));
      return {
        ok: required && calls.length > 0 && passing.length === calls.length,
        saw:
          `${FIT}: fitBudgetFor requires endpointKey: ${required}; ${GOVERNOR}: fitBudgetFor ` +
          `calls ${calls.length}, passing this.endpointKey ${passing.length}`,
      };
    },
    why:
      "a fit's measurements describe the endpoint it measured. Read by provider and model alone, a " +
      "fit taken at a remote server gave a machine-local one 4 requests in flight (review finding " +
      "3, reproduced). The record counts only at its own endpoint; elsewhere the governor runs as " +
      "if unmeasured, 1 in flight on a local server.",
    mutants: [
      (src) => ({
        ...src,
        [FIT]: src[FIT].replace(
          "model: string; endpointKey: string }",
          "model: string; endpointKey?: string }",
        ),
      }),
      (src) => ({
        ...src,
        [GOVERNOR]: src[GOVERNOR].replace("model, endpointKey: this.endpointKey }", "model }"),
      }),
    ],
  },

  "adapter-signal": {
    letter: "m",
    title: "every core HTTP embedding adapter and the Ollama extension forward the abort signal",
    run(src) {
      const want = [
        [POST_JSON, /\bsignal: params\.signal\b/],
        [REMOTE_FETCH, /\bsignal: params\.signal\b/],
        [REMOTE_PROVIDER, /\bsignal: opts\?\.signal\b/],
        [VOYAGE, /\bsignal: opts\?\.signal\b/],
        [GEMINI, /\bsignal: opts\?\.signal\b/],
        [OLLAMA, /\bsignal: opts\?\.signal\b/],
        [OLLAMA_EXT, /\bembedMany\([^)]*opts\?\.signal\)/],
      ];
      const unreadable = want.filter(([rel]) => src[rel] === undefined).map(([rel]) => rel);
      if (unreadable.length > 0) {
        return gone(unreadable.join(", "));
      }
      const without = want.filter(([rel, re]) => !re.test(codeOnly(src[rel]))).map(([rel]) => rel);
      return {
        ok: without.length === 0,
        saw:
          without.length === 0
            ? `the call's signal reaches the request in all ${want.length} adapter paths`
            : `no signal forwarded in ${without.join(", ")}`,
      };
    },
    why:
      "the governor gives up on a call by aborting the signal it hands the provider. An adapter " +
      "that drops it leaves the request running at the server after the governor has moved on " +
      "(review finding 1, the provider half): that is how requests piled into one slot on " +
      "2026-10-28.",
    mutants: [
      (src) => ({
        ...src,
        [POST_JSON]: src[POST_JSON].replace(/\bsignal: params\.signal,?/, ""),
      }),
      (src) => ({
        ...src,
        [REMOTE_PROVIDER]: src[REMOTE_PROVIDER].replace(/\bsignal: opts\?\.signal,?/g, ""),
      }),
      (src) => ({
        ...src,
        [GEMINI]: src[GEMINI].replace(/\bsignal: opts\?\.signal,?/g, ""),
      }),
      (src) => ({
        ...src,
        [OLLAMA_EXT]: src[OLLAMA_EXT].replace("embedMany(texts, opts?.signal)", "embedMany(texts)"),
      }),
    ],
  },
};

function loadSources() {
  const src = {};
  for (const rel of FILES) {
    try {
      src[rel] = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    } catch {
      src[rel] = undefined;
    }
  }
  return src;
}

function sameSources(a, b) {
  return FILES.every((rel) => a[rel] === b[rel]);
}

const args = process.argv.slice(2);
const picked = (args.find((a) => a.startsWith("--check=")) ?? "")
  .slice("--check=".length)
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const unknown = picked.filter((id) => !Object.hasOwn(CHECKS, id));
if (unknown.length > 0) {
  console.error(`unknown --check=${unknown.join(",")}; known: ${Object.keys(CHECKS).join(", ")}`);
  process.exit(2);
}
const ids = picked.length > 0 ? picked : Object.keys(CHECKS);

if (args.includes("--list")) {
  for (const id of ids) {
    const check = CHECKS[id];
    console.log(`(${check.letter}) ${id}: ${check.title}`);
    console.log(`    why: ${check.why}`);
  }
  process.exit(0);
}

const src = loadSources();

if (args.includes("--self-test")) {
  console.log(
    "embedder-fit.md gate self-test: each check must be green here and red under every mutant",
  );
  let bad = 0;
  for (const id of ids) {
    const check = CHECKS[id];
    const base = check.run(src);
    if (!base.ok) {
      console.log(`  ✗ (${check.letter}) ${id}: already RED on this tree: ${base.saw}`);
      bad += 1;
      continue;
    }
    let tripped = 0;
    for (const [n, mutate] of check.mutants.entries()) {
      const mutated = mutate(src);
      if (sameSources(mutated, src)) {
        console.log(
          `  ✗ (${check.letter}) ${id}: mutant #${n} did not apply (its anchor moved); update it`,
        );
        bad += 1;
      } else if (check.run(mutated).ok) {
        console.log(
          `  ✗ (${check.letter}) ${id}: mutant #${n} did NOT trip the check, so it cannot see its regression`,
        );
        bad += 1;
      } else {
        tripped += 1;
      }
    }
    const mark = tripped === check.mutants.length ? "✓" : "✗";
    console.log(
      `  ${mark} (${check.letter}) ${id}: green here, red under ${tripped} of ${check.mutants.length} mutant(s)`,
    );
  }
  console.log(bad === 0 ? "SELF-TEST PASS" : `SELF-TEST FAIL (${bad})`);
  process.exit(bad === 0 ? 0 : 1);
}

let failed = 0;
for (const id of ids) {
  const check = CHECKS[id];
  const r = check.run(src);
  console.log(`${r.ok ? "✓" : "✗"} (${check.letter}) ${id}: ${check.title}`);
  console.log(`    saw: ${r.saw}`);
  if (!r.ok) {
    console.log(`    → ${check.why}`);
    failed += 1;
  }
}
if (failed > 0) {
  console.error(
    `FAIL: ${failed} check(s) red; see TINKER_UI_DESIGN_BIBLE/embedder-fit.md, Don't regress`,
  );
  process.exit(1);
}
console.log(`PASS: ${ids.join(", ")}`);
