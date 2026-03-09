import MarkdownIt from "markdown-it";
import { mountContextTimeline } from "./panels/context-timeline.js";
// Tinker UI — Command Center v0.3
import { mountContextTreemap } from "./panels/context-treemap.js";
import { mountOverseerGraph, type OverseerItem } from "./panels/overseer-graph.js";
import { mountResponseTreemap } from "./panels/response-treemap.js";

const mdParser = MarkdownIt({ html: false, linkify: true, breaks: true });

// Runtime config: injected by the tinker plugin into index.html, or via URL params
const __cfg = (window as any).__TINKER_CONFIG ?? {};
const TOKEN = __cfg.token ?? new URLSearchParams(window.location.search).get("token") ?? "";
// In dev mode (vite), connect WS directly to the gateway; in prod the plugin serves from the gateway itself
const GW_WS = import.meta.env.DEV
  ? `ws://localhost:18789`
  : `ws${window.location.protocol === "https:" ? "s" : ""}://${window.location.host}`;
const BASE = import.meta.env.BASE_URL ?? "/";

let ws: WebSocket | null = null;
let connected = false;
let pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
let sessionKey = "";
let sessions: any[] = [];
let messages: any[] = [];
/** Index into messages[] of the current streaming temporary message, or -1 if none. */
let streamMsgIdx = -1;
let streamRunId: string | null = null;
/** Tracks how much of the server's accumulated text is already shown in frozen temp messages. */
let frozenTextEnd = 0;
/** Length of the last full delta text received (used to set frozenTextEnd on tool freeze). */
let lastDeltaLen = 0;
let sending = false;
let currentTurnNumber = 0;
let expandedTools = new Set<string>();
let initialized = false;
let budgetData: any = null;
let budgetUsageData: any = null;
let forensicMode = false;
let timelineCtrl: ReturnType<typeof mountContextTimeline> | null = null;

// ─── Tab State ───
interface Tab {
  id: string;
  sessionKey: string | null; // null = unattached
  title: string;
  isAttached: boolean;
}

