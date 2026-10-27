import fx from "../../apps/android/app/src/thirdParty/assets/pack/voice-fx.json";
import { exaggerateIntonation, singingFork } from "./voice-intonation.js";
// FORK 2026-10-15 (the architect: "And what about Jarvis voice?" when the agent runs on the Pi). The
// `jarvis` script plays on the GATEWAY's speaker and also drops each line in a folder the Tinker
// plugin serves (/tinker/api/jarvis-voice/). A page opened from another machine polls for the
// newest line and plays new ones here. A page on the gateway's own machine does nothing: its
// speaker already spoke. Lines older than the page are never replayed.

export type VoiceFetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Newer id than the last one heard, or null. Ids are epoch-ms file names ("1739…123.wav"). */
export function nextToPlay(latest: string | null, lastHeard: string | null): string | null {
  if (!latest) return null;
  if (lastHeard && Number.parseInt(latest, 10) <= Number.parseInt(lastHeard, 10)) return null;
  return latest;
}

// 2026-10-22 (the architect 05:59: "Let's get you the GBD"): inside the Jarvis phone app, Jarvis's lines are
// spoken by the phone's own Google voice GBD (male British, online first) instead of the Pi's wav.
type NativeVoice = { name: string; network: boolean };
type JarvisNativeTts = {
  speak?: (id: string, text: string, rate: string, lang: string) => void;
  voices?: () => void;
  synth?: (id: string, text: string, rate: string, lang: string) => void;
};
let gbdName: string | null | undefined;
function nativeTts(): JarvisNativeTts | null {
  const n = (window as Window & { JarvisNative?: JarvisNativeTts }).JarvisNative;
  return n?.speak && n.voices ? n : null;
}
if (typeof window !== "undefined") {
  window.addEventListener("jarvis-native", (ev) => {
    const d = (ev as CustomEvent<{ ev?: string; list?: NativeVoice[] }>).detail;
    if (d?.ev !== "voices" || !Array.isArray(d.list)) return;
    const gbd = d.list
      .filter((v) => /-x-gbd-/.test(v.name))
      .sort((a, b) => Number(b.network) - Number(a.network))[0];
    gbdName = gbd?.name ?? null;
  });
}
// 2026-10-22 (the architect 06:17: "30% extra speed ... and the metallic voice. Make it sound like the old
// voice"): the app renders GBD to a wav and this chain copies the Pi's (jarvis-voice/bin/jarvis):
// pitch x0.92, 4/9 ms comb, flanger, 10 ms echo, high-pass 300 Hz, treble +8 dB, chorus, 60 Hz tremolo.
// 2026-10-23 (plan "phone app self-update", step 4): the numbers live in voice-fx.json, which the app
// reads from its content pack for the closed-app voice (JarvisVoiceFx.kt). Tune there, not here.
const INTONATION = fx.intonation.k; // pitch contour widened around the line's mean (14:42 the architect: "even more")
const SPEED = fx.speech.speed; // 30% faster
const PHONE_RATE = SPEED / fx.speech.playbackRate; // ... after the pitch drop slows it down
const pending = new Map<string, (b64: string | null) => void>();
if (typeof window !== "undefined") {
  window.addEventListener("jarvis-native", (ev) => {
    const d = (ev as CustomEvent<{ ev?: string; id?: string; b64?: string }>).detail;
    if (d?.ev !== "tts-audio" || !d.id) return;
    pending.get(d.id)?.(d.b64 ?? null);
    pending.delete(d.id);
  });
}
let audioCtx: AudioContext | null = null;

function delayTap(ctx: AudioContext, input: AudioNode, out: AudioNode, ms: number, gain: number) {
  const d = ctx.createDelay(0.1);
  d.delayTime.value = ms / 1000;
  const g = ctx.createGain();
  g.gain.value = gain;
  input.connect(d).connect(g).connect(out);
}

function lfo(ctx: AudioContext, hz: number, depth: number, target: AudioParam) {
  const o = ctx.createOscillator();
  o.frequency.value = hz;
  const g = ctx.createGain();
  g.gain.value = depth;
  o.connect(g).connect(target);
  o.start();
  return o;
}

