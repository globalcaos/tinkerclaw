// FORK 2026-10-22 (the architect 13:17: "exaggerate the intonation, meaning higher pitch for the highs and
// lower pitch for the lows, linearly across"). The phone renders Jarvis's line with Google's GBD voice;
// before the metallic chain, this widens its pitch contour around the line's own average:
//   f0' = mean · (f0 / mean)^k     (linear on the log-pitch scale, k > 1 exaggerates)
// Pitch is tracked every 10 ms by autocorrelation and moved with TD-PSOLA, so timing is unchanged.
// 2026-10-23 (plan "phone app self-update", step 4): every number below comes from voice-fx.json, the
// one file the app reads too (the factory content pack; JarvisVoiceFx.kt). Tune there, not here.
import fx from "../../apps/android/app/src/thirdParty/assets/pack/voice-fx.json";

const MIN_HZ = fx.pitch.minHz;
const MAX_HZ = fx.pitch.maxHz;

/** Pitch (Hz) per 10 ms frame; 0 = unvoiced. */
export function trackPitch(x: Float32Array, sr: number, hop: number, win: number): Float32Array {
  const minLag = Math.floor(sr / MAX_HZ);
  const maxLag = Math.ceil(sr / MIN_HZ);
  let sum = 0;
  for (const v of x) sum += v * v;
  const rms = Math.sqrt(sum / Math.max(1, x.length));
  const floor = win * (0.1 * rms) ** 2;
  const n = Math.max(0, Math.floor((x.length - win - maxLag) / hop));
  const f0 = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const s = f * hop;
    let e0 = 0;
    for (let i = s; i < s + win; i++) e0 += x[i] * x[i];
    if (e0 < floor) continue;
    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let num = 0;
      let e1 = 0;
      for (let i = s; i < s + win; i++) {
        num += x[i] * x[i + lag];
        e1 += x[i + lag] * x[i + lag];
      }
      const r = num / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    if (best > 0.6) f0[f] = sr / bestLag;
  }
  // a 5-frame median removes single-frame octave slips
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    if (!f0[f]) continue;
    const w: number[] = [];
    for (let j = Math.max(0, f - 2); j <= Math.min(n - 1, f + 2); j++) if (f0[j]) w.push(f0[j]);
    w.sort((a, b) => a - b);
    out[f] = w[w.length >> 1];
  }
  return out;
}

/** Returns a copy of `x` with its pitch contour widened by `k` around its mean (k = 1: unchanged). */
export function exaggerateIntonation(x: Float32Array, sr: number, k: number): Float32Array {
  const hop = Math.round(sr * 0.01);
  const win = Math.round(sr * 0.04);
  const f0 = trackPitch(x, sr, hop, win);
  let logSum = 0;
  let voiced = 0;
  for (const v of f0) {
    if (v) {
      logSum += Math.log(v);
      voiced++;
    }
  }
  if (voiced < 5 || k === 1) return x;
  const logMean = logSum / voiced;
  const frameOf = (t: number) =>
    Math.min(f0.length - 1, Math.max(0, Math.round((t - win / 2) / hop)));
  const period = (fi: number) => (f0[fi] ? sr / f0[fi] : hop);
  const ratio = (fi: number) =>
    f0[fi]
      ? Math.min(
          fx.intonation.ratioMax,
          Math.max(fx.intonation.ratioMin, Math.exp((k - 1) * (Math.log(f0[fi]) - logMean))),
        )
      : 1;

  // analysis marks: one per pitch period (one per hop when unvoiced)
  const marks: number[] = [];
  for (let t = 0; t < x.length; t += period(frameOf(t))) marks.push(Math.round(t));

  const out = new Float32Array(x.length);
  const wsum = new Float32Array(x.length);
  let j = 0;
  for (let ts = 0; ts < x.length; ) {
    while (j + 1 < marks.length && Math.abs(marks[j + 1] - ts) <= Math.abs(marks[j] - ts)) j++;
    const ta = marks[j];
    const fi = frameOf(ta);
    const p = period(fi);
    const L = Math.max(2, Math.round(p));
    const at = Math.round(ts);
    for (let n = -L; n <= L; n++) {
      const src = ta + n;
      const dst = at + n;
      if (src < 0 || src >= x.length || dst < 0 || dst >= x.length) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * n) / L);
      out[dst] += x[src] * w;
      wsum[dst] += w;
    }
    ts += p / ratio(fi);
  }
  for (let i = 0; i < out.length; i++) out[i] /= Math.max(wsum[i], 1);
  return out;
}

