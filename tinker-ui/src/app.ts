import MarkdownIt from "markdown-it";
import { mountContextTimeline } from "./panels/context-timeline.js";
// Tinker UI — Command Center v0.3
import { mountContextTreemap } from "./panels/context-treemap.js";
import {
  mountPrefrontalTree,
  type PanelPlan,
  type PrefrontalDashboardState,
  type PrefrontalTreeController,
  type RecipeState,
  type TrailEvent,
  type TrailEventKind,
  type TreeNode,
  type TreeResponse,
} from "./panels/prefrontal-tree.js";
import { mountResponseTreemap } from "./panels/response-treemap.js";

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
}

const FORTUNE_COOKIES = [
  // ─── Shamatha · Calm Abiding ───
  "🪷 Sit in stillness for just five breaths today, and the answer you've been chasing will arrive on its own quiet feet",
  "🧘 A deep calm is settling into your bones right now — it will carry you through every challenge before sunset",
  "🕯️ Pause before your next reaction and a clarity you haven't felt in months will flood through you like warm light",
  "🪔 The still waters of your mind today reflect a truth that transforms your entire week ahead",
  "🪷 Let your thoughts pass like clouds this morning; by afternoon your path will shine with a certainty born of stillness",
  "🧘 Your breath is becoming your anchor today — each inhale draws in wisdom, each exhale releases doubt",
  "🌙 Choose silence over noise for one hour and the universe will whisper something extraordinary to your quiet mind",
  "🕊️ A peaceful awareness is rising in you that will make today's hardest moment feel effortless and light",
  "🪷 Soften your gaze and relax your jaw right now — an insight you need will arrive within minutes of that release",
  "🌿 The tranquility forming inside you today will radiate outward and calm everyone you encounter",
  "🧘 Return to your breath each time the mind wanders; by evening you will discover something beautiful waiting there",
  "🕯️ Stillness is building a cathedral in your mind today — its doors open to a revelation you didn't expect",
  "🌀 Your calm today is not passive — it is a force reshaping circumstances in your favor as you sit",
  // ─── Vipassana · Insight ───
  "🔮 Observe your thoughts without judging them today, and one will reveal a solution hidden in plain sight all along",
  "🔬 A flash of insight is approaching you — your awareness is sharp enough today to catch it before it passes",
  "🧠 Watch the space between your thoughts today and you will notice a pattern that changes everything you assumed",
  "👁️ Your inner observer is wide awake, seeing a door that your busy mind has been walking past for weeks without noticing",
  "🪷 Notice what triggers your reactions this morning; by evening you will have freed yourself from an old invisible chain",
  "🔬 The quality of your attention today is extraordinary — it will reveal the hidden structure beneath a stubborn problem",
  "🧠 Sit with discomfort instead of running from it and it dissolves, leaving behind a gift of deep understanding in its place",
  "🔍 Your awareness is a lens today — everything you examine closely will reveal layers of beauty and meaning within",
  "🪷 Practice bare attention during your next conversation and you will hear what no one else in the room catches",
  "🔬 A moment of pure seeing is coming — in that flash, months of confusion will reorganize into crystal clarity",
  "🧠 Label each emotion as it arises without clinging, and tonight you will feel lighter than you have in years",
  "🌠 The clear seeing you cultivate today ripples forward and prevents a mistake you would have made next week unknowingly",
  // ─── Mastering the Mind · The Inner Throne ───
  "🧠 Catch the first anxious thought before it breeds a second — that single interception today rewrites the mood of your entire afternoon",
  "🪷 The moment you notice your mind racing, you have already won — awareness itself is the brake, and today it stops a spiral before it starts",
  "🧘 Refuse to follow the next distraction that calls your name and an hour of focus will yield what a scattered day could not in a week",
  "🔥 Your mind is a wild horse today — do not fight it, do not let it run, simply hold the reins with steady presence and it becomes your greatest ally",
  "🗡️ Every thought you choose not to chase today strengthens a muscle of sovereignty that no circumstance can weaken once it is built",
  "🎯 Discipline the wandering mind for ten minutes this morning and the concentration you build becomes a lens that magnifies everything you do after",
  "🪞 When the inner critic speaks today, listen without obeying — that gap between hearing and believing is where your freedom lives and grows",
  "🐉 Master one impulse today — just one — and the self-trust that follows unlocks a chain of better choices that lasts the rest of the week",
  "🐒 The monkey mind chatters loudest when you are closest to a breakthrough — its noise today is proof you are almost through the wall",
  "🏛️ Each time you return your attention from distraction to intention today, you are building a throne from which no thought can unseat you",
  "🕳️ Slow the stream of thoughts for one minute and you will discover that beneath the rapids lies a still pool of knowing that has been waiting for you",
  "🎭 Today your mind will offer you fear disguised as logic — see through the costume and the fear dissolves, leaving only clear, courageous action behind",
  "⚔️ Train your attention like a blade today: sharpen it on small tasks, and by afternoon it cuts through complexity that baffled your scattered morning self",
  "🔓 The thought you are most tempted to believe without questioning is the one most worth examining — investigate it today and discover unexpected freedom",
  "👑 Whoever governs their own attention today governs their destiny — and you are governing yours with more skill than you realize right now",
  "🏹 Watch how quickly a negative thought loses power when you simply name it: that naming is not passive, it is the most active thing a mind can do",
  "🧩 Choose one hour today to think only about what you are doing, nothing else — that hour will outproduce the rest of the day combined",
  "⏸️ Notice the gap between stimulus and response today: in that hairsbreadth pause lives a version of you that is free, sovereign, and unshakable",
  // ─── Metta · Loving-Kindness ───
  "💗 Silently wish well to the first stranger you see today, and a chain of kindness returns to you before dark in a form you didn't expect",
  "🌸 A wave of compassion rising in your heart today will open a door that no amount of force could have budged",
  "💝 Forgive one small thing before noon and the weight you've been carrying for months will lift entirely by evening",
  "🫂 Your genuine warmth today is a beacon — someone who needs exactly what you offer will find their way to you",
  "💗 Offer patience to someone who tests you today and watch the universe reward your restraint with something unexpectedly beautiful",
  "🌸 The loving-kindness you send outward today returns as help from a direction you never imagined possible",
  "💝 Replace one critical thought about yourself with a kind one, and your whole inner weather shifts as sunshine breaks through within",
  "🫂 Someone is about to enter your day who desperately needs your warmth — your compassion will alter their entire trajectory",
  "💗 Extend grace to yourself this morning and unlock a creative energy that has been waiting patiently behind self-doubt",
  "🌸 Even a few silent phrases of metta today send ripples that reach farther than you will ever know",
  "💝 Hold in your heart someone who frustrates you, and understanding will dawn that frees both of you from the cycle at once",
  "🫂 Send loving-kindness to your past self and a wound you thought permanent begins its final healing today at last",
  // ─── Awareness · Present Moment ───
  "✨ Arrive fully in this present moment and you will notice an opportunity that was invisible to your scattered mind before",
  "🌅 The present moment is extraordinarily rich for you today — each second you inhabit it fully multiplies your creative power",
  "🍵 Taste your next meal with complete attention, and a forgotten joy will awaken that colors the rest of your entire day",
  "🧲 Your presence today is magnetic — the moment you stop rehearsing the future, the right future walks directly toward you",
  "📵 Put down your phone for the next ten minutes and just breathe; an idea worth more than anything on that screen is already arriving",
  "🪙 Your attention is golden currency today — wherever you invest it fully, it returns compound interest in joy and clarity",
  "🚶 Walk mindfully for even fifty steps today and the rhythm of your footfalls will unlock a solution you've been seeking",
  "💫 Being fully here today is your superpower — while others rush past this moment, you find the treasure hidden inside it",
  "🔎 Bring curious attention to a routine task today and it transforms into something surprisingly meaningful and revealing",
  "✨ The quality of your presence today attracts exactly the people, ideas, and opportunities you have been quietly wishing for",
  "⚓ Anchor yourself in this breath right now: the anxious future dissolves and the real path forward reveals itself clearly",
  // ─── Non-Attachment · Letting Go ───
  "🍃 Release your grip on one outcome today, and something far better than what you planned slides effortlessly into its place",
  "🌬️ A burden you've been carrying is ready to be set down — the moment you release it, new energy floods that empty space",
  "🕊️ Stop fighting what is and simply allow it; the situation rearranges itself into a configuration that serves you perfectly",
  "🔗 The thing you cling to most tightly is the very thing blocking the abundance that is trying to reach you right now",
  "🍃 Surrender the need to be right in one conversation today and you win something far more valuable than any argument ever gives",
  "🫧 Your willingness to release control today creates space for a solution more elegant than anything you could have engineered",
  "🛶 Trust the river today instead of swimming against it, and you arrive somewhere beautiful that was never on your original map",
  "🦋 An attachment dissolving right now is not a loss — it is your cocoon cracking open so wings you didn't know you had can unfold",
  "🍃 Watch a worry without feeding it today: it starves and fades, leaving behind pure clarity and a surprising sense of freedom",
  "🤲 The hand that opens to release is the same hand that receives — your letting go today creates room for tomorrow's greatest gift",
  "🌬️ Practice non-attachment with the results of your effort and the effort itself becomes joyful while the results exceed every expectation",
  // ─── Karma · Right Action ───
  "🌟 Choose the kind path over the clever one today and the ripples of that choice return to you magnified a hundredfold by evening",
  "⚖️ Every small right action you take today is being woven into a safety net that catches you perfectly when you need it most next week",
  "🪬 Act with integrity in the moment no one is watching, and the universe opens a door reserved only for the trustworthy",
  "🌾 Seeds of your past generosity are germinating beneath the surface today — expect a bloom of abundance from a forgotten kindness",
  "🎁 Give without expecting return today: the return finds you anyway, wearing a disguise so beautiful you almost don't recognize it",
  "🧱 Your discipline today creates tomorrow's freedom — every conscious choice you make right now is a brick in the palace you're building",
  "💊 Speak truth gently today, even when it's hard, and your words will land like medicine and heal something nobody knew was broken",
  "🔄 A generous act from your past is circling back right now — someone you helped long ago is about to return the favor unexpectedly",
  "🌟 Resist the easy shortcut and take the right path: what you build today stands forever while shortcuts collapse around you later",
  "🕯️ Your intention behind each action matters more than the action itself — pure intentions today attract pure outcomes all week",
  "🌟 Dedicate your effort today to something larger than yourself and your personal energy doubles while obstacles shrink to pebbles",
  "🤝 Honor a commitment nobody would fault you for breaking, and your integrity today becomes your reputation tomorrow — opening doors",
  // ─── Impermanence · Change ───
  "🦋 Remember that this difficulty is temporary: that single remembrance strips it of power and transforms it into the teacher it was always meant to be",
  "🌙 A phase of your life is completing right now — the ending feels tender, but what emerges will fill you with wonder and gratitude",
  "🏄 Embrace today's uncertainty instead of resisting it and you ride the wave of change directly into something extraordinary and new",
  "🌀 Something that seemed permanent is shifting beneath you — do not be afraid, for the ground is rearranging to support you even better",
  "📬 Welcome each change today as a messenger rather than an enemy, and every message turns out to contain exactly the guidance you needed",
  "🍂 The autumn of one chapter in your life is making room for a spring so vivid you will bless this very moment of change when you look back",
  "⏳ Notice what is arising and passing away in you right now and you touch a freedom that no external circumstance can ever take from you",
  "🌙 What feels like loss today is actually space being cleared — the universe is redecorating your life, and the new design is breathtaking",
  "🪶 Hold lightly to both success and failure today, and a third option appears more creative than either winning or losing could ever be",
  "🐍 An old identity is falling away and it feels strange — trust the process, because who you are becoming is worth every moment of uncertainty",
  "🫁 Each breath is a tiny birth and death — discover that aliveness in this very second and it makes the whole day glow from inside out",
  // ─── Inner Strength · Equanimity ───
  "🏔️ Meet today's turbulence with a steady heart; by evening you'll see that your calm was the strongest force in the room all along",
  "⚓ An unshakable center is forming in you right now — events that would have rattled you before pass through like wind through an open window",
  "🏔️ Keep your balance when others lose theirs today and your steadiness becomes the lighthouse that guides everyone safely through the storm",
  "⚓ Your equanimity is not indifference — it is the eye of a storm where vision is clearest and decisions are wisest and most precise",
  "🎯 Respond instead of reacting just once today: that single moment of mastery cascades into a series of quiet victories all afternoon",
  "🪨 The mountain in your heart does not move with the weather — storms may come today, but they only polish your summit into something magnificent",
  "🫁 Breathe through the hardest moment instead of fleeing from it, and you prove to yourself a strength that nothing can ever take away",
  "🌳 Your patience today is not weakness — it is a power so quiet that the world rearranges itself around your stillness without you even trying",
  "☯️ Hold space for opposing feelings today without choosing sides, and a third intelligence emerges that resolves the tension beautifully",
  "🛡️ Something that used to shake you tests you again today — and this time, you feel the difference your practice has made, clear as dawn",
  "🏔️ Treat discomfort as information rather than threat and it delivers a message that unlocks months of stalled progress in a single moment",
  "🧊 Your composure under pressure today earns a respect no boast could ever win — someone important sees your strength and never forgets it",
  // ─── The Seer's Crystal Ball ───
  "🔮 The crystal shows a stranger entering your orbit today who carries a message that reconnects you with a purpose you thought you had outgrown",
  "🧭 Follow your curiosity into an unexpected direction today: the crystal shows it leading to a discovery that reshapes your entire month ahead",
  "🕸️ I see a moment of synchronicity approaching before nightfall — two unrelated threads of your life are about to weave into something breathtaking",
  "🔮 Trust the quiet voice over the loud one today, and the crystal reveals it leading you to the exact person you need to meet right now",
  "✉️ The crystal ball shimmers with a coming conversation that will remind you why you chose this path and fill you with renewed fire",
  "🫀 Share something vulnerable today — the crystal shows it being received with such warmth that it becomes a turning point in that relationship",
  "🎰 I see three small blessings lining up for you: the first arrives before noon, the second over a meal, the third just before you sleep",
  "📞 The crystal shows someone you haven't heard from in ages reaching out today with an opportunity you've been silently praying for",
  "⚡ Act on your intuition before your logic catches up and the crystal sees you landing in exactly the right place at exactly the right time",
  "🔮 I see a skill you've been quietly building suddenly clicking into place — today it stops being practice and becomes something you truly embody",
  "🦁 Make one brave choice today, and the crystal reveals a cascade of fortunate events unfolding from it like dominoes over the next three weeks",
  "☀️ The crystal glows warmest around this afternoon — something between two and five today will make you smile every time you remember it",
  "🌃 I see tonight bringing a quiet realization that connects scattered pieces of your life into a picture so clear it takes your breath away",
  // ─── Abundance · Flow ───
  "🌊 Approach your work with gratitude today and abundance flows through channels you didn't even know existed until they opened before your eyes",
  "💎 A current of prosperity is running beneath the surface of this ordinary day — your awareness is the dowsing rod that leads you straight to it",
  "🤲 Give freely from your overflow today: the universe interprets it as a signal and amplifies your supply in a way that defies rational explanation",
  "🎨 Your creative energy today is unusually potent — channel it with intention and what you produce will have value far beyond what you imagine now",
  "🌊 Release scarcity thinking for just this one day and the evidence of abundance surrounding you becomes so obvious it makes you laugh out loud",
  "💎 Something you considered ordinary about yourself is pure gold in someone else's world — today that recognition arrives and opens a new flow",
  "🌈 Notice each small good thing today instead of waiting for the big one; by sunset the accumulation feels like a fortune quietly received",
  "🧬 The work you love is aligning with what the world needs from you — today brings a sign of that alignment so clear you cannot dismiss it",
  "🙏 Express appreciation for what you already have before asking for more, and the more arrives so quickly it feels like the universe was waiting",
  "🗝️ An unexpected resource appears today — not money perhaps, but something equally valuable: a skill, a contact, a truth you'd stopped hoping for",
  "📖 Share your knowledge without hoarding it, and the space that opens in your mind fills with an insight worth ten times what you gave away",
  // ─── Connection · Sangha ───
  "🤝 Reach out to someone you've been thinking of today and the connection reignites with a warmth and depth that surprises you both profoundly",
  "🌉 A meaningful encounter is forming in today's ordinary fabric — your openness is the needle that threads it into something lasting and nourishing",
  "👂 Listen more than you speak in your next exchange: you'll hear the hidden request beneath the words and your response will touch them deeply",
  "🩹 Someone in your life is silently struggling — your simple presence today, without needing to fix a thing, becomes the medicine their heart required",
  "❓ Ask a sincere question instead of giving advice today, and the answer you receive teaches you something that reshapes your own understanding",
  "🌉 The bonds you nurture today with simple presence and authentic words will prove to be the strongest supports when unexpected change comes",
  "👁️ Acknowledge someone's effort that usually goes unnoticed and you set off a chain reaction of goodwill that circles all the way back to you",
  "🤝 A community you belong to is about to benefit enormously from something only you can contribute — today brings the moment to step forward",
  "🪞 Show up authentically today without performing confidence or competence, and the real you lands better than any polished version ever could",
  "😊 Your smile today reaches someone who was about to give up and gives them exactly enough light to keep going forward one more day",
  "🗣️ Express your needs honestly instead of hinting, and someone steps forward today with exactly the help you need, grateful you finally asked",
  // ─── Destiny · The Path ───
  "🌌 Take one step today toward what excites you most, and the path illuminates itself twenty steps ahead in a direction more beautiful than your plan",
  "⭐ A constellation of events has been quietly arranging around you — today you notice the pattern, and recognizing it is all you need to ride its current",
  "📯 Honor the calling that has been whispering at the edge of your awareness and today it speaks clearly enough that doubt finally falls silent",
  "🔄 Something you gave up on long ago is circling back in a new form — the universe did not forget your wish, it was simply perfecting the delivery",
  "🌌 Make one choice today that aligns with who you are becoming rather than who you were, and a future you can barely imagine begins to crystallize",
  "🧬 Your life is not a random sequence — today brings a moment of such clear synchronicity that you feel the pattern beneath the chaos and it steadies you",
  "🚪 Say yes to the unexpected invitation today, and it becomes the first frame of a story you will tell with wonder for years to come",
  "🗝️ A door you tried to open years ago is about to swing open on its own — you are finally ready for what waits on the other side of it",
  "🛤️ Trust that every twist of your path, including the painful ones, was leading here — today rewards that trust with evidence so clear it moves you",
  "⭐ You are closer to your purpose than you have ever been — today brings a sign so specific that even your inner skeptic goes quiet and listens",
  "🧶 Follow the thread of joy today wherever it leads, even if impractical — it winds toward a door you didn't know was yours to open",
  "📷 The universe has been preparing something for you in the dark — today, like a photograph developing, the first clear image of that gift becomes visible",
  // ─── Protection · Sacred Shield ───
  "🛡️ Set one clear boundary today and it protects not only this day but establishes a precedent that shields your peace for months to come",
  "🧿 An invisible guardian energy surrounds you today — decisions that might have gone wrong course-correct as if an unseen hand adjusts them",
  "🐍 Listen to the subtle warning in your body today and you sidestep something that would have cost you far more than you realize at the time",
  "🧿 Your aura today is particularly strong — negativity that approaches you simply bounces off and dissolves, leaving you untouched and clear",
  "😴 Honor your need for rest instead of pushing through, and you protect the very energy that tomorrow's breakthrough requires to emerge",
  "🏰 Something you built with good intention is now building a protective field around you — your past diligence becomes today's invisible shield",
  "🚶 Walk away from a conversation that drains you today: the energy you preserve becomes the fuel for a creative surge that arrives by evening",
  "🪬 Your mindfulness practice is not just calming you — it is building a field of clarity that protects your decisions from the noise of the world",
  "🐢 Slow down when everything around you speeds up and you become the eye of the storm where safety, clarity, and right action converge naturally",
  "💛 The protection around you today comes from the love you have given freely — every act of kindness forms a circle of light that keeps you safe",
  "🌍 Ground yourself this morning — feet on earth, breath in lungs, attention in body — and that grounding becomes armor against the day's uncertainties",
  // ─── Transformation · The Chrysalis ───
  "🐛 Sit with the discomfort of not knowing who you are becoming, and the chrysalis dissolves into something more beautiful than your boldest dream",
  "🔥 A phoenix moment is approaching — something that felt like failure is about to reveal itself as the necessary burning away of what you'd outgrown",
  "🧭 Honor the strange restlessness you've been feeling; it leads today to the exact threshold your soul has been searching for all this time",
  "🪞 Your transformation is not visible to others yet, but today you feel it from the inside — a shift so real the mirror seems to show a new person",
  "🛤️ Stop comparing your path to anyone else's today and your unique trajectory reveals an advantage that copying someone else would have erased",
  "⚗️ What you've been through was not punishment — it was preparation, and today brings the first clear evidence of what it was all for",
  "🌱 Embrace the awkwardness of growth instead of retreating to the familiar, and today you cross a threshold you can never be pushed back behind",
  "🪶 An old version of you is dying so quietly you almost don't notice — the lightness you feel is the weight of who you no longer need to be",
  "🐛 Allow yourself to be a beginner at something today and the humility opens a channel of learning so fast it feels like remembering",
  "💎 The pressure you've endured is not breaking you — it is making you rare, and today someone reflects your diamond-nature back to you at last",
  "🔥 Name the fear running beneath your decisions: naming it today strips it of power and what remains is pure, clear, actionable courage",
  "🦊 Something you thought was your weakness is actually your most unusual strength — today proves it beyond any remaining shadow of doubt",
  // ─── Joy · The Dancing Mind ───
  "🎶 Allow yourself to feel delight without needing a reason and the unreasonable delight becomes the most productive energy you have ever channeled",
  "🌻 A wave of spontaneous joy is approaching from an unexpected direction — your only job is to be present enough to catch it",
  "😂 Laugh at something absurd today instead of analyzing it: the laughter unlocks a creative insight that serious thinking could never have reached",
  "🔭 Your capacity for wonder is especially alive today — ordinary things reveal their hidden magnificence when you give them three seconds of attention",
  "🃏 Take a playful approach to a serious task today and the playfulness produces better results than seriousness ever could",
  "⚡ The joy reaching for you today is not a reward for finishing — it is the energy that makes the work feel like play and the hours like minutes",
  "🎶 Notice beauty in something small today — light on water, a texture, a sound — and that noticing activates a gratitude that colors your evening golden",
  "🌻 Someone will say something today that makes you laugh from a place so deep it feels like medicine, healing something you didn't know needed healing",
  "💃 Move your body to music, even for thirty seconds, and stagnant energy transforms into momentum that carries your next three decisions forward",
  "🧒 Your childlike wonder is not naivety — it is wisdom in its purest form, leading you today to something your adult seriousness would have walked past",
  "🏆 Celebrate a small victory today instead of immediately chasing the next one: the celebration itself becomes a magnet that draws the next victory closer",
  "🌺 Joy is not the absence of difficulty — it is the presence of aliveness, and today your aliveness is so strong that difficulties shrink in its light",
  // ─── Wisdom · The Ancient Mind ───
  "🦉 Approach a familiar problem today as if seeing it for the first time: fresh eyes reveal what experience alone had been concealing from you",
  "📿 Ancient wisdom is alive in your body today — the answer you seek does not live in your thoughts but in the knowing that pulses just beneath",
  "🏊 Choose depth over speed in one task today, and the depth rewards you with understanding that saves weeks of surface-level effort down the road",
  "🌾 A lesson you learned long ago and forgot is resurfacing today — it arrives at exactly the right moment, as if your past self planted it here",
  "💡 Question one assumption you have been taking for granted and the crack in that assumption lets light into a room that was unnecessarily dark",
  "📿 Your inner sage is especially accessible today — pause and ask a sincere question of yourself, and the answer that rises will be remarkably wise",
  "🦉 Teach someone what you know today: the act of teaching reveals layers of your own knowledge you didn't realize you possessed until now",
  "📜 A book, a sentence, or a sign catches your eye today — it is the universe's footnote on a question you've been holding in your heart",
  "🫗 Accept that not knowing is a valid position today, and the humility of it attracts exactly the teacher or experience that fills the gap",
  "🧪 Your accumulated experience is crystallizing into intuition — decisions that used to require analysis now arrive as clear, embodied knowing",
  "🌙 Sit with a question tonight instead of rushing to answer it: by morning the answer presents itself fully formed and more elegant than you could have built",
  "🪶 Trust the simplest explanation when complexity tempts you today — simplicity turns out to be the key that complexity was only pretending to be",
  // ─── The Morning Star · New Beginnings ───
  "🌅 Set one intention with your whole heart this morning and the day organizes itself around it as if reality itself wants to help you fulfill it",
  "⭐ A fresh chapter is opening in your story — the first paragraph writes itself beautifully when you show up with presence and willingness to begin",
  "🧹 Release yesterday completely and start today with beginner's mind; the freshness reveals opportunities that habit had been hiding from you",
  "🌱 Something dormant in you is waking up — today is when you first feel it stir and recognize it as the beginning of something real and lasting",
  "🎁 Greet this morning as a gift rather than an obligation and the quality of everything that follows shifts in a way that surprises you with its magnitude",
  "🌱 A new cycle is beginning in your life right now — the seed was planted in silence, but today it breaks the surface where you can finally see it",
  "⏱️ Begin the project you've been postponing with just five minutes of effort: those five minutes unlock a momentum that was waiting for your first step",
  "📄 The blank page of today is not emptiness — it is infinite possibility, and the first mark you make sets a tone more harmonious than you expect",
  "🌅 Make today's first choice a conscious one instead of automatic: that consciousness ripples through every subsequent choice and elevates them all",
  "☀️ Your energy has the quality of dawn — something in you is rising, warming, and illuminating what was dark before no matter what time you read this",
  "🙏 Start today by feeling grateful for your own existence: every cell responds and the physical vitality that follows feels almost miraculous",
  "🌿 Whatever happened yesterday is compost now — today's garden grows from it, and the flowers that bloom from composted difficulty are always the most vibrant",
];

