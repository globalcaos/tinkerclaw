// Jarvis content pack, main script (plan 2026-10-23 "phone app self-update", layer 2).
// Runs inside the app's sandboxed JavaScript engine: no network, no files, no page. The only way out
// is the `jarvis` object, and it only queues the layer-1 verbs (buzz, say, play, notify, open,
// keepAwake); the app runs them after the handler returns. A throw in "start" rolls this pack back.
// Change this file and publish (scripts/phone-door/pack-publish.sh): no APK, no install prompt.

jarvis.on("start", function () {});

// The answer to a prompt sent from the phone just before its screen locked. The page is frozen
// then, so the Pi hands the line here (jarvis-call --buzz): buzz first, then speak it.
jarvis.on("answer", function (ev) {
  jarvis.buzz([180]);
  jarvis.say(ev.text);
});

// A Firebase wake from the gateway. Nothing to do yet; the app already checks for a new pack.
jarvis.on("wake", function () {});
