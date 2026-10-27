#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook: on plain Claude Code, name the saved recipes a prompt may match.
 *
 * FORK 2026-10-09 — a TinkerClaw chat worker gets recipe matching from the gateway on every turn;
 * plain Claude Code got none, so a saved recipe went unused unless the model thought to look. This
 * hook reads the catalog the gateway's prefrontal plugin publishes and adds, under the prompt, up to
 * MAX_HINTS recipes whose words overlap it. A keyword match, not a decision: the model opens the
 * recipe and judges. It is code rather than a prompt rule because the want is "every prompt, the same
 * way"; which recipe fits stays the model's call.
 *
 * THE CATALOG (a contract the prefrontal plugin publishes):
 *   <state dir>/prefrontal/recipe-index.json =
 *   {"version":1,"generatedAt":"ISO","recipes":[{"slug","owner","title","summary","tags":[…],
 *     "category"?,"subdivision"?,"path"}]}
 * Missing, not JSON, or no recipes array: silent.
 *
 * SCORING. Words of 3+ chars, lowercased and accent-folded, minus a short English/Spanish/Catalan
 * stopword list, with a light English suffix strip (publishing → publish). Each distinct prompt word
 * scores the best field of the recipe it appears in: slug and tags 3, title 2, summary 1. A recipe
 * is named with at least MIN_MATCHED distinct words and a score of at least MIN_SCORE: a slug or tag
 * word plus one more hit passes, as do two title words; summary words alone need four.
 *
 * SILENT on a chat worker (TC_SESSION_KEY set: the gateway already matched), when
 * harness-identity.json says "recipeHints": false, on a slash command, and on a prompt of fewer than
 * three words. No dependencies: one file read and a word scan, well inside the hook's 5 s budget.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { claim, harnessSide, readJsonFile, readStdin, stateDir } from "./hook-common.mjs";

/** At most this many recipes per prompt. */
const MAX_HINTS = 3;
/** Distinct prompt words a recipe must contain to be named. */
const MIN_MATCHED = 2;
/** The least summed weight a named recipe carries. */
const MIN_SCORE = 4;
/** What a prompt word is worth, by the best recipe field it appears in. */
const WEIGHT = { slug: 3, tags: 3, title: 2, summary: 1 };

/** Function words that say nothing about a task, accent-folded like the words checked against them. */
const STOPWORDS = new Set(
  [
    // English
    "the and for you your are was were with that this these those from into have has had not but can could would should will what when where which who why how all any our out its then than there here them they their about please just also some more most very lets need want does did done get got use using now",
    // Spanish
    "que los las del una uno unos unas por para con sin como pero mas este esta esto estos estas ese esa eso hay muy tambien sus son fue ser porque cuando donde quiero puedes hacer",
    // Catalan
    "els les amb per uns unes dels com aquest aquesta aixo molt tambe fer vull pots quan perque",
  ]
    .join(" ")
    .split(" "),
);

/** The words of `text`: letters and digits, lowercased, accents folded. */
function words(text) {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** A light English suffix strip, applied alike to prompt and recipe: pushes, pushed, pushing → push. */
function stem(word) {
  let s = word;
  if (s.length > 4 && /(?:s|x|z|ch|sh)es$/.test(s)) {
    s = s.slice(0, -2);
  } else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) {
    s = s.slice(0, -1);
  }
  if (s.length > 5 && s.endsWith("ing")) {
    s = s.slice(0, -3);
  } else if (s.length > 4 && s.endsWith("ed")) {
    s = s.slice(0, -2);
  }
  if (s.length > 4 && s.endsWith("e")) {
    s = s.slice(0, -1);
  }
  return s.length >= 3 ? s : word;
}

/** The distinct key words of `text`: 3+ chars, not a stopword, not a bare number, stemmed. */
function keyWords(text) {
  const out = new Set();
  if (typeof text !== "string") {
    return out;
  }
  for (const w of words(text)) {
    if (w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) {
      out.add(stem(w));
    }
  }
  return out;
}

/** Each key word of a recipe, with the weight of the best field it appears in. */
function recipeWords(recipe) {
  const best = new Map();
  const add = (text, weight) => {
    for (const w of keyWords(text)) {
      if ((best.get(w) ?? 0) < weight) {
        best.set(w, weight);
      }
    }
  };
  const tags = Array.isArray(recipe.tags) ? recipe.tags.filter((t) => typeof t === "string") : [];
  add(recipe.slug, WEIGHT.slug);
  add(tags.join(" "), WEIGHT.tags);
  add(recipe.title, WEIGHT.title);
  add(recipe.summary, WEIGHT.summary);
  return best;
}

/** One line of plain text, at most `max` chars ("" when not a string). */
function oneLine(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Higher score first, then more matched words, then slug order: one catalog always ranks one way. */
function byRank(a, b) {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.matched !== b.matched) {
    return b.matched - a.matched;
  }
  if (a.slug === b.slug) {
    return 0;
  }
  return a.slug < b.slug ? -1 : 1;
}

if (harnessSide() === "worker") {
  process.exit(0);
}
const input = readStdin();
const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
if (!prompt || prompt.startsWith("/") || words(prompt).length < 3) {
  process.exit(0);
}
const state = stateDir();
if (readJsonFile(path.join(state, "harness-identity.json"))?.recipeHints === false) {
  process.exit(0);
}
const index = readJsonFile(path.join(state, "prefrontal", "recipe-index.json"));
const recipes = Array.isArray(index?.recipes) ? index.recipes : [];
const wanted = keyWords(prompt);
if (wanted.size < MIN_MATCHED) {
  process.exit(0);
}

const ranked = [];
for (const recipe of recipes) {
  if (!recipe || typeof recipe !== "object" || typeof recipe.slug !== "string") {
    continue;
  }
  if (!recipe.slug.trim()) {
    continue;
  }
  const best = recipeWords(recipe);
  let score = 0;
  let matched = 0;
  for (const w of wanted) {
    const weight = best.get(w) ?? 0;
    if (weight > 0) {
      score += weight;
      matched += 1;
    }
  }
  if (matched >= MIN_MATCHED && score >= MIN_SCORE) {
    ranked.push({ recipe, slug: recipe.slug, score, matched });
  }
}
if (ranked.length === 0) {
  process.exit(0);
}
ranked.sort(byRank);

// The plugin can be loaded twice in one session: the first copy to get here speaks for both.
const promptKey = createHash("sha1").update(prompt).digest("hex").slice(0, 16);
if (!claim("recipe-hint", input.session_id, promptKey, 1)) {
  process.exit(0);
}

const lines = ranked.slice(0, MAX_HINTS).map(({ recipe }) => {
  const slug = oneLine(recipe.slug, 80).replace(/`/g, "");
  const title = oneLine(recipe.title, 160) || slug;
  const where = oneLine(recipe.path, 300);
  return `- \`${slug}\`: ${title}${where ? ` (${where})` : ""}`;
});
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        '<recipe_hint source="tinkerclaw-core">Saved recipes that may fit (keyword match, not a decision):',
        ...lines,
        "If one fits, follow it with the jarvis-recipe skill; if none fits, ignore this.</recipe_hint>",
      ].join("\n"),
    },
  }),
);
