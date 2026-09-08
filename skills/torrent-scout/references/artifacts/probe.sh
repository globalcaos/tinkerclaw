#!/bin/bash
# probe.sh <name> <url> [extra curl args...]
name="$1"; url="$2"; shift 2
out="/tmp/nets/${name}.body"
meta=$(curl -sS -L --max-time 25 \
  -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' \
  -o "$out" -w '%{http_code}|%{size_download}|%{content_type}|%{time_total}|%{url_effective}' "$@" "$url" 2>/tmp/nets/${name}.err)
rc=$?
echo "### $name"
echo "URL: $url"
if [ $rc -ne 0 ]; then
  echo "CURL_FAIL rc=$rc : $(head -c 200 /tmp/nets/${name}.err | tr '\n' ' ')"
else
  echo "META: $meta"
  echo "SNIPPET:"
  head -c 400 "$out" | tr -d '\000' | sed 's/^/  /'
  echo ""
fi
echo "---"