const FORTUNE_COOKIES = [
  // ─── Breakthroughs & Solutions ───
  "🔓 A stubborn problem surrenders today",
  "💡 An idea hits you mid-conversation",
  "🧩 The missing piece shows itself",
  "⚡ A shortcut saves you hours",
  "🔧 Something broken finally clicks",
  "🎯 You nail it on the first try",
  "🪄 A one-liner replaces a hundred",
  "🔑 The answer was simpler than you thought",
  "🧲 The right tool finds you",
  "🏹 Your instinct proves right",
  "💎 Elegance hides in plain sight",
  "🌊 A wave of clarity washes over you",
  "🔬 You spot what everyone missed",
  "🧪 An experiment pays off big",
  "🎪 The impossible becomes trivial",
  "📐 Everything aligns perfectly",
  "🗝️ A locked door swings open",
  "⏳ Patience rewards you generously",
  "🌀 Confusion spirals into understanding",
  "🛤️ The detour was the shortcut",
  "🧮 A complex formula simplifies beautifully",
  "🪃 What you put out comes back refined",
  "🔩 The last piece falls into place at noon",
  "🧯 A crisis resolves itself before you panic",
  "🪛 The fix you try first actually works",
  // ─── People & Connection ───
  "🤝 Someone offers exactly what you need",
  "💬 A conversation changes everything",
  "📨 Good news arrives unexpectedly",
  "🫂 Someone appreciates your work today",
  "👀 The right person notices your effort",
  "🎤 Your words land perfectly",
  "🌉 A bridge forms where there was none",
  "📞 A message brings a smile",
  "🤲 Help appears without asking",
  "🪢 A loose thread connects two ideas",
  "🎭 You see someone's true brilliance",
  "✉️ An old contact resurfaces at the right time",
  "🏗️ Someone builds on your foundation",
  "📣 Your voice carries further than expected",
  "🧑‍🤝‍🧑 A collaboration sparks something new",
  "💌 Kindness returns to you multiplied",
  "🎁 A gift disguised as a question",
  "🫶 Gratitude finds its way to you",
  "🗣️ You explain it better than ever before",
  "🙌 Someone champions your idea",
  "🧑‍🏫 You teach someone and learn even more",
  "🪞 Someone mirrors your best quality back to you",
  "🎠 A stranger brightens your entire afternoon",
  "🤗 An unexpected hug resets your whole mood",
  "👐 You open your hands and receive abundantly",
  // ─── Energy & Flow ───
  "🔥 You enter the zone effortlessly",
  "🌅 Today starts better than yesterday ended",
  "☕ The first sip sparks momentum",
  "🎵 A rhythm carries you through the work",
  "🌬️ A second wind arrives right on time",
  "⛽ Energy comes from an unexpected source",
  "🏄 You ride a wave of productivity",
  "🎢 The hard part is already behind you",
  "🌤️ The fog lifts earlier than usual",
  "🧘 Calm focus finds you naturally",
  "🏃 Momentum builds without forcing it",
  "🎶 Everything flows in harmony",
  "💫 You surprise yourself with what you finish",
  "🌈 After the grind comes the rainbow",
  "⚖️ Balance finds you today",
  "🕊️ Peace settles into your work",
  "🔋 You recharge faster than expected",
  "🌸 Ease replaces struggle",
  "🏖️ Calm confidence carries you through",
  "🦋 Lightness replaces heaviness",
  "🫗 Tension drains away before lunch",
  "🛁 Rest tonight will feel deeply earned",
  "🍵 A quiet pause yields the best idea of the day",
  "🌡️ Your energy peaks exactly when you need it",
  "🧃 A small treat refuels your entire afternoon",
  // ─── Discovery & Learning ───
  "📖 You learn something that changes how you think",
  "🗺️ A new territory reveals itself",
  "🔭 You see further than before",
  "🌍 A bigger picture comes into focus",
  "📚 One paragraph rewires your understanding",
  "🧭 A new direction feels immediately right",
  "🔎 A small detail unlocks a big insight",
  "🌱 A seed planted long ago sprouts today",
  "🪟 A window opens to a new perspective",
  "🧬 A pattern emerges from the chaos",
  "🗻 You see the summit from here",
  "🔮 Foresight pays dividends today",
  "📡 You pick up a signal others miss",
  "🎓 Mastery sneaks up on you",
  "🌐 Dots connect across domains",
  "🏛️ A foundation proves stronger than expected",
  "🔦 You illuminate a dark corner",
  "📝 Writing crystallizes your thinking",
  "🎨 You see beauty in the structure",
  "🧗 The climb teaches more than the summit",
  "📰 You read something that shifts your worldview",
  "🔍 A footnote contains the real treasure",
  "🪐 You grasp something truly vast today",
  "🧫 A tiny observation leads to a major theory",
  "📻 You tune into a frequency others can't hear",
  // ─── Creation & Building ───
  "🏗️ What you build today outlasts today",
  "🎨 Something you make surprises even you",
  "🛠️ The right abstraction reveals itself",
  "🌳 You plant something that grows on its own",
  "🏠 A solid foundation becomes visible",
  "🧱 One block completes the whole wall",
  "✏️ A rough draft turns out nearly final",
  "🎼 You compose something worth keeping",
  "🪵 Raw material becomes something beautiful",
  "🔩 Moving parts click into place",
  "🎻 Practice becomes performance today",
  "⚒️ You forge something that lasts",
  "🖌️ A rough sketch captures the essence",
  "🪡 You stitch together something whole",
  "🧵 Threads weave into fabric",
  "🏺 Form follows function perfectly",
  "📦 You ship something you're proud of",
  "🗽 You build something that stands alone",
  "🌻 Your creation makes someone's day better",
  "🎹 The pieces play well together",
  "🖋️ You write something worth rereading",
  "🪆 Layers of your work reveal hidden depth",
  "🧰 Everything you need is already in your toolbox",
  "🎸 You riff on an old idea and it becomes new",
  "🪺 Something you nurture takes flight today",
  // ─── Timing & Luck ───
  "🎰 Odds tip in your favor",
  "⏰ Your timing is impeccable today",
  "🌠 A small wish gets granted",
  "🍀 Luck wears a familiar face",
  "🎲 A risk pays off handsomely",
  "🌊 The tide turns in your direction",
  "📈 Numbers move the way you hoped",
  "🎯 You're in the right place at the right time",
  "🌙 The night brings a quiet victory",
  "☀️ Warmth finds you when you need it",
  "🫧 Something bubbles up just in time",
  "🧲 You attract what you were looking for",
  "🕰️ Perfect timing, no rehearsal needed",
  "🌾 You harvest what you forgot you planted",
  "🪙 A small bet yields big returns",
  "🎫 An unexpected door opens",
  "🛎️ Opportunity rings twice today",
  "🦎 You adapt faster than the change",
  "🎪 The stars align for your next move",
  "📬 Something you sent out comes back better",
  "🃏 The wildcard plays in your favor",
  "🎳 One throw knocks everything down perfectly",
  "🪄 Serendipity has your name on it today",
  "🦋 A tiny choice cascades into something wonderful",
  "🎟️ You hold the winning ticket and don't know it yet",
  // ─── Confidence & Growth ───
  "💪 You're stronger than yesterday",
  "🦁 Courage finds you at the right moment",
  "🏆 A quiet win boosts everything after it",
  "🪜 One step up changes the whole view",
  "🛡️ You handle pressure with grace",
  "⚓ Your anchor holds through turbulence",
  "🗡️ You cut through noise with clarity",
  "🏋️ A heavy load feels lighter today",
  "🌟 You shine without trying",
  "🦅 You rise above the noise",
  "💎 Your value becomes undeniable",
  "🧗 The wall you feared is shorter than it looks",
  "🎖️ You earn quiet respect today",
  "🔥 Doubt burns away by afternoon",
  "🪨 You become someone's rock",
  "⚔️ You face a challenge and don't flinch",
  "🗼 You stand taller in your own eyes",
  "🌊 You navigate rough waters with skill",
  "🎗️ Persistence today earns tomorrow's reward",
  "🧊 You stay cool when it matters most",
  "🐉 You slay a dragon you've been avoiding",
  "🪖 Your discipline impresses even yourself",
  "🏅 You outperform your own expectations",
  "🦊 Cleverness gets you through where force couldn't",
  "🐺 Your pack sees you as the leader today",
  // ─── Joy & Surprise ───
  "🎉 Something delightful interrupts the routine",
  "😄 You laugh when you least expect it",
  "🎈 A small moment lifts the whole day",
  "🍰 You savor something unexpected",
  "🎶 A sound brightens your mood",
  "🌺 Beauty appears in an unlikely place",
  "🎊 A minor victory feels major",
  "🍫 Sweetness hides in the mundane",
  "🌻 Someone's smile is contagious today",
  "🎀 A small thing feels like a gift",
  "🫧 Playfulness sneaks into serious work",
  "🌈 Color returns to a grey afternoon",
  "🧁 Treat yourself — you've earned it already",
  "🪁 Something lifts your spirits without effort",
  "✨ Magic hides in the ordinary",
  "🎡 A change of scenery sparks joy",
  "🦜 Something unexpected makes you laugh",
  "🌮 The best meal of the week happens today",
  "🎆 A spark of wonder catches you off guard",
  "🍯 The sweetest moment comes unplanned",
  "🎠 Nostalgia visits and leaves you smiling",
  "🪩 An ordinary moment turns into a celebration",
  "🧸 Comfort finds you in an unexpected form",
  "🎐 A breeze carries away the last of your worries",
  "🎨 You notice a color you've never truly seen before",
  // ─── Wisdom & Clarity ───
  "🧠 A tangled thought untangles itself",
  "🪷 Stillness reveals the answer",
  "📿 An old lesson suddenly makes sense",
  "🏔️ Distance gives perspective",
  "🌙 Sleep brought you closer to the answer",
  "🔮 Intuition outperforms analysis today",
  "📜 A principle you forgot proves timeless",
  "🕯️ A quiet moment brings loud clarity",
  "🪶 Simplicity defeats complexity",
  "🧿 Trust yourself — you know more than you think",
  "🌊 Let it flow and the path appears",
  "🦉 Wisdom arrives disguised as a question",
  "🔔 A gentle reminder changes your course",
  "🌗 What seemed unclear becomes obvious",
  "📏 You measure what matters",
  "🪬 Protection comes from preparation",
  "⚗️ Complexity distills into simplicity",
  "🎑 Reflection reveals the next step",
  "🧊 A cool head wins a warm victory",
  "🌄 The answer arrives at dawn",
  "🪔 An inner light guides you through the dark",
  "🕸️ Everything is more connected than you realized",
  "📀 An old memory holds today's solution",
  "🧂 A grain of truth changes the whole flavor",
  "🪨 Solid ground appears exactly where you step",
  // ─── The Seer Speaks ───
  "🔮 Today you meet a very special person",
  "🌟 Your act of kindness today will be paid tenfold",
  "🃏 A stranger holds the key to your next chapter",
  "🕊️ Someone you haven't thought of in years thinks of you today",
  "💫 The universe conspires in your favor this afternoon",
  "🌙 Tonight you understand something you've wondered about for years",
  "🔔 A bell rings somewhere and your luck changes",
  "🧿 An invisible shield protects you from a mistake you'll never know about",
  "🪬 Someone is about to enter your life who changes it forever",
  "🌠 A wish you made long ago begins to manifest",
  "🕯️ A candle you forgot you lit still burns for you",
  "🦋 A decision you make before sunset ripples for years",
  "🌺 Someone falls in love with your mind today",
  "🔮 You will say exactly the right thing at exactly the right moment",
  "🌙 The dream you had last night was more real than you think",
  "✨ Something you lost returns in a better form",
  "🕸️ Invisible hands are weaving your success right now",
  "🧭 A wrong turn today leads to the right destination",
  "🌿 Healing happens in a place you didn't expect",
  "🔥 A fire inside you reignites today",
  "💎 Someone recognizes a diamond in you that you forgot was there",
  "🌊 The wave that scares you carries you furthest",
  "🪷 A moment of silence today is worth a thousand words",
  "🦅 You see your life from above and it all makes sense",
  "🌈 A promise made to you long ago is kept today",
  "🧶 A thread you've been pulling finally unravels the whole mystery",
  "🪞 You catch a glimpse of who you're becoming and it's magnificent",
  "🌻 Someone you help today will help thousands tomorrow",
  "🕰️ Time bends in your favor today",
  "🗝️ A secret is revealed that changes your perspective forever",
  "🌙 The moon watches over your work tonight",
  "🔮 You are closer to your goal than the stars suggest",
  "🧿 Your aura is golden today — people feel it",
  "🪶 Words you speak today echo further than you imagine",
  "🌟 A forgotten talent resurfaces at the perfect time",
  "🦉 An elder's advice you ignored suddenly proves wise",
  "💫 You walk through a door you didn't see yesterday",
  "🔔 Your name is spoken with admiration in a room you haven't entered",
  "🌊 A current beneath the surface carries you where you need to go",
  "🕯️ Your light is the only one someone needs to see today",
  "🌙 The night sky holds a message written just for you",
  "🪬 What you protect today protects you tomorrow",
  "✨ You are someone's answered prayer and don't know it yet",
  "🧭 Every step today is in the right direction even when it doesn't feel like it",
  "🦋 Transformation completes itself while you're not watching",
  "🌺 You bloom in a season no one expected",
  "🔮 Three good things happen before the day ends",
  "🌿 The earth gives back something you buried long ago",
  "💎 Under pressure today, you become something rare",
  "🌠 Tonight you sleep with a peace you haven't felt in months",
  "🕸️ The web of your life catches exactly what you need",
  // ─── Prophecies of Fortune ───
  "🪙 Money finds its way to you from an unlikely source",
  "📈 An investment of your time pays off spectacularly",
  "🎰 Luck strikes at precisely 3pm",
  "💰 A financial worry dissolves before sunset",
  "🏦 An opportunity worth more than gold lands in your lap",
  "🎁 You receive something you didn't ask for but desperately needed",
  "🍀 Four-leaf clovers grow where you walk today",
  "🌟 The stars wrote today's fortune in your favor last night",
  "🎲 Every gamble you take today lands right",
  "🪄 Something you thought was impossible happens before dinner",
  "🧞 A wish you're about to make comes true faster than expected",
  "🏆 A prize you deserve finally finds you",
  "💳 A door to abundance creaks open this afternoon",
  "🎟️ Today's ticket leads to tomorrow's treasure",
  "🪙 A coin you flip today lands on the side you need",
  // ─── Prophecies of Heart ───
  "💝 Someone tells you something you've needed to hear for a long time",
  "🫀 Your heart opens a door your mind couldn't",
  "💌 Words of love arrive from an unexpected direction",
  "🌹 Romance hides in the most ordinary moment today",
  "💞 A bond deepens without a single word being spoken",
  "🫂 An embrace today heals something old",
  "💕 Someone's eyes light up when they see you today",
  "🥰 You feel truly seen by someone who matters",
  "💗 Compassion you show today plants seeds that bloom for years",
  "🌷 A relationship you thought was fading is actually just beginning",
  "💘 Cupid aims at your afternoon and doesn't miss",
  "🧡 Warmth radiates from you and everyone feels it",
  "💜 A purple sunset tonight marks the start of something new",
  "💛 Friendship deepens through a shared silence",
  "🩵 Someone you care about takes a brave step and it works",
  // ─── Prophecies of Destiny ───
  "🌌 Your path crosses with destiny before midnight",
  "⭐ A star aligns that hasn't moved in years",
  "🌍 Your corner of the world becomes a little more beautiful today",
  "🛤️ A road you've avoided leads exactly where you want to go",
  "🚀 Today launches something that lands much later and much bigger",
  "🧬 Your DNA hums a new frequency starting today",
  "🗺️ You discover a map to something you gave up finding",
  "⏳ The hourglass tips and a new chapter begins",
  "🌅 This sunrise marks a turning point you'll look back on",
  "🔭 You glimpse a future that makes the present worth fighting for",
  "🌀 A spiral you've been circling finally reaches its center",
  "🪐 Planets shift today and so does your trajectory",
  "🛸 Something from beyond your usual world makes contact",
  "🏰 A kingdom you've been building in secret reveals itself",
  "🌋 Dormant power erupts into action at the perfect moment",
  // ─── Prophecies of Protection ───
  "🛡️ An unseen guardian deflects trouble from your path",
  "🧿 The evil eye turns away from you today",
  "🪬 Ancient protection wraps around your work",
  "🕊️ Peace walks ahead of you and clears the road",
  "🌿 Nature conspires to keep you safe today",
  "🐚 The ocean sends you a message of calm",
  "🫧 Negativity slides off you like water on glass",
  "🌤️ Storm clouds part before they reach you",
  "🪨 You stand on solid ground even when the earth shakes",
  "🏔️ The mountain shelters you from the wind today",
  "🦎 You dodge something without even realizing it",
  "🐢 Slow and steady wins today's most important race",
  "🌳 An ancient tree lends you its strength",
  "🪸 Something fragile in your life proves unbreakable",
  "🌬️ The wind changes direction just in time for you",
  // ─── Prophecies of Transformation ───
  "🐛 Something ordinary about you transforms into something extraordinary",
  "🦋 You shed what no longer fits and it feels like flying",
  "🔥 A phoenix moment awaits you this afternoon",
  "🌑 The new moon tonight writes a blank check for reinvention",
  "🪺 Something you've been incubating is ready to hatch",
  "🧊 Ice melts around an old fear and warmth floods in",
  "🌊 A wave washes away what you were afraid to let go of",
  "🫧 A bubble of illusion pops and reality is better than the dream",
  "🎭 You drop a mask today and feel relief instead of fear",
  "🪡 You stitch a new self from golden threads",
  "🌋 Pressure that built for weeks releases in creative fire",
  "🔮 The person you wake up as tomorrow will thank the choices you make today",
  "🧪 An experiment in being yourself yields spectacular results",
  "🌱 Growth happens so fast today you almost feel it physically",
  "⚗️ Base metal becomes gold — something mundane becomes extraordinary",
  // ─── Prophecies of Mastery ───
  "🗡️ A skill you've been honing reveals its true edge",
  "🎻 Your craft sings today in ways it hasn't before",
  "🧙 You perform everyday magic and make it look effortless",
  "📖 A chapter of your expertise closes and a new one begins",
  "🏯 The castle of your knowledge gains a new tower",
  "🎓 You graduate from one level of understanding to the next",
  "⚔️ Mastery of one thing opens mastery of another",
  "🪄 Your hands know what your mind hasn't learned yet",
  "🎼 Your instincts compose a masterpiece",
  "🏹 Aim comes naturally — stop overthinking the shot",
  "🧬 Your body of work becomes greater than the sum of its parts",
  "📐 Precision and creativity merge into something rare",
  "🔬 You see deeper into your field than you ever have",
  "🗂️ Years of scattered knowledge suddenly organize themselves",
  "🎯 Expertise speaks through you without effort",
  // ─── Prophecies of Adventure ───
  "🗺️ An unplanned detour becomes the highlight of your day",
  "🚢 You set sail for unknown waters and find land quickly",
  "🧗 A peak you thought unreachable is one climb away",
  "🌋 Something dormant in you erupts into an adventure",
  "🏜️ A desert stretch ends — an oasis appears",
  "🌊 The current takes you somewhere better than where you aimed",
  "🦈 You swim with something powerful and it respects you",
  "🏕️ You find shelter in the most unlikely place",
  "🗻 Today's view from the top is worth every step",
  "🧊 You break through ice into warm, clear water",
  "🌪️ You ride the whirlwind instead of fighting it",
  "🏄 A wave you didn't see coming gives the best ride",
  "🪂 A leap of faith ends in a perfect landing",
  "🛶 You navigate rapids with grace you didn't know you had",
  "🌌 You venture into the unknown and the unknown welcomes you",
  // ─── The Seer's Visions ───
  "🔮 A secret admirer makes their presence known today",
  "🌟 The skill you've been doubting becomes your superpower",
  "🃏 A joker in the deck plays as your ace",
  "🕯️ Someone lights a candle for you in a faraway place",
  "🌙 Moonlight illuminates a hidden truth tonight",
  "✨ You become unforgettable to someone new today",
  "🧿 Your enemies unknowingly work in your favor",
  "🪬 A curse you didn't know you carried lifts today",
  "🔔 A name you forgot remembers you",
  "🌠 A falling star carries your message to the heavens",
  "🕊️ A grudge dissolves and peace floods the empty space",
  "🔮 Your reflection winks at you — it knows something you don't",
  "🌺 A flower blooms out of season just for you",
  "💫 The wind whispers a name you're about to hear",
  "🦉 A wise one sends guidance wrapped in coincidence",
  "🌿 The earth remembers your footsteps and makes the path softer",
  "🧶 Fate weaves you into someone else's miracle today",
  "🪞 You recognize yourself in a stranger's eyes",
  "🌊 An old sorrow washes out with the evening tide",
  "🕸️ A thread of luck connects this morning to a fortune by nightfall",
  // ─── The Seer's Promises ───
  "🔮 Before sunset, you hear words that make everything worth it",
  "🌟 Someone who doubted you changes their mind today",
  "💫 Your generosity today triggers a chain reaction of good",
  "🕯️ A memory you revisit today holds a gift you missed the first time",
  "🌙 Tomorrow you wake up grateful for a choice you make today",
  "✨ A compliment you give today returns as an opportunity",
  "🧿 Your patience today spares you from a crisis you'll never see",
  "🪶 A gentle word you say heals a wound you didn't know existed",
  "🔔 Your phone brings the best news of the week",
  "🌠 A childhood dream starts breathing again",
  "🌺 Someone you mentor today surpasses all expectations",
  "🕊️ A peace offering you make is accepted with tears of relief",
  "🦋 Something you release today finds a better home",
  "🌿 An herb of fortune grows in your garden of effort",
  "🧶 An old friendship is rewoven stronger than before",
  "🪞 You see your father's strength in your own hands today",
  "🌊 A river of possibility opens that wasn't there yesterday",
  "💎 Raw pressure you've felt crystallizes into something precious",
  "🔮 The oracle says yes — trust the first impulse",
  "🌟 You glow with a light that draws others toward their best selves",
  // ─── The Seer's Warnings Turned Blessings ───
  "🌙 The obstacle you dread is actually your graduation ceremony",
  "🔥 What feels like burning is actually forging",
  "🌊 The flood you fear brings fertile soil",
  "⚡ The lightning that startles you illuminates the way",
  "🌪️ The storm carries you exactly where you needed to land",
  "🧊 The cold front passing through clears the air for weeks",
  "🌑 The darkness you sit in tonight is the seed of tomorrow's light",
  "🪨 The rock in your path becomes the cornerstone of your next build",
  "🐍 Something that looks threatening is actually shedding its skin for you",
  "🌋 The eruption you survived today makes you volcano-proof for life",
  "🦂 The sting you felt was the last one — you're now immune",
  "🌧️ The rain falling now waters something you can't see yet",
  "🕸️ The web that tangled you catches your enemy instead",
  "⏳ The delay that frustrates you is saving you from a bigger mistake",
  "🌫️ The fog that blinds you is hiding a surprise party",
  "🐺 The wolf at your door turns out to be a loyal guard",
  "🔮 What looks like an ending is actually a beginning in disguise",
  "🌊 The undertow you fight delivers you to a private shore",
  "🪶 The weight that presses you down is compressing you into a diamond",
  "✨ The tears you shed today water something that blooms forever",
  // ─── The Seer Sees Your Day ───
  "🔮 At exactly 11:11 you feel a shift you can't explain",
  "🌟 The afternoon holds a conversation that redraws your map",
  "💫 Lunch brings an insight worth more than the meal",
  "🕯️ Evening delivers a sense of completeness rarely felt",
  "🌙 You go to sleep tonight with a secret smile",
  "☕ Your morning routine contains a hidden portal today",
  "🌅 Dawn cracks open and so does a possibility",
  "🧿 Midday brings a visitor — physical or digital — who matters",
  "🪬 The commute home today is where the magic happens",
  "✨ Between two tasks today hides your biggest win",
  "🌺 You stop and notice something beautiful you pass every day",
  "🔔 A notification today is the one you've been waiting for",
  "🦋 An afternoon walk solves a morning puzzle",
  "🌿 By 4pm something you worried about all week dissolves",
  "🍵 Tea time brings a truth that simplifies everything",
  "🌙 The last hour of work is the most productive",
  "🌊 A wave of gratitude hits you on the way home",
  "🔮 Your last thought tonight plants a seed for a dream that teaches",
  "🌟 You catch a sunset that feels personally painted for you",
  "💫 Today ends better than any prediction could capture",
  // ─── The Seer's Gifts ───
  "🎁 A skill you practice alone today impresses someone publicly tomorrow",
  "🪙 Money you spent helping others returns multiplied",
  "🌱 A mistake you made becomes the root of your best idea",
  "🧬 DNA you inherited activates a talent you didn't know you had",
  "🏆 A race you didn't know you were running declares you the winner",
  "🎯 Accuracy improves across everything you touch today",
  "🎲 Chaos reorganizes itself in your favor",
  "🌈 Seven good things happen today — you notice five of them",
  "🔑 A password you forgot suddenly returns to your fingers",
  "📦 Something you ordered arrives early and exceeds expectations",
  "🎁 Someone repays a debt they owed you and adds interest in kindness",
  "🪄 You fix something with a single word",
  "🌻 A child or animal senses your good energy and comes close",
  "🍀 You find what you need in the first place you look",
  "🌟 Your aura is so bright today that even skeptics feel it",
  "🎪 The circus of life puts you center stage for a standing ovation",
  "🔮 Déjà vu strikes and this time you know what to do",
  "💫 The cosmos bookmarks this day in your biography",
  "🌙 Ancestors smile when they look at what you accomplished today",
  // ─── The Seer's Final Words ───
  "🔮 A circle that began years ago completes itself today",
  "🌟 Someone writes about you today and every word is kind",
  "💫 You solve a problem that bothered someone you'll never meet",
  "🕯️ A prayer you forgot you prayed is answered at dusk",
  "🌙 The silence between your words speaks louder than most people's speeches",
  "✨ A photograph taken today becomes your favorite memory",
  "🧿 Your energy field repels distraction all day",
  "🪬 A talisman you carry — even unknowingly — activates today",
  "🔔 You hear your calling, clear as a church bell at noon",
  "🌠 A meteor of inspiration crashes into your afternoon plans",
  "🌺 Today is the day future-you is most grateful for",
  "🕊️ Forgiveness you offer today frees you more than the other person",
  "🦋 You become the version of yourself you imagined as a child",
  "🌿 The universe leaves you a love note in an unlikely place",
  "🧶 The tapestry of your life gains its most vivid thread today",
  "🪞 You finally believe the good things others say about you",
  "🌊 A deep current of joy surfaces without reason",
  "💎 Someone sees your scars and calls them constellations",
  "🔮 The seer has spoken — today exceeds every expectation",
  "🌟 This tab was chosen for you — it knows what's coming",
];

