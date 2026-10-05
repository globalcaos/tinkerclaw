import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { FOLLOW_BOTTOM_EPS, nextFollowState, type FollowState } from "./scroll-follow.js";

const following: FollowState = { follow: true };
const parkedUp: FollowState = { follow: false };

describe("nextFollowState", () => {
  it("owner-send re-arms follow from a scrolled-up viewport", () => {
    expect(nextFollowState(parkedUp, { type: "owner-send" }).follow).toBe(true);
  });

  it("owner-send while already following returns the same state object", () => {
    expect(nextFollowState(following, { type: "owner-send" })).toBe(following);
  });

  it("a gesture that parks at the bottom re-arms follow", () => {
    expect(
      nextFollowState(parkedUp, { type: "user-scroll", distanceFromBottom: 0, byGesture: true })
        .follow,
    ).toBe(true);
  });

  it("a gesture that leaves the bottom turns follow off", () => {
    expect(
      nextFollowState(following, {
        type: "user-scroll",
        distanceFromBottom: FOLLOW_BOTTOM_EPS + 1,
        byGesture: true,
      }).follow,
    ).toBe(false);
  });

  it("landing exactly at the epsilon still counts as the bottom", () => {
    expect(
      nextFollowState(parkedUp, {
        type: "user-scroll",
        distanceFromBottom: FOLLOW_BOTTOM_EPS,
        byGesture: true,
      }).follow,
    ).toBe(true);
  });

  it("the epsilon is intent, not proximity: 2, never the old 80", () => {
    // Pinned so a drift in the one shared copy of the number (app.ts imports it) fails a test
    // instead of silently changing what counts as "at the bottom".
    expect(FOLLOW_BOTTOM_EPS).toBe(2);
  });

  it("a scroll event not attributable to a gesture never changes intent", () => {
    expect(
      nextFollowState(following, {
        type: "user-scroll",
        distanceFromBottom: 500,
        byGesture: false,
      }),
    ).toBe(following);
    expect(
      nextFollowState(parkedUp, { type: "user-scroll", distanceFromBottom: 0, byGesture: false }),
    ).toBe(parkedUp);
  });

  it("content growth never changes intent, in either state", () => {
    expect(nextFollowState(following, { type: "content-grew" })).toBe(following);
    expect(nextFollowState(parkedUp, { type: "content-grew" })).toBe(parkedUp);
  });

  it("our own programmatic scroll never changes intent", () => {
    expect(nextFollowState(following, { type: "programmatic-scroll" })).toBe(following);
    expect(nextFollowState(parkedUp, { type: "programmatic-scroll" })).toBe(parkedUp);
  });

  it("a user fold toggle is a gesture: follow is re-derived from where it leaves the viewport", () => {
    // Opening a tool row above the bottom pushes the last line out of view: stay put and read it.
    expect(
      nextFollowState(following, { type: "user-toggle", distanceFromBottom: 400 }).follow,
    ).toBe(false);
    // Collapsing something that brings the last line back into view re-arms follow.
    expect(nextFollowState(parkedUp, { type: "user-toggle", distanceFromBottom: 0 }).follow).toBe(
      true,
    );
  });

  it("a jump to an older point (EEG prompt, timeline) turns follow off before it starts", () => {
    expect(nextFollowState(following, { type: "user-navigate" }).follow).toBe(false);
    expect(nextFollowState(parkedUp, { type: "user-navigate" })).toBe(parkedUp);
  });

  it("entering a tab restores THAT tab's latch, whatever the previous tab's was", () => {
    expect(nextFollowState(parkedUp, { type: "tab-enter", remembered: true }).follow).toBe(true);
    expect(nextFollowState(following, { type: "tab-enter", remembered: false }).follow).toBe(false);
  });

  it("a remembered row that cannot be found any more hands the tab back to following", () => {
    expect(nextFollowState(parkedUp, { type: "anchor-lost" }).follow).toBe(true);
  });

  it("send-then-stream: follow survives growth, pins and write echoes until a real up-gesture", () => {
    let st: FollowState = { follow: false };
    st = nextFollowState(st, { type: "owner-send" });
    st = nextFollowState(st, { type: "content-grew" });
    st = nextFollowState(st, { type: "programmatic-scroll" });
    st = nextFollowState(st, { type: "user-scroll", distanceFromBottom: 0, byGesture: false });
    expect(st.follow).toBe(true);
    st = nextFollowState(st, { type: "user-scroll", distanceFromBottom: 320, byGesture: true });
    expect(st.follow).toBe(false);
  });
});

// ─── app.ts wiring, locked structurally ─────────────────────────────────────────────────
// app.ts is an un-testable browser entry, so the call-site facts the latch depends on are read off
// its source (the technique retry-lifecycle.test.ts uses for the /clear branch). Walk up from the
// vitest cwd rather than import.meta.url: under this jsdom project the module URL is http://.
describe("app.ts owner-send wiring", () => {
  const findAppSource = (): string => {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "tinker-ui", "src", "app.ts");
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    throw new Error(`could not locate tinker-ui/src/app.ts from ${process.cwd()}`);
  };
  const appSrc = readFileSync(findAppSource(), "utf8");

  it("both composer sends (Enter and the send button) go through sendFromComposer", () => {
    const composerSends = appSrc.match(/\b(?:sendFromComposer|send)\(ta\.value\)/g) ?? [];
    expect(composerSends, "the composer send sites moved").toEqual([
      "sendFromComposer(ta.value)",
      "sendFromComposer(ta.value)",
    ]);
  });

  it("only sendFromComposer raises the owner-intent flag, and send() consumes it FIRST", () => {
    // Ladder retries, Resend, COMPACT and send("/new") must leave a scrolled-up viewport alone:
    // the flag has exactly one writer of `true`, and send() reads-and-clears it before any await.
    expect(appSrc.match(/composerSendArmed = true;/g) ?? []).toHaveLength(1);
    const wrapper = appSrc.indexOf("function sendFromComposer(text: string) {");
    expect(wrapper, "sendFromComposer moved or was renamed").toBeGreaterThan(-1);
    expect(appSrc.slice(wrapper, appSrc.indexOf("\n}\n", wrapper))).toContain(
      "composerSendArmed = true;",
    );
    const decl = appSrc.indexOf("async function send(");
    expect(decl, "send() moved or was renamed").toBeGreaterThan(-1);
    const bodyStart = appSrc.indexOf("{\n", decl) + 2;
    const head = appSrc.slice(bodyStart, bodyStart + 400);
    const consume = head.indexOf("const fromComposer = composerSendArmed;");
    expect(consume, "send() no longer consumes the flag at its top").toBeGreaterThan(-1);
    expect(head.indexOf("composerSendArmed = false;")).toBeGreaterThan(consume);
    // nothing but comments may precede the consume
    expect(
      head
        .slice(0, consume)
        .split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("//")),
    ).toEqual([]);
  });

  it("send() re-arms the latch on a composer send BEFORE drawing the new bubble", () => {
    const at = appSrc.indexOf("if (fromComposer) {");
    expect(at, "send() no longer re-arms follow on a composer send").toBeGreaterThan(-1);
    const block = appSrc.slice(at, appSrc.indexOf("scrollChat();", at));
    expect(block).toMatch(/type:\s*"owner-send"/);
    expect(block.indexOf('"owner-send"')).toBeLessThan(block.indexOf("updateChat();"));
  });
});
