#!/usr/bin/env python3
"""voicecheck.py — flag what makes a draft read machine-written, in English, Spanish or Catalan.

Built 2026-09-24. A vocabulary-only detector scored an announcement 0/100 "human" while the
owner said it read "very AI-ish": the tells were GENRE (hook → bold stat → link → call to
action → witty sign-off), not words. So this checks structure and register as well as
vocabulary, and it knows what the text is FOR (--mode), because a bullet list is fine in a
report and wrong in a WhatsApp message.

  python3 voicecheck.py draft.txt [--mode chat|email|code|post|doc] [--lang auto|en|es|ca] [--voice owner|PROFILE.json] [--thread their_messages.txt] [--json]
  echo "text" | python3 voicecheck.py - --mode chat

--voice is only for text written IN SOMEONE'S NAME. It loads a voice profile (JSON, see
../profiles/example.json) with that writer's measured habits and their own corrections.
`--voice owner` reads the path from the HUMAN_VOICE_PROFILE environment variable;
`--voice some/path.json` reads that file. Without --voice no personal rules apply.

Exit code: 0 = clean enough to send, 1 = fix the HIGH findings first.
Lexicons live in lexicon.json next to this file; add entries there, not here.
"""
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LEX = json.load(open(os.path.join(HERE, "lexicon.json"), encoding="utf-8"))

WEIGHT = {"HIGH": 12, "MED": 5, "LOW": 2}
VOICE = {}  # a loaded voice profile (load_profile) = also check the writer's measured habits
THREAD = []  # the other person's recent messages (--thread file), one per line


def load_profile(spec):
    """Load a voice profile. 'owner' = the file named by $HUMAN_VOICE_PROFILE; anything else is a path."""
    if not spec:
        return {}
    path = os.environ.get("HUMAN_VOICE_PROFILE", "") if spec == "owner" else spec
    if not path:
        sys.exit("voicecheck: --voice owner needs HUMAN_VOICE_PROFILE set to a profile JSON "
                 "(template: profiles/example.json)")
    path = os.path.expanduser(path)
    try:
        prof = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError) as e:
        sys.exit(f"voicecheck: cannot read voice profile {path}: {e}")
    prof.setdefault("name", os.path.splitext(os.path.basename(path))[0])
    prof.setdefault("habits", {})
    prof.setdefault("rules", {})
    return prof


def detect_lang(text):
    """Words each language owns alone, plus letters only one of es/ca uses."""
    toks = re.findall(r"[a-zà-ÿ·'’]+", text.lower())
    score = {lang: sum(1 for t in toks if t in set(ws)) for lang, ws in LEX["lang_markers"].items()}
    t = text.lower()
    score["ca"] += 3 * len(re.findall(r"l·l|\b[ld]['’][a-zàèéíòóú]|ç|à|è|ò|\bquè\b|\bperquè\b", t))
    score["es"] += 3 * len(re.findall(r"ñ|¿|¡|ción\b|\bqué\b", t))
    lang = max(score, key=score.get)
    return lang if score[lang] > 0 else "en"


def sentences(text):
    body = re.sub(r"https?://\S+", "LINK", text)
    # a closing bold/quote after the full stop ("…plan.* Same model") still ends the sentence
    parts = re.split(r"(?<=[.!?][*_\"'”’)])\s+|(?<=[.!?])\s+|\n+", body)
    return [p.strip() for p in parts if len(p.strip().split()) >= 1]


def words(s):
    return re.findall(r"[\wÀ-ÿ·'’-]+", s)


def find_lines(text, pattern, flags=re.I):
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        if re.search(pattern, line, flags):
            out.append(i)
    return out