function randomFortune(): string {
  return FORTUNE_COOKIES[Math.floor(Math.random() * FORTUNE_COOKIES.length)];
}

let tabs: Tab[] = [];
let activeTabId = "";
const TAB_STORAGE_KEY = "tinker-tabs";
const TAB_TITLE_INTERVAL = 5;

function generateTabId(): string {
  return "tab-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function saveTabs() {
  try {
    const persistable = tabs.filter((t) => t.id !== "tab-main");
    localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(persistable));
  } catch {}
}

function loadTabs() {
  try {
    const stored = JSON.parse(localStorage.getItem(TAB_STORAGE_KEY) || "[]");
    return stored as Tab[];
  } catch {
    return [];
  }
}

const $ = (id: string) => document.getElementById(id);
const app = $("app")!;

// ─── Provider Colors ───
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#6b8e23",
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
const PROVIDER_ICONS: Record<string, string> = {
  anthropic: `<svg width="14" height="14" viewBox="0 0 24 24"><polygon points="12,1 13.5,8.3 19.8,4.2 15.7,10.5 23,12 15.7,13.5 19.8,19.8 13.5,15.7 12,23 10.5,15.7 4.2,19.8 8.3,13.5 1,12 8.3,10.5 4.2,4.2 10.5,8.3" fill="#D97757"/></svg>`,
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
    if (pred(arr[i])) return i;
  }
  return -1;
}

// ─── Persisted Error Messages ───
const ERROR_STORAGE_KEY = "tinker-errors";

