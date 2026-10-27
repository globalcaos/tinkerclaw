// node --test scripts/phone-door/pack.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  DEFAULT_SRC,
  buildPack,
  entryNameOk,
  keygen,
  publish,
  signPack,
  verifyPack,
  zipFiles,
} from "./pack.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELUDE = path.resolve(
  HERE,
  "../../apps/android/app/src/thirdParty/assets/jarvis-script/prelude.js",
);
let tmp, keys, door;

/** Python's zipfile reads it back: proof the zip is well formed for a stock reader. */
function readZip(file) {
  const py =
    "import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\n" +
    "print(json.dumps({n: z.read(n).decode() for n in z.namelist()}))";
  return JSON.parse(execFileSync("python3", ["-I", "-c", py, file], { encoding: "utf8" }));
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pack-"));
  keys = path.join(tmp, "keys");
  door = path.join(tmp, "door");
  keygen(keys);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("content pack", () => {
  it("keygen writes a 600 private key and refuses to replace it", () => {
    assert.equal(fs.statSync(path.join(keys, "private.pem")).mode & 0o777, 0o600);
    assert.equal(
      Buffer.from(fs.readFileSync(path.join(keys, "public.b64"), "utf8"), "base64").length,
      32,
    );
    assert.throws(() => keygen(keys), /refusing/);
  });

  it("zipFiles writes a zip a stock reader opens, byte-identical for the same input", () => {
    const entries = [
      { name: "a.txt", data: Buffer.from("hello") },
      { name: "d/b.json", data: Buffer.from('{"x":1}') },
    ];
    const z = zipFiles(entries);
    assert.deepEqual(zipFiles(entries), z);
    const f = path.join(tmp, "t.zip");
    fs.writeFileSync(f, z);
    assert.deepEqual(readZip(f), { "a.txt": "hello", "d/b.json": '{"x":1}' });
  });

  it("signatures verify only for the exact bytes and the right key", () => {
    const pem = fs.readFileSync(path.join(keys, "private.pem"), "utf8");
    const pub = fs.readFileSync(path.join(keys, "public.b64"), "utf8");
    const zip = Buffer.from("pack bytes");
    const sig = signPack(zip, pem);
    assert.equal(verifyPack(zip, sig, pub), true);
    assert.equal(verifyPack(Buffer.from("pack bytez"), sig, pub), false);
    const other = path.join(tmp, "other");
    assert.equal(verifyPack(zip, sig, keygen(other)), false);
    assert.equal(verifyPack(zip, "not base64!", pub), false);
  });

  it("publish stamps the manifest, signs, and only ever raises the version", () => {
    const now = Date.parse("2026-10-23T18:00:00Z");
    const p1 = publish({ door, keys, now });
    assert.match(p1.file, /^pack-\d+\.zip$/);
    const zipPath = path.join(door, "app", p1.file);
    const zip = fs.readFileSync(zipPath);
    assert.equal(zip.length, p1.size);
    const pub = fs.readFileSync(path.join(keys, "public.b64"), "utf8");
    assert.equal(verifyPack(zip, p1.sig, pub), true);
    const files = readZip(zipPath);
    const manifest = JSON.parse(files["manifest.json"]);
    assert.equal(manifest.version, p1.version);
    assert.ok(files["main.js"].includes('jarvis.on("answer"'));
    assert.deepEqual(
      JSON.parse(files["voice-fx.json"]),
      JSON.parse(fs.readFileSync(path.join(DEFAULT_SRC, "voice-fx.json"), "utf8")),
    );
    // Same minute (or a clock behind): still a higher version than the last one.
    const p2 = publish({ door, keys, now });
    assert.equal(p2.version, p1.version + 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(door, "app", "pack.json"), "utf8")), p2);
  });

  it("publish refuses a private key others can read", () => {
    const loose = path.join(tmp, "loose");
    keygen(loose);
    fs.chmodSync(path.join(loose, "private.pem"), 0o644);
    assert.throws(() => publish({ door, keys: loose }), /readable by others/);
  });

  it("buildPack refuses names the app would refuse", () => {
    const src = path.join(tmp, "src");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "manifest.json"), '{"format":1,"version":0,"main":"main.js"}');
    fs.writeFileSync(path.join(src, "main.js"), "");
    fs.writeFileSync(path.join(src, ".env"), "x");
    assert.throws(() => buildPack(src, { version: 1, publishedAt: "" }), /refuse/);
    assert.equal(entryNameOk("www/a.js"), true);
    assert.equal(entryNameOk("../a.js"), false);
  });
});

describe("pack scripts (prelude + factory main.js, as JarvisScript.kt runs them)", () => {
  const run = (main, event, ctx) =>
    JSON.parse(
      vm.runInNewContext(
        `${fs.readFileSync(PRELUDE, "utf8")}\n;\n${main}\n;\n__jarvisRun(${JSON.stringify(event)}, ${JSON.stringify(ctx)});`,
        {},
        { timeout: 1000 },
      ),
    );
  const factory = fs.readFileSync(path.join(DEFAULT_SRC, "main.js"), "utf8");

  it("the locked-phone answer buzzes, then speaks the line", () => {
    const r = run(factory, "answer", { text: "Sir, your answer is ready." });
    assert.equal(r.handled, true);
    assert.deepEqual(r.calls, [
      { verb: "buzz", args: { pattern: [180] } },
      { verb: "say", args: { text: "Sir, your answer is ready.", voice: {} } },
    ]);
  });

  it("start and unknown events queue nothing", () => {
    assert.deepEqual(run(factory, "start", {}), { handled: true, calls: [] });
    assert.deepEqual(run(factory, "nope", {}), { handled: false, calls: [] });
  });

  it("a throwing handler throws out of the run (the app rolls the pack back)", () => {
    assert.throws(
      () => run('jarvis.on("start", function () { throw new Error("bad pack"); });', "start", {}),
      /bad pack/,
    );
  });

  it("the jarvis object cannot be swapped and calls are capped", () => {
    const r = run(
      'jarvis.on("x", function () { try { jarvis.buzz = null; } catch (e) {} jarvis.buzz(1); });',
      "x",
      {},
    );
    assert.deepEqual(r.calls, [{ verb: "buzz", args: { pattern: 1 } }]);
    assert.throws(
      () =>
        run(
          'jarvis.on("x", function () { for (var i = 0; i < 21; i++) jarvis.buzz(1); });',
          "x",
          {},
        ),
      /max 20/,
    );
  });
});
