// ============================================================
// Embedding Pipeline Tests
// ============================================================
//
// Ported 2026-08-02 from src/amygdala/__tests__/embedding.test.ts when that dead twin was
// deleted. EmbeddingWindow and cosineSimilarity are byte-for-byte identical between the two
// copies, so these remain valid specs for the surviving extension implementation — which had
// no coverage of its own.
//
// Integration tests (EmbeddingPipeline) require ONNX models:
//   models/amygdala/encoder.onnx
//   models/amygdala/projection.onnx
//
// Generate them first (the generator moved here with this suite — it is the ONLY thing that
// produces these artefacts, which is why it was rescued rather than deleted):
//   python extensions/tinkerclaw-learned-intuition/export_encoder.py
//
// Unit tests (EmbeddingWindow, cosineSimilarity) run without models.

import os from "os";
import path from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EmbeddingWindow, EmbeddingPipeline, cosineSimilarity } from "../src/embedding";
import type { AmygdalaConfig } from "../src/types";

// ---------------------------------------------------------------------------
// EmbeddingWindow — pure unit tests (no models needed)
// ---------------------------------------------------------------------------

describe("EmbeddingWindow", () => {
  it("should start empty", () => {
    const win = new EmbeddingWindow(4, 3);
    expect(win.getCount()).toBe(0);
    expect(win.getLatest()).toBeNull();
    expect(win.getAll()).toHaveLength(0);
  });

  it("should accept and count embeddings up to capacity", () => {
    const win = new EmbeddingWindow(4, 3);
    win.push(new Float32Array([1, 2, 3]));
    win.push(new Float32Array([4, 5, 6]));
    expect(win.getCount()).toBe(2);
  });

  it("should return latest embedding correctly", () => {
    const win = new EmbeddingWindow(4, 3);
    win.push(new Float32Array([1, 2, 3]));
    win.push(new Float32Array([4, 5, 6]));
    const latest = win.getLatest()!;
    expect(Array.from(latest)).toEqual([4, 5, 6]);
  });

  it("should return all embeddings in chronological order", () => {
    const win = new EmbeddingWindow(4, 3);
    win.push(new Float32Array([1, 2, 3]));
    win.push(new Float32Array([4, 5, 6]));
    win.push(new Float32Array([7, 8, 9]));
    const all = win.getAll();
    expect(all).toHaveLength(3);
    expect(Array.from(all[0])).toEqual([1, 2, 3]);
    expect(Array.from(all[1])).toEqual([4, 5, 6]);
    expect(Array.from(all[2])).toEqual([7, 8, 9]);
  });

  it("should maintain ring buffer of exactly K=32 embeddings", () => {
    const K = 32;
    const dim = 512;
    const win = new EmbeddingWindow(K, dim);

    for (let i = 0; i < K; i++) {
      const v = new Float32Array(dim).fill(i);
      win.push(v);
    }
    expect(win.getCount()).toBe(K);
  });

  it("should evict oldest embedding on overflow (ring buffer)", () => {
    const win = new EmbeddingWindow(2, 3);
    win.push(new Float32Array([1, 2, 3])); // slot 0
    win.push(new Float32Array([4, 5, 6])); // slot 1
    win.push(new Float32Array([7, 8, 9])); // overwrites slot 0 (oldest)

    expect(win.getCount()).toBe(2); // still 2 (capacity)

    const all = win.getAll();
    expect(all).toHaveLength(2);
    expect(Array.from(all[0])).toEqual([4, 5, 6]); // oldest remaining
    expect(Array.from(all[1])).toEqual([7, 8, 9]); // newest
  });

  it("should evict oldest and maintain order through multiple overflows", () => {
    const win = new EmbeddingWindow(3, 2);

    for (let i = 1; i <= 6; i++) {
      win.push(new Float32Array([i, i]));
    }

    expect(win.getCount()).toBe(3);
    const all = win.getAll();
    // After 6 pushes into capacity-3 buffer: slots contain [4,4], [5,5], [6,6]
    expect(Array.from(all[0])).toEqual([4, 4]);
    expect(Array.from(all[1])).toEqual([5, 5]);
    expect(Array.from(all[2])).toEqual([6, 6]);
  });

  it("getSequence should return K*dim float array, zero-padded", () => {
    const K = 4;
    const dim = 3;
    const win = new EmbeddingWindow(K, dim);
    win.push(new Float32Array([1, 2, 3]));

    const seq = win.getSequence();
    expect(seq).toHaveLength(K * dim);

    // First 3*dim values should be zeros (padding for unfilled slots)
    for (let i = 0; i < 3 * dim; i++) {
      expect(seq[i]).toBe(0);
    }
    // Last dim values should be [1, 2, 3]
    expect(Array.from(seq.slice(3 * dim))).toEqual([1, 2, 3]);
  });

  it("should throw on wrong-dimension push", () => {
    const win = new EmbeddingWindow(4, 3);
    expect(() => win.push(new Float32Array([1, 2]))).toThrow("dimension mismatch");
  });

  it("should reset correctly", () => {
    const win = new EmbeddingWindow(4, 3);
    win.push(new Float32Array([1, 2, 3]));
    win.reset();
    expect(win.getCount()).toBe(0);
    expect(win.getLatest()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cosineSimilarity helper
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("should return 1.0 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0);
  });

  it("should return -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it("should return 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("should throw on length mismatch", () => {
    expect(() => cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1]))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// EmbeddingPipeline — integration tests (requires ONNX models)
// ---------------------------------------------------------------------------

const MODELS_DIR = path.join(os.homedir(), "src", "tinkerclaw", "models", "amygdala");
const ENCODER_PATH = path.join(MODELS_DIR, "encoder.onnx");
const PROJECTION_PATH = path.join(MODELS_DIR, "projection.onnx");

function modelsExist(): boolean {
  try {
    const fs = require("fs");
    return fs.existsSync(ENCODER_PATH) && fs.existsSync(PROJECTION_PATH);
  } catch {
    return false;
  }
}

const describeIntegration = modelsExist() ? describe : describe.skip;

describeIntegration("EmbeddingPipeline (integration — requires ONNX models)", () => {
  const config: AmygdalaConfig["embedding"] = {
    encoder_model_path: ENCODER_PATH,
    projection_model_path: PROJECTION_PATH,
    internal_dim: 512,
    input_dim: 384,
    window_size: 32,
  };

  let pipeline: EmbeddingPipeline;

  beforeAll(async () => {
    pipeline = new EmbeddingPipeline(config);
    await pipeline.initialize();
  });

  afterAll(async () => {
    await pipeline.dispose();
  });

  it("should produce a 512d Float32Array for any input string", async () => {
    const result = await pipeline.embed("overwrite heavily-edited configuration file");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(512);
  });

  it("should produce non-zero embeddings", async () => {
    const result = await pipeline.embed("delete recently-modified user data");
    const hasNonZero = Array.from(result).some((v) => v !== 0);
    expect(hasNonZero).toBe(true);
  });

  it("should produce similar embeddings for similar situation strings (cosine > 0.7)", async () => {
    const a = await pipeline.embed("overwrite heavily-edited configuration file");
    const b = await pipeline.embed("overwrite recently-modified configuration file");
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.7);
  });

  it("should produce dissimilar embeddings for dissimilar situation strings (cosine < 0.5)", async () => {
    const a = await pipeline.embed("overwrite heavily-edited configuration file in production");
    const b = await pipeline.embed("send casual greeting message to friend");
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeLessThan(0.5);
  });

  it("should push embeddings to temporal window automatically", async () => {
    const freshPipeline = new EmbeddingPipeline(config);
    await freshPipeline.initialize();

    expect(freshPipeline.window.getCount()).toBe(0);
    await freshPipeline.embed("first situation");
    expect(freshPipeline.window.getCount()).toBe(1);
    await freshPipeline.embed("second situation");
    expect(freshPipeline.window.getCount()).toBe(2);

    await freshPipeline.dispose();
  });

  it("temporal window should maintain last 32 embeddings correctly", async () => {
    const freshPipeline = new EmbeddingPipeline(config);
    await freshPipeline.initialize();

    for (let i = 0; i < 32; i++) {
      await freshPipeline.embed(`situation number ${i}`);
    }
    expect(freshPipeline.window.getCount()).toBe(32);

    await freshPipeline.dispose();
  });

  it("temporal window ring buffer should overflow and evict oldest", async () => {
    const freshPipeline = new EmbeddingPipeline(config);
    await freshPipeline.initialize();

    for (let i = 0; i < 35; i++) {
      await freshPipeline.embed(`situation number ${i}`);
    }
    // Should still be exactly 32 (capped at window_size)
    expect(freshPipeline.window.getCount()).toBe(32);

    await freshPipeline.dispose();
  });
});