function persistErrorMsg(sk: string, msg: any) {
  try {
    const all = JSON.parse(localStorage.getItem(ERROR_STORAGE_KEY) || "{}");
    if (!all[sk]) all[sk] = [];
    all[sk].push(msg);
    localStorage.setItem(ERROR_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota exceeded */
  }
}

function loadPersistedErrors(sk: string): any[] {
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
type ActiveRunInfo = { model: string; provider: string; authProfileId?: string; startedAt: number };
const activeRuns = new Map<string, ActiveRunInfo>();
const providerErrors = new Map<string, { error: string; reason: string; ts: number }>();
const PROVIDER_ERRORS_STORAGE_KEY = "tinker-providerErrors";

function persistProviderErrors() {
  try {
    const obj: Record<string, { error: string; reason: string; ts: number }> = {};
    for (const [k, v] of providerErrors) obj[k] = v;
    localStorage.setItem(PROVIDER_ERRORS_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

function restoreProviderErrors() {
  try {
    const raw = localStorage.getItem(PROVIDER_ERRORS_STORAGE_KEY);
    if (!raw) return;
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
const collapsedModelSections = new Set<string>();
const ACTIVE_RUNS_STORAGE_KEY = "tinker-activeRuns";
const DRAFT_STORAGE_KEY = "tinker-draft";
// Runs restored from sessionStorage that haven't been confirmed by a lifecycle event yet
const unconfirmedRuns = new Set<string>();
// Pending delayed deletes for activeRuns — cancelled when a fallback model re-uses the same runId
const pendingRunDeletes = new Map<string, ReturnType<typeof setTimeout>>();

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
    if (!raw) return;
    const entries: [string, ActiveRunInfo][] = JSON.parse(raw);
    for (const [id, info] of entries) {
      activeRuns.set(id, info);
      unconfirmedRuns.add(id);
    }
  } catch {
    /* parse error — ignore */
  }
}

/** After reconnect, clear restored runs that no lifecycle event confirmed. */
function scheduleUnconfirmedPrune() {
  if (unconfirmedRuns.size === 0) return;
  setTimeout(() => {
    let changed = false;
    for (const id of unconfirmedRuns) {
      activeRuns.delete(id);
      changed = true;
    }
    unconfirmedRuns.clear();
    if (changed) {
      saveActiveRuns();
      updateBudgetPanel();
    }
  }, 5000);
}

// Restore on load
restoreActiveRuns();

function getAuthKeyCounts(forModel?: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const info of activeRuns.values()) {
    if (forModel && info.model !== forModel) continue;
    const key = info.authProfileId || info.model;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

let modelConfigData: any = null;

// ─── Gateway ───
function uuid() {
  return crypto.randomUUID();
}

function gwConnect() {
  ws = new WebSocket(GW_WS);
  ws.onmessage = (ev) => onFrame(JSON.parse(ev.data));
  ws.onclose = () => {
    connected = false;
    sending = false;
    streamMsgIdx = -1;
    frozenTextEnd = 0;
    lastDeltaLen = 0;
    streamRunId = null;
    activeRuns.clear();
    saveActiveRuns();
    updateDots();
    updateBtn();
    updateChat();
    setTimeout(gwConnect, 2000);
  };
}

function onFrame(f: any) {
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
        .then((hello: any) => {
          connected = true;
          const defs = hello?.snapshot?.sessionDefaults;
          if (defs?.mainSessionKey) {
            sessionKey = defs.mainSessionKey;
          }
          // Initialize tabs (preserve active tab across reconnects)
          const prevActiveTabId = activeTabId;
          const mainTab: Tab = {
            id: "tab-main",
            sessionKey: sessionKey,
            title: "🏠 Main",
            isAttached: true,
          };
          const restored = loadTabs();
          tabs = [mainTab, ...restored];
          // Restore previous active tab if it still exists, otherwise default to main
          const prevTabExists = tabs.some((t) => t.id === prevActiveTabId);
          activeTabId = prevTabExists ? prevActiveTabId : "tab-main";
          // Restore the session key from the active tab
          const activeTab = tabs.find((t) => t.id === activeTabId);
          if (activeTab?.isAttached && activeTab.sessionKey) {
            sessionKey = activeTab.sessionKey;
          }
          renderTabs();
          updateDots();
          updateBtn();
          loadSessions();
          loadBudget();
          refreshTreemap();
          timelineCtrl?.loadSession(sessionKey);
          scheduleUnconfirmedPrune();
          req("forensic.setMode", { enabled: true })
            .then((res: any) => {
              forensicMode = res?.enabled ?? true;
            })
            .catch(() => {
              forensicMode = true;
            });
        })
        .catch((e) => console.error("connect:", e));
      return;
    }
    onEvent(f);
    return;
  }
  if (f.type === "res") {
    const p = pending.get(f.id);
    if (p) {
      pending.delete(f.id);
      f.ok ? p.resolve(f.payload) : p.reject(f.error);
    }
  }
}

function req<T = any>(method: string, params?: any): Promise<T> {
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
  if (healthPollInterval) return;
  healthPollInterval = setInterval(async () => {
    if (providerErrors.size === 0) {
      clearInterval(healthPollInterval!);
      healthPollInterval = null;
      return;
    }
    try {
      const res = await req("provider.health", {});
      if (!res?.health) return;
      let changed = false;
      for (const [provider, info] of Object.entries(res.health) as [string, any][]) {
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
function mergeSentenceContinuations(msgs: any[]): void {
  // Only operate on _temporary messages from the current run.
  // Find the range of temporary messages (they're always at the tail).
  let tempStart = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]._temporary) tempStart = i;
    else if (tempStart >= 0) break; // walked past the temp block
  }
  if (tempStart < 0) return;

  for (let i = tempStart + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m._temporary) continue;
    if ((m.role ?? "").toLowerCase() !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const textBlock = content.find((b: any) => b.type === "text" && (b.text ?? "").trim());
    if (!textBlock) continue;

    const text = textBlock.text as string;
    const trimmed = text.trimStart();
    const firstChar = trimmed.charAt(0);
    // Detect mid-sentence start: lowercase letter or continuation punctuation
    const isLower =
      firstChar !== "" &&
      firstChar === firstChar.toLowerCase() &&
      firstChar !== firstChar.toUpperCase();
    const isMidSentence = isLower || /^[\d,;:.!?)}\]"'…–—\-]/.test(trimmed);
    if (!isMidSentence) continue;

    // Find the previous temporary assistant text bubble
    let prevTextBlock: any = null;
    for (let k = i - 1; k >= tempStart; k--) {
      const prev = msgs[k];
      if (!prev._temporary) continue;
      if ((prev.role ?? "").toLowerCase() !== "assistant") continue;
      const pc = Array.isArray(prev.content) ? prev.content : [];
      const pt = pc.find((b: any) => b.type === "text" && (b.text ?? "").trim());
      if (pt) {
        prevTextBlock = pt;
        break;
      }
    }
    if (!prevTextBlock) continue;

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

function onEvent(evt: any) {
  if (evt.event === "chat") {
    const p = evt.payload;
    if (p.sessionKey !== sessionKey) {
      return;
    }
    if (p.state === "delta") {
      streamRunId = p.runId;
      const deltaText = p.message?.content?.[0]?.text ?? "";
      if (deltaText) {
        lastDeltaLen = deltaText.length;
        // Slice off text already shown in frozen thinking bubbles
        const segmentText = frozenTextEnd > 0 ? deltaText.slice(frozenTextEnd) : deltaText;
        if (streamMsgIdx >= 0 && messages[streamMsgIdx]?._temporary) {
          // Update existing temporary message's text
          const content = messages[streamMsgIdx].content;
          const textBlock = content.find((b: any) => b.type === "text");
          if (textBlock) {
            textBlock.text = segmentText;
          }
        } else {
          // Create a new temporary message
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: segmentText }],
            _temporary: true,
          });
          streamMsgIdx = messages.length - 1;
        }
      }
      updateChat();
    } else if (p.state === "final" || p.state === "error" || p.state === "aborted") {
      if (p.state !== "error") {
        // ─── Continuation merge ───
        // Before promoting, merge sentence fragments: if an assistant text
        // bubble starts with lowercase (mid-sentence continuation after a
        // tool call), move text up to the first '.' into the previous
        // assistant text bubble and keep the remainder in the current one.
        mergeSentenceContinuations(messages);

        // Promote temp messages to permanent.
        // When tool calls split the streaming text (frozenTextEnd slicing),
        // the final server message has the complete un-sliced text. Replace
        // ALL temp text segments with the server's authoritative version so
        // markdown elements (tables, lists) that span tool-call boundaries
        // render correctly as a single block.
        const hadTemps = messages.some((m: any) => m._temporary);
        if (hadTemps && p.message) {
          // Remove ALL temporary assistant text bubbles (keep tool_use/tool_result)
          const finalContent = Array.isArray(p.message.content) ? p.message.content : [];
          const finalText = finalContent
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text ?? "")
            .join("");

          // Remove temp text-only messages, keep temp tool messages
          messages = messages.filter((m: any) => {
            if (!m._temporary) return true;
            const c = Array.isArray(m.content) ? m.content : [];
            const isToolMsg = c.some((b: any) => b.type === "tool_use" || b.type === "tool_result");
            return isToolMsg;
          });

          // Insert the complete text as a single non-temp message after the last tool row
          if (finalText.trim()) {
            messages.push({
              role: "assistant",
              content: [{ type: "text", text: finalText }],
            });
          }

          // Clean up remaining temp flags
          for (const m of messages) {
            if (m._temporary) delete m._temporary;
          }
        } else if (hadTemps) {
          // No server final message — promote temps as-is (fallback)
          for (const m of messages) {
            if (m._temporary) delete m._temporary;
          }
        }
        if (!hadTemps && p.message) {
          messages.push(p.message);
        }
      } else {
        messages = messages.filter((m: any) => !m._temporary);
        if (p.message) {
          messages.push(p.message);
        }
      }
      if (p.state === "error" && p.errorMessage) {
        const errMsg = {
          role: "assistant",
          content: [{ type: "text", text: p.errorMessage }],
          _isError: true,
        };
        messages.push(errMsg);
        persistErrorMsg(sessionKey, errMsg);
      }
      if (p.state === "final") {
        clearPersistedErrors(sessionKey);
      }
      // Always reset streaming state — even on error (fallback will start fresh deltas)
      streamMsgIdx = -1;
      frozenTextEnd = 0;
      lastDeltaLen = 0;
      streamRunId = p.state !== "error" ? null : streamRunId;
      if (activeRuns.size === 0 && pendingRunDeletes.size === 0) {
        sending = false;
      }
      updateChat();
      updateBtn();
      if (p.state !== "error") {
        loadBudget();
        refreshTreemap();
        updateResponseMap();
      }
    }
  }
  if (evt.event === "agent") {
    const p = evt.payload;
    // ─── Live Tool Events ───
    // Capture tool-use/tool-result events and inject them as visible messages
    if (p?.stream === "tool" && p.sessionKey === sessionKey) {
      const d = p.data ?? {};
      if (d.phase === "start" && d.name && d.toolCallId) {
        // Freeze current streaming text — it becomes its own thinking bubble
        frozenTextEnd = lastDeltaLen;
        streamMsgIdx = -1;
        // Add tool_use as a temporary message
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: d.toolCallId,
              name: d.name,
              input: d.args ?? {},
            },
          ],
          _temporary: true,
        });
        updateChat();
      } else if (d.phase === "result" && d.toolCallId) {
        // Push tool_result as a temporary message so renderMsg can pair it
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: d.toolCallId,
              content:
                d.result != null
                  ? typeof d.result === "string"
                    ? d.result
                    : JSON.stringify(d.result)
                  : "(completed)",
              is_error: Boolean(d.isError),
            },
          ],
          _temporary: true,
        });
        updateChat();
      }
    }
    // Instant context anatomy bar — pushed over WebSocket, no polling needed
    if (p?.stream === "lifecycle" && p.data?.phase === "context-anatomy") {
      if (p.data.anatomy && timelineCtrl) {
        timelineCtrl.pushEvent(p.data.anatomy as any);
      }
    }
    // Track provider failures from model fallback
    if (p?.stream === "lifecycle" && p.data?.phase === "fallback-error") {
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
        providerErrors.set(errKey, {
          error: (errMsg || reason || "failed") as string,
          reason,
          ts: Date.now(),
        });
        persistProviderErrors();
        updateBudgetPanel();
        startHealthPoll();
      }
      // Show each fallback step as a chat message
      const profileId = (p.data.failedProfileId || "") as string;
      const stepLabel = attempt && total ? `[${attempt}/${total}]` : "";
      const modelLabel = fm || "unknown";
      const profileLabel = profileId ? ` (${profileId})` : "";
      const reasonLabel = describeError(reason, errMsg);
      // (placeholder removed — real bars inserted on data arrival)
      const nextLabel =
        attempt && total && attempt < total ? " — jumping to backup" : " — all backups exhausted";
      const fallbackText = `⚠ ${stepLabel} ${modelLabel}${profileLabel} failed (${reasonLabel})${nextLabel}`;
      const fallbackMsg: any = {
        role: "assistant",
        content: [{ type: "text", text: fallbackText }],
        _isError: true,
        _retryProvider: fp || undefined,
      };
      messages.push(fallbackMsg);
      persistErrorMsg(sessionKey, fallbackMsg);
      updateChat();
    }
    // Show per-profile failure events (auth profile rotation within a provider)
    if (p?.stream === "lifecycle" && p.data?.phase === "fallback-profile-error") {
      const prov = (p.data.provider || "unknown") as string;
      const model = (p.data.model || "unknown") as string;
      const pid = (p.data.profileId || "") as string;
      const reason = (p.data.reason || "unknown") as string;
      const errMsg = (p.data.error || "") as string;
      const pIdx = p.data.profileIndex as number | undefined;
      const pTotal = (p.data.totalProfiles ?? p.data.profileTotal) as number | undefined;
      const reasonLabel = describeError(reason, errMsg);
      const profileStep = pIdx && pTotal ? ` [profile ${pIdx}/${pTotal}]` : "";
      const profileText = `↳ ${model} ${pid ? pid : prov}${profileStep} — ${reasonLabel}`;
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
      const profileMsg: any = {
        role: "assistant",
        content: [{ type: "text", text: profileText }],
        _isError: true,
        _retryProvider: prov,
      };
      messages.push(profileMsg);
      persistErrorMsg(sessionKey, profileMsg);
      updateChat();
    }
    // Overseer periodic chat updates
    if (p?.stream === "lifecycle" && p.data?.phase === "overseer-update") {
      const mdText = p.data.markdown as string;
      if (mdText) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: mdText }],
          _isOverseer: true,
        });
        updateChat();
      }
    }
    if (p?.stream === "lifecycle" && p.data?.model) {
      // Ignore lifecycle events that don't belong to the current session (e.g. heartbeat)
      // Allow subagent sessions through — they're child runs the user cares about
      if (
        p.data.sessionKey &&
        p.data.sessionKey !== sessionKey &&
        !p.data.sessionKey.includes(":subagent:")
      )
        return;
      // Any lifecycle event for a restored run confirms it's still active
      unconfirmedRuns.delete(p.runId);
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
        });
        // Re-assert sending in case a chat error event cleared it during fallback
        sending = true;
        saveActiveRuns();
        updateBudgetPanel();
        updateChat();
        updateBtn();
        startThinkingTick();
        // Poll anatomy API shortly after run starts — pre-prompt anatomy is written before LLM call
        {
          const sk = sessionKey;
          const tn = currentTurnNumber;
          setTimeout(() => {
            if (sk && timelineCtrl) {
              const base = import.meta.env.DEV ? "http://localhost:18789" : "";
              fetch(`${base}/api/context-anatomy/${encodeURIComponent(sk)}?limit=10`)
                .then((r) => (r.ok ? r.json() : null))
                .then((body) => {
                  const events: any[] = Array.isArray(body) ? body : (body?.events ?? []);
                  if (events.length === 0) return;
                  const turnEvents = events.filter((ev: any) => ev.turn === tn);
                  for (const ev of turnEvents) {
                    timelineCtrl!.pushEvent(ev);
                  }
                })
                .catch(() => {});
            }
          }, 800);
        }
      } else if (p.data.phase === "end" || p.data.phase === "error") {
        const endRunId = p.runId;
        const timeoutId = setTimeout(() => {
          pendingRunDeletes.delete(endRunId);
          activeRuns.delete(endRunId);
          saveActiveRuns();
          // Clear sending once all runs are done
          if (activeRuns.size === 0) {
            sending = false;
          }
          updateBudgetPanel();
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
            fetch(`${base}/api/context-anatomy/${encodeURIComponent(sk)}?limit=10`)
              .then((r) => (r.ok ? r.json() : null))
              .then((body) => {
                const events: any[] = Array.isArray(body) ? body : (body?.events ?? []);
                if (events.length === 0) return;
                // Find events for the current turn
                const turnEvents = events.filter((ev: any) => ev.turn === turnNum);
                if (turnEvents.length === 0) {
                  // Fallback: just use the latest event (backwards compat)
                  const latest = events[events.length - 1];
                  if (latest) turnEvents.push(latest);
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
}

// ─── API ───
async function loadSessions() {
  const res = await req("sessions.list", {}).catch(() => ({ sessions: [] }));
  sessions = res.sessions ?? [];
  if (!sessionKey && sessions.length) {
    sessionKey = sessions[0].key;
  }
  updateSelect();
  updateSessionsPanel();
  // Sync tabs with server-side sessions (detect deleted sessions)
  for (const tab of tabs) {
    if (tab.isAttached && tab.sessionKey && tab.id !== "tab-main") {
      const sess = sessions.find((s: any) => s.key === tab.sessionKey);
      if (!sess) {
        tab.sessionKey = null;
        tab.isAttached = false;
        tab.title = randomFortune();
      }
    }
  }
  renderTabs();
  loadChat();
}

async function loadChat() {
  streamMsgIdx = -1;
  frozenTextEnd = 0;
  lastDeltaLen = 0;
  if (!sessionKey) {
    return;
  }
  const res = await req("chat.history", { sessionKey, limit: 1000 }).catch(() => ({
    messages: [],
  }));
  messages = res.messages ?? [];
  // Sync turn counter from loaded history
  const userMsgCount = messages.filter((m: any) => m.role === "user").length;
  currentTurnNumber = userMsgCount;
  // Restore persisted error messages (survive refresh)
  const storedErrors = loadPersistedErrors(sessionKey);
  if (storedErrors.length) {
    // Insert errors before the last assistant message (natural position),
    // or append at end if no assistant message follows.
    const lastAssistantIdx = findLastIndex(messages, (m: any) => m.role === "assistant");
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
  if (!tab.sessionKey || tab.id === "tab-main") return;

  // Collect last N Q&A pairs from messages
  const pairs: string[] = [];
  let count = 0;
  for (let i = messages.length - 1; i >= 0 && count < TAB_TITLE_INTERVAL; i--) {
    const m = messages[i];
    if (!m?.content) continue;
    const text = Array.isArray(m.content)
      ? m.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join(" ")
      : String(m.content);
    if (!text.trim()) continue;
    const role = (m.role || "").toLowerCase();
    if (role === "user" || role === "assistant") {
      pairs.unshift(`${role}: ${text.slice(0, 200)}`);
      if (role === "user") count++;
    }
  }

  if (pairs.length === 0) return;

  const prompt = `Summarize this conversation in 1-3 words (short title, no quotes, no punctuation). Start with a relevant emoji. Example: "🔧 Fix auth bug". Here is the conversation:\n\n${pairs.join("\n")}`;

  try {
    // Try local Ollama first (free, fast)
    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3:1.7b", prompt, stream: false }),
    })
      .then((r) => r.json())
      .catch(() => null);

    let title = ollamaRes?.response?.trim();

    // Strip any quotes or punctuation wrapping
    if (title) {
      title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
    }

    if (title && title.length > 0 && title.length <= 40) {
      // Preserve the original emoji prefix from the fortune cookie
      const originalEmoji =
        tab.title.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)\s*/u)?.[0] || "";
      // Strip any emoji the LLM may have added
      const stripped = title.replace(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)\s*/u, "").trim();
      tab.title = originalEmoji + stripped;
      renderTabs();
      saveTabs();
    }
  } catch {
    // Silent fail — keep existing title
  }
}

async function send(text: string) {
  if (!text.trim()) return;

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

  if (!sessionKey) return;

  sending = true;
  currentTurnNumber++;
  messages.push({ role: "user", content: [{ type: "text", text }] });
  updateChat();
  updateBtn();
  scrollChat();

  // Regenerate tab title on first prompt and every N prompts after
  if (
    activeTab &&
    activeTab.id !== "tab-main" &&
    (currentTurnNumber === 1 || currentTurnNumber % TAB_TITLE_INTERVAL === 0)
  ) {
    generateTabTitle(activeTab);
  }

  await req("chat.send", { sessionKey, message: text, idempotencyKey: uuid() }).catch((e) => {
    console.error(e);
    sending = false;
    updateBtn();
  });
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
  frozenTextEnd = 0;
  lastDeltaLen = 0;
  messages = messages.filter((m) => !(m._isError && m._retryProvider === provider));
  clearPersistedErrors(sessionKey);
  // Find last user message and resend
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i].role ?? "").toLowerCase() === "user") {
      const text = Array.isArray(messages[i].content)
        ? messages[i].content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
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
  sending = false;
  messages = messages.filter((m: any) => !m._temporary);
  streamMsgIdx = -1;
  frozenTextEnd = 0;
  lastDeltaLen = 0;
  streamRunId = null;
  activeRuns.clear();
  updateChat();
  updateBtn();
}

async function loadBudget() {
  const [b, s, mc, bu] = await Promise.all([
    req("usage.budget", {}).catch(() => null),
    req("budget.status", {}).catch(() => null),
    req("config.models", {}).catch(() => null),
    req("budget.usage", {}).catch(() => null),
  ]);
  budgetData = { budget: b, status: s };
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

function extractGrepFiles(cmd: string): string {
  // Get the last path-like argument
  const parts = cmd.split(/\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes("/")) return fileName(shortenPath(parts[i]));
  }
  return "";
}

function editPreview(s: string): string {
  // Return first meaningful line of a string, trimmed
  const line = s.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return line.length > 60 ? line.slice(0, 57) + "…" : line;
}

