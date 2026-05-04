/**
 * FORK: tinkerclaw-people — profile markdown parsing.
 *
 * Computes deltaSinceLastConsult by extracting the "Recent asks" section and
 * keeping only date-prefixed bullets newer than `lastConsultedBythe user`. We
 * keep the parsing tolerant: bullets are `- YYYY-MM-DD ...` lines.
 */

const DATE_BULLET_RE = /^-\s*(\d{4}-\d{2}-\d{2})\b/;

export function extractRecentAsks(profileMd: string): { line: string; date: string }[] {
  const lines = profileMd.split(/\r?\n/);
  const out: { line: string; date: string }[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Recent asks\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) {
      break;
    }
    if (inSection) {
      const m = line.match(DATE_BULLET_RE);
      if (m) {
        out.push({ line, date: m[1] });
      }
    }
  }
  return out;
}

export function computeDelta(profileMd: string, lastConsultedBythe userIso?: string): string {
  if (!profileMd.trim()) return "";
  const bullets = extractRecentAsks(profileMd);
  if (bullets.length === 0) return "";
  if (!lastConsultedBythe userIso) {
    // first consult — show everything
    return bullets.map((b) => b.line).join("\n");
  }
  const cutoffDate = lastConsultedBythe userIso.slice(0, 10); // YYYY-MM-DD
  const fresh = bullets.filter((b) => b.date > cutoffDate);
  return fresh.map((b) => b.line).join("\n");
}
