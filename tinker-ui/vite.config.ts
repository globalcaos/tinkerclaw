import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

// Read gateway token from openclaw config for dev mode auth injection
function readGatewayToken(): string {
  try {
    const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    return cfg?.gateway?.auth?.token ?? "";
  } catch {
    return "";
  }
}

// Inject __TINKER_CONFIG into the HTML in dev mode (mirrors what the plugin does in prod)
function tinkerDevConfig(): Plugin {
  return {
    name: "tinker-dev-config",
    apply: "serve",
    transformIndexHtml(html) {
      const cfg = JSON.stringify({ token: readGatewayToken() });
      return html.replace("</head>", `<script>window.__TINKER_CONFIG=${cfg}</script>\n</head>`);
    },
  };
}

// Dev-only endpoint: POST /api/open-file { path: "relative/path.md" }
// Opens the file in the native OS editor via xdg-open (Linux).
function openFilePlugin(): Plugin {
  const tinkerclaw = path.resolve(__dirname, "..");
  return {
    name: "tinker-open-file",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/open-file", (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end("Method not allowed");
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const { path: filePath } = JSON.parse(body);
            if (!filePath || typeof filePath !== "string") {
              res.writeHead(400);
              res.end("Missing path");
              return;
            }
            // Resolve relative to tinkerclaw root, prevent path traversal
            const resolved = path.resolve(tinkerclaw, filePath);
            if (!resolved.startsWith(tinkerclaw)) {
              res.writeHead(403);
              res.end("Path outside project");
              return;
            }
            if (!fs.existsSync(resolved)) {
              res.writeHead(404);
              res.end("File not found");
              return;
            }
            execFile("xdg-open", [resolved], (err) => {
              if (err) {
                console.error(`[open-file] xdg-open failed: ${err.message}`);
              }
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, path: resolved }));
          } catch {
            res.writeHead(400);
            res.end("Invalid JSON");
          }
        });
      });
    },
  };
}

// Dev-only endpoint: GET /api/kit-content?path=<relative-or-absolute>
// Returns { path, content, isDownloaded } — mirrors /tinker/api/kit-content in production.
// POST /api/save-file { path, content } — atomic write within kit directories.
function kitContentPlugin(): Plugin {
  const tinkerclaw = path.resolve(__dirname, "..");
  const workspaceKits = path.join(os.homedir(), ".openclaw/workspace/kits");
  return {
    name: "tinker-kit-content",
    apply: "serve",
    configureServer(server) {
      // GET /api/kit-content
      server.middlewares.use("/api/kit-content", (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end("Method not allowed");
          return;
        }
        const u = new URL(req.url ?? "/", "http://localhost");
        const rawPath = u.searchParams.get("path") ?? "";
        if (!rawPath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "path param required" }));
          return;
        }
        const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(tinkerclaw, rawPath);
        const inTinkerclaw =
          resolved.startsWith(tinkerclaw + path.sep) || resolved.startsWith(tinkerclaw + "/");
        const inWorkspaceKits =
          resolved.startsWith(workspaceKits + path.sep) || resolved.startsWith(workspaceKits + "/");
        if (!inTinkerclaw && !inWorkspaceKits) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Path outside allowed kit directories" }));
          return;
        }
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isFile()) throw new Error("not a file");
          if (stat.size > 512 * 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "File too large" }));
            return;
          }
          const content = fs.readFileSync(resolved, "utf-8");
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          res.end(JSON.stringify({ path: resolved, content, isDownloaded: inWorkspaceKits }));
        } catch (err: unknown) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message ?? "File not found" }));
        }
      });

      // POST /api/save-file
      server.middlewares.use("/api/save-file", (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end("Method not allowed");
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { path?: unknown; content?: unknown };
            if (typeof parsed.path !== "string" || typeof parsed.content !== "string") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "path and content required" }));
              return;
            }
            const resolved = path.isAbsolute(parsed.path)
              ? parsed.path
              : path.resolve(tinkerclaw, parsed.path);
            const inTinkerclaw =
              resolved.startsWith(tinkerclaw + path.sep) || resolved.startsWith(tinkerclaw + "/");
            const inWorkspaceKits =
              resolved.startsWith(workspaceKits + path.sep) ||
              resolved.startsWith(workspaceKits + "/");
            if (!inTinkerclaw && !inWorkspaceKits) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Path outside allowed kit directories" }));
              return;
            }
            // Atomic write: .tmp then rename
            const tmpPath = resolved + ".tmp";
            try {
              fs.mkdirSync(path.dirname(resolved), { recursive: true });
              fs.writeFileSync(tmpPath, parsed.content as string, "utf-8");
              fs.renameSync(tmpPath, resolved);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true }));
            } catch (writeErr: unknown) {
              try {
                fs.unlinkSync(tmpPath);
              } catch {}
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: (writeErr as Error).message ?? "Write failed" }));
            }
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
          }
        });
      });
    },
  };
}