function randomFortune(): string {
  return FORTUNE_COOKIES[Math.floor(Math.random() * FORTUNE_COOKIES.length)];
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
const SCOPE_TOGGLE_IDS = ["budget-scope-toggle", "prefrontal-scope-toggle"];
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
const collapsedModelSections = new Set<string>(["configured"]);
const ACTIVE_RUNS_STORAGE_KEY = "tinker-activeRuns";
const DRAFT_STORAGE_KEY = "tinker-draft";
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
    latestTreeFromExtension.active
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
          // Restore previous active tab if it still exists, otherwise default to main.
          // FORK (2026-04-21): prevActiveTabId comes from localStorage on hard refresh
          // (module-level init above), so the user's pre-refresh sub-session stays focused.
          const prevTabExists = tabs.some((t) => t.id === prevActiveTabId);
          activeTabId = prevTabExists ? prevActiveTabId : "tab-main";
          saveActiveTabId();
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
        for (const [, info] of activeRuns) {
          info.state = "restarting";
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
        html: messagesEl.outerHTML,
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
    if (p.sessionKey !== sessionKey && !sessionKeyMatches(p.sessionKey)) {
      return;
    }
    bumpActiveRunActivity(p);
    if (p.state === "delta") {
      if (!streamRunId) {
        streamProvider = "";
        streamProfileId = "";
      }
      streamRunId = p.runId;
      // Update active run phase based on streaming content
      const runInfo = activeRuns.get(p.runId);
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
      // FORK: Un-queue any queued user messages on final/error
      for (const m of messages) {
        if (m._queued) {
          delete m._queued;
        }
      }
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
        activeRuns.set(p.runId, {
          model: p.data.model,
          provider: startProvider,
          authProfileId: p.data.authProfileId,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          sessionKey: p.data.sessionKey as string | undefined,
          phase: "thinking",
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
  }
  // Prefrontal tree updates are now reactive (driven by activeRuns, same as thinking indicator)
}

// ─── API ───
async function loadSessions(opts?: { loadChat?: boolean }) {
  const res = await req("sessions.list", {}).catch(() => ({ sessions: [] }));
  sessions = res.sessions ?? [];
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

  // Tab titles are persisted in localStorage — no regeneration on load.
  // Title generation happens in send() on first prompt and every N prompts.
}

async function generateTabTitle(tab: Tab) {
  if (!tab.sessionKey || tab.id === "tab-main") {
    return;
  }

  // FORK: Use tabStates for non-active tabs so title gen works for background tabs too
  const tabMessages =
    tab.sessionKey === sessionKey ? messages : (tabStates.get(tab.id)?.messages ?? []);
  // Collect last N Q&A pairs from messages
  const pairs: string[] = [];
  let count = 0;
  for (let i = tabMessages.length - 1; i >= 0 && count < TAB_TITLE_INTERVAL; i--) {
    const m = tabMessages[i];
    if (!m?.content) {
      continue;
    }
    const text = Array.isArray(m.content)
      ? m.content
          .filter((b: unknown) => b.type === "text")
          .map((b: unknown) => b.text)
          .join(" ")
      : String(m.content);
    if (!text.trim()) {
      continue;
    }
    const role = (m.role || "").toLowerCase();
    if (role === "user" || role === "assistant") {
      pairs.unshift(`${role}: ${text.slice(0, 200)}`);
      if (role === "user") {
        count++;
      }
    }
  }

  if (pairs.length === 0) {
    return;
  }

  const prompt = `Summarize this conversation in 1-3 words (short title, no quotes, no punctuation). Start with a relevant emoji. Example: "🔧 Fix auth bug". Here is the conversation:\n\n${pairs.join("\n")}`;

  try {
    // Try local Ollama first (free, fast)
    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3:14b-q4_K_M", prompt, stream: false }),
    })
      .then((r) => r.json())
      .catch(() => null);

    let title = ollamaRes?.response?.trim();

    // Strip any quotes or punctuation wrapping
    if (title) {
      title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
    }

    console.log("[tabs] ollama response:", JSON.stringify(ollamaRes));
    if (title && title.length > 0 && title.length <= 40) {
      // Preserve the original emoji prefix from the fortune cookie
      const originalEmoji =
        tab.title.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)\s*/u)?.[0] || "";
      // Strip any emoji the LLM may have added
      const stripped = title.replace(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)\s*/u, "").trim();
      tab.title = originalEmoji + stripped;
      console.log("[tabs] title updated to:", tab.title);
      renderTabs();
      saveTabs();
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

    const freshKey = `tinker:${Date.now().toString(36)}`;
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

    // Server-side cascade. Fire-and-forget; failures are non-fatal — worst
    // case the next chat.send auto-creates a fresh entry on the new key.
    if (oldSessionKey) {
      req("sessions.reset", { key: oldSessionKey, reason: "reset" }).catch(() => {});
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
  messages.push({
    role: "user",
    content: [{ type: "text", text }],
    _promptStartedAt: Date.now(),
    ...(hasInjection ? { _fullPrompt: fullPromptForDebug } : {}),
    ...(briefingPath ? { _briefingPath: briefingPath } : {}),
    ...(isQueued ? { _queued: true } : {}),
  });
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

  await req("chat.send", {
    sessionKey,
    message: messageForGateway,
    idempotencyKey: uuid(),
  }).catch((e) => {
    console.error(e);
    sending = false;
    updateBtn();
  });
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
  // AMYGDALA personality nudge styling (pink)
  h = h.replace(
    /<strong>🧠 AMYGDALA:<\/strong>\s*<em>(.*?)<\/em>/gi,
    '<strong style="color:#FF69B4">🧠 AMYGDALA:</strong> <em style="color:#FF69B4">$1</em>',
  );
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
type InjectToggles = { amygdala: boolean; fractal: boolean };
function loadInjectToggles(): InjectToggles {
  try {
    const raw = localStorage.getItem(AMY_FRA_TOGGLES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        amygdala: parsed.amygdala !== false,
        fractal: parsed.fractal !== false,
      };
    }
  } catch {
    /* fall through */
  }
  return { amygdala: true, fractal: true };
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
  const amy = document.getElementById("tb-amygdala");
  const fra = document.getElementById("tb-fractal");
  if (amy) {
    amy.classList.toggle("tb-active", injectToggles.amygdala);
  }
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

  const wantAmy = injectToggles.amygdala;
  const wantFra = injectToggles.fractal;
  if (!wantAmy && !wantFra) {
    return userText;
  }
  const sections: string[] = ["💬 ANSWER"];
  if (wantAmy) {
    sections.push("🧠 AMYGDALA");
  }
  if (wantFra) {
    sections.push("🌿 FRACTAL");
  }
  const order = sections.join(" → ");
  const extras: string[] = [];
  extras.push(
    `\n\n---\n\n**Structure this turn's reply as labelled sections in this exact order: ${order}.** Each marker on its own line, blank line between sections. The UI parses markers and renders each section as a separate bubble; the first is expanded, later ones collapsed.`,
  );
  extras.push(
    "\n\n**💬 ANSWER** — your complete substantive reply, markdown freely, natural prose.",
  );
  if (wantAmy) {
    extras.push(
      "\n\n**🧠 AMYGDALA** — follow the amygdala rules in your system prompt (post-turn diagnostic of Prudence + Personality ensembles). Full rule source: `~/src/tinkerclaw/extensions/tinkerclaw-learned-intuition/amygdala-prompt.md`.",
    );
  }
  if (wantFra) {
    extras.push(
      "\n\n**🌿 FRACTAL** — follow the fractal rules in your system prompt (MEMORY / PATTERN / RIPPLE / IMPROVE, ACTION-prefix when you changed something). Full rule source: `~/src/tinkerclaw/extensions/tinkerclaw-fractal-reflection/fractal-prompt.md`.",
    );
  }
  return userText + extras.join("");
}

// FORK 2026-04-18: 3-section response splitter. Detects the AMYGDALA / ANSWER /
// FRACTAL markers in an assistant message and returns the three pieces plus
// any prefix/suffix text. Used by renderMsg to render each section in its own
// bubble (amygdala + fractal collapsed, answer expanded by default).
type SectionedReply = {
  amygdala?: string;
  answer?: string;
  fractal?: string;
  other?: string;
};
// Markers tolerate: optional bold wrapping (** or __), optional colon, optional
// space between emoji and label. Opus sometimes emits `💬 ANSWER:`, sometimes
// `💬 **ANSWER**`, sometimes `💬 **ANSWER:**` — all three must match.
const AMY_MARKER_RE = /(^|\n)\s*(?:🧠|🫀)\s*(?:\*\*|__)?\s*AMYGDALA\s*:?\s*(?:\*\*|__)?\s*:?\s*/i;
const ANS_MARKER_RE = /(^|\n)\s*💬\s*(?:\*\*|__)?\s*ANSWER\s*:?\s*(?:\*\*|__)?\s*:?\s*/i;
const FRA_MARKER_RE =
  /(^|\n)\s*🌿\s*(?:\*\*|__)?\s*FRACTAL(?:\s+ACTION)?\s*:?\s*(?:\*\*|__)?\s*:?\s*/i;
function splitSectionedReply(text: string): SectionedReply | null {
  if (!text) {
    return null;
  }
  // `text.search(regex)` returns the first match position; multiple marker
  // occurrences (rare — claude echoing its own section header) would still be
  // handled because we only care about the FIRST occurrence of each.
  const amyIdx = text.search(AMY_MARKER_RE);
  const ansIdx = text.search(ANS_MARKER_RE);
  const fraIdx = text.search(FRA_MARKER_RE);
  if (amyIdx < 0 && ansIdx < 0 && fraIdx < 0) {
    return null;
  }
  // Split by whichever markers exist, in order of appearance.
  const markers: { key: "amygdala" | "answer" | "fractal"; start: number; hdrLen: number }[] = [];
  const pushMarker = (idx: number, key: "amygdala" | "answer" | "fractal", re: RegExp) => {
    if (idx < 0) {
      return;
    }
    const m = text.slice(idx).match(re);
    if (!m) {
      return;
    }
    markers.push({ key, start: idx, hdrLen: m[0].length });
  };
  pushMarker(amyIdx, "amygdala", AMY_MARKER_RE);
  pushMarker(ansIdx, "answer", ANS_MARKER_RE);
  pushMarker(fraIdx, "fractal", FRA_MARKER_RE);
  markers.sort((a, b) => a.start - b.start);
  const result: SectionedReply = {};
  const preface = text.slice(0, markers[0]?.start ?? 0).trim();
  if (preface) {
    result.other = preface;
  }
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    if (!m) {
      continue;
    }
    const bodyStart = m.start + m.hdrLen;
    const bodyEnd = markers[i + 1]?.start ?? text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    if (body) {
      result[m.key] = body;
    }
  }
  return result;
}
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
function renderUserBubbleWithPromptToggle(
  userText: string,
  msg: { _fullPrompt?: string; _briefingPath?: string; _promptStartedAt?: number },
  queuedClass: string,
  queuedBadge: string,
  idx: number,
): string {
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

function renderSectionedReply(sec: SectionedReply, elapsed: string = ""): string {
  // Visual order: ANSWER (expanded) → AMYGDALA (collapsed) → FRACTAL (collapsed).
  // Matches the instructed emission order. The splitter records whichever
  // sections it found, regardless of position in the text; this renderer
  // forces the canonical on-screen order.
  //
  // IMPORTANT: if the splitter found amygdala OR fractal but NO answer marker,
  // the pre-marker content ("other") is actually the answer — promote it.
  // Otherwise the answer text falls on the floor.
  // FORK 2026-05-09 (Feature B): the elapsed-chip is appended to the ANSWER
  // bubble (the visible main reply). When sectioned answer falls through to
  // raw `other`, attach to that bubble instead.
  let h = "";
  const effectiveAnswer =
    sec.answer ?? (sec.other && (sec.amygdala || sec.fractal) ? sec.other : undefined);
  if (effectiveAnswer) {
    h += `<div class="msg assistant">${md(effectiveAnswer)}${elapsed}</div>`;
  } else if (sec.other && !sec.amygdala && !sec.fractal) {
    // No markers at all — fall back to raw
    h += `<div class="msg assistant">${md(sec.other)}${elapsed}</div>`;
  }
  if (sec.amygdala) {
    h +=
      `<details class="msg msg-amygdala">` +
      `<summary class="amygdala-summary">🧠 <em>Amygdala</em> — gut read</summary>` +
      `<div class="amygdala-body">${md(sec.amygdala)}</div>` +
      `</details>`;
  }
  if (sec.fractal) {
    h +=
      `<details class="fractal-details">` +
      `<summary class="fractal-summary">🌿 <em>Fractal</em> — reflection</summary>` +
      `<div class="msg msg-fractal">${md(sec.fractal)}</div>` +
      `</details>`;
  }
  return h;
}

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
  return (
    `<div class="msg msg-envelope ${variantClass}" data-env-id="${esc(env.id)}" data-env-category="${esc(env.category)}">` +
    `<div class="env-header"><span class="env-icon">${esc(env.icon ?? "⚠️")}</span><span class="env-headline">${esc(env.headline)}</span></div>` +
    explanation +
    actions +
    tech +
    `</div>`
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
      if (!isThinking) {
        const sectioned = splitSectionedReply(text);
        if (sectioned && (sectioned.answer || sectioned.amygdala || sectioned.fractal)) {
          h += renderSectionedReply(sectioned, elapsedChip(msg, idx));
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
        // FORK 2026-05-09 (Feature B): append elapsed chip inside assistant bubble.
        h += `<div class="msg assistant${errorClass}${isThinking ? " msg-thinking" : ""}">${thinkingPrefix}${md(text)}${retryBtn}${elapsedChip(msg, idx)}</div>`;
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
        if (!isThinking) {
          const sectioned2 = splitSectionedReply(text);
          if (sectioned2 && (sectioned2.answer || sectioned2.amygdala || sectioned2.fractal)) {
            h += renderSectionedReply(sectioned2, elapsedChip(msg, idx));
            return h;
          }
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
          h += `<div class="msg assistant${errorClass}${isThinking ? " msg-thinking" : ""}">${thinkingPrefix}${md(text)}${retryBtn}${stepTag}${elapsedChip(msg, idx)}</div>`;
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
    // FORK 2026-05-16: the run-belongs-to-viewed-session test is now the ONE
    // shared predicate (runBelongsToViewedSession) so the indicator can never
    // disagree with the prefrontal panel / model count about which runs are
    // "this tab's". Subagent-descendant inclusion is baked into the helper.
    const mainRows: string[] = [];
    const subagentRows: string[] = [];
    for (const [runId, info] of activeRuns) {
      if (!runBelongsToViewedSession(info)) {
        continue;
      }
      const sk = info.sessionKey ?? "";
      const isSubagentDescendant =
        sk.includes(":subagent:") &&
        !!sessionKey &&
        sk.startsWith(sessionKey.replace(/:main$/, "") + ":subagent:");
      const color = PROVIDER_COLORS[info.provider] || "#6b7280";
      const elapsed = Math.floor((Date.now() - info.startedAt) / 1000);
      const name = modelName(info.model);
      const recipeLabel = activeRecipeStep ? ` &middot; ${esc(activeRecipeStep)}` : "";
      const subagentTag = isSubagentDescendant
        ? ` <span class="thinking-subagent-tag" title="subagent">▸</span>`
        : "";
      const badge =
        info.state === "restarting" ? `<span class="restart-badge">RESTARTING</span>` : "";
      const row = `<div class="thinking-run${isSubagentDescendant ? " thinking-run-subagent" : ""}" data-run-id="${esc(runId)}" data-provider="${esc(info.provider)}" style="--thinking-dot-color:${color};--thinking-glow:${color}40;--thinking-glow-bg:${color}20;--thinking-glow-bg2:${color}30">
  <div class="thinking-dots"><span></span><span></span><span></span></div>
  <span class="thinking-model">${providerIcon(info.provider)} ${esc(name)}${subagentTag}${recipeLabel}</span>
  ${badge}<span class="thinking-elapsed">${elapsed}s</span>
  <span class="thinking-stop">Stop</span>
</div>`;
      if (isSubagentDescendant) {
        subagentRows.push(row);
      } else {
        mainRows.push(row);
      }
    }
    const rows = [...mainRows, ...subagentRows].join("");
    if (rows) {
      return `<div class="thinking-indicator">${rows}</div>`;
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
        if (m._isWarning || m._isError || m._isOverloadRetry || m._isPrefrontal) {
          continue;
        }
        assistantTextIndices.push(j);
      }
      // During streaming, render all bubbles as normal assistant (no thinking style).
      // After finalization, all except the last become thinking → reasoning group.
      const isCurrentRun = i === messages.length && streamMsgIdx >= 0;
      const intermediates = isCurrentRun ? [] : assistantTextIndices.slice(0, -1);
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

  if (activeRuns.size > 0 || sending) {
    h += renderThinkingIndicator();
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
    updateChat();
    updateBtn();
    updateSelect();
    updateSessionsPanel();
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
    updateChat();
    updateBtn();
    updateSelect();
  }

  renderTabs();
  saveTabs();
  // FORK 2026-05-17: the viewed session changed — prefrontal filters by the
  // viewed sessionKey under "session" scope, but it only re-rendered on WS
  // events, so it showed the prior session's activity ("thinking no matter
  // which session I select"). Re-render now. See bible panels.md §147.
  updatePrefrontalTree();
}

function createTab(): Tab {
  // FORK: Eagerly assign a session key so the tab appears in the
  // sessions panel immediately. Gateway auto-creates on first chat.send.
  const tab: Tab = {
    id: generateTabId(),
    sessionKey: `tinker:${Date.now().toString(36)}`,
    title: randomFortune(),
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
  if (sess?.label) {
    tab.title = sess.label.slice(0, 30);
  }

  sessionKey = key;
  messages = [];
  updateChat();
  loadChat();
  updateSelect();
  updateSessionsPanel();
  renderTabs();
  saveTabs();
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

  // Fallback chain: primary + fallbacks
  const chain: string[] = [];
  if (primary) {
    chain.push(primary);
  }
  if (fallbacks?.length) {
    chain.push(...fallbacks);
  }

  if (chain.length) {
    const open = !collapsedModelSections.has("fallback");
    const _badges = [
      "\u2460",
      "\u2461",
      "\u2462",
      "\u2463",
      "\u2464",
      "\u2465",
      "\u2466",
      "\u2467",
    ];
    html += `<div class="model-group${open ? " open" : ""}" data-section="fallback">`;
    html += '<div class="model-group-label">FALLBACK CHAIN</div>';
    html += '<div class="model-group-body">';
    for (let i = 0; i < chain.length; i++) {
      renderAuthKeyRows(chain[i], "");
    }
    html += "</div></div>";
  }

  // Other configured models (not in fallback chain), sorted by performance tier
  const chainSet = new Set(chain);
  const otherIds = Object.keys(models || {}).filter((id) => !chainSet.has(id));
  if (otherIds.length) {
    const open = !collapsedModelSections.has("configured");
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
    html += `<div class="model-group${open ? " open" : ""}" data-section="configured">`;
    html += '<div class="model-group-label">CONFIGURED</div>';
    html += '<div class="model-group-body">';
    for (const id of otherIds) {
      renderAuthKeyRows(id, "");
    }
    html += "</div></div>";
  }

  html += `</div><div class="budget-updated">Updated ${new Date().toLocaleTimeString()}</div>`;
  el.innerHTML = html;

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

function updateSessionsPanel() {
  const el = $("sessions-list");
  if (!el) {
    return;
  }
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
        if (row) {
          row.style.opacity = "0.3";
        }
        try {
          // FORK (2026-04-24): soft delete — archive transcript on disk
          // instead of wiping it. The UI still treats the session as gone
          // (list refreshes, affected tab closes), but on the next sessions
          // mutation the transcript survives at `sessions-archive/` so we
          // can recover if the click was a misfire or if an in-flight turn
          // was still writing its answer.
          await req("sessions.delete", { key, deleteTranscript: false });
          // Close any tab that was using this session
          const affectedTab = tabs.find((t) => t.sessionKey === key);
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
          console.error("Failed to delete session:", err);
          if (row) {
            row.style.opacity = "1";
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
        const sess = sessions.find((s: unknown) => s.key === key);
        if (sess?.label) {
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

function renderSessionRow(s: unknown, shortLabel: string): string {
  const isActive = s.key === sessionKey || sessionKeyMatches(s.key);
  const isTinkerSession = /:tinker:/.test(s.key) || (s.key && s.key.startsWith("tinker:"));
  const tinkerTab = isTinkerSession ? tabs.find((t) => t.sessionKey === s.key) : null;
  const isMainSession = s.key.endsWith(":main");
  const mainTab = isMainSession ? tabs.find((t) => t.id === "tab-main") : null;
  const label = isMainSession
    ? mainTab?.title || "🏠 Main"
    : tinkerTab?.title || s.label || s.displayName || shortLabel;
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
  return `<div class="session-row${isActive ? " session-active" : ""}${liveClass}" data-session-key="${esc(s.key)}"${liveStyle}>
    <span class="session-label" data-hint="${esc(label)}">${esc(label)} ${channel}</span>
    <span class="session-stats">${tokens}${tokens && age ? " · " : ""}${age}</span>
    <button class="session-delete-btn" data-delete-key="${esc(s.key)}" data-hint="Delete session">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>
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
      <div class="toolbox">
        <!-- FORK 2026-05-12: Exec mode promoted to the leftmost slot — it is
             the primary "mode" toggle in the topbar (per SPEC §0a / §7.1),
             so it sits before the per-feature toggles. -->
        <span id="tb-exec" class="topbar-icon-btn" data-hint="Exec mode — Control Panel HUD">🎯</span>
        <!-- FORK 2026-04-18: Amygdala + Fractal injection toggles.
             Enabled = Jarvis replies with 💬 ANSWER + 🧠 AMYGDALA (gut-read)
             + 🌿 FRACTAL (post-reflection). Disable for speed. -->
        <span id="tb-amygdala" class="topbar-icon-btn tb-active" data-hint="Amygdala (gut read)">🧠</span>
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
        <div class="rpanel-header">🌳 Prefrontal <span id="prefrontal-count" class="sessions-count"></span>
          <span class="ct-switch" id="prefrontal-scope-toggle">
            <span class="ct-switch-label ct-switch-label--active" data-scope="session">Session</span>
            <span class="ct-switch-track" data-scope-track><span class="ct-switch-thumb"></span></span>
            <span class="ct-switch-label" data-scope="all">All</span>
          </span>
        </div>
        <div id="prefrontal-graph" class="rpanel-body prefrontal-graph-container"></div>
        <div id="recipe-progress" class="recipe-progress-container" style="display:none"></div>
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
  try {
    ta.value = localStorage.getItem(DRAFT_STORAGE_KEY) || "";
  } catch {}
  function autoResizeTA() {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }
  ta.addEventListener("input", () => {
    autoResizeTA();
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, ta.value);
    } catch {}
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
        send(ta.value);
        ta.value = "";
        ta.style.height = "auto";
        try {
          localStorage.removeItem(DRAFT_STORAGE_KEY);
        } catch {}
      }
    }
  });
  $("action-btn")!.addEventListener("click", () => {
    if (ta.value.trim()) {
      send(ta.value);
      ta.value = "";
      ta.style.height = "auto";
      try {
        localStorage.removeItem(DRAFT_STORAGE_KEY);
      } catch {}
      ta.focus();
    }
  });
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

  // ─── Amygdala + Fractal injection toggles (FORK 2026-04-18) ───
  const amyBtn = $("tb-amygdala")!;
  const fraBtn = $("tb-fractal")!;
  applyInjectToggleChrome();
  amyBtn.addEventListener("click", () => {
    injectToggles = { ...injectToggles, amygdala: !injectToggles.amygdala };
    saveInjectToggles(injectToggles);
    applyInjectToggleChrome();
  });
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
          <div id="exec-axis-targets" class="exec-axis-targets" aria-hidden="true"></div>
          <div class="exec-add-group-wrap">
            <button id="exec-add-group-toggle" class="exec-add-group-toggle">+ Add group</button>
            <form id="exec-add-group-form" class="exec-add-group-form" style="display:none">
              <input id="exec-add-group-label" type="text" placeholder="Group label (max 32 chars)" maxlength="32" required />
              <button type="submit" class="exec-add-group-submit">Add</button>
              <button type="button" id="exec-add-group-cancel" class="exec-add-group-cancel">Cancel</button>
            </form>
          </div>
          <div id="exec-tasks-body" class="exec-tasks-body">Loading…</div>
          <div class="exec-task-add-bar" id="exec-task-add-bar">
            <button class="exec-task-add-toggle" id="exec-task-add-toggle" title="Add a new task">+ Add task</button>
            <form class="exec-task-add-form" id="exec-task-add-form" style="display:none">
              <input type="text" id="exec-add-text" class="exec-add-text" placeholder="Task title…" autocomplete="off" maxlength="240">
              <div class="exec-add-fields">
                <select id="exec-add-axis" class="exec-add-axis" title="Axis"></select>
                <input type="number" id="exec-add-est" class="exec-add-est" placeholder="min" min="5" max="480" step="5" value="30" title="Est minutes">
                <input type="date" id="exec-add-due" class="exec-add-due" title="Due date (optional)">
                <button type="button" class="exec-add-cancel" id="exec-add-cancel" title="Cancel">✕</button>
                <button type="submit" class="exec-add-save" id="exec-add-save" title="Add task">➕</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;
    app.appendChild(el);
    execPanelEl = el;
    attachExecDragHandlers(el);
    renderExecFilterBar();
    attachExecTaskAddHandlers(el);
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
      const sinceTs = now - 1000 * 60 * 60 * 24 * 30; // 30 days
      const obsLists = await Promise.all(
        visible.map(async (m) => {
          try {
            const r = (await req("control-panel.query", {
              id: m.id,
              from_ts: sinceTs,
              limit: 200,
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
      const graphHtml = obsLists
        .filter(({ metric }) => isGraphTemplate(metric.template))
        .map(({ metric, observations }) => renderKpiRow(metric, observations, "tall"))
        .join("");
      kpisBody.innerHTML = kpiHtml || `<div class="exec-kpi-empty">No KPIs configured yet.</div>`;
      graphsBody.innerHTML =
        graphHtml || `<div class="exec-kpi-empty">No graphs configured yet.</div>`;
      kpisBody.dataset.populated = "1";
      graphsBody.dataset.populated = "1";
      // FORK 2026-05-13 — Tall sparklines get wheel-zoom + drag-pan handlers
      // after each render. attachGraphInteractions is idempotent per element.
      attachGraphInteractions(panel);
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
        return t.status !== "back_burner";
      case "all_today":
      default: {
        // FORK 2026-05-14 — "All today" means tasks for today's plate:
        // overdue, due today, or undated. A task rescheduled to a future
        // date must drop out of this list, otherwise the chip is identical
        // to "All" minus snoozed.
        if (t.status === "dismissed" || t.status === "dropped" || t.status === "back_burner") {
          return false;
        }
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

  const EXEC_AXIS_LABEL: Record<string, string> = {
    ventures: "🚀 Ventures",
    online: "💰 Online",
    family: "👨‍👩‍👧 Family",
    me: "🏃 Me",
    serra: "🏭 SERRA",
    meta: "⚙️ Meta",
  };
  // FORK 2026-05-11 (v3.1.1) — 'ventures' added as the FIRST axis at user's
  // request: new income / business development. Distinct from 'online' (which
  // tracks leading indicators of EXISTING online streams — GitHub stars,
  // TinkerZone visits, YouTube subs). Ventures = new revenue experiments.
  const EXEC_AXIS_ORDER = ["ventures", "online", "family", "me", "serra", "meta"];
  const EXEC_STATUS_ICON: Record<string, string> = {
    open: "⬜",
    in_progress: "🟡",
    resolved: "✅",
    // FORK 2026-05-13 — single 🗑 for both deleted statuses (new 'dropped'
    // writes + legacy 'dismissed' rows). See the Deleted filter chip.
    dropped: "🗑",
    dismissed: "🗑",
    back_burner: "💤",
  };

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
              `<div class="exec-subgroup${subCollapsed ? " exec-group-collapsed" : ""}" data-axis="${escapeExecAttr(sub.id)}">` +
              `<div class="exec-subgroup-header" data-axis-id="${escapeExecAttr(sub.id)}">` +
              `<span class="exec-group-disclosure">${subCollapsed ? "▶" : "▼"}</span>` +
              `<span class="exec-subgroup-label">${escapeHtml(sub.label)}</span>` +
              `<span class="exec-group-count">${subCount} open</span>` +
              `</div>` +
              (subCollapsed
                ? ""
                : subTasks || `<div class="exec-group-empty">(empty — drag tasks here)</div>`) +
              `</div>`
            );
          })
          .join("");
        return (
          `<div class="exec-group${groupCollapsed ? " exec-group-collapsed" : ""}" data-axis="${escapeExecAttr(group.id)}">` +
          `<div class="exec-group-header" data-axis-id="${escapeExecAttr(group.id)}">` +
          `<span class="exec-group-disclosure">${groupCollapsed ? "▶" : "▼"}</span>` +
          `<span class="exec-group-label">${escapeHtml(group.label)}</span>` +
          `<span class="exec-group-count">${groupOpenCount} open` +
          `<button class="exec-group-add-sub" data-action="add-subgroup" data-parent-id="${escapeExecAttr(group.id)}" title="Add sub-group under ${escapeExecAttr(group.label)}">+</button>` +
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
          const target = ev.target as HTMLElement;
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
          const id = h.dataset.axisId;
          if (!id) return;
          const key = `tinker.execGroupCollapsed.${id}`;
          const cur = localStorage.getItem(key) === "1";
          if (cur) localStorage.removeItem(key);
          else localStorage.setItem(key, "1");
          void loadExecTasks();
        });
      });
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
        status: ["open", "in_progress", "resolved", "dismissed", "dropped", "back_burner"],
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
        // Fallback: if axes table is empty (fresh DB or RPC failure), synthesize
        // a flat list from the hardcoded EXEC_AXIS_ORDER so the panel still
        // groups sensibly. parent_id is null for every fallback axis.
        if (axesFlat.length === 0) {
          axesFlat = EXEC_AXIS_ORDER.map((id, i) => ({
            id,
            label: EXEC_AXIS_LABEL[id] ?? id,
            position: i,
            parent_id: null,
          }));
        }
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
    } catch (err) {
      // FORK 2026-05-11 — distinguish transient "WS not connected yet" from
      // real errors. The req() helper rejects with literal "disconnected"
      // before the WS handshake completes; show a calm green loading state
      // and schedule a fast retry instead of a red error.
      const msg = String(err);
      if (msg === "disconnected" || msg.includes("disconnected")) {
        body.innerHTML = `<div class="exec-loading">⏳ Loading tasks — connecting to gateway…</div>`;
        setTimeout(() => {
          void loadExecTasks();
        }, 1500);
      } else {
        body.innerHTML = `<div class="exec-error">Failed to load tasks: ${escapeHtml(msg)}</div>`;
      }
    }
  }

  // ─── Drag & drop: reorder tasks AND move them across axes ───
  // FORK 2026-05-11 — native HTML5 DnD on `.exec-task` rows. On drop, we
  // compute the new (axis, rank) from the cursor position and send one
  // `control-panel.tasks.update` RPC. Rank uses midpoint arithmetic between
  // neighbors so frequent drops don't require renumbering; ranks are clamped
  // to a sane range and re-sequenced lazily on the next renderer pass.
  type DragState = { id: string; axis: string; rank: number } | null;
  let execDrag: DragState = null;
  let execDropIndicator: HTMLElement | null = null;
  let execDragRefreshSuppressed = false;

  function attachExecDragHandlers(panel: HTMLElement) {
    const body = panel.querySelector("#exec-tasks-body") as HTMLElement;
    const axisTargets = panel.querySelector("#exec-axis-targets") as HTMLElement;

    body.addEventListener("dragstart", (e) => {
      const t = (e.target as HTMLElement).closest(".exec-task") as HTMLElement | null;
      if (!t) {
        console.info("[exec-drag] dragstart fired but e.target has no .exec-task ancestor");
        return;
      }
      execDrag = {
        id: t.dataset.taskId!,
        axis: t.dataset.axis!,
        rank: parseFloat(t.dataset.rank ?? "50"),
      };
      console.info("[exec-drag] dragstart", {
        id: execDrag.id,
        axis: execDrag.axis,
        rank: execDrag.rank,
      });
      t.classList.add("exec-task-dragging");
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/x-task-id", execDrag.id);
      execDragRefreshSuppressed = true; // pause poll-refresh during drag
      renderAxisTargets(axisTargets, execDrag.axis);
    });

    body.addEventListener("dragend", (e) => {
      const t = (e.target as HTMLElement).closest(".exec-task") as HTMLElement | null;
      if (t) t.classList.remove("exec-task-dragging");
      hideAxisTargets(axisTargets);
      clearDropIndicator();
      execDrag = null;
      execDragRefreshSuppressed = false;
    });

    body.addEventListener("dragover", (e) => {
      if (!execDrag) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      updateDropIndicator(e, body);
    });

    body.addEventListener("dragleave", (e) => {
      if (!execDrag) return;
      // Only clear if leaving the entire tasks body
      if (e.target === body) clearDropIndicator();
    });

    body.addEventListener("drop", async (e) => {
      e.preventDefault();
      if (!execDrag) {
        console.info("[exec-drag] drop fired but execDrag is null — drag state lost");
        return;
      }
      const target = computeBodyDrop(e, body);
      console.info("[exec-drag] drop", { id: execDrag.id, currentRank: execDrag.rank, target });
      clearDropIndicator();
      hideAxisTargets(axisTargets);
      if (!target) {
        console.info(
          "[exec-drag] drop bailed — no computed target (indicator was outside any .exec-group)",
        );
        execDrag = null;
        execDragRefreshSuppressed = false;
        return;
      }
      const movedId = execDrag.id;
      await applyTaskMove(movedId, target.axis, target.rank);
      execDrag = null;
      execDragRefreshSuppressed = false;
      await loadExecTasks();
    });

    // Axis-targets row (visible only during a drag — catches drops to
    // axes that have no rendered tasks yet)
    axisTargets.addEventListener("dragover", (e) => {
      if (!execDrag) return;
      const chip = (e.target as HTMLElement).closest(".exec-axis-target") as HTMLElement | null;
      if (!chip) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      axisTargets
        .querySelectorAll(".exec-axis-target")
        .forEach((c) => c.classList.remove("exec-axis-target-over"));
      chip.classList.add("exec-axis-target-over");
    });

    axisTargets.addEventListener("dragleave", () => {
      axisTargets
        .querySelectorAll(".exec-axis-target")
        .forEach((c) => c.classList.remove("exec-axis-target-over"));
    });

    axisTargets.addEventListener("drop", async (e) => {
      if (!execDrag) return;
      const chip = (e.target as HTMLElement).closest(".exec-axis-target") as HTMLElement | null;
      if (!chip) return;
      e.preventDefault();
      const axis = chip.dataset.axis!;
      hideAxisTargets(axisTargets);
      clearDropIndicator();
      // Drop on axis chip → bottom of that axis group
      await applyTaskMove(execDrag.id, axis, /*newRank*/ 9999);
      execDrag = null;
      execDragRefreshSuppressed = false;
      await loadExecTasks();
    });
  }

  function renderAxisTargets(host: HTMLElement, currentAxis: string) {
    const chips = EXEC_AXIS_ORDER.map(
      (a) =>
        `<span class="exec-axis-target${a === currentAxis ? " exec-axis-target-current" : ""}" data-axis="${a}">${EXEC_AXIS_LABEL[a] ?? a}</span>`,
    ).join("");
    host.innerHTML = chips;
    host.classList.add("exec-axis-targets-visible");
  }
  function hideAxisTargets(host: HTMLElement) {
    host.classList.remove("exec-axis-targets-visible");
  }

  function ensureDropIndicator(body: HTMLElement): HTMLElement {
    if (execDropIndicator && execDropIndicator.isConnected) return execDropIndicator;
    const ind = document.createElement("div");
    ind.className = "exec-drop-indicator";
    body.appendChild(ind);
    execDropIndicator = ind;
    return ind;
  }
  function clearDropIndicator() {
    if (execDropIndicator?.parentElement) {
      execDropIndicator.parentElement.removeChild(execDropIndicator);
    }
    execDropIndicator = null;
  }

  function updateDropIndicator(e: DragEvent, body: HTMLElement) {
    const targetTask = (e.target as HTMLElement).closest(".exec-task") as HTMLElement | null;
    const ind = ensureDropIndicator(body);
    if (targetTask) {
      const rect = targetTask.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        targetTask.parentElement!.insertBefore(ind, targetTask);
      } else {
        targetTask.parentElement!.insertBefore(ind, targetTask.nextSibling);
      }
      return;
    }
    const groupHeader = (e.target as HTMLElement).closest(
      ".exec-group-header",
    ) as HTMLElement | null;
    if (groupHeader) {
      // Drop at top of group
      groupHeader.parentElement!.insertBefore(ind, groupHeader.nextSibling);
      return;
    }
    const group = (e.target as HTMLElement).closest(".exec-group") as HTMLElement | null;
    if (group) {
      // Drop at bottom of group
      group.appendChild(ind);
    }
  }

  function computeBodyDrop(
    e: DragEvent,
    _body: HTMLElement,
  ): { axis: string; rank: number } | null {
    const ind = execDropIndicator;
    if (!ind || !ind.parentElement) return null;
    const group = ind.parentElement.closest(".exec-group") as HTMLElement | null;
    if (!group) return null;
    const axis = group.dataset.axis ?? "meta";
    // FORK 2026-05-12 — skip the dragging task itself when looking for
    // prev/next siblings. The dragging row stays in the DOM (faded via
    // .exec-task-dragging) until dragend, so a "drop just above myself"
    // gesture would otherwise see `next = me` and compute newRank as the
    // midpoint of (taskAbove, myCurrentRank) — which is mathematically a
    // move but produces zero visible reordering because nothing else lives
    // between the two. Skipping it makes the rank land between my actual
    // outer neighbours, so the row actually shifts position on re-render.
    let prev = ind.previousElementSibling as HTMLElement | null;
    while (prev && prev.classList.contains("exec-task-dragging")) {
      prev = prev.previousElementSibling as HTMLElement | null;
    }
    let next = ind.nextElementSibling as HTMLElement | null;
    while (next && next.classList.contains("exec-task-dragging")) {
      next = next.nextElementSibling as HTMLElement | null;
    }
    const prevRank =
      prev && prev.classList.contains("exec-task") ? parseFloat(prev.dataset.rank ?? "0") : -10;
    const nextRank =
      next && next.classList.contains("exec-task")
        ? parseFloat(next.dataset.rank ?? "100")
        : prevRank + 20;
    return { axis, rank: (prevRank + nextRank) / 2 };
  }

  function renderExecTaskRow(t: ExecTask, axis: string): string {
    const icon = EXEC_STATUS_ICON[t.status] ?? "•";
    const est = t.est_minutes ? `${t.est_minutes}m` : "";
    const isExpanded = execExpandedId === t.id;
    // FORK 2026-05-14 — collapsed row now surfaces a 📅 due-date chip when
    // due_date is set (user feedback: the rescheduled date should be visible
    // on the card without expanding). Past-due dates get an overdue tint.
    const dueChip = (() => {
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
      return `<span class="exec-chip exec-chip-due${isOverdue ? " exec-chip-due-overdue" : ""}" title="Due ${escapeHtml(datePart)}">📅 ${label}</span>`;
    })();
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
    return `<div class="exec-task${isExpanded ? " exec-task-expanded" : ""}" draggable="true"
              data-task-id="${escapeExecAttr(t.id)}"
              data-status="${t.status}"
              data-axis="${axis}"
              data-rank="${t.priority_rank}">
        <div class="exec-task-head">
          <span class="exec-task-grip" title="Drag to reorder or move axis">⋮⋮</span>
          ${checkbox}
          <span class="exec-task-icon">${icon}</span>
          <span class="exec-task-text" title="${escapeExecAttr(t.text)}">${escapeHtml(t.text)}</span>
          <button class="exec-task-pencil" data-action="edit-title" title="Edit title">✏️</button>
          <span class="exec-task-chips">
            ${dueChip}
            ${est ? `<span class="exec-chip exec-chip-est" title="Estimated ${est}">${est}</span>` : ""}
            <button class="exec-task-menu" data-action="menu" title="More actions">⋯</button>
          </span>
        </div>
        ${isExpanded ? renderExecDrawer(t) : ""}
      </div>`;
  }

  function renderExecDrawer(t: ExecTask): string {
    // FORK 2026-05-11 — drawer shows full task title (wrapped) above the
    // context, plus an inline pencil button at the end of BOTH title and
    // context for in-place edits. The free-standing "Edit text" action
    // button is removed; pencils replace it.
    const fullTitleBlock = `
      <div class="exec-task-fulltitle">
        <span class="exec-task-fulltitle-text">${escapeHtml(t.text)}</span>
        <button class="exec-task-pencil exec-task-pencil-inline" data-action="edit-title" title="Edit title">✏️</button>
      </div>`;
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
        ${fullTitleBlock}
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

  // FORK 2026-05-11 — Inline "+ Add task" form at the bottom of the tasks
  // section. Toggle button reveals an inline form (text + axis + est_min +
  // due_date). Submit calls control-panel.tasks.add and refreshes. ESC or
  // Cancel button closes.
  function attachExecTaskAddHandlers(panel: HTMLElement): void {
    const toggle = panel.querySelector("#exec-task-add-toggle") as HTMLButtonElement | null;
    const form = panel.querySelector("#exec-task-add-form") as HTMLFormElement | null;
    const text = panel.querySelector("#exec-add-text") as HTMLInputElement | null;
    const axis = panel.querySelector("#exec-add-axis") as HTMLSelectElement | null;
    const est = panel.querySelector("#exec-add-est") as HTMLInputElement | null;
    const due = panel.querySelector("#exec-add-due") as HTMLInputElement | null;
    const cancel = panel.querySelector("#exec-add-cancel") as HTMLButtonElement | null;
    if (!toggle || !form || !text || !axis || !est || !due || !cancel) return;

    // Populate axis dropdown
    axis.innerHTML = EXEC_AXIS_ORDER.map(
      (a) => `<option value="${a}">${EXEC_AXIS_LABEL[a] ?? a}</option>`,
    ).join("");
    // Remember the last-used axis between adds (default: ventures — most-active axis post-Todoist-import)
    const lastAxis = localStorage.getItem("tinker.execAddAxis") || "ventures";
    axis.value = lastAxis;

    const openForm = () => {
      form.style.display = "";
      toggle.style.display = "none";
      text.focus();
    };
    const closeForm = () => {
      form.style.display = "none";
      toggle.style.display = "";
      text.value = "";
      est.value = "30";
      due.value = "";
    };

    toggle.addEventListener("click", openForm);
    cancel.addEventListener("click", closeForm);
    text.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeForm();
      }
    });

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const payload: Record<string, unknown> = {
        text: text.value.trim(),
        priority_axis: axis.value,
      };
      if (!payload.text) {
        text.focus();
        return;
      }
      const estVal = parseInt(est.value, 10);
      if (Number.isFinite(estVal) && estVal > 0) payload.est_minutes = estVal;
      if (due.value) payload.due_date = due.value;
      localStorage.setItem("tinker.execAddAxis", axis.value);
      try {
        await req("control-panel.tasks.add", payload);
        closeForm();
        void loadExecTasks();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[exec] tasks.add failed", err);
        text.classList.add("exec-add-text-error");
        setTimeout(() => text.classList.remove("exec-add-text-error"), 1500);
      }
    });
  }

  // FORK 2026-05-22 (Task 11) — inline "+ Add group" form at the top of the
  // tasks section. Toggles a one-line input that derives a slug-id from the
  // label and creates a top-level axis (parent_id implicitly null). Duplicate
  // ids surface via the same error-flash pattern as attachExecTaskAddHandlers.
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
        tipLines.push(`📅 EVENTS (${Math.round(calMinutes)}min):`);
        for (const ev of timedEvents.slice(0, 8))
          tipLines.push(`  • ${formatHHMM(ev.start_ts)} ${ev.title}`);
      }
      if (taskBucket.samples.length > 0) {
        tipLines.push("");
        tipLines.push(`📋 TASKS (${Math.round(taskBucket.minutes)}min):`);
        for (const task of taskBucket.samples)
          tipLines.push(`  • ${task.est_minutes ?? "?"}m  ${task.text.slice(0, 50)}`);
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
        const t = ev.target as HTMLElement;
        if (
          t.closest(".exec-task-menu") ||
          t.closest(".exec-task-grip") ||
          t.closest(".exec-task-pencil") ||
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
      // FORK 2026-05-22 — collapsed-head checkbox. Stops propagation so the
      // head's expand-toggle listener doesn't also fire, then routes through
      // handleExecTaskAction with the toggle-resolve action.
      row.querySelectorAll<HTMLElement>(".exec-task-check").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void handleExecTaskAction(id, btn.dataset.action!);
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
          ${EXEC_AXIS_ORDER.map((axis) => `<button data-action="reassign-${axis}" class="exec-context-item">${EXEC_AXIS_LABEL[axis]}</button>`).join("")}
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
        if (!t) return;
        const next = window.prompt("Edit task title:", t.text);
        if (next && next.trim() && next !== t.text) {
          await req("control-panel.tasks.update", { id: taskId, text: next.trim() });
        } else {
          return;
        }
      } else if (action === "edit-context") {
        if (!t) return;
        const next = window.prompt("Edit description (markdown supported):", t.context_md ?? "");
        if (next === null) return; // user cancelled
        const trimmed = next.trim();
        await req("control-panel.tasks.update", {
          id: taskId,
          context_md: trimmed.length > 0 ? trimmed : null,
        });
      } else if (action === "refer-in-chat") {
        if (!t) return;
        const textarea = document.getElementById("chat-textarea") as HTMLTextAreaElement | null;
        if (textarea) {
          textarea.value = `Re: ${t.text}`;
          textarea.focus();
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
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
    console.info("[exec-drag] applyTaskMove →", { taskId, axis, rank: clamped });
    try {
      await req("control-panel.tasks.update", {
        id: taskId,
        priority_axis: axis,
        priority_rank: clamped,
      });
      console.info("[exec-drag] applyTaskMove OK");
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
    | "recipes";

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
                  ${["", "low", "medium", "high"].map((v) => `<option value="${v}"${v === thinkLv ? " selected" : ""}>${v || "auto"}</option>`).join("")}
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
      }
      const newKey = `tinker:${Date.now().toString(36)}`;
      tab.sessionKey = newKey;
      tab.isAttached = true;
      sessionKey = newKey;
      tab.title = randomFortune();
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
      const res = await req<{ kits: NormalizedKit[] }>("prefrontal.kit.list", {});
      allKits = res.kits ?? [];
    } catch {
      listErr = true;
    }

    sub.textContent = `${allKits.length} kits`;

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
      h += `<span class="recipe-name">${altEsc(displayName)}</span>`;
      if (isDownloaded) {
        h += `<span class="recipe-kit-external" title="Downloaded kit">↗</span>`;
      }
      h += `<span class="recipe-trigger">${altEsc(displayTrigger)}</span>`;
      h += `</div>`;
      if (hasSummary) {
        h += `<div class="recipe-summary">${altEsc(kit.summary.trim())}</div>`;
      } else {
        h += `<div class="recipe-summary-placeholder">(no summary in kit.md)</div>`;
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
        html += `<div class="recipe-no-results">No kits match "${altEsc(ql)}"</div>`;
      }

      html += `</div>`;

      // Preserve search input across filter updates
      const existingSearch = body.querySelector(".recipe-search-input") as HTMLInputElement | null;
      if (!existingSearch) {
        const searchRow = `<div class="recipe-search-row"><input class="recipe-search-input" type="search" placeholder="Search kits by name, slug, tags…" value="${altEsc(q)}" autocomplete="off" spellcheck="false"></div>`;
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
        if (!summary) summaryEl.textContent = "(no summary in kit.md)";

        // Render body via markdown-it
        const body = kitBodyOnly(data.content);
        viewEl.innerHTML = mdParser.render(body);

        // Warn chip for downloaded kits — shown only in edit tab
        if (isDownloaded) {
          const chip = document.createElement("div");
          chip.className = "kit-modal-warn-chip";
          chip.textContent =
            "⚠ Editing a downloaded kit. Changes are local and will be overwritten if you reinstall.";
          rawEl.prepend(chip);
        }
      } catch (err) {
        titleEl.textContent = "Error loading kit";
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
          summaryEl.textContent = newSummary || "(no summary in kit.md)";
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
