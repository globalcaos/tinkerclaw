// End-to-end CLI tests. Every run gets a throwaway HOME so nothing touches the real
// activity counters or cache, and an empty PATH so the keychain binary is absent and
// the result is the same on any machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'scripts', 'linkedin.mjs');

function withHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'li-hack-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// Async on purpose: the fake relay below lives in THIS process, so a synchronous
// spawn would block the event loop and the child's fetch would never be answered.
function run(args, { home, env = {} } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { HOME: home, PATH: '/nonexistent', ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', rej);
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

// A stand-in for the OpenClaw browser relay: serves whatever target list a test wants.
async function fakeRelay(t, targets) {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  return {
    LINKEDIN_RELAY_HTTP: `http://127.0.0.1:${port}`,
    LINKEDIN_CDP_URL: `ws://127.0.0.1:${port}/cdp`,
  };
}

// ── removed capabilities must fail loudly, not exit 0 doing nothing ──────────

test('session store is gone and says so', async (t) => {
  const r = await run(['session', 'store'], { home: withHome(t) });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /REMOVED in 1\.2\.1/);
  assert.match(r.stderr, /no longer\s+extracts, stores or replays/);
});

test('session extract-cdp is gone', async (t) => {
  const r = await run(['session', 'extract-cdp', '--store'], { home: withHome(t) });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /REMOVED in 1\.2\.1/);
});

test('an unknown command still fails loudly', async (t) => {
  const r = await run(['frobnicate'], { home: withHome(t) });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown command/);
});

test('help advertises no credential store, no external replay, no relay override', async (t) => {
  const r = await run([], { home: withHome(t) });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Credentials: NONE stored/);
  assert.match(r.stdout, /pinned to exactly\s+https:\/\/www\.linkedin\.com/);
  for (const gone of [
    '--allow-plaintext-store',
    'LINKEDIN_ALLOW_REMOTE_RELAY',
    'LINKEDIN_TRANSPORT',
    'extract-cdp',
  ]) {
    assert.ok(!r.stdout.includes(gone), `help still mentions ${gone}`);
  }
});

// ── per-action consent on the one mutation ──────────────────────────────────

const URN = 'urn:li:conversation:1111';
const OTHER = 'urn:li:conversation:2222';

test('message-send without consent returns a draft and sends nothing', async (t) => {
  const r = await run(['message-send', URN, '--message', 'hello'], { home: withHome(t) });
  assert.equal(r.code, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'draft-only');
  assert.equal(out.sent, false);
  assert.equal(out.would_send_to, URN);
  assert.equal(out.message, 'hello');
});

test('a bare --i-mean-it is not consent', async (t) => {
  const r = await run(['message-send', URN, '--message', 'hello', '--i-mean-it'], { home: withHome(t) });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).status, 'draft-only');
});

test('consent naming a different conversation is refused', async (t) => {
  const r = await run(['message-send', URN, '--message', 'hi', '--i-mean-it', OTHER], {
    home: withHome(t),
  });
  assert.equal(r.code, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'draft-only');
  assert.match(out.why, /names a different conversation/);
});

test('consent naming the exact conversation passes the gate', async (t) => {
  // Relay shares no LinkedIn tab, so the send fails at the network gate — which is
  // proof the consent check let it through instead of drafting.
  const env = await fakeRelay(t, []);
  const r = await run(['message-send', URN, '--message', 'hi', '--i-mean-it', URN], {
    home: withHome(t),
    env,
  });
  assert.ok(!r.stdout.includes('draft-only'), r.stdout);
  assert.match(r.stderr, /No https:\/\/www\.linkedin\.com tab/);
});

// ── the rate guard cannot be wound backwards ────────────────────────────────

test('activity bump refuses a negative or zero step', async (t) => {
  const home = withHome(t);
  for (const by of ['-100', '0']) {
    const r = await run(['activity', 'bump', 'messages_sent', '--by', by], { home });
    assert.equal(r.code, 1, `--by ${by} should be refused`);
    assert.match(r.stderr, /positive integer/);
  }
});