// Dev-only endpoints: GET  /api/ui-state -> { collapsed, flags, choices, tabs? }
//                     POST /api/ui-state { collapsed, flags, choices, tabs? } -> atomic write
// Durable, file-backed UI chrome state (collapsed panels, pressed top-bar buttons,
// active tab, and — since 2026-08-16 — the OPEN TAB LIST itself). It lives in a FILE and
// not in localStorage on purpose: this browser runs with session-only cookies +
// clear-on-exit, so every clean browser close discards localStorage. Disk is the only
// thing that survives that.
//
// `tabs` is the one section that is an ARRAY, and the one section whose ABSENCE from a
// POST body means "no opinion, keep what you have" rather than "clear it". The three maps
// cannot afford that rule — for them absence is how a control says "back to default", so
// preserving it would resurrect every deletion (see the long note in the POST handler).
// A tab list has no per-key defaults to express, so the safe reading is the plain one,
// and it is what lets a store written before this key existed survive its first POST.
//
// THE CLIENT MUST FETCH ROOT-ABSOLUTE. The app is served under `base: "/tinker/"`, so a
// relative fetch("api/ui-state") resolves to /tinker/api/ui-state — which the
// `/tinker/api` proxy rule below forwards to the gateway on :18789, where no such route
// exists. Only fetch("/api/ui-state") reaches this middleware (same as /api/save-file).
//
// MIDDLEWARE ORDERING: `server.proxy` below also has an `/api` rule that forwards to the
// gateway. Middlewares registered via `configureServer` run BEFORE Vite's internal proxy
// middleware — that is exactly why the existing /api/open-file and /api/kit-content
// endpoints work despite that rule, and this one relies on the same ordering.
//
// DEV-SERVER ONLY (`apply: "serve"`): if the UI is ever loaded from the gateway's built
// /tinker route instead of the Vite dev server on :18790, this endpoint is simply absent
// and the client degrades to localStorage-only (its pre-existing behaviour). That is an
// accepted, documented limitation, not an oversight — :18790 (Vite dev) is the actual
// serving path.
function uiStatePlugin(): Plugin {
  // FIXED path. Unlike the kit endpoints there is NO user-supplied path parameter
  // anywhere in this endpoint, so there is deliberately no path-traversal guard here —
  // nothing was forgotten, there is nothing to guard.
  const stateFile = path.join(os.homedir(), ".openclaw", "data", "tinker-ui-state.json");
  // Chrome state is tiny (a few hundred bytes). A runaway writer must not fill the disk.
  const maxBody = 256 * 1024;

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  // Null-prototype maps: a control id that collides with an inherited name
  // (`__proto__`, `constructor`, `toString`) must not hit a prototype setter/getter.
  const emptyMap = () => Object.create(null) as Record<string, unknown>;

  // Keep only the entries whose value has the expected primitive type. One bad entry
  // must not cost the client its whole snapshot, so drop rather than reject.
  const pickTyped = (src: Record<string, unknown>, kind: "boolean" | "string") => {
    const out = emptyMap();
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === kind) out[k] = v;
    }
    return out;
  };

  // Ceiling on persisted tabs, mirroring MAX_PERSISTED_TABS in
  // tinker-ui/src/panels/ui-state.ts. The client already caps; this is the server not
  // trusting it. Well under the maxBody cap below at any realistic tab size.
  const maxTabs = 200;

  // The tab list, carried VERBATIM — the entries are app.ts's `Tab` objects and this file
  // deliberately knows nothing about their fields (a per-field allowlist here would drop
  // every new Tab property on its first cold boot). It checks only the container: an
  // array, of plain objects, bounded. `undefined` survives as `undefined` because the
  // caller has to tell "absent" from "empty" — see the header.
  const pickTabs = (v: unknown): Record<string, unknown>[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) return [];
    return v.filter(isPlainObject).slice(0, maxTabs);
  };

  // Same sanitising on BOTH sides of the wire: the store sits at a user-visible path
  // under ~/.openclaw/data/ and gets hand-edited during debugging, so a read is no more
  // trustworthy than a POST body.
  // Explicit return type: the conditional spread below would otherwise be inferred as a
  // UNION of "with tabs" and "without tabs", and `readState`'s
  // `ReturnType<typeof sanitize>` would inherit it — making every downstream `.tabs`
  // read a type error for no design reason.
  type UiState = {
    collapsed: Record<string, unknown>;
    flags: Record<string, unknown>;
    choices: Record<string, unknown>;
    tabs?: Record<string, unknown>[];
  };

  const sanitize = (src: Record<string, unknown>): UiState => {
    const tabs = pickTabs(src.tabs);
    return {
      collapsed: pickTyped(isPlainObject(src.collapsed) ? src.collapsed : {}, "boolean"),
      flags: pickTyped(isPlainObject(src.flags) ? src.flags : {}, "boolean"),
      choices: pickTyped(isPlainObject(src.choices) ? src.choices : {}, "string"),
      // Spread, not `tabs: tabs`: an explicit `tabs: undefined` would be dropped by
      // JSON.stringify on the way out anyway, but it would ALSO overwrite a carried-
      // forward value in the merge below. Keeping the property genuinely absent means
      // "absent" survives every hop between disk, this object and the wire.
      ...(tabs === undefined ? {} : { tabs }),
    };
  };

  const emptyState = () => sanitize({});

  // Read + sanitise the store. `status` separates three events that look identical to
  // the client but are NOT the same thing:
  //   absent     — nothing saved yet; nothing to lose.
  //   malformed  — the file exists but is not usable JSON; safe to overwrite (self-heal).
  //   unreadable — the file exists and holds real state we FAILED to read (EACCES,
  //                EMFILE…). Overwriting it would destroy it, so POST refuses instead.
  const readState = (): {
    status: "ok" | "absent" | "malformed" | "unreadable";
    state: ReturnType<typeof sanitize>;
    error?: NodeJS.ErrnoException;
  } => {
    let raw: string;
    try {
      raw = fs.readFileSync(stateFile, "utf-8");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "ENOENT") return { status: "absent", state: emptyState() };
      console.error(`[ui-state] read failed (${e?.code ?? "?"}): ${e?.message ?? String(err)}`);
      return { status: "unreadable", state: emptyState(), error: e };
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isPlainObject(parsed)) {
        console.error("[ui-state] store is not a JSON object, ignoring it");
        return { status: "malformed", state: emptyState() };
      }
      return { status: "ok", state: sanitize(parsed) };
    } catch (err: unknown) {
      console.error(`[ui-state] store is not valid JSON, ignoring it: ${(err as Error).message}`);
      return { status: "malformed", state: emptyState() };
    }
  };

  return {
    name: "tinker-ui-state",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/ui-state", (req, res) => {
        // GET /api/ui-state
        if (req.method === "GET") {
          // Never 404/500: the client treats any non-200 as "endpoint unavailable, fall
          // back to localStorage", so an error status for a merely-absent file would
          // silently disable durability on a fresh machine. Always 200 — worst case an
          // empty snapshot. `degraded` is the discriminator the status code cannot
          // carry: it means "the file exists but I could not read it, do NOT overwrite
          // it with what you have in memory".
          const { status, state } = readState();
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(status === "unreadable" ? { ...state, degraded: true } : state));
          return;
        }

        // HEAD and everything else. 405 for HEAD is mildly wrong HTTP but matches the
        // other endpoints in this file, and the client is fetch-only.
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        // POST /api/ui-state — the body is the full snapshot.
        const chunks: Buffer[] = [];
        let size = 0;
        let overflowed = false;
        req.on("error", (err: Error) => {
          console.error(`[ui-state] request stream error: ${err.message}`);
        });
        req.on("data", (chunk: Buffer) => {
          if (overflowed) return;
          size += chunk.length;
          if (size > maxBody) {
            // Answer, flush, then cut the upload off — a cap that only bounds retained
            // memory while the client keeps uploading is half a cap.
            overflowed = true;
            chunks.length = 0;
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Snapshot too large" }), () => {
              req.destroy();
            });
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          if (overflowed) return;
          let parsed: unknown;
          try {
            // Concat the raw buffers before decoding: a multi-byte character split
            // across two chunks would be mangled by per-chunk toString().
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }
          if (!isPlainObject(parsed)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Snapshot must be an object" }));
            return;
          }
          for (const key of ["collapsed", "flags", "choices"] as const) {
            const section = parsed[key];
            if (section !== undefined && !isPlainObject(section)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `${key} must be an object` }));
              return;
            }
          }
          // `tabs` is checked apart from the loop above because it is the one ARRAY
          // section — running it through `isPlainObject` would reject every valid body.
          if (parsed.tabs !== undefined && !Array.isArray(parsed.tabs)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "tabs must be an array" }));
            return;
          }
          const current = readState();
          if (current.status === "unreadable") {
            // The store exists and we could not read it. Writing now would atomically
            // replace real state with whatever this tab happens to hold — and the
            // rename leaves nothing to salvage. Fail loudly instead.
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: `Refusing to overwrite unreadable store: ${current.error?.message ?? "read failed"}`,
              }),
            );
            return;
          }
          // WHOLE-SNAPSHOT REPLACE — deliberately NOT a per-key merge over what is on
          // disk. THE INVARIANT of this store is "absent means the caller's stated
          // default", so the client says "put this control back to its default" by
          // DELETING the key (setCollapsed/setFlag/setChoice in
          // tinker-ui/src/panels/ui-state.ts) and POSTing the WHOLE snapshot. A per-key
          // merge cannot tell that deletion apart from a key this tab simply never had,
          // so it resurrects every deletion off disk: collapsing a panel sticks and
          // UN-collapsing can never survive a reload. Not hypothetical — the merge landed
          // on 2026-08-02 (caf755bdb20b) and stranded models/sessions/prefrontal
          // collapsed, the timeline bar off and the exec bar on, in the SAME commit as
          // the spec forbidding it. Last-writer-wins between two open tabs is the
          // documented, accepted trade-off; the alternative is a per-key tombstone
          // protocol for chrome state, which is not worth it. See
          // TINKER_UI_DESIGN_BIBLE/ui-persistence.md, "Two limitations, stated plainly" #1.
          //
          // Replacing cannot be fed a snapshot the client never read: after a failed
          // hydrate it drops the mirror POST entirely (hydrateOutcome === "failed" in
          // ui-state.ts), so a page that booted on empty defaults cannot blank the store,
          // and readUiStateSnapshot always emits all three sections. A hand-written POST
          // that omits a section, however, now genuinely CLEARS it — send the whole
          // snapshot when probing this endpoint by hand. sanitize() stays the only gate:
          // missing sections coerce to {}, wrong-typed entries drop, null-prototype maps.
          const snapshot = sanitize(parsed);
          // THE ONE EXCEPTION to whole-snapshot replace, and it is not a per-key merge:
          // `tabs` is carried forward WHOLE when the body has no opinion about it. The
          // objection above — that a merge cannot tell a deletion from a key this tab
          // never had — is specific to maps whose entries are individually deletable to
          // express "back to default". A tab list has no such per-entry semantics: the
          // client either states the list or says nothing. Saying nothing happens for
          // exactly one reason (a client older than 2026-08-16, including a stale built
          // bundle), and for that client the honest answer is to leave the durable list
          // alone rather than let it blank the architect's tabs on the next browser close.
          if (snapshot.tabs === undefined && current.state.tabs !== undefined) {
            snapshot.tabs = current.state.tabs;
          }
          // Atomic write: .tmp then rename (same pattern as /api/save-file above). The
          // tmp name carries the pid so a future async rewrite of this handler cannot
          // have two in-flight writes clobber one shared temp file.
          const tmpPath = `${stateFile}.${process.pid}.tmp`;
          try {
            fs.mkdirSync(path.dirname(stateFile), { recursive: true });
            fs.writeFileSync(tmpPath, JSON.stringify(snapshot), "utf-8");
            fs.renameSync(tmpPath, stateFile);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (writeErr: unknown) {
            console.error(`[ui-state] write failed: ${(writeErr as Error).message}`);
            try {
              fs.unlinkSync(tmpPath);
            } catch {}
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: (writeErr as Error).message ?? "Write failed" }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  root: ".",
  base: "/tinker/",
  define: {
    __BUNDLED_DEV__: "false", // Vite 8 requires this build-time constant
  },
  plugins: [tinkerDevConfig(), openFilePlugin(), kitContentPlugin(), uiStatePlugin()],
  server: {
    port: 18790,
    // FORK 2026-05-24 (fourth pass) — bug task-mpjhzu3j-ma9ts: allow
    // imports from `../src/shared/` so client + gateway share the
    // FORTUNE_COOKIES JSON without duplication. Default fs.allow is
    // the tinker-ui root only; opening to `..` lets the client import
    // `../src/shared/fortune-cookies.json` (and any future shared
    // module). Path stays inside the tinkerclaw repo — no escape.
    fs: {
      allow: [".", ".."],
    },
    proxy: {
      // Proxy API calls to the gateway (dev mode only)
      "/api": {
        target: "http://localhost:18789",
        rewrite: (p: string) => `/tinker${p}`,
        headers: { Authorization: `Bearer ${readGatewayToken()}` },
      },
      // Proxy tinker API calls to gateway with auth (context-anatomy, mute, etc.)
      "/tinker/api": {
        target: "http://localhost:18789",
        headers: { Authorization: `Bearer ${readGatewayToken()}` },
      },
      // Proxy tinker file-read API — rewrite to gateway tinker route
      "/tinker-api": {
        target: "http://localhost:18789",
        rewrite: (p: string) => p.replace(/^\/tinker-api/, "/tinker/api"),
        headers: { Authorization: `Bearer ${readGatewayToken()}` },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyDirOnBuild: true,
    // FORK 2026-08-02 (the architect): load-bearing, NOT a style choice. app.ts does a
    // `await hydrateUiState()` at MODULE TOP LEVEL so the durable /api/ui-state
    // snapshot is in the cache before the first synchronous read (the module-scope
    // activeTabId initializer). Vite otherwise falls back to ESBUILD_MODULES_TARGET
    // — es2020/chrome87 — under which esbuild hard-refuses top-level await:
    //   "Top-level await is not available in the configured target environment"
    // and `vite build` dies while `vite dev` on :18790 keeps working, so the
    // breakage only ever shows up on the built /tinker route. Verified by removing
    // this line: the build fails at app.ts's `await hydrateUiState()`.
    target: "es2022",
  },
});
