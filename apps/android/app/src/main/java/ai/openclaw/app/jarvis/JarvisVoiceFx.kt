package ai.openclaw.app.jarvis

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * FORK 2026-10-22 (the architect: "reach me anytime by voice"). Jarvis's phone voice without the Tinker page:
 * the same processing as tinker-ui/src/voice-intonation.ts (exaggerateIntonation, singingFork) and the
 * Web Audio chain in voice-in-browser.ts (playMetallic), so a line spoken with the app closed sounds
 * like one spoken in the app. The x0.92 pitch drop is not here: the player plays at playbackRate.
 *
 * 2026-10-23 (plan "phone app self-update", step 4): no tuning number lives in this file any more.
 * They all come from voice-fx.json in the content pack (JarvisPack.voiceFx), the same file the page is
 * built with. Every field is required, so a pack that lacks one falls back to the APK's own copy
 * instead of a number guessed here. voice-parity.sh checks that this file reads every key.
 */
@Serializable
data class VoiceFx(
  val format: Int,
  val speech: Speech,
  val pitch: Pitch,
  val intonation: Intonation,
  val fork: Fork,
  val chain: Chain,
) {
  @Serializable
  data class Speech(
    val speed: Double,
    val playbackRate: Double,
  )

  @Serializable
  data class Pitch(
    val minHz: Double,
    val maxHz: Double,
  )

  @Serializable
  data class Intonation(
    val k: Double,
    val ratioMin: Double,
    val ratioMax: Double,
  )

  @Serializable
  data class Fork(
    val level: Double,
    val partials: List<List<Double>>,
    val vowel: List<List<Double>>,
    val barMix: Double,
    val layerBase: Double,
    val layerLow: Double,
    val layerHigh: Double,
    val barOctave: Double,
    val step: Double,
    val forkIntonation: Double,
    val octave: Double,
    val gridHz: Double,
    val forkMinHz: Double,
    val forkMaxHz: Double,
    val ringMs: Double,
    val fadeMs: Double,
    val attackMs: Double,
    val nyquist: Double,
    val vowelMaxHz: Double,
    val buzz: Double,
    val vowelGain: Double,
    val norm: Double,
  )

  @Serializable
  data class Chain(
    val comb: List<List<Double>>,
    val flanger: Flanger,
    val echo: List<List<Double>>,
    val highpass: Highpass,
    val treble: Treble,
    val chorus: Chorus,
    val tremolo: Tremolo,
    val gain: Double,
    val limiter: Limiter,
  )

  @Serializable
  data class Flanger(
    val delayMs: Double,
    val depthMs: Double,
    val rateHz: Double,
    val feedback: Double,
    val wet: Double,
  )

  @Serializable
  data class Highpass(
    val hz: Double,
    val q: Double,
  )

  @Serializable
  data class Treble(
    val hz: Double,
    val gainDb: Double,
  )

  @Serializable
  data class Chorus(
    val dry: Double,
    val delayMs: Double,
    val depthMs: Double,
    val rateHz: Double,
    val wet: Double,
  )

  @Serializable
  data class Tremolo(
    val base: Double,
    val depth: Double,
    val rateHz: Double,
  )

  @Serializable
  data class Limiter(
    val thresholdDb: Double,
    val ratio: Double,
    val kneeDb: Double,
    val attackS: Double,
    val releaseS: Double,
  )

  companion object {
    private val json = Json { ignoreUnknownKeys = true }

    fun parse(raw: String): VoiceFx = json.decodeFromString(serializer(), raw)
  }
}

object JarvisVoiceFx {
  /**
   * Web Audio clamps a DelayNode inside a feedback loop to one render quantum (128 frames, at the
   * phone's 48 kHz). The page's flanger is such a loop, so its delay never goes below this.
   */
  private const val LOOP_MIN_S = 128.0 / 48_000

  /** Intonation, fork and chain at the TTS rate `sr`; the result is meant to play at sr x playbackRate. */
  fun process(
    x: FloatArray,
    sr: Int,
    fx: VoiceFx,
  ): FloatArray {
    val sung = exaggerateIntonation(x, sr, fx.intonation.k, fx)
    val fork = singingFork(sung, sr, fx.fork.level, fx)
    val mixed = FloatArray(sung.size) { sung[it] + fork[it] }
    // After playbackRate a sample lasts 1/(sr x rate) s: the chain's times are in that clock.
    return chain(mixed, sr * fx.speech.playbackRate, fx.chain)
  }

