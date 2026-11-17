import { describe, expect, it } from "vitest";
import { plainReason, plainRequester, reloadNotice } from "./reload-notice.js";

describe("the reload notice says what changed, then who asked, with no ids", () => {
  it("takes commit ids and bundle names out of the reason", () => {
    expect(
      plainReason(
        "upgrade: amygdala danger-2 owner-word proof becomes a logged note (7d2f7da1a44f) (develop 7d2f7da1a44)",
      ),
    ).toBe("Upgrade: amygdala danger-2 owner-word proof becomes a logged note");
    expect(
      plainReason(
        "model data refresh 2026-11-11: routing tables ed4cf2cd00ac (develop ed4cf2cd00a)",
      ),
    ).toBe("Model data refresh 2026-11-11: routing tables");
    expect(
      plainReason(
        "a newer Tinker build is live (assets/index-CX6VXhR0.js, this page runs assets/index-CPjdwQNB.js)",
      ),
    ).toBe("A newer Tinker build is live");
    expect(plainReason("Frontend rebuild finished: assets/index-CX6VXhR0.js")).toBe(
      "Frontend rebuild finished",
    );
  });
  it("keeps plain words that only look like hex, and dates", () => {
    expect(plainReason("added a facade, defaced nothing, 2026-11-12")).toBe(
      "Added a facade, defaced nothing, 2026-11-12",
    );
  });
  it("names the author as a person would", () => {
    const titleOf = (k: string) => (k === "agent:main:tinker:mw59uh07" ? "Phone reader" : null);
    expect(plainRequester('tab "Old title" (agent:main:tinker:mw59uh07)', titleOf)).toBe(
      "tab “Phone reader”",
    );
    expect(plainRequester('tab "Old title" (agent:main:tinker:zzz)', titleOf)).toBe(
      "tab “Old title”",
    );
    expect(plainRequester("chat agent:main:tinker:mw59uh07", titleOf)).toBe("tab “Phone reader”");
    expect(
      plainRequester("chat agent:main:cron:model-rank-refresh:run:0a101abb-0f2f", titleOf),
    ).toBe("scheduled job “model-rank-refresh”");
    expect(
      plainRequester(
        "pid 3795185 (/home/x/.nvm/versions/node/v22.23.4/bin/node /home/x/.claude/s)",
      ),
    ).toBe("a background job");
    expect(plainRequester('terminal "fix the reader" (claude-code 1a2b3c4d in tinkerclaw)')).toBe(
      "terminal “fix the reader”",
    );
    expect(plainRequester("Tinker page button")).toBe("the ↻ button on this page");
    expect(plainRequester("an agent (no requester given)")).toBe("an agent");
  });
  it("puts the upgrade first and the author second", () => {
    expect(
      reloadNotice(
        "new build assets/index-CX6VXhR0.js from pid 1 (node): upgrade: faster reader (7d2f7da1a44f)",
        {
          requester: "chat agent:main:tinker:abc",
          reason: "upgrade: faster reader (7d2f7da1a44f)",
        },
        () => "Reader work",
      ),
    ).toEqual({ what: "Upgrade: faster reader", who: "tab “Reader work”" });
    expect(reloadNotice("hmr update", null)).toEqual({ what: "Hmr update", who: null });
  });
  it("reads the author out of a detail stored by an older page (the first reload after the change)", () => {
    expect(
      reloadNotice(
        'new build assets/index-XVoFDGkU.js from tab "📱 Phone app optimization" (agent:main:tinker:mw59uh07): upgrade: a dismiss button (8cdf43c2761c)',
        null,
      ),
    ).toEqual({ what: "Upgrade: a dismiss button", who: "tab “📱 Phone app optimization”" });
  });
});
