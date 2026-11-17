// FORK 2026-11-03 — feature: a record button next to Send. Everything said until the recorder is
// stopped travels with the next prompt as an audio attachment; the gateway transcribes it
// (media-understanding) and hands the agent both the transcript and the file path, so a prompt
// such as "transcribe and diarize this" can work on the real recording. With no typed text the
// recording IS the prompt.
//
// This module holds the PURE rules (format choice, size cap, labels, the text that rides with the
// recording). app.ts owns MediaRecorder, the DOM and the send; it imports every decision from here,
// the same extraction precedent as attachments.ts / outbox.ts.

/** Recorder formats in order of preference. Chrome and Firefox give WebM/Opus, Safari gives MP4. */
export const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

/** Opus at 24 kbit/s is clear for speech and keeps an hour near 11 MB. */
export const RECORDER_BITS_PER_SECOND = 24_000;

/**
 * Largest recording we send. The gateway takes 20 MB per attachment (DEFAULT_CHAT_ATTACHMENT_MAX_MB)
 * inside a 25 MB websocket frame, and base64 grows the file by a third: 17 MB becomes ~22.7 MB on the
 * wire, which leaves room for the rest of the request. At 24 kbit/s that is about 94 minutes.
 */
export const RECORDING_MAX_BYTES = 17 * 1024 * 1024;

/** First candidate the browser can record, or "" to let MediaRecorder pick its own default. */
export function pickRecorderMime(isTypeSupported: (mime: string) => boolean): string {
  for (const mime of RECORDER_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mime)) {
        return mime;
      }
    } catch {
      /* a browser that throws on the probe just skips that candidate */
    }
  }
  return "";
}

/** "0:07", "12:34", "1:02:03". */
export function formatRecordingDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "412 KB", "3.4 MB". */
export function formatRecordingSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 KB";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The MIME type without codec parameters, as the gateway expects it ("audio/webm"). */
export function baseAudioMime(mime: string): string {
  const base = (mime || "").split(";")[0]!.trim().toLowerCase();
  return base.startsWith("audio/") ? base : "audio/webm";
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

/** "recording-2026-11-03-1907.webm", from the local clock at the start of the recording. */
export function recordingFileName(mime: string, startedAt: Date): string {
  const ext = EXT_BY_MIME[baseAudioMime(mime)] ?? "webm";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${startedAt.getFullYear()}-${p(startedAt.getMonth() + 1)}-${p(startedAt.getDate())}-${p(startedAt.getHours())}${p(startedAt.getMinutes())}`;
  return `recording-${stamp}.${ext}`;
}

/**
 * The text that goes to the gateway with the recording, and that the user's bubble shows.
 *
 * Typed text first, unchanged: it is the instruction for what to do with the audio. With nothing
 * typed, the line tells the agent the recording is the whole prompt. Either way the bubble shows a
 * visible mark that a recording went with it.
 */
export function recordingPromptText(typed: string, durationMs: number): string {
  const length = formatRecordingDuration(durationMs);
  // A failed send puts its text back in the composer, mark included; drop it so a retry has one.
  const instruction = typed
    .replace(/🎙️ Voice prompt \([^)]*\)\. The recording is my whole prompt\.\s*$/u, "")
    .replace(/\s*🎙️ Recording attached \([^)]*\)\.\s*$/u, "")
    .trim();
  if (!instruction) {
    return `🎙️ Voice prompt (${length}). The recording is my whole prompt.`;
  }
  return `${instruction}\n\n🎙️ Recording attached (${length}).`;
}