  /** Pitch per 10 ms frame (Hz), 0 = unvoiced. */
  internal fun trackPitch(
    x: FloatArray,
    sr: Int,
    hop: Int,
    win: Int,
    fx: VoiceFx,
  ): FloatArray {
    val minLag = floor(sr / fx.pitch.maxHz).toInt()
    val maxLag = kotlin.math.ceil(sr / fx.pitch.minHz).toInt()
    var sum = 0.0
    for (v in x) sum += v * v
    val rms = sqrt(sum / max(1, x.size))
    val floorE = win * (0.1 * rms) * (0.1 * rms)
    val n = max(0, (x.size - win - maxLag) / hop)
    val f0 = FloatArray(n)
    for (f in 0 until n) {
      val s = f * hop
      var e0 = 0.0
      for (i in s until s + win) e0 += x[i] * x[i]
      if (e0 < floorE) continue
      var best = 0.0
      var bestLag = 0
      for (lag in minLag..maxLag) {
        var num = 0.0
        var e1 = 0.0
        for (i in s until s + win) {
          num += x[i] * x[i + lag]
          e1 += x[i + lag] * x[i + lag]
        }
        val r = num / sqrt(e0 * e1 + 1e-12)
        if (r > best) {
          best = r
          bestLag = lag
        }
      }
      if (best > 0.6) f0[f] = (sr.toDouble() / bestLag).toFloat()
    }
    // a 5-frame median removes single-frame octave slips
    val out = FloatArray(n)
    for (f in 0 until n) {
      if (f0[f] == 0f) continue
      val w = (max(0, f - 2)..min(n - 1, f + 2)).map { f0[it] }.filter { it > 0f }.sorted()
      out[f] = w[w.size / 2]
    }
    return out
  }

  /** Pitch contour widened by k around the line's mean (TD-PSOLA); timing unchanged. */
  internal fun exaggerateIntonation(
    x: FloatArray,
    sr: Int,
    k: Double,
    fx: VoiceFx,
  ): FloatArray {
    val hop = (sr * 0.01).roundToInt()
    val win = (sr * 0.04).roundToInt()
    val f0 = trackPitch(x, sr, hop, win, fx)
    val voiced = f0.filter { it > 0f }
    if (voiced.size < 5 || k == 1.0) return x
    val logMean = voiced.sumOf { ln(it.toDouble()) } / voiced.size

    // as on the page: the frame of a fractional time, win / 2 not rounded
    fun frameOf(t: Double) = min(f0.size - 1, max(0, ((t - win / 2.0) / hop).roundToInt()))

    fun period(fi: Int) = if (f0[fi] > 0f) sr / f0[fi].toDouble() else hop.toDouble()

    fun ratio(fi: Int) =
      if (f0[fi] > 0f) {
        min(fx.intonation.ratioMax, max(fx.intonation.ratioMin, exp((k - 1) * (ln(f0[fi].toDouble()) - logMean))))
      } else {
        1.0
      }

    val marks = ArrayList<Int>()
    var t = 0.0
    while (t < x.size) {
      marks.add(t.roundToInt())
      t += period(frameOf(t))
    }
    val out = FloatArray(x.size)
    val wsum = FloatArray(x.size)
    var j = 0
    var ts = 0.0
    while (ts < x.size) {
      while (j + 1 < marks.size && abs(marks[j + 1] - ts) <= abs(marks[j] - ts)) j++
      val ta = marks[j]
      val fi = frameOf(ta.toDouble())
      val p = period(fi)
      val l = max(2, p.roundToInt())
      val at = ts.roundToInt()
      for (n in -l..l) {
        val src = ta + n
        val dst = at + n
        if (src < 0 || src >= x.size || dst < 0 || dst >= x.size) continue
        val w = (0.5 + 0.5 * cos(PI * n / l)).toFloat()
        out[dst] += x[src] * w
        wsum[dst] += w
      }
      ts += p / ratio(fi)
    }
    for (i in out.indices) out[i] /= max(wsum[i], 1f)
    return out
  }

  private fun vowelAmps(
    note: Double,
    sr: Int,
    f: VoiceFx.Fork,
  ): DoubleArray {
    val amps = ArrayList<Double>()
    var k = 1
    while (k * note < min(f.vowelMaxHz, sr * f.nyquist)) {
      val h = k * note
      var g = f.buzz / k // a little of the plain buzz so low notes still sound
      for (v in f.vowel) g += v[1] * exp(-((h - v[0]) / v[2]).pow(2))
      amps.add(g)
      k++
    }
    val rms = sqrt(amps.sumOf { it * it / 2 }).takeIf { it > 0 } ?: 1.0
    return DoubleArray(amps.size) { f.vowelGain * amps[it] / rms }
  }

  private class Fork(
    val note: Double,
    var env: Double,
    val phase: DoubleArray,
    val vowel: DoubleArray,
    val vowelHigh: DoubleArray,
    val vowelTop: DoubleArray,
    var vphase: Double,
  )

