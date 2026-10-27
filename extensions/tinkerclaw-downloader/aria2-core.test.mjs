// Tests for the download daemon core. Dependency-free; run with:
//   node --test extensions/tinkerclaw-downloader/aria2-core.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findProblems,
  readSetting,
  renderConf,
  renderUnit,
  repairConf,
  resolveOptions,
  resolvePaths,
  summarizeTask,
} from "./aria2-core.mjs";

const paths = resolvePaths("/home/u");
const opts = resolveOptions({}, "/home/u");
const conf = renderConf({ ...opts, secret: "s3cret", paths });

// The config that shipped the bug on 2026-10-06, reduced to the lines that matter.
const SHIPPED_CONF = `enable-rpc=true
seed-time=0
# tasks survive a daemon restart
save-session=/home/u/.config/aria2/session.txt
input-file=/home/u/.config/aria2/session.txt
save-session-interval=30
force-save=true
`;

test("the rendered config never force-saves finished tasks", () => {
  assert.equal(readSetting(conf, "force-save"), undefined);
  assert.deepEqual(findProblems(conf), []);
});

test("unfinished tasks still survive a restart: session is saved and read back", () => {
  assert.equal(readSetting(conf, "save-session"), paths.session);
  assert.equal(readSetting(conf, "input-file"), paths.session);
});

test("no seeding phase and RPC on loopback only", () => {
  assert.equal(readSetting(conf, "seed-time"), "0");
  assert.equal(readSetting(conf, "rpc-listen-all"), "false");
  assert.equal(readSetting(conf, "rpc-listen-port"), "6800");
});

test("the config that re-downloaded deleted files is flagged", () => {
  const problems = findProblems(SHIPPED_CONF);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /force-save/);
});

test("repair drops force-save and keeps everything else", () => {
  const fixed = repairConf(SHIPPED_CONF);
  assert.deepEqual(findProblems(fixed), []);
  assert.equal(readSetting(fixed, "save-session"), "/home/u/.config/aria2/session.txt");
  assert.match(fixed, /# tasks survive a daemon restart/);
});

test("a seeding config and a config without RPC are flagged", () => {
  assert.match(findProblems("enable-rpc=true\nseed-time=60\n")[0], /seeds/);
  assert.match(findProblems("seed-time=0\n")[0], /enable-rpc/);
});

test("the unit runs aria2 with the managed config", () => {
  const unit = renderUnit({ aria2cPath: "/usr/bin/aria2c", paths });
  assert.match(
    unit,
    /ExecStart=\/usr\/bin\/aria2c --conf-path=\/home\/u\/.config\/aria2\/aria2.conf/,
  );
  assert.match(unit, /Restart=always/);
});

test("options fall back to defaults and keep explicit values", () => {
  assert.equal(opts.downloadDir, "/home/u/Downloads/torrent-scout");
  assert.equal(opts.maxConcurrentDownloads, 3);
  assert.equal(resolveOptions({ rpcPort: 6801 }, "/home/u").rpcPort, 6801);
});

test("a task summary names a torrent by its info name and computes progress", () => {
  const row = summarizeTask({
    gid: "g1",
    status: "active",
    totalLength: "200",
    completedLength: "50",
    downloadSpeed: "10",
    dir: "/d",
    bittorrent: { info: { name: "Big.Film.2160p" } },
    files: [{ path: "/d/Big.Film.2160p/a.mkv" }],
  });
  assert.equal(row.name, "Big.Film.2160p");
  assert.equal(row.progress, 25);
  assert.equal(row.speedBytesPerSec, 10);
});
