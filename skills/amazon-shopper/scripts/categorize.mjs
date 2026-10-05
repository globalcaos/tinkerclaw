// categorize.mjs — LLM categorizer + qualifying-question generator.
import { callLLM } from "./llm.mjs";

const SYSTEM = `\
You are categorizing Amazon product search results into a small set of meaningful
axes (form, concentration, package size, etc) and generating UP TO 2 qualifying
questions for the user.

Hard rules:
- Maximum 2 qualifying questions per search.
- Each question MUST have a non-empty 'why_load_bearing' field that states WHY
  the answer would change the recommendation. If you can't justify a question,
  drop it.
- Options are short, mutually exclusive strings the user picks from.

Return ONLY a JSON object matching:
{
  "axes": [{ "id": "<axis_name>", "values": ["..."] }],
  "qualifying_questions": [
    { "id": "<short_slug>", "text": "<question>", "options": ["..."], "why_load_bearing": "<one sentence>" }
  ]
}`;

function userPrompt(products) {
  const sample = products
    .slice(0, 20)
    .map((p, i) => `${i + 1}. [${p.asin}] ${p.title}`)
    .join("\n");
  return `Products from the Amazon.es search (top ${Math.min(products.length, 20)}):\n\n${sample}\n\nReturn axes + ≤2 qualifying questions per the schema.`;
}

export async function categorize(products) {
  const r = await callLLM({
    call_site: "categorize",
    system: SYSTEM,
    user: userPrompt(products),
  });
  const axes = Array.isArray(r.axes) ? r.axes : [];
  const qs = Array.isArray(r.qualifying_questions) ? r.qualifying_questions.slice(0, 2) : [];
  const valid = qs.filter(
    (q) => q.id && q.text && Array.isArray(q.options) && q.why_load_bearing?.length > 5,
  );
  return { axes, qualifying_questions: valid };
}