// 13:48 the architect: "only one fork should be active at any given time and its sound should be very
// metallic". A single struck-metal "tuning fork" sings along: it snaps to the grid note (FORK_STEP) nearest the
// voice's current pitch (sung FORK_OCTAVE above it), switches hard (3 ms) when the voice moves to
// another note, is driven by the voice's loudness and stops 30 ms after it (no tail, 14:23).
// Timbre = free metal bar partials (glockenspiel, BAR_MIX) over a quiet metallic vowel (below).
// 15:14 the architect: "more metallic": brighter inharmonic overtones (were 0.5/0.25/0.12)
const FORK_PARTIALS = fx.fork.partials as Array<[number, number]>;

// 14:10 the architect: the fork should "sound like a very metallic vowel your voice would produce at that
// pitch". So each fork is a sung "ah" (British /a:/ formants 700/1100/2600 Hz) built from the note's
// harmonics; narrow formants make the vowel ring like metal. Tuning history: 14:21 formants narrowed
// to 40/50/70 Hz; 14:25 the bar clang became the main sound (BAR_MIX 1.0) and the vowel was halved.
// 15:14: narrower again (were 40/50/70 Hz), rings rather than speaks
const VOWEL = fx.fork.vowel as Array<[number, number, number]>;
const BAR_MIX = fx.fork.barMix; // 15:14 the architect: "more metallic" (was 1.0)
// 14:21 the architect: "40% at this pitch and 60% an extra octave higher".
// 14:57 the architect: "a 40/50/10 fork split in octaves, having the 40 a lower octave than now":
// 40% at the voice's own note, 50% one octave up (where the main layer was), 10% two octaves up.
// Same total vowel level as before (0.5).
const LAYER_BASE = fx.fork.layerBase; // vowel 30% down at 15:14 (more metal), 40/50/10 kept
const LAYER_LOW = fx.fork.layerLow;
const LAYER_HIGH = fx.fork.layerHigh;
const BAR_OCTAVE = fx.fork.barOctave; // the struck-bar clang stays one octave above the voice, where it was
// 14:31 the architect: "bring down the number of forks to half, so the effect sounds more radical":
// one fork every 4 semitones (major thirds, 3 per octave) instead of every whole tone.
const FORK_STEP = fx.fork.step;
// 20:05 the architect: "exaggerate now only the tune forks' intonation": the fork's pitch is pushed away
// from the line's average pitch by this factor before it snaps to the grid (1 = follows the voice).
// The voice itself is not touched by this (its own widening is INTONATION in voice-in-browser.ts).
const FORK_INTONATION = fx.fork.forkIntonation;
const FORK_OCTAVE = fx.fork.octave; // base layer at the voice's own grid note; the 50/10 layers sit 1 and 2 octaves up

function vowelAmps(note: number, sr: number): number[] {
  const amps: number[] = [];
  for (let k = 1; k * note < Math.min(fx.fork.vowelMaxHz, sr * fx.fork.nyquist); k++) {
    const h = k * note;
    let g = fx.fork.buzz / k; // a little of the plain buzz so low notes still sound
    for (const [f, a, bw] of VOWEL) g += a * Math.exp(-(((h - f) / bw) ** 2));
    amps.push(g);
  }
  const rms = Math.sqrt(amps.reduce((s, a) => s + (a * a) / 2, 0)) || 1;
  return amps.map((a) => (fx.fork.vowelGain * a) / rms);
}

type Fork = {
  note: number;
  env: number;
  phase: number[];
  vowel: number[];
  vowelHigh: number[];
  vowelTop: number[];
  vphase: number;
};

