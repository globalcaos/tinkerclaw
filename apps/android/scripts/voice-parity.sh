#!/bin/bash
# voice-parity.sh — does the app's closed-app voice (JarvisVoiceFx.kt) match the page's voice
# (tinker-ui voice-in-browser.ts + voice-intonation.ts)? Prints each mismatch, exit 1 if any.
#
# Why (2026-10-22): the architect tuned the phone voice on the page for two hours (intonation 2.2 -> 3.0,
# a singing metallic fork, its octave, split, grid and volume). The app kept its own copy for
# jarvis.say with the app closed, and only a comment said it lagged.
# Since 2026-10-23 (plan "phone app self-update", step 4) both read ONE file, the factory content
# pack's voice-fx.json, so this checks three things instead of comparing two codebases:
#   1. every number in voice-fx.json is read by the page and by the app (no knob only one side has);
#   2. neither side keeps its own copy (the page imports the file; the Kotlin has no defaults);
#   3. the pack the door publishes carries the same voice-fx.json (else the closed-app voice is
#      older than the page's: run scripts/phone-door/pack-publish.sh).
# jarvis-pi-publish runs it before every APK build. PHONE_DOOR_DIR overrides the door folder.

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
FX="$ROOT/apps/android/app/src/thirdParty/assets/pack/voice-fx.json"
PAGE="$ROOT/tinker-ui/src/voice-in-browser.ts"
FORK="$ROOT/tinker-ui/src/voice-intonation.ts"
APP="$ROOT/apps/android/app/src/main/java/ai/openclaw/app/jarvis/JarvisVoiceFx.kt"
DOOR_APP="${PHONE_DOOR_DIR:-$HOME/.openclaw/data/phone-door}/app"
exec python3 -I - "$FX" "$PAGE" "$FORK" "$APP" "$DOOR_APP" <<'PY'
import hashlib, json, os, re, sys, zipfile
fx_path, page, fork, app, door = sys.argv[1:]
fx_raw = open(fx_path, "rb").read()
fx = json.loads(fx_raw)
ts = open(page).read() + open(fork).read()
kt = open(app).read()
bad = []

def leaves(o, path=()):
    for k, v in o.items():
        if isinstance(v, dict):
            yield from leaves(v, path + (k,))
        elif isinstance(v, (int, float, list)) and k != "format":
            yield path + (k,)

for p in leaves(fx):
    key = p[-1]
    if not re.search(r"\." + re.escape(key) + r"\b", ts):
        bad.append(f"page does not read {'.'.join(p)}")
    if not re.search(r"\bval " + re.escape(key) + r":", kt):
        bad.append(f"app does not read {'.'.join(p)}")
for f in (page, fork):
    if "assets/pack/voice-fx.json" not in open(f).read():
        bad.append(f"{os.path.basename(f)} does not import voice-fx.json (a local copy of the numbers?)")
if re.search(r"const val (INTONATION|RESONANCE|BAR_MIX|FORK_STEP)\b", kt):
    bad.append("JarvisVoiceFx.kt has its own voice constant again")

try:
    ptr = json.load(open(os.path.join(door, "pack.json")))
    with zipfile.ZipFile(os.path.join(door, ptr["file"])) as z:
        published = z.read("voice-fx.json")
    if hashlib.sha256(published).digest() != hashlib.sha256(fx_raw).digest():
        bad.append(f"the published pack {ptr['version']} has an older voice-fx.json than the page: run scripts/phone-door/pack-publish.sh")
except FileNotFoundError:
    bad.append("no content pack published yet: the phone uses the voice-fx.json inside its APK")
except Exception as err:
    bad.append(f"published pack unreadable: {err}")

for b in bad:
    print(b)
if not bad:
    print("voice parity: page and app read the same voice-fx.json, and the published pack carries it")
sys.exit(1 if bad else 0)
PY
