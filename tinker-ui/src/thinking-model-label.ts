// The thinking indicator's model name, with the version spelled out.
//
// FORK 2026-09-24 (the architect: "put more detail into the model names in the thinking indicator
// in the chat. Now Opus can be 3 different versions. The chatgpt models too"). The row used
// shortModelLabel, which is sized for the picker's button grid: every Opus collapses to
// "Opus" and the current GPT major to a bare codename, so Opus 5.5, Opus 5 and Opus 4.8 all
// read the same while they answer. The thinking row has the width, so it names family AND
// version: Opus 5.5 · Opus 4.8 · Fable 5.1 · GPT-6 Sol · GPT-5.6 Terra · Grok 4.7.
//
// Returns "" when no family rule matches; the caller falls back to its panel label.
export function detailedModelLabel(id: string): string {
  const tail = (id.split("/").pop() || "").toLowerCase().replace(/^claude-/, "");
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const words = (v: string | undefined) => (v ? " " + v.split("-").map(cap).join(" ") : "");

  // opus-5-5 → Opus 5.5, opus-5 → Opus 5. The minor is 1–2 digits so a date stamp
  // (sonnet-4-20250514) is never read as one.
  const claude = tail.match(/^(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/);
  if (claude) {
    const [, fam, major, minor] = claude;
    return `${cap(fam)} ${major}${minor ? `.${minor}` : ""}`;
  }
  // gpt-6-sol → GPT-6 Sol, gpt-5.6-terra → GPT-5.6 Terra, gpt-5.5 → GPT-5.5.
  const gpt = tail.match(/^gpt-?(\d+(?:\.\d+)?)(?:-([a-z][a-z0-9-]*))?$/);
  if (gpt) {
    return `GPT-${gpt[1]}${words(gpt[2])}`;
  }
  // grok-4.7 → Grok 4.7 (4.7 and 4.6 both sit on the picker).
  const grok = tail.match(/^grok-?(\d+(?:\.\d+)?)(?:-([a-z][a-z0-9-]*))?$/);
  if (grok) {
    return `Grok ${grok[1]}${words(grok[2])}`;
  }
  // gemini-3.8-flash → Gemini 3.8 Flash.
  const gemini = tail.match(/^gemini-(\d+(?:\.\d+)?)(?:-([a-z][a-z0-9-]*))?$/);
  if (gemini) {
    return `Gemini ${gemini[1]}${words(gemini[2])}`;
  }
  return "";
}
