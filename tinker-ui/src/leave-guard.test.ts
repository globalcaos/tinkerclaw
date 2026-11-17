import DOMPurify from "dompurify";
import { describe, expect, it } from "vitest";
import {
  causeSignature,
  fixDue,
  leaveTrace,
  linkReplacesPage,
  markLinkForNewTab,
  navigationVerdict,
} from "./leave-guard";

const HERE = "http://100.64.0.10:18794/tinker/";
const plain = {
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};
const link = (rawHref: string, target = "", download = false) => ({
  rawHref,
  href: new URL(rawHref, HERE).href,
  target,
  download,
});

describe("linkReplacesPage", () => {
  it("a link with no target would replace the page", () => {
    expect(linkReplacesPage(link("https://www.youtube.com/watch?v=x"), plain, HERE)).toBe(true);
    expect(linkReplacesPage(link("/pdf/viewer/web/viewer.html?file=a.pdf"), plain, HERE)).toBe(
      true,
    );
    expect(linkReplacesPage(link("https://example.com/", "_self"), plain, HERE)).toBe(true);
    expect(linkReplacesPage(link("https://example.com/", "_top"), plain, HERE)).toBe(true);
  });
  it("a link that already opens elsewhere is left alone", () => {
    expect(linkReplacesPage(link("https://example.com/", "_blank"), plain, HERE)).toBe(false);
    expect(linkReplacesPage(link("https://example.com/", "reader"), plain, HERE)).toBe(false);
    expect(linkReplacesPage(link("https://example.com/"), { ...plain, ctrlKey: true }, HERE)).toBe(
      false,
    );
    expect(linkReplacesPage(link("https://example.com/"), { ...plain, button: 1 }, HERE)).toBe(
      false,
    );
    expect(linkReplacesPage(link("/file.zip", "", true), plain, HERE)).toBe(false);
  });
  it("a link that does not load a page is left alone", () => {
    expect(linkReplacesPage(link("#"), plain, HERE)).toBe(false);
    expect(linkReplacesPage(link("#section"), plain, HERE)).toBe(false);
    expect(
      linkReplacesPage(
        { rawHref: "mailto:a@b.c", href: "mailto:a@b.c", target: "", download: false },
        plain,
        HERE,
      ),
    ).toBe(false);
    expect(linkReplacesPage(link(""), plain, HERE)).toBe(false);
  });
  it("a click some handler already took is left alone", () => {
    expect(
      linkReplacesPage(link("https://example.com/"), { ...plain, defaultPrevented: true }, HERE),
    ).toBe(false);
  });
});

describe("navigationVerdict", () => {
  const nav = (navigationType: string, url: string, more = {}) => ({
    navigationType,
    url,
    sameDocument: false,
    hashChange: false,
    download: false,
    ...more,
  });
  it("stops a script or form that replaces the page", () => {
    expect(navigationVerdict(nav("push", "https://example.com/"), HERE, "/tinker/")).toBe("stop");
    expect(
      navigationVerdict(
        nav("replace", "http://100.64.0.10:18794/pdf/viewer/web/viewer.html"),
        HERE,
        "/tinker/",
      ),
    ).toBe("stop");
  });
  it("in the Jarvis app, another site is handed to the phone's browser, not a leave", () => {
    const shazam = nav("push", "https://www.shazam.com/track/560928912/wellerman-ragtime-version");
    expect(navigationVerdict(shazam, HERE, "/tinker/", true)).toBe("stay");
    expect(navigationVerdict(shazam, HERE, "/tinker/")).toBe("stop");
    const sameSite = new URL(HERE).origin + "/pdf/viewer/web/viewer.html";
    expect(navigationVerdict(nav("push", sameSite), HERE, "/tinker/", true)).toBe("stop");
  });
  it("the app's own pages and reloads are planned; downloads and same-page moves do not leave", () => {
    expect(
      navigationVerdict(nav("replace", "http://100.64.0.10:18794/tinker/login"), HERE, "/tinker/"),
    ).toBe("planned");
    expect(navigationVerdict(nav("reload", HERE), HERE, "/tinker/")).toBe("planned");
    expect(
      navigationVerdict(
        nav("push", "https://example.com/x.zip", { download: true }),
        HERE,
        "/tinker/",
      ),
    ).toBe("stay");
    expect(
      navigationVerdict(
        nav("push", HERE + "#a", { hashChange: true, sameDocument: true }),
        HERE,
        "/tinker/",
      ),
    ).toBe("stay");
  });
  it("Back or Forward out of the page is unplanned, so the leave question is asked", () => {
    expect(navigationVerdict(nav("traverse", "https://example.com/"), HERE, "/tinker/")).toBe(
      "unplanned",
    );
    expect(
      navigationVerdict(nav("traverse", HERE + "#a", { sameDocument: true }), HERE, "/tinker/"),
    ).toBe("stay");
  });
});