test('activity bump still counts up', async (t) => {
  const home = withHome(t);
  const r = await run(['activity', 'bump', 'messages_sent', '--by', '2'], { home });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).today.messages_sent, 2);
});

// ── the relay must be on loopback, with no way round it ─────────────────────

test('an off-loopback relay is refused, and the old override no longer works', async (t) => {
  const home = withHome(t);
  const remote = { LINKEDIN_RELAY_HTTP: 'http://93.184.216.34:18792' };
  const a = await run(['me'], { home, env: remote });
  assert.equal(a.code, 1);
  assert.match(a.stderr, /LINKEDIN_RELAY_HTTP points off loopback/);

  const b = await run(['me'], { home, env: { ...remote, LINKEDIN_ALLOW_REMOTE_RELAY: '1' } });
  assert.equal(b.code, 1);
  assert.match(b.stderr, /points off loopback/);
  assert.match(b.stderr, /no flag that permits a remote one/);
});

test('an off-loopback CDP url is refused too', async (t) => {
  const r = await run(['me'], {
    home: withHome(t),
    env: { LINKEDIN_CDP_URL: 'ws://93.184.216.34:18792/cdp' },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /LINKEDIN_CDP_URL points off loopback/);
});

// ── every target is pinned to the exact LinkedIn origin ─────────────────────

test('a look-alike host in the relay target list is not a LinkedIn tab', async (t) => {
  const env = await fakeRelay(t, [
    { id: 'A', url: 'https://www.linkedin.com.evil.example/feed/' },
    { id: 'B', url: 'http://www.linkedin.com/feed/' },
    { id: 'C', url: 'https://linkedin.com.attacker.test/feed/' },
  ]);
  const r = await run(['me'], { home: withHome(t), env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No https:\/\/www\.linkedin\.com tab in the relay/);
});

test('LINKEDIN_TARGET_ID goes through the same origin check', async (t) => {
  const env = await fakeRelay(t, [
    { id: 'evil', url: 'https://www.linkedin.com.evil.example/feed/' },
    { id: 'good', url: 'https://www.linkedin.com/feed/' },
  ]);
  const r = await run(['me'], { home: withHome(t), env: { ...env, LINKEDIN_TARGET_ID: 'evil' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /points at https:\/\/www\.linkedin\.com\.evil\.example\/feed\//);
  assert.match(r.stderr, /Refusing/);
});

test('LINKEDIN_TARGET_ID naming a tab the relay does not share is refused', async (t) => {
  const env = await fakeRelay(t, [{ id: 'good', url: 'https://www.linkedin.com/feed/' }]);
  const r = await run(['me'], { home: withHome(t), env: { ...env, LINKEDIN_TARGET_ID: 'ghost' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a tab this relay is sharing/);
});

test('a LinkedIn tab sitting on the login wall is reported, not used', async (t) => {
  const env = await fakeRelay(t, [{ id: 'x', url: 'https://www.linkedin.com/login' }]);
  const r = await run(['me'], { home: withHome(t), env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /login wall/);
});

// ── nothing is ever written to disk as a credential ─────────────────────────

test('no run writes a credentials file, even when asked to', async (t) => {
  const home = withHome(t);
  const env = await fakeRelay(t, []);
  for (const args of [
    ['session', 'check'],
    ['session', 'status'],
    ['me', '--allow-plaintext-store'],
  ]) {
    await run(args, { home, env: { ...env, LINKEDIN_ALLOW_PLAINTEXT_STORE: '1' } });
  }
  assert.equal(existsSync(join(home, '.openclaw/credentials/linkedin-session.json')), false);
  assert.equal(existsSync(join(home, '.openclaw/credentials')), false);
});

test('session status reports the posture and prints no secret', async (t) => {
  const home = withHome(t);
  const r = await run(['session', 'status'], { home });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.stored_credentials, 'none — this version never writes one');
  assert.equal(out.origin, 'https://www.linkedin.com');
  assert.equal(out.legacy_session_file_found, false);
  assert.match(out.legacy_keychain_entry, /^not checked/);
  assert.equal(out.relay.must_be_loopback, true);
});

test('logout purges local data and hands back the revoke URL', async (t) => {
  const home = withHome(t);
  await run(['activity', 'bump', 'profile_views'], { home });
  const activity = join(home, '.openclaw/workspace/memory/linkedin-activity.json');
  assert.ok(existsSync(activity));
  assert.ok(readFileSync(activity, 'utf8').includes('openclaw-linkedin-hack'));

  const r = await run(['session', 'logout'], { home });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.revoke_at, /^https:\/\/www\.linkedin\.com\/psettings\/sessions$/);
  assert.equal(existsSync(activity), false);
});

// ── the legacy session FILE is deleted without being opened ─────────────────

test('logout deletes the legacy session file without reading it', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores file modes');
  const home = withHome(t);
  const dir = join(home, '.openclaw/credentials');
  mkdirSync(dir, { recursive: true });
  const legacy = join(dir, 'linkedin-session.json');
  // Not JSON, carries no marker, and unreadable: a delete that depended on opening
  // the file would refuse it.
  writeFileSync(legacy, 'li_at=SECRET');
  chmodSync(legacy, 0o000);
  const r = await run(['session', 'logout'], { home });
  assert.equal(r.code, 0);
  assert.equal(existsSync(legacy), false);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
});

test('logout refuses a symlink planted at the legacy session path', async (t) => {
  const home = withHome(t);
  const dir = join(home, '.openclaw/credentials');
  mkdirSync(dir, { recursive: true });
  const victim = join(home, 'victim.txt');
  writeFileSync(victim, 'keep me');
  symlinkSync(victim, join(dir, 'linkedin-session.json'));
  const r = await run(['session', 'logout'], { home });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /refusing to delete a symlink/);
  assert.ok(lstatSync(join(dir, 'linkedin-session.json')).isSymbolicLink());
  assert.equal(readFileSync(victim, 'utf8'), 'keep me');
});

// ── the legacy keychain entry is deleted, never looked up ───────────────────

// Puts stub `secret-tool` and `security` binaries on PATH that record their argv and
// print a fake secret, so a value-returning lookup would be caught.
function keychainStub(t) {
  const dir = mkdtempSync(join(tmpdir(), 'li-hack-bin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.log');
  for (const bin of ['secret-tool', 'security']) {
    const f = join(dir, bin);
    writeFileSync(f, `#!/bin/sh\necho "${bin} $*" >> "${log}"\necho FAKE-LI-AT-SECRET\n`);
    chmodSync(f, 0o755);
  }
  return { PATH: dir, log };
}

test('session status never invokes the keychain', async (t) => {
  const home = withHome(t);
  const stub = keychainStub(t);
  const r = await run(['session', 'status'], { home, env: { PATH: stub.PATH } });
  assert.equal(r.code, 0);
  assert.equal(existsSync(stub.log), false, 'status ran a keychain binary');
  assert.ok(!r.stdout.includes('FAKE-LI-AT-SECRET'));
});

test('session logout only ever runs the delete form of the keychain command', async (t) => {
  const home = withHome(t);
  const stub = keychainStub(t);
  const r = await run(['session', 'logout'], { home, env: { PATH: stub.PATH } });
  assert.equal(r.code, 0);
  const calls = readFileSync(stub.log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1, calls.join(' | '));
  assert.match(calls[0], /^(secret-tool clear |security delete-generic-password )/);
  assert.ok(!/lookup|find-generic-password|-w\b/.test(calls[0]), calls[0]);
  assert.ok(!r.stdout.includes('FAKE-LI-AT-SECRET'));
  assert.ok(!r.stderr.includes('FAKE-LI-AT-SECRET'));
});

// ── --top is validated and charged in full ──────────────────────────────────

const ACTIVITY = (home) => join(home, '.openclaw/workspace/memory/linkedin-activity.json');

test('out-of-range or malformed --top is rejected before any request', async (t) => {
  const home = withHome(t);
  for (const [args, re] of [
    [['messages', 'urn:li:x', '--top', '100000'], /--top must be an integer between 1 and 50/],
    [['messages', 'urn:li:x', '--top', '0'], /between 1 and 50/],
    [['messages', 'urn:li:x', '--top', '-5'], /between 1 and 50/],
    [['messages', 'urn:li:x', '--top', '2.5'], /between 1 and 50/],
    [['messages', 'urn:li:x', '--top', '1e9'], /between 1 and 50/],
    [['messages', 'urn:li:x', '--top'], /got no value/],
    [['connections', '--top', '101'], /between 1 and 100/],
    [['connections', '--start', '-1'], /--start must be an integer between 0 and 10000/],
    [['conversations', '--top', '51'], /between 1 and 50/],
    [['search', 'people', 'x', '--top', '26'], /between 1 and 25/],
    [['feed', '--top', '9999999999999999999'], /between 1 and 25/],
  ]) {
    const r = await run(args, { home });
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, re, args.join(' '));
  }
  assert.equal(existsSync(ACTIVITY(home)), false, 'a rejected call booked activity');
});

test('the full requested --top is reserved before the request, and a fallback cannot dodge it', async (t) => {
  const home = withHome(t);
  const env = await fakeRelay(t, []); // no tab: the request itself fails after reserving
  const r = await run(['connections', '--top', '100'], { home, env });
  assert.equal(r.code, 1);
  const a = JSON.parse(readFileSync(ACTIVITY(home), 'utf8'));
  assert.equal(a.today.connections_listed, 100);
});

test('a read that would cross the daily ceiling is refused', async (t) => {
  const home = withHome(t);
  mkdirSync(join(home, '.openclaw/workspace/memory'), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    ACTIVITY(home),
    JSON.stringify({
      today: { date: today, messages_read: 190 },
      // An attempt to RAISE the ceiling in the file must be ignored.
      limits: { messages_read: 100000 },
      _openclaw_skill: 'openclaw-linkedin-hack',
    }),
  );
  const r = await run(['messages', 'urn:li:x', '--top', '11'], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Rate guard: daily messages_read would hit 201\/200/);
});

test('a limit in the activity file can lower a ceiling', async (t) => {
  const home = withHome(t);
  mkdirSync(join(home, '.openclaw/workspace/memory'), { recursive: true });
  writeFileSync(ACTIVITY(home), JSON.stringify({ limits: { feed_items: 5 } }));
  const r = await run(['feed', '--top', '6'], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /feed_items would hit 6\/5/);
});

// ── relay must be a literal loopback IP; names are not resolved ─────────────

test('a relay hostname is refused even when it would resolve to loopback', async (t) => {
  const home = withHome(t);
  for (const url of ['http://localhost:18792', 'http://127.0.0.1.nip.io:18792', 'http://127.evil.example:18792']) {
    const r = await run(['me'], { home, env: { LINKEDIN_RELAY_HTTP: url } });
    assert.equal(r.code, 1, url);
    assert.match(r.stderr, /LINKEDIN_RELAY_HTTP points off loopback/, url);
  }
});

test('concurrent runs cannot overshoot a daily ceiling', async (t) => {
  const home = withHome(t);
  const env = await fakeRelay(t, []);
  mkdirSync(join(home, '.openclaw/workspace/memory'), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    ACTIVITY(home),
    JSON.stringify({ today: { date: today, messages_read: 190 }, _openclaw_skill: 'openclaw-linkedin-hack' }),
  );
  const runs = await Promise.all(
    Array.from({ length: 6 }, () => run(['messages', 'urn:li:x', '--top', '5'], { home, env })),
  );
  const refused = runs.filter((r) => /Rate guard: daily messages_read/.test(r.stderr)).length;
  assert.equal(refused, 4);
  const a = JSON.parse(readFileSync(ACTIVITY(home), 'utf8'));
  assert.equal(a.today.messages_read, 200);
  assert.equal(existsSync(`${ACTIVITY(home)}.lock`), false);
});