// 13:37/13:48 the architect: tuning forks that resonate with the voice, but "only one fork should be active
// at any given time and its sound should be very metallic" -> singingFork() in voice-intonation.ts.
const RESONANCE = fx.fork.level; // the fork's loudness relative to the voice (0 = off)
const CHAIN = fx.chain;

async function playMetallic(b64: string): Promise<void> {
  audioCtx ??= new AudioContext();
  const ctx = audioCtx;
  if (ctx.state === "suspended") await ctx.resume();
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const raw = await ctx.decodeAudioData(bytes.buffer);
  // 13:17 the architect: highs higher, lows lower, linearly (voice-intonation.ts)
  const buf = ctx.createBuffer(1, raw.length, raw.sampleRate);
  const sung = exaggerateIntonation(raw.getChannelData(0), raw.sampleRate, INTONATION);
  const fork = singingFork(sung, raw.sampleRate, RESONANCE);
  const mixed = new Float32Array(sung.length);
  for (let i = 0; i < mixed.length; i++) mixed[i] = sung[i] + fork[i];
  buf.copyToChannel(mixed, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = fx.speech.playbackRate;
  // comb: [ms, gain] taps. 15:39 the architect: "clearer ... words more articulated": less rasp (dry 0.8,
  // 4 ms tap 0.4 -> 0.2, 9 ms tap off)
  const comb = ctx.createGain();
  for (const [ms, gain] of CHAIN.comb) delayTap(ctx, src, comb, ms, gain);
  // flanger: 0-4 ms sweep at 0.5 Hz with feedback
  const flang = ctx.createGain();
  comb.connect(flang);
  const fl = CHAIN.flanger;
  const fd = ctx.createDelay(0.02);
  fd.delayTime.value = fl.delayMs / 1000;
  const fb = ctx.createGain();
  fb.gain.value = fl.feedback; // 15:39 0.45 -> 0.25; 13:09 the architect: "too much reverberation" (was 0.6)
  const fwet = ctx.createGain();
  fwet.gain.value = fl.wet; // 15:39 (was 0.5)
  comb.connect(fd);
  fd.connect(fb).connect(fd);
  fd.connect(fwet).connect(flang);
  const lfos = [lfo(ctx, fl.rateHz, fl.depthMs / 1000, fd.delayTime)];
  // echo taps; 13:11 the architect: "remove more reverb" (the 10 ms tap is off)
  const echo = ctx.createGain();
  for (const [ms, gain] of CHAIN.echo) delayTap(ctx, flang, echo, ms, gain);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = CHAIN.highpass.hz;
  hp.Q.value = CHAIN.highpass.q;
  const treble = ctx.createBiquadFilter();
  treble.type = "highshelf";
  treble.frequency.value = CHAIN.treble.hz;
  treble.gain.value = CHAIN.treble.gainDb; // 15:39 (was 10)
  echo.connect(hp).connect(treble);
  // chorus: a swept delay over the dry signal (its wet is off: a 50 ms one read as a room echo)
  const ch = CHAIN.chorus;
  const chorus = ctx.createGain();
  delayTap(ctx, treble, chorus, 0, ch.dry);
  const cd = ctx.createDelay(0.1);
  cd.delayTime.value = ch.delayMs / 1000;
  const cw = ctx.createGain();
  cw.gain.value = ch.wet;
  treble.connect(cd).connect(cw).connect(chorus);
  lfos.push(lfo(ctx, ch.rateHz, ch.depthMs / 1000, cd.delayTime));
  // tremolo; 15:39 halved (was 0.89 / 0.11)
  const trem = ctx.createGain();
  trem.gain.value = CHAIN.tremolo.base;
  lfos.push(lfo(ctx, CHAIN.tremolo.rateHz, CHAIN.tremolo.depth, trem.gain));
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = CHAIN.limiter.thresholdDb;
  limiter.ratio.value = CHAIN.limiter.ratio;
  limiter.knee.value = CHAIN.limiter.kneeDb;
  limiter.attack.value = CHAIN.limiter.attackS;
  limiter.release.value = CHAIN.limiter.releaseS;
  const out = ctx.createGain();
  out.gain.value = CHAIN.gain;
  chorus.connect(trem).connect(out).connect(limiter).connect(ctx.destination);
  await new Promise<void>((resolve) => {
    src.onended = () => {
      lfos.forEach((o) => o.stop());
      resolve();
    };
    src.start();
  });
}

// Native speak() has no end callback: about 15 characters a second, plus a margin.
function speechMs(text: string): number {
  return 1500 + (text.length / 15) * 1000;
}

/** Plays a wav and resolves when it has finished (or failed), so the next line waits for it. */
export function playAudioToEnd(url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const a = new Audio(url);
    a.onended = () => resolve();
    a.onerror = () => resolve();
    a.play().catch(() => resolve());
  });
}

