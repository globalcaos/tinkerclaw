/**
 * FORK: tinkerclaw-people — gateway method registrations.
 *
 * Exposes four RPCs to the agent + operator tooling:
 *   - people.resolve({ query }) -> { slug, displayName } | null
 *   - people.read({ slug }) -> { profile_md, deltaSinceLastConsult }
 *       (advances lastConsultedBythe user)
 *   - people.list() -> [{ slug, displayName, lastInteraction }]
 *   - people.update_consulted_at({ slug }) -> { ok: true }
 *
 * Pure file-backed (no DB). LLM-driven enrichment lives in the cron script.
 */
import type { OpenClawPluginApi } from "../api.js";
import type { PeopleResolvedConfig } from "./paths.js";
import { computeDelta } from "./profile.js";
import { resolveQuery } from "./resolver.js";
import { readAliases, readProfile, readState, writeState, type StateMap } from "./store.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

// Pull the gateway-method context shape off the SDK type so we don't have to
// guess at the request/respond signatures. Mirrors the convention used in
// extensions/memory-wiki/src/gateway.ts.
type GatewayMethodHandlerArg = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];

export function registerPeopleGatewayMethods(params: {
  api: OpenClawPluginApi;
  cfg: PeopleResolvedConfig;
}) {
  const { api, cfg } = params;
  const log = (msg: string) => api.logger.info(msg);

  api.registerGatewayMethod(
    "people.resolve",
    async ({ params: requestParams, respond }: GatewayMethodHandlerArg) => {
      try {
        const query = typeof requestParams?.query === "string" ? requestParams.query.trim() : "";
        if (!query) {
          respond(false, undefined, {
            code: "invalid_argument",
            message: "people.resolve requires a non-empty `query` string.",
          });
          return;
        }
        const aliases = readAliases(cfg);
        const result = resolveQuery(aliases, query, log);
        respond(true, result);
      } catch (err) {
        respond(false, undefined, {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "people.read",
    async ({ params: requestParams, respond }: GatewayMethodHandlerArg) => {
      try {
        const slug = typeof requestParams?.slug === "string" ? requestParams.slug.trim() : "";
        if (!slug) {
          respond(false, undefined, {
            code: "invalid_argument",
            message: "people.read requires a non-empty `slug` string.",
          });
          return;
        }
        const profileMd = readProfile(cfg, slug);
        if (profileMd === null) {
          respond(false, undefined, {
            code: "not_found",
            message: `No profile found for slug "${slug}".`,
          });
          return;
        }
        const state: StateMap = readState(cfg);
        const personState = state[slug] ?? {};
        const deltaSinceLastConsult = computeDelta(profileMd, personState.lastConsultedBythe user);
        // advance lastConsultedBythe user
        const now = new Date().toISOString();
        state[slug] = { ...personState, lastConsultedBythe user: now };
        writeState(cfg, state);
        respond(true, { profile_md: profileMd, deltaSinceLastConsult });
      } catch (err) {
        respond(false, undefined, {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "people.list",
    async ({ respond }: GatewayMethodHandlerArg) => {
      try {
        const aliases = readAliases(cfg);
        const state = readState(cfg);
        const rows = Object.entries(aliases).map(([slug, alias]) => ({
          slug,
          displayName: alias.displayName,
          lastInteraction: state[slug]?.lastInteraction ?? null,
        }));
        rows.sort((a, b) => {
          const al = a.lastInteraction ?? "";
          const bl = b.lastInteraction ?? "";
          if (al && bl) return bl.localeCompare(al);
          if (al) return -1;
          if (bl) return 1;
          return a.displayName.localeCompare(b.displayName);
        });
        respond(true, rows);
      } catch (err) {
        respond(false, undefined, {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "people.update_consulted_at",
    async ({ params: requestParams, respond }: GatewayMethodHandlerArg) => {
      try {
        const slug = typeof requestParams?.slug === "string" ? requestParams.slug.trim() : "";
        if (!slug) {
          respond(false, undefined, {
            code: "invalid_argument",
            message: "people.update_consulted_at requires a non-empty `slug` string.",
          });
          return;
        }
        const aliases = readAliases(cfg);
        if (!aliases[slug]) {
          respond(false, undefined, {
            code: "not_found",
            message: `No alias entry for slug "${slug}".`,
          });
          return;
        }
        const state = readState(cfg);
        const now = new Date().toISOString();
        state[slug] = { ...(state[slug] ?? {}), lastConsultedBythe user: now };
        writeState(cfg, state);
        respond(true, { ok: true, lastConsultedBythe user: now });
      } catch (err) {
        respond(false, undefined, {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    { scope: WRITE_SCOPE },
  );
}
