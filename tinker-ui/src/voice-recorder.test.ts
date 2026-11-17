import { describe, expect, it } from "vitest";
import {
  RECORDER_BITS_PER_SECOND,
  RECORDING_MAX_BYTES,
  baseAudioMime,
  formatRecordingDuration,
  formatRecordingSize,
  pickRecorderMime,
  recordingFileName,
  recordingPromptText,
} from "./voice-recorder.ts";

describe("pickRecorderMime", () => {
  it("takes the first format the browser supports", () => {
    expect(pickRecorderMime((m) => m === "audio/webm;codecs=opus")).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMime((m) => m === "audio/mp4")).toBe("audio/mp4");
  });
  it("returns empty when nothing matches, and skips a probe that throws", () => {
    expect(pickRecorderMime(() => false)).toBe("");
    expect(
      pickRecorderMime((m) => {
        if (m.startsWith("audio/webm")) {
          throw new Error("probe");
        }
        return m === "audio/ogg;codecs=opus";
      }),
    ).toBe("audio/ogg;codecs=opus");
  });
});

describe("formatRecordingDuration", () => {
  it("writes m:ss under an hour and h:mm:ss above", () => {
    expect(formatRecordingDuration(7_400)).toBe("0:07");
    expect(formatRecordingDuration(754_000)).toBe("12:34");
    expect(formatRecordingDuration(3_723_000)).toBe("1:02:03");
  });
  it("never prints a negative or NaN time", () => {
    expect(formatRecordingDuration(-5)).toBe("0:00");
    expect(formatRecordingDuration(Number.NaN)).toBe("0:00");
  });
});

describe("formatRecordingSize", () => {
  it("uses KB below a megabyte and MB above", () => {
    expect(formatRecordingSize(0)).toBe("0 KB");
    expect(formatRecordingSize(300)).toBe("1 KB");
    expect(formatRecordingSize(412 * 1024)).toBe("412 KB");
    expect(formatRecordingSize(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });
});

describe("size cap", () => {
  it("fits the gateway's 25 MB frame after base64, and allows over an hour of speech", () => {
    expect(Math.ceil(RECORDING_MAX_BYTES / 3) * 4).toBeLessThan(24 * 1024 * 1024);
    const minutes = (RECORDING_MAX_BYTES * 8) / RECORDER_BITS_PER_SECOND / 60;
    expect(minutes).toBeGreaterThan(60);
  });
});

describe("baseAudioMime and recordingFileName", () => {
  it("drops codec parameters and falls back to webm for anything that is not audio", () => {
    expect(baseAudioMime("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(baseAudioMime("")).toBe("audio/webm");
    expect(baseAudioMime("video/webm")).toBe("audio/webm");
  });
  it("names the file after the local start time with the right extension", () => {
    const at = new Date(2026, 10, 3, 19, 7);
    expect(recordingFileName("audio/webm;codecs=opus", at)).toBe("recording-2026-11-03-1907.webm");
    expect(recordingFileName("audio/mp4", at)).toBe("recording-2026-11-03-1907.m4a");
  });
});

describe("recordingPromptText", () => {
  it("keeps the typed instruction first and marks the recording", () => {
    expect(recordingPromptText("Transcribe and diarize this talk.", 95_000)).toBe(
      "Transcribe and diarize this talk.\n\n🎙️ Recording attached (1:35).",
    );
  });
  it("does not stack a second mark when a failed send's text comes back", () => {
    const first = recordingPromptText("Summarize it.", 5_000);
    expect(recordingPromptText(first, 5_000)).toBe(first);
    const voice = recordingPromptText("", 5_000);
    expect(recordingPromptText(voice, 5_000)).toBe(voice);
  });
  it("makes the recording the whole prompt when nothing is typed", () => {
    expect(recordingPromptText("   ", 12_000)).toBe(
      "🎙️ Voice prompt (0:12). The recording is my whole prompt.",
    );
  });
});
