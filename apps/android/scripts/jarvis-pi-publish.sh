#!/bin/bash
# jarvis-pi-publish.sh: build the Jarvis Android app ON THE PI, publish it through the phone door, push
# the silent update to the architect's phone and wait until the app answers again.
#
#   bash ~/src/tinkerclaw/apps/android/scripts/jarvis-pi-publish.sh "release notes" [source-root]
#
# Run it as a longjob (a release build takes ~20 min on the Pi under pigov P2).
# Why (2026-10-21): the laptop that used to build went offline, and the Pi became Jarvis's home,
# with permission to build and sign without asking.
# Needs the Pi kit, user space, no root:
#   ~/.jdks/jdk21 (Adoptium aarch64), ~/Android/Sdk (platforms;android-36, build-tools;36.0.0),
#   ~/Android/aapt2-x86/bin/aapt2 = Google's x86-64 aapt2 for AGP 9.2.0 run under Debian's box64, with
#   x86 libgcc_s in ~/Android/aapt2-x86/lib. Debian's arm64 aapt2 (Android 14) cannot read the API 36
#   android.jar ("RES_TABLE_TYPE_TYPE entry offsets overlap"). The "Symbol nftw not found" line box64
#   prints is harmless for Gradle's per-file aapt2 calls.
# The build mirror leaves out the stale ai/openclaw/android trees, which break compilation.
set -euo pipefail
# Enforced, not advised (2026-10-22): three times a turn launched this as a plain background shell
# (10-20 twice, 10-22 02:20), the build died with the turn and the reply had promised the update.
# longjob runs it as a systemd unit, which sets INVOCATION_ID. JARVIS_PUBLISH_FOREGROUND=1 overrides.
if [ -z "${INVOCATION_ID:-}" ] && [ -z "${JARVIS_PUBLISH_FOREGROUND:-}" ]; then
  echo "jarvis-pi-publish: run me as a longjob so I survive the turn:" >&2
  echo "  node ~/.claude/skills/longjob/scripts/longjob.mjs run --id phone-build --cmd 'bash $HOME/src/tinkerclaw/apps/android/scripts/jarvis-pi-publish.sh \"${1:-update}\"'" >&2
  exit 4
fi
NOTES=${1:-update}
SRC=${2:-$HOME/src/tinkerclaw}
export PATH=$HOME/.jdks/jdk21/bin:$HOME/.nvm/versions/node/v22.23.1/bin:$PATH
M=/tmp/jarvis/phone-app/mirror
O=$M/apps/android/app/build/outputs/apk/thirdParty/release
D=$HOME/.openclaw/data/phone-door/app
PHONE=${JARVIS_PHONE_NODE:-c3aea3e0eca1a3a602db47811e036c385c4c5c92c714d38d770b685f92ce0fe4}
OC="node $HOME/src/tinkerclaw/dist/index.js"

# 1. Source into the build mirror.
mkdir -p "$M/apps"
# One build at a time: two chats sharing this mirror killed each other's Gradle (each run ends with
# `gradlew --stop`), 2026-10-22, three failed builds. The second publish waits here.
exec 9>"$M/.publish.lock"
flock 9
cd "$SRC/apps"
rsync -a --delete \
  --exclude '/android/app/src/main/java/ai/openclaw/android/' \
  --exclude '/android/app/src/test/java/ai/openclaw/android/' \
  --exclude 'build/' --exclude '.gradle/' --exclude '.kotlin/' \
  android shared "$M/apps/"

# 1b. Voice parity (2026-10-22): the app's closed-app voice (JarvisVoiceFx.kt) must match the page's
# tuned voice, or jarvis.say sounds unlike the open app. A warning, not a stop: other app work still ships.
# 2026-10-23: the copy in the source being built ($SRC), not the one beside this script.
bash "$SRC/apps/android/scripts/voice-parity.sh" >/tmp/voice-parity.$$ 2>&1 ||
  { echo "WARNING: this APK's closed-app voice lags the page:" >&2; sed 's/^/  /' /tmp/voice-parity.$$ >&2; }
rm -f /tmp/voice-parity.$$

# 2. Gradle on the Pi. Shrunk (R8) by default again since 2026-10-23: the quick build (no R8, 2026-10-22)
# made the APK 72.7 MB instead of 8.5 MB, and the download proved slower than
# the build it saved. JARVIS_QUICK=1 still builds the big, fast one.
# The daemon (~1.3 GB) now stays warm 10 minutes for back-to-back builds, then exits on its own.
# Release lint is skipped: on the Pi its Kotlin analyzer crashes at random (2026-10-22, TerminalScreen.kt,
# unchanged code that had built two hours before). Compile errors still fail the build.
# Through pigov P2 (nice 19, CPUWeight 20): bare, the Gradle JVMs ran at nice 0 and starved the PDF
# reader's Piper voice to 13 s a sentence, so Read aloud looked dead (2026-10-21).
# pigov runs the command as a systemd unit: it keeps the cwd, not the env.
cd "$M/apps/android"
[ -f "$O/output-metadata.json" ] && mv -f "$O/output-metadata.json" "$O/output-metadata.prev.json"
python3 -I "$HOME/.openclaw/workspace/scripts/pi-gov/pigov.py" run --tier P2 --name gradle-apk -- \
  env JAVA_HOME="$HOME/.jdks/jdk21" ANDROID_HOME="$HOME/Android/Sdk" ./gradlew :app:assembleThirdPartyRelease -x lintVitalThirdPartyRelease $([ -n "${JARVIS_QUICK:-}" ] && echo -PjarvisQuick) -Dorg.gradle.daemon.idletimeout=600000 \
  --console=plain -Pandroid.aapt2FromMavenOverride="$HOME/Android/aapt2-x86/bin/aapt2" 2>&1 | tee "$M/gradle.log" | tail -6
