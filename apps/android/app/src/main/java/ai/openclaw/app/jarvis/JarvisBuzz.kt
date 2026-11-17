package ai.openclaw.app.jarvis

import android.content.Context

// FORK 2026-11-12: the buzz that says an answer is ready is the owner's choice, kept on the phone and
// picked in the app's settings (ui/SettingsSheet.kt), where rarely changed things live. A buzz that names
// no pattern (the Pi's turn-end wake, the page's own buzz) uses this one; a caller can still send its own.
// Shown as Morse: a dash is a long buzz, a dot a short one. The first is the default.
object JarvisBuzz {
  class Pattern(
    val morse: String,
    val label: String,
    /** on, off, on ... in milliseconds */
    val steps: List<Long>,
  )

  private const val PREFS = "jarvis.buzz"
  private const val KEY = "morse"
  private const val LONG = 450L
  private const val SHORT = 150L
  private const val GAP = 120L

  val patterns: List<Pattern> =
    listOf("— · ·", "·", "· ·", "· · ·", "— —", "· — ·").map { morse ->
      val marks = morse.split(" ")
      Pattern(
        morse = morse,
        label = marks.joinToString(", ") { if (it == "—") "long" else "short" },
        steps = marks.flatMapIndexed { i, m -> (if (i > 0) listOf(GAP) else emptyList()) + (if (m == "—") LONG else SHORT) },
      )
    }

  /** Index of the chosen pattern; 0 (one long, two short) until the owner picks another. */
  fun chosen(context: Context): Int {
    val morse = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
    return patterns.indexOfFirst { it.morse == morse }.coerceAtLeast(0)
  }

  fun choose(
    context: Context,
    index: Int,
  ) {
    val p = patterns.getOrNull(index) ?: return
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, p.morse).apply()
  }

  /** [0, on, off, on ...]: the shape the vibrator takes. */
  fun timings(context: Context): LongArray = (listOf(0L) + patterns[chosen(context)].steps).toLongArray()
}
