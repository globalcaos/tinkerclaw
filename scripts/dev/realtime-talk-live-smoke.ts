import { GoogleGenAI, Modality } from "@google/genai";
import { chromium, type Browser } from "playwright";

const OPENAI_REALTIME_MODEL =
  process.env.OPENCLAW_REALTIME_OPENAI_MODEL?.trim() || "gpt-realtime-1.5";
const OPENAI_REALTIME_VOICE = process.env.OPENCLAW_REALTIME_OPENAI_VOICE?.trim() || "alloy";
const GOOGLE_REALTIME_MODEL =
  process.env.OPENCLAW_REALTIME_GOOGLE_MODEL?.trim() ||
  "gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_REALTIME_VOICE = process.env.OPENCLAW_REALTIME_GOOGLE_VOICE?.trim() || "Kore";
const GOOGLE_LIVE_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

type SmokeResult = {
  name: string;
  ok: boolean;
  details?: Record<string, unknown>;
};

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function shortError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBoundedText(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

function printResult(result: SmokeResult): void {
  console.log(`${result.name}: ${result.ok ? "ok" : "failed"}`, result.details ?? {});
}

async function createOpenAIClientSecret(apiKey: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: OPENAI_REALTIME_MODEL,
        audio: {
          output: { voice: OPENAI_REALTIME_VOICE },
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `OpenAI Realtime client secret failed (${response.status}): ${await readBoundedText(
        response,
      )}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const nested =
    payload.client_secret && typeof payload.client_secret === "object"
      ? (payload.client_secret as Record<string, unknown>)
      : undefined;
  const value = typeof payload.value === "string" ? payload.value : undefined;
  const nestedValue = typeof nested?.value === "string" ? nested.value : undefined;
  const secret = value ?? nestedValue;
  if (!secret) {
    throw new Error("OpenAI Realtime client secret response did not include a value");
  }
  return secret;
}

async function smokeOpenAIWebRtc(browser: Browser, apiKey: string): Promise<SmokeResult> {
  try {
    const clientSecret = await createOpenAIClientSecret(apiKey);
    const context = await browser.newContext({
      permissions: ["microphone"],
    });
    const page = await context.newPage();
    const result = await page.evaluate(
      async ({ clientSecret: secret }) => {
        let media: MediaStream;
        if (navigator.mediaDevices?.getUserMedia) {
          media = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          const audioContext = new AudioContext();
          const destination = audioContext.createMediaStreamDestination();
          const oscillator = audioContext.createOscillator();
          oscillator.connect(destination);
          oscillator.start();
          media = destination.stream;
        }
        const peer = new RTCPeerConnection();
        for (const track of media.getAudioTracks()) {
          peer.addTrack(track, media);
        }
        const channel = peer.createDataChannel("oai-events");
        const connectionState = new Promise<string>((resolve) => {
          const timeout = window.setTimeout(() => resolve(peer.connectionState), 12_000);
          peer.addEventListener("connectionstatechange", () => {
            if (peer.connectionState === "connected" || peer.connectionState === "failed") {
              window.clearTimeout(timeout);
              resolve(peer.connectionState);
            }
          });
          channel.addEventListener("open", () => {
            window.clearTimeout(timeout);
            resolve(peer.connectionState || "data-channel-open");
          });
        });
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const response = await fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/sdp",
          },
        });
        if (!response.ok) {
          throw new Error(`OpenAI Realtime SDP offer failed (${response.status})`);
        }
        const answer = await response.text();
        await peer.setRemoteDescription({ type: "answer", sdp: answer });
        const state = await connectionState;
        peer.close();
        media.getTracks().forEach((track) => track.stop());
        return {
          answerHasAudio: answer.includes("m=audio"),
          remoteDescriptionApplied: peer.remoteDescription?.type === "answer",
          connectionState: state,
        };
      },
      { clientSecret },
    );
    await context.close();
    return {
      name: "openai-webrtc-browser",
      ok: result.answerHasAudio && result.remoteDescriptionApplied,
      details: {
        model: OPENAI_REALTIME_MODEL,
        answerHasAudio: result.answerHasAudio,
        remoteDescriptionApplied: result.remoteDescriptionApplied,
        connectionState: result.connectionState,
      },
    };
  } catch (error) {
    return { name: "openai-webrtc-browser", ok: false, details: { error: shortError(error) } };
  }
}

async function createGoogleLiveToken(apiKey: string): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1alpha" },
  });
  const now = Date.now();
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
      newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      liveConnectConstraints: {
        model: GOOGLE_REALTIME_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: GOOGLE_REALTIME_VOICE },
            },
          },
          systemInstruction: "OpenClaw browser Talk live smoke.",
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      },
    },
  });
  const name = token.name?.trim();
  if (!name) {
    throw new Error("Google Live auth token response did not include a token name");
  }
  return name;
}

async function smokeGoogleLiveBrowserWs(browser: Browser, apiKey: string): Promise<SmokeResult> {
  try {
    const token = await createGoogleLiveToken(apiKey);
    const page = await browser.newPage();
    await page.evaluate("globalThis.__name = (fn) => fn");
    const result = await page.evaluate(
      async ({ model, tokenName, websocketUrl }) => {
        const debug: {
          opened: boolean;
          messages: string[];
          close?: { code: number; reason: string };
          error: boolean;
        } = { opened: false, messages: [], error: false };
        const dataToText = async (data: unknown): Promise<string> => {
          if (typeof data === "string") {
            return data;
          }
          if (data instanceof Blob) {
            return await data.text();
          }
          if (data instanceof ArrayBuffer) {
            return new TextDecoder().decode(data);
          }
          return String(data);
        };
        const url = new URL(websocketUrl);
        url.searchParams.set("access_token", tokenName);
        const ws = new WebSocket(url.toString());
        const done = new Promise<Record<string, unknown>>((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error(`Google Live setup timed out: ${JSON.stringify(debug)}`)),
            15_000,
          );
          ws.addEventListener("open", () => {
            debug.opened = true;
            ws.send(
              JSON.stringify({
                setup: {
                  model: model.startsWith("models/") ? model : `models/${model}`,
                  generationConfig: { responseModalities: ["AUDIO"] },
                  inputAudioTranscription: {},
                  outputAudioTranscription: {},
                },
              }),
            );
          });
          ws.addEventListener("message", (event) => {
            void (async () => {
              const text = await dataToText(event.data);
              debug.messages.push(text.slice(0, 300));
              const message = JSON.parse(text) as { setupComplete?: unknown };
              if (!message.setupComplete) {
                return;
              }
              window.clearTimeout(timeout);
              resolve({ setupComplete: true, readyState: ws.readyState });
            })().catch((error) => {
              window.clearTimeout(timeout);
              reject(error);
            });
          });
          ws.addEventListener("error", () => {
            debug.error = true;
            window.clearTimeout(timeout);
            reject(new Error("Google Live browser WebSocket errored"));
          });
          ws.addEventListener("close", (event) => {
            debug.close = { code: event.code, reason: event.reason };
            if (event.code !== 1000) {
              window.clearTimeout(timeout);
              reject(new Error(`Google Live browser WebSocket closed: ${JSON.stringify(debug)}`));
            }
          });
        });
        const value = await done;
        ws.close(1000);
        return value;
      },
      {
        model: GOOGLE_REALTIME_MODEL,
        tokenName: token,
        websocketUrl: GOOGLE_LIVE_WS_URL,
      },
    );
    await page.close();
    return {
      name: "google-live-browser-ws",
      ok: result.setupComplete === true,
      details: { model: GOOGLE_REALTIME_MODEL, setupComplete: result.setupComplete === true },
    };
  } catch (error) {
    return { name: "google-live-browser-ws", ok: false, details: { error: shortError(error) } };
  }
}

async function main(): Promise<void> {
  const openAIKey = getEnv("OPENAI_API_KEY");
  const googleKey = getEnv("GEMINI_API_KEY") ?? getEnv("GOOGLE_API_KEY");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const results: SmokeResult[] = [];
  try {
    if (!openAIKey) {
      results.push({
        name: "openai-webrtc-browser",
        ok: false,
        details: { error: "OPENAI_API_KEY missing" },
      });
    } else {
      results.push(await smokeOpenAIWebRtc(browser, openAIKey));
    }
    if (!googleKey) {
      results.push({
        name: "google-live-browser-ws",
        ok: false,
        details: { error: "GEMINI_API_KEY or GOOGLE_API_KEY missing" },
      });
    } else {
      results.push(await smokeGoogleLiveBrowserWs(browser, googleKey));
    }
    // FORK 2026-09-10: stock Control UI retired; skip the ui/ gateway-relay smoke.
    results.push({
      name: "gateway-relay-browser-adapter",
      ok: true,
      details: { skipped: "stock Control UI retired" },
    });
  } finally {
    await browser.close();
  }
  for (const result of results) {
    printResult(result);
  }
  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

await main();
