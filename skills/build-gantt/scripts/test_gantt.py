"""Tests for gantt.py's worker-workflow discovery.

Run: python3 skills/build-gantt/scripts/test_gantt.py

The Gantt tab redraws every 15 s from the workflow ids in the plan, and the master writes those ids
in only at its next wake. So for a whole turn the tab showed nothing of what the worker was doing
(2026-10-05 20:31, the principal: "it should be automatically updating the real one, right?").
"""
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

GANTT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gantt.py")
WORKER = "You are the WORKER, in a fresh session. Read the charter (`~/b/charter.md`) first."


def iso(minutes_ago):
    return (dt.datetime.now().astimezone() - dt.timedelta(minutes=minutes_ago)).isoformat(timespec="seconds")


def session(home, sid, first_prompt):
    """A Claude Code session transcript whose first user prompt is first_prompt."""
    proj = os.path.join(home, ".claude/projects/p")
    os.makedirs(proj, exist_ok=True)
    with open(os.path.join(proj, sid + ".jsonl"), "w") as f:
        f.write(json.dumps({"type": "summary", "summary": "x"}) + "\n")
        f.write(json.dumps({"type": "user", "message": {"role": "user", "content": first_prompt}}) + "\n")


def workflow(home, sid, wf, label, start_min, end_min, done, age_s=0):
    d = os.path.join(home, ".claude/projects/p", sid, "subagents/workflows", wf)
    os.makedirs(d)
    aid = "a" + wf.replace("_", "").replace("-", "")[:12]
    journal = [{"type": "launched"}, {"type": "started", "agentId": aid, "label": label}]
    if done:
        journal.append({"type": "result", "agentId": aid, "result": "ok"})
    with open(os.path.join(d, "journal.jsonl"), "w") as f:
        f.write("".join(json.dumps(o) + "\n" for o in journal))
    with open(os.path.join(d, f"agent-{aid}.jsonl"), "w") as f:
        f.write(json.dumps({"type": "user", "timestamp": iso(start_min)}) + "\n")
        f.write(json.dumps({"type": "assistant", "timestamp": iso(end_min)}) + "\n")
    if age_s:
        t = time.time() - age_s
        os.utime(d, (t, t))


class Discovery(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="gantt-test-")
        session(self.home, "s-old", WORKER)
        session(self.home, "s-new", WORKER)
        session(self.home, "s-other", "Fix the duplicated chat bubbles in Tinker.")
        workflow(self.home, "s-old", "wf_old", "A1 build", 200, 150, True, age_s=3 * 3600)
        workflow(self.home, "s-new", "wf_new", "O1 build", 5, 1, False)
        workflow(self.home, "s-other", "wf_other", "dup build", 5, 1, False)
        self.plan_path = os.path.join(self.home, "gantt.json")
        self.plan = {
            "title": "Test build",
            "worker_prompt_has": ["You are the WORKER", "b/charter.md"],
            "phases": [
                {"id": "A", "label": "A · First", "kind": "build", "workflows": ["wf_old"], "tasks": []},
                {"id": "O", "label": "O · Sent now", "kind": "build", "status": "next",
                 "tasks": [{"label": "O1 tune", "est_hours": 1}]},
            ],
        }

    def write_plan(self):
        with open(self.plan_path, "w") as f:
            json.dump(self.plan, f)

    def run_gantt(self, *args):
        env = {**os.environ, "HOME": self.home}
        r = subprocess.run([sys.executable, GANTT, *args], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_live_shows_a_running_worker_workflow_the_plan_does_not_list(self):
        self.write_plan()
        out = self.run_gantt("live", self.plan_path, "--fragment")
        self.assertIn("wf_new", out)
        self.assertNotIn("wf_other", out)
        with open(self.plan_path) as f:  # live never writes the plan
            self.assertNotIn("wf_new", f.read())

    def test_derive_records_the_worker_workflow_under_the_phase_being_sent(self):
        self.write_plan()
        self.run_gantt("derive", self.plan_path)
        with open(self.plan_path) as f:
            plan = json.load(f)
        self.assertEqual(plan["phases"][0]["workflows"], ["wf_old"])
        self.assertEqual(plan["phases"][1]["workflows"], ["wf_new"])
        self.assertEqual([t["label"] for t in plan["phases"][1]["auto_tasks"]], ["O1 tune"])

    def test_a_split_unit_takes_its_own_lane_and_retires_the_planned_one(self):
        # turn 36 split K36 into K36a and K36b: the lanes read "K36a:build" and the planned K36 bar stayed
        workflow(self.home, "s-new", "wf_split", "K1a:build", 4, 1, False)
        self.plan["phases"][1]["tasks"].append({"label": "K1 tune the mux", "est_hours": 2})
        self.write_plan()
        out = self.run_gantt("live", self.plan_path, "--fragment")
        data = json.loads(out.split('id="gd">', 1)[1].split("</script>", 1)[0])
        labels = [lane["label"] for lane in data["lanes"] if lane["phase"] == "O"]
        self.assertIn("K1a", labels)
        self.assertNotIn("K1a:build", labels)
        self.assertNotIn("K1 tune the mux", labels)

    def test_no_discovery_without_a_worker_mark(self):
        del self.plan["worker_prompt_has"]
        self.write_plan()
        self.run_gantt("derive", self.plan_path)
        with open(self.plan_path) as f:
            plan = json.load(f)
        self.assertNotIn("workflows", plan["phases"][1])

    def test_no_discovery_without_a_phase_being_sent(self):
        del self.plan["phases"][1]["status"]
        self.write_plan()
        out = self.run_gantt("live", self.plan_path, "--fragment")
        self.assertNotIn("wf_new", out)


if __name__ == "__main__":
    unittest.main()