function toolSummary(name: string, input: any): string {
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
      if (cmd.startsWith("ls")) return `Checking what's inside a folder`;
      if (cmd.startsWith("cat")) return `Reading the contents of a file`;
      if (cmd.startsWith("kill")) return `Stopping something that was running`;
      if (cmd.includes("pnpm build") || cmd.includes("npm build"))
        return `Compiling all recent changes so they take effect`;
      if (cmd.includes("pnpm test") || cmd.includes("npm test"))
        return `Running automated checks to make sure nothing is broken`;
      if (cmd.includes("pnpm install") || cmd.includes("npm install"))
        return `Setting up the required software components`;
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
      if (cmd.startsWith("ps ")) return `Checking what programs are currently running`;
      if (cmd.startsWith("sed")) return `Making a quick text replacement in a file`;
      if (cmd.includes("git pull")) return `Downloading the latest version of the code`;
      if (cmd.includes("git push")) return `Uploading the changes so others can see them`;
      if (cmd.includes("git commit")) return `Saving the current changes as a named checkpoint`;
      if (cmd.includes("git diff")) return `Comparing what changed between two versions`;
      if (cmd.includes("git ")) return `Doing some version tracking housekeeping`;
      if (cmd.startsWith("echo")) return `Printing a note`;
      if (cmd.startsWith("sleep")) return `Pausing briefly before the next step`;
      if (cmd.startsWith("nohup") || cmd.startsWith("setsid"))
        return `Starting a long-running task in the background`;
      return `Performing a system operation`;
    }
    case "read":
      return `Reading a section of the code to understand how it works`;
    case "edit": {
      const oldStr = String(a.old_string ?? a.oldText ?? "");
      const newStr = String(a.new_string ?? a.newText ?? "");
      const oldP = editPreview(oldStr);
      const newP = editPreview(newStr);
      if (oldStr && !newStr) return `Removing: "${oldP}"`;
      if (!oldStr && newStr) return `Adding: "${newP}"`;
      return `Changing "${oldP}" to "${newP}"`;
    }
    case "write":
      return `Creating a new file with the necessary content`;
    case "process": {
      const act = a.action ?? "?";
      if (act === "poll") return `Waiting for a background task to finish`;
      if (act === "kill") return `Stopping a background task`;
      if (act === "log") return `Checking the output of a background task`;
      if (act === "list") return `Looking at what's running in the background`;
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
      if (act === "send") return `Sending a message to ${target}`;
      if (act === "react") return `Reacting to a message`;
      return `Performing a messaging action with ${target}`;
    }
    case "browser": {
      const act = a.action ?? "?";
      if (act === "screenshot") return `Taking a picture of what's on screen`;
      if (act === "snapshot") return `Reading the layout of the web page`;
      if (act === "open") return `Opening a web page in the browser`;
      if (act === "navigate") return `Going to a different web page`;
      if (act === "act") return `Clicking or typing something on the page`;
      return `Doing something in the browser`;
    }
    case "image":
      return a.prompt
        ? `Looking at an image to ${String(a.prompt).slice(0, 80)}`
        : `Examining an image`;
    case "whatsapp_history": {
      const act = a.action ?? "?";
      if (act === "search" && a.query) return `Searching WhatsApp messages for "${a.query}"`;
      if (act === "search" && a.chat) return `Reading a WhatsApp conversation`;
      if (act === "search") return `Going through recent WhatsApp messages`;
      if (act === "stats") return `Checking how many WhatsApp messages there are`;
      return `Doing something with WhatsApp`;
    }
    case "sessions_spawn":
      return `Starting a helper to work on: ${String(a.task ?? "").slice(0, 80)}`;
    case "subagents": {
      const act = a.action ?? "?";
      if (act === "list") return `Checking on helpers that are working in parallel`;
      if (act === "kill") return `Telling a helper to stop`;
      if (act === "steer") return `Giving new instructions to a helper`;
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

function toolExpandedDetail(name: string, input: any): string {
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
      if (entries.length === 0)
        return `<div class="explanation">${esc(name ?? "tool")} (no parameters)</div>`;
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
      const fullPath = p.startsWith("~") ? p.replace("~", "/home/globalcaos") : p;
      return `<span class="sys-file-link" data-path="${esc(fullPath)}">📄 ${esc(name)}</span>`;
    });
    preview = links.join(" ");
  } else {
    const firstSentence = flat.match(/^[^.!?\n]{10,120}[.!?]/)?.[0];
    preview = esc(firstSentence ?? flat.slice(0, 120));
    if (text.length > (firstSentence?.length ?? 120)) preview += " …";
  }

  const cssClass = isAlert ? "msg system-alert" : "msg system";
  let h = `<div class="${cssClass}" data-tid="${sid}">${sysExp ? "▾" : "▸"} ${preview}</div>`;
  if (sysExp) {
    h += `<div class="tool-detail system-expanded">${md(text)}</div>`;
  }
  return h;
}

function renderMsg(
  msg: any,
  idx: number,
  isThinking = false,
  globalResults?: Map<string, { content: string; isError: boolean }>,
  globalToolNames?: Map<string, { name: string; input: any }>,
): string {
  const role = (msg.role ?? "").toLowerCase();
  const content = Array.isArray(msg.content) ? msg.content : [];
  const resultMap = globalResults ?? new Map();
  const toolNameMap = globalToolNames ?? new Map();
  let h = "";
  let blockIdx = 0;
  let hasNonToolContent = false;

  // Check if this message has any non-tool content (text blocks or plain string)
  if (typeof msg.content === "string" && msg.content.trim()) hasNonToolContent = true;
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
          if (line.startsWith("System:")) sysLines.push(line);
        } else {
          inSystemBlock = false;
          userLines.push(line);
        }
      }
      for (const line of sysLines) {
        const sysText = line.replace(/^System:\s*/, "").trim();
        if (sysText) h += renderSystemMsg(sysText, idx);
      }
      const userText = userLines.join("\n").trim();
      if (userText) {
        // System-injected messages (runtime context, subagent results) → system style
        if (SYSTEM_INJECTED_RE.test(userText)) {
          h += renderSystemMsg(userText.replace(SYSTEM_INJECTED_RE, "").trim() || userText, idx);
        } else {
          h += `<div class="msg user" data-msg-idx="${idx}">${md(userText)}</div>`;
        }
      }
    } else if (role === "assistant") {
      const errorClass = msg._isError ? " msg-error" : "";
      const retryBtn =
        msg._isError && msg._retryProvider
          ? ` <button class="retry-provider-btn" data-retry-provider="${esc(msg._retryProvider)}" data-hint="Retry ${esc(msg._retryProvider)}">↻</button>`
          : "";
      const thinkingPrefix = isThinking ? `<span class="thinking-label">Thinking:</span> ` : "";
      h += `<div class="msg assistant${errorClass}${isThinking ? " msg-thinking" : ""}">${thinkingPrefix}${md(text)}${retryBtn}</div>`;
    } else {
      h += renderSystemMsg(text, idx);
    }
    return h;
  }

  // Render content blocks in order — text, tool_use, tool_result interlaced
  for (const block of content) {
    if (block.type === "text") {
      const text = (block.text ?? "").trim();
      if (!text) continue;
      if (role === "user") {
        // Split system event lines from user text
        const lines = text.split("\n");
        const sysLines: string[] = [];
        const userLines: string[] = [];
        let inSystemBlock = true;
        for (const line of lines) {
          if (inSystemBlock && (line.startsWith("System:") || line.trim() === "")) {
            if (line.startsWith("System:")) sysLines.push(line);
          } else {
            inSystemBlock = false;
            userLines.push(line);
          }
        }
        // Render system lines as system messages
        for (const line of sysLines) {
          const sysText = line.replace(/^System:\s*/, "").trim();
          if (sysText) h += renderSystemMsg(sysText, idx);
        }
        // Render remaining user text
        const userText = userLines.join("\n").trim();
        if (userText) {
          // System-injected messages (runtime context, subagent results) → system style
          if (SYSTEM_INJECTED_RE.test(userText)) {
            h += renderSystemMsg(userText.replace(SYSTEM_INJECTED_RE, "").trim() || userText, idx);
          } else {
            h += `<div class="msg user" data-msg-idx="${idx}">${md(userText)}</div>`;
          }
        }
      } else if (role === "assistant") {
        const errorClass = msg._isError ? " msg-error" : "";
        const retryBtn =
          msg._isError && msg._retryProvider
            ? ` <button class="retry-provider-btn" data-retry-provider="${esc(msg._retryProvider)}" data-hint="Retry ${esc(msg._retryProvider)}">↻</button>`
            : "";
        const thinkingPrefix = isThinking ? `<span class="thinking-label">Thinking:</span> ` : "";
        h += `<div class="msg assistant${errorClass}${isThinking ? " msg-thinking" : ""}">${thinkingPrefix}${md(text)}${retryBtn}</div>`;
      } else {
        h += renderSystemMsg(text, idx);
      }
    } else if (block.type === "tool_use") {
      const a = block.input ?? {};
      const d = toolSummary(block.name, a);
      const tid = `t${idx}-${block.id ?? block.name}-${blockIdx++}`;
      const exp = expandedTools.has(tid);
      // Look up result from global map (tool_result may be in a different message)
      const paired = resultMap.get(block.id ?? "");
      const statusIcon = paired ? (paired.isError ? "✗" : "✓") : "⋯";
      const statusCls = paired ? (paired.isError ? "err" : "ok") : "run";
      h += `<div class="tool-row" data-tid="${tid}"><span class="status ${statusCls}">${statusIcon}</span><span class="detail">${esc(d)}</span></div>`;
      if (exp) {
        h += `<div class="tool-detail">${toolExpandedDetail(block.name, a)}`;
        // Show result only for errors or when the detail doesn't already contain it
        const n = (block.name ?? "").toLowerCase();
        const detailHasContent = n === "edit" || n === "write";
        if (paired && (paired.isError || !detailHasContent)) {
          h += `<div class="tool-result-inline"><div class="explanation">${paired.isError ? "❌ Something went wrong:" : "What came back:"}</div><div class="code-block">${esc(paired.content)}</div></div>`;
        }
        h += `</div>`;
      }
    } else if (block.type === "tool_result") {
      // tool_result blocks are shown alongside their tool_use (via globalResults).
      // Only render standalone if there's no matching tool_use anywhere AND this
      // message has other content (otherwise skip the whole message).
      const uid = block.tool_use_id ?? "";
      const matchingTool = toolNameMap.get(uid);
      if (matchingTool) continue; // will be shown with its tool_use
      if (!hasNonToolContent) continue; // pure tool_result message — skip entirely
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
    let rows = "";
    for (const [runId, info] of activeRuns) {
      const color = PROVIDER_COLORS[info.provider] || "#6b7280";
      const elapsed = Math.floor((Date.now() - info.startedAt) / 1000);
      const name = modelName(info.model);
      rows += `<div class="thinking-run" data-run-id="${esc(runId)}" data-provider="${esc(info.provider)}" style="--thinking-dot-color:${color}">
  <div class="thinking-dots"><span></span><span></span><span></span></div>
  <span class="thinking-model">${providerIcon(info.provider)} ${esc(name)}</span>
  <span class="thinking-elapsed">${elapsed}s</span>
  <span class="thinking-stop">Stop</span>
</div>`;
    }
    return `<div class="thinking-indicator">${rows}</div>`;
  }
  if (sending) {
    return `<div class="thinking-indicator" data-state="pending"><div class="thinking-run thinking-pending" style="--thinking-dot-color:#6b8e23">
  <div class="thinking-dots"><span></span><span></span><span></span></div>
  <span class="thinking-model">sending...</span>
</div></div>`;
  }
  return "";
}

function startThinkingTick() {
  if (thinkingTickInterval) return;
  thinkingTickInterval = setInterval(() => {
    if (activeRuns.size === 0) {
      clearInterval(thinkingTickInterval!);
      thinkingTickInterval = null;
      return;
    }
    document.querySelectorAll(".thinking-run[data-run-id]").forEach((el) => {
      const runId = el.getAttribute("data-run-id");
      if (!runId) return;
      const info = activeRuns.get(runId);
      if (!info) return;
      const elapsed = Math.floor((Date.now() - info.startedAt) / 1000);
      const span = el.querySelector(".thinking-elapsed");
      if (span) span.textContent = `${elapsed}s`;
    });
  }, 1000);
}

// ─── Usage Tracker Helpers ───
function fmtCost(n: number): string {
  if (n >= 1) return n % 1 === 0 ? n.toString() : n.toFixed(1);
  if (n >= 0.1) return n.toFixed(2);
  return n.toFixed(3);
}

// Subscription effective $/MTok: $200/mo, ~6M tok/day = ~180M/mo → ~$1.1/MTok blended
const SUB_COST_LABEL = "~$1.1";

function getModelCost(modelId: string, keyId?: string): string {
  // Subscription profiles get effective flat rate
  if (keyId && (keyId.includes(":cli-") || keyId.includes(":oauth"))) {
    const provider = modelId.split("/")[0];
    if (provider === "anthropic") return SUB_COST_LABEL;
  }
  const name = modelId.split("/").slice(1).join("/") || modelId;
  const cost = MODEL_COST[name];
  if (!cost) return "";
  if (cost[0] === cost[1]) return `$${fmtCost(cost[0])}`;
  return `$${fmtCost(cost[0])}/${fmtCost(cost[1])}`;
}

function fmtReset(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = d.getTime() - now;
    if (diffMs <= 0) return "";
    const h = Math.floor(diffMs / 3600000);
    const m = Math.floor((diffMs % 3600000) / 60000);
    if (h < 24) return `${h}h ${m}m`;
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
  if (!budgetUsageData || provider === "ollama") return null;
  const name = modelId.split("/").slice(1).join("/") || modelId;

  if (provider === "anthropic") {
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
      if (profileKey)
        return {
          topPct: 0,
          bottomPct: 0,
          tooltip: `${profileKey}: disconnected`,
          disconnected: true,
        };
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
      if (rsfmt) tip += ` \u2014 resets ${rsfmt}`;
    } else {
      const r7 = c.limits.seven_day?.resets_at;
      const r7fmt = r7 ? fmtReset(r7) : "";
      tip += `\n7d: ${d7}%`;
      if (r7fmt) tip += ` \u2014 resets ${r7fmt}`;
    }
    return { topPct: h5, bottomPct, tooltip: tip };
  }

  if (provider === "google") {
    const g = budgetUsageData?.gemini;
    if (!g || !g.rpd_limit) return null;
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
    if (!oc || oc.monthSpend == null) return null;
    const cap = 50;
    const monthPct = Math.min((oc.monthSpend / cap) * 100, 100);
    // Today's spend as fraction of total cap
    const today = new Date().toISOString().slice(0, 10);
    const todayEntry = (oc.dailyBreakdown || []).find((d: any) => d.date === today);
    const todaySpend = todayEntry?.amount ?? 0;
    const todayPct = Math.min((todaySpend / cap) * 100, 100);
    let tip = `Today: $${todaySpend.toFixed(2)}/$${cap} (${todayPct.toFixed(0)}%)`;
    tip += `\nMonth: $${oc.monthSpend.toFixed(2)}/$${cap} (${monthPct.toFixed(0)}%)`;
    return { topPct: todayPct, bottomPct: monthPct, tooltip: tip };
  }

  return null;
}

