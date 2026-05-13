import Ajv from "ajv";
import { fetch as undiciFetch } from "undici";
import {
  PrefrontalKitSearchParamsSchema,
  PrefrontalKitGetParamsSchema,
  PrefrontalKitInstallParamsSchema,
  PrefrontalKitPublishParamsSchema,
  PrefrontalKitListParamsSchema,
  type PrefrontalKitSearchParams,
  type PrefrontalKitGetParams,
  type PrefrontalKitInstallParams,
  type PrefrontalKitPublishParams,
  type PrefrontalKitListParams,
} from "../../src/gateway/protocol/schema/prefrontal-kit.js";
import { KitStore } from "./kit-store.js";

const ajv = new Ajv({ allErrors: true });
const vSearch = ajv.compile(PrefrontalKitSearchParamsSchema);
const vGet = ajv.compile(PrefrontalKitGetParamsSchema);
const vInstall = ajv.compile(PrefrontalKitInstallParamsSchema);
const vPublish = ajv.compile(PrefrontalKitPublishParamsSchema);
const vList = ajv.compile(PrefrontalKitListParamsSchema);

type Validator = ReturnType<typeof ajv.compile>;

function check<T>(v: Validator, p: unknown, name: string): T {
  if (!v(p))
    throw new Error(
      `${name}: invalid params: ${(v.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ")}`,
    );
  return p as T;
}

export interface KitRpcsDeps {
  store: KitStore;
  baseUrl: string;
  apiKey: string | null;
  kitInstallSandbox: string;
  ownKitsDir: string;
}

export function createKitRpcs(deps: KitRpcsDeps) {
  const fetchJson = async (p: string, init?: Parameters<typeof undiciFetch>[1]) => {
    const headers = new Headers((init?.headers as Record<string, string>) ?? undefined);
    headers.set("Accept", "application/json");
    if (deps.apiKey) headers.set("Authorization", `Bearer ${deps.apiKey}`);
    const res = await undiciFetch(`${deps.baseUrl}${p}`, { ...init, headers });
    if (!res.ok) throw new Error(`Journey ${p} -> ${res.status} ${res.statusText}`);
    return res.json();
  };

  return {
    "prefrontal.kit.search": async (raw: unknown) => {
      const p = check<PrefrontalKitSearchParams>(vSearch, raw, "prefrontal.kit.search");
      const j: any = await fetchJson(
        `/api/kits/search?q=${encodeURIComponent(p.query)}${p.limit ? `&limit=${p.limit}` : ""}`,
      );
      return { results: j.results ?? [] };
    },

    "prefrontal.kit.get": async (raw: unknown) => {
      const p = check<PrefrontalKitGetParams>(vGet, raw, "prefrontal.kit.get");
      const j: any = await fetchJson(
        `/api/kits/${p.kitRef}${p.ref ? `?ref=${encodeURIComponent(p.ref)}` : ""}`,
      );
      return { kit: j };
    },

    "prefrontal.kit.install": async (raw: unknown) => {
      const p = check<PrefrontalKitInstallParams>(vInstall, raw, "prefrontal.kit.install");
      const ref = p.ref ?? "latest";
      const install: any = await fetchJson(
        `/api/kits/${p.kitRef}/install?target=openclaw&ref=${encodeURIComponent(ref)}`,
      );

      const risk: Array<{ source: string; level: string; alertCount?: number }> =
        install.risk ?? [];
      const blocking = risk.find((r) => r.level === "Critical" || r.level === "High Risk");
      if (blocking && !p.allowRisky) {
        throw new Error(
          `prefrontal.kit.install refused: kit ${p.kitRef} reports ${blocking.level} (${blocking.source}, alerts=${blocking.alertCount ?? "?"}). Re-run with allowRisky:true to override.`,
        );
      }

      const [owner, slug] = p.kitRef.split("/");
      await deps.store.writeKitFiles({ owner, slug, files: install.files ?? [] });

      const preflightResults: Array<{ check: string; ok: boolean; output: string }> = [];
      for (const pf of install.preflightChecks ?? []) {
        preflightResults.push({
          check: typeof pf === "string" ? pf : (pf.cmd ?? JSON.stringify(pf)),
          ok: false,
          output: "preflight execution not wired in this build",
        });
      }

      return {
        ok: true,
        installedPath: `${deps.kitInstallSandbox}/${owner}/${slug}`,
        preflightResults,
        nextSteps: install.nextSteps ?? [],
      } as const;
    },

    "prefrontal.kit.list": async (raw: unknown) => {
      const p = check<PrefrontalKitListParams>(vList, raw, "prefrontal.kit.list");
      const entries = await deps.store.list({ owner: p.owner });
      return {
        kits: entries.map((e) => ({
          kitRef: `${e.owner}/${e.slug}`,
          owner: e.owner,
          slug: e.slug,
          source: "downloaded" as const,
          path: e.path,
        })),
      };
    },

    "prefrontal.kit.publish": async (raw: unknown) => {
      const p = check<PrefrontalKitPublishParams>(vPublish, raw, "prefrontal.kit.publish");
      if (!deps.apiKey)
        throw new Error(
          "prefrontal.kit.publish: missing apiKey (set integrations.journey.apiKey in openclaw.json)",
        );
      const fsP = await import("node:fs/promises");
      const pathP = await import("node:path");
      const kitMdPath = pathP.join(deps.ownKitsDir, p.slug, "kit.md");
      const body = await fsP.readFile(kitMdPath, "utf-8");
      const res = await undiciFetch(`${deps.baseUrl}/api/kits/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          slug: p.slug,
          visibility: p.visibility,
          orgId: p.orgId,
          kitMd: body,
        }),
      });
      if (!res.ok) throw new Error(`Journey publish -> ${res.status}: ${await res.text()}`);
      return await res.json();
    },
  } as const;
}
