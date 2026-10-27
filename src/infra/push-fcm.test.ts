import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadFcmRegistration,
  registerFcmRegistration,
  resolveFcmServiceAccountFromEnv,
  sendFcmWake,
} from "./push-fcm.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "push-fcm-"));

describe("push-fcm", () => {
  it("stores one token per node, 0600, and refuses junk", async () => {
    const dir = tmp();
    expect(await registerFcmRegistration({ nodeId: "n1", token: "has space" }, dir)).toBeNull();
    expect(await registerFcmRegistration({ nodeId: "", token: "abc" }, dir)).toBeNull();
    await registerFcmRegistration({ nodeId: "n1", token: "tok-1" }, dir);
    await registerFcmRegistration({ nodeId: "n1", token: "tok-2" }, dir);
    expect((await loadFcmRegistration("n1", dir))?.token).toBe("tok-2");
    expect(await loadFcmRegistration("n2", dir)).toBeNull();
    const mode = fs.statSync(path.join(dir, "push", "fcm-registrations.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reports a missing or broken service account instead of throwing", async () => {
    expect((await resolveFcmServiceAccountFromEnv({})).ok).toBe(false);
    const f = path.join(tmp(), "sa.json");
    fs.writeFileSync(f, JSON.stringify({ project_id: "p" }));
    expect(
      (await resolveFcmServiceAccountFromEnv({ OPENCLAW_FCM_SERVICE_ACCOUNT_FILE: f })).ok,
    ).toBe(false);
  });

  it("signs a JWT the token endpoint can verify, then sends a high-priority wake", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const account = {
      project_id: "proj-1",
      client_email: "sa@proj-1.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    const calls: Array<{ url: string; body: string; auth?: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = String(init.body);
      calls.push({ url, body, auth: (init.headers as Record<string, string>).Authorization });
      if (url.includes("oauth2")) {
        const jwt = new URLSearchParams(body).get("assertion") ?? "";
        const [h, c, s] = jwt.split(".");
        const ok = crypto.verify(
          "RSA-SHA256",
          Buffer.from(`${h}.${c}`),
          publicKey,
          Buffer.from(s, "base64url"),
        );
        const claims = JSON.parse(Buffer.from(c, "base64url").toString());
        expect(ok).toBe(true);
        expect(claims.iss).toBe(account.client_email);
        expect(claims.scope).toContain("firebase.messaging");
        return new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600 }));
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const r = await sendFcmWake({
      registration: { nodeId: "n1", token: "device-tok", updatedAtMs: 0 },
      account,
      wakeReason: "invoke-timeout",
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    const send = calls.find((c) => c.url.includes("fcm.googleapis.com"));
    expect(send?.url).toContain("/v1/projects/proj-1/messages:send");
    expect(send?.auth).toBe("Bearer at-1");
    const msg = JSON.parse(send?.body ?? "{}").message;
    expect(msg.token).toBe("device-tok");
    expect(msg.data).toEqual({ type: "wake", reason: "invoke-timeout" });
    expect(msg.android.priority).toBe("HIGH");
  });

  it("returns FCM's error status, e.g. a dead token", async () => {
    const fetchImpl = (async (url: string) =>
      url.includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "at-2" }))
        : new Response('{"error":{"status":"NOT_FOUND"}}', {
            status: 404,
          })) as unknown as typeof fetch;
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const r = await sendFcmWake({
      registration: { nodeId: "n1", token: "gone", updatedAtMs: 0 },
      account: {
        project_id: "p",
        client_email: "other@p.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
      fetchImpl,
    });
    expect(r).toMatchObject({ ok: false, status: 404, reason: "NOT_FOUND" });
  });
});
