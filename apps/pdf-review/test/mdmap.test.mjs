// The writer's source map (viewer/web/mdmap.js): a change typed on the page lands on exactly those characters
// of the Markdown. node test/mdmap.test.mjs   (exit 0 = PASS). Pure functions, no browser, no server.
// With SWEEP=<dir> it also edits every block of every .md under that folder at random and checks each result.
import { parse, applyEdit, runs, blocksOf, findBlock, portion, norm } from "../viewer/web/mdmap.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let fails = 0, n = 0;
const eq = (name, got, want) => {
  n++;
  if (got !== want) { fails++; console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const edit = (md, want) => { try { return applyEdit(md, parse(md), want); } catch (e) { return `ERR ${e.message} ${JSON.stringify(e.out ?? "")}`; } };
const throws = (name, f) => { n++; const r = f(); if (!String(r).startsWith("ERR")) { fails++; console.log(`FAIL ${name}: no error`); } };

// what shows
const P = parse("Hello **bold** and *it* [the link](http://x.com/a_b) `co de` &amp; done");
eq("visible text", P.text, "Hello bold and it the link co de & done");
eq("bold span", "Hello **bold** and".slice(P.spans[6][0], P.spans[9][1]), "bold");
eq("list item", parse("- an *item*\n  goes on").text, "an item goes on");
eq("heading", parse("## A **title**").text, "A title");
eq("quote", parse("> one\n> two").text, "one two");
eq("escape", parse("not \\*bold\\*").text, "not *bold*");
eq("intraword _", parse("snake_case_word stays").text, "snake_case_word stays");
eq("lone stars", parse("x ** y").text, "x ** y");
eq("strong em", parse("***both*** and **a *b* c**").text, "both and a b c");
eq("raw tag", parse('<span class="nw">new</span> text <id> here').text, "new text here");
eq("hard break", parse("a  \nb").text, "a b");
eq("autolink", parse("see <https://x.com/a>").text, "see https://x.com/a");
eq("image gone", parse('![pic](a.jpg) words <img class="side" src="b.jpg"> more').text, "words more");
eq("table refused", parse("| a | b |\n|---|---|\n| 1 | 2 |").ok, false);
eq("fence refused", parse("```\ncode\n```").ok, false);

// changes
eq("replace a word", edit("The cat sat.", "The dog sat."), "The dog sat.");
eq("word in bold keeps bold", edit("The **cat** sat.", "The **dog** sat.".replace(/\*/g, "")), "The **dog** sat.");
eq("continue a bold word", edit("The **cat** sat.", "The cats sat."), "The **cats** sat.");
eq("new word after bold is plain", edit("The **cat** sat.", "The cat really sat."), "The **cat** really sat.");
eq("new word before bold is plain", edit("The **cat** sat.", "The black cat sat."), "The black **cat** sat.");
eq("delete a bold word", edit("The **big** cat.", "The cat."), "The cat.");
eq("delete inside bold", edit("A **very big** cat.", "A **big** cat.".replace(/\*/g, "")), "A **big** cat.");
eq("link text keeps the address", edit("See [the page](http://x.com/a_b) now.", "See this page now."), "See [this page](http://x.com/a_b) now.");
eq("typed markup is escaped", edit("Plain text.", "Plain *text* [1] <b> & co."), "Plain \\*text\\* \\[1\\] &lt;b> & co.");
eq("typed entity-like & escaped", edit("A.", "A &amp; B."), "A &amp;amp; B.");
eq("soft line break kept", edit("one two\nthree four", "one two\nthree five".replace("\n", " ")), "one two\nthree five");
eq("join across a line break", edit("> one two\n> three", "one twothree"), "> one twothree");
eq("enter splits a paragraph", edit("First part. Second part.", "First part.\nSecond part."), "First part.\n\nSecond part.");
eq("enter in a list item", edit("- first, second", "- first,\nsecond".slice(2)), "- first,\n- second");
eq("enter in a numbered item", edit("3. first second", "first\nsecond"), "3. first\n3. second");
eq("enter in a quote", edit("> one two", "one\ntwo"), "> one\n>\n> two");
throws("enter inside bold", () => edit("A **bold phrase** here", "A bold\nphrase here"));
eq("empty = the block goes", edit("Gone soon.", ""), "");
eq("heading edit", edit("## Old title", "New title"), "## New title");
eq("start of a list item", edit("- item here", "An item here"), "- An item here");
eq("line start escapes", edit("Text.", "Text.\n- not a list"), "Text.\n\n\\- not a list");
eq("number at line start", edit("Text.", "Text.\n2026. A year"), "Text.\n\n2026\\. A year");
eq("nested item", edit("- parent\n  - child one", "parent child two"), "- parent\n  - child two");
eq("code span", edit("Run `ls -la` now", "Run ls -l now"), "Run `ls -l` now");
eq("span class kept", edit('Old <span class="nw">new words</span> end', "Old newer words end"), 'Old <span class="nw">newer words</span> end');
eq("italic sentence edit", edit("He said *hello there* to her.", "He said hello again to her."), "He said *hello again* to her.");
eq("two separate edits keep the middle", edit("One *two* three four five", "Uno two three four cinco"), "Uno *two* three four cinco");
eq("unchanged", edit("Same **text**.", "Same text."), "Same **text**.");
eq("accents", edit("Això és una prova", "Això és la prova"), "Això és la prova");

// what the editor shows
eq("runs", JSON.stringify(runs(parse("a **b** [c](u)"))), JSON.stringify([{ text: "a ", css: {} }, { text: "b", css: { fontWeight: "700" } }, { text: " ", css: {} }, { text: "c", css: { color: "#7A3921", textDecoration: "underline" } }]));
eq("runs: part of a block", runs(parse("one *two* three"), 4, 9).map((r) => r.text).join("|"), "two| t");
eq("runs keep entities as text", runs(parse("1 &lt; 2"))[0].text, "1 < 2");

// finding the tapped paragraph
const blocks = blocksOf("# Title\n\nThe first paragraph is here.\n\nThe second one, with **bold** words in it.\n- a list item");
eq("find by words", findBlock(blocks, "The second one, with bold words in it."), 2);
eq("find a list item by its bullet line", findBlock(blocks, "• a list item"), 3);
const B2 = blocksOf("Bram.\n\nHe went out.\n\nBram.\n\nShe came in.\n\nNot in it **at all** &amp; more.");
eq("a short paragraph in two places: refused", findBlock(B2, "Bram."), -1);
eq("...told apart by the paragraph below it", findBlock(B2, "Bram.", [["She came in.", 1]]), 2);
eq("...or by the one above it", findBlock(B2, "Bram.", [["He went out.", -1]]), 2);
eq("no guessing: words not in any block", findBlock(B2, "Hollis (the sheriff, his friend) sat with him"), -1);
eq("an entity reads as what it shows", findBlock(B2, "Not in it at all & more."), 4);
const T = "Alpha beta gamma delta. Epsilon zeta eta theta iota kappa.";
eq("portion: the lines on this page", JSON.stringify(portion(T, "Epsilon zeta eta theta iota kappa.")), JSON.stringify([24, T.length]));
eq("portion: first page part", JSON.stringify(portion(T, "Alpha beta gamma")), JSON.stringify([0, 16]));
eq("portion: not this block", portion(T, "Words that are somewhere else entirely"), null);
const R = Array(5).fill("Same words again and again.").join(" ") + " The end.";
eq("portion: a repeating paragraph, its part on the next page", JSON.stringify(portion(R, "again and again. The end.", "top")), JSON.stringify([R.length - 25, R.length]));
eq("portion: a repeating paragraph, its first page", JSON.stringify(portion(R, "Same words again and again. Same words", "bottom")), JSON.stringify([0, 38]));
eq("portion: words found twice in the middle", portion(R, "words again and again. Same"), null);

// a sweep over real documents: every change either lands exactly (applyEdit checks itself) or is refused
if (process.env.SWEEP) {
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else if (f.endsWith(".md")) files.push(p); } };
  walk(process.env.SWEEP);
  let seed = 7;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  let ok = 0, unsupported = 0, refused = 0, wrong = 0;
  for (const f of files) {
    for (const b of blocksOf(readFileSync(f, "utf8"))) {
      const p = parse(b);
      if (!p.ok) { unsupported++; continue; }
      if (!p.text) continue;
      const w = p.text.split(" ");
      for (let t = 0; t < 3; t++) {
        const v = [...w];
        const k = rnd(v.length);
        const op = rnd(3);
        if (op === 0) v[k] = "changed";
        else if (op === 1) v.splice(k, 0, "inserted");
        else if (v.length > 1) v.splice(k, 1);
        const want = v.join(" ");
        try {
          const out = applyEdit(b, p, want);
          const shown = blocksOf(out).map((x) => parse(x).text).join(" ");
          if (norm(shown) === norm(want)) ok++; else { wrong++; console.log("WRONG", f, JSON.stringify(b).slice(0, 120)); }
        } catch { refused++; }
      }
    }
  }
  console.log({ files: files.length, ok, refused, unsupported, wrong });
  n++;
  if (wrong) fails++;
}

console.log(`${n - fails}/${n} ${fails ? "FAIL" : "PASS"}`);
process.exit(fails ? 1 : 0);
