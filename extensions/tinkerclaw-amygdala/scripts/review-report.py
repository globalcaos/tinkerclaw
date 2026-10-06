#!/usr/bin/env python3
"""What Grok's usefulness reviews say about Jev's flags, per rule (2026-10-06).

Reads the amygdala store read-only. Usage: review-report.py [days=7] [--fixes]
Per rule (family / what Jev did / rule code): flags reviewed, how Grok judged them, and how the architect voted.
`noise` and `harmful` are the candidates to tighten or switch off; the owner decides, this only shows the evidence.
--fixes also lists Grok's suggested change for each noise or harmful verdict.
"""
import json, os, sqlite3, sys, time

args = [a for a in sys.argv[1:] if not a.startswith("--")]
days = float(args[0]) if args else 7
since = int((time.time() - days * 86400) * 1000)
path = os.path.expanduser("~/.openclaw/data/amygdala-jev/amygdala.sqlite")
db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
if not db.execute("SELECT 1 FROM sqlite_master WHERE name='reviews'").fetchone():
    sys.exit("no reviews yet: the table appears when the gateway loads a build with the review job")
rows = db.execute(
    """SELECT d.family, d.kind,
              CASE WHEN instr(d.reason_code,'[')>0 THEN substr(d.reason_code,1,instr(d.reason_code,'[')-1) ELSE d.reason_code END AS rule,
              COUNT(*), SUM(r.verdict='useful'), SUM(r.verdict='harmless'), SUM(r.verdict='noise'), SUM(r.verdict='harmful'),
              SUM(EXISTS(SELECT 1 FROM labels l WHERE l.target_id=d.id AND l.kind='useful' AND l.value=1)),
              SUM(EXISTS(SELECT 1 FROM labels l WHERE l.target_id=d.id AND l.kind='useful' AND l.value=-1))
       FROM reviews r JOIN decisions d ON d.id=r.decision_id
       WHERE r.status='done' AND r.ts>=? GROUP BY 1,2,3 ORDER BY 4 DESC""",
    (since,),
).fetchall()
failed = db.execute("SELECT COUNT(*) FROM reviews WHERE status='failed' AND ts>=?", (since,)).fetchone()[0]
total = sum(r[3] for r in rows)
print(f"{total} reviewed in the last {days:g} days ({failed} failed)\n")
print(f"{'family':<14}{'did':<10}{'rule':<34}{'n':>4}{'useful':>8}{'harmless':>10}{'noise':>7}{'harmful':>9}{'👍':>4}{'👎':>4}")
for fam, kind, rule, n, u, h, no, ha, up, down in rows:
    print(f"{fam:<14}{kind:<10}{rule[:33]:<34}{n:>4}{u or 0:>8}{h or 0:>10}{no or 0:>7}{ha or 0:>9}{up or 0:>4}{down or 0:>4}")
if "--fixes" in sys.argv:
    print()
    for did, rule, body in db.execute(
        """SELECT d.id, d.reason_code, r.body_json FROM reviews r JOIN decisions d ON d.id=r.decision_id
           WHERE r.status='done' AND r.verdict IN ('noise','harmful') AND r.ts>=? ORDER BY r.ts DESC LIMIT 40""",
        (since,),
    ):
        b = json.loads(body)
        print(f"- {rule}: {b['reason']}" + (f"\n    fix: {b['fix']}" if b.get("fix") else ""))
