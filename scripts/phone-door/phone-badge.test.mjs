// node --test scripts/phone-door/phone-badge.test.mjs
// The icon's number follows tab-attention.ts: unread ⇔ the last final (endedAt, or the page's own `f`) is after
// the seen stamp; a chat never seen is not unread; one chat open in two tabs counts once.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keyMatches, unreadTabs } from "./phone-badge.mjs";

const state = (tabs, seen) => ({ tabs, choices: { "tab:seen": JSON.stringify(seen) } });

describe("unreadTabs", () => {
  it("counts a chat whose turn ended after it was last seen", () => {
    const s = state(
      [
        { sessionKey: "agent:main:a", title: "A" },
        { sessionKey: "agent:main:b", title: "B" },
      ],
      { "agent:main:a": { s: 100 }, "agent:main:b": { s: 300 } },
    );
    const ended = { "agent:main:a": 200, "agent:main:b": 250 };
    assert.deepEqual(
      unreadTabs(s, (k) => ended[k]),
      [{ key: "agent:main:a", title: "A" }],
    );
  });

  it("uses the page's own final when it is newer (a reflection answering in the chat)", () => {
    const s = state([{ sessionKey: "k", title: "K" }], { k: { s: 100, f: 150 } });
    assert.equal(unreadTabs(s, () => 90).length, 1);
    assert.equal(unreadTabs(s, () => undefined).length, 1);
  });

  it("is quiet for a chat never seen, a tab with no session, a repeated session and broken state", () => {
    const s = state(
      [
        { sessionKey: "new", title: "N" },
        { title: "no session" },
        { sessionKey: "x", title: "X1" },
        { sessionKey: "x", title: "X2" },
      ],
      { x: { s: 1 } },
    );
    assert.deepEqual(
      unreadTabs(s, () => 5),
      [{ key: "x", title: "X1" }],
    );
    assert.deepEqual(
      unreadTabs({ tabs: "nope", choices: { "tab:seen": "{bad" } }, () => 5),
      [],
    );
    assert.deepEqual(
      unreadTabs(null, () => 5),
      [],
    );
  });

  it("matches session keys the way the page does", () => {
    assert.ok(keyMatches("agent:main:main", "main"));
    assert.ok(keyMatches("main", "agent:main:main"));
    assert.ok(!keyMatches("agent:main:tinker:ab", "agent:main:tinker:abc"));
  });
});

// 2026-11-12: the buzz and the spoken line at the END of a turn, for a prompt sent from the phone.
const { answersDue, spokenLine } = await import("./phone-badge.mjs");
{
  const now = 1_000_000;
  const rows = [
    { key: "agent:main:tinker:aaa", status: "done", endedAt: now - 2_000, startedAt: now - 90_000 },
    {
      key: "agent:main:tinker:bbb",
      status: "running",
      run: { live: true },
      endedAt: now - 500_000,
    },
    { key: "agent:main:tinker:ccc", status: "done", endedAt: now - 300_000 },
    { key: "agent:main:tinker:ddd", status: "done", endedAt: now - 1_000 },
  ];
  const due = answersDue(
    [
      { tail: "aaa", lastSeen: now - 60_000 }, // locked a minute ago, the turn ended 2 s ago
      { tail: "bbb", lastSeen: now - 60_000 }, // still running
      { tail: "ccc", lastSeen: now - 60_000 }, // its last end is from before the prompt
      { tail: "ddd", lastSeen: now - 3_000 }, // ended 1 s ago and the page was alive 3 s ago
      { tail: "zzz", lastSeen: now - 60_000 }, // no such chat
      { tail: "aaa2", lastSeen: 0 }, // a consumed marker
    ],
    rows,
    now,
  );
  assert.deepEqual(
    due.map((d) => [d.tail, d.away]),
    [
      ["aaa", true],
      ["ddd", false],
    ],
  );
  assert.equal(due[0].key, "agent:main:tinker:aaa");
  assert.equal(due[0].startedAt, now - 90_000);

  assert.equal(
    spokenLine("**Jarvis:** *The reader is on the phone.*\n\nBody text."),
    "The reader is on the phone.",
  );
  assert.equal(spokenLine("Intro\n\n**Jarvis:** *Two jokes, one line.*\n"), "Two jokes, one line.");
  assert.equal(spokenLine("**Jarvis:** not italic, so not spoken"), "");
  assert.equal(spokenLine("No line here."), "");

  console.log("turn-end answer: ok");
}