  /** The fork track to add to `x` (same length); `level` is its loudness relative to the voice. */
  internal fun singingFork(
    x: FloatArray,
    sr: Int,
    level: Double,
    fx: VoiceFx,
  ): FloatArray {
    val f = fx.fork
    val hop = (sr * 0.01).roundToInt()
    val win = (sr * 0.04).roundToInt()
    val f0 = trackPitch(x, sr, hop, win, fx)
    val out = FloatArray(x.size)
    if (f0.isEmpty() || level <= 0) return out
    val voicedF = f0.filter { it > 0f }
    val logMean = if (voicedF.isEmpty()) 0.0 else voicedF.sumOf { ln(it.toDouble()) } / voicedF.size
    val energy = DoubleArray(f0.size)
    for (fi in f0.indices) {
      var e = 0.0
      for (i in fi * hop until fi * hop + win) e += x[i] * x[i]
      energy[fi] = sqrt(e / win)
    }
    val ring = exp(-1 / (f.ringMs / 1000 * sr))
    val fade = exp(-1 / (f.fadeMs / 1000 * sr))
    val attack = 1 - exp(-1 / (f.attackMs / 1000 * sr))
    val nyq = sr * f.nyquist

    fun newFork(note: Double) =
      Fork(
        note = note,
        env = 0.0,
        phase = DoubleArray(f.partials.size),
        vowel = if (note > 0) vowelAmps(note, sr, f) else DoubleArray(0),
        vowelHigh = if (note > 0) vowelAmps(2 * note, sr, f) else DoubleArray(0),
        vowelTop = if (note > 0) vowelAmps(4 * note, sr, f) else DoubleArray(0),
        vphase = 0.0,
      )

    fun sing(fk: Fork): Double {
      var s = 0.0
      f.partials.forEachIndexed { p, pa ->
        val hz = f.barOctave * fk.note * pa[0]
        if (hz >= nyq) return@forEachIndexed
        fk.phase[p] += 2 * PI * hz / sr
        s += pa[1] * sin(fk.phase[p])
      }
      s *= f.barMix
      fk.vphase += 2 * PI * fk.note / sr
      for (k in fk.vowel.indices) s += f.layerBase * fk.vowel[k] * sin((k + 1) * fk.vphase)
      for (k in fk.vowelHigh.indices) s += f.layerLow * fk.vowelHigh[k] * sin(2 * (k + 1) * fk.vphase)
      for (k in fk.vowelTop.indices) s += f.layerHigh * fk.vowelTop[k] * sin(4 * (k + 1) * fk.vphase)
      return fk.env * s
    }
    var cur = newFork(0.0)
    var old = newFork(0.0)
    for (i in x.indices) {
      val fi = min(f0.size - 1, max(0, ((i - win / 2.0) / hop).roundToInt()))
      val hz = f0[fi].toDouble()
      if (hz > 0) {
        // the fork's own exaggerated pitch, then the grid note nearest it (step)
        val forkHz = min(f.forkMaxHz, max(f.forkMinHz, exp(logMean + f.forkIntonation * (ln(hz) - logMean))))
        val note = f.octave * f.gridHz * 2.0.pow(f.step * Math.round(log2(forkHz / f.gridHz) * 12 / f.step).toDouble() / 12)
        if (note != cur.note) {
          old = cur
          cur = newFork(note)
        }
        val drive = energy[fi]
        cur.env = if (drive > cur.env) cur.env + (drive - cur.env) * attack else cur.env * ring
      } else {
        cur.env *= ring
      }
      old.env *= fade
      out[i] = (level / f.norm * (sing(cur) + sing(old))).toFloat()
    }
    return out
  }

  private class Biquad(
    val b0: Double,
    val b1: Double,
    val b2: Double,
    val a1: Double,
    val a2: Double,
  ) {
    var x1 = 0.0
    var x2 = 0.0
    var y1 = 0.0
    var y2 = 0.0

    fun run(v: Double): Double {
      val y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = v
      y2 = y1
      y1 = y
      return y
    }
  }

