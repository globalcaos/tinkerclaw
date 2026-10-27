// Runs before a content pack's main.js in the app's JavaScript engine (JarvisScript.kt). It is the
// whole API a pack script has: jarvis.on(event, fn) and the layer-1 verbs, which only QUEUE a call.
// __jarvisRun(event, ctx) runs the handler and returns {handled, calls} as JSON; the app checks
// every call against its own verb list before running it, so this file is not the security line.
// Lives in the APK (not the pack) so a pack cannot change how its own calls are collected.
var __jarvisHandlers = {};
var __jarvisCalls = [];
var __jarvisQueue = function (verb, args) {
  if (__jarvisCalls.length >= 20) throw new Error("too many jarvis calls (max 20)");
  __jarvisCalls.push({ verb: verb, args: args });
};
var jarvis = Object.freeze({
  on: function (event, fn) {
    if (typeof fn !== "function") throw new Error("jarvis.on(" + event + "): handler is not a function");
    __jarvisHandlers[String(event)] = fn;
  },
  buzz: function (pattern) {
    __jarvisQueue("buzz", { pattern: pattern });
  },
  say: function (text, voice) {
    __jarvisQueue("say", { text: String(text == null ? "" : text), voice: voice || {} });
  },
  play: function (url) {
    __jarvisQueue("play", { url: String(url) });
  },
  notify: function (title, body, tap) {
    __jarvisQueue("notify", { title: String(title || ""), body: String(body || ""), tap: tap || "" });
  },
  open: function (target) {
    __jarvisQueue("open", { target: String(target) });
  },
  keepAwake: function (minutes) {
    __jarvisQueue("keepAwake", { minutes: Number(minutes) || 0 });
  },
});
var __jarvisRun = function (event, ctx) {
  var h = Object.prototype.hasOwnProperty.call(__jarvisHandlers, event) ? __jarvisHandlers[event] : null;
  if (h) h(ctx || {});
  return JSON.stringify({ handled: !!h, calls: __jarvisCalls });
};
