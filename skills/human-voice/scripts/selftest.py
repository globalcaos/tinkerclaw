#!/usr/bin/env python3
"""selftest.py — positive and negative controls for voicecheck.py. Run after any lexicon edit.

A checker that flags everything is as useless as one that flags nothing, so every language
has a machine-shaped text that must FAIL and a person-shaped text that must PASS.
The human samples are written to the research reports' "natural rewrite" shapes; in a private
copy, replace the voice-profile case with a real message of the profile's owner.
The voice cases load profiles/example.json. Exit 0 = all controls behave.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voicecheck as vc  # noqa: E402

PROFILES = {"example": os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "profiles", "example.json")}

CASES = [
    # (name, text, mode, voice, expect_lang, must_fail, must_have_rule[, their_thread_lines])
    ("en-announcement-template", """Three new phones in one week — *the Model X* straight to #1, two others right behind.

One number stopped me. *€200 on the monthly plan buys about 40x more data than €200 of prepaid top-ups.* Same phone, same money.

https://example.com/phone-plans/

Drag any phone onto the €200 plan and watch where it lands. Tell me what's wrong with it 🙂""",
     "chat", "", "en", True, "announcement-template"),
    ("en-status-report", """## Summary
I have successfully implemented the requested changes, ensuring a robust and seamless experience.

- **Root cause:** A race condition in the worker.
- **Fix:** Added a mutex, significantly improving reliability.
- **Testing:** Comprehensive test suite passes.

This should fix the issue. Let me know if you have any questions!""",
     "code", "", "en", True, "status-report-voice"),
    ("en-sycophant-email", """I hope this email finds you well! Great question. It's worth noting that the report serves as a testament to the team's work, highlighting the pivotal role of data. Let me know if you have any other questions.""",
     "email", "", "en", True, "stock-opener"),
    ("en-voice-profile-human", """I do not think the cheaper plan is worth it for us. We would hit the limit every Monday and then wait until Thursday
The second tab has the cost per week, which is really where the difference is""",
     "chat", "example", "en", False, None),
    ("en-voice-profile-rule", """Could you kindly send me the signed copy before Friday? The vendor needs it for the delivery slot""",
     "chat", "example", "en", True, "voice-wording"),
    ("en-code-change-good", """The circles on the website did not snap because the page runs its own copy of the drag code, and I had only changed the app. I ported the snapping and the row lighting into that copy and republished the page. Reload it and drag a Claude circle: it stops on each plan and names it. The cache purge is still unreliable, so give it a minute if it looks old.""",
     "code", "", "en", False, None),
    ("es-machine-email", """¡Claro! Espero que este correo te encuentre bien. Es importante destacar que, en el vertiginoso mundo de la tecnología, la propuesta juega un papel fundamental. No solo mejora los costes, sino también la calidad. En resumen, quedo a tu entera disposición.""",
     "email", "", "es", True, "stock-phrase"),
    ("es-title-case", """# Cómo Mejorar La Productividad De Tu Equipo
Te paso tres ideas.""", "doc", "", "es", True, "title-case"),
    ("es-human-email", """Hola, Marta: te paso el presupuesto revisado. He quitado la partida de montaje porque al final lo hacemos nosotros. ¿Te va bien que lo miremos el martes? Un abrazo""",
     "email", "", "es", False, None),
    ("es-raya-in-email-ok", """Hola, Lucía: la propuesta —que ya habíamos hablado— llega tarde, pero la podemos cerrar el jueves. Gracias""",
     "email", "", "es", False, None),
    ("ca-machine-email", """Benvolgut Marc, cal destacar que el projecte juga un paper fonamental. A més a més, és important tenir en compte que la solució és robusta. En definitiva, espero que aquesta informació et sigui útil.""",
     "email", "", "ca", True, "stock-phrase"),
    ("ca-dialect-mix", """Hola! Avui no puc, però este divendres sí. Hui tinc molta feina amb aquest projecte.""",
     "chat", "", "ca", True, "dialect-mix"),
    ("ca-human-email", """Hola, Marc, perdona la tardança. T'adjunto el pressupost revisat: he tret la partida de muntatge perquè al final ho farem nosaltres. Si veus res estrany, digue-m'ho i ho mirem dijous. Gràcies!""",
     "email", "", "ca", False, None),
    # ── 2026-09-25 wave: what people catch ──
    ("en-claudeisms-code", """The fix landed and is wired end to end. I verified the canonical path and the stale cache no longer drifts silently; the seam between the two was the crux, and it's genuinely cleaner now.""",
     "code", "", "en", True, "claudeism"),
    ("en-leftover-offer", """Here is the summary of the meeting with the supplier. They will send the revised quote on Monday. Would you like me to format this into a formal report for the board?""",
     "email", "", "en", True, "stock-phrase"),
    ("en-reported-speech", """He realizes that the key is missing. She explains that the vault was opened at night. The guard reveals that he saw nothing, and the captain admits that the log was changed.""",
     "doc", "", "en", False, "reported-speech"),
    ("en-thread-mismatch", """Dear Jamie,

Thank you for your message. Here is a quick overview:

- **Cost:** the plan is cheaper per month
- **Speed:** the new disk is twice as fast
- **Next:** I will share the chart

Best regards""", "chat", "", "en", True, "structure-vs-thread",
     ["nice one, where did you get the numbers", "ok makes sense", "which disk do you use for the backups"]),
    ("en-thread-match", """From the vendor's own price page, and the speeds from my last two backups. For backups I use the bigger external disk""",
     "chat", "", "en", False, None,
     ["nice one, where did you get the numbers", "ok makes sense", "which disk do you use for the backups"]),
    # 2026-10-02: the Catalan marker "i" (and) matched the English pronoun "I", so an English
    # thread ending in "...otherwise I lose 20 euros" read as Catalan and raised a false HIGH.
    ("en-thread-pronoun-i", """Hi Anna, here's the logo case study, with the reasoning behind each version""",
     "chat", "", "en", False, None,
     ["On the way home", "Can you get these shoes for the kids please. Size 34",
      "They also require a 12 hour cancellation, otherwise I lose 20 euros"]),
    ("es-forgotten-signoff", """Te paso las tres opciones de proveedor con sus precios. Si necesitas más ideas, no dudes en pedírmelo.""",
     "chat", "", "es", True, "stock-phrase"),
    ("ca-parlem-posso", """Hola! Sí, parlém Català! Què tal? Com posso ajudar-te?""", "chat", "", "ca", True, "stock-phrase"),
]


def main():
    bad = 0
    for case in CASES:
        name, text, mode, voice, want_lang, must_fail, rule = case[:7]
        vc.THREAD = case[7] if len(case) > 7 else []
        vc.VOICE = vc.load_profile(PROFILES[voice]) if voice else {}
        lang = vc.detect_lang(text)
        score, findings = vc.check(text, mode, lang)
        high = any(f["sev"] == "HIGH" for f in findings)
        failed = high or score >= 25
        rules = {f["rule"] for f in findings}
        ok = (lang == want_lang) and (failed == must_fail) and (rule is None or rule in rules)
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {name:28s} lang={lang} score={score:3d} "
              f"{'rework' if failed else 'send  '} rules={sorted(rules)}")
    print(f"\n{len(CASES) - bad}/{len(CASES)} controls behave")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