/** The fork track to add to `x` (same length); `level` is its loudness relative to the voice. */
export function singingFork(x: Float32Array, sr: number, level: number): Float32Array {
  const hop = Math.round(sr * 0.01);
  const win = Math.round(sr * 0.04);
  const f0 = trackPitch(x, sr, hop, win);
  const out = new Float32Array(x.length);
  if (!f0.length || level <= 0) return out;
  let logSum = 0;
  let voiced = 0;
  for (const v of f0) {
    if (v) {
      logSum += Math.log(v);
      voiced++;
    }
  }
  const logMean = voiced ? logSum / voiced : 0;
  const energy = new Float32Array(f0.length);
  for (let f = 0; f < f0.length; f++) {
    let e = 0;
    for (let i = f * hop; i < f * hop + win; i++) e += x[i] * x[i];
    energy[f] = Math.sqrt(e / win);
  }
  // 14:21 the architect: "like ... Believe from Cher": hard 3 ms note switch, the note held while the voice
  // sounds. 14:23 the architect: "remove the reverb in the tune forks": no tail, it stops 30 ms after the voice.
  const ring = Math.exp(-1 / ((fx.fork.ringMs / 1000) * sr));
  const fade = Math.exp(-1 / ((fx.fork.fadeMs / 1000) * sr));
  const attack = 1 - Math.exp(-1 / ((fx.fork.attackMs / 1000) * sr));
  const nyq = sr * fx.fork.nyquist;
  const newFork = (note: number): Fork => ({
    note,
    env: 0,
    phase: FORK_PARTIALS.map(() => 0),
    vowel: note ? vowelAmps(note, sr) : [],
    vowelHigh: note ? vowelAmps(2 * note, sr) : [],
    vowelTop: note ? vowelAmps(4 * note, sr) : [],
    vphase: 0,
  });
  let cur = newFork(0);
  let old = newFork(0);
  const sing = (fk: Fork) => {
    let s = 0;
    FORK_PARTIALS.forEach(([mult, amp], p) => {
      const hz = BAR_OCTAVE * fk.note * mult;
      if (hz >= nyq) return;
      fk.phase[p] += (2 * Math.PI * hz) / sr;
      s += amp * Math.sin(fk.phase[p]);
    });
    s *= BAR_MIX;
    fk.vphase += (2 * Math.PI * fk.note) / sr;
    for (let k = 0; k < fk.vowel.length; k++)
      s += LAYER_BASE * fk.vowel[k] * Math.sin((k + 1) * fk.vphase);
    for (let k = 0; k < fk.vowelHigh.length; k++)
      s += LAYER_LOW * fk.vowelHigh[k] * Math.sin(2 * (k + 1) * fk.vphase);
    for (let k = 0; k < fk.vowelTop.length; k++)
      s += LAYER_HIGH * fk.vowelTop[k] * Math.sin(4 * (k + 1) * fk.vphase);
    return fk.env * s;
  };
  for (let i = 0; i < x.length; i++) {
    const fi = Math.min(f0.length - 1, Math.max(0, Math.round((i - win / 2) / hop)));
    const hz = f0[fi];
    if (hz) {
      // the fork's own exaggerated pitch, then the grid note nearest it (FORK_STEP)
      const forkHz = Math.min(
        fx.fork.forkMaxHz,
        Math.max(fx.fork.forkMinHz, Math.exp(logMean + FORK_INTONATION * (Math.log(hz) - logMean))),
      );
      const grid = fx.fork.gridHz;
      const note =
        FORK_OCTAVE *
        grid *
        2 ** ((FORK_STEP * Math.round((Math.log2(forkHz / grid) * 12) / FORK_STEP)) / 12);
      if (note !== cur.note) {
        old = cur;
        cur = newFork(note);
      }
      const drive = energy[fi];
      cur.env = drive > cur.env ? cur.env + (drive - cur.env) * attack : cur.env * ring;
    } else {
      cur.env *= ring;
    }
    old.env *= fade;
    out[i] = (level / fx.fork.norm) * (sing(cur) + sing(old));
  }
  return out;
}
