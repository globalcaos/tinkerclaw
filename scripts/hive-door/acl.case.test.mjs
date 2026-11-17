// node --test scripts/hive-door/acl.case.test.mjs
// The gateway lowercases every session key before it resolves one, so the door must too: a case
// variant of someone else's chat is the same chat, never a new one to claim.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { canonKey, createAcl, userMainKey } from "./acl.mjs";
import { eventSessionKey } from "./door.mjs";

const alice = { operatorId: "alice", admin: false };
const bob = { operatorId: "bob", admin: false };

function freshAcl(store) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acl-case-"));
  let gatewayStoreFile;
  if (store) {
    gatewayStoreFile = path.join(dir, "sessions.json");
    fs.writeFileSync(gatewayStoreFile, JSON.stringify(store));
  }
  return createAcl({ file: path.join(dir, "acl.json"), gatewayStoreFile, defaultAgent: "main" });
}

describe("session keys fold case like the gateway", () => {
  it("canonKey lowercases", () => {
    assert.equal(canonKey("Agent:Main:Hive:Alice:MAIN"), "agent:main:hive:alice:main");
    assert.equal(canonKey("Tinker:AbC"), "agent:main:tinker:abc");
  });

  it("a case variant of someone else's chat is not treated as a new chat", () => {
    const acl = freshAcl();
    acl.claim(alice, "agent:main:hive:alice:main");
    assert.equal(acl.authorize(bob, "agent:main:hive:alice:MAIN").ok, false);
    assert.equal(acl.authorize(bob, "Agent:main:hive:alice:main").ok, false);
    assert.equal(acl.canSee(bob, "agent:main:HIVE:alice:main"), false);
    assert.equal(
      acl.authorize(alice, "agent:main:hive:alice:MAIN").ok,
      true,
      "the owner still gets in",
    );
  });

  it("a case variant of a chat only the gateway knows (a cron) stays admin-only", () => {
    const acl = freshAcl({ "agent:main:cron:nightly": { sessionId: "c" } });
    assert.equal(acl.authorize(bob, "agent:main:cron:NIGHTLY").ok, false);
  });

  it("a mixed-case key in the gateway's store is still known, so nobody can claim it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acl-case-"));
    const storeFile = path.join(dir, "sessions.json");
    fs.writeFileSync(storeFile, "{}");
    const acl = createAcl({ file: path.join(dir, "acl.json"), gatewayStoreFile: storeFile });
    // a chat the gateway created after the door's first start, stored with capitals
    fs.writeFileSync(storeFile, JSON.stringify({ "agent:main:cron:Weekly": { sessionId: "w" } }));
    fs.utimesSync(storeFile, new Date(), new Date(Date.now() + 5000));
    assert.equal(acl.authorize(bob, "agent:main:cron:weekly").ok, false);
  });

  it("each person's Main key is lowercase, whatever the case of their operator id", () => {
    assert.equal(userMainKey("Alice"), "agent:main:hive:alice:main");
  });

  it("an event naming a chat with a capitalised prefix is still filtered", () => {
    assert.equal(eventSessionKey({ key: "Agent:main:tinker:a1" }), "Agent:main:tinker:a1");
  });
});
