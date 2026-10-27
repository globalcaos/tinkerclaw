import { describe, expect, it } from "vitest";
import { FS_PATH_CODE_RE } from "./md-links.js";

const match = (html: string) => html.replace(FS_PATH_CODE_RE, (_f, _a, p: string) => `[${p}]`);

describe("FS_PATH_CODE_RE", () => {
  it("links a path whose name holds an ampersand (escaped as &amp;)", () => {
    expect(match("<code>~/Documents/Malleable Software - Ink &amp; Switch.pdf</code>")).toBe(
      "[~/Documents/Malleable Software - Ink &amp; Switch.pdf]",
    );
  });
  it("still links plain and accented paths", () => {
    expect(match("<code>/home/x/Llicència projecte/a.md</code>")).toBe(
      "[/home/x/Llicència projecte/a.md]",
    );
  });
  it("does not link other entities or non-paths", () => {
    expect(match("<code>~/a&lt;b</code>")).toBe("<code>~/a&lt;b</code>");
    expect(match("<code>npm run build</code>")).toBe("<code>npm run build</code>");
  });
});

describe("FS_PATH_CODE_RE flags", () => {
  it("stops before a command-line flag after the path", () => {
    expect(match("<code>~/a.pdf -v</code>")).toBe("<code>~/a.pdf -v</code>");
  });
});
