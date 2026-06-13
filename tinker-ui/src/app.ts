import MarkdownIt from "markdown-it";
// FORK 2026-06-11 (fractal v3, bible §5.67b) — fractal dock renderer lives in its
// own one-concern module (the sectioned-reply.ts extraction precedent); app.ts
// keeps only the KNOWN_STREAMS entry, the stream:"fractal" dispatch, and the
// dock-anchor lookup over app.ts-owned message state.
import { upsertFractalDock } from "./fractal-dock.js";
// FORK 2026-06-06 — BROCA recipe visibility: shared render module for the
// single-recipe (recipe-detail) page. renderBrocaProgram turns a parsed recipe
// into interleaved code+prose; BrocaRecipe is the read DTO shape.
import { renderBrocaProgram, type BrocaRecipe } from "./panels/broca.js";
import { mountContextTimeline } from "./panels/context-timeline.js";
// Tinker UI — Command Center v0.3
import { mountContextTreemap } from "./panels/context-treemap.js";
// FORK 2026-06-13 (eeg): seismograph trace store (bible §5.8h) — pure state +
// SVG renderer live in their own unit-tested module; app.ts only feeds and
// mounts it (effort stream → record, lifecycle end → turnEnd, history → backfill).
import {
  EegTraceStore,
  eegStopLeftCss,
  eegProviderPaint,
  eegCostWidthPx,
  type EegSample,
  type EegTurnEnd,
} from "./panels/eeg-trace.js";
import {
  mountPrefrontalTree,
  type PanelPlan,
  type PrefrontalDashboardState,
  type PrefrontalTreeController,
  type RecipeState,
  type TrailEvent,
  type TrailEventKind,
  type TrailEventPayload,
  type TreeNode,
  type TreeResponse,
} from "./panels/prefrontal-tree.js";
import {
  renderPresenceGraphsHtml,
  attachPresenceGraphs,
  type GGroup,
} from "./panels/presence-graph.js";
import { mountResponseTreemap } from "./panels/response-treemap.js";
// FORK 2026-06-08 — bug "queued prompts stick forever + show in every tab": pure, unit-tested
// helpers that scope the queued-send array by session (render only the active tab's entries; settle
// a session's entries when ITS turn ends, independent of which tab is viewed). See queued-sends.ts.
import { queuedForSession, settleQueuedSession } from "./queued-sends.js";
// FORK 2026-06-10 (amygdala retirement): the 3-section reply split/render logic
// lives in its own unit-tested module. Recognises only 💬 ANSWER / 🌿 FRACTAL;
// the retired 🧠 AMYGDALA section is no longer split or compacted (live panel owns it).
import {
  renderSectionedReply,
  splitSectionedReply,
  splitLeadingNarration,
} from "./sectioned-reply.js";
// FORK 2026-05-30: shared per-subagent identity color (chat sub-bubble + RECIPES
// panel row + thinking-row all import the SAME function so colors always match).
import { colorForSubagent, shortSubagentId } from "./subagent-color.js";

// FORK 2026-05-09: disable linkify — markdown-it was auto-converting plain
// text like "BRIEFING.md" into <a href="http://BRIEFING.md"> which navigates
// to a search/dictionary page when clicked. Real file paths still get the
// click-to-open treatment via the `.fs-link` post-processor (see md() below).
// Real URLs still link via explicit markdown syntax `[label](url)`.
const mdParser = MarkdownIt({ html: false, linkify: false, breaks: true });

// FORK 2026-04-20: Prefrontal debug channel. Turn on by visiting the page with
// ?pfdebug=1 or by running `__pf.debug=true` in devtools. When on, every
// prefrontal-related WS event, state transition, and render decision logs a
// line to the console, and `__pf.state` mirrors the current dashboard feed so
// you can inspect it live from the browser devtools.
const PF_DEBUG_STATE = {
  debug:
    new URLSearchParams(window.location.search).get("pfdebug") === "1" ||
    localStorage.getItem("tinker-pf-debug") === "1",
  lastTree: null as unknown,
  lastRecipe: null as unknown,
  lastTrailEvent: null as unknown,
  lastRenderSource: "" as "extension" | "fallback" | "",
  renderCount: 0,
  eventCounts: { tree: 0, recipe: 0, trail: 0, subagentStart: 0, subagentEnd: 0 },
};
function pfLog(label: string, payload?: unknown): void {
  if (!PF_DEBUG_STATE.debug) {
    return;
  }
  const ts = new Date().toISOString().split("T")[1].replace("Z", "");
  // One-argument form keeps devtools cleaner when payload is undefined.
  if (payload === undefined) {
    console.log(`%c[PF %s] %s`, "color:#c19a6b;font-weight:600", ts, label);
    return;
  }
  console.log(`%c[PF %s] %s`, "color:#c19a6b;font-weight:600", ts, label, payload);
}
// Expose a live inspection handle so you can do `__pf.enable()` / `__pf.state`
// from devtools without needing a page reload.
(window as unknown).__pf = {
  get debug() {
    return PF_DEBUG_STATE.debug;
  },
  enable() {
    PF_DEBUG_STATE.debug = true;
    localStorage.setItem("tinker-pf-debug", "1");
    console.log("%c[PF] debug ON (persists across reloads)", "color:#c19a6b;font-weight:600");
  },
  disable() {
    PF_DEBUG_STATE.debug = false;
    localStorage.removeItem("tinker-pf-debug");
    console.log("[PF] debug OFF");
  },
  state: PF_DEBUG_STATE,
};
if (PF_DEBUG_STATE.debug) {
  console.log(
    "%c[PF] debug active — prefrontal events will log here. `__pf.disable()` to turn off.",
    "color:#c19a6b;font-weight:600",
  );
}

// Runtime config: injected by the tinker plugin into index.html, or via URL params
const __cfg = (window as unknown).__TINKER_CONFIG ?? {};
const TOKEN = __cfg.token ?? new URLSearchParams(window.location.search).get("token") ?? "";
// In dev mode (vite), connect WS directly to the gateway; in prod the plugin serves from the gateway itself
const GW_WS = import.meta.env.DEV
  ? `ws://localhost:18789`
  : `ws${window.location.protocol === "https:" ? "s" : ""}://${window.location.host}`;
const BASE = import.meta.env.BASE_URL ?? "/";

// FORK 2026-06-07 — auto full-reload on any dev HMR update. This app renders once at
// import time with no granular hot-accept, so a Vite hot-swap replaces the module but
// never re-paints the DOM — which is why structural UI edits looked "stuck" until a
// manual hard refresh. Self-accepting with location.reload() makes dev edits actually
// appear live, matching the "dev server loads code directly" expectation. Dev-only:
// import.meta.hot is undefined (and this block stripped) in the production build.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    location.reload();
  });
}

let ws: WebSocket | null = null;
let connected = false;
let pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let sessionKey = "";
let sessions: unknown[] = [];
let messages: unknown[] = [];
/** Index into messages[] of the current streaming temporary message, or -1 if none. */
let streamMsgIdx = -1;
let streamRunId: string | null = null;
let streamProvider = "";
let streamProfileId = "";
// FORK 2026-06-04 — bug task-mpwfiot2 (Queuing a prompt): user prompts queued WHILE a turn is
// streaming are held here (NOT in messages[]) until the turn finalizes, then flushed into
// messages[] in correct chronological order. Keeping them out of messages[] during the turn is
// what prevents the running turn's continuation/tool bubbles from landing after them — the
// "queued prompt appears in the middle of the last answer (fixed by hard refresh)" bug.
// Rendered as trailing bubbles by updateChat; flushed by the chat final/error/aborted handler.
let pendingQueuedSends: Array<Record<string, unknown>> = [];
/** Length of the last full delta text received (used to compute per-bubble
 * `_segmentStart` when a new bubble is created mid-stream — tool freeze or
 * >5s gap split). FORK 2026-05-09: replaced the global frozenTextEnd cursor
 * with per-bubble `_segmentStart` so concurrent freezes (tool + gap) don't
 * clobber each other's offsets. */
let lastDeltaLen = 0;
/** FORK 2026-05-09 (Feature C): wall-clock ms of the most recent text_delta arrival.
 * Used to detect gaps >5s and split assistant bubbles. Reset on final/error/clear. */
let lastDeltaAt = 0;
let sending = false;
let currentTurnNumber = 0;
let expandedTools = new Set<string>();

// FORK (2026-04-21): Story Mode. When on, every tool call renders as if it
// were clicked-expanded: full grandma-friendly title, full args, full stdout,
// full tool result. Intended for users who want to "see literally everything"
// the agent does, interleaved with thinking and text, as a continuous
// narrative that builds up chronologically. Toggle via the 🎬 button in the
// topbar; persists across reloads. Default ON so first-time users see the
// full flow immediately — they can turn it off if they want the compact view.
// FORK 2026-04-27: removed Story Mode entirely. Bible §5.6 specifies tool
// calls collapse by default with click-to-expand; the topbar 🎬 toggle was
// a global override that confused the click-to-collapse contract and added
// no behaviour the user wanted. Stale `tinker-story-mode` localStorage
// keys from previous installs are harmless — nothing reads them now.
let initialized = false;
let _budgetData: unknown = null;
let budgetUsageData: unknown = null;
let _forensicMode = false;
// FORK: Active recipe step name for thinking indicator + message tags
let activeRecipeStep: string | null = null;
// FORK 2026-06-06 — BROCA recipe visibility: the recipe-detail page is reached
// by clicking any .broca-recipe-link (chat banner, RECIPES panel, recipe card).
// currentRecipeRef holds the selected recipe's slug/ref; lastRecipeList is the
// most recent prefrontal.recipe.list result, used as a graceful-degradation
// metadata fallback for the detail page when prefrontal.recipe.read is not yet
// deployed. recipeRefListenerAttached guards the single delegated click wiring.
let currentRecipeRef: string | null = null;
let lastRecipeList: any[] = [];
let recipeRefListenerAttached = false;
let budgetScope: "session" | "all" = "session";
let timelineCtrl: ReturnType<typeof mountContextTimeline> | null = null;

// FORK (2026-04-21): reload the timeline for the current session, but respect
// the filter toggle. Previously every tab switch called loadSession() directly,
// which silently collapsed an "All"-mode timeline back to the single session
// while leaving the toggle visually set to "All" — fixing required toggling
// off and on again. Centralizing here keeps the two states in sync.
function refreshTimelineRespectingMode(): void {
  if (!timelineCtrl) {
    return;
  }
  if (timelineCtrl.getFilterMode() === "all") {
    timelineCtrl.loadAllSessions(sessions.map((s: unknown) => s.key));
  } else {
    timelineCtrl.loadSession(sessionKey);
  }
}

// ─── Tab State ───
interface Tab {
  id: string;
  sessionKey: string | null; // null = unattached
  title: string;
  isAttached: boolean;
  // FORK 2026-06-06 — u2-tab-naming: once a tab gets a deliberate title (manual rename OR a
  // successful auto-name), lock it so loadSessions() never overwrites it with the server
  // fortune-cookie phrase. Persisted to localStorage via saveTabs(), so custom/auto names
  // survive both a hard refresh AND a gateway restart.
  titleLocked?: boolean;
}

// FORK 2026-05-24 (fourth pass) — bug task-mpjhzu3j-ma9ts:
// FORTUNE_COOKIES moved to src/shared/fortune-cookies.json (single
// source of truth shared between client and server lazy-mint). The
// inline 218-entry array + randomFortune() function that lived here
// were extracted on 2026-05-24. Both client (this file, addTab + /clear)
// and server (src/gateway/session-cookie-phrase.ts) import from the
// same JSON now. See bible session-naming.md.
import { FORTUNE_COOKIES, fortuneForKey, randomFortune } from "../../src/shared/fortune-cookies.js";

// FORK 2026-05-25 — emoji catalog for the inline group/sub-group
// rename picker (openInlineAxisLabelEdit). Curated common set across
// faces, hands, hearts/symbols, objects, nature, animals, food,
// activities, travel, time/weather. Skin-tone + gender variants
// omitted to keep the grid compact; users can paste those manually
// if needed. Order roughly matches Unicode emoji order within each
// section so the scroll feels like Slack/Discord rather than random.
const EMOJI_CATALOG: readonly string[] = [
  // Smileys & emotion
  "😀",
  "😁",
  "😂",
  "🤣",
  "😃",
  "😄",
  "😅",
  "😆",
  "😉",
  "😊",
  "😋",
  "😎",
  "😍",
  "🥰",
  "😘",
  "🥲",
  "😗",
  "😙",
  "😚",
  "🙂",
  "🤗",
  "🤩",
  "🤔",
  "🫡",
  "🤨",
  "😐",
  "😑",
  "😶",
  "🙄",
  "😏",
  "😣",
  "😥",
  "😮",
  "🤐",
  "😯",
  "😪",
  "😫",
  "🥱",
  "😴",
  "😌",
  "😛",
  "😜",
  "🤪",
  "😝",
  "🤤",
  "😒",
  "😓",
  "😔",
  "😕",
  "🙃",
  "🤑",
  "😲",
  "☹️",
  "🙁",
  "😖",
  "😞",
  "😟",
  "😤",
  "😢",
  "😭",
  "😦",
  "😧",
  "😨",
  "😩",
  "🤯",
  "😬",
  "😰",
  "😱",
  "🥵",
  "🥶",
  "😳",
  "😵",
  "🥴",
  "😠",
  "😡",
  "🤬",
  "😷",
  "🤒",
  "🤕",
  "🤢",
  "🤮",
  "🥳",
  "🥺",
  "🤠",
  "🤡",
  "🤥",
  "🥸",
  "🤫",
  "🤭",
  "🫣",
  // Hands & body
  "👍",
  "👎",
  "👌",
  "✌️",
  "🤞",
  "🤟",
  "🤘",
  "🤙",
  "👈",
  "👉",
  "👆",
  "👇",
  "☝️",
  "✋",
  "🤚",
  "🖐️",
  "🖖",
  "👋",
  "🤝",
  "👏",
  "🙌",
  "🙏",
  "🤲",
  "💪",
  "🫶",
  "🫰",
  "🫵",
  "🦾",
  "🧠",
  "👁️",
  "👀",
  "👄",
  "🫦",
  // Hearts & symbols
  "❤️",
  "🧡",
  "💛",
  "💚",
  "💙",
  "💜",
  "🖤",
  "🤍",
  "🤎",
  "💔",
  "❣️",
  "💕",
  "💞",
  "💓",
  "💗",
  "💖",
  "💘",
  "💝",
  "💟",
  "💯",
  "💢",
  "💥",
  "💫",
  "💦",
  "💨",
  "💬",
  "💭",
  "🗯️",
  "♻️",
  "✨",
  "⭐",
  "🌟",
  "🌠",
  "🌈",
  "☀️",
  "☁️",
  "⛅",
  "🌤️",
  "🌧️",
  "⛈️",
  "❄️",
  "☃️",
  "🔥",
  "💧",
  "🌊",
  // Objects, tools, work
  "💼",
  "🎒",
  "👜",
  "🎓",
  "📱",
  "💻",
  "⌨️",
  "🖥️",
  "🖨️",
  "📷",
  "📹",
  "🎥",
  "📞",
  "📺",
  "📻",
  "🎙️",
  "🎛️",
  "⏰",
  "🕰️",
  "⌛",
  "⏳",
  "📡",
  "🔋",
  "🔌",
  "💡",
  "🔦",
  "🕯️",
  "🧯",
  "💸",
  "💵",
  "💰",
  "💳",
  "🧾",
  "💎",
  "⚖️",
  "🧰",
  "🔧",
  "🪛",
  "🔩",
  "⚙️",
  "🪤",
  "🧲",
  "🔫",
  "💣",
  "🧨",
  "⚔️",
  "🛡️",
  "🪦",
  "⚱️",
  "🏺",
  "🔮",
  "🧿",
  "🪬",
  "⚗️",
  "🔭",
  "🔬",
  "💊",
  "💉",
  "🩹",
  "🩺",
  "🧬",
  "🦠",
  "🧪",
  "🌡️",
  "🧹",
  "🧺",
  "🔑",
  "🗝️",
  "🚪",
  "🛋️",
  "🛏️",
  "🛁",
  "🛒",
  "🎁",
  "🎈",
  "🎀",
  "🎊",
  "🎉",
  "✉️",
  "📩",
  "📨",
  "📧",
  "💌",
  "📥",
  "📤",
  "📦",
  "🏷️",
  "🪧",
  "📜",
  "📃",
  "📄",
  "📑",
  "📊",
  "📈",
  "📉",
  "🗒️",
  "🗓️",
  "📆",
  "📅",
  "🗑️",
  "🗃️",
  "📋",
  "📁",
  "📂",
  "🗂️",
  "🗞️",
  "📰",
  "📓",
  "📒",
  "📕",
  "📗",
  "📘",
  "📙",
  "📚",
  "📖",
  "🔖",
  "🔗",
  "📎",
  "📐",
  "📏",
  "🧮",
  "📌",
  "📍",
  "✂️",
  "🖊️",
  "✒️",
  "🖌️",
  "📝",
  "✏️",
  "🔍",
  "🔎",
  "🔒",
  "🔓",
  // Nature, places
  "🌳",
  "🌲",
  "🌴",
  "🌱",
  "🌿",
  "☘️",
  "🍀",
  "🎋",
  "🌾",
  "🌵",
  "🌷",
  "🌸",
  "🌹",
  "🥀",
  "🌺",
  "🌻",
  "🌼",
  "🌎",
  "🌍",
  "🌏",
  "🗺️",
  "🧭",
  "🏔️",
  "⛰️",
  "🌋",
  "🏕️",
  "🏖️",
  "🏜️",
  "🏝️",
  "🏞️",
  "🏛️",
  "🏗️",
  "🧱",
  "🪨",
  "🛖",
  "🏘️",
  "🏠",
  "🏡",
  "🏢",
  "🏥",
  "🏦",
  "🏨",
  "🏪",
  "🏫",
  "🏬",
  "🏭",
  "🏯",
  "🏰",
  "⛪",
  "🗼",
  "🗽",
  "⛲",
  "⛺",
  "🌅",
  "🌆",
  "🌇",
  "🌉",
  "🌁",
  "🌃",
  "🌄",
  // Animals
  "🐶",
  "🐱",
  "🐭",
  "🐹",
  "🐰",
  "🦊",
  "🐻",
  "🐼",
  "🦁",
  "🐮",
  "🐷",
  "🐸",
  "🐵",
  "🙈",
  "🙉",
  "🙊",
  "🐒",
  "🐔",
  "🐧",
  "🐦",
  "🐤",
  "🦆",
  "🦉",
  "🦇",
  "🐺",
  "🐗",
  "🐴",
  "🦄",
  "🐝",
  "🐛",
  "🦋",
  "🐌",
  "🐞",
  "🐜",
  "🕷️",
  "🐢",
  "🐍",
  "🦎",
  "🐙",
  "🦐",
  "🦀",
  "🐠",
  "🐬",
  "🐳",
  "🐊",
  "🦓",
  "🦍",
  "🐘",
  "🦒",
  "🐪",
  "🐎",
  "🐑",
  "🐐",
  "🐕",
  "🐈",
  "🦮",
  "🦝",
  "🦨",
  "🐾",
  // Food & drink
  "🍇",
  "🍉",
  "🍊",
  "🍋",
  "🍌",
  "🍍",
  "🥭",
  "🍎",
  "🍏",
  "🍐",
  "🍑",
  "🍒",
  "🍓",
  "🥝",
  "🍅",
  "🥥",
  "🥑",
  "🍆",
  "🥔",
  "🥕",
  "🌽",
  "🌶️",
  "🥒",
  "🥬",
  "🥦",
  "🧄",
  "🧅",
  "🍄",
  "🥜",
  "🍞",
  "🥐",
  "🥖",
  "🥨",
  "🥯",
  "🥞",
  "🧇",
  "🧀",
  "🍖",
  "🍗",
  "🥩",
  "🥓",
  "🍔",
  "🍟",
  "🍕",
  "🌭",
  "🥪",
  "🌮",
  "🌯",
  "🥙",
  "🥚",
  "🍳",
  "🥘",
  "🍲",
  "🥗",
  "🍿",
  "🧂",
  "🍱",
  "🍙",
  "🍚",
  "🍛",
  "🍜",
  "🍝",
  "🍣",
  "🍤",
  "🍥",
  "🍡",
  "🥟",
  "🍦",
  "🍩",
  "🍪",
  "🎂",
  "🍰",
  "🧁",
  "🥧",
  "🍫",
  "🍬",
  "🍭",
  "🍮",
  "🍯",
  "🍼",
  "🥛",
  "☕",
  "🍵",
  "🍶",
  "🍷",
  "🍸",
  "🍹",
  "🍺",
  "🥂",
  "🥃",
  "🥤",
  "🧊",
  // Activities, sports, music
  "⚽",
  "🏀",
  "🏈",
  "⚾",
  "🎾",
  "🏐",
  "🏓",
  "🥊",
  "🎣",
  "⛳",
  "🎯",
  "🎳",
  "🎮",
  "🎲",
  "🧩",
  "🎬",
  "🎤",
  "🎧",
  "🎼",
  "🎹",
  "🎸",
  "🥁",
  "🎷",
  "🎺",
  "🎻",
  "🏆",
  "🥇",
  "🥈",
  "🥉",
  "🏅",
  "🎫",
  "🎟️",
  "🎭",
  "🎨",
  // Travel
  "🚗",
  "🚕",
  "🚌",
  "🏎️",
  "🚓",
  "🚑",
  "🚒",
  "🚚",
  "🚜",
  "🛴",
  "🚲",
  "🏍️",
  "✈️",
  "🚀",
  "🛸",
  "🚁",
  "⛵",
  "🚤",
  "🚢",
  "⚓",
  "⛽",
  "🚧",
  "🚦",
  "🗺️",
  "🗿",
  // Time, weather
  "🌑",
  "🌒",
  "🌓",
  "🌔",
  "🌕",
  "🌖",
  "🌗",
  "🌘",
  "🌙",
  "🪐",
  "⚡",
  "🌪️",
  "🌫️",
  // Misc symbols & flags-ish
  "✅",
  "❌",
  "⛔",
  "🚫",
  "✔️",
  "☑️",
  "✖️",
  "➕",
  "➖",
  "➗",
  "✳️",
  "❇️",
  "💢",
  "♻️",
  "☮️",
  "✝️",
  "☪️",
  "🕉️",
  "☸️",
  "✡️",
  "🔯",
  "☯️",
  "☦️",
  "⚛️",
  "🕎",
  "🛐",
  "♈",
  "♉",
  "♊",
  "♋",
  "♌",
  "♍",
  "♎",
  "♏",
  "♐",
  "♑",
  "♒",
  "♓",
  "⛎",
  "🆗",
  "🆒",
  "🆕",
  "🆓",
  "🆙",
  "🆖",
  "🆘",
  "🔴",
  "🟠",
  "🟡",
  "🟢",
  "🔵",
  "🟣",
  "⚫",
  "⚪",
  "🟤",
  "🔺",
  "🔻",
  "🔶",
  "🔷",
  "🔸",
  "🔹",
] as const;

// FORK 2026-05-24 (second pass) — bug task-mpjhzu3j-ma9ts. The first
// pass invented a separate 2-word generator (COOKIE_ADJECTIVES /
// COOKIE_NOUNS) — that was a hallucinated requirement; the existing
// FORTUNE_COOKIES pool (200+ long poetic greetings with emojis) is
// what the user wanted all along. randomFortune() above is the only
// mint site now. The 2-word generator + its helpers have been
// deleted. See bible session-naming.md for the contract.
//
// looksLikeLegacy2WordPhrase is kept for ONE purpose: migrating
// sessions whose cookiePhrase was set by the server-side lazy-mint
// during the first pass. When loadSessions sees a stored phrase
// that matches the 2-word shape, it re-mints a long fortune and
// patches the server. Once all legacy entries have flushed, this
// helper has no remaining purpose — safe to delete after a week or
// two of normal use.
const LEGACY_2WORD_PHRASE_RE = /^[a-z]+ [a-z]+( \d{2})?$/;
function looksLikeLegacy2WordPhrase(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return LEGACY_2WORD_PHRASE_RE.test(value.trim());
}

// FORK: Per-tab state isolation — each tab has its own chat state.
// The globals (messages, sending, etc.) are always the "active tab's" working copy.
// switchToTab does atomic save/load swap via saveCurrentTabState/loadTabState.
interface TabState {
  messages: unknown[];
  streamMsgIdx: number;
  streamRunId: string | null;
  lastDeltaLen: number;
  /** FORK 2026-05-09 (Feature C): timestamp of the last delta for gap detection. */
  lastDeltaAt: number;
  sending: boolean;
  currentTurnNumber: number;
  expandedTools: Set<string>;
  draft: string;
}

const tabStates = new Map<string, TabState>();

function freshTabState(): TabState {
  return {
    messages: [],
    streamMsgIdx: -1,
    streamRunId: null,
    lastDeltaLen: 0,
    lastDeltaAt: 0,
    sending: false,
    currentTurnNumber: 0,
    expandedTools: new Set(),
    draft: "",
  };
}

/** Save current globals into the active tab's TabState. */
function saveCurrentTabState() {
  if (!activeTabId) {
    return;
  }
  const s = tabStates.get(activeTabId) ?? freshTabState();
  // FORK 2026-05-16: snapshot the array, don't alias it. Previously
  // `s.messages = messages` stored the SAME array reference the live globals
  // use; a background tab's stream events (which push/splice the live
  // `messages`) then mutated the saved state of OTHER tabs, so switching tabs
  // showed corrupted/empty history. A shallow copy per save isolates each
  // tab's transcript (message objects are treated as immutable once pushed).
  s.messages = (messages as unknown[]).slice();
  s.streamMsgIdx = streamMsgIdx;
  s.streamRunId = streamRunId;
  s.lastDeltaLen = lastDeltaLen;
  s.lastDeltaAt = lastDeltaAt;
  s.sending = sending;
  s.currentTurnNumber = currentTurnNumber;
  s.expandedTools = expandedTools;
  const ta = $("chat-textarea") as HTMLTextAreaElement | null;
  if (ta) {
    s.draft = ta.value;
    // FORK 2026-06-06: write-through the unsent draft to its per-tab
    // localStorage slot so it survives a hard refresh regardless of which
    // tab is active at refresh time.
    saveDraftFor(activeTabId, ta.value);
  }
  tabStates.set(activeTabId, s);
}

/** Load a tab's TabState into the globals. */
function loadTabState(tabId: string) {
  const s = tabStates.get(tabId) ?? freshTabState();
  // FORK 2026-05-16: hand the globals a fresh array so the stored snapshot
  // stays frozen while this tab streams. Pairs with the slice-on-save above —
  // together they guarantee no two tabs ever share a messages array.
  messages = (s.messages as unknown[]).slice();
  streamMsgIdx = s.streamMsgIdx;
  streamRunId = s.streamRunId;
  lastDeltaLen = s.lastDeltaLen;
  lastDeltaAt = s.lastDeltaAt;
  sending = s.sending;
  currentTurnNumber = s.currentTurnNumber;
  expandedTools = s.expandedTools;
  const ta = $("chat-textarea") as HTMLTextAreaElement | null;
  if (ta) {
    ta.value = s.draft;
    ta.dispatchEvent(new Event("input")); // trigger auto-resize
  }
  tabStates.set(tabId, s);
}

// FORK: Session keys may be short ("tinker:xxx") or canonical ("agent:main:tinker:xxx").
// Used as fallback in event filters during the window between chat.send and canonicalization.
function sessionKeyMatches(evtKey: string | undefined | null, refKey?: string): boolean {
  const ref = refKey ?? sessionKey;
  if (!evtKey || !ref) {
    return false;
  }
  if (evtKey === ref) {
    return true;
  }
  return evtKey.endsWith(":" + ref) || ref.endsWith(":" + evtKey);
}

// ─── FORK 2026-05-16: single source of truth for "is this run / session busy" ───
// Before this, FOUR panels each computed "busy" differently (chat indicator
// filtered activeRuns by the viewed sessionKey; the `sending` pill was a
// tab-global boolean; the sessions panel scanned per-session; prefrontal used
// the gateway extension tree unfiltered). During any long turn they disagreed
// — chat stuck on "sending", prefrontal "idle", sessions "thinking". Every
// consumer now routes through these helpers so the answer is consistent and
// the session/all toggle is always honored.

/** True if this run belongs to the tab the user is currently viewing — either
 *  its sessionKey matches the viewed key (short or canonical form) or it is a
 *  subagent descendant of the viewed session. */
function runBelongsToViewedSession(info: ActiveRunInfo): boolean {
  const sk = info.sessionKey ?? "";
  if (!sk) {
    return false;
  }
  if (sessionKeyMatches(sk)) {
    return true;
  }
  return (
    sk.includes(":subagent:") &&
    !!sessionKey &&
    sk.startsWith(sessionKey.replace(/:main$/, "") + ":subagent:")
  );
}

// FORK 2026-05-30: a chat event whose sessionKey is a subagent OF the viewed
// session. sessionKeyMatches() is intentionally strict (it returns false for
// ":subagent:" descendants), so the onEvent chat guard used to drop these and
// the colored sub-bubble renderer (_subagentId) was dead code. This predicate
// re-admits them so a subagent's thinking streams into the parent chat live.
function chatEventIsSubagentOfView(evtKey?: unknown): boolean {
  if (typeof evtKey !== "string" || !sessionKey) {
    return false;
  }
  return (
    evtKey.includes(":subagent:") &&
    evtKey.startsWith(sessionKey.replace(/:main$/, "") + ":subagent:")
  );
}

// FORK 2026-05-30: per-subagent streaming bubbles in the PARENT chat. Each subagent
// run owns its OWN _temporary bubble (keyed by runId) tagged with _subagentId, so the
// renderer paints it with colorForSubagent + a "▸ label" badge and PARALLEL subagents
// never clobber each other or the single-stream main-run state. On final/end the
// bubble is frozen (drop _temporary) so it persists in the transcript.
const subagentStreamIdx = new Map<string, number>();
// FORK 2026-05-30: which subagent bubbles are expanded (collapsed by default). The
// colored "▸ label" header is always shown (the live roster); the thinking body is
// behind a <details> the user expands. Persisted here so it survives the per-delta
// innerHTML rebuild in updateChat.
const expandedSubagents = new Set<string>();

function subagentLabelFor(runId: string, sk: string): string {
  const info = activeRuns.get(runId);
  if (info?.model) {
    return modelName(info.model);
  }
  return shortSubagentId(sk || runId);
}

function handleSubagentChatEvent(p: {
  runId?: unknown;
  sessionKey?: unknown;
  state?: unknown;
  message?: { content?: Array<{ text?: string }> };
}): void {
  const runId = typeof p.runId === "string" ? p.runId : "";
  if (!runId) {
    return;
  }
  const sk = typeof p.sessionKey === "string" ? p.sessionKey : "";
  const text = p.message?.content?.[0]?.text ?? "";
  if (p.state === "delta") {
    if (!text) {
      return;
    }
    const existing = subagentStreamIdx.get(runId);
    const live =
      existing !== undefined &&
      !!messages[existing] &&
      (messages[existing] as Record<string, unknown>)._temporary === true &&
      (messages[existing] as Record<string, unknown>)._subagentId === runId;
    if (!live) {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
        _temporary: true,
        _bubbleStartedAt: Date.now(),
      });
      const idx = messages.length - 1;
      const m = messages[idx] as Record<string, unknown>;
      m._subagentId = runId;
      m._subagentLabel = subagentLabelFor(runId, sk);
      subagentStreamIdx.set(runId, idx);
    } else {
      const block = (messages[existing].content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === "text",
      );
      if (block) {
        block.text = text; // server-cumulative text for this run
      }
    }
    updateChat();
  } else if (
    p.state === "final" ||
    p.state === "end" ||
    p.state === "error" ||
    p.state === "aborted"
  ) {
    const idx = subagentStreamIdx.get(runId);
    if (idx !== undefined && (messages[idx] as Record<string, unknown>)?._subagentId === runId) {
      if (text) {
        const block = (messages[idx].content as Array<{ type: string; text?: string }>).find(
          (b) => b.type === "text",
        );
        if (block) {
          block.text = text;
        }
      }
      // Freeze: keep the bubble + its tag, drop _temporary so it survives the next
      // `messages.filter(m => !m._temporary)` purge and persists in the transcript.
      delete (messages[idx] as Record<string, unknown>)._temporary;
    }
    subagentStreamIdx.delete(runId);
    updateChat();
  }
}

/** activeRuns entries in scope of the session/all toggle: when "session", only
 *  runs for the viewed tab's session; when "all", every run. The ONE place the
 *  budgetScope filter is applied — model count, prefrontal tree, and the
 *  thinking indicator all consume this so they can never disagree. */
function scopedActiveRuns(): Array<[string, ActiveRunInfo]> {
  const out: Array<[string, ActiveRunInfo]> = [];
  for (const entry of activeRuns) {
    if (budgetScope === "session" && !runBelongsToViewedSession(entry[1])) {
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Is the tab the user is viewing busy right now? Independent of other tabs'
 *  runs — the multi-tab "sending forever" bug was the global `activeRuns.size`
 *  check staying non-zero because a DIFFERENT tab still had a run. */
function viewedSessionBusy(): boolean {
  for (const [, info] of activeRuns) {
    if (runBelongsToViewedSession(info)) {
      return true;
    }
  }
  return false;
}

// FORK 2026-05-17: the ONE place `budgetScope` is mutated (bible panels.md
// §147 #18 — one canonical scope concept). Both scope switches — Models
// (#budget-scope-toggle) and Prefrontal (#prefrontal-scope-toggle) — are
// views of this single state. Before this the prefrontal switch had NO
// click handler (dead control) and the Models handler never re-rendered
// prefrontal, so the panel ignored the toggle and went stale. The setter
// syncs BOTH switches' chrome and re-renders BOTH panels so they can never
// disagree and neither toggle is dead.
const SCOPE_TOGGLE_IDS = [
  "budget-scope-toggle",
  "prefrontal-scope-toggle",
  "amygdala-scope-toggle",
];
function syncScopeToggleChrome(): void {
  for (const id of SCOPE_TOGGLE_IDS) {
    const toggle = document.getElementById(id);
    if (!toggle) {
      continue;
    }
    toggle
      .querySelector(".ct-switch-track")
      ?.classList.toggle("ct-switch-track--on", budgetScope === "all");
    toggle.querySelectorAll(".ct-switch-label").forEach((b) => {
      b.classList.toggle(
        "ct-switch-label--active",
        (b as HTMLElement).dataset.scope === budgetScope,
      );
    });
  }
}
function setBudgetScope(next: "session" | "all"): void {
  if (next !== "session" && next !== "all") {
    return;
  }
  budgetScope = next;
  syncScopeToggleChrome();
  updateBudgetPanel();
  updatePrefrontalTree();
  if (budgetScope === "all") void fetchAmygdalaAll();
  else renderAmygdalaPanel();
}

let tabs: Tab[] = [];
// FORK (2026-04-21): initialize from localStorage so a hard refresh preserves
// focus on whichever tab was active pre-reload. Previously defaulted to "" and
// the connect handler fell through to "tab-main", losing sub-session focus.
let activeTabId = (() => {
  try {
    return localStorage.getItem("tinker-active-tab") || "";
  } catch {
    return "";
  }
})();
const TAB_STORAGE_KEY = "tinker-tabs";
const ACTIVE_TAB_STORAGE_KEY = "tinker-active-tab";
const TAB_TITLE_INTERVAL = 5;
// FORK 2026-06-04 — jarvis-upgrade task-mpzcjw6n-n45zs (Tab name summary): the sentinel icon
// prefixed to AUTO-summarized tab names so they're visually distinct from fortune-cookie names
// (zen/nature emoji), "🏠 Main" and "❤️ Heartbeat". Single-sourced here so it's trivially
// swappable. Manual renames keep whatever the user types; auto-naming (periodic + the right-click
// "Auto-name" action) both flow through generateTabTitle and get this prefix.
const AUTO_NAME_ICON = "🏷️";
let tabContextMenuEl: HTMLElement | null = null;

function saveActiveTabId(): void {
  try {
    if (activeTabId) {
      localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTabId);
    }
  } catch {
    // Private-mode / quota errors — silent fail; refresh falls back to tab-main.
  }
}

function generateTabId(): string {
  return "tab-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function saveTabs() {
  try {
    // FORK (2026-04-21): persist tab-main too. Previously filtered out, which meant
    // `/clear`-rotated main-tab sessionKeys were lost on hard reset (gateway restart or
    // browser refresh), causing the connect handshake's `defs.mainSessionKey` default
    // to restore yesterday's agent:main:main session instead of the user's fresh
    // tinker:* continuation.
    localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(tabs));
  } catch {}
}

function loadTabs() {
  try {
    const stored = JSON.parse(localStorage.getItem(TAB_STORAGE_KEY) || "[]") as Tab[];
    // FORK (2026-04-21): force-restore tab-main's title to "🏠 Main" on every load.
    // The old v1/v2 fortune-migration heuristic that used to stomp short titles was
    // removed — it was intentionally stomping good Ollama-generated titles like
    // "🔧 Fix auth bug" (short + emoji-prefixed by design), destroying tab-title
    // persistence for every tinker:* session on gateway restart / hard refresh.
    // v1/v2 migrations are months old at this point; any stale titles can be cleared
    // manually by closing and reopening the tab.
    let changed = false;
    for (const tab of stored) {
      if (tab.id === "tab-main" && tab.title !== "🏠 Main") {
        tab.title = "🏠 Main";
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(stored));
    }
    return stored;
  } catch {
    return [];
  }
}

// FORK 2026-06-10 — u3-tab-naming: persist a DELIBERATE (manual rename or auto-name) tab title to
// the server session store via sessions.patch, so the name is durable across ANY restart, browser,
// or device — not just this browser's localStorage. cookiePhraseUserSet=true tells the gateway's
// lazy-mint to never overwrite it with a random fortune cookie. Fire-and-forget; the next
// sessions.list surfaces it back as the session's cookiePhrase.
function persistTabNameToServer(tab: Tab) {
  if (!tab.sessionKey || !tab.isAttached || tab.id === "tab-main") return;
  const title = tab.title?.trim();
  if (!title) return;
  req("sessions.patch", {
    key: tab.sessionKey,
    cookiePhrase: title,
    cookiePhraseUserSet: true,
  }).catch(() => {});
}

const $ = (id: string) => document.getElementById(id);
const app = $("app")!;

// ─── Provider Colors ───
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#D97757",
  "claude-code": "#D97757", // FORK: cc-bridge runs Claude models; reuse Anthropic orange
  google: "#16a34a",
  openai: "#6b7280",
  ollama: "#ca8a04",
  meta: "#0668E1",
  mistral: "#f97316",
  deepseek: "#4f8ff7",
};

// FORK 2026-05-30: colorForSubagent / shortSubagentId / SUBAGENT_PALETTE moved to
// ./subagent-color.ts (imported at the top of this file) so the RECIPES panel and
// the thinking-rows import the SAME color function as the chat sub-bubbles. Before
// this they were local to app.ts and unused by the panel — which is exactly why
// panel/thinking-row colors (provider-based) never matched the bubble colors.

// API cost per MTok [input, output] by model short name
const MODEL_COST: Record<string, [number, number]> = {
  // Anthropic (source: platform.claude.com/docs/en/docs/about-claude/models)
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
  // OpenAI (source: developers.openai.com/api/docs/pricing)
  "gpt-5.4-pro": [30, 180],
  "gpt-5.4": [2.5, 15],
  "gpt-5.2-pro": [21, 168],
  "gpt-5.2": [1.75, 14],
  "gpt-5.1": [1.25, 10],
  "gpt-4.1": [2, 8],
  "gpt-4o": [2.5, 10],
  o3: [2, 8],
  "o4-mini": [1.1, 4.4],
  // Gemini (source: ai.google.dev/pricing)
  "gemini-3.1-pro-preview": [2, 12],
  "gemini-3-flash-preview": [0.5, 3],
  "gemini-2.5-pro": [1.25, 10],
  "gemini-2.5-flash": [0.3, 2.5],
  "gemini-2.0-flash": [0.1, 0.4],
  "gemini-2.0-flash-lite": [0.075, 0.3],
};

// ─── Provider Icons (14px inline SVGs) ───
const ANTHROPIC_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24"><polygon points="12,1 13.5,8.3 19.8,4.2 15.7,10.5 23,12 15.7,13.5 19.8,19.8 13.5,15.7 12,23 10.5,15.7 4.2,19.8 8.3,13.5 1,12 8.3,10.5 4.2,4.2 10.5,8.3" fill="#D97757"/></svg>`;
const PROVIDER_ICONS: Record<string, string> = {
  anthropic: ANTHROPIC_ICON_SVG,
  // FORK: cc-bridge talks to the same Claude models through the claude CLI;
  // show the Anthropic asterisk so the model panel + thinking indicator
  // read as "Opus (Anthropic)" instead of an anonymous grey dot.
  "claude-code": ANTHROPIC_ICON_SVG,
  google: `<svg width="14" height="14" viewBox="0 0 48 48"><path d="M43.6 20.5H42V20H24v8h11.3C33.6 33.4 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" fill="#FFC107"/><path d="M6.3 14.7l6.6 4.8C14.5 15.9 18.9 13 24 13c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" fill="#FF3D00"/><path d="M24 44c5.2 0 9.9-1.9 13.5-5l-6.2-5.3c-2 1.5-4.5 2.3-7.3 2.3-5.2 0-9.6-3.5-11.2-8.2l-6.5 5C9.5 39.6 16.2 44 24 44z" fill="#4CAF50"/><path d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4 5.7l6.2 5.3C37 39.4 44 34 44 24c0-1.2-.1-2.3-.4-3.5z" fill="#1976D2"/></svg>`,
  openai: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M22.28 9.37a5.88 5.88 0 0 0-.51-4.86 5.97 5.97 0 0 0-6.43-2.83A5.9 5.9 0 0 0 10.87 0a5.97 5.97 0 0 0-5.69 4.13 5.88 5.88 0 0 0-3.93 2.85 5.97 5.97 0 0 0 .74 6.99 5.88 5.88 0 0 0 .51 4.86 5.97 5.97 0 0 0 6.43 2.83A5.9 5.9 0 0 0 13.4 24a5.97 5.97 0 0 0 5.69-4.13 5.88 5.88 0 0 0 3.93-2.85 5.97 5.97 0 0 0-.74-6.99zM13.4 22.3a4.42 4.42 0 0 1-2.84-1.03l.14-.08 4.72-2.73a.77.77 0 0 0 .39-.67v-6.66l2 1.15a.07.07 0 0 1 .04.06v5.52a4.46 4.46 0 0 1-4.46 4.44zM3.48 18.2a4.42 4.42 0 0 1-.53-2.97l.14.08 4.72 2.73a.77.77 0 0 0 .77 0l5.76-3.33v2.31a.07.07 0 0 1-.03.06l-4.77 2.76a4.46 4.46 0 0 1-6.06-1.64zM2.2 7.87A4.42 4.42 0 0 1 4.52 5.9v5.62a.77.77 0 0 0 .39.67l5.76 3.33-2 1.15a.07.07 0 0 1-.07 0L3.83 13.9A4.46 4.46 0 0 1 2.2 7.87zm17.33 4.03l-5.76-3.33 2-1.15a.07.07 0 0 1 .07 0l4.77 2.76a4.46 4.46 0 0 1-.69 8.05v-5.66a.77.77 0 0 0-.39-.67zM21.5 9.7l-.14-.08-4.72-2.73a.77.77 0 0 0-.77 0L10.1 10.2V7.9a.07.07 0 0 1 .03-.06l4.77-2.76a4.46 4.46 0 0 1 6.6 4.62zM8.93 13.34l-2-1.15a.07.07 0 0 1-.04-.06V6.61a4.46 4.46 0 0 1 7.3-3.42l-.14.08-4.72 2.73a.77.77 0 0 0-.39.67zm1.08-2.34L12 9.77l1.99 1.15v2.3L12 14.36l-1.99-1.15z" fill="#10a37f"/></svg>`,
  ollama: `<svg width="14" height="14" viewBox="0 0 24 24"><text x="3" y="17" font-size="14" font-weight="bold" fill="#ca8a04">O</text></svg>`,
  meta: `<svg width="14" height="14" viewBox="0 0 24 24"><path d="M4 12c0-3 1.5-6 4-6s4 3 4 6-1.5 6-4 6-4-3-4-6zm8 0c0-3 1.5-6 4-6s4 3 4 6-1.5 6-4 6-4-3-4-6z" stroke="#0668E1" stroke-width="2" fill="none"/></svg>`,
  mistral: `<svg width="14" height="14" viewBox="0 0 24 24"><rect x="2" y="3" width="5" height="5" fill="#f97316"/><rect x="10" y="3" width="5" height="5" fill="#f97316"/><rect x="17" y="3" width="5" height="5" fill="#f97316"/><rect x="2" y="10" width="5" height="5" fill="#f97316"/><rect x="10" y="10" width="5" height="5" fill="#f97316"/><rect x="2" y="17" width="5" height="5" fill="#f97316"/><rect x="17" y="17" width="5" height="5" fill="#f97316"/></svg>`,
  deepseek: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="#4f8ff7" stroke-width="2" fill="none"/><path d="M8 12l3 3 5-6" stroke="#4f8ff7" stroke-width="2" fill="none"/></svg>`,
};

function providerIcon(provider: string): string {
  if (PROVIDER_ICONS[provider]) {
    return `<span class="model-provider-icon">${PROVIDER_ICONS[provider]}</span>`;
  }
  const color = PROVIDER_COLORS[provider] || "#6b7280";
  return `<span class="model-provider-dot" style="background:${color}"></span>`;
}

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) {
      return i;
    }
  }
  return -1;
}

// ─── Persisted Error Messages ───
const ERROR_STORAGE_KEY = "tinker-errors";

function persistErrorMsg(sk: string, msg: unknown) {
  try {
    const all = JSON.parse(localStorage.getItem(ERROR_STORAGE_KEY) || "{}");
    if (!all[sk]) {
      all[sk] = [];
    }
    all[sk].push(msg);
    localStorage.setItem(ERROR_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota exceeded */
  }
}

function loadPersistedErrors(sk: string): unknown[] {
  try {
    const all = JSON.parse(localStorage.getItem(ERROR_STORAGE_KEY) || "{}");
    return all[sk] || [];
  } catch {
    return [];
  }
}

function clearPersistedErrors(sk: string) {
  try {
    const all = JSON.parse(localStorage.getItem(ERROR_STORAGE_KEY) || "{}");
    delete all[sk];
    localStorage.setItem(ERROR_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

// ─── Active Model Tracking ───
type ActiveRunPhase = "thinking" | "tool" | "responding" | "reflecting" | "completed" | "failed";
type ActiveRunInfo = {
  model: string;
  provider: string;
  authProfileId?: string;
  startedAt: number;
  // FORK 2026-05-14: timestamp of the most recent WS event for this run.
  // Bumped on every `agent`/`chat` event whose runId or sessionKey matches.
  // The stale-run watchdog compares against THIS, not startedAt — otherwise
  // long cc-bridge tool chains (which routinely exceed 5min total elapsed
  // but never sit silent >25s thanks to the heartbeat) get force-cleared
  // mid-turn and the thinking indicator vanishes while the server is still
  // working. See tool-loop.md (cc-bridge tool-loop divergence) for why
  // total-elapsed timeouts tuned to anthropic provider cadence are wrong
  // for cc-bridge.
  lastEventAt: number;
  sessionKey?: string;
  phase: ActiveRunPhase;
  currentTool?: string;
  state?: "restarting";
  // FORK 2026-05-31: per-run task text ("what this run is doing"), surfaced as the
  // subagent sub-line in the fallback tree. Populated from the "start" lifecycle
  // event when it carries a task/label (the global "all"-scope orchestration view
  // gets task from the richer extension tree broadcast instead).
  task?: string;
  // FORK 2026-06-11 (tinkerui-effort): reasoning-effort vitals fed from the
  // `effort` stream. thinkLevel = requested level string ('' / 'off' = Auto);
  // configuredBudget = requested MAX_THINKING_TOKENS cap in tokens (0 = Auto =
  // model decides, NOT '0 tok'); thinkingChars = ACTUAL reasoning emitted (CHARS,
  // never tokens); hadRealThinking = saw any non-redacted reasoning; redacted =
  // the provider redacted the reasoning. The phase==='final' summary additionally
  // carries outputTokens/numTurns. pendingThinkLevel records a think-level change
  // requested mid-flight (requested vs the level actually running).
  thinkLevel?: string;
  configuredBudget?: number;
  thinkingChars?: number;
  hadRealThinking?: boolean;
  redacted?: boolean;
  outputTokens?: number;
  numTurns?: number;
  pendingThinkLevel?: { requested?: string; running?: string };
};
const activeRuns = new Map<string, ActiveRunInfo>();

// FORK 2026-04-20: Prefrontal dashboard state. Three slices:
// - latestTreeFromExtension: last `prefrontal-tree` WS event from the extension.
//   When present, it's the canonical source of the tree (has labels, progress,
//   per-node summaries). When absent, we fall back to activeRuns synthesis.
// - currentRecipe: last `prefrontal-recipe-state` WS event.
// - prefrontalTrail: full append-only ring of TrailEvent items (synthesized
//   from lifecycle + explicit trail RPC). The panel renders all of them with
//   scroll; we only clamp to an absurd maximum to avoid unbounded memory on
//   long-running sessions.
// FORK 2026-05-13: added currentPlan — last `prefrontal-plan-state` WS event
// (null when no active plan; set to null when plan.close fires).
const PREFRONTAL_TRAIL_HARD_MAX = 500;
let latestTreeFromExtension: TreeResponse | null = null;
let latestTreeFromExtensionAt = 0;
let currentRecipe: RecipeState | null = null;
let currentPlan: PanelPlan | null = null; // FORK 2026-05-13
const prefrontalTrail: TrailEvent[] = [];
function pushTrail(evt: TrailEvent) {
  prefrontalTrail.push(evt);
  if (prefrontalTrail.length > PREFRONTAL_TRAIL_HARD_MAX) {
    prefrontalTrail.splice(0, prefrontalTrail.length - PREFRONTAL_TRAIL_HARD_MAX);
  }
}
const providerErrors = new Map<string, { error: string; reason: string; ts: number }>();
const PROVIDER_ERRORS_STORAGE_KEY = "tinker-providerErrors";

function persistProviderErrors() {
  try {
    const obj: Record<string, { error: string; reason: string; ts: number }> = {};
    for (const [k, v] of providerErrors) {
      obj[k] = v;
    }
    localStorage.setItem(PROVIDER_ERRORS_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

function restoreProviderErrors() {
  try {
    const raw = localStorage.getItem(PROVIDER_ERRORS_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const obj = JSON.parse(raw) as Record<string, { error: string; reason: string; ts: number }>;
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      // Discard errors older than 2 hours
      if (v.ts && now - v.ts < 2 * 60 * 60 * 1000) {
        providerErrors.set(k, v);
      }
    }
  } catch {
    /* ignore */
  }
}
// FORK 2026-06-13 (eeg): panel sections are now 'models' (parity with the old
// 'configured' default-collapsed) and 'eeg' (open by default — absent here).
const collapsedModelSections = new Set<string>(["models"]);
// FORK 2026-06-13 (eeg): one seismograph store per session plus a per-session
// end-of-turn counter feeding the turn markers. Keyed by the event's FULL
// session key so tab switches repaint the right session's paper.
const eegStores = new Map<string, EegTraceStore>();
const eegTurnCounters = new Map<string, number>();
// FORK 2026-06-13 (eeg): billed INPUT tokens accumulated per runId across the
// run's rounds (round-start carries inputTokensEstimate; effort-final carries
// output). Feeds segment length (area ∝ token cost, bible §5.8h).
const eegInputByRun = new Map<string, number>();
// FORK 2026-06-13 (eeg): persist the trace to localStorage so a HARD REFRESH (which
// wipes the in-memory store) restores the session's activity instead of erasing it
// (Oscar 2026-06-13). Keyed per session; capped so storage stays bounded.
const EEG_STORAGE_PREFIX = "tinker-eeg:";
const EEG_PERSIST_CAP = 2000;
function loadEegStoreFromStorage(sk: string, store: EegTraceStore): void {
  try {
    const raw = localStorage.getItem(EEG_STORAGE_PREFIX + sk);
    if (!raw) {
      return;
    }
    const snap = JSON.parse(raw) as { samples?: EegSample[]; ends?: EegTurnEnd[] };
    if (Array.isArray(snap.samples)) {
      store.backfill(snap.samples, Array.isArray(snap.ends) ? snap.ends : []);
    }
  } catch {
    /* corrupt/oversized payload — ignore, fall back to live + anatomy backfill */
  }
}
function saveEegStore(sk: string): void {
  try {
    const snap = getEegStore(sk).toSnapshot();
    localStorage.setItem(
      EEG_STORAGE_PREFIX + sk,
      JSON.stringify({
        samples: snap.samples.slice(-EEG_PERSIST_CAP),
        ends: snap.ends.slice(-EEG_PERSIST_CAP),
      }),
    );
  } catch {
    /* quota exceeded or serialization issue — non-fatal */
  }
}
function getEegStore(sk: string): EegTraceStore {
  let store = eegStores.get(sk);
  if (!store) {
    store = new EegTraceStore();
    eegStores.set(sk, store);
    // rehydrate from the previous session before any live event lands
    loadEegStoreFromStorage(sk, store);
  }
  return store;
}
// FORK 2026-06-13 (eeg): re-render the seismograph SVG at the live pixel width
// of its host so it fills the whole panel (Oscar 2026-06-13). Called after every
// panel render and on window resize.
let eegResizeBound = false;
// FORK 2026-06-13 (eeg): vertical SCALE for the seismograph length axis, driven
// by the secondary(right)-button wheel. 1 = native token→px scale.
let eegZoom = 1;
function fillEegPaper(): void {
  const paper = document.getElementById("eeg-paper");
  if (!paper || !sessionKey) {
    return;
  }
  const w = Math.max(120, Math.floor(paper.clientWidth) || 280);
  // preserve the scroll position proportionally across a re-render/zoom
  const prevH = paper.scrollHeight || 1;
  const ratio = paper.scrollTop / prevH;
  paper.innerHTML = getEegStore(sessionKey).renderSvg({ width: w, zoom: eegZoom });
  paper.scrollTop = ratio * (paper.scrollHeight || 1);
}
const ACTIVE_RUNS_STORAGE_KEY = "tinker-activeRuns";
// FORK 2026-06-06 (bug: unsent draft lost on hard refresh) — drafts are now
// persisted PER TAB. The old single global key `tinker-draft` meant a hard
// refresh (which wipes the in-memory tabStates Map) restored at most ONE
// draft and all tabs shared it. We now key by tab id: `tinker-draft:<tabId>`.
const DRAFT_STORAGE_KEY_PREFIX = "tinker-draft:";
/** localStorage key holding the unsent composer draft for a given tab. */
function draftStorageKey(tabId: string): string {
  return DRAFT_STORAGE_KEY_PREFIX + tabId;
}
/** Read a tab's persisted unsent draft ("" if none). */
function loadDraftFor(tabId: string): string {
  try {
    return localStorage.getItem(draftStorageKey(tabId)) || "";
  } catch {
    return "";
  }
}
/** Write-through a tab's unsent draft to localStorage (or remove it when empty). */
function saveDraftFor(tabId: string, value: string): void {
  try {
    if (value) {
      localStorage.setItem(draftStorageKey(tabId), value);
    } else {
      localStorage.removeItem(draftStorageKey(tabId));
    }
  } catch {
    /* quota / disabled storage — ignore */
  }
}
// FORK 2026-06-07 — recent-drafts ring: a capped backup of drafts so a cleared/sent draft (or one
// about to be lost to a crash/close) stays recoverable. Inspect via localStorage["tinker-draft-history"].
const DRAFT_HISTORY_KEY = "tinker-draft-history";
const DRAFT_HISTORY_MAX = 30;
function archiveDraft(tabId: string, text: string): void {
  if (!text || !text.trim()) return;
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_HISTORY_KEY) || "[]");
    const arr = Array.isArray(parsed) ? parsed : [];
    if (arr.length && arr[arr.length - 1]?.text === text) return; // dedup consecutive
    arr.push({ tabId, text, ts: Date.now() });
    while (arr.length > DRAFT_HISTORY_MAX) arr.shift();
    localStorage.setItem(DRAFT_HISTORY_KEY, JSON.stringify(arr));
  } catch {
    /* quota / disabled storage — ignore */
  }
}
// FORK 2026-06-07 — task-editor draft persistence. An HMR auto-refresh (an agent touching ANY
// UI file) reloads the page and wipes an in-progress inline task edit. Persist each field per
// (taskId, field) to localStorage, seed the editor on open, clear on a confirmed save, and
// auto-reopen the pending edit after a refresh — same idea as the chat composer draft.
const TASK_DRAFT_PREFIX = "tinker-taskdraft:";
function taskDraftKey(taskId: string, field: string): string {
  return `${TASK_DRAFT_PREFIX}${taskId}:${field}`;
}
function saveTaskDraft(taskId: string, field: string, value: string): void {
  try {
    if (value && value.length) localStorage.setItem(taskDraftKey(taskId, field), value);
    else localStorage.removeItem(taskDraftKey(taskId, field));
  } catch {
    /* ignore */
  }
}
function loadTaskDraft(taskId: string, field: string): string | null {
  try {
    return localStorage.getItem(taskDraftKey(taskId, field));
  } catch {
    return null;
  }
}
function clearTaskDraft(taskId: string, field: string): void {
  try {
    localStorage.removeItem(taskDraftKey(taskId, field));
  } catch {
    /* ignore */
  }
}
/** The single most-recent pending task-edit draft (one in-flight edit is the common case), or null. */
function pendingTaskDraft(): { taskId: string; field: string; value: string } | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(TASK_DRAFT_PREFIX)) continue;
      const rest = k.slice(TASK_DRAFT_PREFIX.length);
      const idx = rest.lastIndexOf(":");
      if (idx <= 0) continue;
      return {
        taskId: rest.slice(0, idx),
        field: rest.slice(idx + 1),
        value: localStorage.getItem(k) || "",
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}
// One delegated listener persists EVERY keystroke in the inline task-name (.exec-task-title-edit)
// and task-description (.exec-task-context-edit) editors — both carry dataset.taskId — so an HMR
// refresh can never lose an in-progress task edit. (Seed-on-open + auto-reopen live in the editors
// and loadExecTasks below.)
document.addEventListener(
  "input",
  (ev) => {
    const el = ev.target as HTMLElement | null;
    const tid = (el as HTMLInputElement | HTMLTextAreaElement | null)?.dataset?.taskId;
    if (!el || !tid) return;
    if (el.classList.contains("exec-task-title-edit"))
      saveTaskDraft(tid, "text", (el as HTMLInputElement).value);
    else if (el.classList.contains("exec-task-context-edit"))
      saveTaskDraft(tid, "context", (el as HTMLTextAreaElement).value);
  },
  true,
);
/** Clear a tab's persisted draft. ONLY call on a CONFIRMED send — a failed send MUST keep the draft.
 *  Archives the cleared text into the recent-drafts ring first, so even a sent draft stays recoverable. */
function clearDraftFor(tabId: string): void {
  try {
    const cur = localStorage.getItem(draftStorageKey(tabId));
    if (cur) archiveDraft(tabId, cur);
    localStorage.removeItem(draftStorageKey(tabId));
  } catch {
    /* ignore */
  }
}
// Runs restored from sessionStorage that haven't been confirmed by a lifecycle event yet
const unconfirmedRuns = new Set<string>();
// Pending delayed deletes for activeRuns — cancelled when a fallback model re-uses the same runId
const pendingRunDeletes = new Map<string, ReturnType<typeof setTimeout>>();
// FORK: Timer handle for the 30s restart prune; cleared on rapid restarts.
let restartPruneTimer: ReturnType<typeof setTimeout> | null = null;

function saveActiveRuns() {
  try {
    const entries = Array.from(activeRuns.entries());
    sessionStorage.setItem(ACTIVE_RUNS_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* quota exceeded — ignore */
  }
}

function restoreActiveRuns() {
  try {
    const raw = sessionStorage.getItem(ACTIVE_RUNS_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const entries: [string, ActiveRunInfo][] = JSON.parse(raw);
    for (const [id, info] of entries) {
      // FORK 2026-05-14: backfill lastEventAt for entries written by older
      // builds (the field was added after this storage key shipped). Treat
      // restore time as "last event" so the watchdog gives the run a fresh
      // window to confirm itself via a real lifecycle event.
      if (typeof info.lastEventAt !== "number") {
        info.lastEventAt = info.startedAt ?? Date.now();
      }
      activeRuns.set(id, info);
      unconfirmedRuns.add(id);
    }
  } catch {
    /* parse error — ignore */
  }
}

/** After reconnect, clear restored runs that no lifecycle event confirmed. */
function scheduleUnconfirmedPrune() {
  if (unconfirmedRuns.size === 0) {
    return;
  }
  // FORK: split — normal unconfirmed runs get 5s, restarting runs get 30s.
  const normalIds: string[] = [];
  const restartIds: string[] = [];
  for (const id of unconfirmedRuns) {
    const info = activeRuns.get(id);
    if (info?.state === "restarting") {
      restartIds.push(id);
    } else {
      normalIds.push(id);
    }
  }
  if (normalIds.length > 0) {
    setTimeout(() => {
      let changed = false;
      for (const id of normalIds) {
        if (unconfirmedRuns.has(id)) {
          activeRuns.delete(id);
          unconfirmedRuns.delete(id);
          changed = true;
        }
      }
      if (changed) {
        saveActiveRuns();
        // FORK 2026-05-16: sending tracks the VIEWED tab, not the global map.
        // (Was `if (activeRuns.size === 0)` which stayed true whenever any
        // OTHER tab still had a run — the multi-tab "sending forever" bug.)
        sending = viewedSessionBusy();
        updateBudgetPanel();
        updatePrefrontalTree();
        updateChat();
        updateBtn();
      }
    }, 5000);
  }
  if (restartIds.length > 0) {
    if (restartPruneTimer) {
      clearTimeout(restartPruneTimer);
    }
    restartPruneTimer = setTimeout(() => {
      restartPruneTimer = null;
      let changed = false;
      for (const id of restartIds) {
        if (unconfirmedRuns.has(id)) {
          activeRuns.delete(id);
          unconfirmedRuns.delete(id);
          changed = true;
        }
      }
      if (changed) {
        saveActiveRuns();
        sending = viewedSessionBusy(); // FORK 2026-05-16: per-viewed-tab, not global map size
        updateBudgetPanel();
        updatePrefrontalTree();
        updateChat();
        updateBtn();
      }
    }, 30000);
  }
}

// Restore on load
restoreActiveRuns();

function getAuthKeyCounts(forModel?: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [, info] of scopedActiveRuns()) {
    if (forModel && info.model !== forModel) {
      continue;
    }
    const key = info.authProfileId || info.model;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// FORK: Check if a session has active LLM runs (for session-live glow)
function sessionHasActiveRuns(sessionKey: string): { live: boolean; provider?: string } {
  for (const info of activeRuns.values()) {
    if (info.sessionKey && sessionKeyMatches(info.sessionKey, sessionKey)) {
      return { live: true, provider: info.provider };
    }
  }
  return { live: false };
}

let modelConfigData: unknown = null;

// FORK 2026-04-20: Build the Prefrontal dashboard state (tree + recipe +
// trail) and push it to the panel controller. Tree source of truth is the
// extension's `prefrontal-tree` broadcast when we've seen one recently (that
// feed has labels, progress, summaries). Falls back to synthesizing from the
// local activeRuns map for the first paint before an extension event arrives.
//
// Called at every point that used to call updatePrefrontalTree (lifecycle
// start/end, tool events, recipe-state events, trail events).
const PREFRONTAL_EXT_TREE_TTL_MS = 6_000;
function updatePrefrontalTree() {
  if (!prefrontalCtrl) {
    return;
  }

  const tree = buildPrefrontalTree();
  prefrontalCtrl.update({
    tree,
    recipe: currentRecipe,
    trail: prefrontalTrail,
    plan: currentPlan, // FORK 2026-05-13
  } satisfies PrefrontalDashboardState);
  // FORK 2026-06-11 (tinkerui-effort): refresh the ?pfdebug truth grid in lockstep
  // with the panel so the raw effort vitals stay in sync with the rendered chip.
  updatePfDebugGrid();
}

// FORK 2026-06-11 (tinkerui-effort) — ?pfdebug=1 (or __pf.enable()) TRUTH GRID.
// Renders one row per active run from `activeRuns` with the HONEST effort columns
// so we can audit the chip against the raw stream: runId · sessionKey · thinkLevel
// · requested budget (cap) · actual thinking (chars) · hadRealThinking · redacted ·
// output_tokens · num_turns · pending(requested→running). HONEST headers — the
// budget column is the REQUESTED cap, the thinking column is ACTUAL chars (never
// tokens). A configuredBudget of 0 renders as the thinkLevel word ('Auto'/'off'),
// NOT '0 tok'. Redacted rows show '[redacted]' for the thinking cell with
// hadRealThinking forced false. Gated entirely on PF_DEBUG_STATE.debug; the grid
// DOM element is created lazily and removed when debug is off.
function updatePfDebugGrid(): void {
  const existing = document.getElementById("pf-debug-grid");
  if (!PF_DEBUG_STATE.debug) {
    existing?.remove();
    return;
  }
  let grid = existing as HTMLElement | null;
  if (!grid) {
    grid = document.createElement("div");
    grid.id = "pf-debug-grid";
    grid.style.cssText =
      "position:fixed;bottom:8px;right:8px;z-index:99999;max-width:min(96vw,920px);" +
      "max-height:42vh;overflow:auto;background:rgba(12,10,8,0.94);color:#e8d4b0;" +
      "border:1px solid rgba(193,154,107,0.45);border-radius:8px;padding:6px 8px;" +
      "font:11px/1.35 ui-monospace,'Courier New',monospace;box-shadow:0 2px 12px rgba(0,0,0,0.5)";
    document.body.appendChild(grid);
  }
  const esc = (s: string): string =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
    );
  const cols = [
    "runId",
    "sessionKey",
    "thinkLevel",
    "requested budget (cap)",
    "actual thinking (chars)",
    "hadRealThinking",
    "redacted",
    "output_tokens",
    "num_turns",
    "pending(req→run)",
  ];
  const rows: string[] = [];
  for (const [runId, info] of activeRuns.entries()) {
    const lvl = !info.thinkLevel || info.thinkLevel === "off" ? "Auto" : info.thinkLevel;
    // configuredBudget 0 -> show the level word ('Auto'/'off'), NOT '0 tok'.
    const cap =
      info.configuredBudget && info.configuredBudget > 0
        ? `${Math.round(info.configuredBudget / 1000)}k tok`
        : info.thinkLevel && info.thinkLevel !== ""
          ? info.thinkLevel
          : "Auto";
    const redacted = info.redacted === true;
    const had = redacted ? false : info.hadRealThinking === true;
    const thinkCell = redacted
      ? "[redacted]"
      : info.thinkingChars != null
        ? String(info.thinkingChars)
        : "-";
    const pend = info.pendingThinkLevel
      ? `${info.pendingThinkLevel.requested ?? "?"}→${info.pendingThinkLevel.running ?? "?"}`
      : "-";
    const cells = [
      runId.slice(0, 8),
      info.sessionKey ?? "-",
      lvl,
      cap,
      thinkCell,
      String(had),
      String(redacted),
      info.outputTokens != null ? String(info.outputTokens) : "-",
      info.numTurns != null ? String(info.numTurns) : "-",
      pend,
    ];
    rows.push(
      "<tr>" +
        cells.map((c) => `<td style="padding:1px 6px;white-space:nowrap">${esc(c)}</td>`).join("") +
        "</tr>",
    );
  }
  const head =
    "<tr>" +
    cols
      .map(
        (c) =>
          `<th style="padding:1px 6px;text-align:left;color:#e8cc93;white-space:nowrap">${esc(c)}</th>`,
      )
      .join("") +
    "</tr>";
  const body =
    rows.length > 0
      ? rows.join("")
      : `<tr><td colspan="${cols.length}" style="padding:3px 6px;color:#b8a593;font-style:italic">no active runs</td></tr>`;
  grid.innerHTML =
    '<div style="color:#d4a574;font-weight:700;margin-bottom:3px">PF effort truth grid (?pfdebug)</div>' +
    `<table style="border-collapse:collapse"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function buildPrefrontalTree(): TreeResponse {
  PF_DEBUG_STATE.renderCount++;
  // Prefer the extension's tree if recent — but ONLY in "all" scope. The
  // extension tree is the gateway's GLOBAL orchestration view; it carries no
  // per-session filter, so returning it under "session" scope was the exact
  // bug where prefrontal ignored the session/all toggle and disagreed with
  // every other panel (FORK 2026-05-16). Under "session" scope we always
  // build from the scoped activeRuns fallback below so the toggle is
  // authoritative.
  if (
    budgetScope === "all" &&
    latestTreeFromExtension &&
    Date.now() - latestTreeFromExtensionAt < PREFRONTAL_EXT_TREE_TTL_MS &&
    latestTreeFromExtension.active &&
    // FORK 2026-05-30 ("Prefrontal rethink" stuck bug): the extension tree is the
    // GLOBAL view and keeps broadcasting active:true until the extension clears
    // its active-main marker (which lags, or never fires if agent_end is missed).
    // chat.final/aborted is authoritative and empties activeRuns immediately, so
    // if THIS client knows of zero running runs, the panel must go idle in sync
    // with every other indicator instead of showing a frozen-clock "thinking".
    activeRuns.size > 0
  ) {
    if (PF_DEBUG_STATE.lastRenderSource !== "extension") {
      PF_DEBUG_STATE.lastRenderSource = "extension";
      pfLog(`render source → extension (age=${Date.now() - latestTreeFromExtensionAt}ms)`);
    }
    return latestTreeFromExtension;
  }
  if (PF_DEBUG_STATE.lastRenderSource !== "fallback") {
    PF_DEBUG_STATE.lastRenderSource = "fallback";
    pfLog(
      `render source → fallback (activeRuns=${activeRuns.size}, extensionTreeAge=${latestTreeFromExtension ? Date.now() - latestTreeFromExtensionAt : "none"}ms)`,
    );
  }

  // Collect active runs (respecting the session/all toggle via the one
  // shared scope helper — same set the model count + indicator use).
  const runs: Array<{ runId: string; info: ActiveRunInfo }> = scopedActiveRuns().map(
    ([runId, info]) => ({ runId, info }),
  );

  if (runs.length === 0) {
    return { active: false, root: null };
  }

  // FORK 2026-05-17 (bible panels.md §115/§147): group runs by their owning
  // session so "all" scope cleanly shows WHICH session is doing WHAT.
  // Subagents nest under their session. A single session (always the case
  // under "session" scope) renders exactly as before — that session's run as
  // root with its subagents as children, zero regression. Multiple top-level
  // sessions (only possible under "all") render as a per-session forest under
  // a synthetic "All sessions" root, instead of one arbitrary session
  // silently winning the single root slot and the rest vanishing.
  const owningSessionKey = (sk: string): string => {
    const m = sk.match(/^(.*?)(?::subagent:|:acp:)/);
    return m ? m[1] : sk;
  };
  const shortSessionLabel = (sk: string): string => {
    const parts = sk.split(":");
    const ci = parts.indexOf("cron");
    if (ci >= 0) {
      return `cron · ${parts[ci + 1] ?? "job"}`;
    }
    return parts[parts.length - 1] || sk;
  };
  const isSubagentKey = (sk: unknown): boolean =>
    typeof sk === "string" && (sk.includes(":subagent:") || sk.includes(":acp:"));
  const toNode = (runId: string, info: ActiveRunInfo, label?: string): TreeNode => ({
    runId,
    model: info.model,
    provider: info.provider,
    label: label ?? info.authProfileId ?? info.model,
    status: info.currentTool ? `tool: ${info.currentTool}` : info.phase,
    progress: 0,
    lastEventAge: Math.floor((Date.now() - info.startedAt) / 1000),
    // FORK 2026-05-31: surface the run's task as the subagent sub-line when known.
    ...(info.task ? { summary: info.task } : {}),
    // FORK 2026-06-11 (tinkerui-effort): carry the reasoning-effort vitals onto the
    // node so renderVitals draws the effort chip (HONEST: requested cap + actual
    // think chars, never a fabricated token count).
    ...(info.thinkLevel != null ? { thinkLevel: info.thinkLevel } : {}),
    ...(info.configuredBudget != null ? { configuredBudget: info.configuredBudget } : {}),
    ...(info.thinkingChars != null ? { thinkingChars: info.thinkingChars } : {}),
    ...(info.hadRealThinking != null ? { hadRealThinking: info.hadRealThinking } : {}),
    children: [],
  });

  const bySession = new Map<string, Array<{ runId: string; info: ActiveRunInfo }>>();
  for (const { runId, info } of runs) {
    const sk = typeof info.sessionKey === "string" ? info.sessionKey : runId;
    const owner = owningSessionKey(sk);
    let group = bySession.get(owner);
    if (!group) {
      group = [];
      bySession.set(owner, group);
    }
    group.push({ runId, info });
  }

  const multiSession = bySession.size > 1;
  const sessionNodes: TreeNode[] = [];
  for (const [owner, group] of bySession) {
    const mainRun = group.find((g) => !isSubagentKey(g.info.sessionKey)) ?? group[0];
    const sessNode = toNode(
      mainRun.runId,
      mainRun.info,
      multiSession ? shortSessionLabel(owner) : undefined,
    );
    sessNode.children = group.filter((g) => g !== mainRun).map((g) => toNode(g.runId, g.info));
    sessionNodes.push(sessNode);
  }

  if (sessionNodes.length === 0) {
    return { active: false, root: null };
  }
  if (sessionNodes.length === 1) {
    return { active: true, root: sessionNodes[0] };
  }
  // Multiple sessions active (only reachable under "all" scope): per-session
  // forest so the user sees which session is doing what.
  return {
    active: true,
    root: {
      runId: "all-sessions",
      model: "all",
      provider: sessionNodes[0].provider,
      label: `All sessions (${sessionNodes.length})`,
      status: "orchestrating",
      progress: 0,
      lastEventAge: 0,
      children: sessionNodes,
    },
  };
}

// ─── Recipe Progress (Prefrontal v3.0) ───
// FORK: Shows active recipe progress below the call tree panel.
function updateRecipeProgress(data: unknown) {
  const container = document.getElementById("recipe-progress");
  if (!container) {
    return;
  }

  if (!data || !data.recipeId) {
    container.style.display = "none";
    return;
  }

  container.style.display = "block";
  const completed = (data.completedSteps as string[]) ?? [];
  const total = (data.totalSteps as number) ?? 0;
  const elapsed = Math.floor(((data.elapsedMs as number) ?? 0) / 1000);

  let html = `<div class="rp-panel">`;
  html += `<div class="rp-header"><span class="rp-name">${data.recipeName}</span>`;
  html += `<span class="rp-elapsed">${elapsed}s</span></div>`;
  html += `<div class="rp-steps">`;

  // We don't have step names in the event — use the IDs available
  // The progress data sends currentStep + completedSteps
  if (data.currentStep) {
    // Render a compact step indicator
    for (let i = 0; i < total; i++) {
      const isDone = i < completed.length;
      const isCurrent = i === completed.length;
      const cls = isDone ? "rp-step rp-done" : isCurrent ? "rp-step rp-current" : "rp-step";
      const icon = isDone ? "\u2713" : isCurrent ? "\u2192" : "\u00b7";
      html += `<span class="${cls}">${icon}</span>`;
    }
  }

  html += `</div>`;
  html += `<div class="rp-counter">${completed.length}/${total} steps</div>`;
  html += `</div>`;

  container.innerHTML = html;
}

// Inject recipe progress styles
{
  const rpStyle = document.createElement("style");
  rpStyle.id = "recipe-progress-styles";
  rpStyle.textContent = `
    .recipe-progress-container { padding: 0 0.5rem; }
    .rp-panel { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 0.5rem 0.65rem; margin-bottom: 0.5rem; }
    .rp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem; }
    .rp-name { color: #c9d1d9; font-size: 0.72rem; font-weight: 600; }
    .rp-elapsed { color: #484f58; font-size: 0.65rem; }
    .rp-steps { display: flex; gap: 0.3rem; align-items: center; margin-bottom: 0.25rem; }
    .rp-step { width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 0.65rem; border: 1px solid rgba(255,255,255,0.1); color: #484f58; }
    .rp-step.rp-done { color: #3fb950; border-color: #3fb950; }
    .rp-step.rp-current { color: #58a6ff; border-color: #58a6ff; background: rgba(88,166,255,0.1); }
    .rp-counter { color: #484f58; font-size: 0.62rem; text-align: right; }
  `;
  document.head.appendChild(rpStyle);
}

// FORK 2026-06-06 — u2-tab-naming: subtle "renaming in progress" shimmer. While an auto-name's
// async LLM call is running we keep the tab's CURRENT title (icon + words) visible and gently
// pulse it, rather than swapping in a placeholder. The keyframe lives here (injected from JS, no
// separate CSS file) and is toggled via the .tab-renaming class on the tab element.
{
  const tnStyle = document.createElement("style");
  tnStyle.id = "tab-renaming-styles";
  tnStyle.textContent = `
    @keyframes tab-rename-pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
    .tab.tab-renaming .tab-title { animation: tab-rename-pulse 1.1s ease-in-out infinite; }
  `;
  document.head.appendChild(tnStyle);
}

// FORK 2026-06-06 — u2-tab-naming: tab-icon helpers (relevance + uniqueness).
// Match a single leading emoji (the convention is "<emoji> <words>" for every named tab).
const LEADING_EMOJI_RE = /^(\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*)/u;

function leadingEmoji(title: string): string | null {
  const m = (title || "").trim().match(LEADING_EMOJI_RE);
  return m ? m[1] : null;
}

// Icons already used as the leading emoji of some OTHER tab — so a freshly generated title can
// avoid duplicating them. `exceptTabId` is the tab being renamed (its own current icon is fine).
function inUseTabIcons(exceptTabId: string): Set<string> {
  const used = new Set<string>();
  for (const t of tabs) {
    if (t.id === exceptTabId) continue;
    const e = leadingEmoji(t.title);
    if (e) used.add(e);
  }
  return used;
}

// Keyword → emoji map (all values exist in EMOJI_CATALOG). Used when the LLM returns no emoji, to
// derive one RELEVANT to the summary text before falling back to the AUTO_NAME_ICON sentinel.
const SUMMARY_EMOJI_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(bug|fix|error|crash|broken|debug)\b/i, "🐛"],
  [/\b(test|spec|qa|coverage)\b/i, "🧪"],
  [/\b(build|compile|bundle|deploy|ship|release)\b/i, "🏗️"],
  [/\b(refactor|cleanup|clean up|tidy|rewrite)\b/i, "🧹"],
  [/\b(config|setting|option|env|environment)\b/i, "⚙️"],
  [/\b(auth|login|token|password|secret|credential|security|secure)\b/i, "🔒"],
  [/\b(api|endpoint|request|http|fetch|server|gateway)\b/i, "📡"],
  [/\b(database|db|sql|query|schema|store|storage)\b/i, "🗃️"],
  [/\b(ui|css|style|design|layout|theme|frontend|button|panel)\b/i, "🎨"],
  [/\b(doc|docs|documentation|readme|note|notes|write[- ]?up)\b/i, "📝"],
  [/\b(paper|research|study|analysis|analyse|analyze)\b/i, "📚"],
  [/\b(idea|brainstorm|plan|design|propose|proposal)\b/i, "💡"],
  [/\b(data|stat|stats|metric|metrics|chart|graph)\b/i, "📊"],
  [/\b(money|cost|price|pay|invoice|loan|budget|finance)\b/i, "💰"],
  [/\b(email|mail|message|reply|inbox|outbound)\b/i, "✉️"],
  [/\b(search|find|lookup|locate)\b/i, "🔍"],
  [/\b(ai|model|llm|neural|brain|cognit|agent)\b/i, "🧠"],
  [/\b(tool|tooling|script|automation|cron|pipeline)\b/i, "🔧"],
  [/\b(file|files|folder|upload|download|attach)\b/i, "📁"],
  [/\b(time|schedule|calendar|deadline|date)\b/i, "🗓️"],
  [/\b(home|house|main|workshop)\b/i, "🏠"],
];

function summaryToEmoji(text: string): string | null {
  for (const [re, emoji] of SUMMARY_EMOJI_RULES) {
    if (re.test(text)) return emoji;
  }
  return null;
}

// Pick a leading icon for an auto-named tab: prefer `preferred`, then a summary-derived emoji,
// then the AUTO_NAME_ICON sentinel — but never one already in use by another tab. If the first
// choice collides, walk EMOJI_CATALOG for the next free emoji so all tab icons stay distinct.
function pickUniqueTabIcon(preferred: string | null, summary: string, exceptTabId: string): string {
  const used = inUseTabIcons(exceptTabId);
  const candidates: string[] = [];
  if (preferred) candidates.push(preferred);
  const mapped = summaryToEmoji(summary);
  if (mapped) candidates.push(mapped);
  candidates.push(AUTO_NAME_ICON);
  for (const c of candidates) {
    if (c && !used.has(c)) return c;
  }
  for (const c of EMOJI_CATALOG) {
    if (!used.has(c)) return c;
  }
  // Everything's taken (extremely unlikely) — fall back to the preferred/sentinel.
  return preferred || AUTO_NAME_ICON;
}

// ─── Gateway ───
function uuid() {
  return crypto.randomUUID();
}

function gwConnect() {
  ws = new WebSocket(GW_WS);
  ws.addEventListener("message", (ev) => onFrame(JSON.parse(ev.data)));
  ws.addEventListener("close", () => {
    connected = false;
    sending = false;
    streamMsgIdx = -1;
    lastDeltaLen = 0;
    lastDeltaAt = 0;
    streamRunId = null;
    // FORK: Preserve activeRuns during graceful restart (state set by shutdown handler).
    const hasRestartingRuns = [...activeRuns.values()].some((r) => r.state === "restarting");
    if (!hasRestartingRuns) {
      activeRuns.clear();
      saveActiveRuns();
    }
    updateDots();
    updateBtn();
    updateChat();
    setTimeout(gwConnect, 2000);
  });
}

// FORK 2026-06-07 — AMYGDALA live panel: stream gate decisions into the right rail
// (the learned-intuition plugin broadcasts one `amygdala-decision` per tool call).
interface AmygdalaLiveDecision {
  phase?: string;
  ts?: number;
  tool?: string;
  target?: string;
  decision?: string;
  blocked?: boolean;
  enforced?: boolean;
  reason?: string;
  mode?: string;
  prudence?: number;
  disagreement?: number;
}
const amygdalaLive: AmygdalaLiveDecision[] = [];
let amygdalaAll: AmygdalaLiveDecision[] = [];
let amygdalaSelected: number | null = null;
function pushAmygdalaDecision(d: AmygdalaLiveDecision): void {
  amygdalaLive.unshift({ ...d, ts: d.ts ?? Date.now() });
  if (amygdalaLive.length > 100) amygdalaLive.pop();
  if (budgetScope !== "all") renderAmygdalaPanel();
}
async function fetchAmygdalaAll(): Promise<void> {
  try {
    const f = await req<{ decisions?: AmygdalaLiveDecision[] }>("amygdala.feed", {});
    amygdalaAll = f.decisions ?? [];
    // FORK 2026-06-07: seed the live (session) view from the persisted feed on first
    // load, so a UI refresh repopulates instead of showing Idle. Guard on empty to
    // avoid duplicating live events that arrived before this resolved.
    if (!amygdalaLive.length && amygdalaAll.length) amygdalaLive.push(...amygdalaAll);
  } catch {
    /* keep stale */
  }
  renderAmygdalaPanel();
}
function amygdalaVerb(d: AmygdalaLiveDecision): { col: string; verb: string } {
  const col =
    d.enforced || d.decision === "hard_block"
      ? "var(--red)"
      : d.decision === "soft_block"
        ? "#f59e0b"
        : "#4ade80";
  const verb = d.enforced
    ? "BLOCKED"
    : d.decision === "hard_block"
      ? "would block"
      : d.decision === "soft_block"
        ? "would flag"
        : "allowed";
  return { col, verb };
}
function amygdalaDetailHtml(d: AmygdalaLiveDecision): string {
  const { col, verb } = amygdalaVerb(d);
  const isOnnx = d.mode === "onnx";
  const p = typeof d.prudence === "number" ? d.prudence : null;
  const dis = typeof d.disagreement === "number" ? d.disagreement : null;
  const row = (k: string, v: string) =>
    `<div style="display:flex;gap:8px;font-size:10px;line-height:1.5"><span style="color:var(--muted);min-width:70px">${k}</span><span style="font-family:monospace;word-break:break-all">${v}</span></div>`;
  const net =
    isOnnx && p !== null
      ? `<div style="margin-top:6px"><div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Network output</div><div style="position:relative;height:7px;border-radius:4px;background:rgba(255,255,255,0.06);margin:4px 0"><div style="position:absolute;left:0;top:0;height:7px;border-radius:4px;width:${Math.round(p * 100)}%;background:${col}"></div><div title="block threshold 0.90" style="position:absolute;left:90%;top:-2px;width:1px;height:11px;background:var(--red)"></div></div><div style="font-size:9px;color:var(--muted)">prudence p=${p.toFixed(3)} — blocks above 0.90 (red mark)${dis !== null ? ` · ensemble Δ=${dis.toFixed(3)} — flags above 0.30` : ""}</div></div>`
      : `<div style="margin-top:6px;font-size:9px;color:var(--muted);line-height:1.5">Rule-based observe layer — no neural score. The ONNX gate (10 nets &rarr; a prudence score judged against the <b>0.90</b> block threshold and <b>0.30</b> disagreement-flag threshold) runs for native OpenClaw tool calls; cc-bridge / Claude-Code tools are screened here by destructive-pattern heuristics instead.</div>`;
  return `<div style="border-top:1px solid rgba(255,255,255,0.09);margin-top:3px;padding:7px 9px;background:rgba(0,0,0,0.4)"><div style="font-size:10px;color:${col};font-weight:600;margin-bottom:4px">${verb} &middot; ${escapeHtml(d.tool ?? "?")}</div>${row("target", escapeHtml(d.target ?? "&mdash;"))}${row("decision", `${escapeHtml(d.decision ?? "allow")}${d.enforced ? " (enforced)" : d.blocked ? " (observe-only)" : ""}`)}${row("mode", isOnnx ? "onnx (neural gate)" : "rules (heuristic)")}${d.reason ? row("reason", escapeHtml(d.reason)) : ""}${net}</div>`;
}
function renderAmygdalaPanel(): void {
  const body = document.getElementById("amygdala-body");
  if (!body) return;
  const list = budgetScope === "all" ? amygdalaAll : amygdalaLive;
  const count = document.getElementById("amygdala-count");
  if (count) count.textContent = list.length ? String(list.length) : "";
  if (!list.length) {
    body.innerHTML = `<div style="color:var(--muted);font-size:11px;padding:8px">${budgetScope === "all" ? "No gate decisions recorded yet." : "Idle &mdash; gate decisions stream here live as the agent runs tools."}</div>`;
    return;
  }
  if (amygdalaSelected !== null && amygdalaSelected >= list.length) amygdalaSelected = null;
  const rows = list
    .map((d, i) => {
      const { col, verb } = amygdalaVerb(d);
      const t = d.ts ? new Date(d.ts).toLocaleTimeString() : "";
      const full = `${verb} — ${d.tool ?? "?"} ${d.target ?? ""}${d.reason ? " — " + d.reason : ""}`;
      const sel = amygdalaSelected === i;
      const line = `<div class="amy-line" data-i="${i}" title="${escapeHtml(full)}" style="cursor:pointer;border-left:2px solid ${col};padding:2px 7px;font-size:10px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${sel ? "background:rgba(255,255,255,0.06);" : ""}"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${col};margin-right:5px;vertical-align:middle"></span><span style="font-family:monospace">${escapeHtml(d.tool ?? "?")}</span> <span style="color:var(--muted)">${escapeHtml(d.target ?? "")}</span> <span style="color:var(--muted);font-size:9px">${t}</span></div>`;
      return line + (sel ? amygdalaDetailHtml(d) : "");
    })
    .join("");
  body.innerHTML = `<div style="border:1px solid rgba(255,255,255,0.08);border-radius:8px;background:rgba(0,0,0,0.28);overflow:hidden"><div style="max-height:240px;overflow-y:auto">${rows}</div></div>`;
}
// FORK 2026-06-07: click a feed line to toggle its detail (network output + thresholds).
document.addEventListener("click", (ev) => {
  const line = (ev.target as HTMLElement).closest(".amy-line") as HTMLElement | null;
  if (!line) return;
  const host = document.getElementById("amygdala-body");
  if (!host || !host.contains(line)) return;
  const i = Number(line.dataset.i);
  amygdalaSelected = amygdalaSelected === i ? null : i;
  renderAmygdalaPanel();
});

function onFrame(f: unknown) {
  if (f.type === "event") {
    if (f.event === "connect.challenge") {
      req("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "webchat-ui",
          displayName: "Tinker UI",
          version: "0.3",
          platform: "web",
          mode: "webchat",
        },
        role: "operator",
        scopes: ["operator.admin"],
        caps: ["tool-events"],
        auth: { token: TOKEN },
      })
        .then((hello: unknown) => {
          connected = true;
          void fetchAmygdalaAll(); // seed persisted Amygdala feed on connect
          const defs = hello?.snapshot?.sessionDefaults;
          if (defs?.mainSessionKey) {
            sessionKey = defs.mainSessionKey;
          }
          // Initialize tabs (preserve active tab across reconnects)
          const prevActiveTabId = activeTabId;
          const restored = loadTabs();
          // FORK (2026-04-21): prefer restored tab-main (which carries the /clear-
          // rotated sessionKey) over the default-constructed one. If no restored
          // tab-main exists (first load ever, or cleared storage), fall back to a
          // fresh mainTab bound to the gateway-provided default sessionKey.
          const defaultMainTab: Tab = {
            id: "tab-main",
            sessionKey: sessionKey,
            title: "🏠 Main",
            isAttached: true,
          };
          const restoredMain = restored.find((t) => t.id === "tab-main");
          // FORK 2026-05-25 — one-shot migration: tab-main must always be
          // bound to the canonical main key (e.g. `agent:main:main`).
          // Before today's fix to /clear, every /clear rotated tab-main
          // to a fresh `tinker:<ts>`, orphaning the canonical slot and
          // creating duplicate-"🏠 Main" rows in the side panel. Users
          // who hit that path have a stale `tinker:<ts>` persisted in
          // localStorage; force-rebind here so the next sessions.list
          // surfaces a single canonical main row and clicking it
          // focuses tab-main correctly.
          if (
            restoredMain &&
            defs?.mainSessionKey &&
            restoredMain.sessionKey !== defs.mainSessionKey
          ) {
            restoredMain.sessionKey = defs.mainSessionKey;
            restoredMain.isAttached = true;
          }
          const mainTab = restoredMain ?? defaultMainTab;
          const others = restored.filter((t) => t.id !== "tab-main");
          tabs = [mainTab, ...others];
          // FORK: Initialize TabState for main and all restored tabs
          tabStates.set(mainTab.id, freshTabState());
          for (const t of others) {
            if (!tabStates.has(t.id)) {
              tabStates.set(t.id, freshTabState());
            }
          }
          // FORK 2026-06-06 (bug: unsent draft lost on hard refresh) — a hard
          // refresh wiped the in-memory tabStates Map, so freshTabState() seeded
          // every tab with draft="". Re-hydrate each restored tab's TabState.draft
          // from its per-tab localStorage slot so unsent text is not lost.
          for (const t of tabs) {
            const st = tabStates.get(t.id);
            if (st) {
              st.draft = loadDraftFor(t.id);
            }
          }
          // Restore previous active tab if it still exists, otherwise default to main.
          // FORK (2026-04-21): prevActiveTabId comes from localStorage on hard refresh
          // (module-level init above), so the user's pre-refresh sub-session stays focused.
          const prevTabExists = tabs.some((t) => t.id === prevActiveTabId);
          activeTabId = prevTabExists ? prevActiveTabId : "tab-main";
          saveActiveTabId();
          // FORK 2026-06-06 (bug: unsent draft lost on hard refresh) — load the
          // ACTIVE tab's persisted draft into the composer so the textarea shows
          // the saved unsent text after a hard refresh (background tabs keep
          // theirs in TabState.draft, hydrated just above).
          {
            const draftTa = $("chat-textarea") as HTMLTextAreaElement | null;
            if (draftTa) {
              const activeState = tabStates.get(activeTabId);
              draftTa.value = activeState?.draft ?? loadDraftFor(activeTabId);
              draftTa.dispatchEvent(new Event("input")); // auto-resize
            }
          }
          // Restore the session key from the active tab
          const activeTab = tabs.find((t) => t.id === activeTabId);
          if (activeTab?.isAttached && activeTab.sessionKey) {
            sessionKey = activeTab.sessionKey;
          }
          renderTabs();
          updateDots();
          updateBtn();
          loadSessions({ loadChat: true });
          loadBudget();
          refreshTreemap();
          refreshTimelineRespectingMode();
          scheduleUnconfirmedPrune();
          // FORK 2026-06-04 — bug task-mppceqsu-24yex (Tab context loads only on
          // switching tabs): proactively hydrate every restored background tab's
          // transcript so its content is present BEFORE the user clicks it (they used to
          // be empty until switched to). Fire-and-forget, batched via allSettled to avoid
          // a thundering herd of chat.history RPCs when many tabs are open.
          void Promise.allSettled(
            others
              .filter((t) => t.isAttached && t.sessionKey && t.id !== activeTabId)
              .map((t) => hydrateTab(t)),
          );
          req("forensic.setMode", { enabled: true })
            .then((res: unknown) => {
              _forensicMode = res?.enabled ?? true;
            })
            .catch(() => {
              _forensicMode = true;
            });
        })
        .catch((e) => console.error("connect:", e));
      return;
    }
    // FORK: Graceful restart — mark active runs as "restarting" to hold the indicator.
    // Intentionally returns early so onEvent() does not process the shutdown frame.
    if (f.event === "shutdown" && f.payload?.restartExpectedMs != null) {
      if (activeRuns.size > 0) {
        for (const [runId, info] of activeRuns) {
          info.state = "restarting";
          // FORK 2026-05-24 — add the runId to unconfirmedRuns so the
          // post-reconnect scheduleUnconfirmedPrune() at line ~1269 actually
          // schedules its 30s cleanup timer for these restarting runs.
          // Without this enrollment, runs marked "restarting" stayed in
          // activeRuns forever after an in-tab graceful restart: the
          // gateway process that owned them is dead, so no lifecycle:end
          // will ever come; the reconnect-hello path runs scheduleUncon-
          // firmedPrune() unconditionally but it early-returns at
          // `unconfirmedRuns.size === 0`. Symptom (2026-05-24): prefrontal
          // panel showed "claude still running" with a frozen elapsed
          // clock while every other surface reported idle and the server's
          // own `prefrontal.tree` RPC returned `active:false`. Only a page
          // reload (which re-runs restoreActiveRuns and repopulates
          // unconfirmedRuns from sessionStorage) used to clear the ghost.
          // If lifecycle:start for this same runId arrives after reconnect
          // (cc-bridge resume preserves runId), it confirms via
          // unconfirmedRuns.delete(p.runId) — no spurious prune.
          unconfirmedRuns.add(runId);
        }
        saveActiveRuns();
        startThinkingTick();
        updateChat();
      }
      return;
    }
    onEvent(f);
    return;
  }
  if (f.type === "res") {
    const p = pending.get(f.id);
    if (p) {
      pending.delete(f.id);
      if (f.ok) {
        p.resolve(f.payload);
      } else {
        p.reject(f.error);
      }
    }
  }
}

// FORK 2026-05-09 — mirror the rendered chat HTML to a file on the gateway
// host (~/.openclaw/data/tinker-ui-snapshot.html) on every render, so the
// architect-side Claude Code session can debug bubble layout / collapse
// state / classes without a screen share. Calls `debug.dumpUiSnapshot`,
// debounced 300ms. Best-effort; failures are silent.
let _uiSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleUiSnapshotDump(messagesEl: HTMLElement): void {
  if (_uiSnapshotTimer) {
    clearTimeout(_uiSnapshotTimer);
  }
  _uiSnapshotTimer = setTimeout(() => {
    _uiSnapshotTimer = null;
    try {
      // Capture the messages container plus key computed-styles for the LAST
      // user + assistant bubbles, so layout regressions are diagnosable from
      // text alone.
      const lastUser = messagesEl.querySelector(".msg.user:last-of-type");
      const lastAssistant = messagesEl.querySelector(".msg.assistant:last-of-type");
      const computed = (e: Element | null) => {
        if (!e) return null;
        const cs = getComputedStyle(e);
        return {
          alignSelf: cs.alignSelf,
          marginLeft: cs.marginLeft,
          marginRight: cs.marginRight,
          marginBottom: cs.marginBottom,
          width: cs.width,
          maxWidth: cs.maxWidth,
          position: cs.position,
          dataTimestamp: (e as HTMLElement).dataset.timestamp ?? null,
        };
      };
      void req("debug.dumpUiSnapshot", {
        html:
          "<!--SNAPVER:amy-panel-2026-06-07i-->" +
          (document.querySelector(".right-panels")?.outerHTML ?? "<!--NO-RIGHT-PANELS-->") +
          "\n<!--CHAT-AREA-->\n" +
          messagesEl.outerHTML,
        url: location.href,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        computedStyles: {
          lastUserBubble: computed(lastUser),
          lastAssistantBubble: computed(lastAssistant),
          messagesContainer: computed(messagesEl),
        },
      }).catch(() => {});
    } catch {
      /* silent — debug-only */
    }
  }, 300);
}

function req<T = unknown>(method: string, params?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject("disconnected");
    }
    const id = uuid();
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

// ─── Health Poll (replaces 5-min auto-clear) ───
let healthPollInterval: ReturnType<typeof setInterval> | null = null;

function startHealthPoll() {
  if (healthPollInterval) {
    return;
  }
  healthPollInterval = setInterval(async () => {
    if (providerErrors.size === 0) {
      clearInterval(healthPollInterval!);
      healthPollInterval = null;
      return;
    }
    try {
      const res = await req("provider.health", {});
      if (!res?.health) {
        return;
      }
      let changed = false;
      for (const [provider, info] of Object.entries(res.health) as [string, unknown][]) {
        if (info.available) {
          if (providerErrors.has(provider)) {
            providerErrors.delete(provider);
            changed = true;
          }
          // Clear per-profile and per-model errors for this provider
          for (const k of providerErrors.keys()) {
            if (k.startsWith(provider + ":") || k.startsWith(provider + "/")) {
              providerErrors.delete(k);
              changed = true;
            }
          }
        }
      }
      if (changed) {
        persistProviderErrors();
        updateBudgetPanel();
      }
    } catch {
      /* gateway disconnected */
    }
  }, 60_000);
}

/**
 * Find the first sentence-ending position in `text` starting search from `from`.
 * A sentence end is a '.' followed by whitespace, newline, or end-of-string.
 * Returns the index of the '.', or -1 if none found.
 */
function findSentenceEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === ".") {
      const next = text[i + 1];
      // '.' at end of string, or followed by space/newline = sentence boundary
      if (next === undefined || next === " " || next === "\n" || next === "\r") {
        return i;
      }
    }
  }
  return -1;
}

/**
 * After streaming completes, merge sentence continuations back into
 * their predecessor bubbles. If a text bubble starts with a lowercase
 * letter (or mid-sentence punctuation), the text up to the first
 * sentence-ending '.' is appended to the previous assistant text bubble.
 * The remainder (after the '.') stays in the current bubble. If nothing
 * remains, the bubble is removed entirely.
 */
function mergeSentenceContinuations(msgs: unknown[]): void {
  // Only operate on _temporary messages from the current run.
  // Find the range of temporary messages (they're always at the tail).
  let tempStart = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]._temporary) {
      tempStart = i;
    } else if (tempStart >= 0) {
      break;
    } // walked past the temp block
  }
  if (tempStart < 0) {
    return;
  }

  for (let i = tempStart + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m._temporary) {
      continue;
    }
    if ((m.role ?? "").toLowerCase() !== "assistant") {
      continue;
    }
    const content = Array.isArray(m.content) ? m.content : [];
    const textBlock = content.find((b: unknown) => b.type === "text" && (b.text ?? "").trim());
    if (!textBlock) {
      continue;
    }

    const text = textBlock.text as string;
    const trimmed = text.trimStart();
    const firstChar = trimmed.charAt(0);
    // Detect mid-sentence start: lowercase letter or continuation punctuation
    const isLower =
      firstChar !== "" &&
      firstChar === firstChar.toLowerCase() &&
      firstChar !== firstChar.toUpperCase();
    const isMidSentence = isLower || /^[\d,;:.!?)}\]"'…–—-]/.test(trimmed);
    if (!isMidSentence) {
      continue;
    }

    // Find the previous temporary assistant text bubble
    let prevTextBlock: unknown = null;
    for (let k = i - 1; k >= tempStart; k--) {
      const prev = msgs[k];
      if (!prev._temporary) {
        continue;
      }
      if ((prev.role ?? "").toLowerCase() !== "assistant") {
        continue;
      }
      const pc = Array.isArray(prev.content) ? prev.content : [];
      const pt = pc.find((b: unknown) => b.type === "text" && (b.text ?? "").trim());
      if (pt) {
        prevTextBlock = pt;
        break;
      }
    }
    if (!prevTextBlock) {
      continue;
    }

    // Find sentence boundary in the current text
    const dotIdx = findSentenceEnd(text, 0);
    if (dotIdx >= 0) {
      // Merge up to and including the period
      prevTextBlock.text += text.slice(0, dotIdx + 1);
      const remainder = text.slice(dotIdx + 1);
      if (remainder.trim()) {
        textBlock.text = remainder;
      } else {
        // Nothing left — remove this message
        msgs.splice(i, 1);
        i--;
      }
    } else {
      // No period found — merge the entire fragment
      prevTextBlock.text += text;
      msgs.splice(i, 1);
      i--;
    }
  }
}

// FORK 2026-05-14: bump lastEventAt for any activeRun touched by this WS
// event. This was originally added to feed a UI-side stale-run watchdog
// (since deleted — see startThinkingTick docstring). It's STILL useful for
// driving the prefrontal panel's "lastEventAge" display (how long since
// any event on this run, useful for spotting genuine hangs without
// force-clearing anything). Match by runId first (canonical), fall back
// to sessionKey for events that omit runId (lifecycle round events, some
// tool events). Runs from other clients / other sessions are left untouched.
function bumpActiveRunActivity(payload: { runId?: unknown; sessionKey?: unknown }): void {
  if (!payload) return;
  const now = Date.now();
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  if (runId) {
    const info = activeRuns.get(runId);
    if (info) {
      info.lastEventAt = now;
      return;
    }
  }
  const evtKey = typeof payload.sessionKey === "string" ? payload.sessionKey : null;
  if (evtKey) {
    for (const info of activeRuns.values()) {
      if (info.sessionKey && sessionKeyMatches(info.sessionKey, evtKey)) {
        info.lastEventAt = now;
      }
    }
  }
}

function onEvent(evt: unknown) {
  if (evt.event === "chat") {
    const p = evt.payload;
    // FORK 2026-05-30: admit chat events from subagents OF the viewed session so a
    // subagent's thinking streams into the parent chat in real time. Before, the
    // strict guard below dropped every ":subagent:" delta (sessionKeyMatches=false
    // for descendants), so subagent progress was invisible and "looked stuck".
    const isViewedMain = p.sessionKey === sessionKey || sessionKeyMatches(p.sessionKey);
    const isViewedSubagent = !isViewedMain && chatEventIsSubagentOfView(p.sessionKey);
    if (!isViewedMain && !isViewedSubagent) {
      // FORK 2026-06-08 — bug "queued prompts stick forever": this chat event is for a session the
      // user is NOT currently viewing, so the handler below (including the queue flush) is skipped.
      // But if THIS event says that session's turn just ended, we must still drop any prompts queued
      // under it — otherwise they stay "queued" forever (the old global queue was only ever drained
      // by the viewed session's own final). We do NOT splice into the live transcript here (that is
      // a different tab); loadChat re-fetches the authoritative server history when that tab opens.
      if (p.state === "final" || p.state === "error" || p.state === "aborted") {
        const settled = settleQueuedSession(
          pendingQueuedSends,
          p.sessionKey,
          false,
          sessionKeyMatches,
        );
        if (settled.remaining.length !== pendingQueuedSends.length) {
          pendingQueuedSends = settled.remaining;
          updateChat();
        }
      }
      return;
    }
    bumpActiveRunActivity(p);
    // Subagent chat events take their OWN per-run tagged-bubble path and never fall
    // through to the single-stream main-run logic below (which assumes one stream).
    if (isViewedSubagent) {
      handleSubagentChatEvent(p);
      return;
    }
    if (p.state === "delta") {
      if (!streamRunId) {
        streamProvider = "";
        streamProfileId = "";
      }
      streamRunId = p.runId;
      // Update active run phase based on streaming content
      let runInfo = activeRuns.get(p.runId);
      if (!runInfo) {
        // FORK 2026-06-04 — bug task-mpr2cego-unkak (Disappearing chat thinking indicator).
        // A text delta is arriving for the VIEWED main session (guaranteed by the guard at
        // the top of this handler) but there is NO activeRuns entry — the run was emptied
        // prematurely (a stray/early lifecycle:end, the 3s debounce racing a slow next
        // delta, or a runId we never saw a phase:start for) while Jarvis is demonstrably
        // still emitting. A delta is authoritative proof the run is ALIVE, so SELF-HEAL:
        // re-create a minimal entry and resume the tick. This follows done-signals.md R1
        // (an authoritative live signal supersedes an advisory/debounced "done") and does
        // NOT violate R2 (no UI stale-run watchdog): we only ever ADD a run on positive
        // evidence of life, never force-clear one on a timer. The matching lifecycle:end /
        // chat.final for this same runId still clears it normally.
        const pendingTimeout = pendingRunDeletes.get(p.runId);
        if (pendingTimeout) {
          clearTimeout(pendingTimeout);
          pendingRunDeletes.delete(p.runId);
        }
        runInfo = {
          model: "",
          provider: streamProvider || "",
          authProfileId: streamProfileId || undefined,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : sessionKey || undefined,
          phase: "responding",
        };
        activeRuns.set(p.runId, runInfo);
        sending = true;
        saveActiveRuns();
        startThinkingTick();
        updatePrefrontalTree();
      }
      if (runInfo) {
        const txt = p.message?.content?.[0]?.text ?? "";
        const isFractal =
          txt.trimStart().startsWith("🌿 FRACTAL:") || txt.includes("# FRACTAL REFLECTION");
        const newPhase: ActiveRunPhase = isFractal ? "reflecting" : "responding";
        if (runInfo.phase !== newPhase) {
          runInfo.phase = newPhase;
          runInfo.currentTool = undefined;
          updatePrefrontalTree();
        }
      }
      // FORK: Un-queue any queued user messages — LLM absorbed them via steer
      for (const m of messages) {
        if (m._queued) {
          delete m._queued;
        }
      }
      const deltaText = p.message?.content?.[0]?.text ?? "";
      // FORK 2026-05-25 (task-mpkw1a0b-9jsfy "Response rendering"):
      // diagnostic for the duplicate-sentence bug. deltaText is the
      // SERVER-CUMULATIVE text for the current run, NOT a per-delta
      // increment. Logging its length and tail lets us see whether the
      // duplicate exists at the bytes the server sent (tail.includes
      // a chunk that's also earlier in deltaText), or whether the
      // duplication appears only after client-side slicing into
      // multiple bubbles. Tag "[duprep-ui]" for grep, throttle to one
      // log per ~500ms to avoid spam.
      if (
        deltaText &&
        (typeof (window as Record<string, unknown>).__duprepLastLogAt !== "number" ||
          Date.now() - ((window as Record<string, unknown>).__duprepLastLogAt as number) > 500)
      ) {
        (window as Record<string, unknown>).__duprepLastLogAt = Date.now();
        const flat = deltaText.replace(/\n/g, "↵");
        const tail = flat.length > 80 ? flat.slice(-80) : flat;
        // eslint-disable-next-line no-console
        console.log(
          `[duprep-ui] deltaText runId=${p.runId ?? "?"} cumulative.len=${deltaText.length} bubbles=${messages.filter((m: unknown) => (m as Record<string, unknown>)._temporary).length} tail=${JSON.stringify(tail)}`,
        );
      }
      if (deltaText) {
        // FORK 2026-05-09 (Feature C, revised): detect >5s gap between deltas
        // and split the streaming bubble. The bubble keeps `_temporary` so
        // tail-recover can re-slice its content from the server-authoritative
        // text using its own `_segmentStart` cursor — no global frozenTextEnd,
        // no clobbering between concurrent freezes (tool + gap).
        const nowDelta = Date.now();
        const gapMs = lastDeltaAt > 0 ? nowDelta - lastDeltaAt : 0;
        const currentBubbleHasContent =
          streamMsgIdx >= 0 &&
          !!messages[streamMsgIdx]?._temporary &&
          (() => {
            const tb = (
              messages[streamMsgIdx].content as Array<{ type: string; text?: string }>
            )?.find?.((b) => b.type === "text");
            return typeof tb?.text === "string" && tb.text.length > 0;
          })();
        if (gapMs > 5000 && currentBubbleHasContent) {
          // Stamp the gap-bubble's end time and detach it from streamMsgIdx so
          // the next delta opens a new bubble. Bubble stays _temporary; the
          // tail-recover at final time will re-slice its content from the
          // authoritative finalText using its `_segmentStart`.
          const gapBubble = messages[streamMsgIdx] as Record<string, unknown>;
          gapBubble._bubbleEndedAt = lastDeltaAt;
          streamMsgIdx = -1;
        }
        // Capture cumulative offset BEFORE updating lastDeltaLen so the new
        // bubble (if we create one) records where it begins.
        const segmentStart = lastDeltaLen;
        lastDeltaLen = deltaText.length;
        lastDeltaAt = nowDelta;
        if (streamMsgIdx >= 0 && messages[streamMsgIdx]?._temporary) {
          // Append to existing bubble. Slice from this bubble's _segmentStart.
          const bubble = messages[streamMsgIdx] as Record<string, unknown>;
          const start = (bubble._segmentStart as number | undefined) ?? 0;
          const segmentText = deltaText.slice(start);
          const content = messages[streamMsgIdx].content;
          const textBlock = content.find((b: unknown) => b.type === "text");
          if (textBlock) {
            textBlock.text = segmentText;
          }
        } else {
          // Create a new bubble. Its _segmentStart is the cumulative offset
          // captured before this delta updated lastDeltaLen — i.e. where the
          // previous bubble (if any) ended in the cumulative stream.
          const segmentText = deltaText.slice(segmentStart);
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: segmentText }],
            _temporary: true,
            _bubbleStartedAt: nowDelta,
            _segmentStart: segmentStart,
          });
          streamMsgIdx = messages.length - 1;
        }
      }
      updateChat();
    } else if (p.state === "final" || p.state === "error" || p.state === "aborted") {
      // FORK 2026-06-04 — bug task-mpwfiot2 (Queuing a prompt): the running turn ended, so any
      // prompts queued during it now take their correct chronological place at the END of the
      // transcript (matching the server's history order — the position a hard refresh always
      // showed correctly). Flush the held bubbles into messages[] as normal user messages. They
      // were kept OUT of messages[] until now so the turn's own continuation/tool bubbles could
      // never land after them ("queued prompt in the middle of the last answer").
      if (pendingQueuedSends.length > 0) {
        // FORK 2026-06-08: flush ONLY the prompts queued under the session whose turn just ended
        // (= the viewed session here, since we are past the viewed-session guard). Other tabs'
        // queued prompts stay put — previously this drained the WHOLE global array into whichever
        // tab was on screen, dumping one session's queued prompt into another's transcript.
        const settled = settleQueuedSession(
          pendingQueuedSends,
          p.sessionKey,
          true,
          sessionKeyMatches,
        );
        for (const qm of settled.commit) {
          messages.push(qm);
        }
        pendingQueuedSends = settled.remaining;
      }
      // Defensive: clear any _queued styling that slipped into messages[] directly.
      for (const m of messages) {
        if (m._queued) {
          delete m._queued;
        }
      }
      // FORK 2026-06-11 — discard the live reasoning bubble for this run on turn
      // end. The final answer (or its reconciled bubbles) supersedes the
      // cumulative reasoning preview; leaving it would double-render the thinking.
      messages = messages.filter(
        (m) => !((m as any)._isReasoning && (m as any)._reasoningRunId === p.runId),
      );
      if (p.state !== "error") {
        // ─── Continuation merge ───
        // Before promoting, merge sentence fragments: if an assistant text
        // bubble starts with lowercase (mid-sentence continuation after a
        // tool call), move text up to the first '.' into the previous
        // assistant text bubble and keep the remainder in the current one.
        mergeSentenceContinuations(messages);

        // FORK 2026-05-09 (revised tail-recover): with per-bubble `_segmentStart`,
        // each temp text bubble knows where its slice begins in the cumulative
        // server text. Re-slice each bubble's content from finalText using
        // `_segmentStart`-to-next-bubble's-start (or to end-of-finalText for
        // the last bubble), then promote in place. This preserves gap-split
        // bubble structure across the truncation/divergence reconciliation
        // (the original logic dropped all temp text bubbles and pushed a
        // single new one, which would duplicate content with gap-splits).
        const hadTemps = messages.some((m: unknown) => m._temporary);
        const bubbleEndedAt = Date.now();
        if (hadTemps && p.message) {
          const finalContent = Array.isArray(p.message.content) ? p.message.content : [];
          const finalText = finalContent
            .filter((b: unknown) => b.type === "text")
            .map((b: unknown) => b.text ?? "")
            .join("");

          // Collect all temp text bubbles in order with their segment starts.
          const tempTextBubbles: { idx: number; segStart: number }[] = [];
          for (let i = 0; i < messages.length; i++) {
            const m = messages[i] as Record<string, unknown>;
            if (
              m._temporary &&
              m.role === "assistant" &&
              Array.isArray(m.content) &&
              (m.content as Array<{ type: string }>).some((b) => b.type === "text")
            ) {
              tempTextBubbles.push({
                idx: i,
                segStart: (m._segmentStart as number | undefined) ?? 0,
              });
            }
          }

          if (tempTextBubbles.length === 0) {
            // No temp text bubbles — push the authoritative text as a single
            // new bubble (e.g. response is tool-only with no streamed text).
            if (finalText.trim()) {
              messages.push({
                role: "assistant",
                content: [{ type: "text", text: finalText }],
                _bubbleEndedAt: bubbleEndedAt,
              });
            }
          } else {
            // Re-slice each temp text bubble from its _segmentStart up to the
            // next bubble's _segmentStart (or end-of-finalText for the last).
            for (let i = 0; i < tempTextBubbles.length; i++) {
              const cur = tempTextBubbles[i];
              const next = tempTextBubbles[i + 1];
              const segEnd = next ? next.segStart : finalText.length;
              const segText = finalText.slice(cur.segStart, segEnd);
              const m = messages[cur.idx] as Record<string, unknown>;
              const blocks = m.content as Array<{ type: string; text?: string }>;
              for (const b of blocks) {
                if (b.type === "text") {
                  b.text = segText;
                  break;
                }
              }
              delete m._temporary;
              if (typeof m._bubbleStartedAt === "number" && !m._bubbleEndedAt) {
                m._bubbleEndedAt = bubbleEndedAt;
              }
            }
          }

          // Clean up remaining temp flags on tool messages etc.
          for (const m of messages) {
            if (m._temporary) {
              delete m._temporary;
            }
          }
        } else if (hadTemps) {
          // No server final message — promote temps as-is (fallback).
          // FORK 2026-05-09 (Feature B): stamp _bubbleEndedAt on the last
          // temp text message before promoting.
          for (const m of messages) {
            if (m._temporary) {
              if (m.role === "assistant" && m._bubbleStartedAt) {
                m._bubbleEndedAt = bubbleEndedAt;
              }
              delete m._temporary;
            }
          }
        }
        if (!hadTemps && p.message) {
          messages.push(p.message);
        }
      } else {
        messages = messages.filter((m: unknown) => !m._temporary);
        if (p.message) {
          messages.push(p.message);
        }
      }
      if (p.state === "error" && p.errorMessage) {
        const errText = p.errorMessage as string;
        // FORK: Classify auto-recovering errors as orange warnings
        const isAutoRecovering =
          errText.includes("draining for restart") ||
          errText.includes("overloaded") ||
          errText.includes("temporarily unavailable") ||
          errText.includes("HTTP 502") ||
          errText.includes("HTTP 503") ||
          errText.includes("HTTP 529");
        // Clean up unhelpful CLI hints from webchat error messages
        const cleanText = errText.replace(/\s*Logs:.*$/s, "").trim();
        const errMsg = {
          role: "assistant",
          content: [{ type: "text", text: cleanText }],
          ...(isAutoRecovering ? { _isWarning: true } : { _isError: true }),
        };
        messages.push(errMsg);
        persistErrorMsg(sessionKey, errMsg);
      }
      if (p.state === "final") {
        clearPersistedErrors(sessionKey);
        // Clear provider error badges for the provider that just succeeded
        if (streamProvider || streamProfileId) {
          let cleared = false;
          if (streamProfileId) {
            providerErrors.delete(streamProfileId);
            cleared = true;
          }
          // Clear all keys matching this provider (provider:*, provider/*)
          if (streamProvider) {
            for (const key of providerErrors.keys()) {
              if (
                key === streamProvider ||
                key.startsWith(streamProvider + ":") ||
                key.startsWith(streamProvider + "/")
              ) {
                providerErrors.delete(key);
                cleared = true;
              }
            }
          }
          if (cleared) {
            persistProviderErrors();
            updateBudgetPanel();
          }
        }
      }
      // Always reset streaming state — even on error (fallback will start fresh deltas)
      streamMsgIdx = -1;
      lastDeltaLen = 0;
      lastDeltaAt = 0;
      streamRunId = p.state !== "error" ? null : streamRunId;
      // FORK: Chat final/error is authoritative — if the lifecycle "end" agent event
      // was missed (dropped frame, JS error, session key mismatch), activeRuns would
      // keep a stale entry forever. Schedule a safety-net cleanup so the thinking
      // indicator clears even when the lifecycle event never arrives.
      // FORK 2026-05-16: chat.final/aborted is AUTHORITATIVE — the assistant's
      // answer is in. Remove the run IMMEDIATELY rather than the old 5s
      // delayed-maybe. This is the direct fix for "Jarvis already answered but
      // the run never closed": we no longer wait for a lifecycle:end that may
      // never arrive (the exact case the user hit — turn hung in `processing`
      // for 10 min after the reply was delivered). The watchdog was deleted
      // 2026-05-14 precisely so the UI would trust lifecycle/final events; this
      // makes `final` actually close the run instead of leaking it.
      if (p.state === "final" || p.state === "aborted") {
        const finalRunId = p.runId;
        const pend = pendingRunDeletes.get(finalRunId);
        if (pend) {
          clearTimeout(pend);
          pendingRunDeletes.delete(finalRunId);
        }
        if (activeRuns.has(finalRunId)) {
          activeRuns.delete(finalRunId);
          saveActiveRuns();
        }
      }
      // sending reflects the VIEWED tab only — never the global map size, so a
      // different tab's live run can't pin this tab on "sending" forever.
      sending = viewedSessionBusy();
      updateChat();
      updateBtn();
      if (p.state !== "error") {
        loadBudget();
        loadSessions();
        refreshTreemap();
        updateResponseMap();
      }
    }
  }
  // FORK: Auth profile reload event — refresh models panel + notify re-auth flows
  if (evt.event === "auth.profiles.updated") {
    for (const listener of authProfileListeners) {
      try {
        listener(evt);
      } catch {}
    }
    const d = evt.data ?? evt.payload ?? {};
    const profileId = d.profileId as string | undefined;
    if (profileId) {
      providerErrors.delete(profileId);
      persistProviderErrors();
    }
    loadBudget();
  }

  if (evt.event === "agent") {
    const p = evt.payload;
    bumpActiveRunActivity(p ?? {});
    // ─── Live Tool Events ───
    // Capture tool-use/tool-result events and inject them as visible messages.
    // FORK (2026-04-21): use sessionKeyMatches so a server-canonicalized key
    // like "agent:main:tinker:mo7jxksk" matches a client key of
    // "tinker:mo7jxksk". Previously the strict `===` check silently dropped
    // every tool event on tinker:* sessions — that's why tool calls vanished
    // from chat after /clear had rotated to a fresh key.
    if (p?.stream === "tool" && sessionKeyMatches(p.sessionKey)) {
      const d = p.data ?? {};
      if (d.phase === "start" && d.name && d.toolCallId) {
        // Update active run phase to "tool"
        for (const info of activeRuns.values()) {
          if (!info.sessionKey || sessionKeyMatches(info.sessionKey)) {
            info.phase = "tool";
            info.currentTool = d.name;
          }
        }
        updatePrefrontalTree();
        // Freeze current streaming text — it becomes its own thinking bubble.
        // FORK 2026-05-09: with per-bubble `_segmentStart`, no global cursor
        // is needed. The next text delta will open a new bubble whose
        // `_segmentStart` captures the cumulative offset where it begins.
        streamMsgIdx = -1;
        // Add tool_use as a temporary message. FORK (2026-04-24): cc-bridge
        // attaches a `purpose` string to the event carrying the LLM's
        // purpose narration that preceded the tool call. Stash it on the
        // pushed block as `_purpose` so renderMsg can use it as the tool
        // row's title without re-rendering the narration (already streamed
        // above as text deltas into the preceding chat bubble).
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: d.toolCallId,
              name: d.name,
              input: d.args ?? {},
              _purpose: typeof d.purpose === "string" ? d.purpose : undefined,
            },
          ],
          _temporary: true,
        });
        updateChat();
      } else if (d.phase === "result" && d.toolCallId) {
        // Tool completed — back to thinking
        for (const info of activeRuns.values()) {
          if (!info.sessionKey || sessionKeyMatches(info.sessionKey)) {
            info.phase = "thinking";
            info.currentTool = undefined;
          }
        }
        updatePrefrontalTree();
        // Push tool_result as a temporary message so renderMsg can pair it.
        // FORK (2026-04-24): never fill missing output with "(completed)" —
        // that used to mask a real problem (empty stdout vs. not-yet-arrived
        // vs. dropped-in-transit). Empty string is honest; renderMsg hides
        // the stdout block when content is empty.
        const resultContent =
          typeof d.result === "string"
            ? d.result
            : d.result != null
              ? JSON.stringify(d.result)
              : "";
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: d.toolCallId,
              content: resultContent,
              is_error: Boolean(d.isError),
            },
          ],
          _temporary: true,
        });
        updateChat();
      }
    }
    // FORK 2026-06-11 — STREAM:"thinking" consumer (cc-bridge reasoning deltas).
    // d.text is the CUMULATIVE reasoning text for this run, so OVERWRITE the
    // bubble's text on every event (never append). Render as a type:"text"
    // block tagged _isReasoning — renderMsg's content-block loop has NO
    // thinking-block arm, so type:"thinking" would render EMPTY. The bubble is
    // _temporary (discarded on turn end) and is force-excluded from the
    // thinkingSet classifier via its _isReasoning flag.
    if (p?.stream === "thinking" && sessionKeyMatches(p.sessionKey)) {
      const d = p.data ?? {};
      const text = typeof d.text === "string" ? d.text : "";
      if (!text) return;
      let idx = messages.findIndex(
        (m) => (m as any)._reasoningRunId === p.runId && (m as any)._isReasoning,
      );
      if (idx < 0) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text }],
          _isReasoning: true,
          _reasoningRunId: p.runId,
          _temporary: true,
        } as any);
      } else {
        const blk = (messages[idx].content as any[]).find((b) => b.type === "text");
        if (blk) blk.text = text;
      }
      updateChat();
      return;
    }
    // FORK 2026-06-11 (tinkerui-effort) — STREAM:"effort" consumer. The gateway
    // broadcasts a per-run reasoning-effort summary (incremental during the run,
    // phase==="final" at turn end). Fold it onto the run's ActiveRunInfo so the
    // call-tree effort chip + the ?pfdebug truth grid can show what was REQUESTED
    // (thinkLevel + configuredBudget cap) vs what ACTUALLY happened (thinkingChars,
    // hadRealThinking, redacted, and on final output_tokens/num_turns). Gated on
    // sessionKey like the tool/thinking branches.
    if (p?.stream === "effort" && sessionKeyMatches(p.sessionKey)) {
      const d = p.data ?? {};
      const r: ActiveRunInfo =
        activeRuns.get(p.runId) ??
        ({
          model: typeof d.model === "string" ? d.model : "",
          provider: typeof d.provider === "string" ? d.provider : "",
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
          phase: "thinking",
        } as ActiveRunInfo);
      // FORK 2026-06-13 (eeg): the effort event now self-describes its model
      // (cc-bridge), so even an Auto run colours by the ACTUAL model running
      // underneath instead of falling back to gray (Oscar 2026-06-13). Keep any
      // existing non-empty model if the event omits it.
      if (typeof d.model === "string" && d.model) r.model = d.model;
      if (typeof d.provider === "string" && d.provider) r.provider = d.provider;
      if (typeof d.thinkLevel === "string") r.thinkLevel = d.thinkLevel;
      if (typeof d.configuredBudget === "number") r.configuredBudget = d.configuredBudget;
      if (typeof d.thinkingChars === "number") r.thinkingChars = d.thinkingChars;
      if (typeof d.hadRealThinking === "boolean") r.hadRealThinking = d.hadRealThinking;
      if (typeof d.redacted === "boolean") r.redacted = d.redacted;
      if (d.phase === "final") {
        if (typeof d.output_tokens === "number") r.outputTokens = d.output_tokens;
        if (typeof d.num_turns === "number") r.numTurns = d.num_turns;
      }
      activeRuns.set(p.runId, r);
      r.lastEventAt = Date.now();
      // FORK 2026-06-13 (eeg): feed the seismograph (bible §5.8h). Effort events
      // arrive incrementally per run; record() upserts by runId so every emit just
      // refreshes the run's sample. The store is keyed by the VIEWED sessionKey to
      // match the render at updateBudgetPanel() — and every event reaching here has
      // already passed sessionKeyMatches(p.sessionKey), so it belongs to the viewed
      // session. NOTE (v2 gap): sessionKeyMatches does NOT admit `:subagent:`
      // descendants, so subagent effort events are dropped upstream and the q3
      // split/join branches stay unfed until the consumer admits them. Main-session
      // traces are fully live. Failure must never break the consumer.
      try {
        const evtSk = sessionKey;
        getEegStore(evtSk).record({
          runId: p.runId,
          model: r.model,
          provider: r.provider || providerOf(r.model),
          chosenLevel: r.thinkLevel ?? "",
          forced: viewedSessionForced(),
          subagent: String(p.sessionKey || "").includes(":subagent:"),
          parentRunId: undefined,
          thinkingChars: r.thinkingChars,
          // tokens drive segment LENGTH; area = width·length ∝ cost (bible §5.8h). output from
          // the effort-final event; input accumulated from round-start events.
          inputTokens: eegInputByRun.get(p.runId),
          outputTokens: r.outputTokens,
          startedAt: r.startedAt,
          endedAt: undefined,
        });
      } catch {
        /* eeg feed must never break the effort consumer */
      }
      updatePrefrontalTree();
      updateBudgetPanel();
      return;
    }
    // FORK 2026-06-11 (fractal v3, bible §5.67b) — STREAM:"fractal" consumer.
    // The fractal-reflection plugin emits its envelope under the MAIN session's
    // sessionKey (lane runIds ride inside data), so gate exactly like the effort
    // consumer above. The renderer body lives in fractal-dock.ts (one concern,
    // the sectioned-reply.ts precedent); app.ts owns only this dispatch + the
    // dock-anchor lookup that reads app.ts-owned message state.
    if (p?.stream === "fractal" && sessionKeyMatches(p.sessionKey)) {
      const d = p.data ?? {};
      const parentRunId = typeof d.parentRunId === "string" ? d.parentRunId : "";
      if (!parentRunId) return;
      // Anchor tagging (the _reasoningRunId/_subagentId precedent): answer
      // bubbles carry NO runId in messages[]. The pending stub fires at the
      // parent's agent_end — after the final chat message landed and the run's
      // _reasoningRunId bubble was purged — so the last real assistant bubble
      // IS the parent's answer; later events for the same parent reuse the tag
      // instead of re-guessing.
      // TODO(fractal-v3): heuristic, not a real runId mapping (none exists in
      // messages[] for answer bubbles). If the first fractal event arrives
      // after the user moved on, the tag may miss and the dock falls back to
      // the module's orphan rendering. Replace when answer messages gain a
      // real runId stamp at chat-final. Do NOT add new global state here.
      const alreadyTagged = messages.some((m) => (m as any)._fractalParentRunId === parentRunId);
      const parentStillStreaming = messages.some(
        (m) => (m as any)._isReasoning && (m as any)._reasoningRunId === parentRunId,
      );
      if (!alreadyTagged && !parentStillStreaming) {
        for (let k = messages.length - 1; k >= 0; k--) {
          const mm = messages[k] as any;
          if (
            (mm.role || "").toLowerCase() === "assistant" &&
            !mm._isReasoning &&
            !mm._temporary &&
            !mm._subagentId
          ) {
            mm._fractalParentRunId = parentRunId;
            break;
          }
        }
        // Flush the data-fractal-parent-run attribute into the DOM so the
        // anchor lookup below can find the bubble (skipScroll: a dock filling
        // in minutes later must not yank the viewport).
        updateChat(true);
      }
      upsertFractalDock(d, (runForAnchor: string) => {
        const container = $("messages");
        if (!container) return null;
        const escaped =
          typeof CSS !== "undefined" && typeof CSS.escape === "function"
            ? CSS.escape(runForAnchor)
            : runForAnchor;
        return container.querySelector<HTMLElement>(`[data-fractal-parent-run="${escaped}"]`);
      });
      return;
    }
    // FORK 2026-05-28 — cc-bridge text-block boundary. Anthropic's streaming
    // protocol guarantees content_block_delta carries an index field; cc-
    // bridge emits this event whenever the active text block index advances
    // (typically a tool_use block fired between two pieces of prose, but
    // also fires before the first tool when the model emits a long pre-tool
    // narration as a single block). Treat exactly like a tool_start: freeze
    // the current streaming text bubble so the next text delta opens a
    // fresh one. Result: each text block between tool_use blocks becomes
    // its own bubble instead of piling into one with all subsequent
    // narrations.
    if (
      p?.stream === "lifecycle" &&
      p.data?.phase === "text-block-break" &&
      sessionKeyMatches(p.sessionKey)
    ) {
      streamMsgIdx = -1;
      return;
    }
    // FORK 2026-06-11 — cc-bridge turn-incomplete phase event (sibling hook to
    // the model-gated end/error handler below). This event carries NO model, so
    // it never reaches the `p.data?.model`-gated lifecycle block; stamp the last
    // real assistant bubble with _turnIncomplete so renderMsg shows the badge.
    if (
      p?.stream === "lifecycle" &&
      p.data?.phase === "turn-incomplete" &&
      sessionKeyMatches(p.sessionKey)
    ) {
      for (let k = messages.length - 1; k >= 0; k--) {
        const mm = messages[k] as any;
        if ((mm.role || "").toLowerCase() === "assistant" && !mm._isReasoning && !mm._temporary) {
          mm._turnIncomplete = String(p.data.subtype || "incomplete");
          break;
        }
      }
      updateChat();
      return;
    }
    // FORK 2026-06-11 (tinkerui-effort) — think-level-pending lifecycle phase. Fires
    // when a think-level change is requested mid-flight; the run keeps RUNNING at the
    // previous level until the next turn applies the requested one. Stamp the pending
    // requested→running pair onto the run so the truth grid can show the lag.
    if (
      p?.stream === "lifecycle" &&
      p.data?.phase === "think-level-pending" &&
      sessionKeyMatches(p.sessionKey)
    ) {
      const info = activeRuns.get(p.runId);
      if (info) {
        info.pendingThinkLevel = {
          requested: typeof p.data.requested === "string" ? p.data.requested : undefined,
          running: typeof p.data.running === "string" ? p.data.running : undefined,
        };
        info.lastEventAt = Date.now();
        updatePrefrontalTree();
      }
      return;
    }
    // Instant context anatomy bar — enriches existing round bars or creates new ones for legacy events
    if (p?.stream === "lifecycle" && p.data?.phase === "context-anatomy") {
      if (p.data.anatomy && timelineCtrl) {
        const anatomy = p.data.anatomy as unknown;
        if (anatomy.roundNumber) {
          // Round-level anatomy: enrich existing round bar with full segment data
          timelineCtrl.pushEvent(anatomy, p.runId);
        } else {
          // Legacy turn-level anatomy (fallback for non-round-aware sessions)
          timelineCtrl.pushEvent(anatomy);
        }
      }
    }

    // Round-start: push a new bar to the timeline immediately
    if (p?.stream === "lifecycle" && p.data?.phase === "round-start") {
      if (
        p.data.sessionKey &&
        p.data.sessionKey !== sessionKey &&
        !p.data.sessionKey.includes(":subagent:")
      ) {
        return;
      }
      // FORK 2026-06-13 (eeg): accumulate billed input tokens per runId so the
      // seismograph segment length tracks token count; area ∝ cost (bible §5.8h).
      if (typeof p.runId === "string" && typeof p.data.inputTokensEstimate === "number") {
        eegInputByRun.set(p.runId, (eegInputByRun.get(p.runId) ?? 0) + p.data.inputTokensEstimate);
      }
      if (timelineCtrl) {
        const roundEvent: unknown = {
          turn: p.data.turnNumber,
          roundNumber: p.data.roundNumber,
          model: p.data.model,
          provider: p.data.provider,
          timestampMs: p.data.timestampMs ?? Date.now(),
          contextSent: { totalTokens: p.data.inputTokensEstimate ?? 0 },
          contextWindow: { maxTokens: 200000, usedTokens: p.data.inputTokensEstimate ?? 0 },
        };
        timelineCtrl.pushEvent(roundEvent, p.runId);
      }
    }

    // Round-complete: update the bar with response data
    if (p?.stream === "lifecycle" && p.data?.phase === "round-complete") {
      if (
        p.data.sessionKey &&
        p.data.sessionKey !== sessionKey &&
        !p.data.sessionKey.includes(":subagent:")
      ) {
        return;
      }
      if (timelineCtrl) {
        timelineCtrl.pushRoundComplete(p.runId, {
          roundNumber: p.data.roundNumber,
          outputTokens: p.data.outputTokens,
          durationMs: p.data.durationMs,
          stopReason: p.data.stopReason,
          toolCallsRequested: p.data.toolCallsRequested,
        });
      }
    }

    // Tool execution events: attach to the round's detail
    if (
      p?.stream === "lifecycle" &&
      (p.data?.phase === "tool-exec-start" || p.data?.phase === "tool-exec-complete")
    ) {
      if (
        p.data.sessionKey &&
        p.data.sessionKey !== sessionKey &&
        !p.data.sessionKey.includes(":subagent:")
      ) {
        return;
      }
      if (timelineCtrl) {
        timelineCtrl.pushToolExec(p.runId, {
          roundNumber: p.data.roundNumber,
          phase: p.data.phase,
          toolName: p.data.toolName,
          toolCallId: p.data.toolCallId,
          outputChars: p.data.outputChars,
          durationMs: p.data.durationMs,
          isError: p.data.isError,
          inputChars: p.data.inputChars,
        });
      }
    }
    // Track provider failures from model fallback
    // FORK: Only show fallback errors for the active session (skip other tabs' failures)
    if (
      p?.stream === "lifecycle" &&
      p.data?.phase === "fallback-error" &&
      (!p.data.sessionKey || sessionKeyMatches(p.data.sessionKey))
    ) {
      const fp = p.data.failedProvider as string | undefined;
      const fm = p.data.failedModel as string | undefined;
      const reason = (p.data.reason || "unknown") as string;
      const errMsg = (p.data.error || "") as string;
      const attempt = p.data.attempt as number | undefined;
      const total = p.data.total as number | undefined;
      // Key by profileId or model — NOT bare provider, to avoid bleeding
      // into other models from the same provider (e.g. opus error showing on sonnet/haiku).
      // fallback-profile-error already populates per-profile entries.
      const errKey = (p.data.failedProfileId as string) || fm || fp;
      if (errKey) {
        const errEntry = {
          error: (errMsg || reason || "failed") as string,
          reason,
          ts: Date.now(),
        };
        providerErrors.set(errKey, errEntry);
        // Also store under bare model ID (strip "provider/" prefix) so the model
        // panel can find the error — it looks up by keyId (auth profile) or bare
        // modelId, but fallback-error events use "provider/model" format.
        if (fm && fm.includes("/")) {
          providerErrors.set(fm.split("/").slice(1).join("/"), errEntry);
        }
        // Store under all auth profile IDs for this provider so per-key rows
        // show the error badge even when failedProfileId is missing.
        if (!p.data.failedProfileId && fp && modelConfigData?.authOrder?.[fp]) {
          for (const kid of modelConfigData.authOrder[fp]) {
            providerErrors.set(kid, errEntry);
          }
        }
        persistProviderErrors();
        updateBudgetPanel();
        startHealthPoll();
      }
      // Show each fallback step as a chat message
      const profileId = (p.data.failedProfileId || "") as string;
      const stepLabel = attempt && total ? `[${attempt}/${total}]` : "";
      const shortModel = fm && fm.includes("/") ? fm.split("/").pop() : fm || "unknown";
      const profileLabel = profileId ? ` (${profileId})` : "";
      const reasonLabel = describeError(reason, errMsg);
      const nextModel = p.data.nextModel as string | undefined;
      const nextShort =
        nextModel && nextModel.includes("/") ? nextModel.split("/").pop() : nextModel;
      const nextLabel = nextShort
        ? ` — falling back to ${nextShort}`
        : attempt && total && attempt >= total
          ? " — all backups exhausted"
          : " — jumping to backup";
      const fallbackText = `⚠ ${shortModel}${profileLabel} ${stepLabel} — ${reasonLabel}${nextLabel}`;
      const fallbackMsg: unknown = {
        role: "assistant",
        content: [{ type: "text", text: fallbackText }],
        _isWarning: true,
        _retryProvider: fp || undefined,
      };
      messages.push(fallbackMsg);
      persistErrorMsg(sessionKey, fallbackMsg);
      updateChat();
    }
    // Show per-profile failure events (auth profile rotation within a provider)
    // FORK: Only show profile errors for the active session
    if (
      p?.stream === "lifecycle" &&
      p.data?.phase === "fallback-profile-error" &&
      (!p.data.sessionKey || sessionKeyMatches(p.data.sessionKey))
    ) {
      const prov = (p.data.provider || "unknown") as string;
      const model = (p.data.model || "unknown") as string;
      const pid = (p.data.profileId || "") as string;
      const reason = (p.data.reason || "unknown") as string;
      const errMsg = (p.data.error || "") as string;
      const pIdx = p.data.profileIndex as number | undefined;
      const pTotal = (p.data.totalProfiles ?? p.data.profileTotal) as number | undefined;
      const reasonLabel = describeError(reason, errMsg);
      const profileStep = pIdx && pTotal ? ` [${pIdx}/${pTotal}]` : "";
      const shortModel = model.includes("/") ? model.split("/").pop() : model;
      const profileLabel = pid ? ` (${pid})` : "";
      const profileText = `⚠ ${shortModel}${profileLabel}${profileStep} — ${reasonLabel}`;
      // Track per-profile error for model panel red labels
      if (pid) {
        providerErrors.set(pid, {
          error: (errMsg || reason || "failed") as string,
          reason,
          ts: Date.now(),
        });
        persistProviderErrors();
        updateBudgetPanel();
        startHealthPoll();
      }
      const profileMsg: unknown = {
        role: "assistant",
        content: [{ type: "text", text: profileText }],
        _isWarning: true,
        _retryProvider: prov,
      };
      messages.push(profileMsg);
      persistErrorMsg(sessionKey, profileMsg);
      updateChat();
    }
    // FORK: Overload retry events — show orange bubble with attempt/delay info
    if (
      p?.stream === "lifecycle" &&
      (p.data?.phase === "overload-retry" || p.data?.phase === "overload-retry-exhausted") &&
      (!p.data.sessionKey || sessionKeyMatches(p.data.sessionKey))
    ) {
      const d = p.data;
      const isExhausted = d.phase === "overload-retry-exhausted";
      const shortModel =
        d.model && String(d.model).includes("/") ? String(d.model).split("/").pop() : d.model;
      const text = isExhausted
        ? `🛑 ${shortModel} — ${d.attempts} retries exhausted — falling back`
        : `⏳ ${shortModel} — overload retry ${d.attempt}/${d.maxAttempts} — waiting ${((d.delayMs as number) / 1000).toFixed(0)}s`;
      const retryMsg: unknown = {
        role: "assistant",
        content: [{ type: "text", text }],
        _isOverloadRetry: true,
        _isExhausted: isExhausted,
      };
      messages.push(retryMsg);
      updateChat();
    }
    // Prefrontal periodic chat updates
    // FORK: Only show prefrontal updates for the active session
    if (
      p?.stream === "lifecycle" &&
      p.data?.phase === "prefrontal-update" &&
      (!p.data.sessionKey || sessionKeyMatches(p.data.sessionKey))
    ) {
      const mdText = p.data.markdown as string;
      if (mdText) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: mdText }],
          _isPrefrontal: true,
        });
        updateChat();
      }
    }
    // v3.0: Prefrontal recipe progress events
    if (p?.stream === "lifecycle" && p.data?.phase === "prefrontal-progress") {
      updateRecipeProgress(p.data.data);
    }

    // FORK 2026-04-20: Prefrontal tree broadcast from the extension. Canonical
    // source of the right-panel tree -- has labels, progress%, summaries per
    // node that the local activeRuns synthesis can't provide.
    if (p?.stream === "lifecycle" && p.data?.phase === "prefrontal-tree") {
      const tree = p.data?.tree as TreeResponse | undefined;
      if (tree && typeof tree.active === "boolean") {
        latestTreeFromExtension = tree;
        latestTreeFromExtensionAt = Date.now();
        PF_DEBUG_STATE.lastTree = tree;
        PF_DEBUG_STATE.eventCounts.tree++;
        pfLog(
          `tree event #${PF_DEBUG_STATE.eventCounts.tree} active=${tree.active} root=${tree.root?.model ?? "-"} children=${tree.root?.children?.length ?? 0}`,
          tree,
        );
        updatePrefrontalTree();
      } else {
        pfLog(`tree event IGNORED (malformed)`, p.data);
      }
    }

    // FORK 2026-04-20: Jarvis (or any caller) publishes recipe state via
    // fork.prefrontal.setRecipe RPC. The gateway broadcasts it as a lifecycle
    // event; we update the right-panel header + append a trail item.
    if (p?.stream === "lifecycle" && p.data?.phase === "prefrontal-recipe-state") {
      const d = p.data as {
        recipeId?: string;
        step?: number;
        totalSteps?: number;
        stepName?: string;
        parallelismCap?: number;
        inFlightLabels?: string[];
        note?: string;
        ts?: number;
      };
      if (d.recipeId) {
        const prev = currentRecipe;
        const startedAt =
          prev?.recipeId === d.recipeId ? (prev.startedAt ?? Date.now()) : (d.ts ?? Date.now());
        currentRecipe = {
          recipeId: d.recipeId,
          step: d.step,
          totalSteps: d.totalSteps,
          stepName: d.stepName,
          parallelismCap: d.parallelismCap,
          inFlightLabels: d.inFlightLabels,
          note: d.note,
          startedAt,
        };
        PF_DEBUG_STATE.lastRecipe = currentRecipe;
        PF_DEBUG_STATE.eventCounts.recipe++;
        pfLog(
          `recipe-state #${PF_DEBUG_STATE.eventCounts.recipe} recipe=${d.recipeId} step=${d.step ?? "-"}/${d.totalSteps ?? "-"} name="${d.stepName ?? ""}" cap=${d.parallelismCap ?? "-"} inFlight=${(d.inFlightLabels ?? []).length}`,
          currentRecipe,
        );
        // Emit a trail item on step transitions (including recipe start).
        const newStepKey = `${d.recipeId}:${d.step ?? 0}`;
        const prevStepKey = prev ? `${prev.recipeId}:${prev.step ?? 0}` : "";
        if (newStepKey !== prevStepKey) {
          const label =
            d.step != null
              ? `Step ${d.step}${d.totalSteps != null ? `/${d.totalSteps}` : ""}`
              : d.recipeId;
          pushTrail({
            ts: d.ts ?? Date.now(),
            kind: "recipe-step",
            label,
            message: d.stepName ?? d.recipeId,
          });
        }
        updatePrefrontalTree();
      }
    }

    // FORK 2026-05-13: Plan-board state update. Emitted by the prefrontal
    // extension's PlanStore.onMutation callback after every set/step/close.
    // plan is null when a plan has been closed (archived).
    if (p?.stream === "lifecycle" && p.data?.phase === "prefrontal-plan-state") {
      const d = p.data as { sessionKey?: string; plan?: PanelPlan | null };
      currentPlan = d.plan ?? null;
      pfLog(
        `plan-state sessionKey=${d.sessionKey ?? "-"} status=${currentPlan?.status ?? "null"} steps=${currentPlan?.steps?.length ?? 0}`,
        currentPlan,
      );
      updatePrefrontalTree();
    }

    // FORK 2026-06-07 — AMYGDALA live: the learned-intuition plugin broadcasts a
    // gate decision per tool call; stream it into the right-rail Amygdala panel.
    if (p?.stream === "lifecycle" && p.data?.phase === "amygdala-decision") {
      pushAmygdalaDecision(p.data as AmygdalaLiveDecision);
    }

    // FORK 2026-04-20: Jarvis publishes a discrete trail event via
    // fork.prefrontal.trailEvent RPC. kind ∈ dispatch|complete|note|
    // transition|warn (other kinds fall through to "note").
    if (p?.stream === "lifecycle" && p.data?.phase === "prefrontal-trail-event") {
      const d = p.data as {
        kind?: string;
        label?: string;
        message?: string;
        icon?: string;
        ts?: number;
        // FORK 2026-05-31: optional structured provenance (recipeId, confidence,
        // score, semantic-lane flags, recipe-apply outcome, …). Forwarded
        // verbatim from the producer's emitTrail so the decision-trail summary
        // can name the matched recipe + confidence at a glance.
        payload?: TrailEventPayload;
      };
      if (d.message) {
        const ALLOWED: TrailEventKind[] = [
          "dispatch",
          "complete",
          "note",
          "transition",
          "warn",
          "recipe-step",
          "spawn-fail",
          // FORK 2026-05-29: recipe-lifecycle provenance verbs.
          "searched",
          "matched",
          "merged",
          "composed",
          "authored",
          // FORK 2026-05-31: autonomous recipe-evolution provenance verbs.
          "recipe-apply",
          "recipe-reject",
          "recipe-supersede",
        ];
        const kind: TrailEventKind = ALLOWED.includes(d.kind as TrailEventKind)
          ? (d.kind as TrailEventKind)
          : "note";
        const entry = {
          ts: d.ts ?? Date.now(),
          kind,
          label: d.label,
          message: d.message,
          icon: d.icon,
          ...(d.payload ? { payload: d.payload } : {}),
        };
        pushTrail(entry);
        PF_DEBUG_STATE.lastTrailEvent = entry;
        PF_DEBUG_STATE.eventCounts.trail++;
        pfLog(
          `trail-event #${PF_DEBUG_STATE.eventCounts.trail} kind=${kind} label=${d.label ?? "-"} msg="${d.message}"`,
        );
        updatePrefrontalTree();
      } else {
        pfLog(`trail-event IGNORED (no message)`, d);
      }
    }
    // FORK: Prefrontal recipe status — banner + thinking annotation + message tags
    if (p?.stream === "lifecycle" && p.data?.phase === "prefrontal-recipe-status") {
      const d = p.data;
      const banner = document.getElementById("recipe-banner");
      const nameEl = document.getElementById("recipe-banner-name");
      const stepEl = document.getElementById("recipe-banner-step");
      const progressEl = document.getElementById("recipe-banner-progress");
      if (banner && nameEl && stepEl && progressEl) {
        banner.classList.remove("hidden");
        nameEl.textContent = d.recipeName || d.recipeId || "";
        stepEl.textContent = `step ${(d.completedSteps?.length || 0) + 1}/${d.totalSteps}: ${d.currentStepName || d.currentStep || "starting"}`;
        progressEl.textContent = "";
        // Set category color
        const colors: Record<string, string> = {
          coding: "#6b8e23",
          writing: "#8b5cf6",
          operations: "#f59e0b",
          analysis: "#3b82f6",
          security: "#ef4444",
          communication: "#10b981",
        };
        banner.style.borderLeftColor = colors[d.category as string] || "#c19a6b";
      }
      activeRecipeStep = d.currentStepName || d.currentStep || null;
    }
    if (p?.stream === "lifecycle" && p.data?.model) {
      // FORK: Ignore lifecycle events that don't belong to the current session.
      // Events without a sessionKey (cron, heartbeat) are also ignored — they would
      // set sending=true and disrupt the active tab's UI.
      // Allow subagent sessions through — they're child runs the user cares about.
      const evtSessionKey = p.data.sessionKey as string | undefined;
      if (
        !evtSessionKey ||
        (!sessionKeyMatches(evtSessionKey) && !evtSessionKey.includes(":subagent:"))
      ) {
        return;
      }
      // Any lifecycle event for a restored run confirms it's still active
      unconfirmedRuns.delete(p.runId);
      // Track the provider/profile that's actively responding
      if (p.data?.provider) {
        streamProvider = String(p.data.provider);
      }
      if (p.data?.profileId) {
        streamProfileId = String(p.data.profileId);
      }
      if (p.data.phase === "start") {
        const startProvider = p.data.modelProvider || providerOf(p.data.model);
        // Cancel any pending deletion for this runId (fallback reuses the same runId)
        const pendingTimeout = pendingRunDeletes.get(p.runId);
        if (pendingTimeout) {
          clearTimeout(pendingTimeout);
          pendingRunDeletes.delete(p.runId);
        }
        // Clear errors only for the specific profile/model that succeeded.
        // Don't wipe sibling profiles — cli-sv can stay errored while cli-gm works.
        const startModel = p.data.model as string;
        const startProfileId = p.data.authProfileId as string | undefined;
        if (startProfileId) {
          providerErrors.delete(startProfileId);
        }
        providerErrors.delete(startModel);
        persistProviderErrors();
        // FORK 2026-05-31: capture task/label text if the start event carries it,
        // so the fallback tree can show "what this run is doing" as a sub-line.
        // The event does not carry it today; this is the forward-compatible seam
        // (the "all"-scope extension tree surfaces task via its own broadcast).
        const startTask =
          typeof (p.data as { task?: unknown }).task === "string"
            ? ((p.data as { task?: string }).task as string)
            : typeof (p.data as { label?: unknown }).label === "string"
              ? ((p.data as { label?: string }).label as string)
              : undefined;
        activeRuns.set(p.runId, {
          model: p.data.model,
          provider: startProvider,
          authProfileId: p.data.authProfileId,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          sessionKey: p.data.sessionKey as string | undefined,
          phase: "thinking",
          ...(startTask ? { task: startTask } : {}),
        });
        // FORK 2026-04-20: synthesize an implicit trail entry when a subagent
        // session starts/ends, so the panel trail still shows motion even if
        // the caller forgot to push explicit trail events via the RPC.
        {
          const sk = typeof p.data.sessionKey === "string" ? p.data.sessionKey : "";
          if (sk.includes(":subagent:")) {
            const tail = sk.split(":").pop() ?? sk;
            const shortId = tail.length > 8 ? tail.slice(0, 8) : tail;
            const shortModel =
              String(p.data.model ?? "")
                .split("/")
                .pop() ?? "";
            pushTrail({
              ts: Date.now(),
              kind: "dispatch",
              label: shortId,
              message: `subagent start · ${shortModel}`,
            });
            PF_DEBUG_STATE.eventCounts.subagentStart++;
            pfLog(
              `implicit dispatch #${PF_DEBUG_STATE.eventCounts.subagentStart} sessionKey=${sk} model=${shortModel} runId=${p.runId}`,
            );
          }
        }
        // Re-assert sending in case a chat error event cleared it during fallback
        sending = true;
        saveActiveRuns();
        updateBudgetPanel();
        updateSessionsPanel();
        updatePrefrontalTree();
        updateChat();
        updateBtn();
        startThinkingTick();
        // Poll anatomy API shortly after run starts — pre-prompt anatomy is written before LLM call
        {
          const sk = sessionKey;
          const tn = currentTurnNumber;
          setTimeout(() => {
            if (sk && timelineCtrl) {
              // Use relative URL so Vite proxy handles auth (avoids CORS preflight)
              fetch(`/tinker/api/context-anatomy/${encodeURIComponent(sk)}?limit=10`)
                .then((r) => (r.ok ? r.json() : null))
                .then((body) => {
                  const events: unknown[] = Array.isArray(body) ? body : (body?.events ?? []);
                  if (events.length === 0) {
                    return;
                  }
                  const turnEvents = events.filter((ev: unknown) => ev.turn === tn);
                  for (const ev of turnEvents) {
                    timelineCtrl!.pushEvent(ev);
                  }
                })
                .catch(() => {});
            }
          }, 800);
        }
      } else if (p.data.phase === "end" || p.data.phase === "error") {
        // FORK 2026-06-11 — turn-incomplete badge (model-gated hook). If the run
        // ended in an abandoned/blocked liveness state, stamp the last real
        // assistant bubble so renderMsg surfaces a ⚠ incomplete badge.
        const incomplete =
          p.data.livenessState === "abandoned" || p.data.livenessState === "blocked";
        if (incomplete) {
          for (let k = messages.length - 1; k >= 0; k--) {
            const mm = messages[k] as any;
            if (
              (mm.role || "").toLowerCase() === "assistant" &&
              !mm._isReasoning &&
              !mm._temporary
            ) {
              mm._turnIncomplete = String(
                p.data.livenessState || p.data.stopReason || "incomplete",
              );
              break;
            }
          }
          updateChat();
        }
        // FORK 2026-04-20: implicit trail entry on subagent completion.
        {
          const sk = typeof p.data.sessionKey === "string" ? p.data.sessionKey : "";
          if (sk.includes(":subagent:")) {
            const runMeta = activeRuns.get(p.runId);
            const tail = sk.split(":").pop() ?? sk;
            const shortId = tail.length > 8 ? tail.slice(0, 8) : tail;
            const elapsed = runMeta ? Math.round((Date.now() - runMeta.startedAt) / 1000) : 0;
            const kind = p.data.phase === "error" ? "spawn-fail" : "complete";
            pushTrail({
              ts: Date.now(),
              kind,
              label: shortId,
              message:
                kind === "spawn-fail"
                  ? `subagent failed · ${elapsed}s`
                  : `subagent done · ${elapsed}s`,
            });
            PF_DEBUG_STATE.eventCounts.subagentEnd++;
            pfLog(
              `implicit ${kind} #${PF_DEBUG_STATE.eventCounts.subagentEnd} sessionKey=${sk} elapsed=${elapsed}s runId=${p.runId}`,
            );
          }
        }
        // FORK: Regenerate tab title after assistant responds — works for any tab via TabState
        if (p.data.phase === "end") {
          const evtKey = p.data.sessionKey as string | undefined;
          const targetTab = evtKey
            ? tabs.find(
                (t) =>
                  t.id !== "tab-main" && t.sessionKey && sessionKeyMatches(evtKey, t.sessionKey),
              )
            : tabs.find((t) => t.id === activeTabId && t.id !== "tab-main");
          if (targetTab) {
            const ts = tabStates.get(targetTab.id);
            const tabMsgs = targetTab.id === activeTabId ? messages : (ts?.messages ?? []);
            const tabTurns = tabMsgs.filter((m: unknown) => m.role === "user").length;
            if (tabTurns === 1 || tabTurns % TAB_TITLE_INTERVAL === 0) {
              console.log(
                "[tabs] triggering title generation for turn",
                tabTurns,
                "tab",
                targetTab.id,
              );
              generateTabTitle(targetTab);
            }
          }
        }
        // Update usage bars from Anthropic rate limit response headers
        if (p.data.rateLimit && budgetUsageData?.claude) {
          const rl = p.data.rateLimit as { h5: number; d7: number; d7Sonnet?: number };
          if (!budgetUsageData.claude.limits) {
            budgetUsageData.claude.limits = {} as unknown;
          }
          budgetUsageData.claude.limits.five_hour = {
            utilization: rl.h5,
            resets_at: budgetUsageData.claude.limits.five_hour?.resets_at ?? null,
          };
          budgetUsageData.claude.limits.seven_day = {
            utilization: rl.d7,
            resets_at: budgetUsageData.claude.limits.seven_day?.resets_at ?? null,
          };
          if (rl.d7Sonnet != null) {
            budgetUsageData.claude.limits.seven_day_sonnet = {
              utilization: rl.d7Sonnet,
              resets_at: budgetUsageData.claude.limits.seven_day_sonnet?.resets_at ?? null,
            };
          }
          updateBudgetPanel();
        }
        const endRunId = p.runId;
        const timeoutId = setTimeout(() => {
          pendingRunDeletes.delete(endRunId);
          activeRuns.delete(endRunId);
          saveActiveRuns();
          // FORK 2026-05-16: sending tracks the viewed tab, not the global map.
          sending = viewedSessionBusy();
          if (!sending) {
            // Hide recipe banner when the viewed session is idle
            activeRecipeStep = null;
            document.getElementById("recipe-banner")?.classList.add("hidden");
          }
          updateBudgetPanel();
          updateSessionsPanel();
          updatePrefrontalTree();
          updateChat();
          updateBtn();
        }, 3000);
        pendingRunDeletes.set(endRunId, timeoutId);
        // FORK 2026-06-13 (eeg): end-of-turn marker (bible §5.8h q7). Bump the
        // session's turn counter, stamp the trace store, tag the last real
        // assistant bubble (the turn-incomplete reverse-loop precedent: skip
        // _isReasoning/_temporary/_subagentId) with _eegTurn so renderMsg emits
        // data-eeg-turn, then flush the DOM and repaint the paper. The event's
        // own sessionKey wins; the viewed session is the fallback.
        if (p.data.phase === "end") {
          try {
            const eegEvtSk =
              typeof p.data.sessionKey === "string" && p.data.sessionKey
                ? p.data.sessionKey
                : sessionKey;
            if (eegEvtSk && !eegEvtSk.includes(":subagent:")) {
              const turn = (eegTurnCounters.get(eegEvtSk) ?? 0) + 1;
              eegTurnCounters.set(eegEvtSk, turn);
              getEegStore(eegEvtSk).turnEnd({ turn, runId: endRunId, endedAt: Date.now() });
              // persist the completed turn so a hard refresh restores it (Oscar 2026-06-13)
              saveEegStore(eegEvtSk);
              if (sessionKeyMatches(eegEvtSk)) {
                for (let k = messages.length - 1; k >= 0; k--) {
                  const mm = messages[k] as any;
                  if (
                    (mm.role || "").toLowerCase() === "assistant" &&
                    !mm._isReasoning &&
                    !mm._temporary &&
                    !mm._subagentId
                  ) {
                    mm._eegTurn = turn;
                    break;
                  }
                }
                updateChat(true);
              }
              updateBudgetPanel();
            }
          } catch {
            /* eeg marker must never break the end handler */
          }
        }
        // Poll anatomy API after turn completes — fetch recent events to capture fallback attempts
        const sk = sessionKey;
        const turnNum = currentTurnNumber;
        setTimeout(() => {
          if (sk && timelineCtrl) {
            const base = import.meta.env.DEV ? "http://localhost:18789" : "";
            const hdrs: Record<string, string> = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
            fetch(
              `${base}/tinker/api/context-anatomy/${encodeURIComponent(sk)}?limit=10`,
              Object.keys(hdrs).length ? { headers: hdrs } : undefined,
            )
              .then((r) => (r.ok ? r.json() : null))
              .then((body) => {
                const events: unknown[] = Array.isArray(body) ? body : (body?.events ?? []);
                if (events.length === 0) {
                  return;
                }
                // Find events for the current turn
                const turnEvents = events.filter((ev: unknown) => ev.turn === turnNum);
                if (turnEvents.length === 0) {
                  // Fallback: just use the latest event (backwards compat)
                  const latest = events[events.length - 1];
                  if (latest) {
                    turnEvents.push(latest);
                  }
                }
                for (const ev of turnEvents) {
                  timelineCtrl!.pushEvent(ev);
                }
              })
              .catch(() => {});
          }
        }, 500);
      }
    }
    // FORK 2026-06-11 — generic fallback for UNKNOWN streams (e.g. future
    // server-tool/lifecycle channels). Known streams are handled above; for any
    // other stream, surface a thin one-line system bubble on a terminal phase so
    // novel events are visible instead of silently dropped. Does not touch the
    // tool/lifecycle/assistant/thinking paths. (server-tool web_search/web_fetch
    // need no edit — existing friendly labels already cover them.)
    const KNOWN_STREAMS = new Set([
      "tool",
      "lifecycle",
      "assistant",
      "thinking",
      "effort",
      "fractal",
    ]);
    if (
      p?.stream &&
      !KNOWN_STREAMS.has(p.stream) &&
      (!p.sessionKey || sessionKeyMatches(p.sessionKey))
    ) {
      const phase = typeof p.data?.phase === "string" ? p.data.phase : "";
      const title =
        typeof p.data?.title === "string"
          ? p.data.title
          : typeof p.data?.name === "string"
            ? p.data.name
            : "";
      const summary = typeof p.data?.summary === "string" ? p.data.summary : "";
      if (!phase || phase === "end" || phase === "error") {
        const line =
          `[${p.stream}${phase ? `:${phase}` : ""}]${title ? ` ${title}` : ""}${summary ? ` — ${summary}` : ""}`.trim();
        messages.push({
          role: "system",
          content: [{ type: "text", text: line }],
          _temporary: true,
        } as any);
        updateChat();
      }
    }
  }
  // Prefrontal tree updates are now reactive (driven by activeRuns, same as thinking indicator)
}

// FORK 2026-05-24 (third pass) — bug task-mpjhzu3j-ma9ts. Tab lookup helper
// for the cookiePhrase reconciliation in loadSessions. The primary lookup
// is the tabsByKey Map (exact match on tab.sessionKey). This fallback
// catches the prefix-canonicalisation case where a server returns
// "agent:main:tinker:abc" but tab.sessionKey is the unprefixed "tinker:abc"
// (mirrors the renderSessionRow comment at app.ts:6172 explaining the
// same drift). Returns undefined when no tab matches.
function findTabByMatch(tabsByKey: Map<string, Tab>, sessionKey: string): Tab | undefined {
  const direct = tabsByKey.get(sessionKey);
  if (direct) return direct;
  for (const [tabKey, tab] of tabsByKey.entries()) {
    if (sessionKeyMatches(sessionKey, tabKey)) return tab;
  }
  return undefined;
}

// ─── API ───
async function loadSessions(opts?: { loadChat?: boolean }) {
  const res = await req("sessions.list", {}).catch(() => ({ sessions: [] }));
  sessions = res.sessions ?? [];
  // FORK 2026-05-24 (fourth pass) — bug task-mpjhzu3j-ma9ts: tab.title
  // sync only. The server's `listSessionsFromStore` lazy-mint (now
  // restored, drawing from the shared FORTUNE_COOKIES pool) is the
  // single source of truth for cookiePhrase. The client just reads it
  // and syncs any matching tab's title.
  //
  // The previous attempt at client-side sessions.patch (third pass)
  // failed: every patch returned INVALID_REQUEST because the
  // rejectWebchatSessionMutation guard blocks webchat clients from
  // patching session metadata. Server-side mint is the only path that
  // works for chat-originated sessions.
  //
  // Tab.title sync logic: for any open tab whose sessionKey matches a
  // returned session, if tab.title is empty OR matches the legacy
  // 2-word shape (from the wrong first-pass mints), replace with the
  // server's cookiePhrase. Auto-title (Gemini topic phrase) doesn't
  // match the legacy regex and is left alone.
  const tabsByKey = new Map<string, Tab>();
  for (const tab of tabs) {
    if (tab.sessionKey && tab.id !== "tab-main") {
      tabsByKey.set(tab.sessionKey, tab);
    }
  }
  let tabTitlesChanged = false;
  // FORK 2026-05-25 (third pass) — set of FORTUNE_COOKIES for O(1)
  // "is this title a fortune phrase?" lookup. Used to identify tabs
  // whose title was burned in BY a fortune-cookie mint (random or
  // canonical) so we can resync them without trampling
  // user/Gemini-set titles like "🔧 Fix auth bug" that happen to
  // not equal what fortuneForKey(key) currently expects.
  const fortuneSet = new Set(FORTUNE_COOKIES);
  for (const s of sessions) {
    if (!s || typeof (s as { key?: unknown }).key !== "string") continue;
    const sess = s as { key: string; cookiePhrase?: string; cookiePhraseUserSet?: boolean };
    const serverPhrase = sess.cookiePhrase;
    if (!serverPhrase) continue;
    const tab = tabsByKey.get(sess.key) ?? findTabByMatch(tabsByKey, sess.key);
    if (!tab) continue;
    // FORK 2026-06-06 — u2-tab-naming: never overwrite a LOCKED title (manual rename or a
    // successful auto-name) with the server fortune. A locked tab's title always wins while it
    // still exists in this browser's localStorage.
    if (tab.titleLocked) continue;
    // FORK 2026-06-10 — u3-tab-naming: the server holds a USER-SET / auto display name (durable in
    // sessions.json). This tab is unlocked — either a default/fortune title, or a tab whose lock
    // was lost when browser localStorage was cleared on a computer restart. Adopt the server name
    // AND re-lock it, so renamed/auto names RETURN after any restart/browser/device change instead
    // of reverting to the fortune cookie. Shape-agnostic (a user name may look like anything).
    if (sess.cookiePhraseUserSet) {
      tab.title = serverPhrase;
      tab.titleLocked = true;
      tabTitlesChanged = true;
      continue;
    }
    if (looksLikeLegacy2WordPhrase(serverPhrase)) continue;
    // Sync conditions for an unlocked, non-user-set tab:
    //   - empty title (initial render)
    //   - legacy 2-word title (from the wrong first-pass mints)
    //   - title IS a known fortune phrase but doesn't match the server's current cookiePhrase
    // Auto/manual titles are locked (handled above), so they're never resynced here.
    const isStaleFortune = fortuneSet.has(tab.title) && tab.title !== serverPhrase;
    const tabNeedsSync = !tab.title || looksLikeLegacy2WordPhrase(tab.title) || isStaleFortune;
    if (tabNeedsSync && tab.title !== serverPhrase) {
      tab.title = serverPhrase;
      tabTitlesChanged = true;
    }
  }
  if (tabTitlesChanged) {
    saveTabs();
    renderTabs();
  }
  const hadSessionKey = Boolean(sessionKey);
  if (!sessionKey && sessions.length) {
    sessionKey = sessions[0].key;
  }
  updateSelect();
  updateSessionsPanel();
  // FORK: If sessionKey was just resolved for the first time, load timeline
  if (!hadSessionKey && sessionKey) {
    refreshTimelineRespectingMode();
  }
  // FORK: Sync tabs with server-side sessions — suffix match for canonicalization
  for (const tab of tabs) {
    if (tab.isAttached && tab.sessionKey && tab.id !== "tab-main") {
      let sess = sessions.find((s: unknown) => s.key === tab.sessionKey);
      if (!sess) {
        // Try suffix match: tab has "tinker:xxx", server has "agent:main:tinker:xxx"
        sess = sessions.find((s: unknown) => s.key.endsWith(":" + tab.sessionKey));
      }
      if (sess && tab.sessionKey !== sess.key) {
        // Upgrade to canonical key
        tab.sessionKey = sess.key;
        if (activeTabId === tab.id) {
          sessionKey = sess.key;
        }
      } else if (!sess) {
        // Session doesn't exist on server yet — keep tab (don't detach new tabs)
        // Only detach if tab was previously canonicalized (key contains "agent:")
        // FORK: Keep sessionKey for timeline/treemap lookups — only mark as unattached
        // so new messages can't be sent, but historical data is still accessible.
        if (tab.sessionKey!.startsWith("agent:")) {
          tab.isAttached = false;
        }
      }
    }
  }
  saveTabs();
  renderTabs();
  if (opts?.loadChat) {
    loadChat();
  }
}

async function loadChat() {
  if (!sessionKey) {
    return;
  }
  const keyAtStart = sessionKey;
  const res = await req("chat.history", { sessionKey, limit: 1000 }).catch(() => ({
    messages: [],
  }));
  // FORK: If user switched tabs while loading, write to that tab's state, not globals
  if (!sessionKeyMatches(keyAtStart)) {
    const targetTab = tabs.find((t) => sessionKeyMatches(keyAtStart, t.sessionKey ?? ""));
    if (targetTab) {
      const ts = tabStates.get(targetTab.id) ?? freshTabState();
      ts.messages = res.messages ?? [];
      // FORK 2026-05-09: reconstruct injection fields for background-tab history.
      // Also pull _promptStartedAt from server-side timestamp fields (Feature A).
      for (const m of ts.messages) {
        reconstructInjectionFields(m as Record<string, unknown>);
        const rec = m as Record<string, unknown>;
        if (rec.role === "user" && !rec._promptStartedAt) {
          const ts2 = rec.createdAtMs ?? rec.timestamp;
          if (typeof ts2 === "number") {
            rec._promptStartedAt = ts2;
          } else if (typeof ts2 === "string") {
            const parsed2 = Date.parse(ts2 as string);
            if (!isNaN(parsed2)) {
              rec._promptStartedAt = parsed2;
            }
          }
        }
      }
      ts.currentTurnNumber = ts.messages.filter((m: unknown) => m.role === "user").length;
      tabStates.set(targetTab.id, ts);
    }
    return;
  }
  streamMsgIdx = -1;
  lastDeltaLen = 0;
  lastDeltaAt = 0;
  messages = res.messages ?? [];
  // FORK 2026-05-09: Reconstruct _fullPrompt / _briefingPath for historical
  // user messages. The gateway persists the full injected prompt as the
  // message body; client-only metadata is lost on refresh. Split at the
  // injection separator so the bubble shows only the original user text.
  // Also pull _promptStartedAt from server-side timestamp fields (Feature A).
  for (const m of messages) {
    reconstructInjectionFields(m as Record<string, unknown>);
    const rec = m as Record<string, unknown>;
    if (rec.role === "user" && !rec._promptStartedAt) {
      const ts = rec.createdAtMs ?? rec.timestamp;
      if (typeof ts === "number") {
        rec._promptStartedAt = ts;
      } else if (typeof ts === "string") {
        const parsed = Date.parse(ts as string);
        if (!isNaN(parsed)) {
          rec._promptStartedAt = parsed;
        }
      }
    }
  }
  // Sync turn counter from loaded history
  const userMsgCount = messages.filter((m: unknown) => m.role === "user").length;
  currentTurnNumber = userMsgCount;
  // Restore persisted error messages (survive refresh)
  const storedErrors = loadPersistedErrors(sessionKey);
  if (storedErrors.length) {
    // Insert errors before the last assistant message (natural position),
    // or append at end if no assistant message follows.
    const lastAssistantIdx = findLastIndex(messages, (m: unknown) => m.role === "assistant");
    if (lastAssistantIdx >= 0) {
      messages.splice(lastAssistantIdx, 0, ...storedErrors);
    } else {
      messages.push(...storedErrors);
    }
  }
  updateChat();
  scrollChat();
  updateResponseMap();

  // FORK 2026-06-13 (eeg): backfill the seismograph from the context-anatomy API
  // on first load of a session (bible §5.8h q8), so a reload/restore shows the
  // session's history instead of an empty paper. BEST-EFFORT mapping — absent
  // fields simply omit the halo; failure must never break the panel or chat load.
  try {
    const eegSk = sessionKey;
    if (eegSk && getEegStore(eegSk).isEmpty) {
      const base = import.meta.env.DEV ? "http://localhost:18789" : "";
      const hdrs: Record<string, string> = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
      fetch(
        // limit=500: restore the WHOLE session on reload (permanent retention,
        // Oscar 2026-06-13) so all activity is scrollable, not just recent turns.
        `${base}/tinker/api/context-anatomy/${encodeURIComponent(eegSk)}?limit=500`,
        Object.keys(hdrs).length ? { headers: hdrs } : undefined,
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (!body) {
            return;
          }
          const events: any[] = Array.isArray(body) ? body : (body?.events ?? []);
          if (!events.length || !getEegStore(eegSk).isEmpty) {
            return;
          }
          const samples: EegSample[] = [];
          const ends: EegTurnEnd[] = [];
          let lastTurn: number | undefined;
          let lastRunId = "";
          for (let i = 0; i < events.length; i++) {
            const ev = (events[i] ?? {}) as any;
            const model = typeof ev.model === "string" ? ev.model : "";
            const ts =
              typeof ev.timestampMs === "number"
                ? ev.timestampMs
                : typeof ev.timestamp === "number"
                  ? ev.timestamp
                  : Date.now();
            const runId = typeof ev.runId === "string" && ev.runId ? ev.runId : `eeg-backfill-${i}`;
            samples.push({
              runId,
              model,
              provider:
                typeof ev.provider === "string" && ev.provider ? ev.provider : providerOf(model),
              chosenLevel: typeof ev.thinkLevel === "string" ? ev.thinkLevel : "",
              forced: false,
              subagent: false,
              parentRunId: undefined,
              ...(typeof ev.thinkingChars === "number" ? { thinkingChars: ev.thinkingChars } : {}),
              // tokens → segment length (area ∝ cost). Best-effort from anatomy.
              ...(() => {
                const inTok =
                  ev.inputTokens ?? ev.contextSent?.totalTokens ?? ev.tokensIn ?? undefined;
                const outTok = ev.outputTokens ?? ev.tokensOut ?? undefined;
                return {
                  ...(typeof inTok === "number" ? { inputTokens: inTok } : {}),
                  ...(typeof outTok === "number" ? { outputTokens: outTok } : {}),
                };
              })(),
              startedAt: ts,
              endedAt: undefined,
            });
            const turn = typeof ev.turn === "number" ? ev.turn : undefined;
            if (lastTurn != null && turn !== lastTurn) {
              ends.push({ turn: lastTurn, runId: lastRunId, endedAt: ts });
            }
            lastTurn = turn;
            lastRunId = runId;
          }
          if (lastTurn != null) {
            ends.push({ turn: lastTurn, runId: lastRunId, endedAt: Date.now() });
          }
          getEegStore(eegSk).backfill(samples, ends);
          eegTurnCounters.set(eegSk, Math.max(eegTurnCounters.get(eegSk) ?? 0, lastTurn ?? 0));
          updateBudgetPanel();
        })
        .catch(() => {});
    }
  } catch {
    /* eeg backfill must never break chat load */
  }

  // Tab titles are persisted in localStorage — no regeneration on load.
  // Title generation happens in send() on first prompt and every N prompts.
}

// FORK 2026-06-04 — bug task-mppceqsu-24yex (Tab context loads only on switching tabs).
// Proactively hydrate a background/restored tab's transcript so its content is present
// BEFORE the user switches to it. Previously every non-active tab was born empty
// (freshTabState → messages:[]) and only fetched its history the moment it was clicked
// (switchToTab → loadChat), so background tabs showed nothing until selected. This writes
// straight into the tab's own TabState — never the active/global `messages` — mirroring
// loadChat's background-tab write path (lines ~3380-3404). The on-switch loadChat()
// remains the freshness refresh; this just removes the empty-until-clicked gap.
async function hydrateTab(tab: Tab): Promise<void> {
  if (!tab.sessionKey || !tab.isAttached || tab.id === activeTabId) {
    return;
  }
  const ts = tabStates.get(tab.id) ?? freshTabState();
  // Already has content — skip so we never clobber a tab the user already populated;
  // on-switch loadChat() will refresh it for staleness.
  if (ts.messages.length > 0) {
    return;
  }
  const res = await req("chat.history", { sessionKey: tab.sessionKey, limit: 1000 }).catch(() => ({
    messages: [],
  }));
  // The user may have switched INTO this tab mid-fetch — if it's now active, let
  // loadChat() own the write (it sets globals + renders); don't double-write here.
  if (tab.id === activeTabId) {
    return;
  }
  const target = tabStates.get(tab.id) ?? ts;
  target.messages = res.messages ?? [];
  for (const m of target.messages) {
    reconstructInjectionFields(m as Record<string, unknown>);
    const rec = m as Record<string, unknown>;
    if (rec.role === "user" && !rec._promptStartedAt) {
      const t2 = rec.createdAtMs ?? rec.timestamp;
      if (typeof t2 === "number") {
        rec._promptStartedAt = t2;
      } else if (typeof t2 === "string") {
        const parsed = Date.parse(t2 as string);
        if (!isNaN(parsed)) {
          rec._promptStartedAt = parsed;
        }
      }
    }
  }
  target.currentTurnNumber = target.messages.filter((m: unknown) => m.role === "user").length;
  tabStates.set(tab.id, target);
}

// FORK 2026-06-04 — task-mpzcjw6n (auto-rename fix): generateTabTitle hardcoded
// "qwen3:14b-q4_K_M", which is NOT installed on this box (only gemma4:26b + an embed model), so
// every auto-name (the menu button AND the periodic titler) silently 404'd and looked broken.
// Resolve an AVAILABLE ollama chat model dynamically (cached), excluding embedding models, so it
// works regardless of which model is pulled. Returns null (→ caller skips) if ollama is down or
// only embedding models exist.
let _ollamaTitleModel: string | null | undefined = undefined;
async function resolveOllamaTitleModel(): Promise<string | null> {
  if (_ollamaTitleModel !== undefined) {
    return _ollamaTitleModel;
  }
  try {
    const res = await fetch("http://localhost:11434/api/tags")
      .then((r) => r.json())
      .catch(() => null);
    const names: string[] = ((res?.models ?? []) as Array<{ name?: string }>)
      .map((m) => m?.name ?? "")
      .filter(Boolean);
    const isEmbed = (n: string) => /embed/i.test(n);
    // Prefer a fast small instruct model if present, else the first non-embedding model installed.
    const preferred = [
      "qwen3:14b-q4_K_M",
      "qwen2.5:7b",
      "llama3.2:3b",
      "llama3.1:8b",
      "gemma4:26b",
    ];
    _ollamaTitleModel =
      preferred.find((p) => names.includes(p)) ?? names.find((n) => !isEmbed(n)) ?? null;
  } catch {
    _ollamaTitleModel = null;
  }
  return _ollamaTitleModel;
}

async function generateTabTitle(tab: Tab) {
  if (!tab.sessionKey || tab.id === "tab-main") {
    return;
  }

  // FORK: Use tabStates for non-active tabs so title gen works for background tabs too
  const tabMessages =
    tab.sessionKey === sessionKey ? messages : (tabStates.get(tab.id)?.messages ?? []);
  // FORK 2026-06-10 — u3-tab-naming: build the summary primarily from the USER's
  // own prompts (their intent — short + signal-dense), recency-weighted, and fall
  // back to the latest assistant reply only when the user's prompts are too thin.
  const msgText = (m: unknown): string => {
    if (!m?.content) return "";
    const t = Array.isArray(m.content)
      ? m.content
          .filter((b: unknown) => b.type === "text")
          .map((b: unknown) => b.text)
          .join(" ")
      : String(m.content);
    return t.trim();
  };
  const userPrompts: string[] = [];
  let lastAssistant = "";
  for (let i = tabMessages.length - 1; i >= 0; i--) {
    const m = tabMessages[i];
    const role = (m?.role || "").toLowerCase();
    const text = msgText(m);
    if (!text) continue;
    if (role === "user") {
      // Newest prompt gets the lion's share of the budget.
      userPrompts.unshift(text.slice(0, userPrompts.length === 0 ? 600 : 200));
      if (userPrompts.length >= TAB_TITLE_INTERVAL) break;
    } else if (role === "assistant" && !lastAssistant) {
      lastAssistant = text.slice(0, 200);
    }
  }

  if (userPrompts.length === 0) {
    return;
  }

  // FORK 2026-06-04 — task-mpzcjw6n (auto-rename fix): use an INSTALLED ollama model, not a
  // hardcoded one that may be absent. Skip gracefully if none is available.
  const titleModel = await resolveOllamaTitleModel();
  if (!titleModel) {
    console.log("[tabs] auto-name skipped — no ollama chat model installed (only embed/none)");
    return;
  }

  // FORK 2026-06-10 — u3-tab-naming: gather the OTHER tabs' deliberate (locked) names so the model
  // can make THIS one distinct, then ask for a short, specific, prompt-driven title with one
  // relevant leading emoji.
  const siblingTitles = tabs
    .filter((t) => t.id !== tab.id && t.id !== "tab-main" && t.titleLocked && t.title)
    .map((t) => {
      const e = leadingEmoji(t.title);
      return (e ? t.title.slice(e.length) : t.title).trim();
    })
    .filter((s) => s.length > 0)
    .slice(0, 8);
  const prompt = [
    `Give this chat tab a SHORT, SPECIFIC name (it shows in a narrow tab strip) that captures what I am working on in THIS conversation and what makes it DIFFERENT from my other tabs.`,
    `Base it on MY messages below — my intent is what matters; the assistant's replies are only secondary context.`,
    siblingTitles.length
      ? `My OTHER tabs are already named: ${siblingTitles.join("; ")}. Make THIS name clearly distinct from those — name what is unique here; do not reuse their words or settle for a generic shared theme.`
      : "",
    `Reply with ONLY: one emoji relevant to the topic, then a space, then 2-4 words. No quotes, no trailing punctuation. Examples: 🔧 Auth token refresh — 📊 Q3 revenue model — 🐛 Flaky CI retries.`,
    ``,
    `My recent messages (oldest to newest):`,
    userPrompts.map((p) => `- ${p}`).join("\n"),
    lastAssistant ? `\n(Assistant context, secondary: ${lastAssistant})` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  try {
    // Try local Ollama first (free, fast)
    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: titleModel, prompt, stream: false }),
    })
      .then((r) => r.json())
      .catch(() => null);

    let title = ollamaRes?.response?.trim();

    // Strip any quotes or punctuation wrapping
    if (title) {
      title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
    }

    console.log("[tabs] ollama response:", JSON.stringify(ollamaRes));
    if (title && title.length > 0 && title.length <= 48) {
      // FORK 2026-06-06 \u2014 u2-tab-naming: KEEP a relevant leading emoji.
      // 1) split off any leading emoji the LLM returned (per the prompt) from the word part.
      const preferred = leadingEmoji(title);
      const words = preferred ? title.slice(preferred.length).trim() : title.trim();
      // 2) choose a final icon that is RELEVANT to the summary and NOT already used by another tab
      //    (preferred LLM emoji \u2192 summary-mapped emoji \u2192 AUTO_NAME_ICON sentinel \u2192 next free catalog
      //    emoji). This guarantees every tab's leading icon is distinct.
      const icon = pickUniqueTabIcon(preferred, words, tab.id);
      tab.title = words ? `${icon} ${words}` : `${icon} ${title.trim()}`;
      // 3) lock the title so loadSessions() won't clobber it with the server fortune-cookie phrase;
      //    persists via saveTabs() so it survives hard refresh AND gateway restart.
      tab.titleLocked = true;
      console.log("[tabs] title updated to:", tab.title);
      renderTabs();
      saveTabs();
      // FORK 2026-06-10 — u3-tab-naming: persist the auto-name server-side so it survives any
      // restart/browser/device, not just this browser's localStorage.
      persistTabNameToServer(tab);
      updateSessionsPanel();
    } else {
      console.log("[tabs] title rejected — length:", title?.length, "value:", title);
    }
  } catch (err) {
    console.error("[tabs] generateTabTitle error:", err);
  }
}

async function send(text: string) {
  if (!text.trim()) {
    return;
  }

  // FORK (2026-04-20, rewired 2026-04-27): /clear wipes the UI immediately
  // and routes the OLD sessionKey through `sessions.reset` so the gateway
  // archives the transcript (soft-delete per bible §5.5), mints a fresh
  // sessionId on the same key, and fires the full plugin lifecycle
  // (`command:reset` → `before_reset` → `session_end` → `session_start`).
  // The session-memory hook saves the prior context to memory, and
  // — because the OpenClaw sessionId is now part of the cc-bridge
  // worker-pool key (see `extensions/tinkerclaw-cc-bridge/src/stream.ts:
  // deriveSessionKey`) — the next message lands on a fresh claude-cli
  // worker without `--resume`, so Jarvis's underlying memory resets too.
  // No LLM call is fired; /clear stays a zero-token operation.
  //
  // The tab's local sessionKey ALSO rotates to a new `tinker:<ts>` (so
  // history reload can't accidentally surface the old transcript while
  // the reset RPC is still in flight) — but the reset is what does the
  // real work server-side. /new keeps its own path (chat.send "/new")
  // because it intentionally fires a BRIEFING.md prelude through the
  // model.
  if (text.trim() === "/clear") {
    messages = [];
    streamMsgIdx = -1;
    streamRunId = null;
    lastDeltaLen = 0;
    lastDeltaAt = 0;
    sending = false;
    currentTurnNumber = 0;
    expandedTools = new Set();

    const oldSessionKey = sessionKey;
    const clearTab = tabs.find((t) => t.id === activeTabId);

    // FORK 2026-05-25 — tab-main does NOT rotate its sessionKey on
    // /clear. It stays on `agent:main:main` (the canonical main slot)
    // for its entire life. sessions.reset below archives the old
    // transcript on the SAME key and the gateway mints a fresh
    // underlying cc-bridge worker / claude-cli sessionId so memory
    // does reset — only the OpenClaw-level session key is preserved.
    //
    // Why this matters: before 2026-05-25 every /clear rotated
    // tab-main to a brand-new `tinker:<ts>`. The original
    // `agent:main:main` was left on disk as an orphan with its own
    // content. The side panel surfaced BOTH as "🏠 Main" (the orphan
    // via key-suffix protectedLabel, the rotated one via tab.title),
    // and clicking the orphan opened a new tab pointing at content
    // tab-main was no longer bound to. By keeping tab-main pinned to
    // `agent:main:main`, the orphan can't arise — there's always
    // exactly one canonical "🏠 Main."
    //
    // Non-main tabs still rotate to a fresh `tinker:<ts>` on /clear;
    // their original keys also archive via sessions.reset.
    const isMainTab = clearTab?.id === "tab-main";
    const freshKey =
      isMainTab && oldSessionKey ? oldSessionKey : `tinker:${Date.now().toString(36)}`;
    sessionKey = freshKey;
    if (clearTab) {
      clearTab.sessionKey = freshKey;
      clearTab.isAttached = true;
      const ts = tabStates.get(clearTab.id);
      if (ts) {
        ts.messages = [];
        ts.currentTurnNumber = 0;
      }
      saveTabs();
      renderTabs();
    }

    updateChat();
    scrollChat();
    // FORK 2026-06-11 — tinkerui-slider: /clear rotated `sessionKey` (above, for
    // non-main tabs); re-paint the Models panel so the thinking slider reflects the
    // freshly-rotated key rather than the archived session's state.
    updateBudgetPanel();

    // Server-side cascade. Fire-and-forget; failures are non-fatal — worst
    // case the next chat.send auto-creates a fresh entry on the new key.
    if (oldSessionKey) {
      req("sessions.reset", { key: oldSessionKey, reason: "reset" }).catch(() => {});
      // FORK 2026-05-26 (task-mpkw1a0b-9jsfy follow-on, user instruction:
      // "I keep typing /clear in the main chat but new messages appear
      // all the time without me typing them, plus responses that
      // indicate tokens are being wasted"):
      //
      // Restart-continue auto-fires for any plan with status="in_progress"
      // — including plans Jarvis never marked closed even though the turn
      // finished successfully. /clear is the user's signal that THIS
      // sessionKey's work is done; the plan should die with it. Without
      // this abandon call, every subsequent gateway restart would
      // re-fire the resume chip → cc-bridge spawn → token burn → another
      // bubble the user didn't ask for.
      //
      // tab-main keeps its sessionKey across /clear (per the fork at
      // line ~3385), so abandoning oldSessionKey IS abandoning the
      // canonical main plan. Non-main tabs rotate, but their oldSessionKey
      // (the about-to-be-archived one) ALSO had any pending plan, so
      // abandoning it before the rotation locks in the user's intent.
      req("prefrontal.plan.close", {
        sessionKey: oldSessionKey,
        status: "abandoned",
        note: "Closed by /clear — user signalled session work is done.",
      }).catch(() => {});
    }
    return;
  }

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // If no session (unattached tab), create one by generating a key
  // (the gateway auto-creates sessions on first chat.send)
  if (!sessionKey && activeTab && !activeTab.isAttached) {
    const newKey = `tinker:${Date.now().toString(36)}`;
    sessionKey = newKey;
    activeTab.sessionKey = newKey;
    activeTab.isAttached = true;
    saveTabs();
    renderTabs();
  }

  if (!sessionKey) {
    return;
  }

  const isFirstMessage = messages.length === 0;
  // FORK: Mark message as queued only if THIS session has an active run
  const hasActiveRunForSession = Array.from(activeRuns.values()).some(
    (r) => r.sessionKey && sessionKeyMatches(r.sessionKey),
  );
  const isQueued = hasActiveRunForSession || streamRunId != null;
  if (!isQueued) {
    sending = true;
  }
  currentTurnNumber++;
  // FORK 2026-04-18: Show the USER'S TEXT in the bubble, but stash the full
  // injected prompt (with amygdala/fractal instructions) on the message so
  // the renderer can offer a click-to-expand view. `_fullPrompt` holds the
  // actual string that was sent to claude — useful both for debugging and
  // for the user to confirm what instructions landed with their turn.
  const fullPromptForDebug = await buildInjectedPrompt(text);
  const hasInjection = fullPromptForDebug.length > text.length + 16;
  // Detect briefing injection by header sentinel, distinguishes from amygdala/fractal injections.
  const isBriefingInjection =
    /^\/(new|reset)$/i.test(text.trim()) &&
    fullPromptForDebug.includes("Execute the morning briefing NOW");
  let briefingPath: string | undefined;
  if (isBriefingInjection) {
    const m = fullPromptForDebug.match(/Briefing source: `([^`]+)`/);
    if (m) {
      briefingPath = m[1];
    }
  }
  // FORK 2026-05-09: Capture wall-clock send time so the user bubble can show
  // an absolute HH:MM:SS timestamp on its left gutter (Feature A). Also used
  // by assistant bubbles to compute elapsed seconds (Feature B).
  const outgoingUserMsg: Record<string, unknown> = {
    role: "user",
    content: [{ type: "text", text }],
    _promptStartedAt: Date.now(),
    ...(hasInjection ? { _fullPrompt: fullPromptForDebug } : {}),
    ...(briefingPath ? { _briefingPath: briefingPath } : {}),
    // FORK 2026-06-08: tag the queued bubble with the session it was queued under so it renders
    // ONLY in its own tab and can be settled when THAT session's turn ends (not just when the
    // session happens to be the one on screen). Fixes "stuck queued" + "queued in every tab".
    ...(isQueued ? { _queued: true, _queuedSession: sessionKey } : {}),
  };
  if (isQueued) {
    // FORK 2026-06-04 — bug task-mpwfiot2: hold the queued bubble OUT of messages[] (see the
    // pendingQueuedSends declaration). It renders as a trailing "queued" bubble and is flushed
    // into messages[] when the in-flight turn ends, so the running turn's later bubbles can
    // never jump above it.
    pendingQueuedSends.push(outgoingUserMsg);
  } else {
    messages.push(outgoingUserMsg);
  }
  updateChat();
  if (!isQueued) {
    updateBtn();
  }
  scrollChat();

  // FORK 2026-04-18: Amygdala + Fractal injection.
  // The user sees ONLY `text` in their bubble (with a click-to-expand hint
  // showing the full prompt if instructions were appended). The gateway
  // receives `text + optional instruction suffix` so Opus emits a structured
  // reply (💬 ANSWER → 🧠 AMYGDALA → 🌿 FRACTAL).
  const messageForGateway = fullPromptForDebug;

  // FORK 2026-06-07 — the saved draft is dropped ONLY on a CONFIRMED send. A failed send (e.g. the
  // gateway is down / restarting) MUST keep the draft and put the text back in the composer, so a
  // failed "enter" can never lose what you typed.
  const draftTabId = activeTabId;
  let sendOk = false;
  await req("chat.send", {
    sessionKey,
    message: messageForGateway,
    idempotencyKey: uuid(),
  })
    .then(() => {
      sendOk = true;
    })
    .catch((e) => {
      console.error(e);
      sending = false;
      updateBtn();
    });
  if (draftTabId) {
    if (sendOk) {
      // confirmed → safe to drop the saved draft (clearDraftFor archives it into the ring first)
      clearDraftFor(draftTabId);
      const st = tabStates.get(draftTabId);
      if (st) st.draft = "";
    } else {
      // FAILED — keep the draft persisted and restore the text into the composer so it's not lost.
      saveDraftFor(draftTabId, text);
      const st = tabStates.get(draftTabId);
      if (st) st.draft = text;
      if (activeTabId === draftTabId) {
        const ta2 = $("chat-textarea") as HTMLTextAreaElement | null;
        if (ta2 && !ta2.value.trim()) {
          ta2.value = text;
          ta2.dispatchEvent(new Event("input"));
        }
      }
    }
  }
  // FORK: After first message in a tab session, refresh to canonicalize key
  if (isFirstMessage) {
    loadSessions();
  }
}

function retryProvider(provider: string) {
  // Clear provider-level, per-profile, and per-model error state
  providerErrors.delete(provider);
  for (const k of providerErrors.keys()) {
    if (k.startsWith(provider + ":") || k.startsWith(provider + "/")) {
      providerErrors.delete(k);
    }
  }
  persistProviderErrors();
  updateBudgetPanel();
  // Remove error messages from this provider and re-render
  streamMsgIdx = -1;
  lastDeltaLen = 0;
  lastDeltaAt = 0;
  messages = messages.filter(
    (m) => !((m._isError || m._isWarning) && m._retryProvider === provider),
  );
  clearPersistedErrors(sessionKey);
  // Find last user message and resend
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i].role ?? "").toLowerCase() === "user") {
      const text = Array.isArray(messages[i].content)
        ? messages[i].content
            .filter((b: unknown) => b.type === "text")
            .map((b: unknown) => b.text)
            .join("\n")
        : typeof messages[i].content === "string"
          ? messages[i].content
          : "";
      if (text.trim()) {
        // Remove the user message — send() will re-add it
        messages.splice(i, 1);
        send(text.trim());
        return;
      }
    }
  }
  // No user message found — just refresh
  updateChat();
}

async function abort() {
  await req("chat.abort", { sessionKey }).catch(() => {});
  messages = messages.filter((m: unknown) => !m._temporary);
  streamMsgIdx = -1;
  lastDeltaLen = 0;
  lastDeltaAt = 0;
  streamRunId = null;
  // FORK 2026-05-16: chat.abort only aborts THIS session server-side, so only
  // drop THIS session's runs locally. The old `activeRuns.clear()` nuked every
  // other tab's live run from the indicator too (multi-tab regression).
  for (const [runId, info] of [...activeRuns]) {
    if (runBelongsToViewedSession(info)) {
      activeRuns.delete(runId);
    }
  }
  saveActiveRuns();
  sending = viewedSessionBusy();
  updateChat();
  updateBtn();
}

async function loadBudget() {
  const [s, mc, bu] = await Promise.all([
    req("budget.status", {}).catch(() => null),
    req("config.models", {}).catch(() => null),
    req("budget.usage", {}).catch(() => null),
  ]);
  _budgetData = { budget: null, status: s };
  if (mc) {
    modelConfigData = mc;
  }
  budgetUsageData = bu;
  updateBudgetPanel();
}

// ─── Render Helpers ───
function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function md(text: string): string {
  // Ensure a blank line before table-header rows so markdown-it parses them
  // as tables even when they follow a list or paragraph with no gap.
  const fixed = text.replace(/([^\n])\n(\|[^\n]+\|\s*\n\|[\s:|-]+\|\s*\n)/g, "$1\n\n$2");
  let h = mdParser.render(fixed);

  // Jarvis voice styling
  h = h.replace(
    /<strong>Jarvis:<\/strong>\s*<em>(.*?)<\/em>/gi,
    '<strong>Jarvis:</strong> <span class="jarvis-voice">$1</span>',
  );
  // FORK 2026-06-10 (amygdala retirement): the pink "🧠 AMYGDALA:" inline-nudge
  // styling was removed. The per-turn amygdala section is retired — any residual
  // amygdala text the model still emits renders as plain inline prose, not a
  // special pink-highlighted line. Fractal styling stays.
  // Fractal reflection styling (green)
  h = h.replace(
    /<strong>🌿 FRACTAL:<\/strong>\s*<em>(.*?)<\/em>/gi,
    '<strong style="color:#2ECC71">🌿 FRACTAL:</strong> <em style="color:#2ECC71">$1</em>',
  );
  // FORK 2026-04-18: wrap absolute or ~/ paths (rendered as inline <code>
  // by markdown-it) in a clickable span that opens the file in the OS
  // default viewer via the `config.openExternalFile` RPC. Also matches
  // bare paths in plain text for pointer-style instructions.
  h = h.replace(
    /<code>(~\/[\w./-]+\.(?:md|txt|ts|js|json|yaml|yml|png|jpg|jpeg|pdf)|\/(?:home|usr|tmp|var|opt|etc)\/[\w./-]+\.(?:md|txt|ts|js|json|yaml|yml|png|jpg|jpeg|pdf))<\/code>/g,
    '<code class="fs-link" data-path="$1" title="Click to open in system viewer">$1</code>',
  );
  // FORK 2026-05-10: ALSO wrap bare filenames (no slash, just `BRIEFING.md`)
  // as clickable. Resolution to an absolute path is deferred to click time
  // via the `files.resolveBareName` RPC — that way the markdown render stays
  // synchronous and we avoid an RPC per render. Skip anything that already
  // got the .fs-link class above. The whitelist of extensions matches the
  // server-side allowlist behavior (we don't want `report.docx` resolving
  // because it's neither a text file nor an OS-openable doc here).
  h = h.replace(
    /<code>([A-Za-z][\w.-]*\.(?:md|txt|ts|tsx|js|json|yaml|yml|png|jpg|jpeg|pdf|sh|py|css|html|toml|ini))<\/code>/g,
    (full, name) => {
      // If this <code> is already the start of an fs-link replacement (the
      // earlier regex would have transformed it), skip. We can't easily look
      // back through the string here, but the earlier regex always rewrites
      // <code> → <code class="fs-link" so by the time we get here the bare
      // <code> tag is guaranteed not to overlap with an absolute-path <code>.
      const safe = String(name).replace(/"/g, "&quot;");
      return `<code class="fs-link fs-link-bare" data-name="${safe}" title="Click to find &amp; open ${safe}">${name}</code>`;
    },
  );
  return h;
}

// ─── Smart Tool Summaries ───
function shortenPath(s: string): string {
  return s.replace(/\/home\/[^/]+/g, "~");
}

function fileName(p: string): string {
  return p.split("/").pop() ?? p;
}

function extractGrepTarget(cmd: string): string {
  // Extract the search pattern from grep commands
  const m = cmd.match(/grep\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

function _extractGrepFiles(cmd: string): string {
  // Get the last path-like argument
  const parts = cmd.split(/\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes("/")) {
      return fileName(shortenPath(parts[i]));
    }
  }
  return "";
}

function editPreview(s: string): string {
  // Return first meaningful line of a string, trimmed
  const line = s.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return line.length > 60 ? line.slice(0, 57) + "…" : line;
}

function toolSummary(name: string, input: unknown): string {
  const n = (name ?? "").toLowerCase();
  const a = input ?? {};
  switch (n) {
    case "exec": {
      const cmd = shortenPath(String(a.command ?? ""));
      if (cmd.match(/^grep\b/)) {
        const target = extractGrepTarget(cmd);
        return target
          ? `Looking for any mention of "${target}" across the code`
          : `Searching through the code for a specific pattern`;
      }
      if (cmd.match(/^find\b/)) {
        const nameM = cmd.match(
          /-name\s+"([^"]+)"|--name\s+"([^"]+)"|-name\s+'([^']+)'|-name\s+(\S+)/,
        );
        const what = nameM ? (nameM[1] ?? nameM[2] ?? nameM[3] ?? nameM[4]) : "something";
        return `Scanning the project to locate ${what}`;
      }
      if (cmd.startsWith("ls")) {
        return `Checking what's inside a folder`;
      }
      if (cmd.startsWith("cat")) {
        return `Reading the contents of a file`;
      }
      if (cmd.startsWith("kill")) {
        return `Stopping something that was running`;
      }
      if (cmd.includes("pnpm build") || cmd.includes("npm build")) {
        return `Compiling all recent changes so they take effect`;
      }
      if (cmd.includes("pnpm test") || cmd.includes("npm test")) {
        return `Running automated checks to make sure nothing is broken`;
      }
      if (cmd.includes("pnpm install") || cmd.includes("npm install")) {
        return `Setting up the required software components`;
      }
      if (cmd.match(/^curl\b/)) {
        const urlM = cmd.match(/https?:\/\/([^/\s"']+)/);
        return urlM
          ? `Requesting information from ${urlM[1]}`
          : `Requesting information from the internet`;
      }
      if (cmd.startsWith("jarvis")) {
        const textM = cmd.match(/jarvis\s+"([^"]+)"|jarvis\s+'([^']+)'/);
        const speech = textM ? (textM[1] ?? textM[2] ?? "").slice(0, 80) : "";
        return speech ? `Saying out loud: "${speech}"` : `Speaking a response out loud`;
      }
      if (cmd.startsWith("which")) {
        const bins = cmd.replace(/^which\s+/, "").trim();
        return `Checking whether ${bins} is available on this machine`;
      }
      if (cmd.startsWith("ps ")) {
        return `Checking what programs are currently running`;
      }
      if (cmd.startsWith("sed")) {
        return `Making a quick text replacement in a file`;
      }
      if (cmd.includes("git pull")) {
        return `Downloading the latest version of the code`;
      }
      if (cmd.includes("git push")) {
        return `Uploading the changes so others can see them`;
      }
      if (cmd.includes("git commit")) {
        return `Saving the current changes as a named checkpoint`;
      }
      if (cmd.includes("git diff")) {
        return `Comparing what changed between two versions`;
      }
      if (cmd.includes("git ")) {
        return `Doing some version tracking housekeeping`;
      }
      if (cmd.startsWith("echo")) {
        return `Printing a note`;
      }
      if (cmd.startsWith("sleep")) {
        return `Pausing briefly before the next step`;
      }
      if (cmd.startsWith("nohup") || cmd.startsWith("setsid")) {
        return `Starting a long-running task in the background`;
      }
      return `Performing a system operation`;
    }
    case "read":
      return `Reading a section of the code to understand how it works`;
    case "edit": {
      const oldStr = String(a.old_string ?? a.oldText ?? "");
      const newStr = String(a.new_string ?? a.newText ?? "");
      const oldP = editPreview(oldStr);
      const newP = editPreview(newStr);
      if (oldStr && !newStr) {
        return `Removing: "${oldP}"`;
      }
      if (!oldStr && newStr) {
        return `Adding: "${newP}"`;
      }
      return `Changing "${oldP}" to "${newP}"`;
    }
    case "write":
      return `Creating a new file with the necessary content`;
    case "process": {
      const act = a.action ?? "?";
      if (act === "poll") {
        return `Waiting for a background task to finish`;
      }
      if (act === "kill") {
        return `Stopping a background task`;
      }
      if (act === "log") {
        return `Checking the output of a background task`;
      }
      if (act === "list") {
        return `Looking at what's running in the background`;
      }
      return `Managing a background task`;
    }
    case "memory_search":
      return `Searching through past notes for "${a.query ?? ""}"`;
    case "memory_get":
      return `Pulling up a previous note from memory`;
    case "web_search":
      return `Looking up "${a.query ?? ""}" on the internet`;
    case "web_fetch": {
      const url = String(a.url ?? "");
      const domain = url.match(/https?:\/\/([^/]+)/)?.[1] ?? "";
      return domain ? `Reading a page from ${domain}` : `Reading a web page`;
    }
    case "message": {
      const act = a.action ?? "send";
      const target = a.target ?? a.to ?? "someone";
      if (act === "send") {
        return `Sending a message to ${target}`;
      }
      if (act === "react") {
        return `Reacting to a message`;
      }
      return `Performing a messaging action with ${target}`;
    }
    case "browser": {
      const act = a.action ?? "?";
      if (act === "screenshot") {
        return `Taking a picture of what's on screen`;
      }
      if (act === "snapshot") {
        return `Reading the layout of the web page`;
      }
      if (act === "open") {
        return `Opening a web page in the browser`;
      }
      if (act === "navigate") {
        return `Going to a different web page`;
      }
      if (act === "act") {
        return `Clicking or typing something on the page`;
      }
      return `Doing something in the browser`;
    }
    case "image":
      return a.prompt
        ? `Looking at an image to ${String(a.prompt).slice(0, 80)}`
        : `Examining an image`;
    case "whatsapp_history": {
      const act = a.action ?? "?";
      if (act === "search" && a.query) {
        return `Searching WhatsApp messages for "${a.query}"`;
      }
      if (act === "search" && a.chat) {
        return `Reading a WhatsApp conversation`;
      }
      if (act === "search") {
        return `Going through recent WhatsApp messages`;
      }
      if (act === "stats") {
        return `Checking how many WhatsApp messages there are`;
      }
      return `Doing something with WhatsApp`;
    }
    case "sessions_spawn":
      return `Starting a helper to work on: ${String(a.task ?? "").slice(0, 80)}`;
    case "subagents": {
      const act = a.action ?? "?";
      if (act === "list") {
        return `Checking on helpers that are working in parallel`;
      }
      if (act === "kill") {
        return `Telling a helper to stop`;
      }
      if (act === "steer") {
        return `Giving new instructions to a helper`;
      }
      return `Managing helpers`;
    }
    case "tts":
      return `Saying out loud: "${String(a.text ?? "").slice(0, 80)}"`;
    case "session_status":
      return `Checking how much time and resources this conversation has used`;
    case "pdf":
      return a.prompt
        ? `Reading a PDF document to ${String(a.prompt).slice(0, 80)}`
        : `Reading a PDF document`;
    default:
      return `Performing an action`;
  }
}

function toolExpandedDetail(name: string, input: unknown): string {
  const n = (name ?? "").toLowerCase();
  const a = input ?? {};
  const p = shortenPath(String(a.file_path ?? a.path ?? ""));
  switch (n) {
    case "exec":
      return `<div class="explanation">Ran shell command:</div><div class="code-block">${esc(String(a.command ?? ""))}</div>`;
    case "edit": {
      const oldStr = String(a.old_string ?? a.oldText ?? "");
      const newStr = String(a.new_string ?? a.newText ?? "");
      return `<div class="explanation">Edited ${p} — replaced ${oldStr.length} chars with ${newStr.length} chars:</div><del>${esc(oldStr)}</del><ins>${esc(newStr)}</ins>`;
    }
    case "read":
      return `<div class="explanation">Read ${p}${a.offset ? `, lines ${a.offset}–${(a.offset ?? 0) + (a.limit ?? 0)}` : ""}:</div>`;
    case "write":
      return `<div class="explanation">Wrote ${String(a.content ?? "").length} chars to ${p}:</div><div class="code-block">${esc(String(a.content ?? ""))}</div>`;
    case "memory_search":
      return `<div class="explanation">Searched memory for: "${esc(String(a.query ?? ""))}"</div>`;
    case "web_search":
      return `<div class="explanation">Web search: "${esc(String(a.query ?? ""))}"</div>`;
    case "web_fetch":
      return `<div class="explanation">Fetched URL: ${esc(String(a.url ?? ""))}</div>`;
    case "process":
      return `<div class="explanation">Process ${esc(String(a.action ?? "?"))} on session ${esc(String(a.sessionId ?? "?"))}${a.timeout ? ` (timeout: ${a.timeout}ms)` : ""}:</div>`;
    default: {
      // Formatted key-value pairs instead of raw JSON
      const entries = Object.entries(a);
      if (entries.length === 0) {
        return `<div class="explanation">${esc(name ?? "tool")} (no parameters)</div>`;
      }
      let out = `<div class="explanation">${esc(name ?? "tool")}:</div>`;
      for (const [k, v] of entries) {
        const vs = typeof v === "string" ? v : JSON.stringify(v);
        out += `<div><span class="kv-label">${esc(k)}:</span> ${esc(shortenPath(String(vs)))}</div>`;
      }
      return out;
    }
  }
}

/** Extract file paths from text (absolute paths like /home/... or ~/...) */
function extractFilePaths(text: string): string[] {
  const matches = text.match(/(?:\/[\w./-]+\.[a-zA-Z0-9]+|~\/[\w./-]+\.[a-zA-Z0-9]+)/g);
  return matches ? [...new Set(matches)] : [];
}

// FORK 2026-04-18: Amygdala + Fractal injection ----------------------------
// Client-side, single-turn injection. The user's prompt, optionally wrapped
// with an instruction suffix, flows through one normal turn — Opus 4.7 emits
// a 3-section structured response (🧠 AMYGDALA → 💬 ANSWER → 🌿 FRACTAL).
// This replaces the two-turn sessions.steer dance the old fractal-reflection
// plugin used, eliminating the lane-race entirely.
const AMY_FRA_TOGGLES_KEY = "tinker-amy-fra-toggles";
// FORK 2026-06-10 (amygdala retirement): the `amygdala` toggle is gone — the
// per-turn amygdala injection was removed, so only the fractal toggle remains.
type InjectToggles = { fractal: boolean };
function loadInjectToggles(): InjectToggles {
  try {
    const raw = localStorage.getItem(AMY_FRA_TOGGLES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        fractal: parsed.fractal !== false,
      };
    }
  } catch {
    /* fall through */
  }
  return { fractal: true };
}
function saveInjectToggles(t: InjectToggles): void {
  try {
    localStorage.setItem(AMY_FRA_TOGGLES_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}
let injectToggles = loadInjectToggles();
function applyInjectToggleChrome(): void {
  // FORK 2026-06-07: amygdala top button + per-turn section removed; the live
  // Amygdala panel stays always-visible in the right rail. Only fractal toggles.
  const fra = document.getElementById("tb-fractal");
  if (fra) {
    fra.classList.toggle("tb-active", injectToggles.fractal);
  }
}
// FORK 2026-04-18: UI injection is now minimal — the detailed rules for
// each section live in the system prompt (appended by cc-bridge/worker.ts
// from amygdala-prompt.md + fractal-prompt.md). The per-turn injection
// just names which sections to emit and in what order. Opus pulls the
// content from its system-prompt context.
//
// FORK 2026-04-21: for `/new` and `/reset`, replace the amygdala/fractal
// suffix with a pointer to BRIEFING.md. Two reasons:
//   1. Appending the ANSWER/AMYGDALA/FRACTAL template to /new makes
//      bodyStripped non-empty on the server, which bypasses the
//      isBareSessionReset → SESSION.md → BRIEFING.md path entirely. That's
//      why /new wasn't producing the briefing before.
//   2. The user wants to see the BRIEFING.md path in the expandable _fullPrompt
//      so they can edit that file directly to change the briefing format,
//      without digging through amygdala/fractal noise unrelated to /new.
//
// FORK 2026-05-09: buildBriefingPrompt injects the resolved BRIEFING.md
// content directly so Jarvis executes it without a read-file round-trip.
// Called by buildInjectedPrompt when briefing.resolve RPC succeeds.
function buildBriefingPrompt(briefingPath: string, content: string): string {
  return (
    "/new\n\n---\n\n" +
    "**Execute the morning briefing NOW.** Begin by running every step in the briefing below, top to bottom, without asking permission. The user already requested the briefing by typing `/new`. Do not ask whether to proceed — proceed.\n\n" +
    "Briefing source: `" +
    briefingPath +
    "`\n\n" +
    "---\n\n" +
    content
  );
}

async function buildInjectedPrompt(userText: string): Promise<string> {
  const trimmed = userText.trim();
  // FORK 2026-05-09: try briefing.resolve RPC to inline the full BRIEFING.md
  // content so Jarvis executes it immediately without a read-file round-trip.
  // FORK 2026-04-28 (bible §5.76): soft fallback names two paths in resolution
  // order — workspace (override) → bundled default. Whichever exists wins,
  // both for fresh clones (workspace missing → falls back to briefing-default.md)
  // and for users who have customised their briefing. Fallback fires when the
  // RPC is unavailable (gateway offline, plugin not loaded, etc).
  if (/^\/(new|reset)$/i.test(trimmed)) {
    try {
      const resolved = await req<{
        path: string | null;
        source: "workspace" | "bundled" | null;
        content: string | null;
      }>("briefing.resolve", {});
      if (resolved && resolved.path && resolved.content) {
        return buildBriefingPrompt(resolved.path, resolved.content);
      }
    } catch (err) {
      console.warn("[briefing.resolve] failed, falling back to soft suffix:", err);
    }
    // Fallback: soft suffix preserves day-0 sanity if RPC is unavailable.
    return (
      userText +
      "\n\n---\n\n**Session Startup.** Read and follow whichever of these briefing files exists (try in order, take the first found): " +
      "`~/.openclaw/workspace/BRIEFING.md` (your workspace override, if present), then " +
      "`~/src/tinkerclaw/extensions/tinkerclaw-cc-bridge/prompts/briefing-default.md` (the bundled day-0 fallback). " +
      "Edit the workspace file (or seed one with `openclaw briefing init`) if you want to change the briefing format — `git pull` will keep refreshing the bundled fallback without touching your workspace override."
    );
  }

  // FORK 2026-06-07: amygdala per-turn section removed (served no purpose — the
  // live panel is the feedback loop). Only the fractal section remains.
  const wantFra = injectToggles.fractal;
  if (!wantFra) {
    return userText;
  }
  const extras: string[] = [];
  extras.push(
    "\n\n---\n\n**Structure this turn's reply as labelled sections in this exact order: 💬 ANSWER → 🌿 FRACTAL.** Each marker on its own line, blank line between sections. The UI parses markers and renders each section as a separate bubble; the first is expanded, later ones collapsed.",
  );
  extras.push(
    "\n\n**💬 ANSWER** — your complete substantive reply, markdown freely, natural prose.",
  );
  extras.push(
    "\n\n**🌿 FRACTAL** — follow the fractal rules in your system prompt (MEMORY / PATTERN / RIPPLE / IMPROVE, ACTION-prefix when you changed something). Full rule source: `~/src/tinkerclaw/extensions/tinkerclaw-fractal-reflection/fractal-prompt.md`.",
  );
  return userText + extras.join("");
}

// FORK 2026-06-10 (amygdala retirement): the 3-section reply splitter
// (splitSectionedReply) moved to ./sectioned-reply.ts and now recognises only
// 💬 ANSWER / 🌿 FRACTAL — the retired 🧠 AMYGDALA marker is no longer a section.
// FORK 2026-05-09: Detect and reconstruct _fullPrompt / _briefingPath for
// historical user messages loaded from chat.history. The gateway persists the
// FULL injected prompt as the user message body (that is what was actually
// sent to Claude). After a hard refresh, messages arrive from the server
// without the client-only _fullPrompt and _briefingPath fields, so the
// renderer would display the raw injected text expanded in the bubble.
//
// This function checks whether the user text body contains a known injection
// sentinel and, if so, splits it at the "\n\n---\n\n" boundary:
//   - The pre-separator portion becomes the display text (original user text).
//   - The full string becomes _fullPrompt.
//   - For briefing injections, _briefingPath is extracted from the sentinel.
//
// Both injection types use "\n\n---\n\n" as separator (see buildInjectedPrompt).
// Sentinels:
//   Amygdala/fractal: "Structure this turn's reply as labelled sections"
//   Briefing:         "Execute the morning briefing NOW"
//                     + "Briefing source: `<path>`"
const INJECTION_SEP = "\n\n---\n\n";
function reconstructInjectionFields(msg: Record<string, unknown>): void {
  if (msg.role !== "user") {
    return;
  }
  // FORK 2026-05-09: use _fullPrompt as the source-of-truth if already set
  // by a prior pass — that way subsequent reconstruct invocations can fix
  // botched first-pass extractions (e.g. when the first pass set _fullPrompt
  // but failed to extract _briefingPath because of a regex miss).
  let rawText: string | null = null;
  if (typeof msg._fullPrompt === "string" && (msg._fullPrompt as string).length > 0) {
    rawText = msg._fullPrompt as string;
  }
  if (!rawText && Array.isArray(msg.content)) {
    const first = (msg.content as Array<{ type: string; text?: string }>).find(
      (b) => b.type === "text",
    );
    if (first?.text) {
      rawText = first.text;
    }
  }
  if (!rawText && typeof msg.content === "string") {
    rawText = msg.content;
  }
  if (!rawText) {
    return;
  }
  // FORK 2026-05-09 (revised): detect injection by SENTINEL first, separator
  // second. The persistence layer somewhere collapses `\n\n---\n\n` to `\n---\n`
  // or strips the leading `/new\n\n` entirely, so requiring the exact separator
  // misses real briefing turns. Sentinel-based detection catches them all.
  const isBriefingNew = rawText.includes("Execute the morning briefing NOW");
  const isBriefingLegacy = rawText.includes(
    "Read and follow whichever of these briefing files exists",
  );
  const isBriefingShape = /^\s*\/(new|reset)\b/i.test(rawText);
  const isBriefing = isBriefingNew || isBriefingLegacy || isBriefingShape;
  const isAmygdala = rawText.includes("Structure this turn's reply as labelled sections");
  if (!isBriefing && !isAmygdala) {
    return;
  }
  // Compute the visible user text. Three strategies, in order:
  //   1. Strict separator found → split there.
  //   2. Briefing detected without strict separator → synthetic "/new".
  //   3. Amygdala detected without strict separator → take everything BEFORE
  //      the "Structure this turn" sentinel as the user's typed text.
  const sepIdx = rawText.indexOf(INJECTION_SEP);
  let originalText: string;
  if (sepIdx > 0) {
    originalText = rawText.slice(0, sepIdx);
  } else if (isBriefing) {
    originalText = "/new";
  } else {
    // Amygdala fallback: split right before the directive marker. Tolerates
    // collapsed whitespace and inline `---` separators.
    const amygMatch = rawText.match(/^([\s\S]*?)\s*(?:---\s*)?\*{0,2}\s*Structure this turn/);
    originalText = amygMatch ? amygMatch[1].trim() : rawText.slice(0, 200);
    if (!originalText) {
      originalText = rawText.slice(0, 200);
    }
  }
  msg._fullPrompt = rawText;
  // Rewrite the FIRST text block (regardless of strict text===rawText match)
  // so the bubble shows just the user-visible portion, not the full prompt.
  // The strict equality check missed cases where multiple blocks exist or
  // the persistence layer trimmed/normalized the text.
  if (Array.isArray(msg.content)) {
    const blocks = msg.content as Array<{ type: string; text?: string }>;
    for (const b of blocks) {
      if (b.type === "text") {
        b.text = originalText;
        break;
      }
    }
  } else if (typeof msg.content === "string") {
    msg.content = originalText;
  }
  if (isBriefing) {
    // Try the canonical "Briefing source: `<path>`" pattern first; if absent
    // (e.g. server stripped the label or collapsed whitespace), fall back to
    // any backtick-quoted .md path that looks like a workspace BRIEFING file.
    let pathMatch: RegExpMatchArray | null = rawText.match(/Briefing source:\s*`([^`]+)`/);
    if (!pathMatch) {
      pathMatch = rawText.match(/`((?:\/|~\/)[^`]*BRIEFING[^`]*\.md)`/);
    }
    if (!pathMatch) {
      pathMatch = rawText.match(/((?:\/|~\/)[\w./-]*BRIEFING[\w./-]*\.md)/);
    }
    if (pathMatch) {
      msg._briefingPath = pathMatch[1];
    }
  }
  // FORK 2026-05-09 (Feature A): pull timestamp from server-side field if available.
  // Gateway message records expose createdAtMs (number ms) or timestamp (ISO string).
  // If neither is present we leave _promptStartedAt unset — no fabrication.
  if (!msg._promptStartedAt) {
    const ts = msg.createdAtMs ?? msg.timestamp;
    if (typeof ts === "number") {
      msg._promptStartedAt = ts;
    } else if (typeof ts === "string") {
      const parsed = Date.parse(ts);
      if (!isNaN(parsed)) {
        msg._promptStartedAt = parsed;
      }
    }
  }
}

// FORK 2026-04-18: render the user bubble. If the message was sent with
// amygdala/fractal instructions appended, show the raw user text plus a
// tiny clickable "📜 prompt" badge; clicking expands a <details> with the
// full text sent to the gateway (for user visibility + debugging).
// FORK 2026-05-09 (Feature A): prepend HH:MM:SS absolute timestamp on the
// left gutter when _promptStartedAt is present.
function formatHHMMSS(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
// FORK 2026-05-31: Overseer nudge sentinel + colour — MUST match OVERSEER_PROMPT_PREFIX
// / OVERSEER_COLOR in src/fork/overseer.ts. An Overseer nudge is injected into Jarvis'
// session as a user-role prompt (Jarvis sees it as input) but renders as a LEFT amber
// "Overseer" bubble, so it reads as the Overseer's own voice on the assistant side.
const OVERSEER_MARKER = "⟦OVERSEER⟧";
const AGENT_MARKER = "⟦AGENT⟧";
const OVERSEER_COLOR = "#d97706";

function renderUserBubbleWithPromptToggle(
  userText: string,
  msg: { _fullPrompt?: string; _briefingPath?: string; _promptStartedAt?: number },
  queuedClass: string,
  queuedBadge: string,
  idx: number,
): string {
  if (userText.startsWith(OVERSEER_MARKER)) {
    const body = userText.slice(OVERSEER_MARKER.length).trim();
    return `<div class="msg user msg-agent" data-msg-idx="${idx}"><span class="msg-agent-badge">🔭 Overseer</span>${md(body)}</div>`;
  }
  if (userText.startsWith(AGENT_MARKER)) {
    const body = userText.slice(AGENT_MARKER.length).trim();
    return `<div class="msg user msg-agent" data-msg-idx="${idx}"><span class="msg-agent-badge">🤖 Agent</span>${md(body)}</div>`;
  }
  // FORK 2026-05-09 (Feature A, simplified): timestamp lives on the bubble
  // itself as a `data-timestamp` attribute. CSS uses a `::after` pseudo-
  // element to render the value below the bubble's bottom-left corner.
  // No wrapper div — the bubble keeps its original `align-self: flex-end`
  // and stays right-anchored in the messages flex column. The bubble grows
  // a small bottom margin (via attribute selector) to make room for the
  // pseudo so it doesn't overlap the next message.
  const tsAttr =
    typeof msg._promptStartedAt === "number"
      ? ` data-timestamp="${formatHHMMSS(msg._promptStartedAt)}"`
      : "";

  if (!msg._fullPrompt || typeof msg._fullPrompt !== "string") {
    return `<div class="msg user${queuedClass}" data-msg-idx="${idx}"${tsAttr}>${md(userText)}${queuedBadge}</div>`;
  }
  const full = msg._fullPrompt;
  if (msg._briefingPath) {
    const safePath = escapeHtml(msg._briefingPath);
    return (
      `<div class="msg user${queuedClass} msg-user-with-prompt" data-msg-idx="${idx}"${tsAttr}>` +
      `${md(userText)}` +
      `<details class="user-prompt-toggle briefing-toggle">` +
      `<summary class="user-prompt-summary briefing-summary">` +
      `⚡ Executing <code class="fs-link" data-path="${safePath}" title="Click to open in system viewer">${safePath}</code>` +
      `</summary>` +
      `<div class="user-prompt-full">${md(full)}</div>` +
      `</details>` +
      `${queuedBadge}` +
      `</div>`
    );
  }
  return (
    `<div class="msg user${queuedClass} msg-user-with-prompt" data-msg-idx="${idx}"${tsAttr}>` +
    `${md(userText)}` +
    `<details class="user-prompt-toggle">` +
    `<summary class="user-prompt-summary">📜 view full prompt</summary>` +
    `<div class="user-prompt-full">${md(full)}</div>` +
    `</details>` +
    `${queuedBadge}` +
    `</div>`
  );
}

// FORK 2026-06-10 (amygdala retirement): renderSectionedReply +
// scrubResidualSectionMarkers moved to ./sectioned-reply.ts. The renderer no
// longer fabricates a collapsed 🧠 amygdala block; pre-answer narration folds
// into the ANSWER bubble inline. 🌿 FRACTAL rendering is preserved there.
// FORK 2026-04-17: ErrorEnvelope rendering ---------------------------------
// See `src/fork/error-envelope.ts` on the server side. Servers deliver a
// structured envelope as an assistant-text payload prefixed with the sentinel
// `__ERR_ENV__:` so it flows through the normal assistant-turn path without
// triggering any special-case error branches in the middle layers. Here we
// detect the sentinel, parse, and render a rich error bubble (red if fatal,
// orange if the system can recover on its own — per Design Bible §11.12).
type EnvelopeLlm = {
  provider?: string;
  model?: string;
  authProfileId?: string;
  requestId?: string;
  httpStatus?: number;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  durationMs?: number;
};
type Envelope = {
  kind: "error";
  id: string;
  fatal: boolean;
  category: string;
  headline: string;
  explanation?: string;
  suggestedActions?: string[];
  icon: string;
  llm?: EnvelopeLlm;
  sessionKey?: string;
  raw?: string;
  details?: Record<string, unknown>;
  timestamp?: string;
};
const ERR_ENV_PREFIX = "__ERR_ENV__:";
function extractEnvelope(text: string): Envelope | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  // indexOf, not startsWith: defense-in-depth. If some upstream path ever
  // concatenates prose before the envelope, we still detect it.
  const idx = text.indexOf(ERR_ENV_PREFIX);
  if (idx < 0) {
    return null;
  }
  const jsonStart = idx + ERR_ENV_PREFIX.length;
  // Find the end of the JSON object by brace-matching from the first '{'.
  const braceStart = text.indexOf("{", jsonStart);
  if (braceStart < 0) {
    return null;
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(braceStart, end)) as Envelope;
    if (parsed?.kind === "error" && typeof parsed.headline === "string") {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return null;
}
function renderEnvelope(env: Envelope): string {
  const variantClass = env.fatal ? "envelope-fatal" : "envelope-recoverable";
  const actions =
    env.suggestedActions && env.suggestedActions.length > 0
      ? `<ul class="env-actions">${env.suggestedActions.map((a) => `<li>${md(a)}</li>`).join("")}</ul>`
      : "";
  const kvEntries: string[] = [];
  if (env.llm?.provider) {
    kvEntries.push(`provider: ${env.llm.provider}`);
  }
  if (env.llm?.model) {
    kvEntries.push(`model: ${env.llm.model}`);
  }
  if (env.llm?.authProfileId) {
    kvEntries.push(`auth_profile: ${env.llm.authProfileId}`);
  }
  if (env.llm?.httpStatus !== undefined) {
    kvEntries.push(`http_status: ${env.llm.httpStatus}`);
  }
  if (env.llm?.providerErrorCode) {
    kvEntries.push(`provider_error_code: ${env.llm.providerErrorCode}`);
  }
  if (env.llm?.requestId) {
    kvEntries.push(`request_id: ${env.llm.requestId}`);
  }
  if (env.llm?.durationMs !== undefined) {
    kvEntries.push(`duration_ms: ${env.llm.durationMs}`);
  }
  if (env.sessionKey) {
    kvEntries.push(`session: ${env.sessionKey}`);
  }
  if (env.timestamp) {
    kvEntries.push(`timestamp: ${env.timestamp}`);
  }
  if (env.details) {
    for (const [k, v] of Object.entries(env.details)) {
      if (v !== undefined && v !== null) {
        kvEntries.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      }
    }
  }
  const kv = kvEntries.length > 0 ? `<div class="env-kv">${esc(kvEntries.join("\n"))}</div>` : "";
  const raw = env.raw ? `<div class="env-kv">${esc(env.raw)}</div>` : "";
  const tech =
    kv || raw
      ? `<details class="env-tech"><summary>technical details</summary>${kv}${raw}</details>`
      : "";
  const explanation = env.explanation
    ? `<div class="env-explanation">${md(env.explanation)}</div>`
    : "";
  // FORK 2026-05-30 (Oscar directive): progressive disclosure. The COLLAPSED
  // view is just the icon + headline — a small, plain-language warning the
  // normal user can glance past ("Gateway restarted"). Everything else
  // (explanation, actions, the technical kv/raw block) lives inside the
  // expand, so an advanced user can open it and explore. Recoverable errors
  // (fatal:false) collapse by default — I'm already handling them, so there's
  // nothing to act on. Fatal errors render `open` because the user must act,
  // so we never hide the call-to-action behind a click.
  const openAttr = env.fatal ? " open" : "";
  const body = explanation + actions + tech;
  return (
    `<details class="msg msg-envelope ${variantClass}"${openAttr} data-env-id="${esc(env.id)}" data-env-category="${esc(env.category)}">` +
    `<summary class="env-header"><span class="env-icon">${esc(env.icon ?? "⚠️")}</span><span class="env-headline">${esc(env.headline)}</span></summary>` +
    (body ? `<div class="env-body">${body}</div>` : "") +
    `</details>`
  );
}

function renderSystemMsg(text: string, idx: number): string {
  const sid = `s${idx}`;
  const sysExp = expandedTools.has(sid);
  const flat = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  const isAlert = /⚠️|⚠/.test(flat);

  // Detect file content: try to find file paths
  const paths = extractFilePaths(text);
  let preview: string;
  if (paths.length > 0) {
    // Show file paths as links instead of dumping content
    const links = paths.map((p) => {
      const name = p.split("/").pop() || p;
      // Home dir expansion happens server-side; keep ~ as-is for display links
      const fullPath = p;
      return `<span class="sys-file-link" data-path="${esc(fullPath)}">📄 ${esc(name)}</span>`;
    });
    preview = links.join(" ");
  } else {
    const firstSentence = flat.match(/^[^.!?\n]{10,120}[.!?]/)?.[0];
    preview = esc(firstSentence ?? flat.slice(0, 120));
    if (text.length > (firstSentence?.length ?? 120)) {
      preview += " …";
    }
  }

  const cssClass = isAlert ? "msg system-alert" : "msg system";
  let h = `<div class="${cssClass}" data-tid="${sid}">${sysExp ? "▾" : "▸"} ${preview}</div>`;
  if (sysExp) {
    h += `<div class="tool-detail system-expanded">${md(text)}</div>`;
  }
  return h;
}

// FORK 2026-05-09 (Feature B): Format elapsed seconds as "+Ns" or "+1m12s".
function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `+${s}s`;
  }
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `+${m}m${rem}s` : `+${m}m`;
}

// FORK 2026-05-09 (Feature B): Walk backward from idx to find the most recent
// user message's _promptStartedAt. Returns undefined when unavailable so the
// chip is simply omitted rather than showing incorrect data.
function findPrecedingPromptStart(msgs: unknown[], idx: number): number | undefined {
  for (let i = idx - 1; i >= 0; i--) {
    const m = msgs[i] as Record<string, unknown>;
    if (m.role === "user" && typeof m._promptStartedAt === "number") {
      return m._promptStartedAt;
    }
  }
  return undefined;
}

// FORK 2026-05-09 (Feature B): Build the elapsed chip HTML or empty string.
// Uses _bubbleEndedAt vs the preceding user _promptStartedAt.
// References the module-level `messages` array (always the active tab's copy).
function elapsedChip(msg: unknown, idx: number): string {
  const m = msg as Record<string, unknown>;
  // FORK 2026-05-09: fall back to message-level server timestamps when the
  // streaming-time `_bubbleEndedAt` is missing (i.e. historical messages
  // loaded from chat.history that pre-date Feature B's instrumentation, or
  // assistant messages loaded fresh on hard refresh).
  let endedAt: number | undefined =
    typeof m._bubbleEndedAt === "number" ? (m._bubbleEndedAt as number) : undefined;
  if (endedAt === undefined) {
    const ts = m.timestamp ?? m.createdAtMs ?? m.serverTime;
    if (typeof ts === "number") {
      endedAt = ts;
    } else if (typeof ts === "string") {
      const parsed = Date.parse(ts);
      if (!isNaN(parsed)) endedAt = parsed;
    }
  }
  if (endedAt === undefined) {
    return "";
  }
  const startedAt = findPrecedingPromptStart(messages, idx);
  if (startedAt === undefined) {
    return "";
  }
  const elapsed = endedAt - startedAt;
  if (elapsed < 0 || elapsed > 24 * 3600 * 1000) {
    // Negative (clock skew) or >24h (sane upper bound — likely a stale ts) → omit.
    return "";
  }
  return `<span class="msg-elapsed">${formatElapsed(elapsed)}</span>`;
}

function renderMsg(
  msg: unknown,
  idx: number,
  isThinking = false,
  globalResults?: Map<string, { content: string; isError: boolean }>,
  globalToolNames?: Map<string, { name: string; input: unknown }>,
): string {
  const role = (msg.role ?? "").toLowerCase();
  const content = Array.isArray(msg.content) ? msg.content : [];
  const resultMap = globalResults ?? new Map();
  const toolNameMap = globalToolNames ?? new Map();
  // FORK: Queued message styling
  const queuedClass = msg._queued ? " msg-queued" : "";
  const queuedBadge = msg._queued ? `<span class="queued-badge">queued</span>` : "";
  let h = "";

  // FORK: Hide fractal reflection prompts regardless of role (user/assistant/toolResult)
  // sessions.send injects them as toolResult messages in the transcript
  const _allMsgTexts =
    content.map((b: unknown) => b.text ?? "").join(" ") +
    (typeof msg.content === "string" ? msg.content : "");
  if (_allMsgTexts.includes("# FRACTAL REFLECTION")) {
    return h;
  }

  // FORK (2026-04-21, enriched 2026-04-29 §5.80): synthetic compaction markers.
  // session-utils.fs.ts on the server emits one role:"system" entry per transcript
  // compaction record, now carrying { summary, tokensBefore, tokensAfter } in
  // __openclaw. Render an expandable banner so the user sees what was retained,
  // not just that something happened.
  if (msg.__openclaw?.kind === "compaction") {
    const meta = msg.__openclaw as {
      summary?: string;
      tokensBefore?: number;
      tokensAfter?: number;
    };
    const summary = typeof meta.summary === "string" ? meta.summary : "";
    const before = typeof meta.tokensBefore === "number" ? meta.tokensBefore : undefined;
    const after = typeof meta.tokensAfter === "number" ? meta.tokensAfter : undefined;
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);
    const tokenLabel =
      typeof before === "number" && typeof after === "number"
        ? `${fmt(before)} → ${fmt(after)} tok`
        : typeof before === "number"
          ? `${fmt(before)} tok compacted`
          : "";
    if (!summary.trim()) {
      // No summary captured — fall back to the minimal divider so old transcripts
      // still render cleanly.
      return `<div class="msg-compaction-divider"><span class="msg-compaction-label">context consolidated${tokenLabel ? ` · ${tokenLabel}` : ""}</span></div>`;
    }
    const summaryHtml = md(summary);
    const tokenSpan = tokenLabel
      ? `<span class="msg-compaction-banner-tokens">${esc(tokenLabel)}</span>`
      : "";
    return (
      `<div class="msg-compaction-banner" data-msg-idx="${idx}" onclick="this.classList.toggle('is-open')">` +
      `<div class="msg-compaction-banner-header">` +
      `<span class="msg-compaction-banner-chevron">▶</span>` +
      `<span>context compacted — click to expand summary</span>` +
      tokenSpan +
      `</div>` +
      `<div class="msg-compaction-banner-summary">${summaryHtml}</div>` +
      `</div>`
    );
  }
  let blockIdx = 0;
  let hasNonToolContent = false;

  // Check if this message has any non-tool content (text blocks or plain string)
  if (typeof msg.content === "string" && msg.content.trim()) {
    hasNonToolContent = true;
  }
  for (const b of content) {
    if (b.type === "text" && (b.text ?? "").trim()) {
      hasNonToolContent = true;
      break;
    }
  }

  // Plain string content (legacy format)
  if (content.length === 0 && typeof msg.content === "string" && msg.content.trim()) {
    const text = msg.content as string;
    if (role === "user") {
      // Split system event lines from user text
      const lines = text.split("\n");
      const sysLines: string[] = [];
      const userLines: string[] = [];
      let inSystemBlock = true;
      for (const line of lines) {
        if (inSystemBlock && (line.startsWith("System:") || line.trim() === "")) {
          if (line.startsWith("System:")) {
            sysLines.push(line);
          }
        } else {
          inSystemBlock = false;
          userLines.push(line);
        }
      }
      for (const line of sysLines) {
        const sysText = line.replace(/^System:\s*/, "").trim();
        if (sysText) {
          h += renderSystemMsg(sysText, idx);
        }
      }
      const userText = userLines.join("\n").trim();
      if (userText) {
        // FORK: Hide fractal reflection prompts (injected via sessions.send)
        // Render as invisible div that preserves run boundary detection
        if (userText.includes("# FRACTAL REFLECTION")) {
          h += `<div class="fractal-boundary" style="display:none" data-msg-idx="${idx}"></div>`;
        } else if (
          userText.startsWith("⚠️ Gateway restarted") ||
          userText.startsWith("⚠ Gateway restarted")
        ) {
          // FORK: Gateway restart resume — orange centered bubble (not a user message)
          h += `<div class="msg-overload-bubble">${md(userText)}</div>`;
        } else if (SYSTEM_INJECTED_RE.test(userText)) {
          // System-injected messages (runtime context, subagent results) → system style
          h += renderSystemMsg(userText.replace(SYSTEM_INJECTED_RE, "").trim() || userText, idx);
        } else {
          h += renderUserBubbleWithPromptToggle(userText, msg, queuedClass, queuedBadge, idx);
        }
      }
    } else if (role === "assistant") {
      // FORK 2026-04-17: ErrorEnvelope detection ahead of everything else.
      // Any assistant text prefixed with __ERR_ENV__:{json} gets rendered as a
      // rich envelope bubble (red or orange per Design Bible §11.12) instead
      // of going through the generic error/warning branches below.
      const envelope = extractEnvelope(text);
      if (envelope) {
        h += renderEnvelope(envelope);
        return h;
      }
      // FORK 2026-04-18: Amygdala/Answer/Fractal 3-section detection.
      // If ANY of the three markers is present we take over the render so
      // the user never sees the raw "💬 ANSWER:" / "🧠 AMYGDALA:" / "🌿 FRACTAL:"
      // prefixes as plain text. Splitter returns whatever sections it can
      // extract; missing sections simply don't render.
      // FORK 2026-06-04 — bug task-mpwf4x8s-t8wjt (Thinking vs Final Answer bubbles).
      // Decide appearance by STRUCTURE, not by position. This used to be gated behind
      // `!isThinking`, so a completed bubble that carries the full answer-amygdala-fractal
      // structure but lands in a non-final (thinking) slot rendered as a plain thinking
      // bubble with the raw 💬/🧠/🌿 markers showing. Run the splitter unconditionally:
      // any bubble whose own text actually has the structure renders as the final-answer
      // layout regardless of where it sits in the stream (content-local, so it cannot
      // reintroduce the format "blinking" class which depended on neighbouring stream state).
      {
        const sectioned = splitSectionedReply(text);
        if (sectioned && (sectioned.answer || sectioned.fractal)) {
          h += renderSectionedReply(sectioned, elapsedChip(msg, idx), md, esc);
          return h;
        }
      }
      const errorClass = msg._isError ? " msg-error" : "";
      const retryBtn =
        msg._isError && msg._retryProvider
          ? ` <button class="retry-provider-btn" data-retry-provider="${esc(msg._retryProvider)}" data-hint="Retry ${esc(msg._retryProvider)}">↻</button>`
          : "";
      const thinkingPrefix = isThinking ? `<span class="thinking-label">Thinking:</span> ` : "";
      // FORK: Overload retry messages — orange centered bubble
      if (msg._isOverloadRetry) {
        h += `<div class="msg-overload-bubble${msg._isExhausted ? " exhausted" : ""}">${md(text)}</div>`;
        return h;
      }
      // FORK: Warning messages (fallback, profile rotation) — orange centered bubble
      if (msg._isWarning) {
        h += `<div class="msg-overload-bubble">${md(text)}</div>`;
        return h;
      }
      // FORK: Error messages — centered red bubble (not left-aligned assistant)
      // Detect by flag OR by content (history-loaded messages lack _isError flag).
      // The isError flag on reply payloads doesn't propagate through the broadcast
      // layer (server-chat.ts constructs messages from the text buffer, not the
      // payload), so we pattern-match on known error prefixes here.
      if (
        msg._isError ||
        text.startsWith("⚠️ Agent failed") ||
        text.startsWith("⚠ Agent failed") ||
        text.includes("Previous run is still shutting down") ||
        text.includes("All models failed")
      ) {
        h += `<div class="msg-overload-bubble exhausted">${md(text)}${retryBtn}</div>`;
        return h;
      }
      // FORK: Detect fractal reflection responses — collapsible green block
      const isFractal = text.trimStart().startsWith("🌿 FRACTAL:");
      const fractalClass = isFractal ? " msg-fractal" : "";
      // FORK: Hide the fractal instruction prompt (it's injected via sessions.send as assistant msg)
      const isFractalPrompt = text.includes("# FRACTAL REFLECTION");
      if (isFractalPrompt) {
        // Don't render the instruction prompt at all
        return h;
      }
      if (isFractal) {
        // Extract summary: first try the 🌿 FRACTAL: prefix line, then Level 2, then fallback
        const fractalLineMatch = text.match(/^🌿\s*FRACTAL:\s*(.{0,120})/m);
        const lvl2Match = text.match(/Level 2[:\s]*["""]?\s*(.{0,120})/);
        const preview =
          (fractalLineMatch?.[1] || lvl2Match?.[1] || "reflection").replace(/[*_#`]/g, "").trim() ||
          "reflection";
        // Check if this fractal took action (tool calls in surrounding messages)
        const hasAction = content.some(
          (b: unknown) => b.type === "tool_use" || b.type === "tool_result",
        );
        const openAttr = hasAction ? " open" : "";
        h += `<details class="fractal-details"${openAttr}><summary class="fractal-summary">🌿 <span class="fractal-summary-text">${esc(preview)}</span></summary><div class="msg assistant${errorClass}${fractalClass}">${md(text)}${retryBtn}</div></details>`;
      } else {
        // FORK 2026-05-29: colored subagent sub-bubble. When a message is tagged
        // with a subagent origin (_subagentId), render it with that subagent's
        // stable color + an id badge so parallel subagents are visually distinct
        // in the chat stream. Untagged messages are unaffected.
        // oxlint-disable-next-line typescript-eslint/no-explicit-any
        const saId = (msg as any)?._subagentId as string | undefined;
        if (saId) {
          const c = colorForSubagent(saId);
          // oxlint-disable-next-line typescript-eslint/no-explicit-any
          const saLabel =
            ((msg as any)?._subagentLabel as string | undefined) ?? shortSubagentId(saId);
          // oxlint-disable-next-line typescript-eslint/no-explicit-any
          const saLive = (msg as any)?._temporary === true;
          // FORK 2026-05-30: collapsible per-subagent bubble. The colored "▸ label"
          // header is the <summary> (always visible = the live roster of running
          // subagents); the thinking body is collapsed by default, expand-on-click.
          // Open state persists in expandedSubagents across the per-delta re-render.
          const saOpen = expandedSubagents.has(saId) ? " open" : "";
          const liveDot = saLive ? `<span class="msg-subagent-live" title="streaming"></span>` : "";
          const badge = `<span class="msg-subagent-badge" style="background:${c}">${esc(saLabel)}</span>`;
          h += `<details class="msg-subagent-details${saLive ? " is-live" : ""}" data-subagent-id="${esc(saId)}"${saOpen} style="--subagent-color:${c}"><summary class="msg-subagent-summary">${badge}${liveDot}</summary><div class="msg assistant msg-subagent${errorClass}${isThinking ? " msg-thinking" : ""}">${thinkingPrefix}${md(text)}${retryBtn}${elapsedChip(msg, idx)}${(msg as any)._turnIncomplete ? `<span class="msg-incomplete-badge" title="This turn did not finish cleanly (${esc(String((msg as any)._turnIncomplete))})">⚠ incomplete</span>` : ""}</div></details>`;
        } else {
          // FORK 2026-05-09 (Feature B): append elapsed chip inside assistant bubble.
          // FORK 2026-06-10: peel leading narration off the plain final-answer path
          // into a collapsible "Commentary" block (final answers only, !isThinking).
          // Empty narration (the default) => byte-identical output to before.
          let answerText = text;
          let commentaryHtml = "";
          if (!isThinking) {
            const sln = splitLeadingNarration(text);
            if (sln.narration) {
              commentaryHtml = `<details class="reasoning-group narration-details"><summary class="reasoning-header">▸ Commentary</summary><div class="reasoning-content"><div class="msg assistant msg-thinking"><span class="thinking-label">Commentary:</span> ${md(sln.narration)}</div></div></details>`;
              answerText = sln.answer;
            }
          }
          // FORK 2026-06-11 (fractal v3, bible §5.67b): answer bubbles carry no
          // runId in the DOM — when the stream:"fractal" consumer tags this
          // message with _fractalParentRunId (the data-subagent-id precedent),
          // emit it as data-fractal-parent-run so the dock-anchor lookup can
          // find the element across innerHTML rebuilds.
          const fractalAnchorAttr = (msg as any)._fractalParentRunId
            ? ` data-fractal-parent-run="${esc(String((msg as any)._fractalParentRunId))}"`
            : "";
          // FORK 2026-06-13 (eeg): twin of the fractal anchor — emit the _eegTurn
          // stamp as data-eeg-turn so EEG marker clicks can find the bubble
          // across innerHTML rebuilds (bible §5.8h q7).
          const eegTurnAttr =
            (msg as any)._eegTurn != null
              ? ` data-eeg-turn="${esc(String((msg as any)._eegTurn))}"`
              : "";
          h += `${commentaryHtml}<div class="msg assistant${errorClass}${isThinking ? " msg-thinking" : ""}"${fractalAnchorAttr}${eegTurnAttr}>${thinkingPrefix}${md(answerText)}${retryBtn}${elapsedChip(msg, idx)}${(msg as any)._turnIncomplete ? `<span class="msg-incomplete-badge" title="This turn did not finish cleanly (${esc(String((msg as any)._turnIncomplete))})">⚠ incomplete</span>` : ""}</div>`;
        }
      }
    } else {
      h += renderSystemMsg(text, idx);
    }
    return h;
  }

  // Render content blocks in order — text, tool_use, tool_result interlaced.
  // FORK (2026-04-21): track the most recent text block so the next tool_use
  // can use it as its title ("bird's-eye purpose" narration). The LLM is
  // prompted to write a purpose sentence before each tool call; that sentence
  // both renders as a normal text bubble AND becomes the tool row's title.
  let pendingToolNarration: string | null = null;
  for (const block of content) {
    if (block.type === "text") {
      const text = (block.text ?? "").trim();
      if (!text) {
        continue;
      }
      // FORK (2026-04-21): stash assistant text as pending narration for the
      // next tool_use in the same content array. Only the FINAL non-empty
      // text before a tool_use becomes its title — if multiple text blocks
      // stack up, the last one wins (closest to the tool call semantically).
      if (role === "assistant") {
        pendingToolNarration = text;
      }
      if (role === "user") {
        // Split system event lines from user text
        const lines = text.split("\n");
        const sysLines: string[] = [];
        const userLines: string[] = [];
        let inSystemBlock = true;
        for (const line of lines) {
          if (inSystemBlock && (line.startsWith("System:") || line.trim() === "")) {
            if (line.startsWith("System:")) {
              sysLines.push(line);
            }
          } else {
            inSystemBlock = false;
            userLines.push(line);
          }
        }
        // Render system lines as system messages
        for (const line of sysLines) {
          const sysText = line.replace(/^System:\s*/, "").trim();
          if (sysText) {
            h += renderSystemMsg(sysText, idx);
          }
        }
        // Render remaining user text
        const userText = userLines.join("\n").trim();
        if (userText) {
          // FORK: Gateway restart resume — orange centered bubble (not a user message)
          if (
            userText.startsWith("⚠️ Gateway restarted") ||
            userText.startsWith("⚠ Gateway restarted")
          ) {
            h += `<div class="msg-overload-bubble">${md(userText)}</div>`;
            // System-injected messages (runtime context, subagent results) → system style
          } else if (SYSTEM_INJECTED_RE.test(userText)) {
            h += renderSystemMsg(userText.replace(SYSTEM_INJECTED_RE, "").trim() || userText, idx);
          } else {
            h += renderUserBubbleWithPromptToggle(userText, msg, queuedClass, queuedBadge, idx);
          }
        }
      } else if (role === "assistant") {
        // FORK 2026-04-17: same ErrorEnvelope detection as above.
        const envelope2 = extractEnvelope(text);
        if (envelope2) {
          h += renderEnvelope(envelope2);
          return h;
        }
        // FORK 2026-04-18: Amygdala/Answer/Fractal 3-section detection (twin path).
        // FORK 2026-06-04 — bug task-mpwf4x8s-t8wjt: structure-based, not position-based
        // (see the string-content path above for the full rationale). Run unconditionally.
        {
          const sectioned2 = splitSectionedReply(text);
          if (sectioned2 && (sectioned2.answer || sectioned2.fractal)) {
            h += renderSectionedReply(sectioned2, elapsedChip(msg, idx), md, esc);
            return h;
          }
        }
        // FORK 2026-06-11 — live reasoning bubble (cc-bridge stream:"thinking").
        // Render BEFORE the overload/error/thinkingPrefix guards so the cumulative
        // reasoning text shows as a plain .msg-thinking bubble. Empty text => no
        // bubble (keeps a half-arrived reasoning stream from flashing an empty box).
        if ((msg as any)._isReasoning) {
          const rtext = (content.find((b: any) => b.type === "text")?.text ?? "").toString();
          if (!rtext.trim()) return h;
          h += `<div class="msg assistant msg-thinking"><span class="thinking-label">Thinking:</span> ${md(rtext)}</div>`;
          return h;
        }
        const errorClass = msg._isError ? " msg-error" : "";
        const retryBtn =
          msg._isError && msg._retryProvider
            ? ` <button class="retry-provider-btn" data-retry-provider="${esc(msg._retryProvider)}" data-hint="Retry ${esc(msg._retryProvider)}">↻</button>`
            : "";
        const thinkingPrefix = isThinking ? `<span class="thinking-label">Thinking:</span> ` : "";
        // FORK: Overload retry + warning messages — orange centered bubble
        if (msg._isOverloadRetry) {
          h += `<div class="msg-overload-bubble${msg._isExhausted ? " exhausted" : ""}">${md(text)}</div>`;
          return h;
        }
        if (msg._isWarning) {
          h += `<div class="msg-overload-bubble">${md(text)}</div>`;
          return h;
        }
        // FORK: Error messages — centered red bubble (not left-aligned assistant)
        if (
          msg._isError ||
          text.startsWith("⚠️ Agent failed") ||
          text.startsWith("⚠ Agent failed") ||
          text.includes("Previous run is still shutting down") ||
          text.includes("All models failed")
        ) {
          h += `<div class="msg-overload-bubble exhausted">${md(text)}${retryBtn}</div>`;
          return h;
        }
        // FORK: Detect fractal reflection responses — collapsible green block
        const isFractal2 = text.trimStart().startsWith("🌿 FRACTAL:");
        const fractalClass2 = isFractal2 ? " msg-fractal" : "";
        // FORK: Hide the fractal instruction prompt
        const isFractalPrompt2 = text.includes("# FRACTAL REFLECTION");
        if (isFractalPrompt2) {
          return h;
        }
        if (isFractal2) {
          const fractalLineMatch2 = text.match(/^🌿\s*FRACTAL:\s*(.{0,120})/m);
          const lvl2Match2 = text.match(/Level 2[:\s]*["""]?\s*(.{0,120})/);
          const preview2 =
            (fractalLineMatch2?.[1] || lvl2Match2?.[1] || "reflection")
              .replace(/[*_#`]/g, "")
              .trim() || "reflection";
          const hasAction2 = content.some(
            (b: unknown) => b.type === "tool_use" || b.type === "tool_result",
          );
          const openAttr2 = hasAction2 ? " open" : "";
          h += `<details class="fractal-details"${openAttr2}><summary class="fractal-summary">🌿 <span class="fractal-summary-text">${esc(preview2)}</span></summary><div class="msg assistant${errorClass}${fractalClass2}">${md(text)}${retryBtn}</div></details>`;
        } else {
          // FORK: Add recipe step tag below assistant messages when a recipe is active
          const stepTag =
            activeRecipeStep && !isThinking
              ? `<div class="recipe-step-tag">${esc(activeRecipeStep)}</div>`
              : "";
          // FORK 2026-05-09 (Feature B): append elapsed chip inside assistant bubble.
          // FORK 2026-06-10: peel leading narration off the plain final-answer path
          // into a collapsible "Commentary" block (final answers only, !isThinking).
          // Empty narration (the default) => byte-identical output to before.
          let answerText = text;
          let commentaryHtml = "";
          if (!isThinking) {
            const sln = splitLeadingNarration(text);
            if (sln.narration) {
              commentaryHtml = `<details class="reasoning-group narration-details"><summary class="reasoning-header">▸ Commentary</summary><div class="reasoning-content"><div class="msg assistant msg-thinking"><span class="thinking-label">Commentary:</span> ${md(sln.narration)}</div></div></details>`;
              answerText = sln.answer;
            }
          }
          // FORK 2026-06-11 (fractal v3, bible §5.67b): twin of the string-content
          // path above — emit the _fractalParentRunId tag as a DOM attribute.
          const fractalAnchorAttr = (msg as any)._fractalParentRunId
            ? ` data-fractal-parent-run="${esc(String((msg as any)._fractalParentRunId))}"`
            : "";
          // FORK 2026-06-13 (eeg): twin of the fractal anchor — emit the _eegTurn
          // stamp as data-eeg-turn so EEG marker clicks can find the bubble
          // across innerHTML rebuilds (bible §5.8h q7).
          const eegTurnAttr =
            (msg as any)._eegTurn != null
              ? ` data-eeg-turn="${esc(String((msg as any)._eegTurn))}"`
              : "";
          h += `${commentaryHtml}<div class="msg assistant${errorClass}${isThinking ? " msg-thinking" : ""}"${fractalAnchorAttr}${eegTurnAttr}>${thinkingPrefix}${md(answerText)}${retryBtn}${stepTag}${elapsedChip(msg, idx)}${(msg as any)._turnIncomplete ? `<span class="msg-incomplete-badge" title="This turn did not finish cleanly (${esc(String((msg as any)._turnIncomplete))})">⚠ incomplete</span>` : ""}</div>`;
        }
      } else {
        h += renderSystemMsg(text, idx);
      }
    } else if (block.type === "tool_use") {
      const a = block.input ?? {};
      const mechanicalSummary = toolSummary(block.name, a);
      const tid = `t${idx}-${block.id ?? block.name}-${blockIdx++}`;
      const exp = expandedTools.has(tid);
      // Look up result from global map (tool_result may be in a different message)
      const paired = resultMap.get(block.id ?? "");
      const statusIcon = paired ? (paired.isError ? "✗" : "✓") : "⋯";
      const statusCls = paired ? (paired.isError ? "err" : "ok") : "run";
      // FORK (2026-04-21): if the LLM wrote a purpose sentence right before
      // this tool call, use the LAST sentence (or first ~160 chars) of it as
      // the tool row's title — that's the "bird's-eye view" the user asked
      // for. Fall back to the mechanical pattern summary when the LLM skipped
      // narration. Keep the mechanical summary as a secondary line inside the
      // row so you can still see what the tool literally does at a glance.
      // FORK (2026-04-24): single-line tool row. Title is the LLM's purpose
      // narration if available, else the mechanical summary. No subtitle —
      // everything else lives in the expanded view.
      let title = mechanicalSummary;
      const liveNarration =
        typeof (block as { _purpose?: unknown })._purpose === "string"
          ? ((block as { _purpose?: string })._purpose ?? "").trim()
          : "";
      const narration = liveNarration || pendingToolNarration;
      if (narration) {
        const lastSentence = narration.match(/[^.!?\n]+[.!?]?\s*$/)?.[0]?.trim() ?? narration;
        title = lastSentence.length > 160 ? lastSentence.slice(0, 157).trim() + "…" : lastSentence;
        pendingToolNarration = null; // consumed — next tool_use gets a fresh narration
      }
      h += `<div class="tool-row" data-tid="${tid}"><span class="status ${statusCls}">${statusIcon}</span><span class="detail">${esc(title)}</span></div>`;
      if (exp) {
        // FORK (2026-04-24): expanded view = command first, then full stdout
        // of the command. Explicit design: description is the only
        // thing visible until you click. Everything you need to judge the
        // call lives in the expansion — what ran, and what came back.
        h += `<div class="tool-detail">${toolExpandedDetail(block.name, a)}`;
        if (paired && paired.content) {
          h += `<div class="tool-result-inline"><div class="explanation">${paired.isError ? "❌ Something went wrong:" : "stdout:"}</div><div class="code-block">${esc(paired.content)}</div></div>`;
        }
        h += `</div>`;
      }
    } else if (block.type === "tool_result") {
      // tool_result blocks are shown alongside their tool_use (via globalResults).
      // Only render standalone if there's no matching tool_use anywhere AND this
      // message has other content (otherwise skip the whole message).
      const uid = block.tool_use_id ?? "";
      const matchingTool = toolNameMap.get(uid);
      if (matchingTool) {
        continue;
      } // will be shown with its tool_use
      if (!hasNonToolContent) {
        continue;
      } // pure tool_result message — skip entirely
      const rt =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      const err = block.is_error === true;
      const tid = `r${idx}-${uid || "r"}-${blockIdx++}`;
      const exp = expandedTools.has(tid);
      const preview = rt.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
      const summary = preview.length > 120 ? preview.slice(0, 117) + "…" : preview;
      h += `<div class="tool-row" data-tid="${tid}"><span class="status ${err ? "err" : "ok"}">${err ? "✗" : "✓"}</span><span class="detail">${esc(summary)}</span></div>`;
      if (exp) {
        h += `<div class="tool-detail"><div class="code-block">${esc(rt)}</div></div>`;
      }
    }
  }
  return h;
}

// ─── Thinking Indicator ───
let thinkingTickInterval: ReturnType<typeof setInterval> | null = null;

function renderThinkingIndicator(): string {
  if (activeRuns.size > 0) {
    // FORK 2026-06-04 — bug task-mpzgsvbo (Thinking indicators): the CHAT indicator is now
    // BINARY — it shows ONLY whether the viewed session has a live LLM call, as ONE row.
    // It used to render one row PER active run (main + each subagent), which is what produced
    // the "multiple indicators at once" Oscar reported. The per-run / per-subagent breakdown
    // now lives ONLY in the RECIPES panel (+ the collapsible subagent chat bubbles). The Stop
    // button has always called the session-level abort() (see the delegated #messages handler),
    // so one Stop is the correct semantics. runBelongsToViewedSession stays the ONE shared
    // predicate so chat/prefrontal/model-count can't disagree. See done-signals.md §3 + panels.md §147.
    const viewed: Array<[string, ActiveRunInfo]> = [];
    let subagentCount = 0;
    let restarting = false;
    for (const [runId, info] of activeRuns) {
      if (!runBelongsToViewedSession(info)) {
        continue;
      }
      viewed.push([runId, info]);
      const sk = info.sessionKey ?? "";
      if (
        sk.includes(":subagent:") &&
        !!sessionKey &&
        sk.startsWith(sessionKey.replace(/:main$/, "") + ":subagent:")
      ) {
        subagentCount++;
      }
      if (info.state === "restarting") {
        restarting = true;
      }
    }
    if (viewed.length > 0) {
      // Primary = the main (non-subagent) run if present, else the earliest-started run.
      const isSub = (i: ActiveRunInfo) => {
        const sk = i.sessionKey ?? "";
        return (
          sk.includes(":subagent:") &&
          !!sessionKey &&
          sk.startsWith(sessionKey.replace(/:main$/, "") + ":subagent:")
        );
      };
      const [primaryRunId, primary] =
        viewed.find(([, i]) => !isSub(i)) ??
        viewed.reduce((a, b) => (a[1].startedAt <= b[1].startedAt ? a : b));
      const color = PROVIDER_COLORS[primary.provider] || "#6b7280";
      const elapsed = Math.floor((Date.now() - primary.startedAt) / 1000);
      const name = modelName(primary.model) || "working";
      const recipeLabel = activeRecipeStep ? ` &middot; ${esc(activeRecipeStep)}` : "";
      // One small badge for "+N subagents running" — detail is in the RECIPES panel.
      const subBadge =
        subagentCount > 0
          ? ` <span class="thinking-subagent-tag" title="${subagentCount} subagent${subagentCount > 1 ? "s" : ""} running — see RECIPES panel">▸${subagentCount}</span>`
          : "";
      const badge = restarting ? `<span class="restart-badge">RESTARTING</span>` : "";
      const row = `<div class="thinking-run" data-run-id="${esc(primaryRunId)}" data-provider="${esc(primary.provider)}" style="--thinking-dot-color:${color};--thinking-glow:${color}40;--thinking-glow-bg:${color}20;--thinking-glow-bg2:${color}30">
  <div class="thinking-dots"><span></span><span></span><span></span></div>
  <span class="thinking-model">${providerIcon(primary.provider)} ${esc(name)}${recipeLabel}${subBadge}</span>
  ${badge}<span class="thinking-elapsed">${elapsed}s</span>
  <span class="thinking-stop">Stop</span>
</div>`;
      return `<div class="thinking-indicator">${row}</div>`;
    }
  }
  // The "sending..." pending pill is ONLY the brief window between chat.send
  // and the first lifecycle event for THIS tab. If the viewed session already
  // has a live run we rendered it above; if it doesn't and `sending` is still
  // true that's the genuine pre-first-event gap. It must NOT stay up because a
  // DIFFERENT tab still has a run (that was the multi-tab "sending forever"
  // bug — fixed by clearing `sending` via viewedSessionBusy() at turn end).
  if (sending && !viewedSessionBusy()) {
    return `<div class="thinking-indicator" data-state="pending"><div class="thinking-run thinking-pending" style="--thinking-dot-color:#D97757;--thinking-glow:#D9775740;--thinking-glow-bg:#D9775720;--thinking-glow-bg2:#D9775730">
  <div class="thinking-dots"><span></span><span></span><span></span></div>
  <span class="thinking-model">sending...</span>
  <span class="thinking-stop">Stop</span>
</div></div>`;
  }
  return "";
}

function startThinkingTick() {
  // FORK 2026-05-14: this tick used to host a "stale-run watchdog" that
  // force-cleared activeRuns at startedAt + 5min (later: lastEventAt + 5min).
  // Both shapes were wrong. The watchdog was compensating for a presumed
  // unreliability in lifecycle:end emission — but Claude Code itself doesn't
  // need one, and neither do we once lifecycle:end is hardened in attempt.ts
  // (try/finally on every run-termination branch). A UI-side timer that
  // disagrees with the server's authoritative lifecycle is a code smell:
  // either the server is wrong (fix the server) or the UI is lying about
  // server state (don't ship a UI that lies).
  //
  // What this tick still does: update the displayed elapsed seconds on each
  // active thinking-indicator row, and call updatePrefrontalTree() so the
  // panel's age and status reflect the latest WS events. It does NOT touch
  // activeRuns — entries are added by lifecycle:start and removed by
  // lifecycle:end / chat.final / chat.error. Period.
  if (thinkingTickInterval) {
    return;
  }
  thinkingTickInterval = setInterval(() => {
    if (activeRuns.size === 0) {
      // No active runs left. Stop the tick. (sending is cleared by the
      // lifecycle:end / chat.final / chat.error handler that emptied
      // activeRuns; no longer cleared here.)
      clearInterval(thinkingTickInterval!);
      thinkingTickInterval = null;
      return;
    }
    document.querySelectorAll(".thinking-run[data-run-id]").forEach((el) => {
      const runId = el.getAttribute("data-run-id");
      if (!runId) {
        return;
      }
      const info = activeRuns.get(runId);
      if (!info) {
        return;
      }
      const elapsed = Math.floor((Date.now() - info.startedAt) / 1000);
      const span = el.querySelector(".thinking-elapsed");
      if (span) {
        span.textContent = `${elapsed}s`;
      }
    });
    updatePrefrontalTree();
  }, 1000);
}

// ─── Usage Tracker Helpers ───
function fmtCost(n: number): string {
  if (n >= 1) {
    return n % 1 === 0 ? n.toString() : n.toFixed(1);
  }
  if (n >= 0.1) {
    return n.toFixed(2);
  }
  return n.toFixed(3);
}

// Subscription effective $/MTok: $200/mo, ~6M tok/day = ~180M/mo → ~$1.1/MTok blended
const SUB_COST_LABEL = "~$1.1";

function getModelCost(modelId: string, keyId?: string): string {
  // Subscription profiles get effective flat rate
  if (keyId && (keyId.includes(":cli-") || keyId.includes(":oauth"))) {
    const provider = modelId.split("/")[0];
    if (provider === "anthropic") {
      return SUB_COST_LABEL;
    }
  }
  const name = modelId.split("/").slice(1).join("/") || modelId;
  const cost = MODEL_COST[name];
  if (!cost) {
    return "";
  }
  if (cost[0] === cost[1]) {
    return `$${fmtCost(cost[0])}`;
  }
  return `$${fmtCost(cost[0])}/${fmtCost(cost[1])}`;
}

function fmtReset(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = d.getTime() - now;
    if (diffMs <= 0) {
      return "";
    }
    const h = Math.floor(diffMs / 3600000);
    const m = Math.floor((diffMs % 3600000) / 60000);
    if (h < 24) {
      return `${h}h ${m}m`;
    }
    const day = d.toLocaleDateString(undefined, { weekday: "short" });
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${day} ${time}`;
  } catch {
    return iso;
  }
}

interface ModelUsageInfo {
  topPct: number;
  bottomPct: number;
  tooltip: string;
  disconnected?: boolean;
}

function getModelUsage(provider: string, modelId: string, keyId?: string): ModelUsageInfo | null {
  if (!budgetUsageData || provider === "ollama") {
    return null;
  }
  const name = modelId.split("/").slice(1).join("/") || modelId;

  // FORK 2026-05-09: claude-code is just a wrapper around the Anthropic API
  // (uses the same cli-gm OAuth credentials and the same usage limits). Treat
  // the two providers identically for the purposes of usage-bar rendering so
  // models like `claude-code/claude-opus-4-7` show their 5h/7d utilization bars.
  if (provider === "anthropic" || provider === "claude-code") {
    // Check if profile is disabled (billing cap, cooldown, etc.)
    const prof = keyId ? modelConfigData?.authProfiles?.[keyId] : null;
    if (prof?.disabled) {
      const reason = prof.disabledReason || "cooldown";
      const label = keyId?.split(":").slice(1).join(":") || keyId || "api";
      return { topPct: 100, bottomPct: 100, tooltip: `${label}: ${reason}`, disconnected: true };
    }
    // Use per-profile data if available (e.g. "anthropic:cli-sv" → "cli-sv")
    const profileKey = keyId?.split(":").slice(1).join(":") || "";
    const profiles = budgetUsageData.claudeProfiles || {};
    const matched = profileKey ? profiles[profileKey] : null;
    const c = matched || budgetUsageData.claude;
    if (!c?.limits) {
      // Profile exists but no usage data — show disconnected state
      if (profileKey) {
        return {
          topPct: 0,
          bottomPct: 0,
          tooltip: `${profileKey}: disconnected`,
          disconnected: true,
        };
      }
      return null;
    }
    const src = matched ? profileKey : "shared";
    const h5 = c.limits.five_hour?.utilization ?? 0;
    const isSonnet = name.includes("sonnet");
    const sonnet7 = c.limits.seven_day_sonnet?.utilization;
    const d7 = c.limits.seven_day?.utilization ?? 0;
    const bottomPct = isSonnet && sonnet7 != null ? sonnet7 : d7;
    let tip = `${src}: 5h ${h5}%`;
    if (isSonnet && sonnet7 != null) {
      const rs = c.limits.seven_day_sonnet?.resets_at;
      const rsfmt = rs ? fmtReset(rs) : "";
      tip += `\n7d sonnet: ${sonnet7}%`;
      if (rsfmt) {
        tip += ` \u2014 resets ${rsfmt}`;
      }
    } else {
      const r7 = c.limits.seven_day?.resets_at;
      const r7fmt = r7 ? fmtReset(r7) : "";
      tip += `\n7d: ${d7}%`;
      if (r7fmt) {
        tip += ` \u2014 resets ${r7fmt}`;
      }
    }
    return { topPct: h5, bottomPct, tooltip: tip };
  }

  if (provider === "google") {
    const g = budgetUsageData?.gemini;
    if (!g || !g.rpd_limit) {
      return null;
    }
    // Top bar: RPM (requests per minute — short-term pressure)
    const rpmPct = g.rpm_limit > 0 ? Math.min((g.rpm_used / g.rpm_limit) * 100, 100) : 0;
    // Bottom bar: RPD (requests per day — daily hard cap)
    const rpdPct = g.rpd_limit > 0 ? Math.min((g.rpd_used / g.rpd_limit) * 100, 100) : 0;
    let tip = `RPM: ${g.rpm_used}/${g.rpm_limit} (${rpmPct.toFixed(0)}%)`;
    tip += `\nRPD: ${g.rpd_used}/${g.rpd_limit} (${rpdPct.toFixed(0)}%)`;
    return { topPct: rpmPct, bottomPct: rpdPct, tooltip: tip };
  }

  if (provider === "openai") {
    const oc = budgetUsageData?.openaiCosts;
    if (!oc || oc.monthSpend == null) {
      return null;
    }
    const cap = 50;
    const monthPct = Math.min((oc.monthSpend / cap) * 100, 100);
    // Today's spend as fraction of total cap
    const today = new Date().toISOString().slice(0, 10);
    const todayEntry = (oc.dailyBreakdown || []).find((d: unknown) => d.date === today);
    const todaySpend = todayEntry?.amount ?? 0;
    const todayPct = Math.min((todaySpend / cap) * 100, 100);
    let tip = `Today: $${todaySpend.toFixed(2)}/$${cap} (${todayPct.toFixed(0)}%)`;
    tip += `\nMonth: $${oc.monthSpend.toFixed(2)}/$${cap} (${monthPct.toFixed(0)}%)`;
    return { topPct: todayPct, bottomPct: monthPct, tooltip: tip };
  }

  return null;
}

function renderUsageBarsOnly(usage: ModelUsageInfo | null): string {
  if (!usage) {
    return '<span class="usage-bars-col"></span>';
  }
  if (usage.disconnected) {
    // Red-tinted dashes for billing/cooldown, gray for plain disconnected
    const isCapped = usage.topPct >= 100;
    const color = isCapped ? "#ef444450" : "#6b728033";
    let h = '<span class="usage-bars-col">';
    h += `<span class="usage-bars-wrap usage-disconnected" data-hint="${esc(usage.tooltip)}">`;
    h += `<span class="usage-bar"><span class="usage-bar-fill" style="width:100%;background:repeating-linear-gradient(90deg,${color} 0,${color} 3px,transparent 3px,transparent 6px)"></span></span>`;
    h += `<span class="usage-bar"><span class="usage-bar-fill" style="width:100%;background:repeating-linear-gradient(90deg,${color} 0,${color} 3px,transparent 3px,transparent 6px)"></span></span>`;
    h += `</span></span>`;
    return h;
  }
  const topColor = "#4ade80";
  const bottomColor = "#f59e0b";
  const topW = Math.min(usage.topPct, 100);
  const bottomW = Math.min(usage.bottomPct, 100);
  let h = '<span class="usage-bars-col">';
  h += `<span class="usage-bars-wrap" data-hint="${esc(usage.tooltip)}">`;
  h += `<span class="usage-bar"><span class="usage-bar-fill" style="width:${topW}%;background:${topColor}"></span></span>`;
  h += `<span class="usage-bar"><span class="usage-bar-fill" style="width:${bottomW}%;background:${bottomColor}"></span></span>`;
  h += `</span></span>`;
  return h;
}

function renderCostCol(costLabel: string): string {
  if (!costLabel) {
    return '<span class="usage-cost-col"></span>';
  }
  return `<span class="usage-cost-col">${esc(costLabel)}</span>`;
}

// ─── Budget Helpers ───
function _budgetColor(pct: number) {
  if (pct >= 100) {
    return "#ef4444";
  }
  if (pct >= 90) {
    return "#f97316";
  }
  if (pct >= 70) {
    return "#ca8a04";
  }
  if (pct >= 50) {
    return "#6b7280";
  }
  return "#16a34a";
}

function formatNum(n: number) {
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1) + "M";
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + "K";
  }
  return n.toString();
}

// ─── System-injected user message detection ───
// Some "user" messages are actually system-injected (subagent completions,
// runtime context, etc.). They should render as system messages, not user
// bubbles, and should NOT create run boundaries.
const SYSTEM_INJECTED_RE =
  /^\[.*?\]\s*OpenClaw runtime context \(internal\):|^OpenClaw runtime context \(internal\):/;

/** Extract the actual user text from a user message, stripping System: prefixes.
 *  Returns null if the message is entirely system-injected (no real user text). */
function extractUserText(msg: unknown): string | null {
  const content = Array.isArray(msg.content) ? msg.content : [];
  let raw = "";
  if (content.length === 0 && typeof msg.content === "string") {
    raw = msg.content;
  } else {
    for (const b of content) {
      if (b.type === "text" && (b.text ?? "").trim()) {
        raw = b.text;
        break;
      }
    }
  }
  if (!raw.trim()) {
    return null;
  }
  // Strip System: prefix lines
  const lines = raw.split("\n");
  const userLines: string[] = [];
  let inSys = true;
  for (const line of lines) {
    if (inSys && (line.startsWith("System:") || line.trim() === "")) {
      // skip
    } else {
      inSys = false;
      userLines.push(line);
    }
  }
  const text = userLines.join("\n").trim();
  if (!text) {
    return null;
  }
  // Check if remaining text is system-injected runtime context
  if (SYSTEM_INJECTED_RE.test(text)) {
    return null;
  }
  return text;
}

// ─── Targeted Updates ───
function updateChat(skipScroll = false) {
  const el = $("messages");
  if (!el) {
    return;
  }
  let h = "";
  // Identify intermediate "thinking" assistant messages: in each run
  // (bounded by user messages), all assistant text messages except the last
  // are thinking steps. If streaming is active, ALL assistant texts in the
  // current run are thinking (the live answer is a temporary message).
  // Tool result user messages are NOT run boundaries — they're mid-run tool responses.
  const isRunBoundary = (m: unknown) => {
    // FORK: Fractal reflection responses start a new run
    // (sessions.send injects them as assistant messages, so they won't have a user boundary)
    const mc = Array.isArray(m.content) ? m.content : [];
    const firstText =
      mc.find((b: unknown) => b.type === "text" && b.text)?.text ??
      (typeof m.content === "string" ? m.content : "");
    if ((firstText as string).trimStart().startsWith("🌿 FRACTAL:")) {
      return true;
    }

    if ((m.role ?? "").toLowerCase() !== "user") {
      return false;
    }
    const c = Array.isArray(m.content) ? m.content : [];
    // Pure tool_result messages are part of the run, not boundaries
    if (c.length > 0 && !c.some((b: unknown) => b.type !== "tool_result")) {
      return false;
    }
    // System-injected user messages (runtime context, subagent results) are not boundaries
    if (extractUserText(m) === null) {
      return false;
    }
    return true;
  };
  const thinkingSet = new Set<number>();
  {
    let runStart = 0;
    for (let i = 0; i <= messages.length; i++) {
      const isUserOrEnd = i === messages.length || isRunBoundary(messages[i]);
      if (!isUserOrEnd) {
        continue;
      }
      const assistantTextIndices: number[] = [];
      for (let j = runStart; j < i; j++) {
        const m = messages[j];
        if ((m.role ?? "").toLowerCase() !== "assistant") {
          continue;
        }
        const c = Array.isArray(m.content) ? m.content : [];
        const hasText = c.some((b: unknown) => b.type === "text" && (b.text ?? "").trim());
        const plainText = typeof m.content === "string" && (m.content as string).trim();
        if (!hasText && !plainText) {
          continue;
        }
        // FORK: Fractal responses are NOT real assistant text — they render as
        // their own collapsed block. Exclude them so the real answer before
        // a fractal isn't demoted to "thinking".
        const firstTextBlock =
          c.find((b: unknown) => b.type === "text" && b.text)?.text ?? (plainText || "");
        if ((firstTextBlock as string).trimStart().startsWith("🌿 FRACTAL:")) {
          continue;
        }
        // FORK: Fractal prompts are hidden entirely — don't count them
        if ((firstTextBlock as string).includes("# FRACTAL REFLECTION")) {
          continue;
        }
        // FORK: System messages (warnings, errors, retries, prefrontal) must NEVER
        // collapse into reasoning groups — they are user-facing status updates.
        if (
          m._isWarning ||
          m._isError ||
          m._isOverloadRetry ||
          m._isPrefrontal ||
          (m as any)._isReasoning
        ) {
          continue;
        }
        assistantTextIndices.push(j);
      }
      // All assistant text messages except the last in each run are thinking steps.
      // This applies during streaming too — frozen bubbles before tool calls are
      // definitively intermediate and slice(0,-1) already excludes the live bubble.
      // DO NOT re-add an `isCurrentRun`/`streamMsgIdx`-style guard here: it makes
      // ALL prior bubbles flash to final-answer style on each delta and snap back on
      // each tool call (the "blinking chat text" bug). Removed 2026-03-26 in 69693d3f61,
      // collateral-reverted by the 2026-03-28 restart-badge refactor c893c87370, removed
      // again 2026-05-29. See bible §5.8.
      const intermediates = assistantTextIndices.slice(0, -1);
      for (const idx of intermediates) {
        thinkingSet.add(idx);
      }
      runStart = i + 1;
    }
  }
  // Build a global tool result map: tool_use_id → { content, isError, name }
  // so tool_use blocks can find their paired results even across messages.
  const globalResultMap = new Map<string, { content: string; isError: boolean }>();
  const globalToolNames = new Map<string, { name: string; input: unknown }>();
  for (const m of messages) {
    const c = Array.isArray(m.content) ? m.content : [];
    for (const b of c) {
      if (b.type === "tool_result") {
        const rt = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        globalResultMap.set(b.tool_use_id ?? "", { content: rt, isError: b.is_error === true });
      }
      if (b.type === "tool_use") {
        globalToolNames.set(b.id ?? "", { name: b.name, input: b.input ?? {} });
      }
    }
  }
  // Render messages grouped by run. In completed runs, intermediate messages
  // (thinking + tool calls + system) collapse into an expandable reasoning group.
  {
    let runStart = 0;
    for (let i = 0; i <= messages.length; i++) {
      const isUserOrEnd = i === messages.length || isRunBoundary(messages[i]);
      if (!isUserOrEnd) {
        continue;
      }

      // Collect intermediate vs final in this run
      const runEnd = i; // exclusive
      const intermediateIndices: number[] = [];
      let finalIdx = -1;

      for (let j = runStart; j < runEnd; j++) {
        const m = messages[j];
        if (thinkingSet.has(j)) {
          intermediateIndices.push(j);
        } else {
          const role = (m.role ?? "").toLowerCase();
          if (role === "assistant") {
            // Check if it's a tool-only message (no text) — intermediate
            const c = Array.isArray(m.content) ? m.content : [];
            const hasText = c.some((b: unknown) => b.type === "text" && (b.text ?? "").trim());
            const plainText = typeof m.content === "string" && (m.content as string).trim();
            if (!hasText && !plainText) {
              intermediateIndices.push(j);
            } else {
              // If we already had a final candidate, demote it to intermediate
              if (finalIdx >= 0) {
                intermediateIndices.push(finalIdx);
              }
              finalIdx = j;
            }
          } else {
            // user tool_result messages, system messages — intermediate
            intermediateIndices.push(j);
          }
        }
      }

      // Count tool_use blocks only in intermediates (not the final answer)
      let toolCount = 0;
      for (const j of intermediateIndices) {
        const tc = Array.isArray(messages[j].content) ? messages[j].content : [];
        for (const b of tc) {
          if (b.type === "tool_use") {
            toolCount++;
          }
        }
      }

      // Determine if this run is still streaming (has temporary messages)
      const hasTemporaries = intermediateIndices.some((j) => messages[j]._temporary);
      const isStreaming = hasTemporaries || (i === messages.length && streamMsgIdx >= 0);

      // Render the run
      if (intermediateIndices.length > 0 && finalIdx >= 0 && !isStreaming) {
        // Completed run with intermediates — wrap in collapsible group
        const groupId = `rg-${intermediateIndices[0]}`;
        const expanded = expandedTools.has(groupId);
        const stepCount = intermediateIndices.filter((j) => thinkingSet.has(j)).length;
        const chevron = expanded ? "▾" : "▸";
        const stepLabel = stepCount > 0 ? `${stepCount} step${stepCount !== 1 ? "s" : ""}` : "";
        const toolLabel =
          toolCount > 0 ? `${toolCount} tool call${toolCount !== 1 ? "s" : ""}` : "";
        const parts = [stepLabel, toolLabel].filter(Boolean).join(", ");
        const summary = parts ? `Reasoning (${parts})` : "Reasoning";

        h += `<div class="reasoning-group">`;
        h += `<div class="reasoning-header" data-tid="${groupId}">${chevron} ${summary}</div>`;
        if (expanded) {
          h += `<div class="reasoning-content">`;
          for (const j of intermediateIndices) {
            h += renderMsg(messages[j], j, thinkingSet.has(j), globalResultMap, globalToolNames);
          }
          h += `</div>`;
        }
        h += `</div>`;
        // Render the final answer normally
        h += renderMsg(messages[finalIdx], finalIdx, false, globalResultMap, globalToolNames);
      } else {
        // Streaming run or no intermediates — render flat
        for (let j = runStart; j < runEnd; j++) {
          h += renderMsg(messages[j], j, thinkingSet.has(j), globalResultMap, globalToolNames);
        }
      }

      // Render the user message that ends this run (if not end-of-array)
      if (i < messages.length) {
        h += renderMsg(messages[i], i, false, globalResultMap, globalToolNames);
      }
      runStart = i + 1;
    }
  }

  // FORK 2026-06-07 — bug task-mq3gn32d (Prompt hopping): the running turn's thinking/tool
  // indicator must render ABOVE the queued bubble. So emit the thinking indicator FIRST, then the
  // queued-but-not-yet-committed prompts as the very last (bottom-most) bubbles — grayed, pinned to
  // the bottom in "queuing mode" exactly like Claude Code. The still-streaming turn's
  // continuation/tool output therefore always appears above the queued prompt, never below it.
  // Queued prompts are deliberately NOT in messages[] (see send()); they are flushed into
  // messages[] at turn-final, which splices them into their correct chronological position (in the
  // middle, within the thinking/tool stream) once the turn that was reading them completes.
  if (activeRuns.size > 0 || sending) {
    h += renderThinkingIndicator();
  }
  // FORK 2026-06-08: render ONLY the queued prompts that belong to the tab on screen. The queue is
  // one global array shared by all tabs; without this filter a prompt queued in one tab showed as a
  // "queued" bubble in EVERY tab.
  const visibleQueued = queuedForSession(pendingQueuedSends, sessionKey, sessionKeyMatches);
  for (let k = 0; k < visibleQueued.length; k++) {
    h += renderMsg(visibleQueued[k], messages.length + k, false, globalResultMap, globalToolNames);
  }
  // FORK: Preserve manually-opened fractal <details> across DOM rebuilds.
  // Without this, every streaming update collapses fractals the user expanded.
  const openFractals = new Set<number>();
  el.querySelectorAll("details.fractal-details[open]").forEach((det) => {
    const idx = Array.prototype.indexOf.call(el.querySelectorAll("details.fractal-details"), det);
    if (idx >= 0) {
      openFractals.add(idx);
    }
  });

  // Decide scroll behavior BEFORE replacing DOM content.
  const threshold = 80;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  const prevScrollTop = el.scrollTop;
  el.innerHTML = h;
  // FORK 2026-05-09: mirror chat HTML to a file via gateway RPC so the
  // architect-side Claude Code session can introspect the rendered DOM
  // without a screen share. Debounced 300ms to avoid spam during streaming.
  scheduleUiSnapshotDump(el);

  // Restore fractal open state
  if (openFractals.size > 0) {
    el.querySelectorAll("details.fractal-details").forEach((det, idx) => {
      if (openFractals.has(idx)) {
        (det as HTMLDetailsElement).open = true;
      }
    });
  }
  // FORK 2026-05-30: capture subagent <details> toggles into expandedSubagents so the
  // open/closed state survives the next per-delta innerHTML rebuild (the `open` attr is
  // rendered from the same set, so first paint is already correct without a restore pass).
  el.querySelectorAll("details.msg-subagent-details[data-subagent-id]").forEach((det) => {
    det.addEventListener("toggle", () => {
      const sid = det.getAttribute("data-subagent-id");
      if (!sid) {
        return;
      }
      if ((det as HTMLDetailsElement).open) {
        expandedSubagents.add(sid);
      } else {
        expandedSubagents.delete(sid);
      }
    });
  });
  if (wasAtBottom) {
    el.scrollTop = el.scrollHeight;
  } else {
    el.scrollTop = prevScrollTop;
  }
  el.querySelectorAll("[data-tid]").forEach((r) =>
    r.addEventListener("click", (ev) => {
      const fileLink = (ev.target as HTMLElement).closest(".sys-file-link") as HTMLElement | null;
      if (fileLink) {
        ev.stopPropagation();
        const fp = fileLink.dataset.path;
        if (!fp) {
          return;
        }
        // Collapse any existing open file viewer
        el.querySelectorAll(".file-viewer-inline").forEach((v) => v.remove());
        // If clicking the same link that was already open, just collapse
        if (fileLink.classList.contains("file-viewer-open")) {
          fileLink.classList.remove("file-viewer-open");
          return;
        }
        el.querySelectorAll(".sys-file-link.file-viewer-open").forEach((l) =>
          l.classList.remove("file-viewer-open"),
        );
        fileLink.classList.add("file-viewer-open");
        const viewer = document.createElement("div");
        viewer.className = "file-viewer-inline";
        viewer.textContent = "Loading...";
        // Insert after the parent system message row
        const parentMsg = fileLink.closest(".msg") ?? fileLink.parentElement!;
        parentMsg.insertAdjacentElement("afterend", viewer);
        const fileApiBase = import.meta.env.DEV ? "/tinker-api" : "/tinker/api";
        fetch(`${fileApiBase}/file-read?path=${encodeURIComponent(fp)}`)
          .then((r) => r.json())
          .then((data: unknown) => {
            if (data.error) {
              viewer.textContent = `Error: ${data.error}`;
              return;
            }
            const name = fp.split("/").pop() || fp;
            const ext = (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
            const isMarkdown = ext === "md" || ext === "mdx";
            const isJson = ext === "json";
            let body: string;
            if (isMarkdown) {
              body = `<div class="file-viewer-content file-viewer-md">${md(data.content)}</div>`;
            } else {
              let content = data.content;
              if (isJson) {
                try {
                  content = JSON.stringify(JSON.parse(content), null, 2);
                } catch {}
              }
              const lines = content.split("\n");
              const numbered = lines
                .map((line: string, i: number) => `<span class="fv-ln">${i + 1}</span>${esc(line)}`)
                .join("\n");
              body = `<pre class="file-viewer-content file-viewer-code">${numbered}</pre>`;
            }
            viewer.innerHTML = `<div class="file-viewer-header"><span>📄 ${esc(name)}</span><span class="file-viewer-path">${esc(fp)}</span></div>${body}`;
          })
          .catch((e) => {
            viewer.textContent = `Fetch error: ${e.message}`;
          });
        return;
      }
      const id = r.getAttribute("data-tid")!;
      if (expandedTools.has(id)) {
        expandedTools.delete(id);
      } else {
        expandedTools.add(id);
      }
      // Remember the clicked row's position relative to the viewport
      const clickedTop = (r as HTMLElement).getBoundingClientRect().top;
      updateChat(true);
      // After re-render, find the same element and adjust scroll so it
      // stays at the exact same viewport position — only content below moves.
      const after = el.querySelector(`[data-tid="${id}"]`) as HTMLElement | null;
      if (after) {
        const newTop = after.getBoundingClientRect().top;
        el.scrollTop += newTop - clickedTop;
      }
    }),
  );
  // Stop button uses event delegation (registered once in init) to survive
  // innerHTML replacements during streaming.
  el.querySelectorAll(".retry-provider-btn").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const prov = (btn as HTMLElement).getAttribute("data-retry-provider");
      if (prov) {
        retryProvider(prov);
      }
    }),
  );
  if (!skipScroll) {
    scrollChat();
  }
}

function updateDots() {
  document
    .querySelectorAll(".gw-dot")
    .forEach((d) => (d.className = `status-dot gw-dot ${connected ? "dot-green" : "dot-red"}`));
  const l = $("gw-label");
  if (l) {
    l.textContent = connected ? "Connected" : "Disconnected";
  }
}

function updateSelect() {
  // Session dropdown removed — tabs handle session switching now. Kept as no-op for callers.
}

function renderTabs() {
  const container = $("tab-bar-scroll");
  if (!container) {
    return;
  }

  let html = "";
  for (const tab of tabs) {
    const isActive = tab.id === activeTabId;
    const classes = ["tab"];
    if (isActive) {
      classes.push("tab-active");
    }
    if (!tab.isAttached) {
      classes.push("tab-unattached");
    }

    const isMain = tab.id === "tab-main";
    const closeBtn = isMain
      ? ""
      : `<span class="tab-close" data-tab-close="${tab.id}">&times;</span>`;

    html += `<div class="${classes.join(" ")}" data-tab-id="${tab.id}" data-hint="${escapeHtml(tab.title)}">
      <span class="tab-title">${escapeHtml(tab.title)}</span>${closeBtn}
    </div>`;
  }
  container.innerHTML = html;
  checkTabOverflow();

  const activeEl = container.querySelector(".tab-active") as HTMLElement | null;
  if (activeEl) {
    activeEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }
}

// FORK 2026-06-04 — jarvis-upgrade task-mpzcjw6n-n45zs (Tab name summary): right-click a tab to
// rename it. Two actions: "Rename…" (manual, type a name) and "Auto-name" (an LLM summary via the
// existing generateTabTitle, recency-weighted + the 🏷️ sentinel). Reuses the proven
// .exec-context-menu / .exec-context-item styling + clamp pattern (openExecContextMenu). The Main
// tab is excluded — its title is force-restored to "🏠 Main" on every loadTabs(), so a rename
// wouldn't stick.
function openTabContextMenu(tabId: string, x: number, y: number) {
  closeTabContextMenu();
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || tab.id === "tab-main") {
    return;
  }
  const menu = document.createElement("div");
  menu.className = "exec-context-menu";
  tabContextMenuEl = menu;
  menu.innerHTML = `
    <button data-tab-action="rename" class="exec-context-item">✏️ Rename…</button>
    <button data-tab-action="auto" class="exec-context-item">${AUTO_NAME_ICON} Auto-name</button>
  `;
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 100)}px`;
  document.body.appendChild(menu);
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - r.width - 8}px`;
    if (r.bottom > window.innerHeight - 8)
      menu.style.top = `${window.innerHeight - r.height - 8}px`;
  });
  menu.querySelectorAll<HTMLElement>(".exec-context-item").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const action = btn.dataset.tabAction;
      closeTabContextMenu();
      if (action === "rename") {
        openTabRename(tabId, x, y);
      } else if (action === "auto") {
        const t = tabs.find((tt) => tt.id === tabId);
        if (t) {
          // FORK 2026-06-06 — u2-tab-naming: while the (local-LLM) summary runs, KEEP the tab's
          // current title (icon + words) visible and gently pulse it via the .tab-renaming class —
          // do NOT swap in a placeholder. generateTabTitle replaces the title on success; on
          // failure/empty it leaves the title untouched. Either way we remove the pulse when done.
          const setRenaming = (on: boolean) => {
            const el = document.querySelector<HTMLElement>(
              `#tab-bar-scroll [data-tab-id="${t.id}"]`,
            );
            if (el) el.classList.toggle("tab-renaming", on);
          };
          setRenaming(true);
          void generateTabTitle(t).finally(() => {
            setRenaming(false);
            // generateTabTitle re-renders on success (dropping the class with the old node); ensure
            // the class is cleared on the current node too in the no-change path.
            setRenaming(false);
          });
        }
      }
    });
  });
}

function closeTabContextMenu() {
  if (tabContextMenuEl) {
    tabContextMenuEl.remove();
    tabContextMenuEl = null;
  }
}

// Floating single-line rename input (the 64px tab is too narrow to edit in place). Enter / blur
// commit, Escape cancels. Persists via the existing saveTabs + renderTabs + updateSessionsPanel.
function openTabRename(tabId: string, x: number, y: number) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || tab.id === "tab-main") {
    return;
  }
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:10000;";
  const input = document.createElement("input");
  input.type = "text";
  input.value = tab.title;
  input.spellcheck = false;
  input.style.cssText =
    "width:200px;font-size:11px;padding:3px 6px;background:var(--surface,#1a1a1a);color:var(--text,#eee);border:1px solid var(--accent,#d97757);border-radius:4px;outline:none;";
  box.appendChild(input);
  box.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
  box.style.top = `${Math.min(y, window.innerHeight - 44)}px`;
  document.body.appendChild(box);
  input.focus();
  input.select();
  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v) {
        tab.title = v;
        // FORK 2026-06-06 — u2-tab-naming: a manual rename is a deliberate title; lock it so
        // loadSessions() won't overwrite it with the server fortune-cookie phrase. Persisted via
        // saveTabs() → survives hard refresh AND gateway restart.
        tab.titleLocked = true;
        saveTabs();
        // FORK 2026-06-10 — u3-tab-naming: also persist server-side (durable across any
        // restart/browser/device, not just this browser's localStorage).
        persistTabNameToServer(tab);
        renderTabs();
        updateSessionsPanel();
      }
    }
    box.remove();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function checkTabOverflow() {
  const bar = $("tab-bar");
  const scroll = $("tab-bar-scroll");
  if (!bar || !scroll) {
    return;
  }
  const overflows = scroll.scrollWidth > scroll.clientWidth;
  bar.classList.toggle("has-overflow", overflows);
}

// FORK 2026-06-04 — bug task-mpkwez3k-ehc9v (thinking indicator: MODELS panel +
// session/all toggle + prefrontal freeze). Single source of truth for "the viewed
// session changed → every viewed-session-scoped indicator must re-derive." Each
// view-change site used to hand-roll its own subset of update calls and they drifted:
// switchToTab forgot updateBudgetPanel() (the MODELS-panel glow kept indicating after a
// tab switch under "session" scope), and attachSessionToTab forgot both
// updateBudgetPanel() AND updatePrefrontalTree() (prefrontal froze "thinking" until you
// toggled scope). Routing ALL of them through here means no indicator can be missed.
// See bible panels.md §147 (single-source-of-truth) + done-signals.md §3.
function refreshViewedSessionIndicators() {
  updateChat();
  updateBtn();
  updateSessionsPanel();
  updateBudgetPanel();
  updatePrefrontalTree();
}

function switchToTab(tabId: string) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || tab.id === activeTabId) {
    return;
  }

  // FORK: Save current tab's full state before switching
  saveCurrentTabState();

  activeTabId = tab.id;
  saveActiveTabId();

  if (tab.sessionKey) {
    sessionKey = tab.sessionKey;
    // FORK: Restore per-tab state atomically — no async, no clearing
    loadTabState(tab.id);
    updateSelect();
    const tmCanvas = $("treemap-canvas");
    if (tmCanvas) {
      (tmCanvas as unknown).__treemapClear?.();
    }
    refreshTimelineRespectingMode();
    // Background refresh from server — only if still attached (server has the session)
    if (tab.isAttached) {
      loadChat();
    }
  } else {
    sessionKey = "";
    loadTabState(tab.id); // loads fresh empty state
    updateSelect();
  }

  renderTabs();
  saveTabs();
  // FORK 2026-05-17 / 2026-06-04: the viewed session changed — re-derive EVERY
  // viewed-session-scoped indicator (chat spinner, button, sessions glow, MODELS glow,
  // prefrontal) through the single helper so none can be missed. Prefrontal filters by
  // the viewed sessionKey under "session" scope and only re-rendered on WS events before
  // ("thinking no matter which session I select"); the MODELS glow had the same bug
  // (task-mpkwez3k-ehc9v). See bible panels.md §147.
  refreshViewedSessionIndicators();
}

function createTab(): Tab {
  // FORK: Eagerly assign a session key so the tab appears in the
  // sessions panel immediately. Gateway auto-creates on first chat.send.
  // FORK 2026-05-25 — bug task-mpjhzu3j-ma9ts (Tabs behavior part 1):
  // tab.title is picked DETERMINISTICALLY from sessionKey via
  // fortuneForKey(). The server-side lazy-mint at session-utils.ts:1648
  // calls the SAME fortuneForKey(key) when populating cookiePhrase, so
  // both sides converge on the same phrase for any given key — no
  // patches, no race, no flip-on-close. Earlier passes used
  // randomFortune() independently on each side; they diverged and the
  // side-panel row flipped phrase the moment the tab closed (priority
  // chain fell from tab.title to cookiePhrase, exposing the server's
  // different pick). See src/shared/fortune-cookies.ts:fortuneForKey.
  const sessionKey = `tinker:${Date.now().toString(36)}`;
  const tab: Tab = {
    id: generateTabId(),
    sessionKey,
    title: fortuneForKey(sessionKey),
    isAttached: true,
  };
  tabs.push(tab);
  tabStates.set(tab.id, freshTabState());
  saveTabs();
  return tab;
}

function closeTab(tabId: string) {
  if (tabId === "tab-main") {
    return;
  }

  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) {
    return;
  }

  tabs.splice(idx, 1);
  tabStates.delete(tabId);

  if (activeTabId === tabId) {
    switchToTab("tab-main");
    // switchToTab already calls renderTabs + saveTabs
    return;
  }

  renderTabs();
  saveTabs();
}

function attachSessionToTab(key: string) {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) {
    return;
  }

  const existing = tabs.find((t) => t.sessionKey === key && t.id !== activeTabId);
  if (existing) {
    switchToTab(existing.id);
    return;
  }

  tab.sessionKey = key;
  tab.isAttached = true;
  const sess = sessions.find((s: unknown) => s.key === key);
  // FORK 2026-05-24 — bug task-mpjhzu3j-ma9ts (Tabs behavior): prefer the
  // server-burned cookiePhrase over the often-empty sess.label. Falls
  // through to .label for sessions that have an explicit meaningful label
  // (group titles, manually-set names). Auto-title from Gemini already
  // overrides tab.title via its own write site, so it still wins for
  // sessions where the topic phrase is more meaningful than the cookie.
  if (sess?.cookiePhrase) {
    tab.title = sess.cookiePhrase;
    // FORK 2026-06-10 — u3-tab-naming: a user-set / auto server name is deliberate; lock it so it
    // isn't treated as a replaceable fortune.
    if ((sess as { cookiePhraseUserSet?: boolean }).cookiePhraseUserSet) tab.titleLocked = true;
  } else if (sess?.label) {
    tab.title = sess.label.slice(0, 30);
  }

  sessionKey = key;
  messages = [];
  loadChat();
  updateSelect();
  renderTabs();
  saveTabs();
  // FORK 2026-06-04 — bug task-mpkwez3k-ehc9v: attaching a session to a tab is a
  // viewed-session change too; route through the same helper so the MODELS glow and the
  // prefrontal panel re-derive for the newly-attached session. Both were missing here,
  // so prefrontal froze "thinking" until a scope toggle forced a re-render.
  refreshViewedSessionIndicators();
}

function updateBtn() {
  const btn = $("action-btn") as HTMLButtonElement | null;
  if (!btn) {
    return;
  }
  if (sending || streamRunId || activeRuns.size > 0) {
    btn.className = "queue";
    btn.textContent = "Queue";
    btn.disabled = !connected;
  } else {
    btn.className = "";
    btn.textContent = "Send";
    btn.disabled = !connected;
  }
}

// ─── Error Description ───
// Extract actionable detail from raw LLM error messages instead of showing generic labels
function describeError(reason: string, errMsg: string): string {
  const e = errMsg.toLowerCase();

  if (reason === "billing") {
    const resetMatch = errMsg.match(/regain access on (\d{4}-\d{2}-\d{2}(?: at [^.]+)?)/i);
    if (resetMatch) {
      return `Spending cap reached — resets ${resetMatch[1]}`;
    }
    if (/credit|payment/i.test(errMsg)) {
      return "No credits remaining";
    }
    return "Spending cap reached";
  }

  if (reason === "auth" || reason === "auth_permanent") {
    if (/OAuth authentication.*not.*supported/i.test(errMsg)) {
      return "OAuth API access disabled — click to re-authenticate";
    }
    if (/refresh token.*(?:not found|invalid|revoked|expired)/i.test(errMsg)) {
      return "OAuth token revoked — click to re-authenticate";
    }
    if (/OAuth token refresh failed/i.test(errMsg)) {
      return "OAuth refresh failed — click to re-authenticate";
    }
    if (/token.*expired/i.test(errMsg)) {
      return "Token expired — click to re-authenticate";
    }
    if (/invalid.*key|invalid.*api/i.test(errMsg)) {
      return "Invalid API key";
    }
    if (/unauthorized|forbidden|permission/i.test(errMsg)) {
      return "Access denied";
    }
    return reason === "auth_permanent"
      ? "Auth permanently failed — click to re-authenticate"
      : "Auth error — click to re-authenticate";
  }

  if (reason === "api_key") {
    return "API key invalid or revoked";
  }

  if (reason === "rate_limit") {
    if (/retry.after.*(\d+)/i.test(errMsg)) {
      const secs = errMsg.match(/retry.after.*?(\d+)/i);
      return secs ? `Rate limited — retry in ${secs[1]}s` : "Rate limited";
    }
    if (/tokens? per minute|tpm/i.test(errMsg)) {
      return "TPM limit hit";
    }
    if (/requests? per minute|rpm/i.test(errMsg)) {
      return "RPM limit hit";
    }
    if (/quota/i.test(errMsg)) {
      return "Quota exceeded";
    }
    return "Rate limited";
  }

  if (reason === "timeout") {
    return "Request timed out — server didn't respond";
  }
  if (reason === "model_not_found") {
    return "Model not available on this provider";
  }
  if (reason === "session_expired") {
    return "Session ended";
  }
  if (reason === "format") {
    return "Request format rejected by provider";
  }
  if (reason === "cooldown") {
    return "Cooling down after repeated failures";
  }
  if (reason === "overloaded" || /overloaded|503|capacity/i.test(e)) {
    return "Server overloaded — retrying";
  }

  if (errMsg && errMsg.length > 0) {
    const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]{1,80})"/);
    if (msgMatch) {
      return msgMatch[1];
    }
    return errMsg.slice(0, 80);
  }
  return reason || "Unknown error";
}

const SHORT_NAMES: Record<string, string> = {
  "qwen3:14b-q4_K_M": "qwen3-14b",
  "gemini-3.1-pro-preview": "gem-3.1-pro",
  "gemini-3-flash-preview": "gem-3-fl",
  "gemini-2.5-pro": "gem-2.5-pro",
  "gemini-2.5-flash": "gem-2.5-fl",
  "gemini-2.0-flash": "gem-2.0-fl",
  "gemini-2.0-flash-lite": "gem-2.0-fl-lt",
  "gpt-5.4-pro": "gpt-5.4p",
  "gpt-5.2-pro": "gpt-5.2p",
};

function modelName(id: string): string {
  const name = id.split("/").slice(1).join("/") || id;
  const clean = name.replace(/^claude-/, "");
  let short = SHORT_NAMES[name] || SHORT_NAMES[clean] || clean;
  // Anthropic model names: opus-4-6 → opus4.6, sonnet-4-6 → sonnet4.6, haiku-4-5 → haiku4.5
  short = short.replace(/^(opus|sonnet|haiku)-(\d+)-(\d+).*$/, "$1$2.$3");
  return short;
}

function simplifyProfileLabel(label: string, mode: string): string {
  // "default" with api_key mode → "api"
  if (label === "default") {
    return mode === "api_key" ? "api" : "";
  }
  // cli-gm / oauth-gm → oauth (GM is primary, no suffix needed)
  if (/^(?:cli|oauth)-gm$/i.test(label)) {
    return "oauth";
  }
  // cli-sv / oauth-sv → oauth-sv
  if (/^(?:cli|oauth)-sv$/i.test(label)) {
    return "oauth-sv";
  }
  // Other cli-*/oauth-* → oauth-{suffix}
  const oauthMatch = label.match(/^(?:cli|oauth)-(.+)$/i);
  if (oauthMatch) {
    return `oauth-${oauthMatch[1]}`;
  }
  return label;
}

function providerOf(id: string): string {
  return id.split("/")[0] || "unknown";
}

// Performance ranking for sorting configured models (lower = more performant).
// Uses keyword matching against the model name portion of the ID.
//
// FORK 2026-05-09: extended tier 0 to recognize the o-series reasoning lineage
// (-o1, -o3, -o5, etc.) and tier 1 to recognize gpt-4.x / gpt-5.x families.
// Without these, gpt-4.1 / gpt-5.x / o3 fell through to tier 5 (everything-else)
// and were ranked as lightweight despite being strong/frontier.
function modelPerfRank(id: string): number {
  const lo = id.toLowerCase();
  // Lightweight tag overrides everything — `o4-mini` etc. are mini variants
  // even though their base name matches the o-series tier-0 regex.
  // Use separator-prefixed regex so we don't false-positive on "mini" inside
  // "gemini" or "lite" inside "elite".
  const isLightweight = /[-/](?:mini|nano|lite)(?:[-/]|$)/.test(lo);
  // Tier 0: frontier reasoning (opus, pro-preview, o-series reasoning).
  // The /[-/]o\d+/ test catches `openai/o3`, `openai/o5`, `something-o7`, etc.,
  // while still NOT matching `gpt-4o` (o is not preceded by a digit-segment).
  if (
    !isLightweight &&
    (lo.includes("opus") || lo.includes("pro-preview") || /[-/]o\d+(?:[-/]|$)/.test(lo))
  ) {
    return 0;
  }
  // Tier 1: strong general (sonnet, pro, gpt-4o, gpt-4.x, gpt-5.x).
  if (
    lo.includes("sonnet") ||
    (lo.includes("pro") && !lo.includes("preview")) ||
    lo.includes("gpt-4o") ||
    /gpt-[45](?:\.\d+)?(?:-pro)?$/.test(lo)
  ) {
    return 1;
  }
  // Tier 2: balanced (flash non-lite)
  if (lo.includes("flash") && !lo.includes("lite")) {
    return 2;
  }
  // Tier 3: balanced-low (haiku)
  if (lo.includes("haiku")) {
    return 3;
  }
  // Tier 4: lightweight / local
  if (isLightweight) {
    return 4;
  }
  return 5;
}

function updateBudgetPanel() {
  const el = $("budget-panel");
  if (!el) {
    return;
  }
  if (!modelConfigData) {
    el.innerHTML =
      '<div style="padding:20px;color:var(--muted);font-size:11px">Loading config...</div>';
    return;
  }

  const { primary, fallbacks, models, authProfiles, authOrder } = modelConfigData;
  let html = '<div class="model-list">';

  // Helper: render auth key rows for a model's provider
  function renderAuthKeyRows(modelId: string, badge: string) {
    const provider = providerOf(modelId);
    const name = modelName(modelId);
    const keys: string[] = authOrder?.[provider] || [];
    // Get counts filtered to THIS model only (prevents cross-model glow)
    const counts = getAuthKeyCounts(modelId);
    if (keys.length <= 1) {
      // Single key or no keys — show one row with model name
      const keyId = keys[0];
      const keyLabel = keyId ? authProfiles?.[keyId]?.label || keyId.split(":")[1] || keyId : "";
      const mode = keyId ? authProfiles?.[keyId]?.mode || "" : "";
      // Simplify profile labels: cli-gm/oauth-gm → oauth, cli-sv/oauth-sv → oauth-sv, default → api
      const shortProfileLabel = simplifyProfileLabel(keyLabel, mode);
      const showSuffix = shortProfileLabel.length > 0;
      const suffix = showSuffix ? ` \u00b7 ${shortProfileLabel}` : "";
      // FORK: Lifecycle events may lack authProfileId, so count is stored under
      // modelId instead of keyId. Fall back to model-level count.
      const singleKeyCount = counts.get(keyId || modelId) || counts.get(modelId) || 0;
      html += renderModelRow(
        modelId,
        provider,
        name,
        badge,
        suffix,
        singleKeyCount,
        providerErrors.get(keyId || modelId),
        keyId,
      );
    } else {
      // Multiple keys — one compact row per key with model name inline
      // Lifecycle events may lack authProfileId, so count is stored under modelId.
      // Fall back to model-level count so all rows glow when the model is active.
      const modelCount = counts.get(modelId) || 0;
      for (let ki = 0; ki < keys.length; ki++) {
        const keyId = keys[ki];
        const prof = authProfiles?.[keyId] || {};
        const rawKeyLabel = prof.label || keyId.split(":")[1] || keyId;
        const keyLabel = simplifyProfileLabel(rawKeyLabel, prof.mode || "");
        html += renderAuthKeyRow(
          keyId,
          keyLabel,
          provider,
          modelId,
          name,
          badge,
          counts.get(keyId) || modelCount,
          providerErrors.get(keyId) || providerErrors.get(modelId),
        );
      }
    }
  }

  // FORK 2026-06-13 (eeg): ONE unified MODELS list replaces the FALLBACK CHAIN +
  // CONFIGURED two-section split (bible §5.8h q10). Chain members (primary +
  // fallbacks, in chain order) sit at the top wearing circled-number badges so
  // the chain primary stays visible in the list; the remaining configured models
  // follow, sorted by the existing rank logic. Every row still renders through
  // renderAuthKeyRows (auth key rows + provider error chips preserved).
  const chain: string[] = [];
  if (primary) {
    chain.push(primary);
  }
  if (fallbacks?.length) {
    chain.push(...fallbacks);
  }
  const _badges = ["\u2460", "\u2461", "\u2462", "\u2463", "\u2464", "\u2465", "\u2466", "\u2467"];
  const chainSet = new Set(chain);
  const otherIds = Object.keys(models || {}).filter((id) => !chainSet.has(id));
  // FORK 2026-05-09: sort by explicit JSON rank first (user-chosen global
  // performance order in openclaw.json), fall back to bible's tier-matching
  // when rank is missing on both sides. This honors finer-grained orderings
  // like gpt-5.5 above gpt-5.4 within the same tier.
  otherIds.sort((a, b) => {
    const ra = (models?.[a] as { rank?: number } | undefined)?.rank ?? 999;
    const rb = (models?.[b] as { rank?: number } | undefined)?.rank ?? 999;
    if (ra !== rb) {
      return ra - rb;
    }
    return modelPerfRank(a) - modelPerfRank(b);
  });
  if (chain.length || otherIds.length) {
    const open = !collapsedModelSections.has("models");
    html += `<div class="model-group${open ? " open" : ""}" data-section="models">`;
    html += '<div class="model-group-label">MODELS</div>';
    html += '<div class="model-group-body">';
    for (let i = 0; i < chain.length; i++) {
      renderAuthKeyRows(chain[i], _badges[i] ?? "");
    }
    for (const id of otherIds) {
      renderAuthKeyRows(id, "");
    }
    html += "</div></div>";
  }

  // FORK 2026-06-13 (eeg): EEG card (bible §5.8h) — (a) the per-tab 8-stop
  // thinking slider (§5.8f, UNCHANGED semantics, still the .model-think-slider
  // token), (b) the model-force slider (writes ONLY { model } — never bundled
  // with thinkingLevel, §5.8f invariant 1), (c) the seismograph paper for the
  // ACTIVE session. The paper re-renders on every updateBudgetPanel() call —
  // effort events and tab switches (refreshViewedSessionIndicators) repaint the
  // right session's trace because the store is keyed by the viewed sessionKey.
  {
    const open = !collapsedModelSections.has("eeg");
    html += `<div class="model-group${open ? " open" : ""}" data-section="eeg">`;
    html += '<div class="model-group-label">EEG</div>';
    html += '<div class="model-group-body">';
    html += renderThinkingSlider();
    html += renderModelForceSlider();
    html +=
      '<div class="eeg-paper" id="eeg-paper">' +
      (sessionKey ? getEegStore(sessionKey).renderSvg({ width: 280 }) : "") +
      "</div>";
    html += "</div></div>";
  }

  html += `</div><div class="budget-updated">Updated ${new Date().toLocaleTimeString()}</div>`;
  el.innerHTML = html;

  // FORK 2026-06-13 (eeg): the seismograph fills the FULL panel width (Oscar
  // 2026-06-13). The SVG needs a concrete pixel width, so measure the now-laid-
  // out #eeg-paper and re-render at its clientWidth — keeping the trace columns
  // pixel-aligned with the effort-slider ticks (both use the same px pads over
  // the same-width box). Re-fills on window resize via the one-time listener.
  fillEegPaper();
  if (!eegResizeBound) {
    eegResizeBound = true;
    window.addEventListener("resize", () => fillEegPaper());
    // persist EVERY session's trace on unload so a mid-turn hard refresh still
    // restores (turn-end already persists completed turns) — Oscar 2026-06-13.
    window.addEventListener("beforeunload", () => {
      for (const sk of eegStores.keys()) {
        saveEegStore(sk);
      }
    });
  }

  // Bind collapse toggles
  el.querySelectorAll<HTMLElement>(".model-group-label").forEach((label) => {
    label.addEventListener("click", () => {
      const group = label.parentElement;
      if (!group) {
        return;
      }
      const section = group.dataset.section;
      if (!section) {
        return;
      }
      group.classList.toggle("open");
      if (group.classList.contains("open")) {
        collapsedModelSections.delete(section);
      } else {
        collapsedModelSections.add(section);
      }
    });
  });

  // FORK 2026-06-13 (eeg): SECONDARY (horizontal/tilt) wheel = vertical SCALE zoom
  // of the length axis (Oscar 2026-06-13). Oscar's secondary wheel emits a
  // HORIZONTAL delta (deltaX) — which was sliding the panel sideways; we capture
  // that (and Ctrl+wheel as a no-tilt-wheel fallback) for zoom instead. The
  // VERTICAL wheel (deltaY) still scrolls history normally.
  const eegPaperEl = el.querySelector<HTMLElement>("#eeg-paper");
  eegPaperEl?.addEventListener(
    "wheel",
    (e) => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const delta = e.ctrlKey ? e.deltaY : horizontal ? e.deltaX : 0;
      if (delta === 0) {
        return; // vertical wheel → normal history scroll
      }
      e.preventDefault();
      const factor = delta < 0 ? 1.12 : 1 / 1.12;
      eegZoom = Math.min(20, Math.max(0.1, eegZoom * factor));
      fillEegPaper();
    },
    { passive: false },
  );

  // FORK 2026-06-13 (eeg): delegate clicks on the seismograph's turn markers →
  // scroll the chat to that turn's answer bubble and flash it (bible §5.8h q7,
  // the context-timeline §5.9 scroll+flash precedent). The bubble is found via
  // the data-eeg-turn stamp renderMsg emits; .eeg-focus is the CSS flash class
  // (owned by the CSS unit).
  el.querySelector<HTMLElement>("#eeg-paper")?.addEventListener("click", (e) => {
    const marker = (e.target as HTMLElement).closest<HTMLElement>(".eeg-marker");
    if (!marker) {
      return;
    }
    const turn = marker.getAttribute("data-eeg-turn");
    if (!turn) {
      return;
    }
    const escapedTurn =
      typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(turn) : turn;
    const bubble = document.querySelector<HTMLElement>(
      `#messages [data-eeg-turn="${escapedTurn}"]`,
    );
    if (!bubble) {
      return;
    }
    bubble.scrollIntoView({ behavior: "smooth", block: "center" });
    bubble.classList.add("eeg-focus");
    setTimeout(() => bubble.classList.remove("eeg-focus"), 2500);
  });
}

function shortErrorLabel(reason: string): string {
  switch (reason) {
    case "billing":
      return "B-CAP";
    case "rate_limit":
      return "LIMIT";
    case "overloaded":
      return "BUSY";
    case "auth":
    case "auth_permanent":
      return "AUTH";
    case "api_key":
      return "KEY";
    case "timeout":
      return "SLOW";
    case "model_not_found":
      return "404";
    case "cooldown":
      return "WAIT";
    case "session_expired":
      return "EXPIRED";
    case "format":
      return "FORMAT";
    default:
      return "FAIL";
  }
}

// ─── Auth Re-auth UI (popover + OAuth popup + paste fallback) ───

const authProfileListeners = new Set<(evt: unknown) => void>();

function showToast(msg: string, isError = false): void {
  const t = document.createElement("div");
  t.className = `toast${isError ? " toast-error" : ""}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

async function startOAuthReauthFlow(profileId: string): Promise<void> {
  let startResult: { sessionId: string; authUrl: string; fallbackAuthUrl: string };
  try {
    startResult = (await req("auth.reauth.start", { profileId })) as unknown;
  } catch (err: unknown) {
    showToast(`Re-auth failed: ${err?.message || err}`, true);
    return;
  }
  const { sessionId, authUrl, fallbackAuthUrl } = startResult;
  const popup = window.open(authUrl, "openclaw-reauth", "width=500,height=700");
  let resolved = false;
  const onAuthEvent = (evt: unknown) => {
    const d = evt.data ?? evt.payload ?? {};
    if (d.profileId === profileId || d.source === "oauth-reauth") {
      resolved = true;
      cleanup();
      try {
        popup?.close();
      } catch {}
      showToast(`Credentials refreshed for ${profileId.replace("anthropic:", "")}`);
    }
  };
  authProfileListeners.add(onAuthEvent);
  const cleanup = () => {
    authProfileListeners.delete(onAuthEvent);
    clearTimeout(fallbackTimer);
    clearInterval(popupPoll);
  };
  const fallbackTimer = setTimeout(() => {
    if (!resolved) {
      cleanup();
      try {
        popup?.close();
      } catch {}
      showPasteModal(sessionId, fallbackAuthUrl, profileId);
    }
  }, 15_000);
  const popupPoll = setInterval(() => {
    if (popup?.closed && !resolved) {
      cleanup();
      showPasteModal(sessionId, fallbackAuthUrl, profileId);
    }
  }, 500);
}

function showPasteModal(sessionId: string, fallbackAuthUrl: string, profileId: string): void {
  document.querySelector(".auth-paste-modal-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "auth-paste-modal-overlay";
  overlay.innerHTML = `
    <div class="auth-paste-modal">
      <h3>Re-authenticate ${esc(profileId.replace("anthropic:", ""))}</h3>
      <p>Auto-capture didn't work. Complete manually:</p>
      <p>1. <a href="${fallbackAuthUrl}" target="_blank" rel="noopener">Click here to authorize</a></p>
      <p>2. Copy the code from the callback page</p>
      <p>3. Paste it below:</p>
      <input type="text" class="auth-paste-input" placeholder="Paste code here" autofocus />
      <div class="auth-paste-actions">
        <button class="auth-paste-cancel">Cancel</button>
        <button class="auth-paste-submit">Submit</button>
      </div>
      <div class="auth-paste-status"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector<HTMLInputElement>(".auth-paste-input")!;
  const status = overlay.querySelector<HTMLElement>(".auth-paste-status")!;
  const submitBtn = overlay.querySelector<HTMLButtonElement>(".auth-paste-submit")!;
  const cancelBtn = overlay.querySelector<HTMLButtonElement>(".auth-paste-cancel")!;
  const submit = async () => {
    const code = input.value.trim();
    if (!code) {
      return;
    }
    submitBtn.disabled = true;
    status.textContent = "Exchanging code...";
    try {
      await req("auth.reauth.exchange", { sessionId, code });
      overlay.remove();
      showToast(`Credentials refreshed for ${profileId.replace("anthropic:", "")}`);
    } catch (err: unknown) {
      status.textContent = `Failed: ${err?.message || err}`;
      status.style.color = "#f38ba8";
      submitBtn.disabled = false;
    }
  };
  submitBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      submit();
    }
  });
  cancelBtn.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  });
}

// ─── Model Panel Rows ───

function renderModelRow(
  id: string,
  provider: string,
  name: string,
  badge: string,
  suffix: string,
  count: number,
  errorInfo?: { error: string; reason: string },
  keyId?: string,
): string {
  const color = PROVIDER_COLORS[provider] || "#6b7280";
  const liveClass = count > 0 ? " model-live" : "";
  const errorClass = errorInfo ? " model-errored" : "";
  const glowStyle =
    count > 0
      ? ` style="--glow-color:${color}80;--glow-bg:${color}18;--glow-bg2:${color}30;--glow-border:${color}50"`
      : "";
  const countBadge = count > 0 ? `<span class="model-agent-count">${count}</span>` : "";
  const isAnthropicOAuth =
    provider === "anthropic" &&
    (keyId?.startsWith("anthropic:cli-") || keyId?.startsWith("anthropic:oauth-"));
  const actionAttr =
    isAnthropicOAuth && errorInfo ? ` data-auth-profile="${esc(keyId || "")}"` : "";
  const errorBadge = errorInfo
    ? `<span class="model-error-badge"${actionAttr} data-hint="${esc(errorInfo.error)}">${shortErrorLabel(errorInfo.reason)}</span>`
    : "";
  const usage = getModelUsage(provider, id, keyId);
  const costLabel = getModelCost(id, keyId);
  const barsHtml = renderUsageBarsOnly(usage);
  const costHtml = renderCostCol(costLabel);
  const nameParts =
    esc(name) + (suffix ? ` <span class="model-auth-suffix">${esc(suffix)}</span>` : "");

  return `<div class="model-row${liveClass}${errorClass}"${glowStyle}>
    <span class="model-name-col">${providerIcon(provider)}<span class="model-name">${nameParts}</span>${badge ? `<span class="model-badge">${badge}</span>` : ""}${errorBadge}</span>
    ${barsHtml}
    ${costHtml}
    ${countBadge}
  </div>`;
}

function renderAuthKeyRow(
  keyId: string,
  label: string,
  provider: string,
  modelId: string,
  name: string,
  badge: string,
  count: number,
  errorInfo?: { error: string; reason: string },
): string {
  const color = PROVIDER_COLORS[provider] || "#6b7280";
  const liveClass = count > 0 ? " model-live" : "";
  const errorClass = errorInfo ? " model-errored" : "";
  const glowStyle =
    count > 0
      ? ` style="--glow-color:${color}80;--glow-bg:${color}18;--glow-bg2:${color}30;--glow-border:${color}50"`
      : "";
  const countBadge = count > 0 ? `<span class="model-agent-count">${count}</span>` : "";
  const isAnthropicOAuth =
    provider === "anthropic" &&
    (keyId?.startsWith("anthropic:cli-") || keyId?.startsWith("anthropic:oauth-"));
  const actionAttr =
    isAnthropicOAuth && errorInfo ? ` data-auth-profile="${esc(keyId || "")}"` : "";
  const errorBadge = errorInfo
    ? `<span class="model-error-badge"${actionAttr} data-hint="${esc(errorInfo.error)}">${shortErrorLabel(errorInfo.reason)}</span>`
    : "";
  const usage = getModelUsage(provider, modelId, keyId);
  const costLabel = getModelCost(modelId, keyId);
  const barsHtml = renderUsageBarsOnly(usage);
  const costHtml = renderCostCol(costLabel);

  return `<div class="model-row auth-key-row${liveClass}${errorClass}"${glowStyle}>
    <span class="model-name-col">${providerIcon(provider)}<span class="model-name">${esc(name)} <span class="auth-key-label">${esc(label)}</span></span>${badge ? `<span class="model-badge">${badge}</span>` : ""}${errorBadge}</span>
    ${barsHtml}
    ${costHtml}
    ${countBadge}
  </div>`;
}

function refreshTreemap() {
  const tmCanvas = $("treemap-canvas");
  if (tmCanvas) {
    (tmCanvas as unknown).__treemapRefresh?.();
  }
}

// ─── Response map ───
function updateResponseMap() {
  const canvas = $("response-canvas");
  if (canvas) {
    (canvas as unknown).__responseRefresh?.();
  }
}

// ─── Bottom-right panel tab switching ───
function switchBrpTab(tab: "context" | "response") {
  const tabs = document.querySelectorAll(".brp-tab");
  const views = document.querySelectorAll(".brp-view");
  tabs.forEach((t) => t.classList.toggle("brp-tab-active", t.id === `brp-tab-${tab}`));
  views.forEach((v) => v.classList.toggle("brp-view-active", v.id === `brp-view-${tab}`));
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) {
    return "now";
  }
  if (diff < 3600000) {
    return Math.floor(diff / 60000) + "m";
  }
  if (diff < 86400000) {
    return Math.floor(diff / 3600000) + "h";
  }
  return Math.floor(diff / 86400000) + "d";
}

// Track which session groups are collapsed (all collapsed by default)
const collapsedGroups = new Set<string>(["cron", "subagent", "whatsapp", "other"]);

function classifySession(key: string): { group: string; shortLabel: string } {
  // agent:main:cron:<uuid>
  if (/:cron:/.test(key)) {
    const uuid = key.split(":cron:")[1] ?? "";
    return { group: "cron", shortLabel: uuid.slice(0, 8) };
  }
  // agent:main:subagent:<uuid>
  if (/:subagent:/.test(key)) {
    const uuid = key.split(":subagent:")[1] ?? "";
    return { group: "subagent", shortLabel: uuid.slice(0, 8) };
  }
  // agent:main:whatsapp:group:<id> or agent:main:whatsapp:direct:<phone>
  if (/:whatsapp:/.test(key)) {
    const tail = key.split(":whatsapp:")[1] ?? "";
    return { group: "whatsapp", shortLabel: tail.replace(/@g\.us$/, "") };
  }
  // agent:main:heartbeat
  if (/:heartbeat/.test(key)) {
    return { group: "pinned", shortLabel: "heartbeat" };
  }
  // agent:main:main
  if (key.endsWith(":main")) {
    return { group: "pinned", shortLabel: "main" };
  }
  // FORK: tinker tab sessions — canonical "agent:main:tinker:xxx" or short "tinker:xxx"
  if (/:tinker:/.test(key) || key.startsWith("tinker:")) {
    const tab = tabs.find((t) => t.sessionKey === key);
    const tinkerSuffix = key.includes(":tinker:") ? key.split(":tinker:")[1] : key.slice(7);
    const label = tab?.title || tinkerSuffix?.slice(0, 8) || "tab";
    return { group: "pinned", shortLabel: label };
  }
  return { group: "other", shortLabel: key.slice(0, 24) };
}

const GROUP_LABELS: Record<string, string> = {
  pinned: "",
  cron: "Cron Jobs",
  subagent: "Subagents",
  whatsapp: "WhatsApp",
  other: "Other",
};

const GROUP_ORDER = ["pinned", "whatsapp", "cron", "subagent", "other"];

// FORK 2026-06-11 — tinkerui-slider: per-tab model badge + 8-stop thinking slider.
// The 8 stops IN ORDER (index 0 = Auto = empty string '' / null). Auto means the
// MAX_THINKING_TOKENS cap is OMITTED so the model decides its own thinking budget
// — it is NOT off; the model still thinks organically. The slider's min=0 max=7
// step=1 maps directly onto this array; the level STRING is what sessions.update
// persists (index 0 -> null). Module-level so the markup, the listener and the
// re-render helper share one source of truth.
// `short` mirrors EEG_STOPS[].short — the compact tick label printed under the
// slider so all 8 stops fit and align with the seismograph columns.
const THINK_STOPS: { lvl: string; label: string; short: string }[] = [
  { lvl: "", label: "Auto", short: "Auto" },
  { lvl: "minimal", label: "Minimal", short: "Min" },
  { lvl: "low", label: "Low", short: "Low" },
  { lvl: "medium", label: "Medium", short: "Med" },
  { lvl: "adaptive", label: "Adaptive", short: "Adpt" },
  { lvl: "high", label: "High", short: "High" },
  { lvl: "xhigh", label: "xHigh", short: "xHi" },
  { lvl: "max", label: "Max", short: "Max" },
];

// FORK 2026-06-13 (eeg): shared tick-label layer printed UNDER a force slider so
// EVERY stop is visible (Oscar's "every option written in the slider") and each
// label centers on the SAME x as its seismograph column (eegStopLeftCss → bible
// §5.8h invariant 2 alignment). The active stop is bolded via .active.
function renderSliderStops(labels: string[], activeIdx: number): string {
  let out = '<div class="model-slider-stops">';
  for (let i = 0; i < labels.length; i++) {
    const cls = i === activeIdx ? "model-slider-stop active" : "model-slider-stop";
    out +=
      `<span class="${cls}" style="left:${eegStopLeftCss(i, labels.length)}">` +
      esc(labels[i]) +
      "</span>";
  }
  out += "</div>";
  return out;
}

// FORK 2026-06-13 (eeg): live-drag highlight — moves the .active class onto the
// tick whose index matches the slider value (replaces the old single readout
// label that renderSliderStops superseded).
function highlightSliderStop(e: Event, rowSelector: string): void {
  const slider = e.target as HTMLInputElement;
  const row = (e.target as HTMLElement).closest(rowSelector);
  if (!row) {
    return;
  }
  const idx = Number(slider.value) || 0;
  const stops = row.querySelectorAll<HTMLElement>(".model-slider-stop");
  stops.forEach((s, i) => s.classList.toggle("active", i === idx));
}

// FORK 2026-06-13 (eeg): the model-force slider's tick row — each stop shows a
// short horizontal line "chip" in that model's EEG IDENTITY (provider color +
// cost-thickness, google = rainbow), so the slider previews how each model will
// appear on the seismograph (Oscar 2026-06-13). Auto = a thin gray dashed chip
// (router's choice). Thickness uses the model's cost at a fixed MEDIUM reference
// effort so the chips are comparable across models.
function renderModelChip(id: string | null, idx: number): string {
  const W = 30;
  const H = 13; // tall enough for fable's 10px line (Oscar's linear scale)
  const y = H / 2;
  if (id === null) {
    return (
      `<svg class="eeg-model-chip" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<line x1="3" y1="${y}" x2="${W - 3}" y2="${y}" stroke="#8A8F98" stroke-width="1.5"` +
      ` stroke-dasharray="3 3" stroke-linecap="round"/></svg>`
    );
  }
  const paint = eegProviderPaint(providerOf(id));
  const w = eegCostWidthPx(id, "medium");
  let defs = "";
  let stroke = paint.stroke;
  if (paint.isRainbow) {
    // Horizontal rainbow. MUST use gradientUnits="userSpaceOnUse" with explicit
    // coords: a horizontal <line> has a ZERO-HEIGHT geometry bbox, so the default
    // objectBoundingBox gradient degenerates and the rainbow vanishes (the
    // seismograph's google gradient only works because those lines are vertical).
    const gid = `eeg-mchip-${idx}`;
    defs =
      `<defs><linearGradient id="${gid}" gradientUnits="userSpaceOnUse"` +
      ` x1="3" y1="0" x2="${W - 3}" y2="0">` +
      `<stop offset="0%" stop-color="#4285F4"/><stop offset="33%" stop-color="#EA4335"/>` +
      `<stop offset="66%" stop-color="#FBBC05"/><stop offset="100%" stop-color="#34A853"/>` +
      `</linearGradient></defs>`;
    stroke = `url(#${gid})`;
  }
  return (
    `<svg class="eeg-model-chip" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `${defs}<line x1="3" y1="${y}" x2="${W - 3}" y2="${y}" stroke="${stroke}"` +
    ` stroke-width="${w.toFixed(1)}" stroke-linecap="round"/></svg>`
  );
}

// FORK 2026-06-13 (eeg): tick row for the MODEL slider — chip (EEG identity)
// stacked over a short label, each centered on its stop's x (eegStopLeftCss).
function renderModelSliderStops(
  stops: { id: string | null; label: string }[],
  activeIdx: number,
): string {
  let out = '<div class="model-slider-stops with-chips">';
  for (let i = 0; i < stops.length; i++) {
    const cls = i === activeIdx ? "model-slider-stop active" : "model-slider-stop";
    const label = stops[i].id === null ? "Auto" : shortModelLabel(stops[i].id as string);
    out +=
      `<span class="${cls}" style="left:${eegStopLeftCss(i, stops.length)}">` +
      renderModelChip(stops[i].id, i) +
      `<span class="model-slider-stop-text">${esc(label)}</span>` +
      "</span>";
  }
  out += "</div>";
  return out;
}

// FORK 2026-06-13 (eeg): compact, DISTINCT label for the force-slider ticks —
// works off the raw model id (NOT modelName, whose "gem-3.1-pro" short form made
// the old regex mislabel a Gemini as "Pro"). Keeps family + the disambiguating
// version/variant so two opus or two gemini stops never collide.
function shortModelLabel(id: string): string {
  const lo = id.toLowerCase();
  if (/fable/.test(lo)) {
    return "Fable";
  }
  if (/opus/.test(lo)) {
    // only one opus on the slider now (4-7 excluded) → no version suffix needed
    return "Opus";
  }
  if (/sonnet/.test(lo)) {
    return "Sonnet";
  }
  if (/haiku/.test(lo)) {
    return "Haiku";
  }
  if (/gemini|(?:^|\/)gem/.test(lo)) {
    const v = (lo.match(/(\d+(?:\.\d+)?)/) || [])[1] || "";
    const kind = /flash/.test(lo) ? "F" : /pro/.test(lo) ? "P" : "";
    return `Gem${v}${kind}`.slice(0, 7);
  }
  if (/gpt-?[\d.]+/.test(lo)) {
    const v = (lo.match(/gpt-?([\d.]+)/) || [])[1] || "";
    const k = /pro/.test(lo) ? "p" : /mini/.test(lo) ? "m" : /nano/.test(lo) ? "n" : "";
    // "GPT" prefix (Oscar 2026-06-13): 5.3cx → GPT5.3, 5.5 → GPT5.5. The codex
    // suffix is dropped — only gpt-5.3-codex carries it and there is no plain 5.3.
    return `GPT${v}${k}`;
  }
  if (/grok/.test(lo)) {
    return "Grok";
  }
  if (/deepseek/.test(lo)) {
    return "DSeek";
  }
  if (/gemma/.test(lo)) {
    return "Gemma";
  }
  return (modelName(id) || id).slice(0, 6);
}

function thinkStopIndexForLevel(level: unknown): number {
  const lv = typeof level === "string" ? level : "";
  const i = THINK_STOPS.findIndex((s) => s.lvl === lv);
  return i >= 0 ? i : 0;
}

// FORK 2026-06-11 — tinkerui-slider: build the per-tab 8-stop thinking slider for
// the Models side panel (#budget-panel). Reads the CURRENTLY-VIEWED session via the
// `sessionKey` module global + `sessions` list, indexes into THINK_STOPS, and
// returns plain-string-concatenated markup that updateBudgetPanel() inserts
// directly UNDER the active tab's model row. Plain '+' concatenation (no nested
// template literals) keeps the path uniform; the .model-think-* CSS is owned by a
// sibling unit. The slider re-renders on tab switch / session update via the
// existing refreshViewedSessionIndicators() -> updateBudgetPanel() path, so it
// always reflects + follows the active tab.
function renderThinkingSlider(): string {
  const active = sessions.find((s: unknown) => (s as { key?: string }).key === sessionKey) as
    | { thinkingLevel?: string }
    | undefined;
  const idx = thinkStopIndexForLevel(active?.thinkingLevel);
  const stop = THINK_STOPS[idx] ?? THINK_STOPS[0];
  return (
    '<div class="model-think-slider-row">' +
    '<span class="model-slider-caption">EFFORT</span>' +
    '<input type="range" class="model-think-slider" min="0" max="7" step="1" value="' +
    String(idx) +
    '" aria-label="Thinking level: ' +
    esc(stop.label) +
    '">' +
    renderSliderStops(
      THINK_STOPS.map((s) => s.short),
      idx,
    ) +
    "</div>"
  );
}

// FORK 2026-06-13 (eeg): stops for the model-force slider (bible §5.8h q2) —
// stop 0 = Auto (router controls the model axis), then the configured models
// sorted by INTELLIGENCE with the SMARTEST on the RIGHT (Oscar 2026-06-13), so
// the model axis reads low→high left→right exactly like the effort slider. Rank
// (Artificial-Analysis Intelligence Index in openclaw.json; lower = smarter) is
// the sort key, modelPerfRank breaks ties. Capped at 7 (keeping the 7 smartest)
// so the row stays a discrete slider. Rebuilt per render/read from
// modelConfigData; shared by the markup and the delegated listeners.
function modelForceStops(): { id: string | null; label: string }[] {
  const stops: { id: string | null; label: string }[] = [{ id: null, label: "Auto" }];
  const cfg = modelConfigData as {
    models?: Record<string, { rank?: number }>;
  } | null;
  if (!cfg) {
    return stops;
  }
  // FORK 2026-06-13 (eeg): drop the older claude-opus-4-7 (keep only opus-4-8) and
  // gpt-5.3-codex (Oscar: "never makes sense to use it"). From Anthropic the slider
  // keeps Sonnet, Opus and Fable.
  const EEG_SLIDER_EXCLUDE = /opus-4-7|gpt-5\.3/i;
  const rankOf = (id: string): number => cfg.models?.[id]?.rank ?? 999;
  // FORK 2026-06-13 (eeg): only show models AT LEAST as smart as sonnet (Oscar:
  // "remove 5.4m, no need if it is not as smart as sonnet"). Sonnet's rank is the
  // intelligence floor; anything ranked below it (mini/nano/haiku/older) is cut.
  let sonnetRank = 999;
  for (const id of Object.keys(cfg.models || {})) {
    if (/sonnet/i.test(id)) {
      sonnetRank = rankOf(id);
      break;
    }
  }
  const ids = Object.keys(cfg.models || {}).filter(
    (id) => !EEG_SLIDER_EXCLUDE.test(id) && rankOf(id) <= sonnetRank,
  );
  // smartest FIRST (lower rank = smarter)
  ids.sort((a, b) => {
    const ra = cfg.models?.[a]?.rank ?? 999;
    const rb = cfg.models?.[b]?.rank ?? 999;
    if (ra !== rb) {
      return ra - rb;
    }
    return modelPerfRank(a) - modelPerfRank(b);
  });
  // keep the 8 SMARTEST (8 so claude-sonnet-4-6 at rank 7 / 8th-smartest makes
  // the cut — Oscar 2026-06-13), then flip so the smartest sits on the RIGHT
  const top = ids.slice(0, 8);
  top.reverse();
  // FORK 2026-06-13: Oscar pins FABLE to the far right (his flagship sits at the
  // end of the intelligence axis, ahead of the rank-1 opus). The rest keep their
  // intelligence order.
  const fi = top.findIndex((id) => /fable/i.test(id));
  if (fi >= 0) {
    const [fable] = top.splice(fi, 1);
    top.push(fable);
  }
  for (const id of top) {
    stops.push({ id, label: modelName(id) });
  }
  return stops;
}

// FORK 2026-06-13 (eeg): the model-force slider (bible §5.8h q2). Mirrors the
// thinking slider's read path — the viewed session's CURRENT model override is
// the session row's `model` field (the same field the Sessions alt-view shows);
// writes go through sessions.update with a { model }-ONLY patch, never bundled
// with thinkingLevel (rejectWebchatSessionMutation — §5.8f invariant 1).
function renderModelForceSlider(): string {
  const stops = modelForceStops();
  const active = sessions.find((s: unknown) => (s as { key?: string }).key === sessionKey) as
    | { model?: string }
    | undefined;
  const cur = typeof active?.model === "string" ? active.model : "";
  let idx = 0;
  if (cur) {
    const found = stops.findIndex((s) => s.id === cur);
    if (found > 0) {
      idx = found;
    }
  }
  const stop = stops[idx] ?? stops[0];
  return (
    '<div class="model-force-slider-row">' +
    '<span class="model-slider-caption">MODEL</span>' +
    '<input type="range" class="model-force-slider" min="0" max="' +
    String(Math.max(0, stops.length - 1)) +
    '" step="1" value="' +
    String(idx) +
    '" aria-label="Model override: ' +
    esc(stop.label) +
    '">' +
    renderModelSliderStops(stops, idx) +
    "</div>"
  );
}

// FORK 2026-06-13 (eeg): true iff the VIEWED session currently has a model
// and/or thinkingLevel override set — derived from the SAME session fields the
// two force sliders read (bible §5.8h q9). Forced samples draw dashed on the
// seismograph: visual proof the force is obeyed.
function viewedSessionForced(): boolean {
  const active = sessions.find((s: unknown) => (s as { key?: string }).key === sessionKey) as
    | { model?: string; thinkingLevel?: string }
    | undefined;
  const modelForced = typeof active?.model === "string" && active.model.length > 0;
  const levelForced = typeof active?.thinkingLevel === "string" && active.thinkingLevel.length > 0;
  return modelForced || levelForced;
}

function updateSessionsPanel() {
  const el = $("sessions-list");
  if (!el) {
    return;
  }
  // FORK 2026-06-11 — tinkerui-slider: the thinking slider now lives in the Models
  // side panel (#budget-panel); it re-paints via refreshViewedSessionIndicators()
  // -> updateBudgetPanel(), so there is no per-tab strip to repaint here.
  const countEl = $("sessions-count");
  if (countEl) {
    countEl.textContent = `(${sessions.length})`;
  }

  // Group sessions
  const groups = new Map<string, Array<{ session: unknown; shortLabel: string }>>();
  for (const s of sessions) {
    const { group, shortLabel } = classifySession(s.key);
    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group)!.push({ session: s, shortLabel });
  }
  // FORK: Inject tab sessions not yet on the server
  for (const tab of tabs) {
    if (tab.id === "tab-main" || !tab.sessionKey) {
      continue;
    }
    const serverKeys = sessions.map((s: unknown) => s.key);
    const hasServer =
      serverKeys.includes(tab.sessionKey) ||
      serverKeys.some((k: string) => k.endsWith(":" + tab.sessionKey));
    if (!hasServer) {
      const fakeSession = { key: tab.sessionKey, label: tab.title };
      if (!groups.has("pinned")) {
        groups.set("pinned", []);
      }
      groups.get("pinned")!.push({ session: fakeSession, shortLabel: tab.title });
    }
  }

  // FORK 2026-05-25 — within the pinned group, force Main first and
  // Heartbeat second. Array.prototype.sort is stable in every modern
  // browser, so items at the same priority (the tinker:* tabs) keep
  // their original ordering — the order sessions.list returned them
  // plus any tab-only entries injected just above.
  const pinned = groups.get("pinned");
  if (pinned) {
    const pinnedPriority = (key: string): number => {
      if (key.endsWith(":main")) return 0;
      if (key.includes(":heartbeat")) return 1;
      return 2;
    };
    pinned.sort(
      (a, b) =>
        pinnedPriority((a.session as { key: string }).key) -
        pinnedPriority((b.session as { key: string }).key),
    );
  }

  const totalEntries = [...groups.values()].reduce((n, arr) => n + arr.length, 0);
  if (!totalEntries) {
    el.innerHTML = '<div style="padding:20px;color:var(--muted);font-size:11px">No sessions</div>';
    return;
  }

  let html = '<div class="session-list">';

  for (const groupKey of GROUP_ORDER) {
    const items = groups.get(groupKey);
    if (!items || items.length === 0) {
      continue;
    }

    if (groupKey === "pinned") {
      // Pinned sessions render directly, no group header
      for (const { session: s, shortLabel } of items) {
        html += renderSessionRow(s, shortLabel);
      }
    } else {
      const label = GROUP_LABELS[groupKey] ?? groupKey;
      const collapsed = collapsedGroups.has(groupKey);
      const hasActive = items.some((i) => i.session.key === sessionKey);
      const arrow = collapsed ? "\u25B8" : "\u25BE";
      html += `<div class="session-group-header${hasActive ? " session-group-has-active" : ""}" data-group="${esc(groupKey)}">
        <span class="session-group-arrow">${arrow}</span>
        <span class="session-group-label">${esc(label)}</span>
        <span class="session-group-count">${items.length}</span>
      </div>`;
      if (!collapsed) {
        for (const { session: s, shortLabel } of items) {
          html += renderSessionRow(s, shortLabel);
        }
      }
    }
  }

  html += "</div>";
  el.innerHTML = html;

  // Wire session row clicks + delete buttons via single event delegation
  // (per-element listeners get destroyed on innerHTML re-render)
  if (!(el as unknown).__sessionsWired) {
    (el as unknown).__sessionsWired = true;

    el.addEventListener("click", async (e) => {
      const tgt = e.target as HTMLElement;

      // ── Delete button (check FIRST — before row click swallows it) ──
      const delBtn = tgt.closest(".session-delete-btn") as HTMLElement | null;
      if (delBtn) {
        e.stopPropagation();
        const key = delBtn.dataset.deleteKey;
        if (!key) {
          return;
        }
        const row = delBtn.closest(".session-row") as HTMLElement | null;
        // FORK 2026-05-24 — bug task-mpjhzu3j-ma9ts: in-flight delete
        // feedback. Sessions with active claude-cli workers can take
        // seconds to delete (server-side cleanupSessionBeforeMutation
        // waits for the worker to drain). Without visible progress, the
        // user clicks again, second click hits a re-rendered row that's
        // a different state, looks like "delete didn't work". Now:
        //   - lock the button (pointer-events: none) to swallow rapid
        //     repeat clicks
        //   - drop opacity to 0.3 (existing behaviour, kept)
        //   - add a small ⌛ overlay so the user sees something is
        //     happening even with no console open
        // On error, restore everything. On success, the next loadSessions
        // re-renders and the row is gone (or restored if server rejected).
        if (row) {
          row.style.opacity = "0.3";
          row.style.pointerEvents = "none";
          row.setAttribute("data-deleting", "1");
        }
        try {
          // FORK (2026-04-24): soft delete — archive transcript on disk
          // instead of wiping it. The UI still treats the session as gone
          // (list refreshes, affected tab closes), but on the next sessions
          // mutation the transcript survives at `sessions-archive/` so we
          // can recover if the click was a misfire or if an in-flight turn
          // was still writing its answer.
          await req("sessions.delete", { key, deleteTranscript: false });
          // FORK 2026-05-24 — bug task-mpjhzu3j-ma9ts: tab-match was using
          // exact `===` which missed the canonicalisation gap. The delete
          // button's data-delete-key is the server's canonical key
          // ("agent:main:tinker:abc") while tab.sessionKey is the
          // unprefixed form ("tinker:abc"); exact equality always
          // failed and the tab stayed open. updateSessionsPanel then
          // re-injected the still-open tab as a "pinned" fake row, so
          // the user saw the deleted session reappear immediately.
          // sessionKeyMatches handles the prefix variance (same helper
          // renderSessionRow uses for the same drift).
          const affectedTab = tabs.find(
            (t) => t.sessionKey && sessionKeyMatches(key, t.sessionKey),
          );
          if (affectedTab && affectedTab.id !== "tab-main") {
            closeTab(affectedTab.id);
          } else if (affectedTab?.id === "tab-main") {
            // Main tab can't be closed — just clear its state
            sessionKey = "";
            messages = [];
            updateChat();
          }
          await loadSessions();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("Failed to delete session:", err);
          if (row) {
            row.style.opacity = "1";
            row.style.pointerEvents = "";
            row.removeAttribute("data-deleting");
          }
        }
        return;
      }

      // ── Session row click (navigate) ──
      const row = tgt.closest(".session-row") as HTMLElement | null;
      if (row) {
        const key = row.dataset.sessionKey;
        if (!key || key === sessionKey) {
          return;
        }

        const activeTab = tabs.find((t) => t.id === activeTabId);
        if (activeTab && !activeTab.isAttached) {
          attachSessionToTab(key);
          return;
        }

        const existingTab = tabs.find((t) => t.sessionKey === key);
        if (existingTab) {
          switchToTab(existingTab.id);
          return;
        }

        const newTab = createTab();
        newTab.sessionKey = key;
        newTab.isAttached = true;
        // FORK 2026-05-24 (fifth pass) — bug task-mpjhzu3j-ma9ts: when
        // the user clicks a session row in the side panel and we create
        // a new tab for it, the burned-in cookiePhrase MUST win over
        // the fresh randomFortune() that createTab() just minted (and
        // over sess.label, which is usually empty for chat-originated
        // sessions). Previously this only checked sess.label, so the
        // fresh random fortune stuck and the user saw a different name
        // every time they opened a session.
        const sess = sessions.find((s: unknown) => s.key === key);
        if (sess?.cookiePhrase) {
          newTab.title = sess.cookiePhrase;
          // FORK 2026-06-10 — u3-tab-naming: lock a deliberate (user/auto) server name.
          if ((sess as { cookiePhraseUserSet?: boolean }).cookiePhraseUserSet)
            newTab.titleLocked = true;
        } else if (sess?.label) {
          newTab.title = sess.label.slice(0, 30);
        }
        renderTabs();
        switchToTab(newTab.id);
      }
    });
  }

  // Wire group header clicks (toggle collapse)
  el.querySelectorAll(".session-group-header").forEach((hdr) => {
    hdr.addEventListener("click", () => {
      const group = (hdr as HTMLElement).dataset.group!;
      if (collapsedGroups.has(group)) {
        collapsedGroups.delete(group);
      } else {
        collapsedGroups.add(group);
      }
      updateSessionsPanel();
    });
  });
}

// FORK 2026-05-23 — defensive backstop matching the same-day server-side
// fix in session-utils.ts. WS-client identification strings should never
// surface as session labels even if old persisted rows still carry them.
// Paired list with the GENERIC_WS_CLIENT_LABELS set in the server-side
// resolver — keep them in sync if either side changes.
const GENERIC_WS_CLIENT_LABELS = new Set(["Tinker UI", "webchat-ui", "openclaw-cli"]);
function meaningfulSessionLabel(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return GENERIC_WS_CLIENT_LABELS.has(s) ? undefined : s;
}

function renderSessionRow(s: unknown, shortLabel: string): string {
  const isActive = s.key === sessionKey || sessionKeyMatches(s.key);
  // FORK 2026-05-23: prefer the client-side tab.title for any session bound
  // to a known tab. Fixes two coupled bugs (paired with session-utils.ts
  // server-side filter on the same day):
  //   1. /clear rotates tab-main's sessionKey from agent:main:main →
  //      tinker:<ts>; the old `isMainSession = s.key.endsWith(":main")`
  //      check returned false post-rotate, so the renderer fell through
  //      to `s.label || s.displayName` — and `s.displayName` defaults to
  //      the WS-client connect handshake's "Tinker UI" string (app.ts:1211),
  //      so the user saw the rotated main session labeled "Tinker UI".
  //   2. The persisted tab title in localStorage (Gemini-generated like
  //      "🔧 Fix auth bug", or "🏠 Main" for tab-main per loadTabs() force-
  //      restore) was being shadowed by the stale server-side label after
  //      gateway restart. The tab.title is the persisted source of truth.
  //   3. Orphaned sessions (closed sub-tabs, old /clear rotations) had no
  //      matching tab AND no useful server label, so they fell through to
  //      s.displayName = "Tinker UI" and showed up as duplicates in the
  //      list. The meaningfulSessionLabel filter blocks that.
  // Resolution order: tab.title (any matching tab) → s.label (server-stored
  // meaningful label) → s.displayName (server-stored meaningful displayName,
  // never a WS-client identifier) → shortLabel.
  //
  // FORK 2026-05-23 (continuation): use sessionKeyMatches for the tab
  // lookup — the gateway stores keys as agent:main:tinker:<ts> (full path)
  // while tab.sessionKey is tinker:<ts> (unprefixed; that's what the
  // /clear-rotate site mints). Exact `===` was failing for tab-main
  // post-/clear, dropping the row through to shortLabel ("npgj631q"
  // instead of "🏠 Main"). sessionKeyMatches handles the prefix variance
  // (defined at app.ts:482 — checks suffix-match in either direction).
  const tab = tabs.find((t) => sessionKeyMatches(s.key, t.sessionKey));
  // FORK 2026-05-25 — bug task-mpjhzu3j-ma9ts: special sessions (main +
  // heartbeat) get a fixed friendly label AND no delete button. The
  // server already rejects sessions.delete on main with INVALID_REQUEST
  // ("Cannot delete the main session …"), so the button was always
  // useless for main; for heartbeat it would technically work but the
  // session immediately reappears as the heartbeat runtime keeps
  // touching it. Per user 2026-05-25: "those sessions should not be
  // deletable" + "I am trying to delete webchat:g-agent-main-main but
  // it does not do anything. Not sure how it came to be, but this is
  // no longer the main session" — the displayName "webchat:g-agent-
  // main-main" was leaking through meaningfulSessionLabel for main
  // (label/displayName fall-through), making main unrecognisable.
  // Hard-special-case both keys: main → "🏠 Main", heartbeat → keep
  // its "❤️ Heartbeat" cookiePhrase (already minted server-side), and
  // OMIT the delete button entirely for either.
  const keySuffix = s.key.split(":").pop() ?? "";
  const isMainSession = s.key.endsWith(":main") || keySuffix === "main";
  const isHeartbeatSession = s.key.endsWith(":heartbeat") || keySuffix === "heartbeat";
  const isProtected = isMainSession || isHeartbeatSession;
  const protectedLabel = isMainSession ? "🏠 Main" : isHeartbeatSession ? "❤️ Heartbeat" : null;

  // FORK 2026-05-24 — bug task-mpjhzu3j-ma9ts ("Tabs behavior" part 1):
  // session-name resolution. Priority:
  //   0. protectedLabel — main/heartbeat get a hard-coded friendly name
  //      (so a stale "webchat:g-agent-main-main" displayName cannot leak
  //      through)
  //   1. tab.title — persisted localStorage (Gemini-titled or "🏠 Main")
  //   2. s.cookiePhrase — gateway-burned long fortune phrase
  //   3. meaningfulSessionLabel(s.label) — server-stored explicit label
  //   4. meaningfulSessionLabel(s.displayName) — server displayName
  //   5. shortLabel — key-derived fallback
  const label =
    protectedLabel ||
    tab?.title ||
    (s.cookiePhrase as string | undefined) ||
    meaningfulSessionLabel(s.label) ||
    meaningfulSessionLabel(s.displayName) ||
    shortLabel;
  const tokens = s.totalTokens ? formatNum(s.totalTokens) + " tok" : "";
  const age = s.updatedAt ? timeAgo(s.updatedAt) : "";
  const channel = s.channel ? `<span style="opacity:.5">${esc(s.channel)}</span>` : "";
  // FORK: Session glow — shimmer when an LLM run is active for this session
  const liveInfo = sessionHasActiveRuns(s.key);
  const liveClass = liveInfo.live ? " session-live" : "";
  const liveColor = liveInfo.provider ? PROVIDER_COLORS[liveInfo.provider] || "#D97757" : "#D97757";
  const liveStyle = liveInfo.live
    ? ` style="--session-glow:${liveColor}40;--session-glow-bg:${liveColor}20"`
    : "";
  // FORK 2026-05-25 — for protected (main + heartbeat) sessions, render
  // an INVISIBLE placeholder button with the same dimensions as the real
  // delete button so the row's right-edge layout (tokens + age + button
  // column) stays aligned across all rows. Per user 2026-05-25: "main
  // and heartbeat now have their details moved to the right. Can you
  // just put a placeholder button, fully transparent, with no action,
  // so that it aligns with the rest?" — `visibility: hidden` keeps the
  // layout space, kills the click, no aria/data-hint exposure.
  const deleteBtnHtml = isProtected
    ? `<button class="session-delete-btn" aria-hidden="true" tabindex="-1" style="visibility:hidden;pointer-events:none">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>`
    : `<button class="session-delete-btn" data-delete-key="${esc(s.key)}" data-hint="Delete session">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>`;
  return `<div class="session-row${isActive ? " session-active" : ""}${liveClass}" data-session-key="${esc(s.key)}"${liveStyle}>
    <span class="session-label" data-hint="${esc(label)}">${esc(label)} ${channel}</span>
    <span class="session-stats">${tokens}${tokens && age ? " · " : ""}${age}</span>
    ${deleteBtnHtml}
  </div>`;
}

/** Auto-scroll only when the user is already near the bottom of the chat. */
function scrollChat() {
  requestAnimationFrame(() => {
    const el = $("messages");
    if (el) {
      const threshold = 80; // px tolerance
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      if (atBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  });
}

// ─── Init Layout ───
function init() {
  if (initialized) {
    return;
  }
  initialized = true;
  restoreProviderErrors();
  app.innerHTML = `
    <nav class="sidebar">
      <button class="nav-btn nav-active" data-tab="chat" data-hint="Chat"><svg viewBox="0 0 24 24" style="stroke:#D97757"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>
      <div class="nav-sep"></div>
      <button class="nav-btn" data-tab="overview" data-hint="Overview"><svg viewBox="0 0 24 24" style="stroke:#4ade80"><line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/></svg></button>
      <button class="nav-btn" data-tab="channels" data-hint="Channels"><svg viewBox="0 0 24 24" style="stroke:#60a5fa"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
      <button class="nav-btn" data-tab="sessions" data-hint="Sessions"><svg viewBox="0 0 24 24" style="stroke:#c084fc"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/></svg></button>
      <button class="nav-btn" data-tab="usage" data-hint="Usage"><svg viewBox="0 0 24 24" style="stroke:#f59e0b"><line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/></svg></button>
      <button class="nav-btn" data-tab="cron" data-hint="Cron"><svg viewBox="0 0 24 24" style="stroke:#fb923c"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg></button>
      <div class="nav-sep"></div>
      <button class="nav-btn" data-tab="agents" data-hint="Agents"><svg viewBox="0 0 24 24" style="stroke:#34d399"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg></button>
      <button class="nav-btn" data-tab="skills" data-hint="Skills"><svg viewBox="0 0 24 24" style="stroke:#facc15"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></button>
      <button class="nav-btn" data-tab="nodes" data-hint="Nodes"><svg viewBox="0 0 24 24" style="stroke:#38bdf8"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg></button>
      <div class="nav-sep"></div>
      <button class="nav-btn" data-tab="config" data-hint="Config"><svg viewBox="0 0 24 24" style="stroke:#a1a1aa"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
      <button class="nav-btn" data-tab="debug" data-hint="Debug"><svg viewBox="0 0 24 24" style="stroke:#f87171"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3 3 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg></button>
      <button class="nav-btn" data-tab="logs" data-hint="Logs"><svg viewBox="0 0 24 24" style="stroke:#94a3b8"><path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M15 8h-5"/><path d="M15 12h-5"/></svg></button>
      <button class="nav-btn" data-tab="recipes" data-hint="Recipes"><svg viewBox="0 0 24 24" style="stroke:#d4a574"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="8" x2="16" y1="13" y2="13"/><line x1="8" x2="12" y1="17" y2="17"/><line x1="8" x2="10" y1="9" y2="9"/></svg></button>
    </nav>
    <div class="topbar">
      <div class="logo" id="new-session-btn" data-hint="New session"><img src="${BASE}icon.png?v=4" alt="T" style="height:76px;width:auto" onmouseenter="this.src='${BASE}icon-neon.png?v=1'" onmouseleave="this.src='${BASE}icon.png?v=4'"><img src="${BASE}icon-neon.png?v=1" style="display:none" aria-hidden="true"></div>
      <div class="tab-bar" id="tab-bar">
        <button class="tab-nav tab-nav-left" id="tab-nav-left" data-hint="Scroll left">&#9664;</button>
        <div class="tab-bar-scroll" id="tab-bar-scroll"></div>
        <button class="tab-add" id="tab-add" data-hint="New tab">+</button>
        <button class="tab-nav tab-nav-right" id="tab-nav-right" data-hint="Scroll right">&#9654;</button>
      </div>
      <!-- FORK 2026-05-24 — bug task-mpjhzu3j-ma9ts (Tabs behavior): topbar
           reorganised into a vertical split. The .topbar-controls wrapper
           groups the toolbox + gateway-status into the bottom-right grid
           cell of .topbar so they sit in their own row beneath the tab
           strip. Previously toolbox + gw-status were direct children of
           .topbar in a horizontal flex; that shared horizontal space with
           the tab-bar and made the topbar's min-content grow with each
           added tab. See base.css .topbar + .topbar-controls selectors.
           (No backticks in this comment — the enclosing innerHTML is a
            tagged template literal; inner backticks terminated it early
            and crashed the page to black on load.) -->
      <div class="topbar-controls">
        <div class="toolbox">
          <!-- FORK 2026-05-12: Exec mode promoted to the leftmost slot — it is
               the primary "mode" toggle in the topbar (per SPEC §0a / §7.1),
               so it sits before the per-feature toggles. -->
          <span id="tb-exec" class="topbar-icon-btn" data-hint="Exec mode — Control Panel HUD">🎯</span>
          <!-- FORK 2026-04-18: Fractal injection toggle. Enabled = Jarvis adds a
               🌿 FRACTAL (post-reflection) section. Disable for speed.
               (Amygdala button + section removed 2026-06-07.) -->
          <span id="tb-fractal" class="topbar-icon-btn tb-active" data-hint="Fractal reflection">🌿</span>
          <span id="tb-voice" class="topbar-icon-btn tb-active" data-hint="Voice">🔊</span>
          <span id="tb-timeline" class="topbar-icon-btn tb-active" data-hint="Timeline">📊</span>
          <!-- FORK 2026-04-27: renamed "Models" → "Side panel". The button
               expands/collapses the entire right rpanel cluster (models,
               sessions, prefrontal, …); the old "Models" label only described
               the topmost section, which was confusing once the panel grew.
               Story Mode (🎬) was removed entirely — collapsed-by-default is
               the design contract per bible §5.6, and the per-tool click
               toggle is the only override that should exist. -->
          <span id="tb-models" class="topbar-icon-btn tb-active" data-hint="Side panel">🗂️</span>
        </div>
        <span id="gw-status" style="color:var(--muted);font-size:11px;display:flex;align-items:center;gap:4px"><span class="status-dot gw-dot dot-red"></span> <span id="gw-label">Connecting…</span></span>
      </div>
    </div>
    <div id="recipe-banner" class="recipe-banner hidden">
      <span class="recipe-banner-icon">📋</span>
      <span id="recipe-banner-name" class="recipe-banner-name"></span>
      <span class="recipe-banner-sep">&mdash;</span>
      <span id="recipe-banner-step" class="recipe-banner-step"></span>
      <span id="recipe-banner-progress" class="recipe-banner-progress"></span>
    </div>
    <div class="alt-view" id="alt-view"></div>
    <div class="chat-area">
      <div class="messages" id="messages"><div class="msg system">Connecting to gateway...</div></div>
      <!-- FORK 2026-06-11 — tinkerui-slider: the per-tab 8-stop thinking slider was
           RELOCATED from this chat-area strip into the Models side panel
           (#budget-panel), rendered directly under the active tab's model row by
           renderThinkingSlider()/updateBudgetPanel(). No chat-area control here. -->
      <div class="chat-input">
        <textarea id="chat-textarea" placeholder="Message..." rows="1"></textarea>
        <button id="action-btn" disabled>Send</button>
      </div>
    </div>
    <div class="right-panels">
      <div class="rpanel" id="sessions-panel">
        <div class="rpanel-header">📋 Sessions <span id="sessions-count" class="sessions-count"></span></div>
        <div id="sessions-list" class="rpanel-body">Loading...</div>
      </div>
      <div class="rpanel budget-panel-wrapper">
        <div class="rpanel-header">🕸️ Models
          <span class="ct-switch" id="budget-scope-toggle">
            <span class="ct-switch-label ct-switch-label--active" data-scope="session">Session</span>
            <span class="ct-switch-track" data-scope-track><span class="ct-switch-thumb"></span></span>
            <span class="ct-switch-label" data-scope="all">All</span>
          </span>
          <button id="budget-refresh" class="budget-refresh-btn" data-hint="Refresh">↻</button>
        </div>
        <div id="budget-panel" class="rpanel-body">Loading...</div>
      </div>
      <div class="rpanel" id="prefrontal-panel">
        <div class="rpanel-header"><button id="recipes-book-btn" class="rpanel-header-btn" title="Open the recipe book">🌳 RECIPES</button> <span id="prefrontal-count" class="sessions-count"></span>
          <span class="ct-switch" id="prefrontal-scope-toggle">
            <span class="ct-switch-label ct-switch-label--active" data-scope="session">Session</span>
            <span class="ct-switch-track" data-scope-track><span class="ct-switch-thumb"></span></span>
            <span class="ct-switch-label" data-scope="all">All</span>
          </span>
        </div>
        <div id="prefrontal-graph" class="rpanel-body prefrontal-graph-container"></div>
        <div id="recipe-progress" class="recipe-progress-container" style="display:none"></div>
      </div>
      <div class="rpanel" id="amygdala-panel">
        <div class="rpanel-header">🧠 AMYGDALA <span id="amygdala-count" class="sessions-count"></span>
          <span class="ct-switch" id="amygdala-scope-toggle">
            <span class="ct-switch-label ct-switch-label--active" data-scope="session">Session</span>
            <span class="ct-switch-track" data-scope-track><span class="ct-switch-thumb"></span></span>
            <span class="ct-switch-label" data-scope="all">All</span>
          </span>
        </div>
        <div id="amygdala-body" class="rpanel-body"><div style="color:var(--muted);font-size:12px;padding:8px">Idle — gate decisions stream here live as the agent runs tools.</div></div>
      </div>
    </div>
    <div class="context-timeline" id="context-timeline"></div>
    <div class="bottom-right-panel" id="bottom-right-panel">
      <div class="brp-views">
        <div class="brp-view brp-view-active" id="brp-view-context">
          <div id="treemap-canvas" style="position:absolute;inset:0"></div>
          <button class="brp-back-btn" id="brp-back-context" data-hint="Back" style="display:none">\u25C0</button>
        </div>
        <div class="brp-view" id="brp-view-response">
          <div id="response-canvas" style="position:absolute;inset:0;overflow:hidden"></div>
          <button class="brp-back-btn" id="brp-back-response" data-hint="Back" style="display:none">\u25C0</button>
        </div>
      </div>
      <div id="treemap-footer" class="treemap-footer"><span id="brp-footer-text"></span><span id="brp-meta" class="brp-meta"></span></div>
    </div>
  `;

  // ─── Global tooltip system (viewport-clamped) ───
  const hintEl = document.createElement("div");
  hintEl.id = "global-hint";
  document.body.appendChild(hintEl);
  let hintTarget: HTMLElement | null = null;

  function positionHint(target: HTMLElement) {
    const text = target.dataset.hint;
    if (!text) {
      return;
    }
    hintEl.textContent = text;
    hintEl.style.opacity = "1";
    const rect = target.getBoundingClientRect();
    const pad = 6;

    // Measure tooltip size
    hintEl.style.left = "0";
    hintEl.style.top = "0";
    const tw = hintEl.offsetWidth;
    const th = hintEl.offsetHeight;

    // Default: centered above
    let left = rect.left + rect.width / 2 - tw / 2;
    let top = rect.top - th - pad;

    // If not enough room above, show below
    if (top < pad) {
      top = rect.bottom + pad;
    }
    // Clamp horizontal to viewport
    if (left < pad) {
      left = pad;
    }
    if (left + tw > window.innerWidth - pad) {
      left = window.innerWidth - pad - tw;
    }
    // Clamp vertical
    if (top + th > window.innerHeight - pad) {
      top = window.innerHeight - pad - th;
    }

    hintEl.style.left = `${left}px`;
    hintEl.style.top = `${top}px`;
  }

  document.addEventListener("mouseover", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-hint]");
    if (target && target.dataset.hint) {
      hintTarget = target;
      positionHint(target);
    } else if (hintTarget) {
      hintEl.style.opacity = "0";
      hintTarget = null;
    }
  });
  document.addEventListener("mouseout", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-hint]");
    if (target === hintTarget) {
      hintEl.style.opacity = "0";
      hintTarget = null;
    }
  });

  const ta = $("chat-textarea") as HTMLTextAreaElement;
  // FORK 2026-06-06 (bug: unsent draft lost on hard refresh) — seed the composer
  // from the ACTIVE tab's per-tab draft. (The connect/init flow also loads this
  // once activeTabId is resolved; this is the early best-effort for activeTabId.)
  try {
    ta.value = loadDraftFor(activeTabId);
  } catch {}
  function autoResizeTA() {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }
  ta.addEventListener("input", () => {
    autoResizeTA();
    // FORK 2026-06-06: persist the unsent draft to the ACTIVE tab's per-tab key
    // AND mirror it into that tab's TabState.draft so a tab switch (which
    // restores from TabState) and a hard refresh (which restores from
    // localStorage) both show the right text.
    if (activeTabId) {
      saveDraftFor(activeTabId, ta.value);
      const st = tabStates.get(activeTabId);
      if (st) {
        st.draft = ta.value;
      }
    }
  });
  // FORK 2026-06-07 — durability: force-persist + ring-archive the current composer draft when the
  // tab is hidden or the page is about to unload, so Chrome's localStorage flush lag / an unexpected
  // close can't drop the latest keystrokes.
  const flushDraftNow = () => {
    try {
      if (activeTabId && ta.value) {
        saveDraftFor(activeTabId, ta.value);
        archiveDraft(activeTabId, ta.value);
      }
    } catch {
      /* ignore */
    }
  };
  window.addEventListener("beforeunload", flushDraftNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDraftNow();
  });
  // Size to fit restored draft + focus
  if (ta.value) {
    requestAnimationFrame(autoResizeTA);
  }
  ta.focus();
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (ta.value.trim()) {
        // FORK 2026-06-07 — do NOT clear the saved draft here. send() clears it ONLY on a
        // CONFIRMED send (and restores it on failure), so a failed send can't lose the draft.
        send(ta.value);
        ta.value = "";
        ta.style.height = "auto";
      }
    }
  });
  $("action-btn")!.addEventListener("click", () => {
    if (ta.value.trim()) {
      // FORK 2026-06-07 — clearing is owned by send() (clears on confirmed send, restores on
      // failure) so a failed send never loses the draft.
      send(ta.value);
      ta.value = "";
      ta.style.height = "auto";
      ta.focus();
    }
  });
  // FORK 2026-06-11 — tinkerui-slider: delegated listeners for the thinking slider,
  // now rendered INSIDE the Models side panel (#budget-panel) directly under the
  // active tab's model row (see renderThinkingSlider + updateBudgetPanel). `input`
  // updates the sibling .model-think-label live as the user drags; `change` (drag
  // release) persists. The patch is ONLY { thinkingLevel } — any other field trips
  // rejectWebchatSessionMutation (~app.ts:3897). Index 0 -> null (= Off). Bound on
  // the panel element (which is re-innerHTML'd every render) so the delegate keeps
  // catching freshly-rendered sliders.
  const budgetPanelEl = $("budget-panel");
  if (budgetPanelEl) {
    const readThinkStop = (e: Event) => {
      const slider = (e.target as HTMLElement).closest(
        ".model-think-slider",
      ) as HTMLInputElement | null;
      if (!slider) {
        return null;
      }
      const idx = Math.max(0, Math.min(THINK_STOPS.length - 1, Number(slider.value) || 0));
      return THINK_STOPS[idx] ?? THINK_STOPS[0];
    };
    budgetPanelEl.addEventListener("input", (e) => {
      const stop = readThinkStop(e);
      if (!stop) {
        return;
      }
      highlightSliderStop(e, ".model-think-slider-row");
    });
    budgetPanelEl.addEventListener("change", (e) => {
      const stop = readThinkStop(e);
      if (!stop) {
        return;
      }
      highlightSliderStop(e, ".model-think-slider-row");
      if (sessionKey) {
        req("sessions.update", {
          key: sessionKey,
          patch: { thinkingLevel: stop.lvl || null },
        }).catch(() => {});
      }
    });
    // FORK 2026-06-13 (eeg): delegated listeners for the model-force slider
    // (bible §5.8h q2) — same pattern as the thinking slider above. `input`
    // updates the sibling label live; `change` (drag release) persists. The
    // patch is ONLY { model } — bundling it with thinkingLevel would trip
    // rejectWebchatSessionMutation (§5.8f invariant 1). Index 0 -> null (Auto =
    // router controls the model axis again).
    const readModelStop = (e: Event) => {
      const slider = (e.target as HTMLElement).closest(
        ".model-force-slider",
      ) as HTMLInputElement | null;
      if (!slider) {
        return null;
      }
      const stops = modelForceStops();
      const idx = Math.max(0, Math.min(stops.length - 1, Number(slider.value) || 0));
      return stops[idx] ?? stops[0];
    };
    budgetPanelEl.addEventListener("input", (e) => {
      const stop = readModelStop(e);
      if (!stop) {
        return;
      }
      highlightSliderStop(e, ".model-force-slider-row");
    });
    budgetPanelEl.addEventListener("change", (e) => {
      const stop = readModelStop(e);
      if (!stop) {
        return;
      }
      highlightSliderStop(e, ".model-force-slider-row");
      if (sessionKey) {
        req("sessions.update", {
          key: sessionKey,
          patch: { model: stop.id || null },
        }).catch(() => {});
      }
    });
  }
  // Session-select dropdown removed — tabs handle session switching now
  $("budget-refresh")!.addEventListener("click", () => {
    loadBudget();
  });
  // FORK: Auth error badge click — direct OAuth re-auth
  $("budget-panel")?.addEventListener("click", (e) => {
    const badge = (e.target as HTMLElement).closest<HTMLElement>(".model-error-badge");
    if (!badge) {
      return;
    }
    e.stopPropagation();
    const profileId = badge.dataset.authProfile;
    if (!profileId) {
      return;
    }
    startOAuthReauthFlow(profileId);
  });
  // FORK 2026-05-17: BOTH scope switches (Models #budget-scope-toggle AND
  // Prefrontal #prefrontal-scope-toggle) drive the one budgetScope via
  // setBudgetScope. Previously only the Models switch had a handler — the
  // prefrontal one was a dead control — and that handler never re-rendered
  // prefrontal. See bible panels.md §147.
  for (const scopeToggleId of SCOPE_TOGGLE_IDS) {
    $(scopeToggleId)?.addEventListener("click", (e) => {
      const el = e.target as HTMLElement;
      const label = el.closest("[data-scope]") as HTMLElement | null;
      const track = el.closest("[data-scope-track]") as HTMLElement | null;
      if (!label && !track) {
        return;
      }
      const next: "session" | "all" = label
        ? (label.dataset.scope as "session" | "all")
        : budgetScope === "session"
          ? "all"
          : "session";
      setBudgetScope(next);
    });
  }

  // ─── Fractal injection toggle (FORK 2026-04-18; amygdala removed 2026-06-07) ───
  const fraBtn = $("tb-fractal")!;
  applyInjectToggleChrome();
  fraBtn.addEventListener("click", () => {
    injectToggles = { ...injectToggles, fractal: !injectToggles.fractal };
    saveInjectToggles(injectToggles);
    applyInjectToggleChrome();
  });

  // FORK 2026-04-27: Story Mode toggle + handler removed. The topbar 🎬 was
  // deleted; collapsed-by-default with per-tool click-to-expand is the only
  // contract now. See bible §5.6 for rationale.

  // ─── Filesystem link → open in system viewer (FORK 2026-04-18) ───
  // Any <code class="fs-link" data-path="..."> rendered by md() (typically
  // in pointers like fractal-prompt.md) becomes clickable. Calls the
  // gateway RPC config.openExternalFile which invokes xdg-open / open /
  // Start-Process with the path as a single argv element.
  //
  // FORK 2026-05-10: Bare filenames (data-name only, no data-path) are
  // resolved on first click via files.resolveBareName, then opened. The
  // resolved path is cached on the element so subsequent clicks skip the
  // resolver. A session-scope cache (bareNameCache) avoids re-resolving the
  // same filename across multiple bubbles.
  const bareNameCache = new Map<string, string | null>();
  function openResolvedPath(link: HTMLElement, path: string): void {
    link.classList.add("fs-link-opening");
    req("config.openExternalFile", { path })
      .then((res: { ok?: boolean; error?: string; path?: string }) => {
        link.classList.remove("fs-link-opening");
        if (res?.ok === false) {
          link.classList.add("fs-link-error");
          link.title = res.error ?? "open failed";
          setTimeout(() => link.classList.remove("fs-link-error"), 4000);
        } else {
          link.classList.add("fs-link-opened");
          setTimeout(() => link.classList.remove("fs-link-opened"), 1500);
        }
      })
      .catch((err: unknown) => {
        link.classList.remove("fs-link-opening");
        link.classList.add("fs-link-error");
        link.title = String(err);
        setTimeout(() => link.classList.remove("fs-link-error"), 4000);
      });
  }
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const link = target?.closest(".fs-link") as HTMLElement | null;
    if (!link) {
      return;
    }
    const path = link.dataset.path;
    if (path) {
      ev.preventDefault();
      ev.stopPropagation();
      openResolvedPath(link, path);
      return;
    }
    const name = link.dataset.name;
    if (!name) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    // Cached miss → flag as not found, no re-RPC
    if (bareNameCache.has(name)) {
      const cached = bareNameCache.get(name);
      if (cached === null) {
        link.classList.add("fs-link-error");
        link.title = `not found in any allowlisted root`;
        setTimeout(() => link.classList.remove("fs-link-error"), 4000);
        return;
      }
      link.dataset.path = cached as string;
      openResolvedPath(link, cached as string);
      return;
    }
    link.classList.add("fs-link-opening");
    req("files.resolveBareName", { name })
      .then((res: { matches?: string[]; ambiguous?: boolean; count?: number; reason?: string }) => {
        link.classList.remove("fs-link-opening");
        const matches = Array.isArray(res?.matches) ? res.matches : [];
        if (matches.length === 0) {
          bareNameCache.set(name, null);
          link.classList.add("fs-link-error");
          link.title = res?.reason ?? "not found in any allowlisted root";
          setTimeout(() => link.classList.remove("fs-link-error"), 4000);
          return;
        }
        // Single match (or first match in first-hit-root) — open it.
        // For ambiguous results we still take the first; the server
        // returns deterministic order (root-walk order), and the bible
        // §5.68 invariant prefers workspace > tinkerclaw > jarvis-icu >
        // ~/.openclaw. A future refinement can add an LLM disambiguation
        // pass here (haiku-tier) when matches.length > 1.
        const resolved = matches[0];
        bareNameCache.set(name, resolved);
        link.dataset.path = resolved;
        if (res?.ambiguous) {
          link.title = `${matches.length} matches, opening ${resolved}`;
        }
        openResolvedPath(link, resolved);
      })
      .catch((err: unknown) => {
        link.classList.remove("fs-link-opening");
        link.classList.add("fs-link-error");
        link.title = String(err);
        setTimeout(() => link.classList.remove("fs-link-error"), 4000);
      });
  });

  // ─── Voice mute toggle (§5.36) ───
  const voiceBtn = $("tb-voice")!;
  const muteApi = "/tinker/api/jarvis-mute";
  fetch(muteApi)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d: { muted: boolean }) => voiceBtn.classList.toggle("tb-active", !d.muted))
    .catch(() => {});
  voiceBtn.addEventListener("click", () => {
    const willMute = voiceBtn.classList.contains("tb-active");
    voiceBtn.classList.toggle("tb-active", !willMute);
    fetch(muteApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ muted: willMute }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { muted: boolean }) => voiceBtn.classList.toggle("tb-active", !d.muted))
      .catch(() => {
        voiceBtn.classList.toggle("tb-active", !willMute);
        voiceBtn.classList.add("tb-error");
        setTimeout(() => voiceBtn.classList.remove("tb-error"), 5000);
      });
  });

  // ─── Timeline toggle (bottom panels expand/collapse) ───
  // FORK 2026-05-12: persist collapsed state across hard refresh, mirroring
  // the `tinker.execMode` pattern at line ~7460. Without this, the panel
  // visibility silently reset to "visible" on every reload even though the
  // topbar button is a toggle the user expects to remember its position.
  const tlBtn = $("tb-timeline")!;
  if (localStorage.getItem("tinker.bottomCollapsed") === "1") {
    app.classList.add("bottom-collapsed");
    tlBtn.classList.remove("tb-active");
  }
  tlBtn.addEventListener("click", () => {
    const collapsed = app.classList.toggle("bottom-collapsed");
    tlBtn.classList.toggle("tb-active", !collapsed);
    localStorage.setItem("tinker.bottomCollapsed", collapsed ? "1" : "0");
  });

  // ─── Models toggle (right panels expand/collapse) ───
  // FORK 2026-05-12: persist collapsed state — same rationale as the timeline
  // toggle directly above. See `tinker.execMode` for the canonical pattern.
  const mdBtn = $("tb-models")!;
  if (localStorage.getItem("tinker.rightCollapsed") === "1") {
    app.classList.add("right-collapsed");
    mdBtn.classList.remove("tb-active");
  }
  mdBtn.addEventListener("click", () => {
    const collapsed = app.classList.toggle("right-collapsed");
    mdBtn.classList.toggle("tb-active", !collapsed);
    localStorage.setItem("tinker.rightCollapsed", collapsed ? "1" : "0");
  });

  // ─── Exec mode toggle (Control Panel HUD: graphs + calendar + tasks) ───
  // FORK 2026-05-11 (tinkerclaw-control-panel Phase C MVP). The HUD is
  // rendered on demand into the page as a position:absolute aside; styles
  // live in tinker-ui/src/styles/base.css under the `.exec-panel` rules.
  const execBtn = $("tb-exec")!;
  let execPanelEl: HTMLElement | null = null;
  let execTasksTimer: ReturnType<typeof setInterval> | null = null;

  function ensureExecPanel(): HTMLElement {
    if (execPanelEl) return execPanelEl;
    const el = document.createElement("aside");
    el.id = "exec-panel";
    el.className = "exec-panel";
    // FORK 2026-05-13 — exec-panel split into two tabs per user request: the
    // Pulse tab holds graphs + KPIs (read sparingly, periodic glance), the
    // Today tab holds calendar + tasks (the daily-driver flow). Active tab
    // persists in `tinker.execTab`. CSS hides the inactive group via
    // body-level classes on .exec-panel.
    el.innerHTML = `
      <div class="exec-tabs" role="tablist">
        <button class="exec-tab" data-tab="pulse" role="tab">📈 Pulse</button>
        <button class="exec-tab" data-tab="today" role="tab">📅 Today</button>
      </div>
      <div class="exec-tab-body exec-tab-body-pulse">
        <div class="exec-section exec-kpis">
          <div class="exec-section-title">
            <span>📊 KPIs</span>
            <button class="exec-section-refresh" data-section="kpis" title="Re-poll every KPI now">↻</button>
          </div>
          <div class="exec-kpis-body" id="exec-kpis-body">Loading…</div>
        </div>
        <div class="exec-section exec-graphs">
          <div class="exec-section-title">
            <span>📈 Graphs</span>
            <button class="exec-section-refresh" data-section="graphs" title="Re-poll every graph now">↻</button>
          </div>
          <div class="exec-graphs-body" id="exec-graphs-body">Loading…</div>
        </div>
      </div>
      <div class="exec-tab-body exec-tab-body-today">
        <div class="exec-section exec-calendar">
          <div class="exec-section-title">📅 Calendar (7d)</div>
          <div class="exec-calendar-body">Calendar sync lands in Phase E.</div>
        </div>
        <div class="exec-section exec-tasks">
          <div class="exec-section-title">
            <span>✅ Tasks</span>
            <span class="exec-progress-inline" id="exec-progress-inline"></span>
            <span class="exec-busy-inline" id="exec-busy-inline" title="Today's scheduled load (events + task estimates / 8h workday)"></span>
          </div>
          <div class="exec-filter-bar" id="exec-filter-bar"></div>
          <div class="exec-progress-bar-wrap"><div class="exec-progress-bar" id="exec-progress-bar"></div></div>
          <div class="exec-add-group-wrap">
            <button id="exec-add-group-toggle" class="exec-add-group-toggle">+ Add group</button>
            <form id="exec-add-group-form" class="exec-add-group-form" style="display:none">
              <input id="exec-add-group-label" type="text" placeholder="Group label (max 32 chars)" maxlength="32" required />
              <button type="submit" class="exec-add-group-submit">Add</button>
              <button type="button" id="exec-add-group-cancel" class="exec-add-group-cancel">Cancel</button>
            </form>
          </div>
          <div id="exec-tasks-body" class="exec-tasks-body">Loading…</div>
          <!-- FORK 2026-05-23 (F2) — bottom + Add task bar removed. The new
               affordance is a per-group "+ Add task" button (data-action=
               "add-task-to-axis") in each group / sub-group header, which
               opens an inline form via openInlineAddTaskForm anchored under
               that header. The task lands in the group it was added from,
               so the axis dropdown is no longer needed. -->
        </div>
      </div>
    `;
    app.appendChild(el);
    execPanelEl = el;
    attachExecPointerDragHandlers(el);
    attachExecGroupPointerDragHandlers(el);
    renderExecFilterBar();
    // FORK 2026-05-23 (F2) — bottom + Add task form replaced by per-group
    // affordance. attachExecTaskAddHandlers + repopulateExecAddAxisOptions
    // were deleted; openInlineAddTaskForm (mirrors openInlineSubgroupForm)
    // takes over.
    attachExecAddGroupHandlers(el);
    attachExecTabHandlers(el);
    // Global handlers: click-outside closes context menu; Escape closes too.
    document.addEventListener("click", (ev) => {
      if (execContextMenuEl && !execContextMenuEl.contains(ev.target as Node)) {
        closeExecContextMenu();
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeExecContextMenu();
    });
    return el;
  }

  // ───────────────────────────────────────────────── exec tabs (Pulse/Today)
  // FORK 2026-05-13 — two-tab split: Pulse (graphs + KPIs) vs. Today
  // (calendar + tasks). Per-tab visibility is via a body class on the
  // .exec-panel (`.exec-tab-active-pulse` / `.exec-tab-active-today`); CSS
  // hides the inactive tab's body. Switching the Pulse tab triggers a KPI
  // load if no observations are in memory yet.
  type ExecTab = "pulse" | "today";
  let execActiveTab: ExecTab = (localStorage.getItem("tinker.execTab") as ExecTab) || "today";

  function applyExecTab(panel: HTMLElement, tab: ExecTab): void {
    execActiveTab = tab;
    localStorage.setItem("tinker.execTab", tab);
    panel.classList.toggle("exec-tab-active-pulse", tab === "pulse");
    panel.classList.toggle("exec-tab-active-today", tab === "today");
    panel.querySelectorAll<HTMLElement>(".exec-tab").forEach((btn) => {
      btn.classList.toggle("exec-tab-on", btn.dataset.tab === tab);
    });
    if (tab === "pulse") {
      void loadExecKpis();
    }
  }

  function attachExecTabHandlers(panel: HTMLElement): void {
    panel.querySelectorAll<HTMLElement>(".exec-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab as ExecTab | undefined;
        if (tab) applyExecTab(panel, tab);
      });
    });
    // Section-level refresh: re-poll every metric in that section, then re-render.
    panel.querySelectorAll<HTMLButtonElement>(".exec-section-refresh").forEach((btn) => {
      btn.addEventListener("click", () => {
        const section = btn.dataset.section as "kpis" | "graphs" | undefined;
        if (!section) return;
        void refreshExecSection(section);
      });
    });
    // Per-row refresh: delegated click on .exec-kpi-row-refresh inside either body.
    const onRowRefresh = (ev: Event) => {
      const target = ev.target as HTMLElement | null;
      const btn = target?.closest<HTMLButtonElement>(".exec-kpi-row-refresh");
      if (!btn) return;
      ev.stopPropagation();
      const id = btn.dataset.id;
      if (!id) return;
      void refreshExecMetric(id, btn);
    };
    panel.querySelector("#exec-kpis-body")?.addEventListener("click", onRowRefresh);
    panel.querySelector("#exec-graphs-body")?.addEventListener("click", onRowRefresh);
    applyExecTab(panel, execActiveTab);
  }

  // FORK 2026-05-13 — on-demand poll for a single metric. Calls the new
  // control-panel.metrics.poll RPC so the backend hits the real upstream
  // (GitHub API, npm registry, etc.) and writes a fresh observation; then
  // re-fetches and re-renders only this row.
  async function refreshExecMetric(metricId: string, btn: HTMLButtonElement): Promise<void> {
    btn.classList.add("exec-kpi-row-refresh-spinning");
    try {
      await req("control-panel.metrics.poll", { id: metricId });
    } catch (err) {
      console.error("[exec-panel] metrics.poll failed", metricId, err);
    } finally {
      btn.classList.remove("exec-kpi-row-refresh-spinning");
    }
    await loadExecKpis({ force: true });
  }

  // Section-level refresh: re-poll every metric in either KPIs or Graphs.
  // Fire-and-forget poll RPCs in parallel; reload once they all settle.
  async function refreshExecSection(section: "kpis" | "graphs"): Promise<void> {
    const targetSelector =
      section === "kpis"
        ? `#exec-kpis-body .exec-kpi-row[data-id]`
        : `#exec-graphs-body .exec-kpi-row[data-id]`;
    const rows = Array.from(ensureExecPanel().querySelectorAll<HTMLElement>(targetSelector));
    const ids = rows.map((r) => r.dataset.id).filter((x): x is string => !!x);
    await Promise.allSettled(ids.map((id) => req("control-panel.metrics.poll", { id })));
    await loadExecKpis({ force: true });
  }

  // ───────────────────────────────────────────────────── KPI rendering
  // Strategy: for every SNAPSHOT metric, fetch its recent observations.
  //   - 0 points  → render a "pending first poll" line
  //   - 1 point   → render a one-line text KPI (e.g. "⭐ Stars: 124")
  //   - ≥2 points → render a sparkline + the latest value alongside
  // The exec-panel's actual data is driven by the backend poller; this
  // UI just visualizes whatever it finds.
  type KpiMetric = {
    id: string;
    class: "LIVE" | "SNAPSHOT";
    source: string;
    cadence_seconds: number | null;
    template: string;
  };
  type KpiObservation = { metric_id: string; ts: number; value: number };

  let execKpiLastLoad = 0;
  const KPI_LABELS: Record<string, { icon: string; label: string }> = {
    "kpi.github.stars": { icon: "⭐", label: "GitHub stars" },
    "kpi.github.forks": { icon: "🍴", label: "Forks" },
    "kpi.github.open_issues": { icon: "🐞", label: "Open issues+PRs" },
    "kpi.npm.downloads.weekly": { icon: "📦", label: "npm weekly" },
    "kpi.npm.downloads.monthly": { icon: "📦", label: "npm monthly" },
    "graph.website.visits": { icon: "🌐", label: "Website visits" },
    // FORK 2026-06-04 — online-presence metrics (execmode-pulse graphs).
    "kpi.moltbook.karma": { icon: "🦞", label: "Moltbook karma" },
    "kpi.moltbook.posts": { icon: "📝", label: "Moltbook posts" },
    "graph.moltbook.comments": { icon: "💬", label: "Moltbook comments" },
    "graph.moltbook.followers": { icon: "👥", label: "Moltbook followers" },
    "graph.github.traffic.views14d": { icon: "👁", label: "Repo views/day" },
    "graph.github.traffic.clones14d": { icon: "⬇", label: "Repo clones/day" },
    "graph.clawhub.installs": { icon: "🧩", label: "ClawHub installs" },
    "kpi.inbound.organic": { icon: "🔗", label: "Organic inbound links" },
    "graph.inbound.ours": { icon: "🔗", label: "Inbound links (ours)" },
  };

  function deriveKpiPresentation(id: string): { icon: string; label: string; target: string } {
    // id pattern: kpi.<kind>.<target?> OR graph.<kind>.<target?>.
    for (const prefix of Object.keys(KPI_LABELS)) {
      if (id === prefix || id.startsWith(prefix + ".")) {
        const target = id.length > prefix.length ? id.slice(prefix.length + 1) : "";
        return { ...KPI_LABELS[prefix], target };
      }
    }
    return { icon: "📊", label: id.replace(/^(kpi|graph)\./, ""), target: "" };
  }

  // FORK 2026-05-13 — Templates discriminate which section a metric renders in.
  // "single-stat" | "streak" | "traffic-light" → KPIs section (compact one-liner)
  // "sparkline"   | "bar-trend"                → Graphs section (chart block)
  function isGraphTemplate(template: string): boolean {
    return template === "sparkline" || template === "bar-trend";
  }

  // FORK 2026-05-13 — auto-retry chain. First attempt of a fresh load shows
  // the green "Loading…" placeholder; subsequent retries keep it visible.
  // Only after MAX_KPI_ATTEMPTS consecutive failures do we surface the red
  // error block. The retry timer is cancellable so a user-initiated reload
  // (force=true via a section ↻) starts a fresh chain immediately.
  const MAX_KPI_ATTEMPTS = 6;
  let execKpiRetryTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadExecKpis(opts: { force?: boolean; attempt?: number } = {}): Promise<void> {
    const panel = ensureExecPanel();
    const kpisBody = panel.querySelector("#exec-kpis-body") as HTMLElement | null;
    const graphsBody = panel.querySelector("#exec-graphs-body") as HTMLElement | null;
    if (!kpisBody || !graphsBody) return;
    const attempt = opts.attempt ?? 1;
    // First attempt of a fresh load: cancel any pending retry and paint the
    // loading state so the user sees immediate feedback.
    if (attempt === 1) {
      if (execKpiRetryTimer !== null) {
        clearTimeout(execKpiRetryTimer);
        execKpiRetryTimer = null;
      }
      const loadingHtml = `<div class="exec-kpi-loading">Loading metrics…</div>`;
      kpisBody.innerHTML = loadingHtml;
      graphsBody.innerHTML = loadingHtml;
      kpisBody.dataset.populated = "";
      graphsBody.dataset.populated = "";
    }
    // 60s throttle — only honored on first attempt of a fresh load. Retries
    // and force-clicks bypass it.
    const now = Date.now();
    if (
      attempt === 1 &&
      !opts.force &&
      now - execKpiLastLoad < 60_000 &&
      kpisBody.dataset.populated === "1" &&
      graphsBody.dataset.populated === "1"
    ) {
      return;
    }
    if (attempt === 1) execKpiLastLoad = now;
    try {
      const metricsRes = (await req("control-panel.list", {})) as { metrics: KpiMetric[] };
      const visible = (metricsRes.metrics ?? []).filter(
        (m) => (m.id.startsWith("kpi.") || m.id.startsWith("graph.")) && m.class === "SNAPSHOT",
      );
      // FORK 2026-06-05 — load ALL recorded history (no time window). The 30d
      // cap was hiding months of already-collected data; Oscar wants the full
      // record. No from_ts → every observation since the metric's first point;
      // the chart's fullRange auto-fits the span and zoom/pan covers it all.
      const obsLists = await Promise.all(
        visible.map(async (m) => {
          try {
            const r = (await req("control-panel.query", {
              id: m.id,
              limit: 100000,
            })) as { observations: KpiObservation[] };
            return { metric: m, observations: (r.observations ?? []).slice().reverse() };
          } catch {
            return { metric: m, observations: [] as KpiObservation[] };
          }
        }),
      );
      const kpiHtml = obsLists
        .filter(({ metric }) => !isGraphTemplate(metric.template))
        .map(({ metric, observations }) => renderKpiRow(metric, observations, "compact"))
        .join("");
      // FORK 2026-06-04 — Graphs section groups graph-template metrics by family
      // (github, moltbook, …) into one multi-line chart each: numeric Y axis,
      // adaptive time X axis, colored lines + legend + hover crosshair.
      const GROUP_TITLES: Record<string, string> = {
        github: "GitHub",
        moltbook: "Moltbook",
        clawhub: "ClawHub",
        inbound: "Inbound links",
        website: "Website",
        npm: "npm",
      };
      // Gray suffix shown next to the group title (e.g. GitHub graph → "GitHub TinkerClaw").
      const GROUP_ACCENTS: Record<string, string> = {
        github: "TinkerClaw",
      };
      const groupMeta = (id: string): { key: string; title: string; accent?: string } => {
        const seg = id.split(".")[1] ?? id;
        return {
          key: seg,
          title: GROUP_TITLES[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1),
          accent: GROUP_ACCENTS[seg],
        };
      };
      // Per-series styling: distinct colors, dashed = "external/organic", a
      // secondary right axis for series whose scale dwarfs the others (github
      // views vs cumulative clones), and cumulative running-totals where clearer.
      const SERIES_STYLE: Record<
        string,
        {
          color?: string;
          dash?: boolean;
          cumulative?: boolean;
          axis?: "left" | "right";
          label?: string;
        }
      > = {
        // NOT cumulative: clones14d is GitHub's trailing-14-day rolling total; summing
        // daily snapshots double-counts each clone ~14× (the bogus "~50k"). Show the
        // real 14d window value instead (~750).
        "graph.github.traffic.clones14d": { color: "#8ECAE6", axis: "left" },
        "graph.github.traffic.views14d": { color: "#F4A261", axis: "right" },
        // FORK 2026-06-05 — Inbound links: one hue per destination target, the
        // solid line = external (organic / others created), dashed = ours (we
        // created). Same color pairs the two lines of a target visually.
        "graph.inbound.tinkerclaw.external": { color: "#8ECAE6", label: "tinkerclaw · external" },
        "graph.inbound.tinkerclaw.ours": {
          color: "#8ECAE6",
          dash: true,
          label: "tinkerclaw · ours",
        },
        "graph.inbound.thetinkerzone.external": {
          color: "#F4A261",
          label: "thetinkerzone · external",
        },
        "graph.inbound.thetinkerzone.ours": {
          color: "#F4A261",
          dash: true,
          label: "thetinkerzone · ours",
        },
        "graph.inbound.sprintpaper.external": { color: "#c084fc", label: "sprintpaper · external" },
        "graph.inbound.sprintpaper.ours": {
          color: "#c084fc",
          dash: true,
          label: "sprintpaper · ours",
        },
        // FORK 2026-06-06 — ClawHub REINSTATED (appeal #2517). Our globalcaos/jarvis-voice
        // is live again — verified on clawhub.ai: 3 downloads, 0 stars (the "4.5k" was a
        // bad clawskills.sh mirror). Ours-only; add lines as we re-publish more skills.
        "graph.clawhub.jarvis-voice": { color: "#fbbf24", label: "jarvis-voice (ours)" },
      };
      const presenceGroups = new Map<string, GGroup>();
      for (const { metric, observations } of obsLists) {
        if (!isGraphTemplate(metric.template) || observations.length === 0) continue;
        const meta = groupMeta(metric.id);
        let grp = presenceGroups.get(meta.key);
        if (!grp) {
          grp = { key: meta.key, title: meta.title, series: [], accent: meta.accent };
          presenceGroups.set(meta.key, grp);
        }
        // Strip the group name from the line label ("Moltbook karma" → "karma").
        let label = deriveKpiPresentation(metric.id).label;
        if (label.toLowerCase().startsWith(meta.title.toLowerCase() + " ")) {
          label = label.slice(meta.title.length + 1);
        }
        grp.series.push({
          id: metric.id,
          label,
          points: observations.map((o) => ({ ts: o.ts, value: o.value })),
          ...(SERIES_STYLE[metric.id] ?? {}),
        });
      }
      kpisBody.innerHTML = kpiHtml || `<div class="exec-kpi-empty">No KPIs configured yet.</div>`;
      graphsBody.innerHTML = renderPresenceGraphsHtml([...presenceGroups.values()]);
      kpisBody.dataset.populated = "1";
      graphsBody.dataset.populated = "1";
      // FORK 2026-06-04 — grouped charts get zoom/pan/hover here. The old
      // attachGraphInteractions stays (now a no-op: no .exec-kpi-spark-tall
      // remain) so the compact-KPI sparkline wiring path is untouched.
      attachGraphInteractions(panel);
      attachPresenceGraphs(graphsBody);
    } catch (err) {
      console.error(`[exec-panel] loadExecKpis attempt ${attempt} failed`, err);
      // Auto-retry with backoff: 500, 1000, 2000, 3000, 4000 ms. ~16s total
      // across MAX_KPI_ATTEMPTS attempts before we surface the red error.
      if (attempt < MAX_KPI_ATTEMPTS) {
        const delayMs = Math.min(500 * Math.pow(2, attempt - 1), 4000);
        execKpiRetryTimer = setTimeout(() => {
          execKpiRetryTimer = null;
          void loadExecKpis({ force: true, attempt: attempt + 1 });
        }, delayMs);
        // The "Loading…" placeholder stays visible during retries.
        return;
      }
      const errStr =
        err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
      const msg = `<div class="exec-kpi-error">Failed to load metrics: ${escapeHtml(errStr)}</div>`;
      kpisBody.innerHTML = msg;
      graphsBody.innerHTML = msg;
    }
  }

  // FORK 2026-05-13 — `mode` controls chart density. "compact" is the
  // single-line KPIs row (tiny 80×18 inline sparkline if ≥2 samples).
  // "tall" is the Graphs row — bigger 200×56 chart block with axis margin.
  // Both modes always render a per-row ↻ button + the "last updated" age.
  function renderKpiRow(
    metric: KpiMetric,
    observations: KpiObservation[],
    mode: "compact" | "tall" = "compact",
  ): string {
    const pres = deriveKpiPresentation(metric.id);
    const targetLabel = pres.target
      ? `<span class="exec-kpi-target">${escapeHtml(pres.target)}</span>`
      : "";
    const tsAndRefresh = (latest: KpiObservation) => `
        <span class="exec-kpi-ts" title="${new Date(latest.ts).toISOString()}">${formatKpiAge(Date.now() - latest.ts)} ago</span>
        <button class="exec-kpi-row-refresh" data-id="${escapeHtml(metric.id)}" title="Re-poll now">↻</button>`;
    if (observations.length === 0) {
      return `
        <div class="exec-kpi-row exec-kpi-pending" data-id="${escapeHtml(metric.id)}">
          <span class="exec-kpi-icon">${pres.icon}</span>
          <span class="exec-kpi-label">${escapeHtml(pres.label)}</span>
          ${targetLabel}
          <span class="exec-kpi-value">pending first poll…</span>
          <button class="exec-kpi-row-refresh" data-id="${escapeHtml(metric.id)}" title="Poll now">↻</button>
        </div>`;
    }
    if (observations.length === 1) {
      const latest = observations[observations.length - 1];
      return `
        <div class="exec-kpi-row exec-kpi-single" data-id="${escapeHtml(metric.id)}">
          <span class="exec-kpi-icon">${pres.icon}</span>
          <span class="exec-kpi-label">${escapeHtml(pres.label)}</span>
          ${targetLabel}
          <span class="exec-kpi-value">${formatKpiNumber(latest.value)}</span>
          ${tsAndRefresh(latest)}
        </div>`;
    }
    const latest = observations[observations.length - 1];
    const earliest = observations[0];
    const delta = latest.value - earliest.value;
    const deltaSign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
    const deltaAbs = Math.abs(delta);
    const spanDays = Math.max(1, Math.round((latest.ts - earliest.ts) / 86_400_000));
    const sparkline = renderKpiSparkline(observations, mode, metric.id);
    if (mode === "tall") {
      return `
        <div class="exec-kpi-row exec-kpi-graph" data-id="${escapeHtml(metric.id)}">
          <div class="exec-kpi-graph-header">
            <span class="exec-kpi-icon">${pres.icon}</span>
            <span class="exec-kpi-label">${escapeHtml(pres.label)}</span>
            ${targetLabel}
            <span class="exec-kpi-value">${formatKpiNumber(latest.value)}</span>
            <span class="exec-kpi-delta" title="vs ${spanDays}d ago">${deltaSign}${formatKpiNumber(deltaAbs)} / ${spanDays}d</span>
            ${tsAndRefresh(latest)}
          </div>
          <div class="exec-kpi-graph-body">${sparkline}</div>
        </div>`;
    }
    return `
      <div class="exec-kpi-row exec-kpi-series" data-id="${escapeHtml(metric.id)}">
        <span class="exec-kpi-icon">${pres.icon}</span>
        <span class="exec-kpi-label">${escapeHtml(pres.label)}</span>
        ${targetLabel}
        ${sparkline}
        <span class="exec-kpi-value">${formatKpiNumber(latest.value)}</span>
        <span class="exec-kpi-delta" title="vs ${spanDays}d ago">${deltaSign}${formatKpiNumber(deltaAbs)} / ${spanDays}d</span>
        ${tsAndRefresh(latest)}
      </div>`;
  }

  function renderKpiSparkline(
    observations: KpiObservation[],
    mode: "compact" | "tall" = "compact",
    metricId?: string,
  ): string {
    const w = mode === "tall" ? 320 : 80;
    const h = mode === "tall" ? 60 : 18;
    const pad = mode === "tall" ? 4 : 1;
    const xs = observations.map((o) => o.ts);
    const ys = observations.map((o) => o.value);
    const xMin = xs[0];
    const xMax = xs[xs.length - 1];
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const xSpan = Math.max(1, xMax - xMin);
    const ySpan = Math.max(0.01, yMax - yMin);
    const ptToXY = (o: KpiObservation): [number, number] => {
      const x = pad + ((o.ts - xMin) / xSpan) * (w - 2 * pad);
      const y = h - pad - ((o.value - yMin) / ySpan) * (h - 2 * pad);
      // For a flat line, pin to mid-height so it doesn't degenerate.
      return [x, ySpan < 0.5 ? h / 2 : y];
    };
    const points = observations.map(ptToXY);
    const path = points
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
    // Tall mode adds a soft fill under the line for visual weight.
    let fillPath = "";
    if (mode === "tall" && points.length >= 2) {
      const first = points[0];
      const last = points[points.length - 1];
      fillPath = `<path d="${path} L${last[0].toFixed(1)},${h - pad} L${first[0].toFixed(1)},${h - pad} Z" fill="currentColor" fill-opacity="0.12" stroke="none" vector-effect="non-scaling-stroke" />`;
    }
    // FORK 2026-05-13 — preserved view state per metric so zoom/pan survive
    // a poll-driven re-render. Reads from execGraphView; falls back to the
    // natural [0..w] viewBox when nothing is stored.
    const stored = metricId ? execGraphView.get(metricId) : undefined;
    const viewX = stored?.x ?? 0;
    const viewW = stored?.w ?? w;
    // `data-natural-w/h` so the wheel+drag handlers know the underlying
    // canvas bounds and can clamp the viewBox against zoom-out / pan-off.
    return `<svg class="exec-kpi-spark exec-kpi-spark-${mode}" viewBox="${viewX} 0 ${viewW} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true"
        data-metric-id="${metricId ?? ""}" data-natural-w="${w}" data-natural-h="${h}">
        ${fillPath}
        <path d="${path}" fill="none" stroke="currentColor" stroke-width="${mode === "tall" ? 1.6 : 1.2}" vector-effect="non-scaling-stroke" />
      </svg>`;
  }

  // FORK 2026-05-13 — per-metric viewBox state for the Graphs section's
  // tall sparklines. Mouse wheel zooms around the cursor; horizontal drag
  // pans. State survives re-renders triggered by polling or refresh clicks
  // so the user doesn't lose their position. Double-click to reset.
  const execGraphView: Map<string, { x: number; w: number }> = new Map();

  function attachGraphInteractions(panel: HTMLElement): void {
    const svgs = panel.querySelectorAll<SVGSVGElement>(".exec-kpi-spark-tall");
    svgs.forEach((svg) => {
      // Idempotency: skip if we've already wired this element.
      if (svg.dataset.interactive === "1") return;
      svg.dataset.interactive = "1";
      const metricId = svg.dataset.metricId || "";
      const naturalW = Number(svg.dataset.naturalW || 320);
      const naturalH = Number(svg.dataset.naturalH || 60);
      const MIN_ZOOM_W = Math.max(10, naturalW * 0.05); // ≤ 20× zoom
      const MAX_ZOOM_W = naturalW;
      svg.style.cursor = "grab";

      const writeView = (x: number, w: number) => {
        const clampedW = Math.max(MIN_ZOOM_W, Math.min(MAX_ZOOM_W, w));
        const clampedX = Math.max(0, Math.min(naturalW - clampedW, x));
        svg.setAttribute("viewBox", `${clampedX} 0 ${clampedW} ${naturalH}`);
        if (metricId) execGraphView.set(metricId, { x: clampedX, w: clampedW });
      };

      const getView = (): { x: number; w: number } => {
        const vb = (svg.getAttribute("viewBox") || `0 0 ${naturalW} ${naturalH}`).split(/\s+/);
        return { x: Number(vb[0]), w: Number(vb[2]) };
      };

      svg.addEventListener(
        "wheel",
        (ev) => {
          ev.preventDefault();
          const rect = svg.getBoundingClientRect();
          const cursorFrac = (ev.clientX - rect.left) / Math.max(1, rect.width);
          const view = getView();
          // Negative deltaY = scroll up = zoom in.
          const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2;
          const newW = view.w * factor;
          const cursorInData = view.x + cursorFrac * view.w;
          const newX = cursorInData - cursorFrac * newW;
          writeView(newX, newW);
        },
        { passive: false },
      );

      let dragStart: { clientX: number; viewX: number; viewW: number } | null = null;
      svg.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        const view = getView();
        dragStart = { clientX: ev.clientX, viewX: view.x, viewW: view.w };
        svg.setPointerCapture(ev.pointerId);
        svg.style.cursor = "grabbing";
      });
      svg.addEventListener("pointermove", (ev) => {
        if (!dragStart) return;
        const rect = svg.getBoundingClientRect();
        const dxScreen = ev.clientX - dragStart.clientX;
        const dxData = -(dxScreen / Math.max(1, rect.width)) * dragStart.viewW;
        writeView(dragStart.viewX + dxData, dragStart.viewW);
      });
      const endDrag = (ev: PointerEvent) => {
        if (!dragStart) return;
        dragStart = null;
        svg.releasePointerCapture?.(ev.pointerId);
        svg.style.cursor = "grab";
      };
      svg.addEventListener("pointerup", endDrag);
      svg.addEventListener("pointercancel", endDrag);

      svg.addEventListener("dblclick", (ev) => {
        ev.preventDefault();
        if (metricId) execGraphView.delete(metricId);
        svg.setAttribute("viewBox", `0 0 ${naturalW} ${naturalH}`);
      });
    });
  }

  function formatKpiNumber(n: number): string {
    if (!Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (abs >= 10_000) return `${(n / 1000).toFixed(1)}k`;
    if (abs >= 1000) return n.toLocaleString();
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  function formatKpiAge(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  function renderExecFilterBar() {
    const bar = document.getElementById("exec-filter-bar");
    if (!bar) return;
    // FORK 2026-05-12 (SPEC v3.3) — `snoozed` chip added: shows tasks the user
    // has back-burnered indefinitely. Every other filter excludes back_burner
    // so the pile only surfaces when explicitly requested.
    const filters: Array<{ key: ExecFilter; label: string }> = [
      { key: "unfinished", label: "Unfinished" },
      { key: "all_today", label: "All today" },
      { key: "resolved", label: "Resolved" },
      { key: "snoozed", label: "💤 Snoozed" },
      { key: "all", label: "All" },
    ];
    bar.innerHTML = filters
      .map(
        (f) =>
          `<button class="exec-filter-chip${execFilter === f.key ? " exec-filter-chip-active" : ""}" data-filter="${f.key}">${f.label}</button>`,
      )
      .join("");
    bar.querySelectorAll<HTMLElement>(".exec-filter-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        execFilter = btn.dataset.filter as ExecFilter;
        localStorage.setItem("tinker.execFilter", execFilter);
        renderExecFilterBar();
        void loadExecTasks();
      });
    });
  }

  function execFilterAccepts(t: ExecTask): boolean {
    // FORK 2026-05-23 (F1) — deleted (dropped/dismissed) tasks are invisible
    // under every filter, unconditionally. The 'Deleted' filter chip and the
    // soft-delete bucket were removed; legacy rows that still carry these
    // statuses must never reach the render path. `tasks.remove` is the new
    // hard-delete path; this guard keeps any straggling rows from showing
    // up under 'All' or anywhere else.
    if (t.status === "dropped" || t.status === "dismissed") return false;
    switch (execFilter) {
      case "unfinished":
        return t.status === "open" || t.status === "in_progress";
      case "resolved":
        return t.status === "resolved";
      case "snoozed":
        return t.status === "back_burner";
      case "all":
        // "All" means everything currently in play — snoozed tasks are not
        // in play, they're the user's "don't show me but don't forget" pile.
        // Deleted tasks are filtered out by the top-of-function guard above.
        return t.status !== "back_burner";
      case "all_today":
      default: {
        // FORK 2026-05-14 — "All today" means tasks for today's plate:
        // overdue, due today, or undated. A task rescheduled to a future
        // date must drop out of this list, otherwise the chip is identical
        // to "All" minus snoozed. (Deleted filtered out above.)
        if (t.status === "back_burner") return false;
        if (!t.due_date) return true;
        const now = new Date();
        const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        return t.due_date.slice(0, 10) <= todayIso;
      }
    }
  }

  function escapeExecAttr(s: string): string {
    return s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  }

  // FORK 2026-05-14 — merge a metadata patch onto a task's current metadata
  // object. Used by the snooze-until-tomorrow + bring-back paths so the
  // tasks.update call doesn't wipe Todoist/Gmail/labels metadata. Passing
  // `null` (or undefined) for a key removes it from the merged object.
  function mergeTaskMetadata(t: ExecTask, patch: Record<string, unknown>): Record<string, unknown> {
    let cur: Record<string, unknown> = {};
    if (t.metadata_json) {
      try {
        const parsed = JSON.parse(t.metadata_json);
        if (parsed && typeof parsed === "object") cur = parsed as Record<string, unknown>;
      } catch {
        cur = {};
      }
    }
    const next: Record<string, unknown> = { ...cur, ...patch };
    for (const k of Object.keys(next)) {
      if (next[k] == null) delete next[k];
    }
    return next;
  }

  function formatExecAge(ms: number): string {
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
  }

  type ExecTask = {
    id: string;
    text: string;
    context_md: string | null;
    status: "open" | "in_progress" | "resolved" | "dropped" | "dismissed" | "back_burner";
    source: string;
    source_ref: string | null;
    priority_axis: string | null;
    priority_rank: number;
    est_minutes: number | null;
    hands: "user" | "assistant" | "either" | null;
    created_at: number;
    due_date: string | null;
    dismissal_kind: string | null;
    dismissal_note: string | null;
    metadata_json: string | null;
  };

  // Filter + expand state — persists between renders & sessions.
  type ExecFilter = "unfinished" | "all_today" | "resolved" | "snoozed" | "all";
  // FORK 2026-05-13 — `dismissed` filter renamed → `deleted`. Migrate any
  // persisted value so the chip highlight matches after the rename.
  const rawExecFilter = localStorage.getItem("tinker.execFilter");
  // FORK 2026-05-14 — the "Deleted" chip was removed (delete is now a hard
  // remove). Any persisted "deleted" or legacy "dismissed" value falls back
  // to the default "unfinished" chip.
  const validExecFilters: ReadonlySet<string> = new Set([
    "unfinished",
    "all_today",
    "resolved",
    "snoozed",
    "all",
  ]);
  let execFilter: ExecFilter =
    rawExecFilter && validExecFilters.has(rawExecFilter)
      ? (rawExecFilter as ExecFilter)
      : "unfinished";
  let execExpandedId: string | null = null;
  let execLastTasks: ExecTask[] = [];
  let execContextMenuEl: HTMLElement | null = null;

  // FORK 2026-05-22 (Task 10) — axis tree types + helpers. The flat axes list
  // returned by control-panel.axes.list (v3.5) is built into a 2-level tree
  // (top-level groups + sub-groups); sub-groups cannot nest further (enforced
  // server-side by validateParentDepth).
  type AxisRow = {
    id: string;
    label: string;
    position: number;
    parent_id: string | null;
  };
  type AxisNode = AxisRow & { children: AxisNode[] };

  // FORK 2026-05-22 (Task 18) — `EXEC_AXIS_ORDER` + `EXEC_AXIS_LABEL` deleted.
  // Axes now come exclusively from `control-panel.axes.list` (Task 10), cached
  // in `execAxesList` below. Writer: `loadExecTasks` (refreshed every load).
  // Readers: `openExecContextMenu` (Reassign-axis submenu) and `renderExecGroups`
  // (per-group + Add task button data-axis-id, F2 2026-05-23). The fresh-DB /
  // RPC-failure fallback inlines the 5-axis defaults as a literal array inside
  // loadExecTasks — search there for FRESH_DB_FALLBACK.
  let execAxesList: AxisRow[] = [];
  // FORK 2026-05-22 — `open` was "⬜" until the head-checkbox shipped (commit
  // d08cd06ca9); the checkbox now owns the open/resolved signal so the white
  // square was dead weight on every open card. Dropped to "". Other icons
  // remain — they flag non-default states (in_progress, back_burner,
  // dropped/dismissed) that the checkbox does NOT communicate.
  const EXEC_STATUS_ICON: Record<string, string> = {
    open: "",
    // FORK 2026-05-29 — the 🟡 "in-progress" signal moved from this status-icon
    // to a 🟡 prefix on the task NAME, toggled by the pin button (data-action=
    // toggle-pin). Kept empty here so in-progress tasks don't show 🟡 TWICE
    // (status icon + name prefix). The name prefix is now the single source of
    // truth for the yellow marker. A one-time migration carried existing
    // in_progress task names over to the prefix. See feedback_bug_upgrade_task_lifecycle_protocol.
    in_progress: "",
    // FORK 2026-05-23 — dropped "✅" (was redundant with the head
    // checkbox which already turns accent-green with a ✓ when
    // status='resolved'; doubled up green checkmarks on every resolved
    // task). Same logic as the 2026-05-22 drop of "⬜" for open: the
    // checkbox owns the open/resolved signal. Other statuses keep
    // their icons — they flag states the checkbox can't communicate.
    resolved: "",
    // FORK 2026-05-13 — single 🗑 for both deleted statuses (new 'dropped'
    // writes + legacy 'dismissed' rows). Dropped/dismissed tasks are
    // unconditionally filtered out of every view as of 2a34dae51c, so
    // these icons are effectively never rendered now — kept for
    // historical/audit code paths that may query the row directly.
    dropped: "🗑",
    dismissed: "🗑",
    back_burner: "💤",
  };

  function buildAxisTree(flat: AxisRow[]): AxisNode[] {
    const byId = new Map<string, AxisNode>();
    for (const a of flat) byId.set(a.id, { ...a, children: [] });
    const roots: AxisNode[] = [];
    for (const node of byId.values()) {
      if (node.parent_id && byId.has(node.parent_id)) {
        byId.get(node.parent_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    const sortByPos = (a: AxisNode, b: AxisNode) =>
      a.position - b.position || a.id.localeCompare(b.id);
    roots.sort(sortByPos);
    for (const r of roots) r.children.sort(sortByPos);
    return roots;
  }

  function renderExecGroups(tree: AxisNode[], tasksByAxis: Map<string, ExecTask[]>): string {
    return tree
      .map((group) => {
        const ownTasks = tasksByAxis.get(group.id) ?? [];
        const groupOpenCount =
          ownTasks.length +
          group.children.reduce((acc, sub) => acc + (tasksByAxis.get(sub.id)?.length ?? 0), 0);
        const groupCollapsed =
          localStorage.getItem(`tinker.execGroupCollapsed.${group.id}`) === "1";
        const groupTasks = ownTasks.map((t) => renderExecTaskRow(t, group.id)).join("");
        const subgroupsHtml = group.children
          .map((sub) => {
            const subList = tasksByAxis.get(sub.id) ?? [];
            const subCount = subList.length;
            const subCollapsed =
              localStorage.getItem(`tinker.execGroupCollapsed.${sub.id}`) === "1";
            const subTasks = subList.map((t) => renderExecTaskRow(t, sub.id)).join("");
            return (
              `<div class="exec-subgroup${subCollapsed ? " exec-group-collapsed" : ""}" data-axis="${escapeExecAttr(sub.id)}" data-axis-parent="${escapeExecAttr(group.id)}" data-axis-position="${sub.position}">` +
              `<div class="exec-subgroup-header" data-axis-id="${escapeExecAttr(sub.id)}">` +
              `<span class="exec-group-grip" aria-hidden="true">⋮⋮</span>` +
              `<span class="exec-group-disclosure">${subCollapsed ? "▶" : "▼"}</span>` +
              `<span class="exec-subgroup-label" data-axis-label="${escapeExecAttr(sub.label)}">${escapeHtml(sub.label)}</span>` +
              `<button class="exec-group-pencil" data-action="edit-axis" data-axis-id="${escapeExecAttr(sub.id)}" title="Rename sub-group">✏️</button>` +
              `<span class="exec-group-count">${subCount} open` +
              // FORK 2026-05-23 (F2) — + Add task button on every sub-group
              // header. priority_axis is the SUB-GROUP's id (the click
              // handler reads data-axis-id from the closest header). Comes
              // before the 🗑 delete-empty so deletion remains a hover-tail.
              `<button class="exec-group-add-task" data-action="add-task-to-axis" data-axis-id="${escapeExecAttr(sub.id)}" title="Add task to ${escapeExecAttr(sub.label)}">+</button>` +
              (subCount === 0
                ? `<button class="exec-group-delete" data-action="delete-axis" data-axis-id="${escapeExecAttr(sub.id)}" data-axis-label="${escapeExecAttr(sub.label)}" title="Delete empty sub-group">🗑</button>`
                : ``) +
              `</span>` +
              `</div>` +
              (subCollapsed
                ? ""
                : subTasks || `<div class="exec-group-empty">(empty — drag tasks here)</div>`) +
              `</div>`
            );
          })
          .join("");
        return (
          `<div class="exec-group${groupCollapsed ? " exec-group-collapsed" : ""}" data-axis="${escapeExecAttr(group.id)}" data-axis-position="${group.position}">` +
          `<div class="exec-group-header" data-axis-id="${escapeExecAttr(group.id)}">` +
          `<span class="exec-group-grip" aria-hidden="true">⋮⋮</span>` +
          `<span class="exec-group-disclosure">${groupCollapsed ? "▶" : "▼"}</span>` +
          `<span class="exec-group-label" data-axis-label="${escapeExecAttr(group.label)}">${escapeHtml(group.label)}</span>` +
          `<button class="exec-group-pencil" data-action="edit-axis" data-axis-id="${escapeExecAttr(group.id)}" title="Rename group">✏️</button>` +
          `<span class="exec-group-count">${groupOpenCount} open` +
          // FORK 2026-05-23 (F2) — + Add task button on every top-level
          // group header (primary, bolder visual). Comes BEFORE the
          // + Add sub-group button (secondary, muted) so the most-frequent
          // action is the easier target.
          `<button class="exec-group-add-task" data-action="add-task-to-axis" data-axis-id="${escapeExecAttr(group.id)}" title="Add task to ${escapeExecAttr(group.label)}">+</button>` +
          `<button class="exec-group-add-sub" data-action="add-subgroup" data-parent-id="${escapeExecAttr(group.id)}" title="Add sub-group under ${escapeExecAttr(group.label)}">⤵</button>` +
          // FORK 2026-05-23 (F2) — 🗑 delete-empty button on top-level group
          // header. Renders only when the group itself has zero tasks AND
          // zero sub-groups (fully empty). Backend `axes.delete` accepts the
          // id; we re-render on success.
          (ownTasks.length === 0 && group.children.length === 0
            ? `<button class="exec-group-delete" data-action="delete-axis" data-axis-id="${escapeExecAttr(group.id)}" data-axis-label="${escapeExecAttr(group.label)}" title="Delete empty group">🗑</button>`
            : ``) +
          `</span>` +
          `</div>` +
          (groupCollapsed ? "" : groupTasks + subgroupsHtml) +
          `</div>`
        );
      })
      .join("");
  }

  // FORK 2026-05-22 (Task 10) — disclosure click wiring. Click anywhere on a
  // group/sub-group header (other than the + Add sub-group button) flips the
  // collapsed state and persists it in localStorage. Task 12 wires the +
  // button: intercept clicks on .exec-group-add-sub BEFORE the disclosure
  // toggle runs and open an inline sub-group form. Cheap re-render via
  // loadExecTasks() keeps the rest of the panel state synced.
  function attachExecGroupCollapseHandlers(scope: HTMLElement): void {
    scope
      .querySelectorAll<HTMLElement>(".exec-group-header, .exec-subgroup-header")
      .forEach((h) => {
        h.addEventListener("click", (ev) => {
          // FORK 2026-05-23 — suppress the synthetic click the browser fires
          // on the header row after a completed group drag. Same setPointer-
          // Capture-bypass issue as task DnD; without this guard a drag-to-
          // reorder would flip the dragged group's collapse state at landing.
          if (Date.now() - execLastDragEndAt < EXEC_POST_DRAG_CLICK_SUPPRESS_MS) {
            return;
          }
          const target = ev.target as HTMLElement;
          // FORK 2026-05-23 (F3) — clicks on the ⋮⋮ drag grip must never
          // toggle the disclosure. The drag handler captures the pointer on
          // pointerdown and below-threshold gestures still emit a synthetic
          // click — short-circuit it here.
          if (target.closest(".exec-group-grip")) {
            ev.stopPropagation();
            return;
          }
          // FORK 2026-05-23 (F2) — + Add task button: open the inline
          // task-add form anchored under this header. Must intercept BEFORE
          // the disclosure-toggle path so a click on the button doesn't also
          // flip the group's collapsed state. The axis id comes from the
          // button's data-axis-id (works for both top-level and sub-group).
          const addTask = target.closest(".exec-group-add-task") as HTMLButtonElement | null;
          if (addTask) {
            ev.stopPropagation();
            const axisId = addTask.dataset.axisId;
            if (axisId) openInlineAddTaskForm(addTask, axisId);
            return;
          }
          // FORK 2026-05-22 (Task 12) — + Add sub-group button: open the
          // inline form anchored under this header and bail before the
          // collapse logic.
          const addSub = target.closest(".exec-group-add-sub") as HTMLButtonElement | null;
          if (addSub) {
            ev.stopPropagation();
            const parentId = addSub.dataset.parentId;
            if (parentId) openInlineSubgroupForm(addSub, parentId);
            return;
          }
          // FORK 2026-05-23 (F1) — ✏️ pencil opens the inline rename input.
          // Must intercept BEFORE the collapse-toggle path so a pencil click
          // doesn't also flip the disclosure.
          const pencil = target.closest(".exec-group-pencil") as HTMLButtonElement | null;
          if (pencil) {
            ev.stopPropagation();
            const axisId = pencil.dataset.axisId;
            if (axisId) openInlineAxisLabelEdit(h, axisId);
            return;
          }
          // FORK 2026-05-23 (F2) — 🗑 delete-empty button. The button only
          // renders when the group is fully empty (no own tasks, no children
          // for top-level), so the click here can assume axes.delete is safe.
          // Still guard with window.confirm so an accidental click on a
          // freshly-created group can be reverted before the RPC fires.
          const del = target.closest(".exec-group-delete") as HTMLButtonElement | null;
          if (del) {
            ev.stopPropagation();
            const axisId = del.dataset.axisId;
            const label = del.dataset.axisLabel ?? axisId ?? "";
            if (!axisId) return;
            if (!window.confirm(`Delete empty group '${label}'?`)) return;
            void (async () => {
              try {
                await req("control-panel.axes.delete", { id: axisId });
                await loadExecTasks();
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error("[exec] axes.delete failed", err);
                flashExecError(
                  `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            })();
            return;
          }
          const id = h.dataset.axisId;
          if (!id) return;
          const key = `tinker.execGroupCollapsed.${id}`;
          const cur = localStorage.getItem(key) === "1";
          if (cur) localStorage.removeItem(key);
          else localStorage.setItem(key, "1");
          void loadExecTasks();
        });
        // FORK 2026-05-23 (F1) — dblclick on the label opens the inline
        // rename input. Stop propagation so the second click of the dblclick
        // doesn't also fire the collapse-toggle on the same header.
        h.addEventListener("dblclick", (ev) => {
          const target = ev.target as HTMLElement;
          const label = target.closest(
            ".exec-group-label, .exec-subgroup-label",
          ) as HTMLElement | null;
          if (!label) return;
          ev.stopPropagation();
          ev.preventDefault();
          const axisId = h.dataset.axisId;
          if (axisId) openInlineAxisLabelEdit(h, axisId);
        });
      });
  }

  // FORK 2026-05-25 — emoji picker for inline group/sub-group rename.
  // Singleton: only one picker open at a time across the whole UI.
  // Module-scoped variable + helpers; the picker DOM is appended to
  // document.body with position:fixed so it escapes any ancestor's
  // overflow:hidden clipping (the control panel uses several).
  let activeEmojiPicker: {
    el: HTMLElement;
    cleanup: () => void;
  } | null = null;

  function closeActiveEmojiPicker(): void {
    if (!activeEmojiPicker) return;
    activeEmojiPicker.cleanup();
    activeEmojiPicker.el.remove();
    activeEmojiPicker = null;
  }

  function insertAtCursor(input: HTMLInputElement, text: string): void {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    input.value = before + text + after;
    const pos = start + text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
    // Dispatch input event so any listeners (length counters, etc.)
    // see the synthetic update.
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function openEmojiPicker(anchor: HTMLElement, target: HTMLInputElement): void {
    // Toggle: re-clicking the same trigger closes the picker.
    if (activeEmojiPicker) {
      closeActiveEmojiPicker();
      return;
    }
    const picker = document.createElement("div");
    picker.className = "exec-emoji-picker";
    for (const emoji of EMOJI_CATALOG) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "exec-emoji-picker-item";
      item.textContent = emoji;
      item.title = emoji;
      // Keep focus on the host input — same trick as the trigger button.
      item.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      item.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        insertAtCursor(target, emoji);
        // Close after pick. Common picker UX (Slack/Discord behave the
        // same on single-click outside the shift-modifier path).
        closeActiveEmojiPicker();
      });
      picker.appendChild(item);
    }
    // Position below the anchor, clamped to viewport. position:fixed
    // because the anchor lives inside several scroll containers in the
    // control panel; absolute positioning would clip.
    const rect = anchor.getBoundingClientRect();
    const pickerWidth = 300;
    const pickerMaxHeight = 280;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - pickerWidth - 8));
    const top =
      rect.bottom + 4 + pickerMaxHeight > window.innerHeight
        ? Math.max(8, rect.top - pickerMaxHeight - 4)
        : rect.bottom + 4;
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
    document.body.appendChild(picker);

    const onDocMouseDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (!picker.contains(t) && t !== anchor && !anchor.contains(t)) {
        closeActiveEmojiPicker();
      }
    };
    const onDocKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        closeActiveEmojiPicker();
      }
    };
    // Stop the picker's own clicks from bubbling out and triggering
    // exec-group header handlers.
    picker.addEventListener("click", (ev) => ev.stopPropagation());
    picker.addEventListener("mousedown", (ev) => ev.stopPropagation());

    // Defer attaching the document mousedown so this very click
    // (which OPENED the picker) doesn't immediately close it.
    const handle = setTimeout(() => {
      document.addEventListener("mousedown", onDocMouseDown);
      document.addEventListener("keydown", onDocKey, true);
    }, 0);

    activeEmojiPicker = {
      el: picker,
      cleanup: () => {
        clearTimeout(handle);
        document.removeEventListener("mousedown", onDocMouseDown);
        document.removeEventListener("keydown", onDocKey, true);
      },
    };
  }

  // FORK 2026-05-23 (F1) — inline rename for a top-level group or sub-group.
  // Replaces the `.exec-group-label` / `.exec-subgroup-label` span with an
  // <input> pre-filled with the current label. Enter or blur saves via
  // `control-panel.axes.update {id, label}`; Esc cancels. Empty trimmed value
  // on save is treated as cancel (server would reject anyway). Triggered by
  // either the ✏️ pencil button or a dblclick on the label span; both paths
  // route through here. The header's parent collapse-handler is short-circuited
  // by stopPropagation in the caller, so the disclosure does NOT toggle.
  function openInlineAxisLabelEdit(headerEl: HTMLElement, axisId: string): void {
    const labelEl = headerEl.querySelector(
      ".exec-group-label, .exec-subgroup-label",
    ) as HTMLElement | null;
    if (!labelEl) return;
    // Avoid stacking — if we're already editing this header, bail.
    if (headerEl.querySelector(".exec-group-label-edit")) return;
    const current = labelEl.dataset.axisLabel ?? labelEl.textContent ?? "";
    const wasSubgroup = labelEl.classList.contains("exec-subgroup-label");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "exec-group-label-edit";
    input.maxLength = 32;
    input.value = current;
    input.dataset.axisId = axisId;
    if (wasSubgroup) input.dataset.subgroup = "1";
    // FORK 2026-05-25 — wrap input + emoji-picker trigger button in
    // an inline-flex container, so the trigger sits to the right of
    // the text box and stays aligned with it during inline rename.
    // Clicking the button toggles a floating scrollable emoji grid
    // (openEmojiPicker) that inserts at the input's caret position
    // and closes on outside click / Escape / re-click.
    const wrap = document.createElement("span");
    wrap.className = "exec-group-label-edit-wrap";
    const emojiBtn = document.createElement("button");
    emojiBtn.type = "button";
    emojiBtn.className = "exec-group-label-emoji-btn";
    emojiBtn.title = "Insert emoji";
    emojiBtn.tabIndex = -1;
    emojiBtn.textContent = "🙂";
    wrap.appendChild(input);
    wrap.appendChild(emojiBtn);
    labelEl.replaceWith(wrap);
    input.focus();
    input.select();

    let resolved = false;
    const restore = () => {
      if (resolved) return;
      resolved = true;
      closeActiveEmojiPicker();
      const span = document.createElement("span");
      span.className = wasSubgroup ? "exec-subgroup-label" : "exec-group-label";
      span.dataset.axisLabel = current;
      span.textContent = current;
      wrap.replaceWith(span);
    };
    const save = async () => {
      if (resolved) return;
      const next = input.value.trim();
      if (!next || next === current) {
        restore();
        return;
      }
      resolved = true;
      closeActiveEmojiPicker();
      try {
        await req("control-panel.axes.update", { id: axisId, label: next });
        await loadExecTasks();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec] axes.update (rename) failed", err);
        resolved = false;
        input.classList.add("exec-add-text-error");
        setTimeout(() => input.classList.remove("exec-add-text-error"), 1500);
        input.focus();
      }
    };

    // FORK 2026-05-25 — emoji button: mousedown.preventDefault keeps
    // focus on the input (so blur doesn't fire → save doesn't trigger
    // a premature save when the user just wants to insert an emoji).
    emojiBtn.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    emojiBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      openEmojiPicker(emojiBtn, input);
    });

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void save();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        restore();
      }
    });
    input.addEventListener("blur", (ev) => {
      // FORK 2026-05-25 — if focus is leaving for the emoji button or
      // a picker item, don't save. The mousedown.preventDefault above
      // SHOULD keep focus, but defensively check relatedTarget too.
      const next = (ev.relatedTarget as HTMLElement | null) ?? null;
      if (next && (next === emojiBtn || next.closest(".exec-emoji-picker"))) {
        return;
      }
      // Blur saves (mirrors Enter). If the input is empty, the save path
      // calls restore() so the user can never accidentally erase a label.
      void save();
    });
    // The replaced wrapper sits inside the header which has its own click
    // handler; stop clicks/mousedowns inside it from bubbling up to the
    // collapse-toggle and dblclick handlers above.
    wrap.addEventListener("click", (ev) => ev.stopPropagation());
    wrap.addEventListener("mousedown", (ev) => ev.stopPropagation());
    wrap.addEventListener("dblclick", (ev) => ev.stopPropagation());
  }

  // FORK 2026-05-23 (F1) — inline rename for a task title. Replaces the
  // .exec-task-text (collapsed head) or .exec-task-fulltitle-text (drawer)
  // span with an <input>. Enter or blur saves via
  // `control-panel.tasks.update {id, text}`; Esc cancels; empty trim is
  // treated as cancel. Mirrors openInlineAxisLabelEdit so the pattern is
  // consistent for the user. Replaces the prior window.prompt popup.
  function openInlineTaskTitleEdit(taskRow: HTMLElement, taskId: string): void {
    // Prefer the drawer's full-title span (visible when expanded); fall back
    // to the collapsed head's compact title. The collapsed-head version is
    // hidden by CSS when expanded, so picking the drawer one is correct.
    const labelEl =
      (taskRow.querySelector(".exec-task-fulltitle-text") as HTMLElement | null) ||
      (taskRow.querySelector(".exec-task-text") as HTMLElement | null);
    if (!labelEl) return;
    // Avoid stacking — if we're already editing this row, bail.
    if (taskRow.querySelector(".exec-task-title-edit")) return;
    const t = execLastTasks.find((x) => x.id === taskId);
    const current = t ? t.text : (labelEl.textContent ?? "");
    const wasFulltitle = labelEl.classList.contains("exec-task-fulltitle-text");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "exec-task-title-edit";
    input.value = loadTaskDraft(taskId, "text") ?? current;
    input.dataset.taskId = taskId;
    if (wasFulltitle) input.dataset.fulltitle = "1";
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    let resolved = false;
    const restore = () => {
      if (resolved) return;
      resolved = true;
      clearTaskDraft(taskId, "text"); // explicit cancel / no-op edit — discard the persisted draft
      const span = document.createElement("span");
      if (wasFulltitle) {
        span.className = "exec-task-fulltitle-text";
        span.textContent = current;
      } else {
        span.className = "exec-task-text";
        span.title = current;
        span.textContent = current;
      }
      input.replaceWith(span);
    };
    const save = async () => {
      if (resolved) return;
      const next = input.value.trim();
      if (!next || next === current) {
        restore();
        return;
      }
      resolved = true;
      try {
        await req("control-panel.tasks.update", { id: taskId, text: next });
        await loadExecTasks();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec] tasks.update (rename) failed", err);
        resolved = false;
        input.classList.add("exec-add-text-error");
        setTimeout(() => input.classList.remove("exec-add-text-error"), 1500);
        input.focus();
      }
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void save();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        restore();
      }
    });
    input.addEventListener("blur", () => {
      void save();
    });
    // The row has click/dblclick/pointerdown handlers; stop everything inside
    // the input so the row doesn't expand/collapse and DnD doesn't pick it up.
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("mousedown", (ev) => ev.stopPropagation());
    input.addEventListener("dblclick", (ev) => ev.stopPropagation());
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  // FORK 2026-05-23 (F2) — inline edit for a task description (context_md).
  // Replaces the rendered markdown body inside .exec-task-context-wrap with
  // a <textarea> pre-filled with the raw markdown. Ctrl/Cmd+Enter saves via
  // `control-panel.tasks.update {id, context_md}`; Esc cancels; blur saves
  // UNLESS the trimmed value is empty AND the prior context_md was non-empty
  // (defensive guard against accidental wipe). Replaces the prior
  // window.prompt popup.
  function openInlineTaskContextEdit(taskRow: HTMLElement, taskId: string): void {
    const wrap = taskRow.querySelector(".exec-task-context-wrap") as HTMLElement | null;
    if (!wrap) return;
    if (wrap.querySelector(".exec-task-context-edit")) return;
    const ctxEl = wrap.querySelector(".exec-task-context") as HTMLElement | null;
    if (!ctxEl) return;
    const t = execLastTasks.find((x) => x.id === taskId);
    const current = t?.context_md ?? "";
    const priorHeight = Math.max(80, ctxEl.offsetHeight);
    const textarea = document.createElement("textarea");
    textarea.className = "exec-task-context-edit";
    textarea.value = loadTaskDraft(taskId, "context") ?? current;
    textarea.dataset.taskId = taskId;
    textarea.style.height = `${priorHeight}px`;
    // Hide the pencil while editing — restored by the next render on save.
    const pencil = wrap.querySelector(".exec-task-pencil-context") as HTMLElement | null;
    if (pencil) pencil.style.display = "none";
    ctxEl.replaceWith(textarea);
    textarea.focus();
    // Place cursor at the end of the existing value for a natural append.
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
    // Auto-resize on input so the textarea grows with content.
    const autoResize = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.max(80, textarea.scrollHeight)}px`;
    };
    textarea.addEventListener("input", autoResize);

    let resolved = false;
    const restore = () => {
      if (resolved) return;
      resolved = true;
      clearTaskDraft(taskId, "context"); // explicit cancel / no-op edit — discard the persisted draft
      // Trigger a re-render so the markdown body comes back intact. Cheaper
      // than reconstructing the rendered HTML inline.
      void loadExecTasks();
    };
    const save = async (force: boolean) => {
      if (resolved) return;
      const next = textarea.value;
      const trimmed = next.trim();
      // Defensive blur-guard: empty-on-blur with non-empty prior = treat as
      // cancel. Ctrl+Enter (force=true) bypasses this. Esc restore()s directly.
      if (!force && trimmed.length === 0 && current.trim().length > 0) {
        restore();
        return;
      }
      if (next === current) {
        restore();
        return;
      }
      resolved = true;
      try {
        await req("control-panel.tasks.update", {
          id: taskId,
          context_md: trimmed.length > 0 ? trimmed : null,
        });
        await loadExecTasks();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec] tasks.update (context) failed", err);
        resolved = false;
        textarea.classList.add("exec-add-text-error");
        setTimeout(() => textarea.classList.remove("exec-add-text-error"), 1500);
        textarea.focus();
      }
    };

    textarea.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        void save(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        restore();
      }
    });
    textarea.addEventListener("blur", () => {
      void save(false);
    });
    // Same propagation guards as the title input — the row's click/dblclick
    // and the panel's pointerdown DnD trigger must not pick up textarea events.
    textarea.addEventListener("click", (ev) => ev.stopPropagation());
    textarea.addEventListener("mousedown", (ev) => ev.stopPropagation());
    textarea.addEventListener("dblclick", (ev) => ev.stopPropagation());
    textarea.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  // FORK 2026-05-23 (F3) — inline edit for the due_date chip in the drawer
  // meta-line. Replaces the chip span with <input type="date">. Enter or
  // change saves via tasks.update; empty value clears the due date; Esc
  // cancels. Width matches the chip; the native datepicker overlays on top.
  function openInlineTaskDueEdit(chipEl: HTMLElement, taskId: string): void {
    const t = execLastTasks.find((x) => x.id === taskId);
    if (!t) return;
    // Already editing this chip → bail.
    if (chipEl.tagName === "INPUT") return;
    const current = t.due_date ? t.due_date.slice(0, 10) : "";
    const input = document.createElement("input");
    input.type = "date";
    input.className = "exec-task-chip-edit";
    input.value = current;
    input.dataset.taskId = taskId;
    chipEl.replaceWith(input);
    input.focus();

    let resolved = false;
    const restore = () => {
      if (resolved) return;
      resolved = true;
      void loadExecTasks();
    };
    const save = async () => {
      if (resolved) return;
      const next = input.value.trim();
      if (next === current) {
        restore();
        return;
      }
      resolved = true;
      try {
        await req("control-panel.tasks.update", {
          id: taskId,
          due_date: next.length > 0 ? next : null,
        });
        await loadExecTasks();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec] tasks.update (due_date) failed", err);
        resolved = false;
        input.focus();
      }
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void save();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        restore();
      }
    });
    input.addEventListener("change", () => void save());
    input.addEventListener("blur", () => void save());
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("mousedown", (ev) => ev.stopPropagation());
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  // FORK 2026-05-23 (F4) — task duration semantics changed from integer
  // minutes to decimal hours per user request 2026-05-23: "The duration
  // of the tasks should be measured in hours, the number being decimal so
  // 0.1h is also possible as an entry." Storage stays as `est_minutes`
  // (the column is INTEGER in store.sql and rewriting the schema for a
  // unit relabel would be gold-plating per [[feedback_minimal_blast_
  // radius_collapse]]) — the UI converts at the input/display boundary:
  //   - display: minutes / 60, formatted as decimal with trailing-zero
  //     trim (60 → "1h", 30 → "0.5h", 6 → "0.1h", 45 → "0.75h").
  //   - input:   decimal hours, rounded to nearest minute (0.1h → 6 min).
  function formatEstHoursValue(minutes: number): string {
    return (minutes / 60).toFixed(2).replace(/\.?0+$/, "");
  }
  function formatEstHours(minutes: number): string {
    return `${formatEstHoursValue(minutes)}h`;
  }

  // FORK 2026-05-23 (F3) — inline edit for the est_minutes chip in the
  // drawer meta-line. Replaces the chip with <input type="number">.
  // FORK 2026-05-23 (F4) — input now takes decimal hours (step=0.1) and
  // converts to integer minutes for storage. See formatEstHoursValue above.
  function openInlineTaskEstEdit(chipEl: HTMLElement, taskId: string): void {
    const t = execLastTasks.find((x) => x.id === taskId);
    if (!t) return;
    if (chipEl.tagName === "INPUT") return;
    const current = t.est_minutes != null ? formatEstHoursValue(t.est_minutes) : "";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "0.1";
    input.placeholder = "hours";
    input.title = "Duration in hours (e.g., 0.1 = 6 min, 0.5 = 30 min, 1.5 = 90 min)";
    input.className = "exec-task-chip-edit exec-task-chip-edit-num";
    input.value = current;
    input.dataset.taskId = taskId;
    chipEl.replaceWith(input);
    input.focus();
    input.select();

    let resolved = false;
    const restore = () => {
      if (resolved) return;
      resolved = true;
      void loadExecTasks();
    };
    const save = async () => {
      if (resolved) return;
      const raw = input.value.trim();
      if (raw === current) {
        restore();
        return;
      }
      const parsedHours = raw === "" ? null : Number.parseFloat(raw);
      if (parsedHours !== null && (!Number.isFinite(parsedHours) || parsedHours < 0)) {
        restore();
        return;
      }
      // Hours → minutes: 0.1h = 6 min. Round so 0.166h doesn't store as 9.96.
      const parsed = parsedHours === null ? null : Math.round(parsedHours * 60);
      resolved = true;
      try {
        await req("control-panel.tasks.update", {
          id: taskId,
          est_minutes: parsed,
        });
        await loadExecTasks();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec] tasks.update (est_minutes) failed", err);
        resolved = false;
        input.focus();
      }
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void save();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        restore();
      }
    });
    input.addEventListener("blur", () => void save());
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("mousedown", (ev) => ev.stopPropagation());
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  // FORK 2026-06-07 — after a render, re-open the single pending inline task edit (rename or
  // description) so an HMR auto-refresh restores what the user was typing. A draft that already
  // matches the stored task (the edit was saved) is cleared, not reopened.
  function restorePendingTaskEdits(): void {
    const p = pendingTaskDraft();
    if (!p) return;
    const t = execLastTasks.find((x) => x.id === p.taskId);
    if (t) {
      const cur = p.field === "context" ? (t.context_md ?? "") : t.text;
      if (p.value.trim() === (cur ?? "").trim()) {
        clearTaskDraft(p.taskId, p.field); // already saved → nothing to restore
        return;
      }
    }
    const row = document.querySelector(
      `.exec-task[data-task-id="${p.taskId}"]`,
    ) as HTMLElement | null;
    if (!row) return; // task not currently visible (filtered / collapsed group) — keep the draft
    if (p.field === "text") {
      openInlineTaskTitleEdit(row, p.taskId);
    } else if (p.field === "context") {
      if (execExpandedId !== p.taskId) {
        execExpandedId = p.taskId; // the description editor lives in the drawer — expand, then re-run
        void loadExecTasks();
      } else {
        openInlineTaskContextEdit(row, p.taskId);
      }
    }
  }

  async function loadExecTasks(): Promise<void> {
    const panel = ensureExecPanel();
    const body = panel.querySelector("#exec-tasks-body") as HTMLElement;
    const progressEl = panel.querySelector("#exec-progress-inline") as HTMLElement;
    const progressBar = panel.querySelector("#exec-progress-bar") as HTMLElement;
    try {
      const res = (await req("control-panel.tasks.list", {
        // v3.3 — back_burner included in the fetch so the 💤 Snoozed chip has
        // tasks to render; execFilterAccepts hides them from every other filter.
        // FORK 2026-05-23 (F1) — dropped/dismissed removed from the fetch; the
        // 'Deleted' filter chip and soft-delete bucket were dropped, and
        // execFilterAccepts now rejects those statuses unconditionally. Not
        // fetching them avoids paying for rows the UI will never display.
        status: ["open", "in_progress", "resolved", "back_burner"],
        limit: 500,
      })) as { tasks: ExecTask[]; count: number };
      execLastTasks = res.tasks ?? [];

      // FORK 2026-05-14 — auto-wake back_burner tasks whose snoozed_until
      // metadata has been reached. Mutate in-place so this render shows
      // them as open immediately; fire-and-forget the tasks.update call to
      // persist. Bulk: typically 0–1 per render, never blocking.
      const wakeNow = (() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      })();
      for (const t of execLastTasks) {
        if (t.status !== "back_burner" || !t.metadata_json) continue;
        let meta: Record<string, unknown>;
        try {
          const parsed = JSON.parse(t.metadata_json);
          meta = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        } catch {
          continue;
        }
        const until = meta.snoozed_until;
        if (typeof until !== "string" || until > wakeNow) continue;
        delete meta.snoozed_until;
        t.status = "open";
        t.metadata_json = Object.keys(meta).length === 0 ? null : JSON.stringify(meta);
        void req("control-panel.tasks.update", { id: t.id, status: "open", metadata: meta });
      }

      const visible = execLastTasks.filter(execFilterAccepts);
      if (visible.length === 0) {
        body.innerHTML = `<div class="exec-empty">Nothing matches the <b>${execFilter}</b> filter.</div>`;
      } else {
        // FORK 2026-05-22 (Task 10) — group → sub-group hierarchy from the
        // task_axis tree. Axes come from control-panel.axes.list now (v3.5
        // added parent_id). Empty sub-groups still render (drag target).
        // Tasks pointing at an unknown axis fall into the implicit Unsorted
        // bucket at the bottom (preserves the prior fallback behavior of
        // rendering rogue-axis tasks instead of dropping them).
        const tasksByAxis = new Map<string, ExecTask[]>();
        for (const t of visible) {
          const k = t.priority_axis ?? "meta";
          if (!tasksByAxis.has(k)) tasksByAxis.set(k, []);
          tasksByAxis.get(k)!.push(t);
        }
        for (const arr of tasksByAxis.values()) {
          arr.sort((a, b) => a.priority_rank - b.priority_rank);
        }
        let axesFlat: AxisRow[] = [];
        try {
          const axesRes = (await req("control-panel.axes.list", {})) as { axes: AxisRow[] };
          axesFlat = axesRes.axes ?? [];
        } catch {
          axesFlat = [];
        }
        // FRESH_DB_FALLBACK — if axes table is empty (fresh DB or RPC failure),
        // synthesize a flat list of 5 default top-level groups so the panel
        // still renders sensibly. parent_id is null for every fallback axis.
        // Task 18 (2026-05-22) inlined this literal after deleting the
        // EXEC_AXIS_ORDER / EXEC_AXIS_LABEL constants — the labels match the
        // seeds in extensions/tinkerclaw-control-panel/src/store/db.ts which
        // is what gets written on first-boot in the normal path.
        if (axesFlat.length === 0) {
          axesFlat = [
            { id: "ventures", label: "🚀 Ventures", position: 0, parent_id: null },
            { id: "online", label: "💰 Online", position: 1, parent_id: null },
            { id: "family", label: "👨‍👩‍👧 Family", position: 2, parent_id: null },
            { id: "me", label: "🏃 Me", position: 3, parent_id: null },
            { id: "serra", label: "🏭 SERRA", position: 4, parent_id: null },
            { id: "meta", label: "⚙️ Meta", position: 5, parent_id: null },
          ];
        }
        // Cache the resolved list for non-render readers (the right-click
        // Reassign-axis submenu + the new per-group + Add task affordance,
        // which reads the parent axis id from the clicked header). The +
        // Add task dropdown was removed in F2 (2026-05-23) since each task
        // is now added directly under the group whose + button was clicked.
        execAxesList = axesFlat;
        const tree = buildAxisTree(axesFlat);
        // Collect every id reachable through the tree so we can detect
        // orphan tasks (priority_axis set but not in the tree).
        const knownIds = new Set<string>();
        for (const r of tree) {
          knownIds.add(r.id);
          for (const c of r.children) knownIds.add(c.id);
        }
        const html: string[] = [];
        html.push(renderExecGroups(tree, tasksByAxis));
        // Orphan / unsorted bucket — any axis id with tasks that isn't in the
        // tree (e.g. tasks whose sub-axis was deleted). Render only when
        // non-empty; matches the prior "unknown-axis fallback" semantics.
        const orphanTasks: ExecTask[] = [];
        for (const [axis, tasks] of tasksByAxis.entries()) {
          if (!knownIds.has(axis)) orphanTasks.push(...tasks);
        }
        if (orphanTasks.length > 0) {
          orphanTasks.sort((a, b) => a.priority_rank - b.priority_rank);
          const orphanCollapsed =
            localStorage.getItem("tinker.execGroupCollapsed.__unsorted__") === "1";
          const rows = orphanTasks.map((t) => renderExecTaskRow(t, "meta")).join("");
          html.push(
            `<div class="exec-group${orphanCollapsed ? " exec-group-collapsed" : ""}" data-axis="__unsorted__">` +
              `<div class="exec-group-header" data-axis-id="__unsorted__">` +
              `<span class="exec-group-disclosure">${orphanCollapsed ? "▶" : "▼"}</span>` +
              `<span class="exec-group-label">Unsorted</span>` +
              `<span class="exec-group-count">${orphanTasks.length} open</span>` +
              `</div>${orphanCollapsed ? "" : rows}</div>`,
          );
        }
        body.innerHTML = html.join("");
        attachExecTaskHandlers(body);
        attachExecGroupCollapseHandlers(body);
      }
      try {
        const prog = (await req("control-panel.tasks.progress", {})) as {
          pass_id: string | null;
          denominator: number;
          numerator: number;
        };
        if (prog && prog.pass_id && prog.denominator > 0) {
          const pct = Math.round((prog.numerator / prog.denominator) * 100);
          progressEl.textContent = ` ${prog.numerator}/${prog.denominator} · ${pct}%`;
          progressBar.style.width = `${pct}%`;
          progressBar.dataset.tier = pct < 25 ? "low" : pct < 67 ? "mid" : "high";
          progressBar.parentElement!.classList.add("exec-progress-bar-visible");
        } else {
          progressEl.textContent = "";
          progressBar.style.width = "0%";
          progressBar.parentElement!.classList.remove("exec-progress-bar-visible");
        }
      } catch {
        progressEl.textContent = "";
      }
      // Today's busy % chip — independent fetch, doesn't block render
      void loadExecBusyChip();
      try {
        restorePendingTaskEdits();
      } catch {
        /* auto-reopen is best-effort — the draft stays in localStorage regardless */
      }
    } catch (err) {
      // FORK 2026-05-11 — distinguish transient "WS not connected yet" from
      // real errors. The req() helper rejects with literal "disconnected"
      // before the WS handshake completes; show a calm green loading state
      // and schedule a fast retry instead of a red error.
      // FORK 2026-05-26 (task-mpkw1a0b-9jsfy follow-on, user instruction:
      // "make sure that visible errors deliver user-level information, and
      // that they log in console the deeper issue, so we can debug it"):
      // GatewayClientRequestError and the plain Error class both stringify
      // to "[object Object]" on naive `String(err)`. Extract a real human
      // message via the error's own .message field (preferred) before
      // falling back to JSON serialisation. The full object — stack, code,
      // details, the lot — goes to console.error so devtools has the
      // diagnostic depth while the bubble stays user-readable.
      // eslint-disable-next-line no-console
      console.error("[exec] loadExecTasks failed", err);
      const errorRecord = err as Record<string, unknown> | string | null;
      const rawMsg =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : errorRecord && typeof errorRecord === "object" && "message" in errorRecord
              ? String((errorRecord as { message: unknown }).message)
              : (() => {
                  try {
                    return JSON.stringify(err);
                  } catch {
                    return "unknown error";
                  }
                })();
      const msg = rawMsg || "unknown error";
      if (msg === "disconnected" || msg.includes("disconnected")) {
        body.innerHTML = `<div class="exec-loading">⏳ Loading tasks — connecting to gateway…</div>`;
        setTimeout(() => {
          void loadExecTasks();
        }, 1500);
      } else {
        body.innerHTML = `<div class="exec-error">Failed to load tasks: ${escapeHtml(msg)} <span style="opacity:.6;font-size:11px">(devtools console has full error)</span></div>`;
      }
    }
  }

  // ─── Drag & drop: reorder tasks AND move them across axes ───
  // FORK 2026-05-22 — pointer-event DnD on `.exec-task` rows (Task 13 of
  // Today card redesign; superseded the prior HTML5-DnD path removed in
  // Task 17). On pointerup, we compute the new (axis, rank) from the cursor
  // position and send one `control-panel.tasks.update` RPC. Rank uses
  // midpoint arithmetic between neighbors so frequent drops don't require
  // renumbering; ranks are clamped to a sane range and re-sequenced lazily
  // on the next renderer pass.
  let execDragRefreshSuppressed = false;
  // FORK 2026-05-23 — when a drag completes, the browser sometimes still
  // fires a synthetic `click` on the source row despite `preventDefault()`
  // in pointerdown (setPointerCapture changes the suppression heuristics).
  // That click hits the row's expand-toggle handler at line ~9506 and
  // expands the dragged task at its new home, which is not what the user
  // wants. Stamp the time at pointerup-commit; the click handler ignores
  // clicks within EXEC_POST_DRAG_CLICK_SUPPRESS_MS of it.
  let execLastDragEndAt = 0;
  const EXEC_POST_DRAG_CLICK_SUPPRESS_MS = 300;

  type PointerDrag = {
    id: string;
    axisAtStart: string;
    startClientX: number;
    startClientY: number;
    pointerId: number;
    ghost: HTMLElement;
    source: HTMLElement;
    indicator: HTMLElement;
    passedThreshold: boolean;
  };

  let execPointerDrag: PointerDrag | null = null;

  const DRAG_START_THRESHOLD_PX = 4;
  const AUTOSCROLL_EDGE_PX = 60;
  const AUTOSCROLL_MAX_SPEED_PX_PER_FRAME = 18;

  function attachExecPointerDragHandlers(panel: HTMLElement): void {
    const body = panel.querySelector("#exec-tasks-body") as HTMLElement;

    body.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      // FORK 2026-05-23 — the grip was made visually invisible in 7b91d26a6a
      // so users couldn't find the 6px hit target to start a drag; the row's
      // cursor:grab promised drag-anywhere but the pointerdown trigger was
      // still grip-only. Switch to: pointerdown anywhere on `.exec-task-head`
      // initiates the drag UNLESS it lands on an interactive child (the
      // checkbox, pencil, menu button, chip, or any nested button/input).
      // The DRAG_START_THRESHOLD_PX gate later ensures a plain click without
      // mouse movement still fires the expand-toggle normally; only actual
      // dragging gestures (>= 4px move) become DnD operations.
      const target = ev.target as HTMLElement;
      if (
        target.closest(
          "button, input, textarea, select, .exec-task-check, .exec-task-pencil, .exec-task-menu, .exec-chip, .exec-task-drawer",
        )
      ) {
        return;
      }
      const head = target.closest(".exec-task-head") as HTMLElement | null;
      if (!head) return;
      const task = head.closest(".exec-task") as HTMLElement | null;
      if (!task) return;

      ev.preventDefault();
      task.setPointerCapture(ev.pointerId);

      const ghost = task.cloneNode(true) as HTMLElement;
      ghost.classList.add("exec-drag-ghost");
      ghost.style.position = "fixed";
      ghost.style.pointerEvents = "none";
      ghost.style.zIndex = "10000";
      ghost.style.left = `${task.getBoundingClientRect().left}px`;
      ghost.style.top = `${task.getBoundingClientRect().top}px`;
      ghost.style.width = `${task.getBoundingClientRect().width}px`;
      ghost.style.opacity = "0";
      document.body.appendChild(ghost);

      const indicator = document.createElement("div");
      indicator.className = "exec-drop-indicator";

      execPointerDrag = {
        id: task.dataset.taskId!,
        axisAtStart: task.dataset.axis!,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        pointerId: ev.pointerId,
        ghost,
        source: task,
        indicator,
        passedThreshold: false,
      };
      execDragRefreshSuppressed = true;
    });

    // FORK 2026-05-22 — Task 14: pointermove tracks the ghost to the cursor
    // and computes drop-indicator placement via elementFromPoint. The ghost is
    // temporarily hidden during the lookup so it doesn't shadow itself.
    // Drop-target priority: nearest .exec-task (before/after by midpoint) →
    // .exec-subgroup-header (after) → .exec-group-header (after) →
    // .exec-subgroup (append) → .exec-group (append).
    function onPointerMove(ev: PointerEvent): void {
      const drag = execPointerDrag;
      if (!drag || ev.pointerId !== drag.pointerId) return;

      if (!drag.passedThreshold) {
        const dx = ev.clientX - drag.startClientX;
        const dy = ev.clientY - drag.startClientY;
        if (dx * dx + dy * dy < DRAG_START_THRESHOLD_PX * DRAG_START_THRESHOLD_PX) return;
        drag.passedThreshold = true;
        drag.source.classList.add("exec-task-source");
        drag.ghost.style.opacity = "0.85";
      }

      // Ghost follows the cursor (anchor near top-left of the row).
      drag.ghost.style.left = `${ev.clientX - 24}px`;
      drag.ghost.style.top = `${ev.clientY - 12}px`;

      // FORK 2026-05-22 — Task 16: edge auto-scroll. Runs every move tick so
      // a long list scrolls smoothly while the user hovers near an edge. The
      // indicator-positioning branches below each early-return, so placing
      // this BEFORE them guarantees auto-scroll fires regardless of which
      // drop-target branch the cursor lands in. Pointermove is already
      // browser-throttled to ~60fps, so no manual throttle needed.
      const bodyRect = body.getBoundingClientRect();
      const fromTop = ev.clientY - bodyRect.top;
      const fromBottom = bodyRect.bottom - ev.clientY;
      if (fromTop < AUTOSCROLL_EDGE_PX) {
        const speed =
          ((AUTOSCROLL_EDGE_PX - fromTop) / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_MAX_SPEED_PX_PER_FRAME;
        body.scrollTop -= speed;
      } else if (fromBottom < AUTOSCROLL_EDGE_PX) {
        const speed =
          ((AUTOSCROLL_EDGE_PX - fromBottom) / AUTOSCROLL_EDGE_PX) *
          AUTOSCROLL_MAX_SPEED_PX_PER_FRAME;
        body.scrollTop += speed;
      }

      // Find drop target via elementFromPoint, ignoring the ghost.
      drag.ghost.style.visibility = "hidden";
      const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      drag.ghost.style.visibility = "";
      if (!under) return;

      const targetTask = under.closest(".exec-task:not(.exec-task-source)") as HTMLElement | null;
      if (targetTask) {
        // FORK 2026-05-23 — was `targetTask.getBoundingClientRect()` (full
        // task including the drawer when expanded). With an expanded card
        // ~200px tall, the midpoint landed deep inside the drawer, so the
        // user's hover inside the head was tested against a midpoint far
        // below — indicator placement didn't match user intent. Use the
        // HEAD's bounding rect instead: consistent ~32px target regardless
        // of expand state, so the midpoint sits at the visual center of
        // the row's interactive surface.
        const head = targetTask.querySelector(":scope > .exec-task-head") as HTMLElement | null;
        const refRect = head ? head.getBoundingClientRect() : targetTask.getBoundingClientRect();
        if (ev.clientY < refRect.top + refRect.height / 2) {
          targetTask.parentElement!.insertBefore(drag.indicator, targetTask);
        } else {
          targetTask.parentElement!.insertBefore(drag.indicator, targetTask.nextSibling);
        }
        return;
      }
      // FORK 2026-05-23 — if the user is briefly hovering over the source
      // row (the faded original), do NOT move the indicator. Falling through
      // to the subgroup/group selectors below was making the indicator jump
      // to the bottom of the group every time the cursor crossed the source
      // row, which is exactly the "destination doesn't go where I want"
      // symptom the user reported. Leave the indicator at its last valid
      // position until the user hovers over a real drop target.
      if (under.closest(".exec-task-source")) {
        return;
      }
      const subHeader = under.closest(".exec-subgroup-header") as HTMLElement | null;
      if (subHeader) {
        subHeader.parentElement!.insertBefore(drag.indicator, subHeader.nextSibling);
        return;
      }
      const groupHeader = under.closest(".exec-group-header") as HTMLElement | null;
      if (groupHeader) {
        groupHeader.parentElement!.insertBefore(drag.indicator, groupHeader.nextSibling);
        return;
      }
      // FORK 2026-05-23 — only fall back to "append to bottom of (sub)group"
      // when that container is genuinely EMPTY (no task children). The
      // prior "always append to bottom" behaviour kicked in whenever the
      // cursor was over padding/spacing between rows, causing unintended
      // bottom-jumps. With the source-row early-return above and this
      // empty-container guard, the indicator only moves on intentional
      // hover over an actionable target.
      const subgroup = under.closest(".exec-subgroup") as HTMLElement | null;
      if (subgroup && !subgroup.querySelector(":scope > .exec-task:not(.exec-task-source)")) {
        subgroup.appendChild(drag.indicator);
        return;
      }
      const group = under.closest(".exec-group") as HTMLElement | null;
      if (group && !group.querySelector(":scope > .exec-task:not(.exec-task-source)")) {
        group.appendChild(drag.indicator);
        return;
      }
    }

    document.addEventListener("pointermove", onPointerMove);

    // FORK 2026-05-22 — Task 15: pointerup commits the drop. Visual teardown
    // (ghost, source class, indicator) is synchronous and unconditional once
    // we have an active drag. `execPointerDrag = null` and the refresh-suppress
    // flag are cleared BEFORE the await so a slow RPC can't leave state
    // inconsistent if another pointerdown fires during the wait. No-op gestures
    // (release into the same axis adjacent to the source row) bail without RPC.
    async function onPointerUp(ev: PointerEvent): Promise<void> {
      const drag = execPointerDrag;
      if (!drag || ev.pointerId !== drag.pointerId) return;

      // Ghost is unconditionally safe to remove — it's just a floating
      // visual clone that has no semantic role in the drop computation.
      drag.ghost.remove();

      // If we never crossed the drag threshold, this was a click on the row.
      // The click event itself was suppressed by ev.preventDefault() in
      // pointerdown (necessary to stop text-selection during actual drags),
      // so the row's normal click→toggle-expand handler never fires. Fire
      // it ourselves: toggle execExpandedId on the source task. FORK
      // 2026-05-23 — restoring click→expand after the DnD trigger was
      // widened from the invisible grip to the whole row.
      if (!drag.passedThreshold) {
        drag.source.classList.remove("exec-task-source");
        drag.indicator.remove();
        const taskId = drag.source.dataset.taskId;
        execPointerDrag = null;
        execDragRefreshSuppressed = false;
        if (taskId) {
          execExpandedId = execExpandedId === taskId ? null : taskId;
          void loadExecTasks();
        }
        return;
      }

      // FORK 2026-05-23 — stamp the post-drag click-suppression window
      // synchronously, BEFORE the async commit path yields. The browser
      // fires a synthetic `click` on the source row immediately after this
      // handler returns (setPointerCapture + DOM mutations during the drag
      // bypass preventDefault's usual click suppression), and that click
      // hits the row's expand-toggle handler — causing the dragged task to
      // expand at its new home, which is not what the user wants. The
      // click handler at attachExecTaskHandlers checks this stamp and
      // ignores clicks within EXEC_POST_DRAG_CLICK_SUPPRESS_MS. Only set
      // in the drag branch (passedThreshold === true) so that non-drag
      // rapid clicks aren't blocked.
      execLastDragEndAt = Date.now();

      // FORK 2026-05-23 (architectural rework) — the prior commit pulled
      // the indicator AND the source's `.exec-task-source` class BEFORE
      // walking the destination axis. The walk depends on both: the
      // indicator marks the slot drag.id should occupy, and the source
      // class lets the walk skip the source row (so it isn't pushed at
      // its OLD position). With both stripped, the walk:
      //   1. found ZERO .exec-drop-indicator → insertedSource stayed false
      //   2. found the source row as a "normal" task at its OLD position
      //      → pushed drag.id at that index
      //   3. fell through to the trailing `if (!insertedSource)` clause
      //      → pushed drag.id AGAIN at the end of orderedIds
      // The RPC batch then issued two control-panel.tasks.update calls for
      // drag.id with different priority_rank values; the higher-index
      // (end) write won the race, so the dragged task always landed at
      // the END of the destination axis. ("always at end" symptom)
      //
      // Fix: walk while the indicator is IN DOM and the source row still
      // carries the .exec-task-source class. Only after orderedIds is
      // built do we strip the visuals.
      const indParent = drag.indicator.parentElement;
      if (!indParent) {
        // Indicator never landed in a valid container (e.g., user dropped
        // outside the panel or over an unhandled element). Bail with no
        // RPC; restore the source visual.
        drag.source.classList.remove("exec-task-source");
        drag.indicator.remove();
        execPointerDrag = null;
        execDragRefreshSuppressed = false;
        return;
      }

      const subgroupHost = indParent.closest(".exec-subgroup") as HTMLElement | null;
      const groupHost = subgroupHost ?? (indParent.closest(".exec-group") as HTMLElement | null);
      if (!groupHost) {
        drag.source.classList.remove("exec-task-source");
        drag.indicator.remove();
        execPointerDrag = null;
        execDragRefreshSuppressed = false;
        return;
      }
      const axis = (subgroupHost ?? groupHost).dataset.axis!;
      const axisHost = subgroupHost ?? groupHost;

      // Walk the destination axis in DOM order. Indicator is still in
      // place; source still has .exec-task-source. Every direct-axis
      // task gets pushed in its current visual position, with drag.id
      // pushed AT the indicator's slot (in place of the source's old
      // position).
      const orderedIds: string[] = [];
      let insertedSource = false;
      for (const node of axisHost.querySelectorAll<HTMLElement>(
        ".exec-task, .exec-drop-indicator",
      )) {
        // Only renumber this axis — skip tasks in nested sub-groups
        // (those have their own axis container).
        const ownGroup =
          (node.closest(".exec-subgroup") as HTMLElement | null) ??
          (node.closest(".exec-group") as HTMLElement | null);
        if (ownGroup !== axisHost) continue;
        if (node.classList.contains("exec-drop-indicator")) {
          if (!insertedSource) {
            orderedIds.push(drag.id);
            insertedSource = true;
          }
          continue;
        }
        if (node.classList.contains("exec-task-source")) continue;
        const id = node.dataset.taskId;
        if (id) orderedIds.push(id);
      }

      // Indicator-not-found is now a hard error, not a "push at end"
      // fallback. The only way insertedSource can be false at this point
      // is if querySelectorAll didn't see the indicator inside axisHost
      // — meaning indParent must be in a different subtree. Bail rather
      // than silently shuffling the whole axis.
      if (!insertedSource) {
        // eslint-disable-next-line no-console
        console.warn("[exec-drag] indicator outside axisHost — aborting renumber", {
          axisHost,
          indParent,
        });
        drag.source.classList.remove("exec-task-source");
        drag.indicator.remove();
        execPointerDrag = null;
        execDragRefreshSuppressed = false;
        return;
      }

      // Visuals can now be stripped safely.
      drag.source.classList.remove("exec-task-source");
      drag.indicator.remove();
      execPointerDrag = null;
      execDragRefreshSuppressed = false;

      // FORK 2026-05-23 — was a single tasks.update with a midpoint rank.
      // priority_rank is INTEGER in store.sql, and midpoint arithmetic
      // compresses toward existing rank values over multiple drops; with
      // enough drops the column becomes degenerate (live ventures had 21
      // tasks at rank=30 before the renumber landed). The renumber path:
      // assign rank = (i+1)*100 to every task in the axis based on its
      // new DOM index. Spacing 100 leaves headroom for future midpoint-
      // style adjustments if we ever want them.
      try {
        await Promise.all(
          orderedIds.map((id, i) =>
            req("control-panel.tasks.update", {
              id,
              priority_axis: axis,
              priority_rank: (i + 1) * 100,
            }),
          ),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec-drag] tasks.update batch failed", err);
      }
      await loadExecTasks();
    }

    document.addEventListener("pointerup", onPointerUp);

    // FORK 2026-05-22 — Task 16: synchronous cleanup for cancellation paths.
    // pointercancel (OS/browser yanking the gesture), window blur (alt-tab),
    // and Escape all route through abortPointerDrag. Must NOT do async work
    // — safe to call from the keydown handler. The Esc guard is mandatory
    // because the page has multiple other Escape handlers (context menu,
    // add-task inline forms, etc.) that must keep functioning when no drag
    // is active.
    function abortPointerDrag(): void {
      const drag = execPointerDrag;
      if (!drag) return;
      drag.ghost.remove();
      drag.source.classList.remove("exec-task-source");
      drag.indicator.remove();
      execPointerDrag = null;
      execDragRefreshSuppressed = false;
    }

    document.addEventListener("pointercancel", abortPointerDrag);
    window.addEventListener("blur", abortPointerDrag);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && execPointerDrag) {
        ev.preventDefault();
        abortPointerDrag();
      }
    });
  }

  // ─── Drag & drop: reorder/reparent groups (categories) ───
  // FORK 2026-05-23 (F3) — pointer-event DnD on `.exec-group-grip` /
  // `.exec-subgroup-grip` (both share the `.exec-group-grip` class). Mirrors
  // the task-row DnD but writes `control-panel.axes.update {id, position,
  // parent_id?}` instead. Drop-target rules:
  //   • Source = top-level group: only reorder among top-level groups
  //     (drop on another top-level group's header). Drops over a sub-group
  //     header / sub-group content / a top-level group's tail-content area
  //     get normalized to "reorder against that top-level group" so the user
  //     can't accidentally nest a group three levels deep.
  //   • Source = sub-group: drop on another sub-group header → reorder
  //     within that sub-group's parent (reparent if the parent changed);
  //     drop on a top-level group header or that group's content area →
  //     reparent into that group at the end.
  // Two-level depth cap is also enforced server-side; the client guard above
  // is purely UX (no useless "rejected" round-trip).
  type GroupPointerDrag = {
    id: string;
    isTopLevel: boolean;
    parentAtStart: string | null;
    startClientX: number;
    startClientY: number;
    pointerId: number;
    ghost: HTMLElement;
    source: HTMLElement; // the .exec-group or .exec-subgroup wrapper
    indicator: HTMLElement;
    passedThreshold: boolean;
  };

  let execGroupDrag: GroupPointerDrag | null = null;

  function attachExecGroupPointerDragHandlers(panel: HTMLElement): void {
    const body = panel.querySelector("#exec-tasks-body") as HTMLElement;

    body.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      // FORK 2026-05-23 — the grip element was made invisible in 7b91d26a6a;
      // users had no findable hit target to start a category drag. Switch
      // to: pointerdown anywhere on `.exec-group-header` or
      // `.exec-subgroup-header` initiates the drag UNLESS it lands on an
      // interactive child (the disclosure caret, label-edit pencil, +Add
      // task / +Add subgroup buttons, count chip, delete button, label
      // text in edit mode, etc.). Plain clicks still fire collapse-toggle
      // via the existing handler — DnD only takes over once the
      // DRAG_START_THRESHOLD_PX move-threshold is crossed.
      const target = ev.target as HTMLElement;
      if (
        target.closest(
          "button, input, textarea, select, .exec-group-pencil, .exec-group-add-task, .exec-group-add-sub, .exec-group-delete, .exec-group-disclosure",
        )
      ) {
        return;
      }
      const header =
        (target.closest(".exec-group-header") as HTMLElement | null) ||
        (target.closest(".exec-subgroup-header") as HTMLElement | null);
      if (!header) return;
      const subWrap = header.closest(".exec-subgroup") as HTMLElement | null;
      const topWrap = header.closest(".exec-group") as HTMLElement | null;
      const source = subWrap ?? topWrap;
      if (!source) return;
      const isTopLevel = !subWrap;
      const id = source.dataset.axis;
      if (!id) return;
      const parentAtStart = subWrap ? (subWrap.dataset.axisParent ?? null) : null;

      ev.preventDefault();
      source.setPointerCapture?.(ev.pointerId);

      const headerSel = isTopLevel ? ".exec-group-header" : ".exec-subgroup-header";
      const headerEl = source.querySelector(headerSel) as HTMLElement | null;
      const cloneSrc = headerEl ?? source;
      const ghost = cloneSrc.cloneNode(true) as HTMLElement;
      ghost.classList.add("exec-drag-ghost", "exec-group-drag-ghost");
      const rect = cloneSrc.getBoundingClientRect();
      ghost.style.position = "fixed";
      ghost.style.pointerEvents = "none";
      ghost.style.zIndex = "10000";
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.opacity = "0";
      document.body.appendChild(ghost);

      const indicator = document.createElement("div");
      indicator.className = "exec-drop-indicator exec-group-drop-indicator";

      execGroupDrag = {
        id,
        isTopLevel,
        parentAtStart,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        pointerId: ev.pointerId,
        ghost,
        source,
        indicator,
        passedThreshold: false,
      };
      execDragRefreshSuppressed = true;
    });

    function onPointerMove(ev: PointerEvent): void {
      const drag = execGroupDrag;
      if (!drag || ev.pointerId !== drag.pointerId) return;

      if (!drag.passedThreshold) {
        const dx = ev.clientX - drag.startClientX;
        const dy = ev.clientY - drag.startClientY;
        if (dx * dx + dy * dy < DRAG_START_THRESHOLD_PX * DRAG_START_THRESHOLD_PX) return;
        drag.passedThreshold = true;
        drag.source.classList.add("exec-group-source");
        drag.ghost.style.opacity = "0.85";
      }

      drag.ghost.style.left = `${ev.clientX - 24}px`;
      drag.ghost.style.top = `${ev.clientY - 12}px`;

      // Edge auto-scroll mirrors the task DnD.
      const bodyRect = body.getBoundingClientRect();
      const fromTop = ev.clientY - bodyRect.top;
      const fromBottom = bodyRect.bottom - ev.clientY;
      if (fromTop < AUTOSCROLL_EDGE_PX) {
        const speed =
          ((AUTOSCROLL_EDGE_PX - fromTop) / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_MAX_SPEED_PX_PER_FRAME;
        body.scrollTop -= speed;
      } else if (fromBottom < AUTOSCROLL_EDGE_PX) {
        const speed =
          ((AUTOSCROLL_EDGE_PX - fromBottom) / AUTOSCROLL_EDGE_PX) *
          AUTOSCROLL_MAX_SPEED_PX_PER_FRAME;
        body.scrollTop += speed;
      }

      drag.ghost.style.visibility = "hidden";
      const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      drag.ghost.style.visibility = "";
      if (!under) return;

      // Locate the candidate wrapper under the cursor.
      const overSub = under.closest(".exec-subgroup:not(.exec-group-source)") as HTMLElement | null;
      const overTop = under.closest(".exec-group:not(.exec-group-source)") as HTMLElement | null;

      if (drag.isTopLevel) {
        // Top-level source: indicator only ever lands between top-level
        // groups, never inside one. If the cursor is over a sub-group or
        // top-level content area, we use the enclosing top-level group as
        // the reorder anchor.
        const anchor = overTop;
        if (!anchor) {
          drag.indicator.remove();
          return;
        }
        const ar = anchor.getBoundingClientRect();
        const before = ev.clientY < ar.top + ar.height / 2;
        anchor.parentElement!.insertBefore(drag.indicator, before ? anchor : anchor.nextSibling);
        return;
      }

      // Source is a sub-group.
      if (overSub) {
        const sr = overSub.getBoundingClientRect();
        const before = ev.clientY < sr.top + sr.height / 2;
        overSub.parentElement!.insertBefore(drag.indicator, before ? overSub : overSub.nextSibling);
        return;
      }
      if (overTop) {
        // Drop area inside a top-level group but not on a sub-group → append
        // as a sub-group at the end of that group. We park the indicator at
        // the very end of the group's wrapper, after any existing subgroups.
        overTop.appendChild(drag.indicator);
        return;
      }
      drag.indicator.remove();
    }

    document.addEventListener("pointermove", onPointerMove);

    async function onPointerUp(ev: PointerEvent): Promise<void> {
      const drag = execGroupDrag;
      if (!drag || ev.pointerId !== drag.pointerId) return;

      // Ghost is the floating clone — no semantic role in the walk, safe
      // to strip up front. Source class MUST stay until after the walk
      // (it's how the walk distinguishes the source row from valid peers);
      // the click branch can remove it inline since no walk runs there.
      drag.ghost.remove();

      // FORK 2026-05-23 — same restoration as the task pointerup above:
      // when the gesture is a plain click (no drag movement), fire the
      // group/sub-group collapse-toggle ourselves since the click event
      // was suppressed by ev.preventDefault() in pointerdown. Mirrors the
      // logic in attachExecGroupCollapseHandlers (localStorage key flip +
      // loadExecTasks).
      if (!drag.passedThreshold) {
        drag.source.classList.remove("exec-group-source");
        drag.indicator.remove();
        const axisId = drag.source.dataset.axis;
        execGroupDrag = null;
        execDragRefreshSuppressed = false;
        if (axisId) {
          const key = `tinker.execGroupCollapsed.${axisId}`;
          if (localStorage.getItem(key) === "1") {
            localStorage.removeItem(key);
          } else {
            localStorage.setItem(key, "1");
          }
          void loadExecTasks();
        }
        return;
      }

      // FORK 2026-05-23 — same post-drag click-suppression stamp as the
      // task DnD: blocks the synthetic click from triggering the group's
      // collapse-toggle handler at attachExecGroupCollapseHandlers.
      execLastDragEndAt = Date.now();

      // FORK 2026-05-23 (architectural rework) — same indicator-removed-
      // before-walk bug the task DnD just shed: stripping the indicator at
      // the top of the commit path made the renumber walk push drag.source
      // at the END every time (the `if (!insertedSource) orderedPeers.push
      // (drag.source)` fallback fired on every drop). The fix mirrors the
      // task pointerup: walk while the indicator is still in DOM, then
      // remove visuals.
      const indParent = drag.indicator.parentElement;
      if (!indParent) {
        drag.indicator.remove();
        execGroupDrag = null;
        execDragRefreshSuppressed = false;
        return;
      }

      // Resolve the new parent from the indicator's wrapper context.
      const indicatorParentClass = indParent.className;
      let targetParentId: string | null;
      let containerEl: HTMLElement;
      if (drag.isTopLevel) {
        targetParentId = null;
        containerEl = body;
      } else {
        if (indParent.classList.contains("exec-group")) {
          targetParentId = (indParent.dataset.axis as string) ?? null;
          containerEl = indParent;
        } else {
          const enclosingTop = indParent.closest(".exec-group") as HTMLElement | null;
          targetParentId = (enclosingTop?.dataset.axis as string) ?? null;
          containerEl = enclosingTop ?? indParent;
        }
        if (!targetParentId) {
          drag.indicator.remove();
          execGroupDrag = null;
          execDragRefreshSuppressed = false;
          return;
        }
      }

      // Walk the destination container in DOM order, still WITH the
      // indicator + source visible. Source row carries .exec-group-source
      // so the loop body skips it; indicator marks drag.source's new slot.
      const peerSelector = drag.isTopLevel ? ".exec-group" : ".exec-subgroup";
      const peerNodes = Array.from(
        containerEl.querySelectorAll<HTMLElement>(
          `:scope > ${peerSelector}, :scope > .exec-drop-indicator`,
        ),
      );
      const orderedPeers: HTMLElement[] = [];
      let insertedSource = false;
      for (const node of peerNodes) {
        if (node.classList.contains("exec-drop-indicator")) {
          if (!insertedSource) {
            orderedPeers.push(drag.source);
            insertedSource = true;
          }
          continue;
        }
        if (node === drag.source) continue;
        if (node.classList.contains("exec-group-source")) continue;
        orderedPeers.push(node);
      }

      // Indicator-not-found in containerEl is a hard error, not a fallback
      // to "push at end" (that was the bug we just fixed for task DnD).
      if (!insertedSource) {
        // eslint-disable-next-line no-console
        console.warn("[exec-group-drag] indicator outside containerEl — aborting renumber", {
          containerEl,
          indParent,
        });
        drag.source.classList.remove("exec-group-source");
        drag.indicator.remove();
        execGroupDrag = null;
        execDragRefreshSuppressed = false;
        return;
      }

      // No-op detection: same parent AND the new order matches the current
      // visual order (source's current DOM position vs. orderedPeers).
      const sameParent = (drag.parentAtStart ?? null) === (targetParentId ?? null);
      let sameOrder = false;
      if (sameParent) {
        const currentOrder = Array.from(
          containerEl.querySelectorAll<HTMLElement>(`:scope > ${peerSelector}`),
        );
        sameOrder =
          currentOrder.length === orderedPeers.length &&
          currentOrder.every((el, i) => el === orderedPeers[i]);
      }

      // Visuals can be stripped now that the walk is done.
      drag.source.classList.remove("exec-group-source");
      drag.indicator.remove();
      execGroupDrag = null;
      execDragRefreshSuppressed = false;

      if (sameOrder) return;

      try {
        await Promise.all(
          orderedPeers.map((peer, i) => {
            const peerId = peer.dataset.axis!;
            const params: { id: string; position: number; parent_id?: string | null } = {
              id: peerId,
              position: (i + 1) * 100,
            };
            if (peer === drag.source) {
              params.parent_id = targetParentId;
            }
            return req("control-panel.axes.update", params);
          }),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec-group-drag] axes.update batch failed", err, indicatorParentClass);
        flashExecError(`Reorder failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await loadExecTasks();
    }

    document.addEventListener("pointerup", onPointerUp);

    function abortPointerDrag(): void {
      const drag = execGroupDrag;
      if (!drag) return;
      drag.ghost.remove();
      drag.source.classList.remove("exec-group-source");
      drag.indicator.remove();
      execGroupDrag = null;
      execDragRefreshSuppressed = false;
    }

    document.addEventListener("pointercancel", abortPointerDrag);
    window.addEventListener("blur", abortPointerDrag);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && execGroupDrag) {
        ev.preventDefault();
        abortPointerDrag();
      }
    });
  }

  // FORK 2026-05-23 (F3) — extracted due-chip renderer so the collapsed head
  // and the expanded drawer's meta-line can share the same chip markup. The
  // `editable` flag adds a data-action="edit-due" + role/tabindex hint so the
  // drawer-side chip routes through openInlineTaskDueEdit.
  function renderExecDueChip(t: ExecTask, editable: boolean): string {
    if (!t.due_date) return "";
    const datePart = t.due_date.slice(0, 10);
    const [yy, mm, dd] = datePart.split("-").map(Number);
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const now = new Date();
    const label =
      yy === now.getFullYear()
        ? `${months[mm - 1]} ${dd}`
        : `${months[mm - 1]} ${dd} '${String(yy).slice(-2)}`;
    const todayPart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const isOverdue = datePart < todayPart;
    const editableAttrs = editable ? ` data-action="edit-due" role="button" tabindex="0"` : "";
    return `<span class="exec-chip exec-chip-due${isOverdue ? " exec-chip-due-overdue" : ""}${editable ? " exec-chip-editable" : ""}"${editableAttrs} title="Due ${escapeHtml(datePart)}${editable ? " (click to edit)" : ""}">📅 ${label}</span>`;
  }

  // FORK 2026-05-23 (F3) — placeholder due chip ("Set due date") for the
  // drawer meta-line when t.due_date is null. Clicking opens the inline date
  // input so the user can add a due date without going through the
  // reschedule overlay. Only rendered in the drawer (editable=true path).
  function renderExecDuePlaceholder(): string {
    return `<span class="exec-chip exec-chip-due exec-chip-editable exec-chip-empty" data-action="edit-due" role="button" tabindex="0" title="Click to set a due date">📅 Set due</span>`;
  }

  // FORK 2026-05-23 (F3) — est chip renderer + placeholder, same pattern.
  function renderExecEstChip(t: ExecTask, editable: boolean): string {
    if (!t.est_minutes) return "";
    // FORK 2026-05-23 (F4) — display unit switched from minutes ("30m") to
    // decimal hours ("0.5h"). Storage still in est_minutes; formatter trims
    // trailing zeros so whole hours read clean (60 min → "1h").
    const est = formatEstHours(t.est_minutes);
    const editableAttrs = editable ? ` data-action="edit-est" role="button" tabindex="0"` : "";
    return `<span class="exec-chip exec-chip-est${editable ? " exec-chip-editable" : ""}"${editableAttrs} title="Estimated ${est}${editable ? " (click to edit)" : ""}">${est}</span>`;
  }
  function renderExecEstPlaceholder(): string {
    return `<span class="exec-chip exec-chip-est exec-chip-editable exec-chip-empty" data-action="edit-est" role="button" tabindex="0" title="Click to set an estimate (hours, e.g. 0.5 = 30 min)">⏱ Set est</span>`;
  }

  function renderExecTaskRow(t: ExecTask, axis: string): string {
    // FORK 2026-05-22: fallback character is "" (not "•") so unknown statuses
    // also render no icon — `open` is the empty default and any future status
    // we forget to register shouldn't grow a stray bullet on every card.
    const icon = EXEC_STATUS_ICON[t.status] ?? "";
    const isExpanded = execExpandedId === t.id;
    // FORK 2026-05-14 — collapsed row surfaces 📅 due chip + est chip. The
    // shared renderExecDueChip/renderExecEstChip helpers above keep the head
    // and drawer chips visually identical. F3 (2026-05-23): when the row is
    // expanded, CSS hides these head chips to avoid duplication with the
    // drawer's meta-line; the markup stays in the DOM so collapsed-state
    // toggling doesn't churn the surrounding flexbox.
    const dueChip = renderExecDueChip(t, false);
    const estChip = renderExecEstChip(t, false);
    // FORK 2026-05-22: collapsed head now carries an 18px checkbox between
    // the grip and the status icon. Click toggles status open↔resolved via
    // the toggle-resolve action (handled by handleExecTaskAction). This
    // replaces the drawer's "Resolve" button per the Today card redesign.
    const isResolved = t.status === "resolved";
    const checkbox = `<button
              class="exec-task-check${isResolved ? " exec-task-check-checked" : ""}"
              data-action="toggle-resolve"
              title="${isResolved ? "Mark open" : "Mark resolved"}"
              aria-label="${isResolved ? "Mark open" : "Mark resolved"}">${isResolved ? "✓" : ""}</button>`;
    return `<div class="exec-task${isExpanded ? " exec-task-expanded" : ""}"
              data-task-id="${escapeExecAttr(t.id)}"
              data-status="${t.status}"
              data-axis="${axis}"
              data-rank="${t.priority_rank}">
        <div class="exec-task-head">
          <span class="exec-task-grip" aria-hidden="true">⋮⋮</span>
          ${checkbox}
          ${icon ? `<span class="exec-task-icon">${icon}</span>` : ""}
          <span class="exec-task-text" title="${escapeExecAttr(t.text)}">${escapeHtml(t.text)}</span>
          <button class="exec-task-pencil" data-action="edit-title" title="Edit title">✏️</button>
          <button class="exec-task-pin${t.text.startsWith("🟡") ? " exec-task-pin-on" : ""}" data-action="toggle-pin" title="${t.text.startsWith("🟡") ? "Unpin (remove yellow marker)" : "Pin (mark as in-progress)"}" aria-pressed="${t.text.startsWith("🟡") ? "true" : "false"}">📌</button>
          <span class="exec-task-chips">
            ${dueChip}
            ${estChip}
            <button class="exec-task-menu" data-action="menu" title="More actions">⋯</button>
          </span>
        </div>
        ${isExpanded ? renderExecDrawer(t) : ""}
      </div>`;
  }

  function renderExecDrawer(t: ExecTask): string {
    // FORK 2026-05-23 — drawer no longer renders a duplicate full-title
    // block. The collapsed head's `.exec-task-text` now wraps in place
    // when the card is expanded (see base.css `.exec-task-expanded
    // .exec-task-text`), so the title stays at its collapsed-row Y
    // coordinate instead of jumping to a line below in a separate
    // drawer block. The head's edit-title pencil remains visible when
    // expanded for in-place rename.
    //
    // Drawer order (unchanged otherwise):
    //   1. meta-line: 📅 due + ⏱ est chips with inline-edit on click.
    //   2. context body (rendered markdown) with edit pencil.
    //   3. metadata-strip chips (📧 N threads, etc.).
    //   4. action buttons row.
    const dueChip = t.due_date ? renderExecDueChip(t, true) : renderExecDuePlaceholder();
    const estChip = t.est_minutes ? renderExecEstChip(t, true) : renderExecEstPlaceholder();
    const metaLine = `<div class="exec-task-metaline">${dueChip}${estChip}</div>`;
    const ctxBody = t.context_md
      ? (() => {
          try {
            return mdParser.render(t.context_md);
          } catch {
            return `<p>${escapeHtml(t.context_md)}</p>`;
          }
        })()
      : `<p class="exec-task-context-empty">No context yet.</p>`;
    let meta = "";
    try {
      const m = t.metadata_json ? JSON.parse(t.metadata_json) : null;
      if (m) {
        const bits: string[] = [];
        // FORK 2026-05-22: Todoist deprecated (memory: 2026-05-11). All
        // todoist_* chips removed from render; the metadata strip migration
        // also clears these from metadata_json on next gateway boot.
        if (Array.isArray(m.gmail_thread_ids))
          bits.push(
            `<span class="exec-task-meta-chip">📧 ${m.gmail_thread_ids.length} thread${m.gmail_thread_ids.length === 1 ? "" : "s"}</span>`,
          );
        if (bits.length > 0) meta = `<div class="exec-task-meta">${bits.join("")}</div>`;
      }
    } catch {
      /* ignore malformed metadata */
    }
    return `<div class="exec-task-drawer">
        ${metaLine}
        <div class="exec-task-context-wrap">
          <div class="exec-task-context">${ctxBody}</div>
          <button class="exec-task-pencil exec-task-pencil-context" data-action="edit-context" title="Edit description">✏️</button>
        </div>
        ${meta}
        <div class="exec-task-actions">
          <button class="exec-task-action" data-action="reschedule">📅 Reschedule…</button>
          ${
            t.status === "back_burner"
              ? `<button class="exec-task-action exec-task-action-primary" data-action="bring-back">↩ Bring back</button>`
              : `<button class="exec-task-action" data-action="snooze-tomorrow">💤 Snooze until tomorrow</button>`
          }
          <button class="exec-task-action exec-task-action-warn" data-action="delete">🗑 Delete</button>
          <button class="exec-task-action" data-action="refer-in-chat">💬 Refer in chat</button>
        </div>
      </div>`;
  }

  // FORK 2026-05-23 (F2) — per-group + Add task inline form. Mirrors
  // openInlineSubgroupForm: insert a one-input form right under the
  // group/sub-group header, focus the input, Enter submits via
  // control-panel.tasks.add with priority_axis = the clicked header's
  // axis id (top-level OR sub-group). Esc / × cancel; the form is the
  // only visible field — est defaults to nothing, due date stays unset
  // (the user can fill them in via the drawer chips after the row lands).
  function openInlineAddTaskForm(anchor: HTMLElement, axisId: string): void {
    // Avoid stacking multiple forms (matches openInlineSubgroupForm).
    document
      .querySelectorAll(".exec-add-task-form, .exec-add-subgroup-form")
      .forEach((f) => f.remove());

    const form = document.createElement("form");
    form.className = "exec-add-task-form";
    form.innerHTML =
      `<input type="text" placeholder="Task title…" maxlength="240" required />` +
      `<button type="submit">Add</button>` +
      `<button type="button" data-cancel="1">×</button>`;
    // Anchor under the group header OR sub-group header containing the click.
    const header =
      (anchor.closest(".exec-group-header") as HTMLElement | null) ||
      (anchor.closest(".exec-subgroup-header") as HTMLElement | null);
    if (!header) return;
    header.insertAdjacentElement("afterend", form);
    const input = form.querySelector("input") as HTMLInputElement;
    input.focus();

    const close = () => form.remove();
    (form.querySelector("button[data-cancel]") as HTMLButtonElement).addEventListener(
      "click",
      close,
    );
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
      }
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      try {
        await req("control-panel.tasks.add", { text, priority_axis: axisId });
        close();
        await loadExecTasks();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec] tasks.add (per-group) failed", err);
        input.classList.add("exec-add-text-error");
        setTimeout(() => input.classList.remove("exec-add-text-error"), 1500);
        input.focus();
      }
    });
  }

  // FORK 2026-05-22 (Task 11) — inline "+ Add group" form at the top of the
  // tasks section. Toggles a one-line input that derives a slug-id from the
  // label and creates a top-level axis (parent_id implicitly null). Duplicate
  // ids surface via the same error-flash pattern as openInlineAddTaskForm.
  function attachExecAddGroupHandlers(panel: HTMLElement): void {
    const toggle = panel.querySelector("#exec-add-group-toggle") as HTMLButtonElement | null;
    const form = panel.querySelector("#exec-add-group-form") as HTMLFormElement | null;
    const label = panel.querySelector("#exec-add-group-label") as HTMLInputElement | null;
    const cancel = panel.querySelector("#exec-add-group-cancel") as HTMLButtonElement | null;
    if (!toggle || !form || !label || !cancel) return;

    const open = () => {
      form.style.display = "";
      toggle.style.display = "none";
      label.focus();
    };
    const close = () => {
      form.style.display = "none";
      toggle.style.display = "";
      label.value = "";
    };

    toggle.addEventListener("click", open);
    cancel.addEventListener("click", close);
    label.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
      }
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const text = label.value.trim();
      if (!text) {
        label.focus();
        return;
      }
      // Derive a slug-id from the label.
      const id = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32);
      if (!id) {
        label.focus();
        return;
      }
      try {
        await req("control-panel.axes.add", { id, label: text });
        close();
        await loadExecTasks();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec] axes.add (group) failed", err);
        label.classList.add("exec-add-text-error");
        setTimeout(() => label.classList.remove("exec-add-text-error"), 1500);
      }
    });
  }

  // FORK 2026-05-22 (Task 12) — per-group + button inline form for adding a
  // sub-group under a specific top-level parent. Stacks at most one form at
  // a time; Esc/× close; success → close + refresh via loadExecTasks(); error
  // → red flash. The slug-id is namespaced under the parent so collisions
  // across different parents are impossible.
  function openInlineSubgroupForm(anchor: HTMLElement, parentId: string): void {
    // Avoid stacking multiple forms.
    document.querySelectorAll(".exec-add-subgroup-form").forEach((f) => f.remove());

    const form = document.createElement("form");
    form.className = "exec-add-subgroup-form";
    form.innerHTML =
      `<input type="text" placeholder="Sub-group label" maxlength="32" required />` +
      `<button type="submit">Add</button>` +
      `<button type="button" data-cancel="1">×</button>`;
    // Insert immediately after the group header containing the anchor.
    const groupHeader = anchor.closest(".exec-group-header") as HTMLElement | null;
    if (!groupHeader) return;
    groupHeader.insertAdjacentElement("afterend", form);
    const input = form.querySelector("input") as HTMLInputElement;
    input.focus();

    const close = () => form.remove();
    (form.querySelector("button[data-cancel]") as HTMLButtonElement).addEventListener(
      "click",
      close,
    );
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
      }
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      const id = `${parentId}-${text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")}`.slice(0, 64);
      try {
        await req("control-panel.axes.add", { id, label: text, parent_id: parentId });
        close();
        await loadExecTasks();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec] axes.add (subgroup) failed", err);
        input.classList.add("exec-add-text-error");
        setTimeout(() => input.classList.remove("exec-add-text-error"), 1500);
      }
    });
  }

  // FORK 2026-05-11 — Today's busy %: sum of timed calendar event minutes
  // + sum of task est_minutes for tasks due today (or with no due date),
  // divided by 480-min workday. Computed inside loadExecTasks once per
  // refresh, shown as a chip in the tasks section header.
  async function loadExecBusyChip(): Promise<void> {
    const chip = document.getElementById("exec-busy-inline");
    if (!chip) return;
    const todayIso = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();
    let calMinutes = 0;
    try {
      const res = (await req("control-panel.calendar.list", { from: todayIso, to: todayIso })) as {
        events: Array<{ all_day: number; start_ts: number; end_ts: number | null }>;
      };
      for (const ev of res.events ?? []) {
        if (!ev.all_day && ev.end_ts) {
          calMinutes += Math.max(0, (ev.end_ts - ev.start_ts) / 60000);
        }
      }
    } catch {
      /* graceful empty */
    }
    let taskMinutes = 0;
    for (const t of execLastTasks) {
      // v3.3 — back_burner excluded from today's scheduled-load calculation:
      // snoozed tasks are intentionally hidden from working memory.
      if (
        t.status === "resolved" ||
        t.status === "dropped" ||
        t.status === "dismissed" ||
        t.status === "back_burner"
      )
        continue;
      const dayKey = t.due_date ? t.due_date.slice(0, 10) : todayIso;
      if (dayKey !== todayIso) continue;
      taskMinutes += typeof t.est_minutes === "number" ? t.est_minutes : 30;
    }
    const total = calMinutes + taskMinutes;
    const pct = Math.round((total / EXEC_WORKDAY_MINUTES) * 100);
    const tier =
      pct === 0 ? "free" : pct > 100 ? "over" : pct >= 80 ? "high" : pct >= 50 ? "mid" : "low";
    chip.textContent = pct === 0 ? "📊 free" : `📊 ${pct}%`;
    chip.dataset.tier = tier;
    chip.title = `Today: ${Math.round(taskMinutes)}m tasks + ${Math.round(calMinutes)}m events = ${Math.round(total)}m / 480m (${pct}%)`;
  }

  // FORK 2026-05-11 — Reschedule picker overlay (SPEC §7.8). Mon→Sun rows
  // showing event density, task counts, and the current task's due date.
  // FORK 2026-05-14 — The picker now renders 52 weeks (~1 year) in a
  // scrollable list starting from the Monday of the current week. Past
  // days in the first row are crossed out and unclickable. A native date
  // input in the header lets the user type any date numerically.
  // Click a day → tasks.reschedule + close. ESC or backdrop click → cancel.
  let execReschedulePickerEl: HTMLElement | null = null;

  type CalEvent = {
    source: string;
    event_id: string;
    date: string;
    start_ts: number;
    end_ts: number | null;
    all_day: number;
    title: string;
    location: string | null;
  };

  function closeExecReschedulePicker(): void {
    if (execReschedulePickerEl) {
      execReschedulePickerEl.remove();
      execReschedulePickerEl = null;
    }
  }

  // 8-hour workday baseline for busyness %; calibrated for the user's day shape.
  const EXEC_WORKDAY_MINUTES = 480;

  function formatHHMM(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  async function openExecReschedulePicker(taskId: string): Promise<void> {
    const t = execLastTasks.find((x) => x.id === taskId);
    if (!t) return;
    closeExecReschedulePicker();

    // 52 Mon→Sun weeks starting from the Monday of the current week.
    const TOTAL_WEEKS = 52;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDow = today.getDay(); // 0 Sun … 6 Sat
    const mondayOffset = todayDow === 0 ? -6 : 1 - todayDow;
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() + mondayOffset);

    const dayNamesMon = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    type DayCell = {
      date: string;
      dayName: string;
      dayNum: number;
      isToday: boolean;
      isPast: boolean;
      isWeekend: boolean;
    };
    const weeks: DayCell[][] = [];
    for (let w = 0; w < TOTAL_WEEKS; w++) {
      const row: DayCell[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(weekStart);
        d.setDate(weekStart.getDate() + w * 7 + i);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        row.push({
          date: iso,
          dayName: dayNamesMon[i],
          dayNum: d.getDate(),
          isToday: d.getTime() === today.getTime(),
          isPast: d.getTime() < today.getTime(),
          isWeekend: i >= 5, // Sat (5) and Sun (6) — Mon-first row layout
        });
      }
      weeks.push(row);
    }
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const fromIso = weeks[0][0].date;
    const toIso = weeks[weeks.length - 1][6].date;

    // Fetch calendar event list (with titles) — derive density client-side.
    // FORK 2026-05-14 — refresh:true forces a fresh `gog calendar events`
    // sync on every popup open so what shows here matches Google right now,
    // not whatever the 30-min cron last wrote. Sync failures are non-fatal
    // and we still render cached rows.
    const eventsByDay = new Map<string, CalEvent[]>();
    try {
      const res = (await req("control-panel.calendar.list", {
        from: fromIso,
        to: toIso,
        refresh: true,
      })) as {
        events: CalEvent[];
      };
      for (const ev of res.events ?? []) {
        const k = ev.date.slice(0, 10);
        if (!eventsByDay.has(k)) eventsByDay.set(k, []);
        eventsByDay.get(k)!.push(ev);
      }
    } catch {
      /* calendar may not be synced yet — graceful empty */
    }

    // Bucket OTHER tasks (excluding the one being moved) by their effective
    // day. Tasks without a due_date count toward TODAY. The combined task
    // minutes drive the busyness % alongside calendar minutes.
    type DayTasks = { count: number; minutes: number; samples: typeof execLastTasks };
    const tasksByDay = new Map<string, DayTasks>();
    const validDateSet = new Set(weeks.flatMap((row) => row.map((c) => c.date)));
    for (const task of execLastTasks) {
      if (task.id === taskId) continue;
      // v3.3 — back_burner excluded from the reschedule-picker per-day counts;
      // snoozed tasks don't represent commitments on any day.
      if (
        task.status === "dismissed" ||
        task.status === "dropped" ||
        task.status === "resolved" ||
        task.status === "back_burner"
      )
        continue;
      const dayKey = task.due_date ? task.due_date.slice(0, 10) : todayIso;
      if (!validDateSet.has(dayKey)) continue;
      const minutes = typeof task.est_minutes === "number" ? task.est_minutes : 30;
      const entry = tasksByDay.get(dayKey) ?? { count: 0, minutes: 0, samples: [] };
      entry.count++;
      entry.minutes += minutes;
      if (entry.samples.length < 6) entry.samples.push(task);
      tasksByDay.set(dayKey, entry);
    }

    const currentDue = t.due_date ? t.due_date.slice(0, 10) : null;

    const buildCell = (d: DayCell): string => {
      if (d.isPast) {
        const pastClasses = [
          "exec-rsch-cell",
          "exec-rsch-past",
          d.isWeekend ? "exec-rsch-weekend" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<div class="${pastClasses}" aria-disabled="true">
          <div class="exec-rsch-day">${d.dayName} ${d.dayNum}</div>
        </div>`;
      }
      const events = eventsByDay.get(d.date) ?? [];
      const timedEvents = events.filter((ev) => !ev.all_day && ev.end_ts);
      const allDayEvents = events.filter((ev) => !!ev.all_day);
      const calMinutes = timedEvents.reduce(
        (sum, ev) => sum + Math.max(0, (ev.end_ts! - ev.start_ts) / 60000),
        0,
      );
      const taskBucket = tasksByDay.get(d.date) ?? { count: 0, minutes: 0, samples: [] };
      const totalMinutes = calMinutes + taskBucket.minutes;
      const busyPct = Math.round((totalMinutes / EXEC_WORKDAY_MINUTES) * 100);
      const overbooked = busyPct > 100;

      // Heat tier from busy %, plus a special "overbooked" tier
      let heat: number;
      if (busyPct === 0 && allDayEvents.length === 0) heat = 0;
      else if (overbooked) heat = 4;
      else if (busyPct >= 80) heat = 3;
      else if (busyPct >= 50) heat = 2;
      else heat = 1;

      const barHeight = Math.min(
        22,
        Math.max(
          busyPct === 0 && allDayEvents.length === 0 ? 0 : 3,
          Math.round((Math.min(busyPct, 100) / 100) * 22),
        ),
      );

      const pctLabel =
        busyPct === 0 && allDayEvents.length === 0
          ? `<div class="exec-rsch-pct exec-rsch-pct-free">free</div>`
          : overbooked
            ? `<div class="exec-rsch-pct exec-rsch-pct-over">${busyPct}%</div>`
            : `<div class="exec-rsch-pct">${busyPct}%</div>`;

      const breakdownParts: string[] = [];
      if (events.length > 0) breakdownParts.push(`${events.length}e`);
      if (taskBucket.count > 0) breakdownParts.push(`${taskBucket.count}t`);
      const breakdown =
        breakdownParts.length > 0
          ? `<div class="exec-rsch-breakdown">${breakdownParts.join(" · ")}</div>`
          : `<div class="exec-rsch-breakdown exec-rsch-breakdown-empty"> </div>`;

      // Hover tooltip — native title with newlines.
      const tipLines: string[] = [`${d.date} — ${busyPct}% busy`];
      if (allDayEvents.length > 0) {
        tipLines.push("");
        tipLines.push("📅 ALL-DAY:");
        for (const ev of allDayEvents) tipLines.push(`  • ${ev.title}`);
      }
      if (timedEvents.length > 0) {
        tipLines.push("");
        // FORK 2026-05-23 (F4) — tooltip totals in hours to match the rest
        // of the duration UI (per-task chip + inline editor are now hours).
        tipLines.push(`📅 EVENTS (${formatEstHours(Math.round(calMinutes))}):`);
        for (const ev of timedEvents.slice(0, 8))
          tipLines.push(`  • ${formatHHMM(ev.start_ts)} ${ev.title}`);
      }
      if (taskBucket.samples.length > 0) {
        tipLines.push("");
        tipLines.push(`📋 TASKS (${formatEstHours(Math.round(taskBucket.minutes))}):`);
        for (const task of taskBucket.samples)
          tipLines.push(
            `  • ${task.est_minutes != null ? formatEstHours(task.est_minutes) : "?h"}  ${task.text.slice(0, 50)}`,
          );
        if (taskBucket.count > taskBucket.samples.length)
          tipLines.push(`  + ${taskBucket.count - taskBucket.samples.length} more`);
      }
      const tip = tipLines.join("\n");

      const isCurrent = currentDue === d.date;
      const classes = [
        "exec-rsch-cell",
        d.isToday ? "exec-rsch-today" : "",
        isCurrent ? "exec-rsch-current" : "",
        overbooked ? "exec-rsch-overbooked" : "",
        d.isWeekend ? "exec-rsch-weekend" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<button class="${classes}" data-date="${d.date}" data-heat="${heat}" title="${escapeExecAttr(tip)}">
        <div class="exec-rsch-day">${d.dayName} ${d.dayNum}</div>
        <div class="exec-rsch-bar-wrap"><div class="exec-rsch-bar" style="height: ${barHeight}px"></div></div>
        ${pctLabel}
        ${breakdown}
        ${allDayEvents.length > 0 ? `<div class="exec-rsch-allday" title="${escapeExecAttr(allDayEvents.map((e) => e.title).join(" · "))}">${allDayEvents.length === 1 ? "📌" : "📌×" + allDayEvents.length}</div>` : ""}
      </button>`;
    };

    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const weekBlocks: string[] = [];
    let lastMonthKey = "";
    weeks.forEach((row, weekIdx) => {
      const monday = new Date(`${row[0].date}T00:00:00`);
      const monthKey = `${monday.getFullYear()}-${monday.getMonth()}`;
      if (monthKey !== lastMonthKey) {
        weekBlocks.push(
          `<div class="exec-rsch-month-label">${monthNames[monday.getMonth()]} ${monday.getFullYear()}</div>`,
        );
        lastMonthKey = monthKey;
      }
      const rowHtml = row.map(buildCell).join("");
      const isCurrentWeek = row.some((c) => c.isToday);
      weekBlocks.push(
        `<div class="exec-rsch-row${isCurrentWeek ? " exec-rsch-row-current" : ""}" data-week-idx="${weekIdx}">${rowHtml}</div>`,
      );
    });

    const dowHeader = dayNamesMon
      .map(
        (n, i) => `<div class="exec-rsch-dow${i >= 5 ? " exec-rsch-dow-weekend" : ""}">${n}</div>`,
      )
      .join("");

    const overlay = document.createElement("div");
    overlay.className = "exec-rsch-backdrop";
    overlay.innerHTML = `
      <div class="exec-rsch-dialog" role="dialog" aria-label="Reschedule task">
        <div class="exec-rsch-header">
          <div class="exec-rsch-title">📅 Reschedule</div>
          <div class="exec-rsch-task-text" title="${escapeExecAttr(t.text)}">${escapeHtml(t.text)}</div>
          ${currentDue ? `<div class="exec-rsch-current-due">Currently due ${escapeHtml(currentDue)}</div>` : `<div class="exec-rsch-current-due">No due date set</div>`}
          <div class="exec-rsch-jump">
            <label for="exec-rsch-date-input">Exact date:</label>
            <input id="exec-rsch-date-input" type="date" min="${todayIso}" max="${toIso}" ${currentDue && currentDue >= todayIso ? `value="${currentDue}"` : ""} />
          </div>
        </div>
        <div class="exec-rsch-dow-row">${dowHeader}</div>
        <div class="exec-rsch-scroll">${weekBlocks.join("")}</div>
        <div class="exec-rsch-footer">
          ${currentDue ? `<button class="exec-rsch-clear" data-action="clear">Clear due date</button>` : `<span></span>`}
          <button class="exec-rsch-cancel" data-action="cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    execReschedulePickerEl = overlay;

    const scrollEl = overlay.querySelector<HTMLElement>(".exec-rsch-scroll");
    const currentWeekEl = overlay.querySelector<HTMLElement>(".exec-rsch-row-current");
    if (scrollEl && currentWeekEl) {
      scrollEl.scrollTop = Math.max(0, currentWeekEl.offsetTop - 24);
    }

    const finish = async (newDate: string | null): Promise<void> => {
      closeExecReschedulePicker();
      try {
        if (newDate === null) {
          // Clear due_date — use tasks.update with explicit null
          await req("control-panel.tasks.update", { id: taskId, due_date: null });
        } else {
          await req("control-panel.tasks.reschedule", { id: taskId, due_date: newDate });
        }
        void loadExecTasks();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec] reschedule failed", err);
      }
    };

    overlay.querySelectorAll<HTMLElement>(".exec-rsch-cell").forEach((cell) => {
      if (cell.tagName !== "BUTTON" || !cell.dataset.date) return;
      cell.addEventListener("click", () => {
        void finish(cell.dataset.date ?? null);
      });
    });
    const dateInput = overlay.querySelector<HTMLInputElement>("#exec-rsch-date-input");
    dateInput?.addEventListener("change", () => {
      const v = dateInput.value;
      if (v && v >= todayIso && v <= toIso) void finish(v);
    });
    overlay.querySelector('[data-action="clear"]')?.addEventListener("click", () => {
      void finish(null);
    });
    overlay.querySelector('[data-action="cancel"]')?.addEventListener("click", () => {
      closeExecReschedulePicker();
    });
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) closeExecReschedulePicker();
    });
    const escHandler = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        closeExecReschedulePicker();
        document.removeEventListener("keydown", escHandler);
      }
    };
    document.addEventListener("keydown", escHandler);
  }

  function attachExecTaskHandlers(scope: HTMLElement) {
    scope.querySelectorAll<HTMLElement>(".exec-task").forEach((row) => {
      const id = row.dataset.taskId!;
      const head = row.querySelector(".exec-task-head") as HTMLElement;
      head.addEventListener("click", (ev) => {
        // FORK 2026-05-23 — suppress the synthetic click the browser fires
        // on the source row after a completed drag. setPointerCapture +
        // ghost-DOM mutations during the drag bypass preventDefault's usual
        // suppression, so a drag-to-new-group always landed with the dragged
        // task expanded ("it expands upon landing"). pointerup stamps
        // execLastDragEndAt; ignore clicks within the suppression window.
        // Non-drag clicks (no setPointerCapture path) are unaffected because
        // pointerup-click branch toggles expand inline before the synthetic
        // click fires, so this guard short-circuits the duplicate.
        if (Date.now() - execLastDragEndAt < EXEC_POST_DRAG_CLICK_SUPPRESS_MS) {
          return;
        }
        const t = ev.target as HTMLElement;
        if (
          t.closest(".exec-task-menu") ||
          t.closest(".exec-task-grip") ||
          t.closest(".exec-task-pencil") ||
          t.closest(".exec-task-pin") ||
          t.closest(".exec-task-check")
        ) {
          return;
        }
        execExpandedId = execExpandedId === id ? null : id;
        void loadExecTasks();
      });
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        openExecContextMenu(id, ev.clientX, ev.clientY);
      });
      const menuBtn = row.querySelector('[data-action="menu"]');
      menuBtn?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        openExecContextMenu(id, rect.right - 4, rect.bottom + 4);
      });
      row.querySelectorAll<HTMLElement>(".exec-task-action").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void handleExecTaskAction(id, btn.dataset.action!);
        });
      });
      // FORK 2026-05-11 — pencil buttons (collapsed title, expanded full
      // title, expanded context). They fire dedicated edit-title /
      // edit-context actions and must NOT toggle the row's expand state.
      row.querySelectorAll<HTMLElement>(".exec-task-pencil").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void handleExecTaskAction(id, btn.dataset.action!);
        });
      });
      // FORK 2026-05-29 — pin button toggles the 🟡 in-progress name marker.
      // Same hover-revealed treatment as the pencil; must not toggle expand.
      row.querySelectorAll<HTMLElement>(".exec-task-pin").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void handleExecTaskAction(id, btn.dataset.action!);
        });
      });
      // FORK 2026-05-22 — collapsed-head checkbox. Stops propagation so the
      // head's expand-toggle listener doesn't also fire, then routes through
      // handleExecTaskAction with the toggle-resolve action.
      row.querySelectorAll<HTMLElement>(".exec-task-check").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void handleExecTaskAction(id, btn.dataset.action!);
        });
      });
      // FORK 2026-05-23 (F1) — dblclick on the title span (either collapsed
      // head or drawer full-title) opens the inline rename input. Mirrors the
      // category-rename pattern. stopPropagation prevents the second click of
      // the dblclick from also toggling the row's expand state.
      row
        .querySelectorAll<HTMLElement>(".exec-task-text, .exec-task-fulltitle-text")
        .forEach((label) => {
          label.addEventListener("dblclick", (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            openInlineTaskTitleEdit(row, id);
          });
        });
      // FORK 2026-05-23 (F3) — drawer meta-line chips. Click → inline edit
      // (date input or number input). stopPropagation so the row's head
      // click handler (collapse-toggle) doesn't fire and the panel's
      // pointerdown DnD trigger doesn't pick them up.
      row.querySelectorAll<HTMLElement>(".exec-chip-editable").forEach((chip) => {
        chip.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const action = chip.dataset.action;
          if (action === "edit-due") openInlineTaskDueEdit(chip, id);
          else if (action === "edit-est") openInlineTaskEstEdit(chip, id);
        });
      });
    });
  }

  function openExecContextMenu(taskId: string, x: number, y: number) {
    closeExecContextMenu();
    const t = execLastTasks.find((task) => task.id === taskId);
    if (!t) return;
    const menu = document.createElement("div");
    menu.className = "exec-context-menu";
    execContextMenuEl = menu;
    menu.innerHTML = `
      <button data-action="resolve" class="exec-context-item">${t.status === "resolved" ? "↺ Re-open" : "✓ Mark resolved"}</button>
      <div class="exec-context-sep"></div>
      <div class="exec-context-submenu-anchor">
        <button class="exec-context-item">↪ Reassign axis ›</button>
        <div class="exec-context-submenu">
          ${(() => {
            // FORK 2026-05-22 (Task 18) — Reassign submenu reads from the
            // execAxesList cache (Task 10) instead of the deleted
            // EXEC_AXIS_ORDER/EXEC_AXIS_LABEL constants. Sub-groups are
            // rendered indented with a "— " prefix so the hierarchy is
            // visible inside a flat vertical menu.
            const byId = new Map<string, AxisRow>();
            for (const a of execAxesList) byId.set(a.id, a);
            const roots = execAxesList
              .filter((a) => !a.parent_id || !byId.has(a.parent_id))
              .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
            const items: string[] = [];
            for (const r of roots) {
              items.push(
                `<button data-action="reassign-${escapeExecAttr(r.id)}" class="exec-context-item">${escapeHtml(r.label)}</button>`,
              );
              const kids = execAxesList
                .filter((a) => a.parent_id === r.id)
                .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
              for (const c of kids) {
                items.push(
                  `<button data-action="reassign-${escapeExecAttr(c.id)}" class="exec-context-item">— ${escapeHtml(c.label)}</button>`,
                );
              }
            }
            return items.join("");
          })()}
        </div>
      </div>
      <button data-action="reschedule" class="exec-context-item">📅 Reschedule…</button>
      ${
        t.status === "back_burner"
          ? `<button data-action="bring-back" class="exec-context-item">↩ Bring back</button>`
          : `<button data-action="snooze-tomorrow" class="exec-context-item">💤 Snooze until tomorrow</button>`
      }
      <div class="exec-context-sep"></div>
      <button data-action="delete" class="exec-context-item exec-context-item-warn">🗑 Delete</button>
      <div class="exec-context-sep"></div>
      <button data-action="edit-title" class="exec-context-item">✏️ Edit title</button>
      <button data-action="edit-context" class="exec-context-item">✏️ Edit description</button>
      <button data-action="refer-in-chat" class="exec-context-item">💬 Refer in chat</button>
    `;
    menu.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 360)}px`;
    document.body.appendChild(menu);
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - r.width - 8}px`;
      if (r.bottom > window.innerHeight - 8)
        menu.style.top = `${window.innerHeight - r.height - 8}px`;
    });
    menu.querySelectorAll<HTMLElement>(".exec-context-item").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const action = btn.dataset.action;
        if (!action) return;
        void handleExecTaskAction(taskId, action);
        closeExecContextMenu();
      });
    });
  }

  function closeExecContextMenu() {
    if (execContextMenuEl) {
      execContextMenuEl.remove();
      execContextMenuEl = null;
    }
  }

  async function handleExecTaskAction(taskId: string, action: string): Promise<void> {
    try {
      if (action === "menu") return;
      const t = execLastTasks.find((x) => x.id === taskId);
      if (action === "resolve") {
        await req("control-panel.tasks.update", {
          id: taskId,
          status: t?.status === "resolved" ? "open" : "resolved",
        });
      } else if (action === "toggle-resolve") {
        // FORK 2026-05-22: Today-card checkbox on collapsed head. Distinct
        // from menu's "resolve" (which is also a toggle today, but kept as a
        // separate action so the menu wording can diverge if needed).
        await req("control-panel.tasks.update", {
          id: taskId,
          status: t?.status === "resolved" ? "open" : "resolved",
        });
      } else if (action === "delete") {
        // FORK 2026-05-14 — delete is now a HARD remove via tasks.remove.
        // The "Deleted" filter chip and the soft-delete bucket were dropped
        // per user request: "When I delete an entry, I want it gone."
        await req("control-panel.tasks.remove", { id: taskId });
      } else if (action === "snooze-tomorrow") {
        // FORK 2026-05-14 — defer-to-tomorrow snooze. Status flips to
        // back_burner (hides from every filter except 💤 Snoozed AND from
        // All today). metadata.snoozed_until stores tomorrow's ISO date;
        // loadExecTasks scans on every render and auto-wakes the task to
        // status="open" when today's date catches up. No due_date is set,
        // so no chip appears — the snooze is invisible to the user.
        const t = execLastTasks.find((x) => x.id === taskId);
        if (!t) return;
        const d = new Date();
        d.setDate(d.getDate() + 1);
        const tomorrowIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const meta = mergeTaskMetadata(t, { snoozed_until: tomorrowIso });
        await req("control-panel.tasks.update", {
          id: taskId,
          status: "back_burner",
          due_date: null,
          metadata: meta,
        });
      } else if (action === "bring-back") {
        const t = execLastTasks.find((x) => x.id === taskId);
        const meta = t ? mergeTaskMetadata(t, { snoozed_until: null }) : undefined;
        await req("control-panel.tasks.update", {
          id: taskId,
          status: "open",
          ...(meta !== undefined ? { metadata: meta } : {}),
        });
      } else if (action.startsWith("reassign-")) {
        const axis = action.slice("reassign-".length);
        await req("control-panel.tasks.update", { id: taskId, priority_axis: axis });
      } else if (action === "reschedule") {
        // FORK 2026-05-11 — replaced the YYYY-MM-DD prompt with the 14-day
        // calendar picker overlay specified in SPEC §7.8. The picker shows
        // event density per day (from control-panel.calendar.density), the
        // count of tasks already rescheduled to each day, and highlights
        // today. The overlay handles the reschedule RPC + refresh itself.
        await openExecReschedulePicker(taskId);
        return;
      } else if (action === "edit-title") {
        // FORK 2026-05-23 (F1) — inline edit replaces the prior window.prompt
        // popup. Helper swaps the title span for an <input>; Enter/blur save,
        // Esc cancels. The expand-state must include this row so the drawer's
        // .exec-task-fulltitle-text is visible; if the row was collapsed,
        // expand it first, re-render, then open the editor on the new node.
        if (!t) return;
        if (execExpandedId !== taskId) {
          execExpandedId = taskId;
          await loadExecTasks();
        }
        const row = document.querySelector(
          `.exec-task[data-task-id="${CSS.escape(taskId)}"]`,
        ) as HTMLElement | null;
        if (row) openInlineTaskTitleEdit(row, taskId);
        return;
      } else if (action === "edit-context") {
        // FORK 2026-05-23 (F2) — inline edit replaces the prior window.prompt
        // popup. Helper swaps the rendered markdown for a <textarea>;
        // Ctrl/Cmd+Enter saves, Esc cancels, blur saves with empty-wipe guard.
        // Expand the row first if collapsed so the drawer's context-wrap
        // exists in the DOM as the swap target.
        if (!t) return;
        if (execExpandedId !== taskId) {
          execExpandedId = taskId;
          await loadExecTasks();
        }
        const row = document.querySelector(
          `.exec-task[data-task-id="${CSS.escape(taskId)}"]`,
        ) as HTMLElement | null;
        if (row) openInlineTaskContextEdit(row, taskId);
        return;
      } else if (action === "refer-in-chat") {
        if (!t) return;
        const textarea = document.getElementById("chat-textarea") as HTMLTextAreaElement | null;
        if (textarea) {
          textarea.value = `Re: ${t.text}`;
          textarea.focus();
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      } else if (action === "toggle-pin") {
        // FORK 2026-05-29 — pin toggles the 🟡 "in-progress" marker on the task
        // NAME (the convention: 🟡 prefix = Jarvis is actively on this; user
        // deleting the task = tested & done). Pure text edit via tasks.update;
        // strip a leading 🟡 (+ optional space) if present, else prepend "🟡 ".
        if (!t) return;
        const stripped = t.text.replace(/^🟡\s*/u, "");
        const next = t.text.startsWith("🟡") ? stripped : `🟡 ${stripped}`;
        await req("control-panel.tasks.update", { id: taskId, text: next });
      } else {
        return;
      }
      void loadExecTasks();
    } catch (err) {
      const row = document.querySelector(`.exec-task[data-task-id="${CSS.escape(taskId)}"]`);
      if (row) {
        row.classList.add("exec-task-error");
        setTimeout(() => row.classList.remove("exec-task-error"), 1500);
      }
      console.error("[exec-panel] task action failed", action, taskId, err);
    }
  }

  async function applyTaskMove(taskId: string, axis: string, rank: number) {
    const clamped = Math.round(Math.max(0, Math.min(1000, rank)));
    try {
      await req("control-panel.tasks.update", {
        id: taskId,
        priority_axis: axis,
        priority_rank: clamped,
      });
    } catch (err) {
      // FORK 2026-05-12 — RPC failure used to silently console.error, which
      // produced the reported "I drop the task and nothing happens" UX. Now
      // we also flash a transient error pill on the exec panel so the user
      // sees that the drop landed but the server rejected it.
      console.error("[exec-panel] tasks.update failed:", err);
      flashExecError(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function flashExecError(message: string): void {
    const panel = document.getElementById("exec-panel");
    if (!panel) return;
    let pill = panel.querySelector<HTMLElement>(".exec-error-pill");
    if (!pill) {
      pill = document.createElement("div");
      pill.className = "exec-error-pill";
      panel.appendChild(pill);
    }
    pill.textContent = message;
    pill.classList.add("exec-error-pill-visible");
    window.setTimeout(() => {
      pill?.classList.remove("exec-error-pill-visible");
    }, 4000);
  }

  function startExecPolling() {
    if (execTasksTimer) return;
    execTasksTimer = setInterval(() => {
      if (execDragRefreshSuppressed) return;
      // FORK 2026-05-23 — suppress the 10s task-list refresh while ANY
      // inline edit is open in the exec panel. The poll calls
      // loadExecTasks() which rebuilds the entire task list HTML, ripping
      // any in-flight <input> or <textarea> out of the DOM mid-edit. The
      // textarea's blur fires when it's removed, the blur handler calls
      // save() with whatever was typed so far, and the edit window
      // appears to close at random — exactly the user's reported symptom.
      // DOM-driven check (vs. a per-function open/close counter) covers
      // every inline-edit pathway uniformly: title, description, due,
      // est, axis-label, add-task, add-subgroup. The scope is intentional
      // (`closest('#exec-panel')`) so a focused input in the main chat
      // window or sessions panel does NOT block the tasks refresh.
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA") &&
        focused.closest("#exec-panel")
      ) {
        return;
      }
      void loadExecTasks();
    }, 10_000);
  }
  function stopExecPolling() {
    if (execTasksTimer) {
      clearInterval(execTasksTimer);
      execTasksTimer = null;
    }
  }

  const execPersisted = localStorage.getItem("tinker.execMode") === "exec";
  if (execPersisted) {
    app.classList.add("exec-mode");
    execBtn.classList.add("tb-active");
    void loadExecTasks();
    startExecPolling();
  }

  execBtn.addEventListener("click", () => {
    const isExec = app.classList.toggle("exec-mode");
    execBtn.classList.toggle("tb-active", isExec);
    localStorage.setItem("tinker.execMode", isExec ? "exec" : "dev");
    if (isExec) {
      void loadExecTasks();
      startExecPolling();
    } else {
      stopExecPolling();
    }
    // Re-evaluate exec-panel visibility: only visible when tab=chat AND exec-mode.
    applyExecPanelVisibility();
  });

  // ─── Sidebar tab switching ───
  const altView = $("alt-view")!;
  const chatArea = document.querySelector(".chat-area") as HTMLElement;
  const topbar = document.querySelector(".topbar") as HTMLElement;
  const ctxTimeline = $("context-timeline")!;
  const rightPanels = document.querySelector(".right-panels") as HTMLElement;
  const bottomRight = $("bottom-right-panel")!;
  let activeTab = "chat";

  // FORK 2026-05-14 — panels.md contract: exec-panel implies tab=chat.
  // Called from both the Dev/Exec toggle and switchTab so the two axes stay
  // consistent. Uses inline style override so the CSS `#app.exec-mode .exec-panel
  // { display: flex }` rule is suppressed when tab≠chat.
  function applyExecPanelVisibility(): void {
    const execPanel = document.querySelector(".exec-panel") as HTMLElement | null;
    if (!execPanel) return;
    const isExecMode = app.classList.contains("exec-mode");
    const isChatTab = activeTab === "chat";
    execPanel.style.display = isExecMode && isChatTab ? "" : "none";
  }

  type AltTab =
    | "overview"
    | "channels"
    | "sessions"
    | "usage"
    | "cron"
    | "agents"
    | "skills"
    | "nodes"
    | "config"
    | "debug"
    | "logs"
    | "recipes"
    // FORK 2026-06-06 — BROCA recipe visibility: a detail view reached by clicking
    // a recipe title (NOT a top-level nav button). switchTab("recipe-detail")
    // routes here; it is intentionally absent from the visible nav bar.
    | "recipe-detail";

  const TAB_COLORS: Record<AltTab, string> = {
    overview: "#4ade80",
    channels: "#60a5fa",
    sessions: "#c084fc",
    usage: "#f59e0b",
    cron: "#fb923c",
    agents: "#34d399",
    skills: "#facc15",
    nodes: "#38bdf8",
    config: "#a1a1aa",
    debug: "#f87171",
    logs: "#94a3b8",
    recipes: "#d4a574",
    "recipe-detail": "#e3b341",
  };

  function switchTab(tab: string) {
    if (tab === activeTab) {
      return;
    }
    activeTab = tab;
    // Update nav-btn active states
    document.querySelectorAll(".nav-btn[data-tab]").forEach((btn) => {
      btn.classList.toggle("nav-active", (btn as HTMLElement).dataset.tab === tab);
    });

    if (tab === "chat") {
      altView.classList.remove("alt-active");
      chatArea.style.display = "";
      topbar.style.display = "";
      ctxTimeline.style.display = "";
      rightPanels.style.display = "";
      bottomRight.style.display = "";
      // FORK 2026-05-14 — panels.md: exec-panel visible only when tab=chat + exec-mode.
      applyExecPanelVisibility();
      return;
    }
    // Show alt-view, hide chat panels
    chatArea.style.display = "none";
    topbar.style.display = "none";
    ctxTimeline.style.display = "none";
    rightPanels.style.display = "none";
    bottomRight.style.display = "none";
    // FORK 2026-05-14 — panels.md: exec-panel hides when tab≠chat.
    applyExecPanelVisibility();
    altView.classList.add("alt-active");
    renderAltView(tab as AltTab);
  }

  // FORK 2026-06-06 — BROCA recipe visibility: a single delegated listener (whole
  // document) for any .broca-recipe-link / [data-recipe-ref] element rendered by
  // renderBrocaProgram, the recipe-card link, the chat banner, or the RECIPES
  // panel. Clicking it selects the recipe and opens the dedicated recipe-detail
  // page. Guarded so it is attached exactly once. This does NOT remove the
  // existing openKitModal handler (that fires on [data-recipe-file]).
  if (!recipeRefListenerAttached) {
    recipeRefListenerAttached = true;
    document.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-recipe-ref]") as HTMLElement | null;
      if (!el) return;
      const ref = el.dataset.recipeRef;
      if (!ref) return;
      e.preventDefault();
      currentRecipeRef = ref;
      switchTab("recipe-detail");
    });
  }

  // ─── Alt-view helpers ───
  function altRelTime(ts: number | string | null | undefined): string {
    if (!ts) {
      return "—";
    }
    const ms = typeof ts === "string" ? new Date(ts).getTime() : ts;
    const diff = Date.now() - ms;
    if (diff < 60_000) {
      return "just now";
    }
    if (diff < 3_600_000) {
      return `${Math.floor(diff / 60_000)}m ago`;
    }
    if (diff < 86_400_000) {
      return `${Math.floor(diff / 3_600_000)}h ago`;
    }
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }
  function altDuration(ms: number | null | undefined): string {
    if (!ms) {
      return "—";
    }
    if (ms < 60_000) {
      return `${Math.round(ms / 1000)}s`;
    }
    if (ms < 3_600_000) {
      return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
    }
    return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  }
  function altEsc(s: unknown): string {
    if (s == null) {
      return "";
    }
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function altTokens(n: number | null | undefined): string {
    if (n == null) {
      return "—";
    }
    if (n >= 1_000_000) {
      return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1_000) {
      return `${(n / 1_000).toFixed(1)}K`;
    }
    return String(n);
  }
  function altJson(obj: unknown): string {
    try {
      return `<pre style="white-space:pre-wrap;word-break:break-all;font-size:11px;color:var(--text);margin:0">${altEsc(JSON.stringify(obj, null, 2))}</pre>`;
    } catch {
      return `<span class="muted">—</span>`;
    }
  }
  function altRow(label: string, value: string, cls = ""): string {
    return `<div class="row"><span class="label">${altEsc(label)}</span><span class="value ${cls}">${value}</span></div>`;
  }
  function altRefreshBtn(id: string): string {
    return `<button class="alt-refresh-btn" id="${id}" style="background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;margin-left:8px">↻ Refresh</button>`;
  }

  // ─── Alt-view event wiring (delegated, survives innerHTML) ───
  altView.addEventListener("click", (e) => {
    const tgt = e.target as HTMLElement;
    // Refresh buttons
    if (tgt.classList.contains("alt-refresh-btn")) {
      renderAltView(activeTab as AltTab);
      return;
    }
    // Session switch
    const sRow = tgt.closest("[data-session-key]") as HTMLElement | null;
    if (sRow) {
      const key = sRow.dataset.sessionKey!;
      if (key && key !== sessionKey) {
        sessionKey = key;
        loadChat();
        switchTab("chat");
        // FORK 2026-05-17: re-filter prefrontal for the newly-viewed session
        // (bible panels.md §147 — it only re-rendered on WS events before).
        updatePrefrontalTree();
      }
      return;
    }
    // Session delete
    const delBtn = tgt.closest(".alt-session-del") as HTMLElement | null;
    if (delBtn) {
      const key = delBtn.dataset.key!;
      if (key && confirm(`Delete session "${key}"?`)) {
        // FORK (2026-04-24): same soft-delete semantics as the session
        // panel × button. Transcript goes to sessions-archive/ instead
        // of being wiped.
        req("sessions.delete", { key, deleteTranscript: false })
          .then(() => renderAltView("sessions"))
          .catch(() => {});
      }
      return;
    }
    // Cron run-now
    const runBtn = tgt.closest(".alt-cron-run") as HTMLElement | null;
    if (runBtn) {
      const id = runBtn.dataset.id!;
      req("cron.run", { id }).catch(() => {});
      return;
    }
    // Cron enable/disable toggle
    const cronToggle = tgt.closest(".alt-cron-toggle") as HTMLElement | null;
    if (cronToggle) {
      const id = cronToggle.dataset.id!;
      const enable = cronToggle.dataset.enable === "true";
      req("cron.update", { id, patch: { enabled: enable } })
        .then(() => renderAltView("cron"))
        .catch(() => {});
      return;
    }
    // Debug RPC call
    if (tgt.id === "alt-debug-call") {
      const method = (
        document.getElementById("alt-debug-method") as HTMLInputElement
      )?.value?.trim();
      const paramsStr = (
        document.getElementById("alt-debug-params") as HTMLTextAreaElement
      )?.value?.trim();
      const resultEl = document.getElementById("alt-debug-result");
      if (!method || !resultEl) {
        return;
      }
      let params = {};
      try {
        if (paramsStr) {
          params = JSON.parse(paramsStr);
        }
      } catch {
        if (resultEl) {
          resultEl.innerHTML = `<span style="color:var(--red)">Invalid JSON params</span>`;
        }
        return;
      }
      resultEl.innerHTML = `<span class="muted">Calling ${altEsc(method)}…</span>`;
      req(method, params)
        .then((r) => {
          debugRpcHistory.push({ method, params, result: r, ts: Date.now() });
          resultEl.innerHTML = altJson(r);
        })
        .catch((err) => {
          debugRpcHistory.push({
            method,
            params,
            result: null,
            ts: Date.now(),
            error: (err as Error).message,
          });
          resultEl.innerHTML = `<span style="color:var(--red)">${altEsc((err as Error).message)}</span>`;
        });
      return;
    }
    // Skill toggle
    const skillToggle = tgt.closest(".alt-skill-toggle") as HTMLElement | null;
    if (skillToggle) {
      const key = skillToggle.dataset.key!;
      const enable = skillToggle.dataset.enable === "true";
      req("skills.update", { skillKey: key, enabled: enable })
        .then(() => renderAltView("skills"))
        .catch(() => {});
      return;
    }
  });

  // Session thinking-level change (delegated on altView for <select> change events)
  altView.addEventListener("change", (e) => {
    const tgt = e.target as HTMLElement;
    if (tgt.classList.contains("alt-sess-thinking")) {
      const key = tgt.dataset.key;
      const value = (tgt as HTMLSelectElement).value;
      if (key) {
        req("sessions.update", { key, patch: { thinkingLevel: value || null } }).catch(() => {});
      }
    }
  });

  // Logs auto-follow state
  let logsAutoFollow = true;
  let logsCursor: number | undefined;
  let logsInterval: ReturnType<typeof setInterval> | null = null;
  let logsLevelFilters = new Set(["info", "warn", "error", "fatal"]);
  let logsFilterText = "";

  async function renderAltView(tab: AltTab) {
    // Stop logs polling when leaving logs tab
    if (logsInterval && tab !== "logs") {
      clearInterval(logsInterval);
      logsInterval = null;
    }

    const color = TAB_COLORS[tab];
    const title = tab.charAt(0).toUpperCase() + tab.slice(1);
    const btnSvg = document.querySelector(`.nav-btn[data-tab="${tab}"] svg`)?.outerHTML || "";
    altView.innerHTML = `
      <div class="alt-view-header">
        <h2 style="color:${color}">${btnSvg} ${title} ${altRefreshBtn("alt-tab-refresh")}</h2>
        <p>Loading…</p>
      </div>
      <div class="alt-view-body">
        <div class="alt-placeholder"><svg viewBox="0 0 24 24" style="stroke:${color}"><path d="M12 2v4"/><circle cx="12" cy="12" r="3"/></svg><span>Fetching data…</span></div>
      </div>`;
    try {
      const body = altView.querySelector(".alt-view-body")!;
      const sub = altView.querySelector(".alt-view-header p")!;
      switch (tab) {
        case "overview":
          await renderOverviewTab(body, sub);
          break;
        case "channels":
          await renderChannelsTab(body, sub);
          break;
        case "sessions":
          await renderSessionsTab(body, sub);
          break;
        case "usage":
          await renderUsageTab(body, sub);
          break;
        case "cron":
          await renderCronTab(body, sub);
          break;
        case "agents":
          await renderAgentsTab(body, sub);
          break;
        case "skills":
          await renderSkillsTab(body, sub);
          break;
        case "nodes":
          await renderNodesTab(body, sub);
          break;
        case "config":
          await renderConfigTab(body, sub);
          break;
        case "debug":
          await renderDebugTab(body, sub);
          break;
        case "logs":
          await renderLogsTab(body, sub);
          break;
        case "recipes":
          await renderRecipesTab(body, sub);
          break;
        case "recipe-detail":
          await renderRecipeDetail(body, sub);
          break;
      }
    } catch (e) {
      const body = altView.querySelector(".alt-view-body");
      if (body) {
        body.innerHTML = `<div class="alt-placeholder"><span style="color:var(--red)">Error: ${altEsc((e as Error).message)}</span></div>`;
      }
    }
  }

  // ═══════════════ OVERVIEW ═══════════════
  async function renderOverviewTab(body: Element, sub: Element) {
    const [status, health, presence, cronStatus] = await Promise.all([
      req("status", {}).catch(() => null),
      req("health", {}).catch(() => null),
      req("system-presence", {}).catch(() => null),
      req("cron.status", {}).catch(() => null),
    ]);
    const snapshot = (status as unknown) ?? {};
    const presenceList = Array.isArray(presence)
      ? presence
      : ((presence as unknown)?.presence ?? []);
    const uptimeMs = snapshot.uptimeMs ?? snapshot.uptime;
    const tickMs = snapshot.policy?.tickIntervalMs ?? snapshot.tickIntervalMs;
    const cronSt = cronStatus as unknown;
    sub.textContent = "Gateway snapshot & system presence";
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="alt-card"><h3>Connection</h3>
          ${altRow("Status", connected ? "Connected" : "Disconnected", connected ? "green" : "red")}
          ${altRow("Gateway URL", altEsc(GW_WS || "—"))}
          ${altRow("Session", altEsc(sessionKey || "—"))}
          ${altRow("Uptime", altDuration(uptimeMs))}
          ${altRow("Tick interval", tickMs ? `${tickMs}ms` : "—")}
        </div>
        <div class="alt-card"><h3>System Stats</h3>
          ${altRow("Instances", String(presenceList.length))}
          ${altRow("Sessions", String(sessions.length))}
          ${altRow("Cron", cronSt?.enabled != null ? (cronSt.enabled ? "Enabled" : "Disabled") : "—", cronSt?.enabled ? "green" : "")}
          ${altRow("Cron jobs", cronSt?.jobs != null ? String(cronSt.jobs) : "—")}
          ${altRow("Next cron", cronSt?.nextWakeAtMs ? altRelTime(cronSt.nextWakeAtMs) : "—")}
        </div>
      </div>
      ${
        presenceList.length
          ? `<div class="alt-card"><h3>System Presence (${presenceList.length} instance${presenceList.length > 1 ? "s" : ""})</h3>
        ${presenceList
          .map(
            (p: unknown) => `<div class="row">
          <span class="label">${altEsc(p.host ?? p.instanceId ?? "?")}</span>
          <span class="value">${altEsc(p.version ?? "")} · ${altEsc(p.platform ?? "")}${p.roles?.length ? ` · ${p.roles.join(", ")}` : ""}</span>
        </div>`,
          )
          .join("")}
      </div>`
          : ""
      }
      ${health ? `<div class="alt-card"><h3>Health</h3>${altJson(health)}</div>` : ""}`;
  }

  // ═══════════════ CHANNELS ═══════════════
  async function renderChannelsTab(body: Element, sub: Element) {
    const res = await req("channels.status", { probe: false }).catch(() => null);
    const snap = res as unknown;
    if (!snap || !snap.channels) {
      sub.textContent = "Channel status";
      body.innerHTML = `<div class="alt-placeholder"><span>No channel data available</span></div>`;
      return;
    }
    const channelMeta: unknown[] = snap.channelMeta ?? [];
    const order: string[] = channelMeta.length
      ? channelMeta.map((m: unknown) => m.id)
      : (snap.channelOrder ?? Object.keys(snap.channels));
    const labels: Record<string, string> = snap.channelLabels ?? {};
    const accounts: Record<string, unknown[]> = snap.channelAccounts ?? {};
    const metaMap: Record<string, unknown> = {};
    for (const m of channelMeta) {
      metaMap[m.id] = m;
    }

    // Sort: enabled channels first, then disabled
    const sorted = order
      .map((ch, i) => {
        const data = snap.channels[ch] ?? {};
        const configured = data.configured ?? data.running ?? data.connected;
        return { ch, configured, order: i };
      })
      .toSorted((a, b) => {
        if (a.configured !== b.configured) {
          return a.configured ? -1 : 1;
        }
        return a.order - b.order;
      });

    const enabledCount = sorted.filter((s) => s.configured).length;
    sub.textContent = `${order.length} channel(s) · ${enabledCount} configured`;

    body.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${sorted
        .map(({ ch }) => {
          const data = snap.channels[ch] ?? {};
          const accts = accounts[ch] ?? [];
          const meta = metaMap[ch];
          const label = meta?.label ?? labels[ch] ?? ch.charAt(0).toUpperCase() + ch.slice(1);
          const configured = data.configured !== false;
          const running = data.running === true;
          const connectedVal = data.connected === true;
          const linked = data.linked === true;
          const lastError = data.lastError ?? data.error;
          const lastConnectedAt = data.lastConnectedAt;
          const lastMessageAt = data.lastMessageAt;
          const mode = data.mode;
          const authAgeMs = data.authAgeMs;

          // Derive overall status like upstream
          const _statusText = connectedVal
            ? "Connected"
            : running
              ? "Running"
              : configured
                ? "Configured"
                : "Not configured";
          const _statusCls = connectedVal
            ? "green"
            : running
              ? "green"
              : configured
                ? "yellow"
                : "";

          return `<div class="alt-card"><h3>${altEsc(label)}</h3>
          <div style="font-size:10px;color:var(--muted);margin-bottom:6px">${altEsc(meta?.description ?? `${label} channel status and configuration.`)}</div>
          ${altRow("Configured", configured ? "Yes" : "No", configured ? "green" : "red")}
          ${data.running != null ? altRow("Running", running ? "Yes" : "No", running ? "green" : "red") : ""}
          ${data.connected != null ? altRow("Connected", connectedVal ? "Yes" : "No", connectedVal ? "green" : "red") : ""}
          ${data.linked != null ? altRow("Linked", linked ? "Yes" : "No", linked ? "green" : "red") : ""}
          ${mode ? altRow("Mode", altEsc(mode)) : ""}
          ${lastConnectedAt ? altRow("Last connect", altRelTime(lastConnectedAt)) : ""}
          ${lastMessageAt ? altRow("Last message", altRelTime(lastMessageAt)) : ""}
          ${authAgeMs != null ? altRow("Auth age", altDuration(authAgeMs)) : ""}
          ${lastError ? `<div style="margin-top:6px;padding:6px 8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:4px;font-size:10px;color:#fca5a5">${altEsc(lastError)}</div>` : ""}
          ${accts.length ? renderChannelAccounts(accts, ch) : ""}
          ${
            ch === "whatsapp"
              ? `<div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap">
            <button class="alt-wa-btn" data-action="qr" style="background:var(--surface2);border:1px solid var(--border);color:var(--accent);border-radius:4px;padding:3px 10px;font-size:10px;cursor:pointer">Show QR</button>
            <button class="alt-wa-btn" data-action="relink" style="background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:3px 10px;font-size:10px;cursor:pointer">Relink</button>
            <button class="alt-wa-btn" data-action="probe" style="background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:3px 10px;font-size:10px;cursor:pointer">Probe</button>
            <button class="alt-wa-btn" data-action="logout" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:var(--red);border-radius:4px;padding:3px 10px;font-size:10px;cursor:pointer">Logout</button>
          </div>
          <div id="wa-qr-area"></div>`
              : ""
          }
          ${ch === "telegram" ? `<div style="margin-top:8px"><button class="alt-probe-btn" data-channel="telegram" style="background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:3px 10px;font-size:10px;cursor:pointer">Probe</button></div>` : ""}
        </div>`;
        })
        .join("")}
    </div>
    <div class="alt-card" style="margin-top:8px"><h3>Channel Health (raw)</h3>
      <details><summary style="cursor:pointer;font-size:10px;color:var(--muted)">Show raw snapshot</summary>
        ${altJson(snap)}
      </details>
    </div>`;

    // Wire WhatsApp buttons
    body.querySelectorAll(".alt-wa-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const action = (btn as HTMLElement).dataset.action;
        const qrArea = document.getElementById("wa-qr-area");
        if (action === "qr" || action === "relink") {
          if (qrArea) {
            qrArea.innerHTML = `<div style="padding:20px;font-size:10px;color:var(--muted)">Requesting QR…</div>`;
          }
          const r = (await req("web.login.start", { force: action === "relink" }).catch((err) => ({
            message: (err as Error).message,
          }))) as unknown;
          if (qrArea) {
            if (r?.qrDataUrl) {
              qrArea.innerHTML = `<div style="margin-top:8px;text-align:center"><img src="${r.qrDataUrl}" alt="WhatsApp QR" style="max-width:200px;border-radius:8px;border:2px solid var(--border)"><div style="font-size:10px;color:var(--muted);margin-top:4px">${altEsc(r.message ?? "Scan with WhatsApp")}</div></div>`;
            } else {
              qrArea.innerHTML = `<div style="padding:20px;font-size:10px;color:var(--muted)">${altEsc(r?.message ?? "No QR available")}</div>`;
            }
          }
        } else if (action === "probe") {
          await req("channels.status", { probe: true }).catch(() => null);
          renderAltView("channels");
        } else if (action === "logout") {
          if (confirm("Logout from WhatsApp?")) {
            await req("channels.logout", { channel: "whatsapp" }).catch(() => null);
            renderAltView("channels");
          }
        }
      });
    });
    // Wire probe buttons for other channels
    body.querySelectorAll(".alt-probe-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await req("channels.status", { probe: true }).catch(() => null);
        renderAltView("channels");
      });
    });
  }

  function renderChannelAccounts(accts: unknown[], _channel: string): string {
    const recentMs = 10 * 60 * 1000;
    return `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:6px">
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px">${accts.length} account(s)</div>
      ${accts
        .map((a: unknown) => {
          const name = a.name || a.accountId || "?";
          const runningVal = a.running
            ? "Yes"
            : a.lastInboundAt && Date.now() - a.lastInboundAt < recentMs
              ? "Active"
              : "No";
          const connVal =
            a.connected === true
              ? "Yes"
              : a.connected === false
                ? "No"
                : a.lastInboundAt && Date.now() - a.lastInboundAt < recentMs
                  ? "Active"
                  : "n/a";
          const probe = a.probe as unknown;
          const botUsername = probe?.bot?.username;
          return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 8px;margin-bottom:4px">
          <div style="font-size:11px;color:var(--text);font-weight:600">${botUsername ? `@${botUsername}` : altEsc(name)}</div>
          <div style="font-size:10px;color:var(--muted)">${altEsc(a.accountId ?? "")}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;margin-top:4px;font-size:10px">
            <span>Running: <span style="color:${runningVal === "Yes" || runningVal === "Active" ? "var(--green)" : "var(--red)"}">${runningVal}</span></span>
            <span>Configured: <span style="color:${a.configured ? "var(--green)" : "var(--red)"}">${a.configured ? "Yes" : "No"}</span></span>
            <span>Connected: <span style="color:${connVal === "Yes" || connVal === "Active" ? "var(--green)" : connVal === "No" ? "var(--red)" : "var(--muted)"}">${connVal}</span></span>
            <span>Last inbound: ${a.lastInboundAt ? altRelTime(a.lastInboundAt) : "n/a"}</span>
          </div>
          ${a.lastError ? `<div style="margin-top:4px;padding:4px 6px;background:rgba(239,68,68,0.1);border-radius:3px;font-size:10px;color:#fca5a5">${altEsc(a.lastError)}</div>` : ""}
        </div>`;
        })
        .join("")}
    </div>`;
  }

  // ═══════════════ SESSIONS ═══════════════
  async function renderSessionsTab(body: Element, sub: Element) {
    const res = await req("sessions.list", {
      includeGlobal: sessIncludeGlobal,
      includeUnknown: sessIncludeUnknown,
    }).catch(() => ({ sessions: [] }));
    let list: unknown[] = (res as unknown)?.sessions ?? [];
    const mainKey = (res as unknown)?.mainSessionKey;

    // Filter by activity window
    if (sessFilterActive !== "all") {
      const cutoff =
        Date.now() -
        ({ "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[
          sessFilterActive
        ] ?? 0);
      list = list.filter((s: unknown) => {
        const ts = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
        return ts >= cutoff;
      });
    }

    // Sort
    if (sessSortBy === "tokens") {
      list.sort(
        (a: unknown, b: unknown) =>
          (b.inputTokens ?? 0) +
          (b.outputTokens ?? 0) -
          ((a.inputTokens ?? 0) + (a.outputTokens ?? 0)),
      );
    } else if (sessSortBy === "key") {
      list.sort((a: unknown, b: unknown) => (a.key ?? "").localeCompare(b.key ?? ""));
    } else {
      list.sort((a: unknown, b: unknown) => {
        const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return tb - ta;
      });
    }

    // Apply limit
    const totalCount = list.length;
    if (sessFilterLimit > 0) {
      list = list.slice(0, sessFilterLimit);
    }

    const totalTokens = list.reduce(
      (sum: number, s: unknown) => sum + (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
      0,
    );
    sub.textContent = `${totalCount} session(s) · ${altTokens(totalTokens)} tokens`;

    // Filter bar
    const filterBar = `<div class="alt-card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:20px 12px">
      <label style="font-size:10px;color:var(--muted);display:flex;align-items:center;gap:4px">Active:
        <select class="alt-sess-filter" data-field="active" style="background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:3px;padding:2px 6px;font-size:10px">
          ${["all", "1h", "24h", "7d", "30d"].map((v) => `<option value="${v}"${v === sessFilterActive ? " selected" : ""}>${v === "all" ? "All time" : `Last ${v}`}</option>`).join("")}
        </select>
      </label>
      <label style="font-size:10px;color:var(--muted);display:flex;align-items:center;gap:4px">Sort:
        <select class="alt-sess-filter" data-field="sort" style="background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:3px;padding:2px 6px;font-size:10px">
          ${(["updated", "tokens", "key"] as const).map((v) => `<option value="${v}"${v === sessSortBy ? " selected" : ""}>${v === "updated" ? "Recently updated" : v === "tokens" ? "Most tokens" : "Key A-Z"}</option>`).join("")}
        </select>
      </label>
      <label style="font-size:10px;color:var(--muted);display:flex;align-items:center;gap:4px">Limit:
        <input class="alt-sess-filter" data-field="limit" type="number" min="0" max="500" value="${sessFilterLimit}" style="width:50px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:3px;padding:2px 6px;font-size:10px">
      </label>
      <label style="font-size:10px;color:var(--muted);display:flex;align-items:center;gap:4px">
        <input class="alt-sess-filter" data-field="global" type="checkbox" ${sessIncludeGlobal ? "checked" : ""}> Global
      </label>
      <label style="font-size:10px;color:var(--muted);display:flex;align-items:center;gap:4px">
        <input class="alt-sess-filter" data-field="unknown" type="checkbox" ${sessIncludeUnknown ? "checked" : ""}> Unknown
      </label>
    </div>`;

    if (!list.length) {
      body.innerHTML = `${filterBar}<div class="alt-placeholder"><span>No sessions match filters</span></div>`;
      wireSessionFilters(body);
      return;
    }

    body.innerHTML = `${filterBar}
    <div class="alt-card" style="padding:0;overflow:hidden">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead><tr style="border-bottom:1px solid var(--border);color:var(--muted);text-align:left">
          <th style="padding:20px 10px">Session</th>
          <th style="padding:20px 6px">Kind</th>
          <th style="padding:20px 6px">Model / Provider</th>
          <th style="padding:20px 6px;text-align:right">In</th>
          <th style="padding:20px 6px;text-align:right">Out</th>
          <th style="padding:20px 6px;text-align:right">Total</th>
          <th style="padding:20px 6px">Updated</th>
          <th style="padding:20px 6px">Thinking</th>
          <th style="padding:20px 6px;text-align:center;width:30px"></th>
        </tr></thead>
        <tbody>
          ${list
            .map((s: unknown) => {
              const isActive = s.key === sessionKey;
              const isMain = s.key === mainKey;
              const inTok = s.inputTokens ?? 0;
              const outTok = s.outputTokens ?? 0;
              const total = inTok + outTok;
              const thinkLv = s.thinkingLevel ?? "";
              const modelStr = s.model ?? "—";
              const providerStr = s.provider ?? "";
              return `<tr class="alt-sess-row" style="border-bottom:1px solid rgba(74,63,48,0.3);cursor:pointer${isActive ? ";background:rgba(193,154,107,0.1)" : ""}" data-session-key="${altEsc(s.key)}">
              <td style="padding:6px 10px;color:var(--accent);font-family:'SF Mono',monospace;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${altEsc(s.displayName ?? s.key)}${isMain ? ' <span style="color:var(--muted);font-size:9px">(main)</span>' : ""}${isActive ? ' <span style="color:var(--green);font-size:9px">*</span>' : ""}
              </td>
              <td style="padding:6px"><span style="padding:1px 5px;border-radius:3px;font-size:9px;background:var(--surface2);color:var(--muted)">${altEsc(s.kind ?? "—")}</span></td>
              <td style="padding:6px;color:var(--muted);font-size:10px">${altEsc(modelStr)}${providerStr ? ` <span style="color:var(--border)">·</span> ${altEsc(providerStr)}` : ""}</td>
              <td style="padding:6px;text-align:right;color:var(--muted);font-size:10px">${altTokens(inTok)}</td>
              <td style="padding:6px;text-align:right;font-size:10px">${altTokens(outTok)}</td>
              <td style="padding:6px;text-align:right;font-weight:600;font-size:10px">${altTokens(total)}</td>
              <td style="padding:6px;color:var(--muted);font-size:10px">${altRelTime(s.updatedAt)}</td>
              <td style="padding:6px">
                <select class="alt-sess-thinking" data-key="${altEsc(s.key)}" style="background:var(--bg);border:1px solid var(--border);color:var(--muted);border-radius:3px;padding:1px 4px;font-size:9px;cursor:pointer" title="Thinking level">
                  ${["", "low", "medium", "high"].map((v) => `<option value="${v}"${v === thinkLv ? " selected" : ""}>${v || "Auto"}</option>`).join("")}
                </select>
              </td>
              <td style="padding:6px;text-align:center"><span class="alt-session-del" data-key="${altEsc(s.key)}" style="color:var(--red);cursor:pointer;font-size:10px" title="Delete session">✕</span></td>
            </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
    ${totalCount > list.length ? `<div style="color:var(--muted);font-size:10px;padding:6px 0;text-align:center">Showing ${list.length} of ${totalCount} sessions</div>` : ""}`;

    wireSessionFilters(body);
  }

  function wireSessionFilters(container: Element) {
    container.querySelectorAll(".alt-sess-filter").forEach((el) => {
      const handler = () => {
        const field = (el as HTMLElement).dataset.field;
        if (field === "active") {
          sessFilterActive = (el as HTMLSelectElement).value;
        } else if (field === "sort") {
          sessSortBy = (el as HTMLSelectElement).value as unknown;
        } else if (field === "limit") {
          sessFilterLimit = parseInt((el as HTMLInputElement).value, 10) || 50;
        } else if (field === "global") {
          sessIncludeGlobal = (el as HTMLInputElement).checked;
        } else if (field === "unknown") {
          sessIncludeUnknown = (el as HTMLInputElement).checked;
        }
        renderAltView("sessions");
      };
      el.addEventListener("change", handler);
    });
  }

  // ═══════════════ USAGE ═══════════════
  async function renderUsageTab(body: Element, sub: Element) {
    const periodDays = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 }[usagePeriod] ?? 7;
    const today = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - periodDays * 86_400_000).toISOString().slice(0, 10);
    const [usage, cost] = await Promise.all([
      req("sessions.usage", { startDate, endDate: today, includeContextWeight: true }).catch(
        () => null,
      ),
      req("usage.cost", { startDate, endDate: today }).catch(() => null),
    ]);
    const usageData = usage as unknown;
    const costData = cost as unknown;
    const totals = usageData?.totals ?? {};
    const sessionUsage: unknown[] = usageData?.sessions ?? [];
    const dailyCost: unknown[] = costData?.daily ?? [];
    const totalIn = totals.inputTokens ?? 0;
    const totalOut = totals.outputTokens ?? 0;
    const totalCost = costData?.totalCost != null ? Number(costData.totalCost) : null;
    sub.textContent = `${startDate} → ${today} · ${altTokens(totalIn + totalOut)} tokens${totalCost != null ? ` · $${totalCost.toFixed(2)}` : ""}`;

    // Insights: top model, provider, session
    const modelMap: Record<string, number> = {};
    const providerMap: Record<string, number> = {};
    let topSession = { key: "", tokens: 0 };
    for (const s of sessionUsage) {
      const tok = (s.inputTokens ?? 0) + (s.outputTokens ?? 0);
      if (s.model) {
        modelMap[s.model] = (modelMap[s.model] ?? 0) + tok;
      }
      if (s.provider) {
        providerMap[s.provider] = (providerMap[s.provider] ?? 0) + tok;
      }
      if (tok > topSession.tokens) {
        topSession = { key: s.sessionKey ?? s.key ?? "?", tokens: tok };
      }
    }
    const topModel = Object.entries(modelMap).toSorted((a, b) => b[1] - a[1])[0];
    const topProvider = Object.entries(providerMap).toSorted((a, b) => b[1] - a[1])[0];

    // Daily bar chart data
    const maxDailyCost =
      dailyCost.reduce((mx: number, d: unknown) => Math.max(mx, Number(d.cost ?? 0)), 0) || 1;

    // Period selector
    const periodBar = `<div class="alt-card" style="display:flex;gap:6px;align-items:center;padding:20px 12px;flex-wrap:wrap">
      <span style="font-size:10px;color:var(--muted)">Period:</span>
      ${["1d", "7d", "30d", "90d"].map((p) => `<button class="alt-usage-period" data-period="${p}" style="background:${p === usagePeriod ? "var(--accent)" : "var(--surface2)"};color:${p === usagePeriod ? "var(--bg)" : "var(--muted)"};border:1px solid ${p === usagePeriod ? "var(--accent)" : "var(--border)"};border-radius:4px;padding:3px 10px;font-size:10px;cursor:pointer;font-weight:${p === usagePeriod ? "700" : "400"}">${p === "1d" ? "Today" : p}</button>`).join("")}
      <span style="flex:1"></span>
      <button class="alt-usage-export" style="background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:3px 10px;font-size:10px;cursor:pointer">Export JSON</button>
    </div>`;

    body.innerHTML = `${periodBar}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px">
        <div class="alt-card"><h3>Tokens</h3>
          ${altRow("Input", altTokens(totalIn))}
          ${altRow("Output", altTokens(totalOut))}
          ${altRow("Total", `<strong>${altTokens(totalIn + totalOut)}</strong>`)}
          ${totals.contextTokens != null ? altRow("Context", altTokens(totals.contextTokens)) : ""}
        </div>
        <div class="alt-card"><h3>Cost</h3>
          ${totalCost != null ? altRow("Total", `<strong>$${totalCost.toFixed(4)}</strong>`) : ""}
          ${costData?.inputCost != null ? altRow("Input", `$${Number(costData.inputCost).toFixed(4)}`) : ""}
          ${costData?.outputCost != null ? altRow("Output", `$${Number(costData.outputCost).toFixed(4)}`) : ""}
          ${totalCost != null && periodDays > 1 ? altRow("Avg/day", `$${(totalCost / periodDays).toFixed(4)}`) : ""}
          ${!costData ? altRow("Info", "Cost API not available") : ""}
        </div>
        <div class="alt-card"><h3>Insights</h3>
          ${altRow("Sessions", String(sessionUsage.length))}
          ${topModel ? altRow("Top model", `${altEsc(topModel[0])} (${altTokens(topModel[1])})`) : ""}
          ${topProvider ? altRow("Top provider", `${altEsc(topProvider[0])} (${altTokens(topProvider[1])})`) : ""}
          ${topSession.tokens > 0 ? altRow("Top session", `${altEsc(topSession.key.slice(0, 30))} (${altTokens(topSession.tokens)})`) : ""}
        </div>
        <div class="alt-card"><h3>Breakdown</h3>
          ${
            Object.entries(modelMap)
              .toSorted((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([m, t]) => altRow(altEsc(m), altTokens(t)))
              .join("") || altRow("—", "No data")
          }
        </div>
      </div>

      ${
        dailyCost.length
          ? `<div class="alt-card"><h3>Daily Cost</h3>
        <div style="display:flex;flex-direction:column;gap:3px">
          ${dailyCost
            .map((d: unknown) => {
              const c = Number(d.cost ?? 0);
              const pct = maxDailyCost > 0 ? (c / maxDailyCost) * 100 : 0;
              return `<div style="display:flex;align-items:center;gap:8px;font-size:10px">
              <span style="width:70px;color:var(--muted);font-family:'SF Mono',monospace;flex-shrink:0">${altEsc(d.date ?? "?")}</span>
              <div style="flex:1;height:14px;background:var(--bg);border-radius:2px;overflow:hidden;position:relative">
                <div style="width:${pct.toFixed(1)}%;height:100%;background:linear-gradient(90deg,rgba(245,158,11,0.3),rgba(245,158,11,0.7));border-radius:2px;transition:width .3s"></div>
              </div>
              <span style="width:60px;text-align:right;color:var(--text);font-family:'SF Mono',monospace;flex-shrink:0">\$${c.toFixed(4)}</span>
            </div>`;
            })
            .join("")}
        </div>
      </div>`
          : ""
      }

      ${
        sessionUsage.length
          ? `<div class="alt-card"><h3>Session Usage (${sessionUsage.length})</h3>
        <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:10px">
          <thead><tr style="border-bottom:1px solid var(--border);color:var(--muted);text-align:left">
            <th style="padding:4px 8px">Session</th>
            <th style="padding:4px 6px">Model</th>
            <th style="padding:4px 6px">Provider</th>
            <th style="padding:4px 6px;text-align:right">Input</th>
            <th style="padding:4px 6px;text-align:right">Output</th>
            <th style="padding:4px 6px;text-align:right">Total</th>
          </tr></thead>
          <tbody>
            ${sessionUsage
              .toSorted(
                (a: unknown, b: unknown) =>
                  (b.inputTokens ?? 0) +
                  (b.outputTokens ?? 0) -
                  ((a.inputTokens ?? 0) + (a.outputTokens ?? 0)),
              )
              .slice(0, 50)
              .map((s: unknown) => {
                const inT = s.inputTokens ?? 0;
                const outT = s.outputTokens ?? 0;
                return `<tr style="border-bottom:1px solid rgba(74,63,48,0.2)">
                <td style="padding:4px 8px;color:var(--accent);font-family:'SF Mono',monospace;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${altEsc(s.sessionKey ?? s.key ?? "?")}</td>
                <td style="padding:4px 6px;color:var(--muted)">${altEsc(s.model ?? "—")}</td>
                <td style="padding:4px 6px;color:var(--muted)">${altEsc(s.provider ?? "—")}</td>
                <td style="padding:4px 6px;text-align:right;color:var(--muted)">${altTokens(inT)}</td>
                <td style="padding:4px 6px;text-align:right">${altTokens(outT)}</td>
                <td style="padding:4px 6px;text-align:right;font-weight:600">${altTokens(inT + outT)}</td>
              </tr>`;
              })
              .join("")}
          </tbody>
        </table>
        </div>
        ${sessionUsage.length > 50 ? `<div style="color:var(--muted);font-size:10px;padding:4px 0;text-align:center">Showing top 50 of ${sessionUsage.length}</div>` : ""}
      </div>`
          : ""
      }`;

    // Wire period buttons
    body.querySelectorAll(".alt-usage-period").forEach((btn) => {
      btn.addEventListener("click", () => {
        usagePeriod = (btn as HTMLElement).dataset.period ?? "7d";
        renderAltView("usage");
      });
    });
    // Wire export
    body.querySelector(".alt-usage-export")?.addEventListener("click", () => {
      const blob = new Blob(
        [
          JSON.stringify(
            {
              period: usagePeriod,
              startDate,
              endDate: today,
              totals,
              dailyCost,
              sessions: sessionUsage,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `usage-${startDate}-${today}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  // ═══════════════ TAB STATE ═══════════════
  let cronSelectedJobId: string | null = null;
  let sessFilterActive = "all"; // 1h | 24h | 7d | 30d | all
  let sessFilterLimit = 50;
  let sessIncludeGlobal = true;
  let sessIncludeUnknown = true;
  let sessSortBy: "updated" | "tokens" | "key" = "updated";
  let usagePeriod = "7d"; // 1d | 7d | 30d | 90d

  async function renderCronTab(body: Element, sub: Element) {
    const [status, jobsRes] = await Promise.all([
      req("cron.status", {}).catch(() => null),
      req("cron.list", { includeDisabled: true }).catch(() => null),
    ]);
    const st = status as unknown;
    const jobs: unknown[] = (jobsRes as unknown)?.jobs ?? [];
    const enabledCount = jobs.filter((j: unknown) => j.enabled).length;
    sub.textContent = `${jobs.length} job(s) · ${enabledCount} enabled · ${st?.enabled ? "Cron active" : "Cron disabled"}`;

    // Fetch runs for selected job or all
    let runs: unknown[] = [];
    let runsTotal = 0;
    if (cronSelectedJobId || jobs.length) {
      const runsRes = (await req("cron.runs", {
        jobId: cronSelectedJobId ?? undefined,
        limit: 20,
      }).catch(() => null)) as unknown;
      runs = runsRes?.runs ?? runsRes?.entries ?? [];
      runsTotal = runsRes?.total ?? runs.length;
    }

    body.innerHTML = `
      <div class="alt-card" style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
        <div style="flex:1;min-width:100px">
          <div style="font-size:10px;color:var(--muted)">Enabled</div>
          <div style="font-size:14px;font-weight:700;color:${st?.enabled ? "var(--green)" : "var(--red)"}">${st?.enabled ? "Yes" : "No"}</div>
        </div>
        <div style="flex:1;min-width:80px">
          <div style="font-size:10px;color:var(--muted)">Jobs</div>
          <div style="font-size:14px;font-weight:700">${st?.jobs ?? jobs.length}</div>
        </div>
        <div style="flex:2;min-width:150px">
          <div style="font-size:10px;color:var(--muted)">Next wake</div>
          <div style="font-size:12px">${st?.nextWakeAtMs ? `${altRelTime(st.nextWakeAtMs)} <span style="color:var(--muted);font-size:10px">(${new Date(st.nextWakeAtMs).toLocaleString()})</span>` : "—"}</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <div class="alt-card"><h3>Jobs (${jobs.length})</h3>
            ${jobs.length ? jobs.map((j: unknown) => renderCronJob(j)).join("") : `<div style="color:var(--muted);font-size:11px;padding:20px 0">No cron jobs configured</div>`}
          </div>
        </div>
        <div>
          <div class="alt-card"><h3>Run History${cronSelectedJobId ? ` — ${altEsc(jobs.find((j: unknown) => j.id === cronSelectedJobId)?.name ?? cronSelectedJobId)}` : " — All jobs"} <span style="color:var(--muted);font-size:10px">(${runsTotal})</span></h3>
            <div style="margin-bottom:6px;display:flex;gap:4px">
              <button class="alt-cron-scope" data-scope="all" style="background:${!cronSelectedJobId ? "var(--surface2)" : "transparent"};border:1px solid var(--border);color:var(--muted);border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer">All jobs</button>
            </div>
            ${runs.length ? runs.map((r: unknown) => renderCronRun(r)).join("") : `<div style="color:var(--muted);font-size:11px;padding:20px 0">No runs recorded</div>`}
          </div>
        </div>
      </div>`;

    // Wire cron-specific event handlers within the body
    body.querySelectorAll(".alt-cron-job-card").forEach((card) => {
      card.addEventListener("click", () => {
        cronSelectedJobId = (card as HTMLElement).dataset.jobId ?? null;
        renderAltView("cron");
      });
    });
    body.querySelectorAll(".alt-cron-scope").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        cronSelectedJobId = null;
        renderAltView("cron");
      });
    });
    body.querySelectorAll(".alt-cron-run-due").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.id!;
        req("cron.run", { id, mode: "due" }).catch(() => {});
      });
    });
    body.querySelectorAll(".alt-cron-del").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.id!;
        const name = (btn as HTMLElement).dataset.name ?? id;
        if (confirm(`Remove cron job "${name}"?`)) {
          req("cron.remove", { id })
            .then(() => renderAltView("cron"))
            .catch(() => {});
        }
      });
    });
  }

  function renderCronJob(j: unknown): string {
    const state = j.state ?? {};
    const lastStatus = state.lastStatus ?? j.lastStatus;
    const statusCls =
      lastStatus === "ok"
        ? "green"
        : lastStatus === "error"
          ? "red"
          : lastStatus === "skipped"
            ? "yellow"
            : "";
    const statusLabel =
      lastStatus === "ok"
        ? "OK"
        : lastStatus === "error"
          ? "Error"
          : lastStatus === "skipped"
            ? "Skipped"
            : "—";
    const nextRunAtMs = state.nextRunAtMs;
    const lastRunAtMs = state.lastRunAtMs;
    const isSelected = j.id === cronSelectedJobId;
    const payload = j.payload ?? {};
    const payloadKind = payload.kind ?? "agentTurn";
    const payloadText =
      payloadKind === "systemEvent" ? (payload.text ?? "") : (payload.message ?? "");
    const delivery = j.delivery;
    const deliveryText = delivery
      ? `${delivery.mode ?? ""}${delivery.channel ? ` → ${delivery.channel}` : ""}${delivery.to ? ` → ${delivery.to}` : ""}`
      : "";

    // Schedule display like upstream
    let scheduleText = "";
    if (j.scheduleKind === "at" || j.schedule?.startsWith?.("at:")) {
      scheduleText = `At: ${j.scheduleAt ?? j.schedule ?? "?"}`;
    } else if (j.scheduleKind === "cron") {
      scheduleText = `Cron: ${j.cronExpr ?? j.schedule ?? j.cron ?? "?"}`;
    } else {
      scheduleText =
        (j.schedule ?? j.cron ?? j.everyAmount)
          ? `Every ${j.everyAmount ?? "?"}${j.everyUnit ?? "m"}`
          : "?";
    }

    return `<div class="alt-cron-job-card" data-job-id="${altEsc(j.id)}" style="background:${isSelected ? "rgba(193,154,107,0.1)" : "var(--bg)"};border:1px solid ${isSelected ? "var(--accent)" : "var(--border)"};border-radius:4px;padding:20px 10px;margin-bottom:6px;cursor:pointer;transition:background .15s">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:11px;font-weight:600;color:var(--accent)">${altEsc(j.name ?? j.id ?? "?")}</span>
        <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:${j.enabled ? "rgba(107,142,35,0.2)" : "rgba(205,92,92,0.2)"};color:${j.enabled ? "var(--green)" : "var(--red)"}">${j.enabled ? "Enabled" : "Disabled"}</span>
      </div>
      <div style="font-size:10px;color:var(--muted);margin-top:3px;font-family:'SF Mono',monospace">${altEsc(scheduleText)}</div>
      ${j.description ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">${altEsc(j.description)}</div>` : ""}
      ${payloadText ? `<div style="font-size:10px;color:var(--muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%"><span style="color:var(--text);font-size:9px;text-transform:uppercase">${payloadKind === "systemEvent" ? "System" : "Prompt"}:</span> ${altEsc(payloadText.slice(0, 120))}</div>` : ""}
      ${deliveryText ? `<div style="font-size:10px;color:var(--muted);margin-top:2px"><span style="font-size:9px;color:var(--text);text-transform:uppercase">Delivery:</span> ${altEsc(deliveryText)}</div>` : ""}
      <div style="display:flex;gap:6px;margin-top:4px;font-size:10px;flex-wrap:wrap;align-items:center">
        <span style="color:var(--muted)">Status: <span style="color:var(--${statusCls})">${statusLabel}</span></span>
        <span style="color:var(--muted)">Next: ${nextRunAtMs ? altRelTime(nextRunAtMs) : "—"}</span>
        <span style="color:var(--muted)">Last: ${lastRunAtMs ? altRelTime(lastRunAtMs) : "—"}</span>
        ${j.agentId ? `<span style="color:var(--muted)">Agent: ${altEsc(j.agentId)}</span>` : ""}
      </div>
      <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">
        <span style="padding:1px 6px;border-radius:3px;font-size:9px;background:var(--surface2);color:var(--muted)">${j.sessionTarget ?? "main"}</span>
        <span style="padding:1px 6px;border-radius:3px;font-size:9px;background:var(--surface2);color:var(--muted)">${j.wakeMode ?? "now"}</span>
        <span class="alt-cron-toggle" data-id="${altEsc(j.id)}" data-enable="${!j.enabled}" style="cursor:pointer;padding:1px 6px;border-radius:3px;font-size:9px;background:var(--surface2);color:var(--accent)">${j.enabled ? "Disable" : "Enable"}</span>
        <span class="alt-cron-run" data-id="${altEsc(j.id)}" style="cursor:pointer;padding:1px 6px;border-radius:3px;font-size:9px;background:var(--surface2);color:var(--accent)">▶ Run</span>
        <span class="alt-cron-run-due" data-id="${altEsc(j.id)}" style="cursor:pointer;padding:1px 6px;border-radius:3px;font-size:9px;background:var(--surface2);color:var(--muted)">Run if due</span>
        <span class="alt-cron-del" data-id="${altEsc(j.id)}" data-name="${altEsc(j.name ?? "")}" style="cursor:pointer;padding:1px 6px;border-radius:3px;font-size:9px;background:rgba(239,68,68,0.1);color:var(--red)">Remove</span>
      </div>
    </div>`;
  }

  function renderCronRun(r: unknown): string {
    const status = r.status ?? "unknown";
    const statusCls =
      status === "ok" ? "green" : status === "error" ? "red" : status === "skipped" ? "yellow" : "";
    const statusLabel =
      status === "ok"
        ? "OK"
        : status === "error"
          ? "Error"
          : status === "skipped"
            ? "Skipped"
            : "Unknown";
    const deliveryStatus = r.deliveryStatus ?? "not-requested";
    const deliveryLabel =
      deliveryStatus === "delivered"
        ? "Delivered"
        : deliveryStatus === "not-delivered"
          ? "Not delivered"
          : deliveryStatus === "not-requested"
            ? "Not requested"
            : "Unknown";
    const usage = r.usage;
    const usageSummary =
      usage && typeof usage.total_tokens === "number"
        ? `${altTokens(usage.total_tokens)} tokens`
        : usage && typeof usage.input_tokens === "number"
          ? `${altTokens(usage.input_tokens)} in / ${altTokens(usage.output_tokens)} out`
          : null;
    return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 8px;margin-bottom:4px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:11px;color:var(--text)">${altEsc(r.jobName ?? r.jobId ?? "?")}</span>
        <span style="font-size:10px;color:var(--${statusCls})">${statusLabel}</span>
      </div>
      <div style="font-size:10px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${altEsc(r.summary ?? r.error ?? "No summary")}</div>
      <div style="display:flex;gap:6px;margin-top:4px;font-size:10px;flex-wrap:wrap">
        <span style="padding:1px 5px;border-radius:3px;background:var(--surface2);color:var(--muted)">${deliveryLabel}</span>
        ${r.model ? `<span style="padding:1px 5px;border-radius:3px;background:var(--surface2);color:var(--muted)">${altEsc(r.model)}</span>` : ""}
        ${r.provider ? `<span style="padding:1px 5px;border-radius:3px;background:var(--surface2);color:var(--muted)">${altEsc(r.provider)}</span>` : ""}
        ${usageSummary ? `<span style="padding:1px 5px;border-radius:3px;background:var(--surface2);color:var(--muted)">${usageSummary}</span>` : ""}
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:3px;font-size:9px;color:var(--muted)">
        <span>${r.startedAt ? new Date(r.startedAt).toLocaleString() : r.ts ? new Date(r.ts).toLocaleString() : "—"}</span>
        ${r.durationMs != null ? `<span>${altDuration(r.durationMs)}</span>` : ""}
        ${r.sessionKey ? `<span data-session-key="${altEsc(r.sessionKey)}" style="cursor:pointer;color:var(--accent)">→ chat</span>` : ""}
      </div>
    </div>`;
  }

  // ═══════════════ AGENTS ═══════════════
  async function renderAgentsTab(body: Element, sub: Element) {
    const [agentsRes, toolsRes] = await Promise.all([
      req("agents.list", {}).catch(() => null),
      req("tools.catalog", { includePlugins: true }).catch(() => null),
    ]);
    const data = agentsRes as unknown;
    const agents: unknown[] = data?.agents ?? [];
    const defaultId = data?.defaultId ?? "";
    const toolsCat = toolsRes as unknown;
    const profiles: unknown[] = toolsCat?.profiles ?? [];
    const groups: unknown[] = toolsCat?.groups ?? [];
    const totalTools = profiles.reduce(
      (s: number, p: unknown) => s + (p.toolCount ?? p.tools?.length ?? 0),
      0,
    );
    sub.textContent = `${agents.length} agent(s) · ${totalTools} tools · ${profiles.length} profile(s)`;

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${agents
          .map((a: unknown) => {
            const isDefault = a.id === defaultId;
            const fb: unknown[] = Array.isArray(a.fallbacks) ? a.fallbacks : [];
            const channels: unknown[] = Array.isArray(a.channels) ? a.channels : [];
            const skills: unknown[] = Array.isArray(a.skills) ? a.skills : [];
            return `<div class="alt-card">
            <h3 style="display:flex;align-items:center;gap:6px">
              ${a.emoji ? `<span style="font-size:16px">${a.emoji}</span>` : ""}
              ${altEsc(a.name ?? a.id ?? "?")}
              ${isDefault ? '<span style="padding:1px 6px;border-radius:3px;font-size:9px;background:rgba(193,154,107,0.2);color:var(--accent)">default</span>' : ""}
            </h3>
            <div style="font-size:10px;color:var(--muted);margin-bottom:6px;font-family:'SF Mono',monospace">${altEsc(a.id ?? "")}</div>
            ${a.description ? `<div style="font-size:10px;color:var(--muted);margin-bottom:6px">${altEsc(a.description.slice(0, 200))}</div>` : ""}
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 12px">
              ${a.model ? altRow("Model", altEsc(a.model)) : ""}
              ${a.provider ? altRow("Provider", altEsc(a.provider)) : ""}
              ${a.workspace ? altRow("Workspace", `<span style="font-family:'SF Mono',monospace;font-size:9px">${altEsc(a.workspace)}</span>`) : ""}
              ${a.thinkingLevel ? altRow("Thinking", altEsc(a.thinkingLevel)) : ""}
              ${a.toolProfile ? altRow("Tool profile", altEsc(a.toolProfile)) : ""}
              ${a.sessionTarget ? altRow("Session", altEsc(a.sessionTarget)) : ""}
            </div>
            ${
              fb.length
                ? `<div style="margin-top:6px">
              <div style="font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:3px">Fallback chain</div>
              <div style="display:flex;gap:4px;flex-wrap:wrap">${fb
                .map((f: unknown, i: number) => {
                  const label =
                    typeof f === "string" ? f : `${f.model ?? "?"} (${f.provider ?? "?"})`;
                  return `<span style="padding:1px 6px;border-radius:3px;font-size:9px;background:var(--surface2);color:var(--muted)">${i + 1}. ${altEsc(label)}</span>`;
                })
                .join("")}</div>
            </div>`
                : ""
            }
            ${channels.length ? `<div style="margin-top:4px;font-size:10px;color:var(--muted)">Channels: ${channels.map((c: unknown) => altEsc(typeof c === "string" ? c : (c.id ?? c.name ?? "?"))).join(", ")}</div>` : ""}
            ${skills.length ? `<div style="margin-top:2px;font-size:10px;color:var(--muted)">Skills: ${skills.length}</div>` : ""}
          </div>`;
          })
          .join("")}
      </div>

      ${
        profiles.length
          ? `<div class="alt-card"><h3>Tool Profiles (${profiles.length})</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          ${profiles
            .map((p: unknown) => {
              const tools: unknown[] = p.tools ?? [];
              const count = p.toolCount ?? tools.length;
              return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 8px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-size:11px;font-weight:600;color:var(--accent)">${altEsc(p.id ?? p.name ?? "?")}</span>
                <span style="font-size:10px;color:var(--muted)">${count} tool(s)</span>
              </div>
              ${p.description ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">${altEsc(p.description.slice(0, 100))}</div>` : ""}
              ${
                tools.length
                  ? `<div style="margin-top:4px;display:flex;gap:3px;flex-wrap:wrap">${tools
                      .slice(0, 12)
                      .map(
                        (t: unknown) =>
                          `<span style="padding:1px 4px;border-radius:2px;font-size:8px;background:var(--surface2);color:var(--muted)">${altEsc(typeof t === "string" ? t : (t.name ?? t.id ?? "?"))}</span>`,
                      )
                      .join(
                        "",
                      )}${tools.length > 12 ? `<span style="font-size:8px;color:var(--muted)">+${tools.length - 12}</span>` : ""}</div>`
                  : ""
              }
            </div>`;
            })
            .join("")}
        </div>
      </div>`
          : ""
      }

      ${
        groups.length
          ? `<div class="alt-card"><h3>Tool Groups (${groups.length})</h3>
        ${groups
          .map((g: unknown) => {
            const tools: unknown[] = g.tools ?? [];
            return `<div class="row" style="flex-wrap:wrap">
            <span class="label" style="font-weight:600">${altEsc(g.id ?? g.name ?? "?")}</span>
            <span class="value">${tools.length} tool(s)${g.description ? ` — ${altEsc(g.description.slice(0, 80))}` : ""}</span>
          </div>`;
          })
          .join("")}
      </div>`
          : ""
      }`;
  }

  // ═══════════════ SKILLS ═══════════════
  async function renderSkillsTab(body: Element, sub: Element) {
    const res = await req("skills.status", {}).catch(() => null);
    const data = res as unknown;
    const skills: unknown[] = data?.skills ?? [];
    const enabledCount = skills.filter((s: unknown) => s.enabled !== false).length;
    const issueCount = skills.filter(
      (s: unknown) => s.missingBinaries?.length || s.unavailableReason,
    ).length;
    sub.textContent = `${skills.length} skill(s) · ${enabledCount} enabled${issueCount ? ` · ${issueCount} with issues` : ""}`;
    if (!skills.length) {
      body.innerHTML = `<div class="alt-placeholder"><span>No skills registered</span></div>`;
      return;
    }
    const grouped: Record<string, unknown[]> = {};
    for (const s of skills) {
      const group = s.source ?? s.group ?? "other";
      (grouped[group] ??= []).push(s);
    }
    body.innerHTML = Object.entries(grouped)
      .map(
        ([group, items]) => `
      <div class="alt-card">
        <h3 style="display:flex;justify-content:space-between;align-items:center">${altEsc(group)}
          <span style="font-size:10px;font-weight:400;color:var(--muted)">${items.filter((s: unknown) => s.enabled !== false).length}/${items.length} enabled</span>
        </h3>
        ${items
          .map((s: unknown) => {
            const enabled = s.enabled !== false;
            const missingBins: string[] = s.missingBinaries ?? [];
            const unavail = s.unavailableReason;
            const hasIssue = missingBins.length > 0 || !!unavail;
            const version = s.version ?? s.skillVersion;
            const author = s.author ?? s.publishedBy;
            return `<div style="background:var(--bg);border:1px solid ${hasIssue ? "rgba(239,68,68,0.3)" : "var(--border)"};border-radius:4px;padding:6px 10px;margin-bottom:4px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:11px;font-weight:600;color:${hasIssue ? "var(--yellow)" : "var(--text)"}">
                ${s.emoji ? s.emoji + " " : ""}${altEsc(s.name ?? s.key ?? "?")}
                ${version ? `<span style="font-size:9px;color:var(--muted);font-weight:400;margin-left:4px">v${altEsc(version)}</span>` : ""}
              </span>
              <span style="display:flex;align-items:center;gap:6px">
                ${hasIssue ? `<span style="padding:1px 5px;border-radius:3px;font-size:9px;background:rgba(239,68,68,0.1);color:var(--red)">!</span>` : ""}
                <span class="alt-skill-toggle" data-key="${altEsc(s.key ?? s.name)}" data-enable="${!enabled}" style="cursor:pointer;padding:2px 8px;border-radius:4px;font-size:10px;background:${enabled ? "rgba(107,142,35,0.2)" : "rgba(205,92,92,0.2)"};color:${enabled ? "var(--green)" : "var(--red)"}">${enabled ? "Enabled" : "Disabled"}</span>
              </span>
            </div>
            ${s.description ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">${altEsc(s.description.slice(0, 160))}</div>` : ""}
            ${author ? `<div style="font-size:9px;color:var(--muted);margin-top:2px">by ${altEsc(author)}</div>` : ""}
            ${missingBins.length ? `<div style="margin-top:4px;font-size:9px;color:var(--red)">Missing: ${missingBins.map((b: string) => `<code style="background:rgba(239,68,68,0.1);padding:0 3px;border-radius:2px">${altEsc(b)}</code>`).join(", ")}</div>` : ""}
            ${unavail ? `<div style="margin-top:3px;font-size:9px;color:var(--red)">${altEsc(unavail)}</div>` : ""}
            ${s.apiKeyRequired ? `<div style="margin-top:3px;font-size:9px;color:var(--yellow)">Requires API key${s.apiKeyConfigured ? " (configured)" : " (not set)"}</div>` : ""}
          </div>`;
          })
          .join("")}
      </div>`,
      )
      .join("");
  }

  // ═══════════════ NODES ═══════════════
  async function renderNodesTab(body: Element, sub: Element) {
    const [nodesRes, devicesRes] = await Promise.all([
      req("node.list", {}).catch(() => null),
      req("device.pair.list", {}).catch(() => null),
    ]);
    const nodes: unknown[] = (nodesRes as unknown)?.nodes ?? [];
    const pending: unknown[] = (devicesRes as unknown)?.pending ?? [];
    const paired: unknown[] = (devicesRes as unknown)?.paired ?? [];
    const onlineNodes = nodes.filter(
      (n: unknown) => n.connected !== false && n.status !== "offline",
    );
    sub.textContent = `${nodes.length} node(s) · ${onlineNodes.length} online · ${paired.length} device(s) · ${pending.length} pending`;

    body.innerHTML = `
      ${
        pending.length
          ? `<div class="alt-card" style="border-color:var(--yellow)"><h3>Pending Device Requests (${pending.length})</h3>
        ${pending
          .map(
            (
              d: unknown,
            ) => `<div style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:20px 10px;margin-bottom:4px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:11px;font-weight:600;color:var(--yellow)">${altEsc(d.displayName ?? d.deviceId ?? "?")}</span>
            <span style="display:flex;gap:4px">
              <button class="alt-device-approve" data-request-id="${altEsc(d.requestId)}" style="background:var(--green);color:#fff;border:none;border-radius:3px;padding:2px 10px;font-size:10px;cursor:pointer">Approve</button>
              <button class="alt-device-reject" data-request-id="${altEsc(d.requestId)}" style="background:var(--red);color:#fff;border:none;border-radius:3px;padding:2px 10px;font-size:10px;cursor:pointer">Reject</button>
            </span>
          </div>
          <div style="display:flex;gap:8px;margin-top:4px;font-size:10px;color:var(--muted);flex-wrap:wrap">
            ${d.remoteIp ? `<span>IP: ${altEsc(d.remoteIp)}</span>` : ""}
            ${d.userAgent ? `<span>UA: ${altEsc(d.userAgent.slice(0, 60))}</span>` : ""}
            ${d.requestedAt ? `<span>Requested: ${altRelTime(d.requestedAt)}</span>` : ""}
            ${d.roles?.length ? `<span>Roles: ${d.roles.join(", ")}</span>` : ""}
          </div>
        </div>`,
          )
          .join("")}
      </div>`
          : ""
      }

      ${
        paired.length
          ? `<div class="alt-card"><h3>Paired Devices (${paired.length})</h3>
        ${paired
          .map(
            (
              d: unknown,
            ) => `<div style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 10px;margin-bottom:4px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:11px;font-weight:600;color:var(--accent)">${altEsc(d.displayName ?? d.deviceId ?? "?")}</span>
            <span style="font-size:9px;padding:1px 6px;border-radius:3px;background:rgba(107,142,35,0.2);color:var(--green)">Paired</span>
          </div>
          <div style="display:flex;gap:8px;margin-top:4px;font-size:10px;color:var(--muted);flex-wrap:wrap">
            ${d.roles?.length ? `<span>Roles: ${d.roles.join(", ")}</span>` : ""}
            <span>Since: ${altRelTime(d.approvedAtMs ?? d.createdAtMs)}</span>
            ${d.lastSeenAt ? `<span>Last seen: ${altRelTime(d.lastSeenAt)}</span>` : ""}
            ${d.tokenId ? `<span style="font-family:'SF Mono',monospace;font-size:9px">Token: ${altEsc(d.tokenId.slice(0, 12))}…</span>` : ""}
          </div>
        </div>`,
          )
          .join("")}
      </div>`
          : ""
      }

      ${
        nodes.length
          ? `<div class="alt-card"><h3>Exec Nodes (${nodes.length})</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          ${nodes
            .map((n: unknown) => {
              const online = n.connected !== false && n.status !== "offline";
              const caps: string[] = n.capabilities ?? [];
              return `<div style="background:var(--bg);border:1px solid ${online ? "var(--border)" : "rgba(239,68,68,0.3)"};border-radius:4px;padding:6px 10px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-size:11px;font-weight:600;color:var(--text)">${altEsc(n.id ?? n.nodeId ?? "?")}</span>
                <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:${online ? "rgba(107,142,35,0.2)" : "rgba(239,68,68,0.2)"};color:${online ? "var(--green)" : "var(--red)"}">${online ? "Online" : "Offline"}</span>
              </div>
              <div style="font-size:10px;color:var(--muted);margin-top:3px">
                ${(n.host ?? n.ip) ? `${altEsc(n.host ?? n.ip)}` : ""}
                ${n.version ? ` · v${altEsc(n.version)}` : ""}
                ${n.platform ? ` · ${altEsc(n.platform)}` : ""}
              </div>
              ${caps.length ? `<div style="margin-top:4px;display:flex;gap:3px;flex-wrap:wrap">${caps.map((c: string) => `<span style="padding:1px 5px;border-radius:2px;font-size:8px;background:var(--surface2);color:var(--muted)">${altEsc(c)}</span>`).join("")}</div>` : ""}
              ${n.lastPingAt ? `<div style="font-size:9px;color:var(--muted);margin-top:3px">Last ping: ${altRelTime(n.lastPingAt)}</div>` : ""}
            </div>`;
            })
            .join("")}
        </div>
      </div>`
          : `<div class="alt-placeholder"><span>No exec nodes connected</span></div>`
      }`;

    // Wire device approve/reject buttons (delegated, no inline onclick)
    body.querySelectorAll(".alt-device-approve").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await req("device.pair.approve", {
          requestId: (btn as HTMLElement).dataset.requestId!,
        }).catch(() => {});
        renderAltView("nodes");
      });
    });
    body.querySelectorAll(".alt-device-reject").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await req("device.pair.reject", {
          requestId: (btn as HTMLElement).dataset.requestId!,
        }).catch(() => {});
        renderAltView("nodes");
      });
    });
  }

  // ═══════════════ CONFIG ═══════════════
  async function renderConfigTab(body: Element, sub: Element) {
    const [configRes, schemaRes, modelsRes] = await Promise.all([
      req("config.get", {}).catch(() => null),
      req("config.schema", {}).catch(() => null),
      req("models.list", {}).catch(() => null),
    ]);
    const cfg = configRes as unknown;
    const schema = schemaRes as unknown;
    const models: unknown[] = (modelsRes as unknown)?.models ?? [];
    const valid = cfg?.valid !== false;
    const issues: unknown[] = cfg?.issues ?? [];
    const configObj =
      cfg?.config ?? cfg?.parsed ?? (typeof cfg?.raw === "string" ? null : cfg?.raw) ?? {};
    const sections = Object.keys(configObj).filter(
      (k) => typeof configObj[k] === "object" && configObj[k] !== null,
    );
    sub.textContent = `${valid ? "Valid" : "INVALID"} · ${models.length} model(s) · ${sections.length} section(s)${schema?.version ? ` · schema v${schema.version}` : ""}`;

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div class="alt-card"><h3>Status</h3>
          ${altRow("Valid", valid ? "Yes" : "No", valid ? "green" : "red")}
          ${altRow("Path", `<span style="font-family:'SF Mono',monospace;font-size:9px">${altEsc(cfg?.path ?? "—")}</span>`)}
          ${altRow("Hash", `<span style="font-family:'SF Mono',monospace;font-size:9px">${altEsc(cfg?.hash?.slice(0, 16) ?? "—")}</span>`)}
          ${schema?.version ? altRow("Schema", `v${altEsc(schema.version)}`) : ""}
          ${altRow("Sections", String(sections.length))}
          ${issues.length ? altRow("Issues", `${issues.length}`, "yellow") : ""}
        </div>
        <div class="alt-card"><h3>Models (${models.length})</h3>
          ${
            models.length
              ? models
                  .map((m: unknown) => {
                    const name = typeof m === "string" ? m : (m.id ?? m.name ?? m.model ?? "?");
                    const provider = typeof m === "object" ? (m.provider ?? "") : "";
                    return `<div class="row">
              <span class="label">${altEsc(name)}</span>
              <span class="value green">${provider ? altEsc(provider) : "configured"}</span>
            </div>`;
                  })
                  .join("")
              : altRow("—", "No models")
          }
        </div>
        <div class="alt-card"><h3>Actions</h3>
          <div style="display:flex;flex-direction:column;gap:6px">
            <button class="alt-config-action" data-action="apply" style="background:var(--accent);color:var(--bg);border:none;border-radius:4px;padding:6px 12px;font-size:11px;cursor:pointer;text-align:left">Apply Config <span style="font-size:9px;opacity:.7">— reload without restart</span></button>
            <button class="alt-config-action" data-action="export" style="background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:6px 12px;font-size:11px;cursor:pointer;text-align:left">Export JSON</button>
          </div>
        </div>
      </div>

      ${
        issues.length
          ? `<div class="alt-card" style="border-color:var(--yellow)"><h3>Validation Issues (${issues.length})</h3>
        ${issues
          .map((i: unknown) => {
            const msg = typeof i === "string" ? i : (i.message ?? "");
            const path = typeof i === "object" ? (i.path ?? i.schemaPath ?? "") : "";
            return `<div style="background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.2);border-radius:4px;padding:4px 8px;margin-bottom:3px;font-size:10px">
            <span style="color:var(--yellow)">${altEsc(msg || JSON.stringify(i))}</span>
            ${path ? `<span style="color:var(--muted);font-family:'SF Mono',monospace;font-size:9px;margin-left:6px">${altEsc(path)}</span>` : ""}
          </div>`;
          })
          .join("")}
      </div>`
          : ""
      }

      ${
        sections.length
          ? `<div class="alt-card"><h3>Sections</h3>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">
          ${sections.map((s) => `<button class="alt-config-section" data-section="${altEsc(s)}" style="background:var(--surface2);border:1px solid var(--border);color:var(--accent);border-radius:3px;padding:3px 8px;font-size:10px;cursor:pointer">${altEsc(s)}</button>`).join("")}
        </div>
        <div id="alt-config-section-view"></div>
      </div>`
          : ""
      }

      <div class="alt-card"><h3>Full Config</h3>
        <pre id="alt-config-raw" style="white-space:pre-wrap;word-break:break-all;font-size:10px;color:var(--muted);max-height:500px;overflow-y:auto;margin:0;line-height:1.5">${altEsc(JSON.stringify(configObj, null, 2))}</pre>
      </div>`;

    // Wire section buttons
    body.querySelectorAll(".alt-config-section").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = (btn as HTMLElement).dataset.section!;
        const view = document.getElementById("alt-config-section-view");
        if (!view) {
          return;
        }
        const sectionData = configObj[key];
        view.innerHTML = `<div style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:20px 10px">
          <div style="font-size:11px;font-weight:600;color:var(--accent);margin-bottom:6px">${altEsc(key)}</div>
          <pre style="white-space:pre-wrap;word-break:break-all;font-size:10px;color:var(--text);margin:0;max-height:300px;overflow-y:auto">${altEsc(JSON.stringify(sectionData, null, 2))}</pre>
        </div>`;
        // Highlight active section button
        body.querySelectorAll(".alt-config-section").forEach((b) => {
          (b as HTMLElement).style.background =
            (b as HTMLElement).dataset.section === key ? "var(--accent)" : "var(--surface2)";
          (b as HTMLElement).style.color =
            (b as HTMLElement).dataset.section === key ? "var(--bg)" : "var(--accent)";
        });
      });
    });
    // Wire action buttons
    body.querySelectorAll(".alt-config-action").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = (btn as HTMLElement).dataset.action;
        if (action === "apply") {
          try {
            await req("config.apply", {});
            (btn as HTMLElement).textContent = "Applied!";
            setTimeout(() => renderAltView("config"), 1500);
          } catch (e) {
            (btn as HTMLElement).textContent = `Error: ${(e as Error).message}`;
          }
        } else if (action === "export") {
          const blob = new Blob([JSON.stringify(configObj, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `openclaw-config-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
        }
      });
    });
  }

  // ═══════════════ DEBUG ═══════════════
  const debugRpcHistory: {
    method: string;
    params: unknown;
    result: unknown;
    ts: number;
    error?: string;
  }[] = [];

  async function renderDebugTab(body: Element, sub: Element) {
    const [status, health, heartbeat, modelsRes] = await Promise.all([
      req("status", {}).catch(() => null),
      req("health", {}).catch(() => null),
      req("last-heartbeat", {}).catch(() => null),
      req("models.list", {}).catch(() => null),
    ]);
    sub.textContent = `Snapshots & RPC console · ${debugRpcHistory.length} call(s) in history`;
    (window as unknown).__tinkerReq = req;

    // Quick-call presets
    const presets = [
      "status",
      "health",
      "channels.status",
      "sessions.list",
      "cron.status",
      "agents.list",
      "skills.status",
      "models.list",
      "logs.tail",
      "last-heartbeat",
      "usage.cost",
      "config.get",
    ];

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <div class="alt-card"><h3>Local State</h3>
            ${altRow("WebSocket", connected ? "Connected" : "Disconnected", connected ? "green" : "red")}
            ${altRow("Gateway", altEsc(GW_WS || "—"))}
            ${altRow("Session key", `<span style="font-family:'SF Mono',monospace;font-size:9px">${altEsc(sessionKey || "—")}</span>`)}
            ${altRow("Messages loaded", String(messages.length))}
            ${altRow("Active runs", String(activeRuns.size))}
            ${altRow("Stream active", streamRunId ? `Yes (${altEsc(streamRunId.slice(0, 12))})` : "No", streamRunId ? "green" : "")}
            ${altRow("Active tab", activeTab)}
          </div>
          <div class="alt-card" style="max-height:280px;overflow-y:auto"><h3>Status</h3>${altJson(status)}</div>
          <div class="alt-card" style="max-height:280px;overflow-y:auto"><h3>Health</h3>${altJson(health)}</div>
          <div class="alt-card" style="max-height:200px;overflow-y:auto"><h3>Last Heartbeat</h3>${altJson(heartbeat)}</div>
          <div class="alt-card" style="max-height:200px;overflow-y:auto"><h3>Models</h3>${altJson(modelsRes)}</div>
        </div>
        <div>
          <div class="alt-card"><h3>RPC Console</h3>
            <div style="margin-bottom:6px;display:flex;gap:3px;flex-wrap:wrap">
              ${presets.map((p) => `<button class="alt-debug-preset" data-method="${p}" style="background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:3px;padding:1px 6px;font-size:9px;cursor:pointer">${p}</button>`).join("")}
            </div>
            <div style="margin-bottom:6px">
              <input id="alt-debug-method" type="text" placeholder="method (e.g. status)" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px;font-family:'SF Mono',monospace">
            </div>
            <div style="margin-bottom:6px">
              <textarea id="alt-debug-params" rows="3" placeholder='{"key": "value"}' style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px;font-family:'SF Mono',monospace;resize:vertical"></textarea>
            </div>
            <button id="alt-debug-call" style="background:var(--accent);color:var(--bg);border:none;border-radius:4px;padding:4px 14px;font-size:11px;cursor:pointer">Call</button>
            <button id="alt-debug-clear-history" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:4px 14px;font-size:11px;cursor:pointer;margin-left:6px">Clear history</button>
          </div>
          <div class="alt-card"><h3>Result</h3><div id="alt-debug-result" style="max-height:300px;overflow-y:auto"><span class="muted">—</span></div></div>
          ${
            debugRpcHistory.length
              ? `<div class="alt-card"><h3>RPC History (${debugRpcHistory.length})</h3>
            <div style="max-height:250px;overflow-y:auto">
              ${debugRpcHistory
                .slice()
                .toReversed()
                .map(
                  (
                    h,
                    i,
                  ) => `<div style="background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:4px 8px;margin-bottom:3px;font-size:10px;cursor:pointer" class="alt-debug-history-item" data-idx="${debugRpcHistory.length - 1 - i}">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <span style="color:var(--accent);font-family:'SF Mono',monospace">${altEsc(h.method)}</span>
                  <span style="color:${h.error ? "var(--red)" : "var(--green)"};font-size:9px">${h.error ? "ERR" : "OK"} · ${altRelTime(h.ts)}</span>
                </div>
              </div>`,
                )
                .join("")}
            </div>
          </div>`
              : ""
          }
        </div>
      </div>`;

    // Wire preset buttons
    body.querySelectorAll(".alt-debug-preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        const methodInput = document.getElementById("alt-debug-method") as HTMLInputElement;
        if (methodInput) {
          methodInput.value = (btn as HTMLElement).dataset.method ?? "";
        }
      });
    });
    // Wire history items to replay
    body.querySelectorAll(".alt-debug-history-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt((el as HTMLElement).dataset.idx ?? "0", 10);
        const entry = debugRpcHistory[idx];
        if (!entry) {
          return;
        }
        const methodInput = document.getElementById("alt-debug-method") as HTMLInputElement;
        const paramsInput = document.getElementById("alt-debug-params") as HTMLTextAreaElement;
        const resultEl = document.getElementById("alt-debug-result");
        if (methodInput) {
          methodInput.value = entry.method;
        }
        if (paramsInput) {
          paramsInput.value = JSON.stringify(entry.params, null, 2);
        }
        if (resultEl) {
          resultEl.innerHTML = entry.error
            ? `<span style="color:var(--red)">${altEsc(entry.error)}</span>`
            : altJson(entry.result);
        }
      });
    });
    // Wire clear history
    document.getElementById("alt-debug-clear-history")?.addEventListener("click", () => {
      debugRpcHistory.length = 0;
      renderAltView("debug");
    });
  }

  // ═══════════════ LOGS ═══════════════
  let logsLineCount = 0;

  async function renderLogsTab(body: Element, sub: Element) {
    sub.textContent = "Live gateway logs";
    logsCursor = undefined;
    logsLineCount = 0;
    body.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <input id="alt-logs-filter" type="text" placeholder="Filter text…" value="${altEsc(logsFilterText)}" style="flex:1;min-width:120px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px">
        ${["trace", "debug", "info", "warn", "error", "fatal"]
          .map(
            (lv) =>
              `<span data-level="${lv}" style="cursor:pointer;padding:2px 6px;border-radius:3px;font-size:10px;background:${logsLevelFilters.has(lv) ? "var(--surface2)" : "transparent"};color:${lv === "error" || lv === "fatal" ? "var(--red)" : lv === "warn" ? "var(--yellow)" : "var(--muted)"};border:1px solid var(--border)">${lv}</span>`,
          )
          .join("")}
        <label style="font-size:10px;color:var(--muted);display:flex;align-items:center;gap:4px">
          <input type="checkbox" id="alt-logs-follow" ${logsAutoFollow ? "checked" : ""}> Auto-follow
        </label>
        <button id="alt-logs-export" style="background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer">Export</button>
        <button id="alt-logs-clear" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer">Clear</button>
        <span id="alt-logs-count" style="font-size:9px;color:var(--muted)">0 lines</span>
      </div>
      <div id="alt-logs-stream" class="alt-card" style="font-family:'SF Mono',monospace;font-size:10px;max-height:calc(100vh - 200px);overflow-y:auto;padding:6px 10px;line-height:1.6">
        <span class="muted">Loading logs…</span>
      </div>`;
    // Wire filter controls
    const filterInput = document.getElementById("alt-logs-filter") as HTMLInputElement;
    filterInput?.addEventListener("input", () => {
      logsFilterText = filterInput.value;
    });
    const followCheck = document.getElementById("alt-logs-follow") as HTMLInputElement;
    followCheck?.addEventListener("change", () => {
      logsAutoFollow = followCheck.checked;
    });
    // Level filter toggles
    body.querySelectorAll("[data-level]").forEach((el) => {
      el.addEventListener("click", () => {
        const lv = (el as HTMLElement).dataset.level!;
        if (logsLevelFilters.has(lv)) {
          logsLevelFilters.delete(lv);
        } else {
          logsLevelFilters.add(lv);
        }
        (el as HTMLElement).style.background = logsLevelFilters.has(lv)
          ? "var(--surface2)"
          : "transparent";
      });
    });
    // Export logs
    document.getElementById("alt-logs-export")?.addEventListener("click", () => {
      const stream = document.getElementById("alt-logs-stream");
      if (!stream) {
        return;
      }
      const text = stream.innerText;
      const blob = new Blob([text], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `openclaw-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    // Clear logs
    document.getElementById("alt-logs-clear")?.addEventListener("click", () => {
      const stream = document.getElementById("alt-logs-stream");
      if (stream) {
        stream.innerHTML = `<span class="muted">Cleared. Waiting for new logs…</span>`;
        logsLineCount = 0;
      }
      const counter = document.getElementById("alt-logs-count");
      if (counter) {
        counter.textContent = "0 lines";
      }
    });
    // Initial fetch + polling
    await fetchLogs();
    logsInterval = setInterval(fetchLogs, 3000);
  }

  async function fetchLogs() {
    const stream = document.getElementById("alt-logs-stream");
    if (!stream || activeTab !== "logs") {
      if (logsInterval) {
        clearInterval(logsInterval);
        logsInterval = null;
      }
      return;
    }
    const res = (await req("logs.tail", { cursor: logsCursor, limit: 200, maxBytes: 64_000 }).catch(
      () => null,
    )) as unknown;
    if (!res?.lines?.length) {
      if (!logsCursor) {
        stream.innerHTML = `<span class="muted">No logs available</span>`;
      }
      return;
    }
    logsCursor = res.cursor;
    const filtered = res.lines.filter((line: string) => {
      if (logsFilterText && !line.toLowerCase().includes(logsFilterText.toLowerCase())) {
        return false;
      }
      const lvMatch = line.match(/\b(trace|debug|info|warn|error|fatal)\b/i);
      if (lvMatch && !logsLevelFilters.has(lvMatch[1].toLowerCase())) {
        return false;
      }
      return true;
    });
    if (!filtered.length) {
      return;
    }
    const levelColors: Record<string, string> = {
      error: "var(--red)",
      fatal: "var(--red)",
      warn: "var(--yellow)",
      info: "var(--green)",
      debug: "var(--muted)",
      trace: "var(--muted)",
    };
    // Structured log parsing: try to extract time, level, subsystem, message
    const html = filtered
      .map((line: string) => {
        const lvMatch = line.match(/\b(trace|debug|info|warn|error|fatal)\b/i);
        const color = lvMatch
          ? (levelColors[lvMatch[1].toLowerCase()] ?? "var(--text)")
          : "var(--text)";
        // Try structured parse: [TIME] LEVEL [SUBSYS] message
        const structured = line.match(
          /^\[?(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]?\s+(trace|debug|info|warn|error|fatal)\s+\[([^\]]+)\]\s+(.*)/i,
        );
        if (structured) {
          const [, time, lv, sys, msg] = structured;
          const lvColor = levelColors[lv.toLowerCase()] ?? color;
          return `<div style="display:flex;gap:8px"><span style="color:var(--muted);flex-shrink:0;width:70px">${altEsc(time)}</span><span style="color:${lvColor};flex-shrink:0;width:40px;text-transform:uppercase;font-size:9px">${altEsc(lv)}</span><span style="color:var(--accent);flex-shrink:0;width:90px;overflow:hidden;text-overflow:ellipsis">${altEsc(sys)}</span><span style="color:${color};flex:1">${altEsc(msg)}</span></div>`;
        }
        return `<div style="color:${color}">${altEsc(line)}</div>`;
      })
      .join("");
    logsLineCount += filtered.length;
    const isFirstLoad =
      stream.innerHTML.includes("Loading logs") ||
      stream.innerHTML.includes("No logs") ||
      stream.innerHTML.includes("Cleared");
    if (isFirstLoad) {
      stream.innerHTML = html;
    } else {
      stream.insertAdjacentHTML("beforeend", html);
      // Cap DOM nodes to prevent memory leak
      while (stream.children.length > 2000) {
        stream.removeChild(stream.firstChild!);
      }
    }
    // Update line counter
    const counter = document.getElementById("alt-logs-count");
    if (counter) {
      counter.textContent = `${logsLineCount} lines`;
    }
    if (logsAutoFollow) {
      stream.scrollTop = stream.scrollHeight;
    }
  }

  // Delegated click handler for sidebar nav buttons
  document.querySelector(".sidebar")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".nav-btn[data-tab]") as HTMLElement | null;
    if (!btn) {
      return;
    }
    const tab = btn.dataset.tab!;
    switchTab(tab);
  });

  // FORK 2026-05-30: the RECIPES panel header doubles as a button into the book.
  document
    .getElementById("recipes-book-btn")
    ?.addEventListener("click", () => switchTab("recipes"));

  $("new-session-btn")!.addEventListener("click", async () => {
    if (!connected) {
      return;
    }

    const tab = tabs.find((t) => t.id === activeTabId);

    messages.length = 0;
    streamMsgIdx = -1;
    lastDeltaLen = 0;
    lastDeltaAt = 0;
    streamRunId = null;
    sending = false;
    if (sessionKey) {
      clearPersistedErrors(sessionKey);
    }
    updateChat();
    updateBtn();

    if (activeRuns.size > 0 || pendingRunDeletes.size > 0) {
      await abort();
    }

    // FORK: /new resets the current tab in place — never switches to main.
    // FORK (2026-04-27): on non-main tabs, also reset the OLD tinker:* session
    // server-side before rotating the local key. Symmetric with /clear: the
    // gateway archives the transcript (soft-delete) and fires the full
    // command:new plugin lifecycle on the previous session, instead of
    // orphaning it on disk. The tab still rotates to a fresh tinker:<ts>
    // afterward so the BRIEFING.md prelude lands on a clean key.
    if (tab && tab.id !== "tab-main") {
      const oldKey = sessionKey;
      if (oldKey && oldKey.startsWith("tinker:")) {
        req("sessions.reset", { key: oldKey, reason: "new" }).catch(() => {});
        // FORK 2026-05-26 — symmetric with /clear: abandon any
        // in_progress plan on the OLD sessionKey so restart-continue
        // can't auto-fire on it after a future gateway restart.
        req("prefrontal.plan.close", {
          sessionKey: oldKey,
          status: "abandoned",
          note: "Closed by /new — user rotated to a fresh session.",
        }).catch(() => {});
      }
      const newKey = `tinker:${Date.now().toString(36)}`;
      tab.sessionKey = newKey;
      tab.isAttached = true;
      sessionKey = newKey;
      // FORK 2026-05-25 — bug task-mpjhzu3j-ma9ts: deterministic phrase
      // by sessionKey hash. Same picker as createTab() and the
      // server-side lazy-mint (src/shared/fortune-cookies.ts:
      // fortuneForKey), so tab.title and the eventual cookiePhrase for
      // this new key converge automatically — the panel row won't flip
      // phrase when this tab is closed.
      tab.title = fortuneForKey(newKey);
      tabStates.set(tab.id, freshTabState());
      loadTabState(tab.id);
      saveTabs();
      renderTabs();
      updateSessionsPanel();
    }
    send("/new");
  });

  // ═══════════════ RECIPES ═══════════════
  const RECIPE_CATEGORIES = {
    coding: { label: "Coding", color: "#6b8e23", icon: "\u2328\uFE0F" },
    writing: { label: "Writing & Research", color: "#8b5cf6", icon: "\uD83D\uDCDD" },
    operations: { label: "Operations", color: "#f59e0b", icon: "\u2699\uFE0F" },
    analysis: { label: "Analysis", color: "#3b82f6", icon: "\uD83D\uDD0D" },
    security: { label: "Security", color: "#ef4444", icon: "\uD83D\uDEE1\uFE0F" },
    communication: { label: "Communication", color: "#10b981", icon: "\uD83D\uDCAC" },
  } as const;

  // FORK 2026-05-14 — RECIPE_CATALOG deleted. Kit data comes exclusively from
  // prefrontal.kit.list (which parses kit.md on disk for both source-tree and
  // downloaded kits). See TINKER_UI_DESIGN_BIBLE/subagents-and-kits.md for the
  // canonical translation contract.

  // FORK 2026-05-14 — Recipes tab is kit.md-only. Single data shape from
  // prefrontal.kit.list. No RECIPE_CATALOG. No two-path render logic.
  // FORK 2026-06-07 (Amygdala feedback loop / M−1.A): show exactly what the
  // AMYGDALA gate does — live prudence decisions + the current personality nudge.
  async function renderAmygdalaTab(body: Element, sub: Element) {
    type AmygdalaDecision = {
      ts: string;
      tool: string;
      target: string;
      decision: string;
      blocked: boolean;
      enforced: boolean;
      reason?: string;
      mode: string;
      prudence?: number;
      disagreement?: number;
    };
    type AmygdalaFeed = {
      ready: boolean;
      mode: string;
      onnxAvailable: boolean;
      observeOnly: boolean;
      phase: number;
      alphas: { prudence: number; personality: number };
      nudge?: { adjustments?: string[]; strength?: number } | null;
      decisions: AmygdalaDecision[];
      counts: { total: number; flagged: number; enforced: number };
    };
    let feed: AmygdalaFeed;
    try {
      // Race a timeout so a missing/unregistered RPC degrades gracefully instead
      // of hanging the panel on "Loading…" forever.
      feed = await Promise.race([
        req<AmygdalaFeed>("amygdala.feed", {}),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
      ]);
    } catch {
      sub.textContent = "amygdala";
      body.innerHTML = `<div class="alt-placeholder"><span style="color:var(--muted)">AMYGDALA feed unavailable — the <code>amygdala.feed</code> gateway method isn't responding. The learned-intuition plugin may need a rebuild + gateway restart.</span></div>`;
      return;
    }
    const f = feed;
    sub.textContent = `${f.counts.total} decisions · ${f.counts.flagged} flagged · ${f.counts.enforced} enforced`;
    const col = (d: AmygdalaDecision) =>
      d.enforced || d.decision === "hard_block"
        ? "var(--red)"
        : d.decision === "soft_block"
          ? "#f59e0b"
          : "#4ade80";
    const verb = (d: AmygdalaDecision) =>
      d.enforced
        ? "BLOCKED"
        : d.decision === "hard_block"
          ? "would hard-block"
          : d.decision === "soft_block"
            ? "would soft-block"
            : "allowed";
    const pill = (s: string, border = "var(--border, #333)") =>
      `<span style="border:1px solid ${border};border-radius:10px;padding:1px 8px;font-size:11px;white-space:nowrap">${s}</span>`;
    const nudge = (f.nudge?.adjustments ?? [])
      .map(
        (a) =>
          `<div style="font-size:12px;color:var(--fg,#ddd);padding:4px 0;border-top:1px solid var(--border,#222)">${altEsc(a)}</div>`,
      )
      .join("");
    const rows = f.decisions.length
      ? f.decisions
          .map(
            (d) => `
          <div style="border-left:3px solid ${col(d)};padding:6px 10px;margin:4px 0;background:rgba(255,255,255,0.02)">
            <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:12px">
              <b style="color:${col(d)}">${verb(d)}</b>
              <span style="font-family:monospace">${altEsc(d.tool)}</span>
              <span style="font-family:monospace;color:var(--muted)">${altEsc(d.target)}</span>
              <span style="color:var(--muted);font-size:11px">${altEsc(d.mode)}${typeof d.prudence === "number" ? ` · p=${d.prudence.toFixed(2)}` : ""}${typeof d.disagreement === "number" ? ` · Δ=${d.disagreement.toFixed(2)}` : ""}</span>
              <span style="margin-left:auto;color:var(--muted);font-size:11px">${altEsc(new Date(d.ts).toLocaleTimeString())}</span>
            </div>
            ${d.reason ? `<div style="font-size:12px;color:var(--muted);margin-top:3px">${altEsc(d.reason)}</div>` : ""}
          </div>`,
          )
          .join("")
      : `<div class="alt-placeholder"><span style="color:var(--muted)">No gate decisions yet this session — AMYGDALA records the next tool call here.</span></div>`;
    body.innerHTML = `
      <div style="padding:10px 14px">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
          ${pill(`mode: <b>${altEsc(f.mode)}</b>${f.onnxAvailable ? "" : " (rule fallback)"}`, f.onnxAvailable ? "#4ade80" : "#f59e0b")}
          ${pill(`phase ${f.phase}`)}
          ${pill(f.observeOnly ? "observe-only" : "ENFORCING", f.observeOnly ? "var(--border, #333)" : "var(--red)")}
          ${pill(`α prudence ${f.alphas.prudence}`)}
          ${pill(`α personality ${f.alphas.personality}`)}
        </div>
        ${nudge ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:6px 0">Personality nudge${typeof f.nudge?.strength === "number" ? ` · strength ${f.nudge.strength}` : ""}</div>${nudge}` : ""}
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:12px 0 6px">Prudence decisions (most recent first)</div>
        ${rows}
      </div>`;
  }

  async function renderRecipesTab(body: Element, sub: Element) {
    // ── Normalized kit type — single shape for ours + downloaded ──
    type NormalizedKit = {
      kitRef: string;
      owner: string;
      slug: string;
      title: string;
      summary: string;
      tags: string[];
      category: string;
      source: "ours" | "downloaded";
      path: string;
    };

    // ── Fetch all kits from prefrontal.kit.list (non-blocking) ──
    let allKits: NormalizedKit[] = [];
    let listErr = false;
    try {
      const res = await req<{ kits: NormalizedKit[] }>("prefrontal.recipe.list", {});
      allKits = res.kits ?? [];
      // FORK 2026-06-06 — stash the fetched kits for the recipe-detail page's
      // graceful-degradation fallback (used when prefrontal.recipe.read is not
      // yet deployed on this gateway).
      lastRecipeList = allKits;
    } catch {
      listErr = true;
    }

    sub.textContent = `${allKits.length} recipes`;

    // ── Build grouped map by category ──
    const grouped = new Map<string, NormalizedKit[]>();
    for (const k of allKits) {
      const cat = k.category || "operations";
      const list = grouped.get(cat) ?? [];
      list.push(k);
      grouped.set(cat, list);
    }

    // Helper: title-case a slug (e.g. "gateway-restart" → "Gateway Restart")
    function slugToTitle(slug: string): string {
      return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // Helper: render a single kit card HTML string.
    function recipeCardHtml(kit: NormalizedKit): string {
      const displayName = kit.title?.trim() || slugToTitle(kit.slug);
      const displayTrigger = kit.slug;
      const hasSummary = !!kit.summary?.trim();
      const isDownloaded = kit.source === "downloaded";
      let h = `<div class="recipe-card" data-recipe-file="${altEsc(kit.path)}" title="Click to view kit details">`;
      h += `<div class="recipe-card-header">`;
      // FORK 2026-06-06 — BROCA recipe visibility: the recipe name is now a
      // clickable .broca-recipe-link carrying data-recipe-ref=<slug>, which the
      // delegated [data-recipe-ref] listener routes to the recipe-detail page.
      // The card keeps its data-recipe-file attribute for openKitModal back-compat.
      h += `<a class="broca-recipe-link" data-recipe-ref="${altEsc(kit.slug)}">${altEsc(displayName)}</a>`;
      if (isDownloaded) {
        h += `<span class="recipe-kit-external" title="Downloaded recipe">↗</span>`;
      }
      h += `<span class="recipe-trigger">${altEsc(displayTrigger)}</span>`;
      h += `</div>`;
      if (hasSummary) {
        h += `<div class="recipe-summary">${altEsc(kit.summary.trim())}</div>`;
      } else {
        h += `<div class="recipe-summary-placeholder">(no summary in recipe)</div>`;
      }
      h += `</div>`;
      return h;
    }

    // ── Render function — called on load and on search input ──
    function applyFilter(q: string) {
      const ql = q.toLowerCase().trim();

      let html = '<div class="recipes-view">';

      if (listErr) {
        html += `<div class="recipe-no-results" style="color:#f59e0b;margin-bottom:6px">prefrontal.kit.list unavailable — kits not shown</div>`;
      }

      let totalVisible = 0;
      for (const [catKey, cat] of Object.entries(RECIPE_CATEGORIES)) {
        const allInCat = grouped.get(catKey) ?? [];
        const items = allInCat.filter((k) => {
          if (!ql) return true;
          return (
            k.title.toLowerCase().includes(ql) ||
            k.slug.toLowerCase().includes(ql) ||
            k.summary.toLowerCase().includes(ql) ||
            k.tags.some((t) => t.toLowerCase().includes(ql))
          );
        });
        if (!items.length) continue;
        totalVisible += items.length;
        html += `<div class="recipe-category" style="--cat-color:${cat.color}">`;
        html += `<div class="recipe-cat-header">`;
        html += `<span class="recipe-cat-icon">${cat.icon}</span>`;
        html += `<span class="recipe-cat-label">${cat.label}</span>`;
        html += `<span class="recipe-cat-count">${items.length}</span>`;
        html += `</div><div class="recipe-cat-items">`;
        for (const kit of items) {
          html += recipeCardHtml(kit);
        }
        html += `</div></div>`;
      }
      if (totalVisible === 0 && ql) {
        html += `<div class="recipe-no-results">No recipes match "${altEsc(ql)}"</div>`;
      }

      html += `</div>`;

      // Preserve search input across filter updates
      const existingSearch = body.querySelector(".recipe-search-input") as HTMLInputElement | null;
      if (!existingSearch) {
        const searchRow = `<div class="recipe-search-row"><input class="recipe-search-input" type="search" placeholder="Search recipes by name, slug, tags…" value="${altEsc(q)}" autocomplete="off" spellcheck="false"><button class="recipe-new-btn" title="Compose a new recipe (scaffold + edit)">+ New recipe</button></div>`;
        body.innerHTML = searchRow + html;
      } else {
        const viewEl = body.querySelector(".recipes-view");
        if (viewEl) {
          viewEl.outerHTML = html;
        } else {
          const searchRowEl = body.querySelector(".recipe-search-row");
          if (searchRowEl) {
            const tmp = document.createElement("div");
            tmp.innerHTML = html;
            searchRowEl.after(tmp.firstElementChild!);
          }
        }
      }
    }

    // Initial render
    applyFilter("");

    // Wire search input (delegated from body — survives innerHTML replacement)
    body.addEventListener("input", (e) => {
      const inp = e.target as HTMLElement;
      if (inp.classList.contains("recipe-search-input")) {
        applyFilter((inp as HTMLInputElement).value);
      }
    });

    // FORK 2026-05-29: "New recipe" — scaffold a kit via prefrontal.kit.author,
    // then open it in the editor. Same authoring path Jarvis uses on the fly.
    body.addEventListener("click", async (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".recipe-new-btn")) return;
      const slug = `draft-${Date.now().toString(36).slice(-5)}`;
      try {
        const res = await req<{ ok: boolean; path: string; kitRef: string }>(
          "prefrontal.recipe.author",
          {
            slug,
            title: "Untitled recipe",
            summary: "Describe what this recipe does (edit me).",
            tags: ["draft"],
            category: "operations",
            steps: [
              {
                title: "First step",
                tools: ["read"],
                doneWhen: "TODO: success criterion",
                body: "Describe what to do in this step.",
              },
            ],
          },
        );
        if (res?.path) {
          const nk: NormalizedKit = {
            kitRef: res.kitRef,
            owner: "globalcaos",
            slug,
            title: "Untitled recipe",
            summary: "Describe what this recipe does (edit me).",
            tags: ["draft"],
            category: "operations",
            source: "ours",
            path: res.path,
          };
          allKits.push(nk);
          grouped.set("operations", [...(grouped.get("operations") ?? []), nk]);
          applyFilter("");
          void openKitModal(res.path);
        }
      } catch (err) {
        console.error("[recipes] new-recipe author failed", err);
      }
    });

    // ── Kit detail modal ──
    // Opens on recipe card click instead of xdg-open.
    // Uses the /api/kit-content endpoint (Vite dev plugin) or /tinker/api/kit-content (prod).

    let activeKitModal: HTMLElement | null = null;

    function closeKitModal(): void {
      activeKitModal?.remove();
      activeKitModal = null;
    }

    /** Strip YAML frontmatter from kit.md content and return body only. */
    function kitBodyOnly(raw: string): string {
      const m = /^---\n[\s\S]+?\n---\n?/.exec(raw);
      return m ? raw.slice(m[0].length).trimStart() : raw;
    }

    /** Extract a single-line frontmatter field. */
    function fmField(raw: string, key: string): string {
      const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(raw);
      if (!m) return "";
      return m[1].trim().replace(/^['"]|['"]$/g, "");
    }

    /** Extract multi-line folded block scalar frontmatter field (summary: >-). */
    function fmSummary(raw: string): string {
      // Try single-line first
      const single = fmField(raw, "summary");
      if (single && !single.startsWith(">")) return single;
      // Try folded block scalar
      const fmBlock = /^---\n([\s\S]+?)\n---/.exec(raw);
      if (!fmBlock) return "";
      const block = fmBlock[1];
      const blockM = /^summary:\s*>\-?\n((?:[ \t]+.+\n?)+)/m.exec(block);
      if (blockM)
        return blockM[1]
          .replace(/^[ \t]+/gm, "")
          .replace(/\n/g, " ")
          .trim();
      return "";
    }

    async function openKitModal(filePath: string): Promise<void> {
      closeKitModal();

      const backdrop = document.createElement("div");
      backdrop.className = "kit-modal-backdrop";
      backdrop.innerHTML = `
        <div class="kit-modal-dialog" role="dialog" aria-label="Kit details">
          <div class="kit-modal-header">
            <div class="kit-modal-title-block">
              <div class="kit-modal-title">Loading…</div>
              <div class="kit-modal-summary"></div>
            </div>
            <button class="kit-modal-close" title="Close (Esc)">✕</button>
          </div>
          <div class="kit-modal-tabs">
            <button class="kit-modal-tab active" data-tab="view">View</button>
            <button class="kit-modal-tab" data-tab="edit">Edit</button>
          </div>
          <div class="kit-modal-body">
            <div class="kit-modal-view"><em style="color:#6b5a48">Loading…</em></div>
            <div class="kit-modal-raw">
              <textarea class="kit-modal-textarea" spellcheck="false"></textarea>
            </div>
          </div>
          <div class="kit-modal-footer">
            <span class="kit-modal-error"></span>
            <button class="kit-modal-btn" data-action="cancel">Cancel</button>
            <button class="kit-modal-btn primary" data-action="save">Save</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);
      activeKitModal = backdrop;

      const dlg = backdrop.querySelector<HTMLElement>(".kit-modal-dialog")!;
      const titleEl = dlg.querySelector<HTMLElement>(".kit-modal-title")!;
      const summaryEl = dlg.querySelector<HTMLElement>(".kit-modal-summary")!;
      const viewEl = dlg.querySelector<HTMLElement>(".kit-modal-view")!;
      const rawEl = dlg.querySelector<HTMLElement>(".kit-modal-raw")!;
      const textarea = dlg.querySelector<HTMLTextAreaElement>(".kit-modal-textarea")!;
      const errorEl = dlg.querySelector<HTMLElement>(".kit-modal-error")!;
      const saveBtn = dlg.querySelector<HTMLButtonElement>('[data-action="save"]')!;

      let currentTab = "view";
      let isDownloaded = false;
      let originalContent = "";
      let resolvedPath = filePath;

      // Fetch kit content
      const apiUrl = `/api/kit-content?path=${encodeURIComponent(filePath)}`;
      try {
        const resp = await fetch(apiUrl);
        if (!resp.ok) {
          const err = (await resp.json().catch(() => ({ error: resp.statusText }))) as {
            error?: string;
          };
          throw new Error(err.error ?? resp.statusText);
        }
        const data = (await resp.json()) as {
          path: string;
          content: string;
          isDownloaded: boolean;
        };
        resolvedPath = data.path;
        isDownloaded = data.isDownloaded;
        originalContent = data.content;
        textarea.value = data.content;

        // Parse frontmatter for display
        const title =
          fmField(data.content, "title") ||
          (() => {
            const slug = filePath.split("/").slice(-2, -1)[0] ?? "";
            return slugToTitle(slug);
          })();
        const summary = fmSummary(data.content);

        titleEl.textContent = title;
        summaryEl.textContent = summary || "";
        summaryEl.style.fontStyle = summary ? "" : "italic";
        summaryEl.style.color = summary ? "" : "#6b5a48";
        if (!summary) summaryEl.textContent = "(no summary in recipe)";

        // Render body via markdown-it
        const body = kitBodyOnly(data.content);
        viewEl.innerHTML = mdParser.render(body);

        // Warn chip for downloaded kits — shown only in edit tab
        if (isDownloaded) {
          const chip = document.createElement("div");
          chip.className = "kit-modal-warn-chip";
          chip.textContent =
            "⚠ Editing a downloaded recipe. Changes are local and will be overwritten if you reinstall.";
          rawEl.prepend(chip);
        }
      } catch (err) {
        titleEl.textContent = "Error loading recipe";
        viewEl.innerHTML = `<em style="color:#ef4444">${altEsc(String(err))}</em>`;
        saveBtn.disabled = true;
      }

      // Tab switching
      dlg.querySelectorAll<HTMLElement>(".kit-modal-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          currentTab = tab.dataset.tab!;
          dlg.querySelectorAll(".kit-modal-tab").forEach((t) => t.classList.remove("active"));
          tab.classList.add("active");
          if (currentTab === "view") {
            viewEl.style.display = "";
            rawEl.classList.remove("visible");
            saveBtn.textContent = "Save";
          } else {
            viewEl.style.display = "none";
            rawEl.classList.add("visible");
            saveBtn.textContent = "Save";
          }
        });
      });

      // Save
      saveBtn.addEventListener("click", async () => {
        errorEl.textContent = "";
        const content = textarea.value;
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        try {
          const resp = await fetch("/api/save-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: resolvedPath, content }),
          });
          const result = (await resp.json()) as { ok?: boolean; error?: string };
          if (!resp.ok || result.ok !== true) {
            throw new Error(result.error ?? `HTTP ${resp.status}`);
          }
          originalContent = content;
          // Re-parse title/summary in case they changed and refresh card display
          const newTitle = fmField(content, "title") || titleEl.textContent;
          const newSummary = fmSummary(content);
          titleEl.textContent = newTitle ?? "";
          summaryEl.textContent = newSummary || "(no summary in recipe)";
          // Re-render view pane
          viewEl.innerHTML = mdParser.render(kitBodyOnly(content));
          closeKitModal();
        } catch (err) {
          errorEl.textContent = `Save failed: ${String(err)}`;
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
        }
      });

      // Cancel / close
      const cancelHandler = (): void => closeKitModal();
      dlg.querySelector('[data-action="cancel"]')?.addEventListener("click", cancelHandler);
      dlg.querySelector(".kit-modal-close")?.addEventListener("click", cancelHandler);

      // Click outside dialog → close
      backdrop.addEventListener("click", (ev) => {
        if (ev.target === backdrop) closeKitModal();
      });

      // ESC to close
      const escHandler = (ev: KeyboardEvent): void => {
        if (ev.key === "Escape") {
          closeKitModal();
          document.removeEventListener("keydown", escHandler);
        }
      };
      document.addEventListener("keydown", escHandler);
    }

    // Click on a recipe card → open kit modal
    body.addEventListener("click", (e) => {
      const card = (e.target as HTMLElement).closest("[data-recipe-file]") as HTMLElement | null;
      if (!card) return;
      const file = card.dataset.recipeFile;
      if (!file) return;
      void openKitModal(file);
    });
  }

  // ═══════════════ RECIPE DETAIL (single-recipe page) ═══════════════
  // FORK 2026-06-06 — BROCA recipe visibility: dedicated single-recipe page.
  // Reached via switchTab("recipe-detail") after a .broca-recipe-link click sets
  // currentRecipeRef. Tries the server-of-truth prefrontal.recipe.read RPC and
  // renders the full interleaved BROCA program; if that RPC is unavailable (it is
  // NOT deployed on develop yet) or errors, it falls back to the metadata from
  // the last prefrontal.recipe.list result. It NEVER throws.
  async function renderRecipeDetail(body: Element, sub: Element) {
    const backLink = `<div class="recipe-detail-back" style="margin-bottom:12px"><a class="broca-recipe-link" data-recipe-back="1" style="cursor:pointer">← back to recipes</a></div>`;
    const wireBack = () => {
      body.querySelector("[data-recipe-back]")?.addEventListener("click", (ev) => {
        ev.preventDefault();
        switchTab("recipes");
      });
    };

    if (!currentRecipeRef) {
      sub.textContent = "no recipe selected";
      body.innerHTML = `${backLink}<div class="recipe-no-results">No recipe selected. Pick a recipe from the Recipes tab.</div>`;
      wireBack();
      return;
    }

    const ref = currentRecipeRef;
    sub.textContent = ref;

    // Build the metadata fallback (from the last recipe.list result) up front so
    // it is available whether recipe.read fails OR is undeployed.
    const fallbackKit = lastRecipeList.find((k) => k && k.slug === ref) as
      | {
          slug?: string;
          title?: string;
          summary?: string;
          category?: string;
          tags?: string[];
          triggers?: string[];
        }
      | undefined;

    function renderFallback(note: string): void {
      const title = fallbackKit?.title?.trim() || ref;
      const meta: string[] = [];
      if (fallbackKit?.category) meta.push(`Category: ${altEsc(fallbackKit.category)}`);
      if (fallbackKit?.tags?.length) meta.push(`Tags: ${altEsc(fallbackKit.tags.join(", "))}`);
      if (fallbackKit?.triggers?.length)
        meta.push(`Triggers: ${altEsc(fallbackKit.triggers.join(", "))}`);
      const summary = fallbackKit?.summary?.trim()
        ? `<div class="recipe-summary" style="margin:8px 0">${altEsc(fallbackKit.summary.trim())}</div>`
        : `<div class="recipe-summary-placeholder">(no summary)</div>`;
      body.innerHTML =
        backLink +
        `<div class="recipe-detail-header"><h3 style="margin:0 0 4px">${altEsc(title)}</h3>` +
        (meta.length
          ? `<div class="recipe-detail-meta muted" style="font-size:12px">${meta.join(" · ")}</div>`
          : "") +
        `</div>` +
        summary +
        `<div class="muted" style="font-size:11px;margin-top:10px">${altEsc(note)}</div>`;
      wireBack();
    }

    body.innerHTML = `${backLink}<div class="alt-placeholder"><span>Loading recipe…</span></div>`;

    let recipe: BrocaRecipe | null = null;
    try {
      const res = await req<{ recipe?: BrocaRecipe }>("prefrontal.recipe.read", { slug: ref });
      recipe = res?.recipe ?? null;
    } catch {
      recipe = null;
    }

    // recipe.read undeployed/errored OR returned nothing → metadata fallback.
    if (!recipe || !Array.isArray(recipe.steps)) {
      renderFallback("Full BROCA program loads once prefrontal.recipe.read is deployed.");
      return;
    }

    // Full render: header (title/category/triggers/lineage) + the BROCA program.
    const meta: string[] = [];
    if (recipe.category) meta.push(`Category: ${altEsc(recipe.category)}`);
    const triggers = (recipe as { triggers?: string[] }).triggers;
    if (triggers?.length) meta.push(`Triggers: ${altEsc(triggers.join(", "))}`);
    const lineage = recipe.lineage;
    const lineageBits: string[] = [];
    if (lineage?.composedFrom) lineageBits.push(`composed from ${altEsc(lineage.composedFrom)}`);
    if (lineage?.composedSkills?.length)
      lineageBits.push(`skills: ${altEsc(lineage.composedSkills.join(", "))}`);
    if (lineage?.composedRecipes?.length)
      lineageBits.push(`recipes: ${altEsc(lineage.composedRecipes.join(", "))}`);
    if (lineage?.sourceQuery) lineageBits.push(`from query: ${altEsc(lineage.sourceQuery)}`);

    body.innerHTML =
      backLink +
      `<div class="recipe-detail-header"><h3 style="margin:0 0 4px">${altEsc(recipe.title || ref)}</h3>` +
      (recipe.summary
        ? `<div class="recipe-summary" style="margin:4px 0 8px">${altEsc(recipe.summary)}</div>`
        : "") +
      (meta.length
        ? `<div class="recipe-detail-meta muted" style="font-size:12px">${meta.join(" · ")}</div>`
        : "") +
      (lineageBits.length
        ? `<div class="recipe-detail-lineage muted" style="font-size:11px;margin-top:4px">${lineageBits.join(" · ")}</div>`
        : "") +
      `</div>` +
      `<div class="recipe-detail-program" style="margin-top:12px">${renderBrocaProgram(recipe, { linkTitle: false })}</div>`;
    wireBack();
  }

  // ─── Tab bar events ───
  $("tab-bar-scroll")!.addEventListener("click", (e) => {
    const tgt = e.target as HTMLElement;

    const closeBtn = tgt.closest("[data-tab-close]") as HTMLElement | null;
    if (closeBtn) {
      e.stopPropagation();
      closeTab(closeBtn.dataset.tabClose!);
      return;
    }

    const tabEl = tgt.closest("[data-tab-id]") as HTMLElement | null;
    if (tabEl) {
      switchToTab(tabEl.dataset.tabId!);
    }
  });

  // Middle-click to close tab
  $("tab-bar-scroll")!.addEventListener("auxclick", (e) => {
    if (e.button !== 1) {
      return;
    } // middle button only
    e.preventDefault();
    const tabEl = (e.target as HTMLElement).closest("[data-tab-id]") as HTMLElement | null;
    if (tabEl) {
      closeTab(tabEl.dataset.tabId!);
    }
  });

  // FORK 2026-06-04 — task-mpzcjw6n-n45zs (Tab name summary): right-click a tab → rename / auto-name.
  $("tab-bar-scroll")!.addEventListener("contextmenu", (e) => {
    const tabEl = (e.target as HTMLElement).closest("[data-tab-id]") as HTMLElement | null;
    const tabId = tabEl?.dataset.tabId;
    if (!tabId || tabId === "tab-main") {
      return; // let the native menu show off the tab bar / on Main (Main has no rename)
    }
    e.preventDefault();
    openTabContextMenu(tabId, e.clientX, e.clientY);
  });
  // Dismiss the tab context menu on outside-click / Escape (mirrors the exec-task menu).
  document.addEventListener("click", (e) => {
    if (tabContextMenuEl && !tabContextMenuEl.contains(e.target as Node)) {
      closeTabContextMenu();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeTabContextMenu();
    }
  });

  $("tab-add")!.addEventListener("click", () => {
    const tab = createTab();
    renderTabs();
    switchToTab(tab.id);
    updateSessionsPanel();
  });

  $("tab-nav-left")!.addEventListener("click", () => {
    const scroll = $("tab-bar-scroll");
    if (scroll) {
      scroll.scrollBy({ left: -150, behavior: "smooth" });
    }
  });
  $("tab-nav-right")!.addEventListener("click", () => {
    const scroll = $("tab-bar-scroll");
    if (scroll) {
      scroll.scrollBy({ left: 150, behavior: "smooth" });
    }
  });

  $("tab-bar")!.addEventListener(
    "wheel",
    (e) => {
      const scroll = $("tab-bar-scroll");
      if (!scroll) {
        return;
      }
      e.preventDefault();
      scroll.scrollBy({ left: e.deltaY > 0 ? 80 : -80 });
      checkTabOverflow();
    },
    { passive: false },
  );

  window.addEventListener("resize", checkTabOverflow);

  // Delegated stop-button handler on messages container — survives innerHTML wipes
  $("messages")!.addEventListener("click", (e) => {
    const stop = (e.target as HTMLElement).closest(".thinking-stop");
    const run = (e.target as HTMLElement).closest(".thinking-run");
    if (stop && run) {
      abort();
    }
  });

  // Mount context treemap into bottom-right panel
  const tmCanvas = $("treemap-canvas")!;
  const tmFooter = $("treemap-footer")!;
  const brpMeta = $("brp-meta")!;
  mountContextTreemap(tmCanvas, tmFooter, brpMeta, req, () => sessionKey, brpMeta);

  // Mount response treemap into bottom-right panel
  const respCanvas = $("response-canvas")!;
  mountResponseTreemap(respCanvas, tmFooter, brpMeta, req, () => sessionKey, brpMeta);

  // Back buttons — siblings of canvas, survive innerHTML wipes
  const backCtx = $("brp-back-context");
  const backResp = $("brp-back-response");

  function updateBackButtons() {
    const ctxBack =
      !!(tmCanvas as unknown).__treemapCanGoBack?.() || !!(tmCanvas as unknown).__hasOverlay;
    const respBack =
      !!(respCanvas as unknown).__responseCanGoBack?.() || !!(respCanvas as unknown).__hasOverlay;
    if (backCtx) {
      backCtx.style.display = ctxBack ? "" : "none";
    }
    if (backResp) {
      backResp.style.display = respBack ? "" : "none";
    }

    // Check for scrollbars and adjust back button position to avoid overlap
    const checkScroll = (canvas: HTMLElement, viewId: string) => {
      const preview = canvas.querySelector(".tm-preview");
      const view = document.getElementById(viewId);
      if (preview && view) {
        if (preview.scrollHeight > preview.clientHeight) {
          view.classList.add("is-scrolling");
        } else {
          view.classList.remove("is-scrolling");
        }
      } else if (view) {
        view.classList.remove("is-scrolling");
      }
    };
    checkScroll(tmCanvas, "brp-view-context");
    checkScroll(respCanvas, "brp-view-response");
  }

  backCtx?.addEventListener("click", () => {
    if ((tmCanvas as unknown).__treemapCanGoBack?.()) {
      (tmCanvas as unknown).__treemapBack?.();
    } else {
      // We're in an overlay (auto-summary) — clear overlay and refresh back to L1 treemap
      (tmCanvas as unknown).__hasOverlay = false;
      (tmCanvas as unknown).__treemapRefresh?.();
    }
    updateBackButtons();
  });
  backResp?.addEventListener("click", () => {
    if ((respCanvas as unknown).__responseCanGoBack?.()) {
      (respCanvas as unknown).__responseBack?.();
    } else {
      (respCanvas as unknown).__hasOverlay = false;
      (respCanvas as unknown).__responseRefresh?.();
    }
    updateBackButtons();
  });

  // Observe treemap re-renders to update back button visibility
  const backObserver = new MutationObserver(updateBackButtons);
  backObserver.observe(tmCanvas, { childList: true, subtree: true });
  backObserver.observe(respCanvas, { childList: true, subtree: true });

  // Also expose direct callback for level changes (catches async updates the observer might miss)
  (tmCanvas as unknown).__onLevelChange = updateBackButtons;
  (respCanvas as unknown).__onLevelChange = updateBackButtons;

  // ─── Auto-summary on bar re-click ───
  async function triggerAutoSummary(event: unknown, type: "context" | "response") {
    const panel = type === "context" ? tmCanvas : respCanvas;
    const ts = event.timestampMs ?? (event.timestamp ? new Date(event.timestamp).getTime() : null);
    panel.innerHTML = '<div class="tm-empty">Summarizing\u2026</div>';
    try {
      const params: unknown = {
        component: type === "context" ? "current_prompt" : "response",
        sessionKey: sessionKey || undefined,
      };
      if (ts) {
        params.timestamp = ts;
      }
      const result = await req("forensic.summarize", params);
      const summary = result?.summary ?? "(no summary)";
      panel.innerHTML = "";
      const div = document.createElement("div");
      div.className = "tm-preview";
      div.style.background = "rgba(20,20,40,0.95)";
      const hdr = document.createElement("div");
      hdr.className = "tm-preview-header";
      hdr.textContent = type === "context" ? "Prompt Summary" : "Response Summary";
      const body = document.createElement("div");
      body.className = "tm-text-block";
      body.textContent = summary;
      div.appendChild(hdr);
      div.appendChild(body);
      panel.appendChild(div);
      // Mark overlay so updateBackButtons() shows the back button
      (panel as unknown).__hasOverlay = true;
      // Give DOM a tick to render before checking scroll
      setTimeout(updateBackButtons, 10);
    } catch (e: unknown) {
      panel.innerHTML = `<div class="tm-empty">Summary failed: ${esc(e?.message ?? "unknown")}</div>`;
    }
  }

  // Mount context timeline (bottom bar)
  const timelineContainer = $("context-timeline")!;
  timelineCtrl = mountContextTimeline(
    timelineContainer,
    (event, mode) => {
      if (mode === "response-summarize") {
        switchBrpTab("response");
        triggerAutoSummary(event, "response");
      } else if (mode === "context-summarize") {
        triggerAutoSummary(event, "context");
      } else if (mode === "response") {
        switchBrpTab("response");
        // Show round detail in response panel
        const sel = timelineCtrl?.getSelected();
        if (sel) {
          const respCanvas = $("response-canvas")!;
          let h = `<div class="tm-detail" style="padding:12px;font-size:13px;line-height:1.6">`;
          h += `<div style="font-weight:700;margin-bottom:8px;font-size:14px">Response — Round ${sel.roundNumber ?? "?"}</div>`;
          if (sel.responseTokens) {
            h += `<div>Output tokens: <b>${sel.responseTokens.toLocaleString()}</b></div>`;
          }
          if (sel.durationMs) {
            h += `<div>Duration: <b>${(sel.durationMs / 1000).toFixed(1)}s</b></div>`;
          }
          if (sel.stopReason) {
            h += `<div>Stop reason: <b>${sel.stopReason}</b></div>`;
          }
          if (sel.toolsTriggered?.length) {
            h += `<div style="margin-top:8px"><b>Tools triggered (${sel.toolsTriggered.length}):</b></div>`;
            for (const t of sel.toolsTriggered) {
              const status = t.isError ? "\u2717" : "\u2713";
              const dur = t.durationMs ? ` ${(t.durationMs / 1000).toFixed(1)}s` : "";
              const out = t.outputChars ? ` \u2192 ${t.outputChars.toLocaleString()} chars` : "";
              const inp = t.inputChars ? ` (${t.inputChars.toLocaleString()} in)` : "";
              const color = t.isError ? "#ef4444" : "#22c55e";
              h += `<div style="margin-left:8px;color:${color}">${status} <span style="color:var(--fg)">${t.name}${dur}${out}${inp}</span></div>`;
            }
          }
          if (!sel.responseTokens && !sel.toolsTriggered?.length) {
            h += `<div style="color:var(--muted)">Waiting for response data...</div>`;
          }
          h += `</div>`;
          respCanvas.innerHTML = h;
        } else {
          updateResponseMap();
        }
      } else {
        switchBrpTab("context");
        (tmCanvas as unknown).__treemapShowAnatomy?.(event);
      }
      updateBackButtons();
    },
    () => sessionKey,
    () => (import.meta.env.DEV ? "http://localhost:18789" : ""),
    PROVIDER_ICONS,
    (groupIndex, firstEvent) => {
      // Show the prompt's context anatomy in the treemap
      switchBrpTab("context");
      (tmCanvas as unknown).__treemapShowAnatomy?.(firstEvent);
      updateBackButtons();

      // Scroll webchat to the Nth user message matching this group
      const container = $("messages");
      if (!container) {
        return;
      }
      const userMsgs = container.querySelectorAll(".msg.user");
      if (groupIndex >= userMsgs.length) {
        return;
      }
      const target = userMsgs[groupIndex] as HTMLElement;
      // Manual smooth scroll within the .messages container
      const targetTop = target.offsetTop - container.offsetTop;
      const dest = targetTop - container.clientHeight / 2 + target.offsetHeight / 2;
      const start = container.scrollTop;
      const delta = dest - start;
      const duration = 350;
      let t0: number | null = null;
      function step(ts: number) {
        if (!t0) {
          t0 = ts;
        }
        const elapsed = ts - t0;
        const progress = Math.min(elapsed / duration, 1);
        // ease-out cubic
        const ease = 1 - Math.pow(1 - progress, 3);
        container!.scrollTop = start + delta * ease;
        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          target.classList.add("scroll-highlight");
          setTimeout(() => target.classList.remove("scroll-highlight"), 900);
        }
      }
      requestAnimationFrame(step);
    },
    (mode) => {
      if (mode === "all") {
        timelineCtrl?.loadAllSessions(sessions.map((s: unknown) => s.key));
      } else {
        timelineCtrl?.loadSession(sessionKey);
      }
    },
    // FORK: Pass auth headers for HTTP fallback
    () => (TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    // FORK: Pass WS req function so timeline uses WebSocket instead of HTTP (avoids CORS in dev)
    req,
    // FORK (2026-04-21): getSessionLabel — in "All" mode, the timeline renders
    // a per-call badge with this label. We return the tab title if the session
    // has an open tab; otherwise fall back to the server-side session label.
    (sk: string) => {
      if (!sk) {
        return null;
      }
      const tab = tabs.find(
        (t) =>
          t.sessionKey === sk ||
          (t.sessionKey && sk.endsWith(":" + t.sessionKey)) ||
          (t.sessionKey && t.sessionKey.endsWith(":" + sk)),
      );
      if (tab?.title) {
        return tab.title;
      }
      const sess = sessions.find(
        (s: unknown) =>
          s.key === sk ||
          (typeof s.key === "string" && (s.key.endsWith(":" + sk) || sk.endsWith(":" + s.key))),
      );
      return sess?.label || sess?.displayName || null;
    },
  );

  // Initial load is triggered from gwConnect's onopen handler (line ~776)
  // since sessionKey isn't available until WS handshake completes.
}

// ─── Prefrontal Tree ───
// FORK: Call tree panel fed by WebSocket "prefrontal-tree" broadcast events from the prefrontal extension.
let prefrontalCtrl: PrefrontalTreeController | null = null;

// ─── Boot ───
init();
// Mount prefrontal tree AFTER init() creates the DOM
const prefrontalContainer = document.getElementById("prefrontal-graph");
if (prefrontalContainer) {
  prefrontalCtrl = mountPrefrontalTree(prefrontalContainer);
  updatePrefrontalTree(); // Show empty state on boot
}
gwConnect();
setInterval(() => {
  if (connected) {
    loadBudget();
  }
}, 300_000);

// Prefrontal tree is now updated reactively via updatePrefrontalTree()
// at the same call sites as updateBudgetPanel/updateChat (no polling needed).
