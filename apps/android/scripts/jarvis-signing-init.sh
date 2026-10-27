#!/usr/bin/env bash
# FORK 2026-10-19 (the architect: phone app) — create the one Jarvis signing key that every thirdParty build
# uses (app/build.gradle.kts reads the properties file). Run once per owner, then copy the two files to
# any other build machine: the same key is what lets a new APK install over the old one.
# Does nothing when the properties file already exists. Never prints the passwords.
set -euo pipefail

DIR="${JARVIS_SIGNING_DIR:-$HOME/.config/jarvis}"
PROPS="$DIR/android-signing.properties"
JKS="$DIR/android-jarvis.jks"
KEYTOOL="${JAVA_HOME:-$HOME/.jdks/jdk21}/bin/keytool"

if [[ -f "$PROPS" ]]; then
  echo "exists: $PROPS (left alone)"
  exit 0
fi
if [[ -e "$JKS" ]]; then
  echo "refusing: $JKS exists without $PROPS; sort that out by hand" >&2
  exit 1
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077
# PKCS12 keeps one password for store and key, so both properties carry the same value.
JARVIS_KS_PW="$(openssl rand -hex 24)"
export JARVIS_KS_PW
"$KEYTOOL" -genkeypair -noprompt \
  -keystore "$JKS" -storetype PKCS12 -alias jarvis \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Jarvis" \
  -storepass:env JARVIS_KS_PW >/dev/null
printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=jarvis\nkeyPassword=%s\n' \
  "$(basename "$JKS")" "$JARVIS_KS_PW" "$JARVIS_KS_PW" >"$PROPS"
chmod 600 "$PROPS" "$JKS"
unset JARVIS_KS_PW
echo "created: $JKS and $PROPS"