def check(text, mode, lang):
    f = []

    def add(sev, rule, msg, fix, lines=None):
        f.append({"sev": sev, "rule": rule, "msg": msg, "fix": fix, "lines": lines or []})

    # Quoted text is mention, not use: a phrase inside "…", “…”, «…» or `…` is someone else's words
    # (or an example), so the phrase and word rules read a copy with those spans blanked out.
    said = re.sub(r"`[^`\n]*`|\"[^\"\n]{1,200}\"|“[^”\n]{1,200}”|«[^»\n]{1,200}»",
                  lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)
    low = said.lower()
    nwords = max(1, len(words(text)))
    sents = sentences(text)
    L = LEX["lang"][lang]

    # ── stock phrases and vocabulary (per language) ──────────────────────────
    for entry in L["phrases"]:
        pat, sev, fix = entry["re"], entry["sev"], entry["fix"]
        if "modes" in entry and mode not in entry["modes"]:
            continue
        ls = find_lines(said, pat)
        if ls:
            add(sev, "stock-phrase", f"stock phrase /{pat}/", fix, ls)
    hits = []
    for w, fix in L["words"].items():
        n = len(re.findall(r"\b" + re.escape(w) + r"\b", low))
        if n:
            hits.append((w, n, fix))
    density = sum(n for _, n, _ in hits) * 100 / nwords
    if hits:
        # one flagged word is a hint, never a verdict: humans say "fundamental" too.
        # It takes several DIFFERENT ones, or a real density of them, to read as machine.
        if len(hits) >= 4 or (len(hits) >= 3 and density >= 1.5):
            sev = "HIGH"
        elif len(hits) >= 2:
            sev = "MED"
        else:
            sev = "LOW"
        add(sev, "ai-vocabulary",
            f"{len(hits)} AI-typical words ({density:.1f} per 100 words): "
            + ", ".join(f"{w}×{n}" for w, n, _ in hits[:10]),
            "; ".join(f"{w} → {fix}" for w, _, fix in hits[:6]))

    # ── negative parallelism: "not X, it's Y" / "no solo… sino" / "no només… sinó" ──
    ls = find_lines(text, L["neg_parallel"])
    if ls:
        add("MED", "not-x-but-y", "contrast frame ('not X, it's Y')",
            "state Y directly; keep the contrast only if someone actually believes X", ls)

    # ── formatting that people do not use in the channel ─────────────────────
    # a dash between numbers is a range (09:00 – 17:00), not a clause break
    em = len(re.findall(r"\s[—–]\s|\w—\w", re.sub(r"\d\s*[—–]\s*\d", "0-0", text)))
    if em:
        # Spanish and Catalan use the raya for incises: correct in an email or document,
        # odd only in chat. In English it is a density tell, never a single-sighting one.
        if mode == "chat":
            sev = "HIGH"
        elif lang in ("es", "ca"):
            sev = "LOW"
        else:
            sev = "MED" if mode in ("email", "post") or em * 100 / nwords > 0.8 else "LOW"
        add(sev, "em-dash", f"{em} em/en dash(es) used as clause breaks",
            "use a full stop, a comma or brackets; people rarely type dashes on a phone",
            find_lines(text, r"\s[—–]\s|\w—\w", 0))
    bold = len(re.findall(r"\*\*[^*]+\*\*", text)) + (
        len(re.findall(r"(?<![\w*])\*[^*\n]{3,200}\*(?![\w*])", text)) if mode in ("chat", "post") else 0)
    if bold >= (1 if mode in ("chat", "email") else 3):
        add("HIGH" if mode in ("chat", "email") else "MED", "bold",
            f"{bold} bolded span(s)", "drop the bold; if a number matters, put it early in a plain sentence")
    heads = find_lines(text, r"^\s*#{1,6}\s", 0)
    if heads and (mode in ("chat", "email") or nwords < 250):
        add("HIGH", "headers", f"{len(heads)} markdown header(s) in a short {mode}",
            "no headers under ~250 words; write paragraphs", heads)
    bullets = find_lines(text, r"^\s*([-*•]|\d+[.)])\s+", 0)
    if bullets and mode == "chat":
        add("MED", "bullets-in-chat", f"{len(bullets)} bullet line(s) in a chat message",
            "chat is sentences; split into two messages if needed", bullets)
    inline = find_lines(text, r"^\s*([-*•]\s+)?\*\*[^*]{2,40}:\*\*|^\s*[-*•]\s+\*\*[^*]{2,40}\*\*:", 0)
    if len(inline) >= 2:
        add("HIGH" if mode in ("chat", "email", "code") else "MED", "bold-label-list",
            f"{len(inline)} '**Label:** text' lines — the most recognisable generated-document shape",
            "plain sentences; if it really is a list, bare fragments without bold labels", inline)
    emo = re.findall(r"[\U0001F300-\U0001FAFF☀-➿]", text)
    if len(emo) > (2 if mode in ("chat", "post") else 0):
        add("MED", "emoji", f"{len(emo)} emoji ({''.join(emo[:8])})",
            "one at most in chat, none in email or code notes")
    deco = [e for e in emo if e in "🚀✨💡✅🔥🎯📈🙌💪⚡"]
    if deco:
        add("MED", "decor-emoji", f"decorative emoji {''.join(deco)}", "drop it; people use 😅 👍 🙏, not 🚀 ✨")
    if mode in ("chat", "email") and re.search(r"[“”‘’]", text):
        add("LOW", "curly-quotes", "typographic quotes", "straight quotes, as typed")
    th = find_lines(text, L["title_case"], 0)
    if th:
        add("HIGH" if lang in ("es", "ca") else "MED", "title-case",
            "Title Case heading", "sentence case (only the first word capitalised)", th)

    # ── rhythm: metronome sentences and copywriter fragments ─────────────────
    lens = [len(words(s)) for s in sents if len(words(s)) > 0]
    if len(lens) >= 6:
        cv = statistics.pstdev(lens) / max(1, statistics.mean(lens))
        if cv < 0.35:
            add("MED", "uniform-rhythm", f"sentence lengths too even (CV {cv:.2f})",
                "mix a short sentence with a long one; people are uneven")
    frags = [s for s in sents if 1 < len(words(s)) <= 5 and s.endswith(".") and not re.search(r"https?://|LINK", s)]
    if len(frags) >= 2 and mode in ("chat", "email", "post"):
        add("MED", "punchy-fragments", f"{len(frags)} punchy fragments: " + " | ".join(frags[:4]),
            "merge them into the sentence they punctuate; nobody talks in slogans")
    triples = find_lines(text, L["triple"])
    if len(triples) >= 2:
        add("LOW", "rule-of-three", "several 'A, B and C' triples", "keep the one that matters", triples)

    # ── genre: the announcement template ─────────────────────────────────────
    has_link = bool(re.search(r"https?://", text))
    cta = find_lines(text, L["cta"])
    hook = bool(sents) and len(words(sents[0])) <= 4 and not re.search(L["greeting"], sents[0], re.I)
    if has_link and cta and (hook or bold) and mode in ("chat", "post"):
        add("HIGH", "announcement-template",
            "hook → emphasised claim → link → call to action: reads as marketing copy",
            "say it the way you would to a friend: what you did, why it surprised you, the link, a plain ask", cta)

    # ── openers and closers ──────────────────────────────────────────────────
    if sents and re.search(L["opener"], sents[0], re.I):
        add("HIGH", "stock-opener", f"stock opener: {sents[0][:60]}", "start with the point")
    if sents and re.search(L["closer"], sents[-1], re.I):
        add("MED", "stock-closer", f"stock closer: {sents[-1][:60]}",
            "end with the actual ask, or just stop")

    # ── code-change explanations to the owner ────────────────────────────────
    if mode == "code":
        ls = find_lines(text, L["status"])
        if ls:
            add("HIGH", "status-report-voice", "status-report words (successfully, seamlessly, robust…)",
                "say what changed and what the reader will notice, in plain words", ls)
        if nwords > 180:
            add("MED", "too-long", f"{nwords} words for a change explanation",
                "3–6 sentences: what was wrong, what I changed, what you will notice, what is still open")
        if len(re.findall(r"`[^`]+`", text)) > 4:
            add("LOW", "jargon-wall", "many code spans", "name one file if it helps the reader open it; describe the rest")

    # ── hedging ──────────────────────────────────────────────────────────────
    hedge = len(re.findall(L["hedge"], low))
    if hedge >= 3:
        add("MED", "hedge-stack", f"{hedge} hedges", "one qualifier per claim, where the doubt really is")

    # ── Catalan: one speaker has one dialect ─────────────────────────────────
    if lang == "ca":
        for a, b in LEX.get("dialect_sets", {}).get("ca", []):
            if re.search(r"\b" + a + r"\b", low) and re.search(r"\b" + b + r"\b", low):
                add("HIGH", "dialect-mix", f"'{a}' and '{b}' in the same text",
                    "pick one variety (central: aquest/avui/meva) and hold it")

    # ── writing IN SOMEONE'S NAME: their measured habits (voice profile › habits) ──
    # Each habit is optional; a profile that omits one simply does not check it. The findings are
    # hints (the thread can overrule them) unless the profile raises their severity.
    hb = VOICE.get("habits", {}) if VOICE else {}
    who = VOICE.get("name", "the writer") if VOICE else ""

    def habit(key, default_sev, rule, msg, default_why):
        h = hb[key]
        add(h.get("sev", default_sev), rule, msg, h.get("why", default_why).replace("{name}", who))

    if hb and mode in ("chat", "post"):
        body = [l for l in text.strip().splitlines() if l.strip() and not re.match(r"https?://", l.strip())]
        if "no_final_stop" in hb and body and re.search(r"[^.]\.\s*$", body[-1]) and \
                nwords < hb["no_final_stop"].get("under_words", 60):
            habit("no_final_stop", "LOW", "voice-final-stop", "ends with a full stop",
                  "{name} ends a chat message on the last word")
        if "no_semicolon" in hb and ";" in text:
            habit("no_semicolon", "MED", "voice-semicolon", "semicolon",
                  "{name} almost never uses one; split the sentence")
        if "chat_max_words" in hb and mode == "chat" and nwords > hb["chat_max_words"].get("value", 70):
            habit("chat_max_words", "MED", "voice-length", f"{nwords} words",
                  "{name} writes short chat messages; say it in two short lines")
        if "no_formal_signoff" in hb and re.search(
                r"\b(best regards|kind regards|saludos cordiales|atentamente|cordialment|salutacions)\b", low):
            habit("no_formal_signoff", "MED", "voice-signoff", "formal sign-off",
                  "{name} does not sign off in chat; just stop")
        if "no_contractions_en" in hb and lang == "en" and \
                len(re.findall(r"\b\w+'(m|re|ve|ll|d)\b", text)) >= hb["no_contractions_en"].get("max", 2) + 1:
            habit("no_contractions_en", "LOW", "voice-contractions", "several contractions",
                  "{name} writes 'I am', 'we are' in English")

    # ── writing IN SOMEONE'S NAME, any mode: their own corrections (voice profile › rules) ──
    if VOICE:
        for r in VOICE.get("rules", {}).get(lang, []):
            hits = re.findall(r["re"], low)
            if hits:
                add(r.get("sev", "MED"), "voice-wording", f"{len(hits)}× /{r['re']}/", r["fix"].replace("{name}", who))

    # ── 2026-09-25: what readers catch (references/tells-heard.md, claudeisms.md) ──
    if lang == "en":
        cw = LEX.get("claudeisms_en", {}).get("words", [])
        ch = [(w, len(re.findall(r"\b" + re.escape(w) + r"\b", low))) for w in cw]
        ch = [(w, n) for w, n in ch if n]
        tot = sum(n for _, n in ch)
        if ch and mode != "doc":
            sev = "HIGH" if len(ch) >= 4 or tot >= 6 else "MED" if len(ch) >= 2 else "LOW"
            add(sev, "claudeism", "Claude dialect: " + ", ".join(f"{w}×{n}" for w, n in ch[:8]),
                "say what happened in plain words: is live (landed), connected (wired), showed up "
                "(surfaced), checked (verified), out of date (stale); see references/claudeisms.md")
    rs = len(re.findall(r"\b(realis|realiz|explain|reveal|inform|admit|mention|recall|note)(e?s|ed) that\b|"
                        r"\b(tells|told|asks|asked) (him|her|them) that\b|\binwardly\b", low))
    if rs >= 3 and rs * 1000 / nwords >= 4:
        add("MED", "reported-speech", f"{rs} 'X explains/realizes that…' constructions",
            "if someone said it, quote them; the summariser's voice is the video-recap tell")
    ly = re.findall(r"\b[a-z]{4,}ly\b", low)
    common = {"only", "really", "early", "likely", "family", "daily", "apply", "reply", "supply", "fully",
              "nearly", "actually", "usually", "probably", "finally", "exactly", "simply", "clearly",
              "recently", "currently", "certainly", "especially"}
    reps = sorted({w for w in ly if w not in common and ly.count(w) >= (2 if nwords < 150 else 3)})
    if reps:
        add("MED", "repeated-adverb", "repeated: " + ", ".join(reps[:4]),
            "a repeated adverb is proof nobody re-read it; change or cut the second one")

    # ── against the thread: deviation from what THIS conversation expects ─────
    if THREAD:
        tl = [t for t in THREAD if t.strip()]
        med = statistics.median([len(words(t)) for t in tl]) or 1
        ratio = nwords / med
        if mode in ("chat", "email", "post") and ratio > 4:
            add("HIGH" if ratio > 8 else "MED", "length-vs-thread",
                f"{nwords} words against their median of {med:.0f} ({ratio:.0f}×)",
                "say what you found in their length; offer the detail instead of dumping it")
        thread_struct = any(re.search(r"^\s*([-*•]|\d+[.)])\s|\*\*|^\s*#", t) for t in tl)
        if not thread_struct and (bullets or heads or bold):
            add("HIGH", "structure-vs-thread", "headers/bullets/bold in a thread that never uses them",
                "carry no more structure than the messages you are answering")
        thread_emo = sum(len(re.findall(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]", t)) for t in tl)
        if thread_emo == 0 and emo:
            add("MED", "emoji-vs-thread", "emoji in a thread where they use none", "mirror their emoji rate")
        if re.search(r"^\s*(dear|estimad[oa]|benvolgu(t|da)|distingid[oa]|distingit)\b", text, re.I | re.M) and \
                not any(re.search(r"\b(dear|estimad|benvolgu|distingi)", t, re.I) for t in tl):
            add("MED", "greeting-vs-thread", "formal greeting in an informal thread", "greet them the way they greet you")
        last = next((t for t in reversed(tl) if len(words(t)) >= 4), None)
        if last:
            tlang = detect_lang(last)
            if tlang != lang:
                add("HIGH", "language-vs-thread", f"draft is {lang}, their last message is {tlang}",
                    "reply in the language of their last message")
        nostop = sum(1 for t in tl if not t.rstrip().endswith("."))
        if nostop >= 0.7 * len(tl) and nwords < 40 and text.rstrip().endswith("."):
            add("LOW", "final-stop-vs-thread", "ends with a full stop; they don't", "drop it in chat")

    score = min(100, sum(WEIGHT[x["sev"]] for x in f))
    return score, f


def main():
    args = sys.argv[1:]
    # Without this, --help fell through to src="-" and blocked on stdin (2026-09-28, 2-min hang).
    if "-h" in args or "--help" in args:
        print(__doc__)
        sys.exit(0)
    mode = "chat"
    lang = "auto"
    as_json = "--json" in args
    if "--mode" in args:
        mode = args[args.index("--mode") + 1]
    if "--lang" in args:
        lang = args[args.index("--lang") + 1]
    global VOICE
    if "--voice" in args:
        VOICE = load_profile(args[args.index("--voice") + 1])
    global THREAD
    if "--thread" in args:
        THREAD = open(args[args.index("--thread") + 1], encoding="utf-8").read().splitlines()
    flagvals = {args[i + 1] for i, a in enumerate(args[:-1]) if a in ("--mode", "--lang", "--voice", "--thread")}
    src = next((a for a in args if not a.startswith("--") and a not in flagvals), "-")
    text = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    if lang == "auto":
        lang = detect_lang(text)
    score, findings = check(text, mode, lang)
    if as_json:
        print(json.dumps({"lang": lang, "mode": mode, "score": score, "findings": findings},
                         ensure_ascii=False, indent=1))
    else:
        verdict = "send" if score < 25 and not any(x["sev"] == "HIGH" for x in findings) else "rework"
        print(f"voicecheck  lang={lang} mode={mode}  score={score}/100  → {verdict}")
        for x in sorted(findings, key=lambda x: -WEIGHT[x["sev"]]):
            where = f" (line {', '.join(map(str, x['lines'][:6]))})" if x["lines"] else ""
            print(f"  [{x['sev']}] {x['rule']}{where}: {x['msg']}\n         fix: {x['fix']}")
    sys.exit(1 if any(x["sev"] == "HIGH" for x in findings) else 0)


if __name__ == "__main__":
    main()