# The tail above hides the cause; on failure show the error lines (full log: $M/gradle.log).
# w: lines too: with -Werror the only e: line is "warnings found" (2026-10-22, the FCM build).
[ -s "$O/output-metadata.json" ] || { grep -E '^[ew]: |error:|What went wrong' -A3 "$M/gradle.log" | head -30 >&2; echo "no APK built" >&2; exit 1; }

# 3. Same signer as the installed app (CN=Jarvis, 12adc71f…), or the phone refuses the update.
META=$(cat "$O/output-metadata.json")
VC=$(printf '%s' "$META" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["elements"][0]["versionCode"])')
APK=$(printf '%s' "$META" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["elements"][0]["outputFile"])')
VN=$(printf '%s' "$META" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["elements"][0]["versionName"])')
"$HOME/Android/Sdk/build-tools/36.0.0/apksigner" verify --print-certs "$O/$APK" | grep -q 'SHA-256 digest: 12adc71f' ||
  { echo "APK not signed with the Jarvis key" >&2; exit 1; }
mkdir -p "$D"
cp "$O/$APK" "$D/jarvis-$VC.apk"
SHA=$(sha256sum "$D/jarvis-$VC.apk" | cut -d' ' -f1)
NOTES_JSON=$(python3 -I -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$NOTES")
printf '{"versionCode":%s,"versionName":"%s","file":"jarvis-%s.apk","sha256":"%s","notes":%s}\n' \
  "$VC" "$VN" "$VC" "$SHA" "$NOTES_JSON" >"$D/latest.json.new"
mv "$D/latest.json.new" "$D/latest.json"
echo "published versionCode $VC"
# Size against the build before (2026-10-23): the quick no-R8 build grew the APK from 8.5 MB to 72.7 MB
# and nobody saw it for a day; every download felt slow.
PREV=$(ls -1t "$D"/jarvis-*.apk 2>/dev/null | grep -v "jarvis-$VC.apk" | head -1)
NEW_B=$(stat -c %s "$D/jarvis-$VC.apk")
if [ -n "$PREV" ]; then
  PREV_B=$(stat -c %s "$PREV")
  echo "APK size: $((NEW_B / 1000000)) MB (before: $((PREV_B / 1000000)) MB, $(basename "$PREV"))"
  [ "$NEW_B" -gt $((PREV_B * 3 / 2)) ] &&
    echo "WARNING: the APK grew by more than half; every phone download is that much slower" >&2
else
  echo "APK size: $((NEW_B / 1000000)) MB"
fi

# 3b. Every jarvis.* command the app declares must be on the gateway's allowlist, or the gateway refuses
#     it with "node command not allowed" (2026-10-22: jarvis.say was built and installed, then refused
#     until gateway.nodes.allowCommands got it and the gateway restarted). Warn only: the fix is a config
#     edit plus a restart, which this script does not do on its own.
REG="$SRC/apps/android/app/src/main/java/ai/openclaw/app/node/InvokeCommandRegistry.kt"
ALLOWED=$($OC config get gateway.nodes.allowCommands 2>/dev/null)
for c in $(grep -oE 'name = "jarvis\.[a-z.]+"' "$REG" | cut -d'"' -f2 | sort -u); do
  printf '%s' "$ALLOWED" | grep -q "\"$c\"" ||
    echo "WARNING: $c is not in gateway.nodes.allowCommands; the gateway will refuse it (add it, then restart)" >&2
done

# 4. Silent update on the phone, then wait (bounded) until the restarted app answers. The Pi gateway can
#    be slow under load: long timeouts, not retries of the update itself.
# A phone that does not answer is not a failed publish (2026-10-22: a 4-minute build that worked was
# reported as "exit 1, node invoke timed out"): note it and fall through to the wait, which ends in exit 3.
$OC nodes invoke --node "$PHONE" --command jarvis.update --invoke-timeout 90000 --timeout 120000 --json 2>&1 | tail -c 300 ||
  echo "the update push did not reach the phone (app asleep?); the APK is published anyway"
echo
# Wait for the NEW build, not for any answer: device.info reports appBuild (= versionCode) and works
# with the app in the background. jarvis.tinker.eval needs the app on screen, so after a silent
# install it could not tell "not installed" from "installed but in the background" (2026-10-21).
for _ in $(seq 1 12); do
  if $OC nodes invoke --node "$PHONE" --command device.info --invoke-timeout 20000 --timeout 40000 --json 2>/dev/null |
    grep -q "\"appBuild\": *\"$VC\""; then
    echo "phone runs versionCode $VC"
    exit 0
  fi
  sleep 10
done
echo "phone still on an older build. The APK is published; the install needs the Jarvis app OPEN on screen" >&2
echo "(silent installs only went through in the foreground, 2026-10-21): start the watcher as a longjob, it installs" >&2
echo "the build the moment the architect opens the app (never wakes the phone itself), then tell him to open it:" >&2
echo "  node $SRC/apps/android/scripts/update-when-on-screen.mjs $VC 3" >&2
exit 3
