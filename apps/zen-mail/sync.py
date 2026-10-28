#!/usr/bin/env python3
"""Hourly run: collect new mail from every configured mailbox, then triage it. Safe to run by hand."""
import fcntl
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))  # run with python3 -I, which drops the script folder
import sys
import traceback

from common import DATA, AuthExpired, db, log, meta_get, meta_set, now_iso, settings
from sources import complete_outlook_threads, fetch_clawhub, fetch_github, fetch_slack, fetch_gmail, fetch_jira, fetch_outlook, fetch_teams, fetch_whatsapp
from tidy import tidy_inbox
from triage import triage
import merge
import owner


TEAMS_DIR = _os.path.expanduser("~/.openclaw/workspace/skills/teams-hack")
TENANT = "f00f60b1-b967-4c0b-91ce-eb200dab0604"


def renew_outlook():
    """Renew the Outlook sign-in from the shared Teams tab, the way skill outlook-hack § Renew the token does it.
    the architect, 2026-10-21 21:51: "the only reason the teams tab is open and shared is for you to use it without asking".
    The token goes from one process to the other through a pipe and is never printed or kept here."""
    import subprocess
    try:
        tok = subprocess.run(["node", "scripts/refresh-token-from-tab.mjs"], cwd=TEAMS_DIR, capture_output=True,
                             text=True, timeout=120).stdout.strip()
        if len(tok) < 100:
            return False
        subprocess.run(["teams", "token", "store", "--tenant-id", TENANT], input=tok, cwd=TEAMS_DIR,
                       capture_output=True, text=True, timeout=60)
        del tok
        return True
    except Exception as err:
        log(f"[sync] renewing the Outlook sign-in from Teams failed: {err}")
        return False


def main():
    cfg = settings()
    DATA.mkdir(parents=True, exist_ok=True)
    lock = open(DATA / "sync.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("[sync] another run is in progress; leaving")
        return 0
    conn = db()
    status = meta_get(conn, "status", {}) or {}
    for acct, spec in cfg["accounts"].items():
        me = (spec.get("address") or "").lower()
        if not me:
            status[acct] = {"ok": False, "error": "No address set for this mailbox in settings.json", "at": now_iso(),
                            "last_ok": (status.get(acct) or {}).get("last_ok")}
            # 2026-10-21: this `continue` used to skip the save below and log nothing, so after the move to the Pi
            # (settings without addresses) both mailboxes were skipped for days with no banner and no log line.
            log(f"[sync] {acct}: skipped, no address set for this mailbox in settings.json")
            meta_set(conn, "status", status)
            continue
        last_ok = (status.get(acct) or {}).get("last_ok")  # the last refresh that worked, kept through failures
        try:
            if spec["kind"] == "outlook":
                try:
                    fetch_outlook(conn, acct, cfg["days"])
                except AuthExpired:
                    log(f"[sync] {acct}: sign-in expired, renewing it from the shared Teams tab")
                    if not renew_outlook():
                        raise
                    fetch_outlook(conn, acct, cfg["days"])  # a second AuthExpired means the tab's own sign-in is dead
                complete_outlook_threads(conn, acct)
            elif spec["kind"] == "gmail":
                fetch_gmail(conn, acct, cfg["days"], me)
            # The other sources of this side (work: Jira, Teams; personal: WhatsApp). One failing source is logged
            # and noted, never the end of the run: the mail and the other sources still get triaged together.
            extra = {}
            for src in spec.get("sources") or []:
                try:
                    if src == "jira":
                        fetch_jira(conn, acct)
                    elif src == "teams":
                        fetch_teams(conn, acct, cfg["days"], me, cfg.get("owner", ""))
                    elif src == "whatsapp":
                        fetch_whatsapp(conn, acct, cfg["days"], me)
                    elif src == "github":
                        fetch_github(conn, acct)
                    elif src == "slack":
                        fetch_slack(conn, acct, me)
                    elif src == "clawhub":
                        fetch_clawhub(conn, acct)
                    extra[src] = "ok"
                except Exception as err:
                    log(f"[sync] {acct}/{src} failed: {err}")
                    extra[src] = str(err)[:200]
            # One matter, one topic (2026-10-19): join threads first, so triage reads each matter whole.
            merge.detect(conn, acct, me)
            merge.apply(conn, acct)
            n = triage(conn, acct, me, cfg, (owner.brief() + "\n\n" + (cfg.get("about_owner") or "")).strip())
            tidy_inbox(conn, acct)
            status[acct] = {"ok": True, "at": now_iso(), "last_ok": now_iso(), "triaged": n, "sources": extra}
        except AuthExpired as err:
            log(f"[sync] {acct}: sign-in expired: {err}")
            status[acct] = {"ok": False, "auth": True, "error": "The sign-in expired", "at": now_iso(),
                            "since": (status.get(acct) or {}).get("since") or now_iso(), "last_ok": last_ok}
        except Exception as err:
            log(f"[sync] {acct} failed: {err}")
            traceback.print_exc()
            msg = str(err)
            if "missing --account" in msg or "No tokens stored" in msg:  # gog holds no Gmail account on this machine
                msg = "Gmail is not signed in on this machine yet (one sign-in in a browser fixes it)"
            status[acct] = {"ok": False, "error": msg[:300], "at": now_iso(), "last_ok": last_ok}
        if status[acct].get("ok"):
            status[acct].pop("since", None)
        meta_set(conn, "status", status)
    # Jarvis's own streams (2026-10-16): read only the opened dams and the next in line, then maybe let one card out.
    try:
        from dams import release
        from streams import collect
        collect(conn)
        release(conn)
    except Exception as err:
        log(f"[sync] streams failed: {err}")
        traceback.print_exc()
    # Promises the owner made and has not kept come back to his list the day after they were due (promises.py,
    # 2026-10-27); before escalate, so a card that comes back is weighed in the same run.
    try:
        import promises
        promises.check_due(conn)
    except Exception as err:
        log(f"[sync] promises failed: {err}")
        traceback.print_exc()
    # Urgency that grows while a topic waits, then a notification, then a call (escalate.py, 2026-10-22).
    try:
        import escalate
        escalate.run(conn)
    except Exception as err:
        log(f"[sync] escalate failed: {err}")
        traceback.print_exc()
    # The butler (2026-10-16; 2026-10-22: every changed subject, one helper each, all in parallel; butler.py).
    try:
        from butler import butler_pass
        butler_pass(conn)
    except Exception as err:
        log(f"[sync] butler failed: {err}")
        traceback.print_exc()
    meta_set(conn, "last_sync", now_iso())
    log("[sync] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
