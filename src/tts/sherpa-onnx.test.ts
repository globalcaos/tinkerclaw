import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_SHERPA_EFFECTS_CHAIN,
  DEFAULT_SHERPA_OUTPUT_CODEC,
  sherpaOnnxTTS,
} from "./tts-core.js";

// Mock child_process.execFile
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Mock node:fs partially — keep real implementations for most functions
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

describe("sherpaOnnxTTS", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(tmpdir(), "sherpa-test-"));

    // Set up a fake model directory
    const modelDir = path.join(tempDir, "model");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(modelDir, { recursive: true });
    mkdirSync(path.join(modelDir, "espeak-ng-data"), { recursive: true });
    writeFileSync(path.join(modelDir, "test-model.onnx"), "fake");
    writeFileSync(path.join(modelDir, "tokens.txt"), "fake");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("exports default effects chain with expected filters", () => {
    expect(DEFAULT_SHERPA_EFFECTS_CHAIN).toContain("asetrate=22050*1.05");
    expect(DEFAULT_SHERPA_EFFECTS_CHAIN).toContain("flanger");
    expect(DEFAULT_SHERPA_EFFECTS_CHAIN).toContain("aecho");
    expect(DEFAULT_SHERPA_EFFECTS_CHAIN).toContain("highpass=f=200");
    expect(DEFAULT_SHERPA_EFFECTS_CHAIN).toContain("treble=g=6");
  });

  it("exports default output codec for OGG/Opus", () => {
    expect(DEFAULT_SHERPA_OUTPUT_CODEC).toBe("-c:a libopus -b:a 64k");
  });

  it("throws when binary does not exist", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (String(p) === "/nonexistent/bin") {return false;}
      return true;
    });

    await expect(
      sherpaOnnxTTS({
        text: "hello",
        outputPath: path.join(tempDir, "out.ogg"),
        config: {
          bin: "/nonexistent/bin",
          modelDir: path.join(tempDir, "model"),
          lengthScale: 0.5,
          effectsChain: DEFAULT_SHERPA_EFFECTS_CHAIN,
          outputCodec: DEFAULT_SHERPA_OUTPUT_CODEC,
        },
        timeoutMs: 10000,
      }),
    ).rejects.toThrow("sherpa-onnx binary not found");
  });

  it("throws when model directory does not exist", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.includes("model-missing")) {return false;}
      return true;
    });

    await expect(
      sherpaOnnxTTS({
        text: "hello",
        outputPath: path.join(tempDir, "out.ogg"),
        config: {
          bin: "/usr/bin/true",
          modelDir: "/model-missing",
          lengthScale: 0.5,
          effectsChain: DEFAULT_SHERPA_EFFECTS_CHAIN,
          outputCodec: DEFAULT_SHERPA_OUTPUT_CODEC,
        },
        timeoutMs: 10000,
      }),
    ).rejects.toThrow("sherpa-onnx model directory not found");
  });
});