/**
 * Speaks `text` as Jarvis with the phone's GBD voice. Resolves when the line has been spoken; false when not in
 * the app, GBD is not there, or the Pi sent no text (a non-English line: play the wav, which has the right voice).
 */
export function speakOnPhone(text: string | null): Promise<void> | false {
  const n = nativeTts();
  if (!n || !text) return false;
  if (gbdName === undefined) {
    n.voices?.(); // the answer arrives as an event; this line still plays as a wav
    return false;
  }
  if (!gbdName) return false;
  const id = `jarvis-${Date.now()}`;
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  if (!n.synth) {
    n.speak?.(id, text, String(SPEED), `voice:${gbdName}`); // an app without synth: plain GBD, faster
    return wait(speechMs(text));
  }
  return new Promise<void>((resolve) => {
    pending.set(id, (b64) => {
      const fallback = () => {
        n.speak?.(id, text, String(SPEED), `voice:${gbdName}`);
        void wait(speechMs(text)).then(resolve);
      };
      if (!b64) return fallback();
      playMetallic(b64)
        .then(resolve)
        .catch((err) => {
          console.error("[voice-in-browser] metallic playback failed", err);
          fallback();
        });
    });
    n.synth?.(id, text, PHONE_RATE.toFixed(2), `voice:${gbdName}`);
  });
}

// FORK 2026-10-23 (the architect: "when I lock the screen I still want the vibration and your voice"). While
// the screen is off, a waiting phone prompt is handed to the Pi, which sends the line to the app's
// native jarvis.say. Lines spoken during the handoff count as heard, so unlocking replays nothing.
let handedOff = false;
export function setVoiceHandedOff(on: boolean): void {
  handedOff = on;
}
// A frozen page polls nothing; on unlock the next poll would find the line the phone already spoke.
let reprime = false;
export function skipMissedVoiceLines(): void {
  reprime = true;
}

export function startVoicePolling(opts: {
  base: string;
  fetchImpl?: VoiceFetch;
  /** text = the line's words when the server has them (2026-10-22, the phone app speaks them). */
  // 2026-10-27 (the architect: "two voice triggers can speak at the same time"): a play that returns a promise is
  // awaited before the next poll, so a new line waits for the one still speaking.
  play?: (url: string, text: string | null) => unknown;
  intervalMs?: number;
}): () => void {
  const fetchImpl = opts.fetchImpl ?? ((u: string) => fetch(u, { credentials: "same-origin" }));
  const play = opts.play ?? ((u: string) => playAudioToEnd(u));
  nativeTts()?.voices?.();
  let lastHeard: string | null = null;
  let primed = false;
  let stopped = false;
  const tick = async () => {
    try {
      const r = await fetchImpl(`${opts.base}/api/jarvis-voice/latest`);
      if (r.ok) {
        const body = (await r.json()) as { latest?: string | null; text?: string | null };
        const latest = body.latest ?? null;
        if (!primed || reprime) {
          reprime = false;
          lastHeard = latest; // what was said before this page opened is not replayed
          primed = true;
        } else {
          const id = nextToPlay(latest, lastHeard);
          if (id) {
            lastHeard = id;
            if (!handedOff) {
              const done = play(`${opts.base}/api/jarvis-voice/${id}`, body.text ?? null);
              if (done instanceof Promise) {
                // Capped, so a player that never ends cannot silence every later line.
                await Promise.race([
                  done.catch(() => undefined),
                  new Promise((r) => setTimeout(r, 120_000)),
                ]);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("[voice-in-browser] poll failed", err);
    }
    if (!stopped) setTimeout(tick, opts.intervalMs ?? 2500);
  };
  void tick();
  return () => {
    stopped = true;
  };
}
