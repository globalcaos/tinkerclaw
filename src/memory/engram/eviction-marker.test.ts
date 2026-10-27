import { describe, expect, it } from "vitest";
import {
  MARKER_QUOTE_CHARS,
  quoteFirstLine,
  quoteLastLine,
  renderToolResultEvictionMarker,
  renderTurnEvictionMarker,
} from "./eviction-marker.js";

/** The JSON-quoted spans of a marker, decoded: what an agent would search for. */
function quotedSpans(marker: string): string[] {
  return [...marker.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => JSON.parse(m[0]) as string);
}

describe("quotes", () => {
  it("quote the first and last non-empty lines verbatim", () => {
    const text = "\n  npm ERR! code ERESOLVE  \nline two\n\nnpm ERR! see the log\n";
    expect(quoteFirstLine(text)).toBe('"npm ERR! code ERESOLVE"');
    expect(quoteLastLine(text)).toBe('"npm ERR! see the log"');
  });

  it("cut a long line to an exact prefix (first) or suffix (last), marked outside the quotes", () => {
    const line = `${"a".repeat(100)}MIDDLE${"z".repeat(100)}`;
    const first = quoteFirstLine(line)!;
    const last = quoteLastLine(line)!;
    expect(first.endsWith("…")).toBe(true);
    expect(last.startsWith("…")).toBe(true);
    const [prefix] = quotedSpans(first);
    const [suffix] = quotedSpans(last);
    expect(prefix).toHaveLength(MARKER_QUOTE_CHARS);
    expect(line.startsWith(prefix)).toBe(true);
    expect(line.endsWith(suffix)).toBe(true);
  });

  it("escape quote marks and backslashes so the marker stays parseable", () => {
    const q = quoteFirstLine('say "hi" to C:\\temp')!;
    expect(JSON.parse(q)).toBe('say "hi" to C:\\temp');
  });

  it("return nothing for blank text", () => {
    expect(quoteFirstLine(" \n\n ")).toBeUndefined();
    expect(quoteLastLine("")).toBeUndefined();
  });
});

describe("renderToolResultEvictionMarker", () => {
  const content = [
    { type: "text", text: "Fetching https://example.com/report\n" + "row\n".repeat(500) },
    { type: "text", text: "Done: 500 rows in 2.1s" },
  ];

  it("names the tool, the size, the exact first and last lines and the id that fetches it", () => {
    const marker = renderToolResultEvictionMarker({
      toolName: "web_fetch",
      toolCallId: "call_abc|fc_1",
      content,
    });
    expect(marker).toContain("Evicted web_fetch output");
    expect(marker).toContain("502 lines");
    const spans = quotedSpans(marker);
    expect(spans).toContain("Fetching https://example.com/report");
    expect(spans).toContain("Done: 500 rows in 2.1s");
    const call = /recall\((\{.*?\})\)/.exec(marker);
    expect(call).not.toBeNull();
    expect(JSON.parse(call![1])).toEqual({ id: "call_abc|fc_1" });
  });

  it("renders the same bytes for the same result (one prompt-cache move per eviction)", () => {
    const a = renderToolResultEvictionMarker({ toolName: "exec", toolCallId: "t1", content });
    const b = renderToolResultEvictionMarker({
      toolName: "exec",
      toolCallId: "t1",
      content: structuredClone(content),
    });
    expect(a).toBe(b);
  });

  it("counts images and still quotes the text beside them", () => {
    const marker = renderToolResultEvictionMarker({
      toolName: "browser",
      toolCallId: "t2",
      content: [
        { type: "text", text: "screenshot of the login page" },
        { type: "image", data: "x".repeat(1000), mimeType: "image/png" },
      ],
    });
    expect(marker).toContain("1 image");
    expect(quotedSpans(marker)).toContain("screenshot of the login page");
  });
});

describe("renderTurnEvictionMarker", () => {
  it("quotes the first and last dropped user words and names the archive", () => {
    const marker = renderTurnEvictionMarker({
      evicted: 40,
      evictedTokens: 12_345,
      firstUserText: "Let's plan the Valencia install\nmore detail",
      lastUserText: "ok, ship the camera config",
      archivePath: "/home/u/.openclaw/agents/main/sessions/s.jsonl.bak.2026-10-25T10-00-00.000Z",
    });
    expect(marker).toContain("Evicted 40 earlier messages (~12,345 tokens)");
    expect(quotedSpans(marker)).toEqual([
      "Let's plan the Valencia install",
      "ok, ship the camera config",
    ]);
    expect(marker).toContain("s.jsonl.bak.2026-10-25T10-00-00.000Z");
  });
});