function renderUsageBarsOnly(usage: ModelUsageInfo | null): string {
  if (!usage) return '<span class="usage-bars-col"></span>';
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
  if (!costLabel) return '<span class="usage-cost-col"></span>';
  return `<span class="usage-cost-col">${esc(costLabel)}</span>`;
}

// ─── Budget Helpers ───
function budgetColor(pct: number) {
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
function extractUserText(msg: any): string | null {
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
  if (!raw.trim()) return null;
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
  if (!text) return null;
  // Check if remaining text is system-injected runtime context
  if (SYSTEM_INJECTED_RE.test(text)) return null;
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
  const isRunBoundary = (m: any) => {
    if ((m.role ?? "").toLowerCase() !== "user") return false;
    const c = Array.isArray(m.content) ? m.content : [];
    // Pure tool_result messages are part of the run, not boundaries
    if (c.length > 0 && !c.some((b: any) => b.type !== "tool_result")) return false;
    // System-injected user messages (runtime context, subagent results) are not boundaries
    if (extractUserText(m) === null) return false;
    return true;
  };
  const thinkingSet = new Set<number>();
  {
    let runStart = 0;
    for (let i = 0; i <= messages.length; i++) {
      const isUserOrEnd = i === messages.length || isRunBoundary(messages[i]);
      if (!isUserOrEnd) continue;
      const assistantTextIndices: number[] = [];
      for (let j = runStart; j < i; j++) {
        const m = messages[j];
        if ((m.role ?? "").toLowerCase() !== "assistant") continue;
        const c = Array.isArray(m.content) ? m.content : [];
        const hasText = c.some((b: any) => b.type === "text" && (b.text ?? "").trim());
        const plainText = typeof m.content === "string" && (m.content as string).trim();
        if (hasText || plainText) assistantTextIndices.push(j);
      }
      // During streaming, render all bubbles as normal assistant (no thinking style).
      // After finalization, all except the last become thinking → reasoning group.
      const isCurrentRun = i === messages.length && streamMsgIdx >= 0;
      const intermediates = isCurrentRun ? [] : assistantTextIndices.slice(0, -1);
      for (const idx of intermediates) thinkingSet.add(idx);
      runStart = i + 1;
    }
  }
  // Build a global tool result map: tool_use_id → { content, isError, name }
  // so tool_use blocks can find their paired results even across messages.
  const globalResultMap = new Map<string, { content: string; isError: boolean }>();
  const globalToolNames = new Map<string, { name: string; input: any }>();
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
      if (!isUserOrEnd) continue;

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
            const hasText = c.some((b: any) => b.type === "text" && (b.text ?? "").trim());
            const plainText = typeof m.content === "string" && (m.content as string).trim();
            if (!hasText && !plainText) {
              intermediateIndices.push(j);
            } else {
              // If we already had a final candidate, demote it to intermediate
              if (finalIdx >= 0) intermediateIndices.push(finalIdx);
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
          if (b.type === "tool_use") toolCount++;
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
  // Decide scroll behavior BEFORE replacing DOM content.
  const threshold = 80;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  const prevScrollTop = el.scrollTop;
  el.innerHTML = h;
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
        if (!fp) return;
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
          .then((data: any) => {
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
              if (isJson)
                try {
                  content = JSON.stringify(JSON.parse(content), null, 2);
                } catch {}
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
      expandedTools.has(id) ? expandedTools.delete(id) : expandedTools.add(id);
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
      if (prov) retryProvider(prov);
    }),
  );
  if (!skipScroll) scrollChat();
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
  if (!container) return;

  let html = "";
  for (const tab of tabs) {
    const isActive = tab.id === activeTabId;
    const classes = ["tab"];
    if (isActive) classes.push("tab-active");
    if (!tab.isAttached) classes.push("tab-unattached");

    const isMain = tab.id === "tab-main";
    const closeBtn = isMain
      ? ""
      : `<span class="tab-close" data-tab-close="${tab.id}">&times;</span>`;

    html += `<div class="${classes.join(" ")}" data-tab-id="${tab.id}">
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
  if (!bar || !scroll) return;
  const overflows = scroll.scrollWidth > scroll.clientWidth;
  bar.classList.toggle("has-overflow", overflows);
}

function switchToTab(tabId: string) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || tab.id === activeTabId) return;

  activeTabId = tab.id;

  if (tab.isAttached && tab.sessionKey) {
    sessionKey = tab.sessionKey;
    messages = [];
    updateChat();
    loadChat();
    updateSelect();
    updateSessionsPanel();
    const tmCanvas = $("treemap-canvas");
    if (tmCanvas) (tmCanvas as any).__treemapRefresh?.();
    timelineCtrl?.loadSession(sessionKey);
  } else {
    sessionKey = "";
    messages = [];
    updateChat();
    updateSelect();
  }

  renderTabs();
  saveTabs();
}

function createTab(): Tab {
  const tab: Tab = {
    id: generateTabId(),
    sessionKey: null,
    title: randomFortune(),
    isAttached: false,
  };
  tabs.push(tab);
  saveTabs();
  return tab;
}

function closeTab(tabId: string) {
  if (tabId === "tab-main") return;

  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;

  tabs.splice(idx, 1);

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
  if (!tab) return;

  const existing = tabs.find((t) => t.sessionKey === key && t.id !== activeTabId);
  if (existing) {
    switchToTab(existing.id);
    return;
  }

  tab.sessionKey = key;
  tab.isAttached = true;
  const sess = sessions.find((s: any) => s.key === key);
  if (sess?.label) tab.title = sess.label.slice(0, 30);

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
    // Extract reset date from "regain access on 2026-04-01 at 00:00 UTC"
    const resetMatch = errMsg.match(/regain access on (\d{4}-\d{2}-\d{2}(?: at [^.]+)?)/i);
    if (resetMatch) return `billing cap — resets ${resetMatch[1]}`;
    if (/credit|payment/i.test(errMsg)) return "billing — no credits";
    return "billing cap reached";
  }

  if (reason === "auth" || reason === "auth_permanent") {
    if (/refresh token.*(?:not found|invalid|revoked|expired)/i.test(errMsg))
      return "OAuth token revoked — needs re-login";
    if (/OAuth token refresh failed/i.test(errMsg)) return "OAuth refresh failed — needs re-login";
    if (/token.*expired/i.test(errMsg)) return "token expired";
    if (/invalid.*key|invalid.*api/i.test(errMsg)) return "invalid API key";
    if (/unauthorized|forbidden|permission/i.test(errMsg)) return "access denied";
    return reason === "auth_permanent" ? "auth permanently failed" : "auth error";
  }

  if (reason === "rate_limit") {
    if (/retry.after.*(\d+)/i.test(errMsg)) {
      const secs = errMsg.match(/retry.after.*?(\d+)/i);
      return secs ? `rate limited — retry in ${secs[1]}s` : "rate limited";
    }
    if (/tokens? per minute|tpm/i.test(errMsg)) return "TPM limit hit";
    if (/requests? per minute|rpm/i.test(errMsg)) return "RPM limit hit";
    if (/quota/i.test(errMsg)) return "quota exceeded";
    return "rate limited";
  }

  if (reason === "timeout") return "timeout";
  if (reason === "model_not_found") return "model not found";
  if (reason === "session_expired") return "session expired";
  if (reason === "format") return "request format rejected";
  if (reason === "cooldown") return "in cooldown";
  if (reason === "overloaded" || /overloaded|503|capacity/i.test(e)) return "overloaded";

  // Fallback: show truncated raw message if we have one, otherwise the reason code
  if (errMsg && errMsg.length > 0) {
    // Try to extract just the message field from JSON error responses
    const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]{1,80})"/);
    if (msgMatch) return msgMatch[1];
    return errMsg.slice(0, 80);
  }
  return reason || "unknown error";
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
  short = short.replace("opus", "op").replace("sonnet", "sn").replace("haiku", "hk");
  return short;
}

function providerOf(id: string): string {
  return id.split("/")[0] || "unknown";
}

// Performance ranking for sorting configured models (lower = more performant).
// Uses keyword matching against the model name portion of the ID.
function modelPerfRank(id: string): number {
  const lo = id.toLowerCase();
  // Tier 0: frontier reasoning (opus, pro-preview, o1)
  if (lo.includes("opus") || lo.includes("pro-preview") || lo.includes("-o1")) return 0;
  // Tier 1: strong general (sonnet, pro, gpt-4o)
  if (
    lo.includes("sonnet") ||
    (lo.includes("pro") && !lo.includes("preview")) ||
    lo.includes("gpt-4o")
  )
    return 1;
  // Tier 2: balanced (flash non-lite, haiku)
  if (lo.includes("flash") && !lo.includes("lite")) return 2;
  if (lo.includes("haiku")) return 3;
  // Tier 3: lightweight / local
  if (lo.includes("lite") || lo.includes("mini") || lo.includes("nano")) return 4;
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
      // Hide redundant "default(api_key)" tags — only show meaningful labels
      const showSuffix = keyLabel && keyLabel !== "default";
      const suffix =
        showSuffix && mode && mode !== "api_key"
          ? ` \u00b7 ${keyLabel} (${mode})`
          : showSuffix
            ? ` \u00b7 ${keyLabel}`
            : "";
      html += renderModelRow(
        modelId,
        provider,
        name,
        badge,
        suffix,
        counts.get(keyId || modelId) || 0,
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
        const keyLabel = prof.label || keyId.split(":")[1] || keyId;
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
  if (primary) chain.push(primary);
  if (fallbacks?.length) chain.push(...fallbacks);

  if (chain.length) {
    const open = !collapsedModelSections.has("fallback");
    const badges = ["\u2460", "\u2461", "\u2462", "\u2463", "\u2464", "\u2465", "\u2466", "\u2467"];
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
    otherIds.sort((a, b) => modelPerfRank(a) - modelPerfRank(b));
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
      if (!group) return;
      const section = group.dataset.section;
      if (!section) return;
      group.classList.toggle("open");
      if (group.classList.contains("open")) {
        collapsedModelSections.delete(section);
      } else {
        collapsedModelSections.add(section);
      }
    });
  });

  // Sync overseer pills with the same data
  updateOverseerPanel();
}

function shortErrorLabel(reason: string): string {
  switch (reason) {
    case "billing":
      return "billing cap";
    case "rate_limit":
      return "rate limited";
    case "overloaded":
      return "overloaded";
    case "auth":
    case "auth_permanent":
      return "auth error";
    case "timeout":
      return "timeout";
    default:
      return "error";
  }
}

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
  const errorBadge = errorInfo
    ? `<span class="model-error-badge" data-hint="${esc(errorInfo.error)}">${shortErrorLabel(errorInfo.reason)}</span>`
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
  const errorBadge = errorInfo
    ? `<span class="model-error-badge" data-hint="${esc(errorInfo.error)}">${shortErrorLabel(errorInfo.reason)}</span>`
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
    (tmCanvas as any).__treemapRefresh?.();
  }
}

// ─── Response map ───
function updateResponseMap() {
  const canvas = $("response-canvas");
  if (canvas) {
    (canvas as any).__responseRefresh?.();
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
  if (/:main$/.test(key)) {
    return { group: "pinned", shortLabel: "main" };
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

  if (!sessions.length) {
    el.innerHTML = '<div style="padding:20px;color:var(--muted);font-size:11px">No sessions</div>';
    return;
  }

  // Group sessions
  const groups = new Map<string, Array<{ session: any; shortLabel: string }>>();
  for (const s of sessions) {
    const { group, shortLabel } = classifySession(s.key);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ session: s, shortLabel });
  }

  let html = '<div class="session-list">';

  for (const groupKey of GROUP_ORDER) {
    const items = groups.get(groupKey);
    if (!items || items.length === 0) continue;

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

  // Wire session row clicks
  el.querySelectorAll(".session-row").forEach((row) => {
    row.addEventListener("click", () => {
      const key = (row as HTMLElement).dataset.sessionKey;
      if (!key || key === sessionKey) return;

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

      // Active tab is already attached — open this session in a new tab instead of rebinding
      const newTab = createTab();
      newTab.sessionKey = key;
      newTab.isAttached = true;
      const sess = sessions.find((s: any) => s.key === key);
      if (sess?.label) newTab.title = sess.label.slice(0, 30);
      renderTabs();
      switchToTab(newTab.id);
    });
  });

  // Wire session delete buttons
  el.querySelectorAll(".session-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn as HTMLElement).dataset.deleteKey;
      if (!key) return;
      try {
        await req("sessions.delete", { key });
        // Revert any tab using this session to unattached
        const affectedTab = tabs.find((t) => t.sessionKey === key);
        if (affectedTab && affectedTab.id !== "tab-main") {
          affectedTab.sessionKey = null;
          affectedTab.isAttached = false;
          affectedTab.title = randomFortune();
          if (affectedTab.id === activeTabId) {
            sessionKey = "";
            messages = [];
            updateChat();
          }
          renderTabs();
          saveTabs();
        }
        // Reload from server to get authoritative list
        await loadSessions();
      } catch (err) {
        console.error("Failed to delete session:", err);
      }
    });
  });

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

function renderSessionRow(s: any, shortLabel: string): string {
  const isActive = s.key === sessionKey;
  const label = s.label || s.displayName || shortLabel;
  const tokens = s.totalTokens ? formatNum(s.totalTokens) + " tok" : "";
  const age = s.updatedAt ? timeAgo(s.updatedAt) : "";
  const channel = s.channel ? `<span style="opacity:.5">${esc(s.channel)}</span>` : "";
  return `<div class="session-row${isActive ? " session-active" : ""}" data-session-key="${esc(s.key)}">
    <span class="session-label">${esc(label)} ${channel}</span>
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
      if (atBottom) el.scrollTop = el.scrollHeight;
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
      <button class="nav-btn nav-active" data-tab="chat" data-hint="Chat"><svg viewBox="0 0 24 24" style="stroke:#6b8e23"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>
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
    </nav>
    <div class="topbar">
      <div class="logo" id="new-session-btn" data-hint="New session"><img src="${BASE}icon.png?v=3" alt="T" style="height:108px;width:auto"></div>
      <div class="tab-bar" id="tab-bar">
        <button class="tab-nav tab-nav-left" id="tab-nav-left" data-hint="Scroll left">&#9664;</button>
        <div class="tab-bar-scroll" id="tab-bar-scroll"></div>
        <button class="tab-add" id="tab-add" data-hint="New tab">+</button>
        <button class="tab-nav tab-nav-right" id="tab-nav-right" data-hint="Scroll right">&#9654;</button>
      </div>
      <div class="toolbox">
        <span id="tb-timeline" class="topbar-icon-btn tb-active" data-hint="Timeline">📊</span>
        <span id="tb-models" class="topbar-icon-btn tb-active" data-hint="Models">🧠</span>
      </div>
      <span id="gw-status" style="color:var(--muted);font-size:11px;display:flex;align-items:center;gap:4px"><span class="status-dot gw-dot dot-red"></span> <span id="gw-label">Connecting…</span></span>
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
      <div class="rpanel budget-panel-wrapper">
        <div class="rpanel-header">🧠 Models <button id="budget-refresh" class="budget-refresh-btn" data-hint="Refresh">↻</button></div>
        <div id="budget-panel" class="rpanel-body">Loading...</div>
      </div>
      <div class="rpanel" id="sessions-panel">
        <div class="rpanel-header">📋 Sessions <span id="sessions-count" class="sessions-count"></span></div>
        <div id="sessions-list" class="rpanel-body">Loading...</div>
      </div>
      <div class="rpanel" id="overseer-panel">
        <div class="rpanel-header">🔭 Overseer <span id="overseer-count" class="sessions-count"></span></div>
        <div id="overseer-graph" class="rpanel-body overseer-graph-container"></div>
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
    if (!text) return;
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
    if (left < pad) left = pad;
    if (left + tw > window.innerWidth - pad) left = window.innerWidth - pad - tw;
    // Clamp vertical
    if (top + th > window.innerHeight - pad) top = window.innerHeight - pad - th;

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
  if (ta.value) requestAnimationFrame(autoResizeTA);
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

  // ─── Timeline toggle (bottom panels expand/collapse) ───
  const tlBtn = $("tb-timeline")!;
  tlBtn.addEventListener("click", () => {
    const collapsed = app.classList.toggle("bottom-collapsed");
    tlBtn.classList.toggle("tb-active", !collapsed);
  });

  // ─── Models toggle (right panels expand/collapse) ───
  const mdBtn = $("tb-models")!;
  mdBtn.addEventListener("click", () => {
    const collapsed = app.classList.toggle("right-collapsed");
    mdBtn.classList.toggle("tb-active", !collapsed);
  });

  // ─── Sidebar tab switching ───
  const altView = $("alt-view")!;
  const chatArea = document.querySelector(".chat-area") as HTMLElement;
  const topbar = document.querySelector(".topbar") as HTMLElement;
  const ctxTimeline = $("context-timeline")!;
  const rightPanels = document.querySelector(".right-panels") as HTMLElement;
  const bottomRight = $("bottom-right-panel")!;
  let activeTab = "chat";

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
    | "logs";

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
  };

  function switchTab(tab: string) {
    if (tab === activeTab) return;
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
      return;
    }
    // Show alt-view, hide chat panels
    chatArea.style.display = "none";
    topbar.style.display = "none";
    ctxTimeline.style.display = "none";
    rightPanels.style.display = "none";
    bottomRight.style.display = "none";
    altView.classList.add("alt-active");
    renderAltView(tab as AltTab);
  }

  // ─── Alt-view helpers ───
  function altRelTime(ts: number | string | null | undefined): string {
    if (!ts) return "—";
    const ms = typeof ts === "string" ? new Date(ts).getTime() : ts;
    const diff = Date.now() - ms;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }
  function altDuration(ms: number | null | undefined): string {
    if (!ms) return "—";
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
    return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  }
  function altEsc(s: any): string {
    if (s == null) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function altTokens(n: number | null | undefined): string {
    if (n == null) return "—";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }
  function altJson(obj: any): string {
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
      }
      return;
    }
    // Session delete
    const delBtn = tgt.closest(".alt-session-del") as HTMLElement | null;
    if (delBtn) {
      const key = delBtn.dataset.key!;
      if (key && confirm(`Delete session "${key}"?`)) {
        req("sessions.delete", { key })
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
      if (!method || !resultEl) return;
      let params = {};
      try {
        if (paramsStr) params = JSON.parse(paramsStr);
      } catch {
        if (resultEl)
          resultEl.innerHTML = `<span style="color:var(--red)">Invalid JSON params</span>`;
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
      }
    } catch (e) {
      const body = altView.querySelector(".alt-view-body");
      if (body)
        body.innerHTML = `<div class="alt-placeholder"><span style="color:var(--red)">Error: ${altEsc((e as Error).message)}</span></div>`;
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
    const snapshot = (status as any) ?? {};
    const presenceList = Array.isArray(presence) ? presence : ((presence as any)?.presence ?? []);
    const uptimeMs = snapshot.uptimeMs ?? snapshot.uptime;
    const tickMs = snapshot.policy?.tickIntervalMs ?? snapshot.tickIntervalMs;
    const cronSt = cronStatus as any;
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
            (p: any) => `<div class="row">
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
    const snap = res as any;
    if (!snap || !snap.channels) {
      sub.textContent = "Channel status";
      body.innerHTML = `<div class="alt-placeholder"><span>No channel data available</span></div>`;
      return;
    }
    const channelMeta: any[] = snap.channelMeta ?? [];
    const order: string[] = channelMeta.length
      ? channelMeta.map((m: any) => m.id)
      : (snap.channelOrder ?? Object.keys(snap.channels));
    const labels: Record<string, string> = snap.channelLabels ?? {};
    const accounts: Record<string, any[]> = snap.channelAccounts ?? {};
    const metaMap: Record<string, any> = {};
    for (const m of channelMeta) metaMap[m.id] = m;

    // Sort: enabled channels first, then disabled
    const sorted = order
      .map((ch, i) => {
        const data = snap.channels[ch] ?? {};
        const configured = data.configured ?? data.running ?? data.connected;
        return { ch, configured, order: i };
      })
      .sort((a, b) => {
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
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
          const statusText = connectedVal
            ? "Connected"
            : running
              ? "Running"
              : configured
                ? "Configured"
                : "Not configured";
          const statusCls = connectedVal ? "green" : running ? "green" : configured ? "yellow" : "";

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
          if (qrArea)
            qrArea.innerHTML = `<div style="padding:20px;font-size:10px;color:var(--muted)">Requesting QR…</div>`;
          const r = (await req("web.login.start", { force: action === "relink" }).catch((err) => ({
            message: (err as Error).message,
          }))) as any;
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

  function renderChannelAccounts(accts: any[], channel: string): string {
    const recentMs = 10 * 60 * 1000;
    return `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:6px">
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px">${accts.length} account(s)</div>
      ${accts
        .map((a: any) => {
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
          const probe = a.probe as any;
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
    let list: any[] = (res as any)?.sessions ?? [];
    const mainKey = (res as any)?.mainSessionKey;

    // Filter by activity window
    if (sessFilterActive !== "all") {
      const cutoff =
        Date.now() -
        ({ "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[
          sessFilterActive
        ] ?? 0);
      list = list.filter((s: any) => {
        const ts = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
        return ts >= cutoff;
      });
    }

    // Sort
    if (sessSortBy === "tokens") {
      list.sort(
        (a: any, b: any) =>
          (b.inputTokens ?? 0) +
          (b.outputTokens ?? 0) -
          ((a.inputTokens ?? 0) + (a.outputTokens ?? 0)),
      );
    } else if (sessSortBy === "key") {
      list.sort((a: any, b: any) => (a.key ?? "").localeCompare(b.key ?? ""));
    } else {
      list.sort((a: any, b: any) => {
        const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return tb - ta;
      });
    }

    // Apply limit
    const totalCount = list.length;
    if (sessFilterLimit > 0) list = list.slice(0, sessFilterLimit);

    const totalTokens = list.reduce(
      (sum: number, s: any) => sum + (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
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
            .map((s: any) => {
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
        if (field === "active") sessFilterActive = (el as HTMLSelectElement).value;
        else if (field === "sort") sessSortBy = (el as HTMLSelectElement).value as any;
        else if (field === "limit")
          sessFilterLimit = parseInt((el as HTMLInputElement).value, 10) || 50;
        else if (field === "global") sessIncludeGlobal = (el as HTMLInputElement).checked;
        else if (field === "unknown") sessIncludeUnknown = (el as HTMLInputElement).checked;
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
    const usageData = usage as any;
    const costData = cost as any;
    const totals = usageData?.totals ?? {};
    const sessionUsage: any[] = usageData?.sessions ?? [];
    const dailyCost: any[] = costData?.daily ?? [];
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
      if (s.model) modelMap[s.model] = (modelMap[s.model] ?? 0) + tok;
      if (s.provider) providerMap[s.provider] = (providerMap[s.provider] ?? 0) + tok;
      if (tok > topSession.tokens) topSession = { key: s.sessionKey ?? s.key ?? "?", tokens: tok };
    }
    const topModel = Object.entries(modelMap).sort((a, b) => b[1] - a[1])[0];
    const topProvider = Object.entries(providerMap).sort((a, b) => b[1] - a[1])[0];

    // Daily bar chart data
    const maxDailyCost =
      dailyCost.reduce((mx: number, d: any) => Math.max(mx, Number(d.cost ?? 0)), 0) || 1;

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
              .sort((a, b) => b[1] - a[1])
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
            .map((d: any) => {
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
              .sort(
                (a: any, b: any) =>
                  (b.inputTokens ?? 0) +
                  (b.outputTokens ?? 0) -
                  ((a.inputTokens ?? 0) + (a.outputTokens ?? 0)),
              )
              .slice(0, 50)
              .map((s: any) => {
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
    const st = status as any;
    const jobs: any[] = (jobsRes as any)?.jobs ?? [];
    const enabledCount = jobs.filter((j: any) => j.enabled).length;
    sub.textContent = `${jobs.length} job(s) · ${enabledCount} enabled · ${st?.enabled ? "Cron active" : "Cron disabled"}`;

    // Fetch runs for selected job or all
    let runs: any[] = [];
    let runsTotal = 0;
    if (cronSelectedJobId || jobs.length) {
      const runsRes = (await req("cron.runs", {
        jobId: cronSelectedJobId ?? undefined,
        limit: 20,
      }).catch(() => null)) as any;
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
            ${jobs.length ? jobs.map((j: any) => renderCronJob(j)).join("") : `<div style="color:var(--muted);font-size:11px;padding:20px 0">No cron jobs configured</div>`}
          </div>
        </div>
        <div>
          <div class="alt-card"><h3>Run History${cronSelectedJobId ? ` — ${altEsc(jobs.find((j: any) => j.id === cronSelectedJobId)?.name ?? cronSelectedJobId)}` : " — All jobs"} <span style="color:var(--muted);font-size:10px">(${runsTotal})</span></h3>
            <div style="margin-bottom:6px;display:flex;gap:4px">
              <button class="alt-cron-scope" data-scope="all" style="background:${!cronSelectedJobId ? "var(--surface2)" : "transparent"};border:1px solid var(--border);color:var(--muted);border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer">All jobs</button>
            </div>
            ${runs.length ? runs.map((r: any) => renderCronRun(r)).join("") : `<div style="color:var(--muted);font-size:11px;padding:20px 0">No runs recorded</div>`}
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

  function renderCronJob(j: any): string {
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

  function renderCronRun(r: any): string {
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
    const data = agentsRes as any;
    const agents: any[] = data?.agents ?? [];
    const defaultId = data?.defaultId ?? "";
    const toolsCat = toolsRes as any;
    const profiles: any[] = toolsCat?.profiles ?? [];
    const groups: any[] = toolsCat?.groups ?? [];
    const totalTools = profiles.reduce(
      (s: number, p: any) => s + (p.toolCount ?? p.tools?.length ?? 0),
      0,
    );
    sub.textContent = `${agents.length} agent(s) · ${totalTools} tools · ${profiles.length} profile(s)`;

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${agents
          .map((a: any) => {
            const isDefault = a.id === defaultId;
            const fb: any[] = Array.isArray(a.fallbacks) ? a.fallbacks : [];
            const channels: any[] = Array.isArray(a.channels) ? a.channels : [];
            const skills: any[] = Array.isArray(a.skills) ? a.skills : [];
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
                .map((f: any, i: number) => {
                  const label =
                    typeof f === "string" ? f : `${f.model ?? "?"} (${f.provider ?? "?"})`;
                  return `<span style="padding:1px 6px;border-radius:3px;font-size:9px;background:var(--surface2);color:var(--muted)">${i + 1}. ${altEsc(label)}</span>`;
                })
                .join("")}</div>
            </div>`
                : ""
            }
            ${channels.length ? `<div style="margin-top:4px;font-size:10px;color:var(--muted)">Channels: ${channels.map((c: any) => altEsc(typeof c === "string" ? c : (c.id ?? c.name ?? "?"))).join(", ")}</div>` : ""}
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
            .map((p: any) => {
              const tools: any[] = p.tools ?? [];
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
                        (t: any) =>
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
          .map((g: any) => {
            const tools: any[] = g.tools ?? [];
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
    const data = res as any;
    const skills: any[] = data?.skills ?? [];
    const enabledCount = skills.filter((s: any) => s.enabled !== false).length;
    const issueCount = skills.filter(
      (s: any) => s.missingBinaries?.length || s.unavailableReason,
    ).length;
    sub.textContent = `${skills.length} skill(s) · ${enabledCount} enabled${issueCount ? ` · ${issueCount} with issues` : ""}`;
    if (!skills.length) {
      body.innerHTML = `<div class="alt-placeholder"><span>No skills registered</span></div>`;
      return;
    }
    const grouped: Record<string, any[]> = {};
    for (const s of skills) {
      const group = s.source ?? s.group ?? "other";
      (grouped[group] ??= []).push(s);
    }
    body.innerHTML = Object.entries(grouped)
      .map(
        ([group, items]) => `
      <div class="alt-card">
        <h3 style="display:flex;justify-content:space-between;align-items:center">${altEsc(group)}
          <span style="font-size:10px;font-weight:400;color:var(--muted)">${items.filter((s: any) => s.enabled !== false).length}/${items.length} enabled</span>
        </h3>
        ${items
          .map((s: any) => {
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
    const nodes: any[] = (nodesRes as any)?.nodes ?? [];
    const pending: any[] = (devicesRes as any)?.pending ?? [];
    const paired: any[] = (devicesRes as any)?.paired ?? [];
    const onlineNodes = nodes.filter((n: any) => n.connected !== false && n.status !== "offline");
    sub.textContent = `${nodes.length} node(s) · ${onlineNodes.length} online · ${paired.length} device(s) · ${pending.length} pending`;

    body.innerHTML = `
      ${
        pending.length
          ? `<div class="alt-card" style="border-color:var(--yellow)"><h3>Pending Device Requests (${pending.length})</h3>
        ${pending
          .map(
            (
              d: any,
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
              d: any,
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
            .map((n: any) => {
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
    const cfg = configRes as any;
    const schema = schemaRes as any;
    const models: any[] = (modelsRes as any)?.models ?? [];
    const valid = cfg?.valid !== false;
    const issues: any[] = cfg?.issues ?? [];
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
                  .map((m: any) => {
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
          .map((i: any) => {
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
        if (!view) return;
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
    params: any;
    result: any;
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
    (window as any).__tinkerReq = req;

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
                .reverse()
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
        if (methodInput) methodInput.value = (btn as HTMLElement).dataset.method ?? "";
      });
    });
    // Wire history items to replay
    body.querySelectorAll(".alt-debug-history-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt((el as HTMLElement).dataset.idx ?? "0", 10);
        const entry = debugRpcHistory[idx];
        if (!entry) return;
        const methodInput = document.getElementById("alt-debug-method") as HTMLInputElement;
        const paramsInput = document.getElementById("alt-debug-params") as HTMLTextAreaElement;
        const resultEl = document.getElementById("alt-debug-result");
        if (methodInput) methodInput.value = entry.method;
        if (paramsInput) paramsInput.value = JSON.stringify(entry.params, null, 2);
        if (resultEl)
          resultEl.innerHTML = entry.error
            ? `<span style="color:var(--red)">${altEsc(entry.error)}</span>`
            : altJson(entry.result);
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
        if (logsLevelFilters.has(lv)) logsLevelFilters.delete(lv);
        else logsLevelFilters.add(lv);
        (el as HTMLElement).style.background = logsLevelFilters.has(lv)
          ? "var(--surface2)"
          : "transparent";
      });
    });
    // Export logs
    document.getElementById("alt-logs-export")?.addEventListener("click", () => {
      const stream = document.getElementById("alt-logs-stream");
      if (!stream) return;
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
      if (counter) counter.textContent = "0 lines";
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
    )) as any;
    if (!res?.lines?.length) {
      if (!logsCursor) stream.innerHTML = `<span class="muted">No logs available</span>`;
      return;
    }
    logsCursor = res.cursor;
    const filtered = res.lines.filter((line: string) => {
      if (logsFilterText && !line.toLowerCase().includes(logsFilterText.toLowerCase()))
        return false;
      const lvMatch = line.match(/\b(trace|debug|info|warn|error|fatal)\b/i);
      if (lvMatch && !logsLevelFilters.has(lvMatch[1].toLowerCase())) return false;
      return true;
    });
    if (!filtered.length) return;
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
      while (stream.children.length > 2000) stream.removeChild(stream.firstChild!);
    }
    // Update line counter
    const counter = document.getElementById("alt-logs-count");
    if (counter) counter.textContent = `${logsLineCount} lines`;
    if (logsAutoFollow) stream.scrollTop = stream.scrollHeight;
  }

  // Delegated click handler for sidebar nav buttons
  document.querySelector(".sidebar")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".nav-btn[data-tab]") as HTMLElement | null;
    if (!btn) return;
    const tab = btn.dataset.tab!;
    switchTab(tab);
  });

  $("new-session-btn")!.addEventListener("click", async () => {
    if (!connected) return;

    const tab = tabs.find((t) => t.id === activeTabId);

    messages.length = 0;
    streamMsgIdx = -1;
    frozenTextEnd = 0;
    lastDeltaLen = 0;
    streamRunId = null;
    sending = false;
    if (sessionKey) clearPersistedErrors(sessionKey);
    updateChat();
    updateBtn();

    if (activeRuns.size > 0 || pendingRunDeletes.size > 0) {
      await abort();
    }

    if (tab && !tab.isAttached) {
      const mainKey = tabs.find((t) => t.id === "tab-main")?.sessionKey || "";
      if (mainKey) {
        sessionKey = mainKey;
        send("/new");
      }
    } else {
      send("/new");
    }
  });

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
    if (e.button !== 1) return; // middle button only
    e.preventDefault();
    const tabEl = (e.target as HTMLElement).closest("[data-tab-id]") as HTMLElement | null;
    if (tabEl) closeTab(tabEl.dataset.tabId!);
  });

  $("tab-add")!.addEventListener("click", () => {
    const tab = createTab();
    renderTabs();
    switchToTab(tab.id);
  });

  $("tab-nav-left")!.addEventListener("click", () => {
    const scroll = $("tab-bar-scroll");
    if (scroll) scroll.scrollBy({ left: -150, behavior: "smooth" });
  });
  $("tab-nav-right")!.addEventListener("click", () => {
    const scroll = $("tab-bar-scroll");
    if (scroll) scroll.scrollBy({ left: 150, behavior: "smooth" });
  });

  $("tab-bar")!.addEventListener(
    "wheel",
    (e) => {
      const scroll = $("tab-bar-scroll");
      if (!scroll) return;
      e.preventDefault();
      scroll.scrollBy({ left: e.deltaY > 0 ? 80 : -80 });
      checkTabOverflow();
    },
    { passive: false },
  );

  window.addEventListener("resize", checkTabOverflow);

  // Delegated stop-button handler on messages container — survives innerHTML wipes
  $("messages")!.addEventListener("click", (e) => {
    const run = (e.target as HTMLElement).closest(".thinking-run[data-run-id]");
    if (run) abort();
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
    const ctxBack = !!(tmCanvas as any).__treemapCanGoBack?.() || !!(tmCanvas as any).__hasOverlay;
    const respBack =
      !!(respCanvas as any).__responseCanGoBack?.() || !!(respCanvas as any).__hasOverlay;
    if (backCtx) backCtx.style.display = ctxBack ? "" : "none";
    if (backResp) backResp.style.display = respBack ? "" : "none";

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
    if ((tmCanvas as any).__treemapCanGoBack?.()) {
      (tmCanvas as any).__treemapBack?.();
    } else {
      // We're in an overlay (auto-summary) — clear overlay and refresh back to L1 treemap
      (tmCanvas as any).__hasOverlay = false;
      (tmCanvas as any).__treemapRefresh?.();
    }
    updateBackButtons();
  });
  backResp?.addEventListener("click", () => {
    if ((respCanvas as any).__responseCanGoBack?.()) {
      (respCanvas as any).__responseBack?.();
    } else {
      (respCanvas as any).__hasOverlay = false;
      (respCanvas as any).__responseRefresh?.();
    }
    updateBackButtons();
  });

  // Observe treemap re-renders to update back button visibility
  const backObserver = new MutationObserver(updateBackButtons);
  backObserver.observe(tmCanvas, { childList: true, subtree: true });
  backObserver.observe(respCanvas, { childList: true, subtree: true });

  // Also expose direct callback for level changes (catches async updates the observer might miss)
  (tmCanvas as any).__onLevelChange = updateBackButtons;
  (respCanvas as any).__onLevelChange = updateBackButtons;

  // ─── Auto-summary on bar re-click ───
  async function triggerAutoSummary(event: any, type: "context" | "response") {
    const panel = type === "context" ? tmCanvas : respCanvas;
    const ts = event.timestampMs ?? (event.timestamp ? new Date(event.timestamp).getTime() : null);
    panel.innerHTML = '<div class="tm-empty">Summarizing\u2026</div>';
    try {
      const params: any = {
        component: type === "context" ? "current_prompt" : "response",
        sessionKey: sessionKey || undefined,
      };
      if (ts) params.timestamp = ts;
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
      (panel as any).__hasOverlay = true;
      // Give DOM a tick to render before checking scroll
      setTimeout(updateBackButtons, 10);
    } catch (e: any) {
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
        updateResponseMap();
      } else {
        switchBrpTab("context");
        (tmCanvas as any).__treemapShowAnatomy?.(event);
      }
      updateBackButtons();
    },
    () => sessionKey,
    () => (import.meta.env.DEV ? "http://localhost:18789" : ""),
    PROVIDER_ICONS,
    (groupIndex, firstEvent) => {
      // Show the prompt's context anatomy in the treemap
      switchBrpTab("context");
      (tmCanvas as any).__treemapShowAnatomy?.(firstEvent);
      updateBackButtons();

      // Scroll webchat to the Nth user message matching this group
      const container = $("messages");
      if (!container) return;
      const userMsgs = container.querySelectorAll(".msg.user");
      if (groupIndex >= userMsgs.length) return;
      const target = userMsgs[groupIndex] as HTMLElement;
      // Manual smooth scroll within the .messages container
      const targetTop = target.offsetTop - container.offsetTop;
      const dest = targetTop - container.clientHeight / 2 + target.offsetHeight / 2;
      const start = container.scrollTop;
      const delta = dest - start;
      const duration = 350;
      let t0: number | null = null;
      function step(ts: number) {
        if (!t0) t0 = ts;
        const elapsed = ts - t0;
        const progress = Math.min(elapsed / duration, 1);
        // ease-out cubic
        const ease = 1 - Math.pow(1 - progress, 3);
        container!.scrollTop = start + delta * ease;
        if (progress < 1) requestAnimationFrame(step);
        else {
          target.classList.add("scroll-highlight");
          setTimeout(() => target.classList.remove("scroll-highlight"), 900);
        }
      }
      requestAnimationFrame(step);
    },
    (mode) => {
      if (mode === "all") {
        timelineCtrl?.loadAllSessions(sessions.map((s: any) => s.key));
      } else {
        timelineCtrl?.loadSession(sessionKey);
      }
    },
  );
}

// ─── Overseer Graph ───
let overseerCtrl: ReturnType<typeof mountOverseerGraph> | null = null;

function updateOverseerPanel(): void {
  if (!overseerCtrl) return;
  if (activeRuns.size === 0) {
    overseerCtrl.update([]);
    const countEl = document.getElementById("overseer-count");
    if (countEl) countEl.textContent = "";
    return;
  }

  const authProfiles = modelConfigData?.authProfiles ?? {};
  const items: OverseerItem[] = [];

  for (const [runId, info] of activeRuns) {
    const authLabel = info.authProfileId
      ? authProfiles[info.authProfileId]?.label ||
        info.authProfileId.split(":")[1] ||
        info.authProfileId
      : "";
    items.push({
      id: runId,
      provider: info.provider,
      modelName: modelName(info.model),
      authLabel,
      badge: "",
      count: 1,
    });
  }

  overseerCtrl.update(items);
  const countEl = document.getElementById("overseer-count");
  if (countEl) {
    countEl.textContent = `(${items.length})`;
  }
}

// ─── Boot ───
init();
// Mount overseer graph AFTER init() creates the DOM
const overseerContainer = document.getElementById("overseer-graph");
if (overseerContainer) {
  overseerCtrl = mountOverseerGraph(overseerContainer, {
    providerIcons: PROVIDER_ICONS,
  });
}
gwConnect();
setInterval(() => {
  if (connected) {
    loadBudget();
  }
}, 300_000);
