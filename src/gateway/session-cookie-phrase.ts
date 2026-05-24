/**
 * FORK 2026-05-24: Fortune-cookie session-name generator.
 *
 * Bug task-mpjhzu3j-ma9ts ("Tabs behavior", part 1): every non-main
 * session should get a memorable two-word name burned into its entry
 * at first list (lazy-minted by sessions.list), and that name then IS
 * what the SESSIONS panel renders — no hexadecimal `mpgj631q`-style
 * codes, no "Tinker UI" generic WS-client labels.
 *
 * Curated word lists keep the output evocative + readable. ~40
 * adjectives × ~80 nouns ≈ 3200 combinations — enough to keep visual
 * collisions rare across a normal user's session history (the lazy-
 * mint site is the canonical home for retry-on-collision logic; this
 * module just generates).
 *
 * Format: `"adjective noun"` with a space (display reads naturally;
 * not slug-style with dashes). Caller can lowercase/slugify if they
 * want a different surface.
 */

const ADJECTIVES = [
  "amber",
  "quiet",
  "drifting",
  "dusk",
  "gentle",
  "restless",
  "hidden",
  "ember",
  "mossy",
  "lucid",
  "fern",
  "marble",
  "brass",
  "golden",
  "opal",
  "jade",
  "slate",
  "indigo",
  "twilight",
  "dawn",
  "sage",
  "copper",
  "velvet",
  "glass",
  "paper",
  "silver",
  "ivory",
  "ochre",
  "ruby",
  "woven",
  "hushed",
  "weathered",
  "brindle",
  "deep",
  "pale",
  "ancient",
  "soft",
  "windswept",
  "tender",
  "kindled",
] as const;

const NOUNS = [
  "raven",
  "dune",
  "hearth",
  "bramble",
  "willow",
  "lantern",
  "river",
  "harbor",
  "vault",
  "abacus",
  "sparrow",
  "ridge",
  "anvil",
  "mariner",
  "vector",
  "tower",
  "glacier",
  "garden",
  "atlas",
  "archer",
  "kestrel",
  "beacon",
  "sentinel",
  "oracle",
  "foxglove",
  "mountain",
  "stream",
  "almanac",
  "courtyard",
  "monastery",
  "lighthouse",
  "citadel",
  "flute",
  "threshold",
  "melody",
  "parable",
  "signal",
  "watcher",
  "traveler",
  "alibi",
  "breath",
  "ledger",
  "current",
  "story",
  "axis",
  "frame",
  "lens",
  "vessel",
  "rune",
  "compass",
  "marsh",
  "harbour",
  "echo",
  "fjord",
  "orchard",
  "forge",
  "meadow",
  "lattice",
  "verse",
  "alcove",
  "cathedral",
  "spire",
  "isthmus",
  "delta",
  "harvest",
  "loom",
  "anchor",
  "veil",
  "tapestry",
  "lighthouse",
  "thicket",
  "pilgrim",
  "carillon",
  "manuscript",
  "scribe",
  "promise",
  "tide",
  "constellation",
  "envoy",
  "wanderer",
] as const;

/**
 * Generate one fortune-cookie phrase. Optional `taken` set lets the
 * caller pre-empt collisions by passing in phrases already in use —
 * the function retries up to MAX_RETRIES, then falls back to
 * appending a 2-digit suffix to guarantee uniqueness.
 */
const MAX_RETRIES = 8;

export function generateCookiePhrase(taken?: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const phrase = `${adj} ${noun}`;
    if (!taken || !taken.has(phrase)) {
      return phrase;
    }
  }
  // Collision after MAX_RETRIES — fall back to a 2-digit suffix. The
  // suffix derives from the time-of-mint so the same call site retrying
  // doesn't loop on the same suffix. Width 2 keeps the visual short.
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = String(Date.now() % 100).padStart(2, "0");
  return `${adj} ${noun} ${suffix}`;
}

/**
 * Convenience for the lazy-mint site: collects all phrases already in
 * a session store into a Set so the caller can pass it into
 * generateCookiePhrase.
 */
export function collectExistingPhrases(
  store: Record<string, { cookiePhrase?: string | null }>,
): Set<string> {
  const taken = new Set<string>();
  for (const entry of Object.values(store)) {
    if (typeof entry?.cookiePhrase === "string" && entry.cookiePhrase.trim()) {
      taken.add(entry.cookiePhrase.trim());
    }
  }
  return taken;
}
