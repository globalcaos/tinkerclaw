import { describe, expect, it } from "vitest";
import { pageIsRemote, viewerBlob } from "./file-in-browser.js";
import { nextToPlay, startVoicePolling } from "./voice-in-browser.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("file links when the gateway is on another machine (2026-10-15)", () => {
  it("tells a loopback page from a remote one", () => {
    expect(pageIsRemote("127.0.0.1")).toBe(false);
    expect(pageIsRemote("localhost")).toBe(false);
    expect(pageIsRemote("[::1]")).toBe(false);
    expect(pageIsRemote("100.64.0.10")).toBe(true);
    expect(pageIsRemote("raspberrypi")).toBe(true);
  });

  it("renders markdown, sandboxes HTML, keeps a PDF's type", async () => {
    const md = viewerBlob(
      { name: "n.md", mime: "text/markdown", base64: b64("# Hi\n<script>x()</script>") },
      (t) => `<h1>Hi</h1>${t.includes("script") ? "<script>x()</script>" : ""}`,
    );
    expect(md.type).toBe("text/html");
    const mdText = await md.text();
    expect(mdText).toContain("<h1>Hi</h1>");
    expect(mdText).not.toContain("<script>");

    const html = await viewerBlob(
      { name: "p.html", mime: "text/html", base64: b64("<b>x</b>") },
      (t) => t,
    ).text();
    expect(html).toContain('sandbox="allow-scripts allow-popups"');
    expect(html).not.toContain("allow-same-origin");

    expect(viewerBlob({ mime: "application/pdf", base64: b64("%PDF") }, (t) => t).type).toBe(
      "application/pdf",
    );
    expect(viewerBlob({ mime: "text/plain", base64: b64("x") }, (t) => t).type).toBe(
      "text/plain;charset=utf-8",
    );
  });
});

describe("Jarvis voice on a remote page (2026-10-15)", () => {
  it("plays only lines newer than the last one heard", () => {
    expect(nextToPlay(null, null)).toBeNull();
    expect(nextToPlay("200.wav", "100.wav")).toBe("200.wav");
    expect(nextToPlay("100.wav", "100.wav")).toBeNull();
    expect(nextToPlay("100.wav", null)).toBe("100.wav");
  });

  it("never replays what was said before the page opened, then plays each new line once", async () => {
    const answers = ["100.wav", "100.wav", "250.wav", "250.wav"];
    const played: string[] = [];
    let i = 0;
    const stop = startVoicePolling({
      base: "/tinker",
      intervalMs: 1,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ latest: answers[Math.min(i++, 3)] }),
      }),
      play: (u) => played.push(u),
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(played).toEqual(["/tinker/api/jarvis-voice/250.wav"]);
  });

  it("waits for the line still speaking before starting the next (2026-10-27)", async () => {
    const answers = ["100.wav", "200.wav", "300.wav"];
    const played: string[] = [];
    let finish: () => void = () => {};
    let i = 0;
    const stop = startVoicePolling({
      base: "/tinker",
      intervalMs: 1,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ latest: answers[Math.min(i++, 2)] }),
      }),
      play: (u) => {
        played.push(u);
        return new Promise<void>((r) => (finish = r));
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(played).toEqual(["/tinker/api/jarvis-voice/200.wav"]);
    finish();
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(played).toEqual([
      "/tinker/api/jarvis-voice/200.wav",
      "/tinker/api/jarvis-voice/300.wav",
    ]);
  });
});