  /** Web Audio's highpass: Q in dB. */
  private fun highpass(
    f: Double,
    qDb: Double,
    sr: Double,
  ): Biquad {
    val w = 2 * PI * f / sr
    val alpha = sin(w) / (2 * 10.0.pow(qDb / 20))
    val c = cos(w)
    val a0 = 1 + alpha
    return Biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0)
  }

  /** Web Audio's highshelf (slope 1). */
  private fun highshelf(
    f: Double,
    gainDb: Double,
    sr: Double,
  ): Biquad {
    val a = 10.0.pow(gainDb / 40)
    val w = 2 * PI * f / sr
    val c = cos(w)
    val alpha = sin(w) / 2 * sqrt(2.0)
    val sa = 2 * sqrt(a) * alpha
    val a0 = (a + 1) - (a - 1) * c + sa
    return Biquad(
      a * ((a + 1) + (a - 1) * c + sa) / a0,
      -2 * a * ((a - 1) + (a + 1) * c) / a0,
      a * ((a + 1) + (a - 1) * c - sa) / a0,
      2 * ((a - 1) - (a + 1) * c) / a0,
      ((a + 1) - (a - 1) * c - sa) / a0,
    )
  }

  /** Linear read of `line` at fractional index `pos` (only past samples; 0 before the start). */
  private fun at(
    line: FloatArray,
    pos: Double,
  ): Double {
    val i0 = floor(pos).toInt()
    if (i0 < 0) return 0.0
    val frac = pos - i0
    val a = line[i0].toDouble()
    val b = if (i0 + 1 < line.size) line[i0 + 1].toDouble() else 0.0
    return a * (1 - frac) + b * frac
  }

  /** Sum of [delay ms, gain] taps, as delayTap() builds them on the page. */
  private fun taps(
    x: FloatArray,
    taps: List<List<Double>>,
    sr: Double,
  ): FloatArray {
    val out = FloatArray(x.size)
    for (t in taps) {
      val g = t[1]
      if (g == 0.0) continue
      val d = (t[0] / 1000 * sr).roundToInt()
      for (i in d until x.size) out[i] += (g * x[i - d]).toFloat()
    }
    return out
  }

  /** playMetallic's node graph, sample by sample: comb, flanger, echo, high-pass, treble, chorus, tremolo, gain, limiter. */
  private fun chain(
    x: FloatArray,
    sr: Double,
    c: VoiceFx.Chain,
  ): FloatArray {
    val n = x.size
    val comb = taps(x, c.comb, sr)
    // flanger: flang = comb + wet x fd; fd = delay(comb + feedback x fd), delay swept by an LFO
    val fl = c.flanger
    val loopIn = FloatArray(n)
    val flang = FloatArray(n)
    val minLoop = LOOP_MIN_S * sr
    for (i in 0 until n) {
      val d = max(minLoop, (fl.delayMs + fl.depthMs * sin(2 * PI * fl.rateHz * i / sr)) / 1000 * sr)
      val fd = at(loopIn, i - d)
      loopIn[i] = (comb[i] + fl.feedback * fd).toFloat()
      flang[i] = (comb[i] + fl.wet * fd).toFloat()
    }
    val echo = taps(flang, c.echo, sr)
    val hp = highpass(c.highpass.hz, c.highpass.q, sr)
    val shelf = highshelf(c.treble.hz, c.treble.gainDb, sr)
    val treb = FloatArray(n) { shelf.run(hp.run(echo[it].toDouble())).toFloat() }
    val ch = c.chorus
    val tr = c.tremolo
    val out = FloatArray(n)
    for (i in 0 until n) {
      val cd = (ch.delayMs + ch.depthMs * sin(2 * PI * ch.rateHz * i / sr)) / 1000 * sr
      val chorus = ch.dry * treb[i] + (if (ch.wet != 0.0) ch.wet * at(treb, i - cd) else 0.0)
      val trem = tr.base + tr.depth * sin(2 * PI * tr.rateHz * i / sr)
      out[i] = (chorus * trem * c.gain).toFloat()
    }
    return limit(out, sr, c.limiter)
  }

  /**
   * DynamicsCompressorNode, approximately: soft knee from threshold to threshold + knee, attack and
   * release on the gain reduction, and the node's automatic make-up gain ((1 / gain at 0 dBFS)^0.6).
   */
  private fun limit(
    x: FloatArray,
    sr: Double,
    l: VoiceFx.Limiter,
  ): FloatArray {
    fun curveDb(inDb: Double): Double {
      val t = l.thresholdDb
      val k = l.kneeDb
      return when {
        inDb <= t -> inDb
        inDb <= t + k -> inDb + (1 / l.ratio - 1) * (inDb - t).pow(2) / (2 * k)
        else -> t + k / 2 + k / (2 * l.ratio) + (inDb - t - k) / l.ratio
      }
    }
    val makeup = 10.0.pow(-curveDb(0.0) / 20 * 0.6)
    val att = exp(-1 / (l.attackS * sr))
    val rel = exp(-1 / (l.releaseS * sr))
    var reduction = 0.0
    val out = FloatArray(x.size)
    for (i in x.indices) {
      val v = x[i].toDouble()
      val inDb = if (v == 0.0) -120.0 else 20 * kotlin.math.log10(abs(v))
      val want = inDb - curveDb(inDb)
      reduction = if (want > reduction) att * reduction + (1 - att) * want else rel * reduction + (1 - rel) * want
      out[i] = (v * 10.0.pow(-reduction / 20) * makeup).toFloat()
    }
    return out
  }
}