describe("fixDue", () => {
  it("asks once per cause in 12 hours", () => {
    const mem = new Map<string, string>();
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const a = causeSignature("link", "https://www.youtube.com/watch?v=1");
    const b = causeSignature("link", "https://www.youtube.com/watch?v=2");
    expect(a).toBe(b); // two videos, one cause
    expect(fixDue(a, 1_000, store)).toBe(true);
    expect(fixDue(b, 2_000, store)).toBe(false);
    expect(fixDue(causeSignature("script", "https://example.com/a"), 3_000, store)).toBe(true);
    expect(fixDue(a, 1_000 + 12 * 3600_000 + 1, store)).toBe(true);
  });
});

describe("markLinkForNewTab", () => {
  it("marks every link the cleaner lets through, and leaves in-page anchors alone", () => {
    DOMPurify.addHook("afterSanitizeAttributes", markLinkForNewTab);
    try {
      const out = DOMPurify.sanitize(
        '<div><a href="https://www.youtube.com/watch?v=x">video</a> <a href="/pdf/a.pdf" target="_self">file</a> <a href="#top">top</a></div>',
      );
      const box = document.createElement("div");
      box.innerHTML = out;
      const [video, file, top] = [...box.querySelectorAll("a")];
      expect(video.target).toBe("_blank");
      expect(video.rel).toBe("noopener noreferrer");
      expect(file.target).toBe("_blank");
      expect(top.hasAttribute("target")).toBe(false);
    } finally {
      DOMPurify.removeHook("afterSanitizeAttributes");
    }
  });
});

describe("leaveTrace", () => {
  // 2026-11-12: a script leave was reported with its address and nothing that named its source.
  it("names the script that started it, without the guard's own frames", () => {
    const stack =
      "Error: leave\n    at onNavigate (leave-guard.ts:300:9)\n    at openCard (zen-panel.ts:12:5)\n    at HTMLButtonElement.<anonymous> (app.ts:9:1)";
    const t = leaveTrace({ userInitiated: false }, null, 10_000, stack, false);
    expect(t.stack).toBe(
      "    at openCard (zen-panel.ts:12:5)\n    at HTMLButtonElement.<anonymous> (app.ts:9:1)",
    );
    expect(t.userInitiated).toBe(false);
    expect(t.form).toBe(false);
  });

  it("keeps the last click only when it was under five seconds before", () => {
    const click = { html: '<a href="/zen/plan">Plan</a>', at: 8_000 };
    expect(leaveTrace({}, click, 10_000, undefined, false).lastClick).toBe(click.html);
    expect(leaveTrace({}, click, 10_000, undefined, false).lastClickAgoMs).toBe(2000);
    expect(leaveTrace({}, click, 20_000, undefined, false).lastClick).toBeNull();
  });

  it("says when a form, a person or a frame is behind it, and which element the browser names", () => {
    const t = leaveTrace(
      { userInitiated: true, formData: {}, sourceElement: { outerHTML: "<form></form>" } },
      null,
      1,
      undefined,
      true,
    );
    expect([t.userInitiated, t.form, t.source, t.framed, t.stack]).toEqual([
      true,
      true,
      "<form></form>",
      true,
      null,
    ]);
  });

  it("names the browser, so a report says whether it came from the phone app (2026-11-16)", () => {
    const ua = "Mozilla/5.0 (Linux; Android 16) JarvisApp/452241";
    expect(leaveTrace({}, null, 1, undefined, false, ua).browser).toBe(ua);
    expect(leaveTrace({}, null, 1, undefined, false).browser).toBeNull();
  });
});
