## Chapter: delivery — hold what was delivered against what was expected

_Why this chapter came with your prompt: the turn produced something for the owner (a document, a
build, a fix, a message, a status) and the gate judged it worth checking. v4 chapters 2 (expected
against delivered, 2026-10-03), 5 (green is what the owner can observe), 7 (count the class,
2026-08-22) and 11 (memory, ripple, recipe, preempt)._

### Expected against delivered: find the gap before the owner does

- [ ] List what was expected: his ask, plus every step and "Done when" line of the recipe or skill
      that governed the task. Read the file; never list it from memory. If no recipe governs it,
      use his words and the house conventions the turn touched.
- [ ] Check each item against the artifact, not against the turn's account of it: open the file,
      grep the PDF, count the figures, run the test, load the page. "The turn said it did X" is not
      evidence that X is there.
- [ ] A gap is a defect, found here, not by him. Close it in the deliverable if it is in reach
      (self-repair, in the core). Then find why it happened: was the step missing from the recipe,
      worded so it could not fire, or there and skipped? Fix the cause at that layer, with a dated
      Failures Overcome entry, and report the gap, the cause, the fix and its commit.

Worked instance, 2026-10-03: compile-paper's figure step sends a paper's diagrams to Napkin, and
a 62-page research PDF went out with one D2 drawing. The reflection wrote up pandoc and grep
troubles and never held the PDF against the recipe. The owner pointed out the missing Napkin
diagrams and asked whether the Fractal turn had caught the gap. It had not.

### Sub-checks: each is a gap class the owner found before Fractal did

- [ ] **Hedges, workarounds, warnings.** Every hedge in the reply ("not confirmed", "unverified",
      "I did not find"), every workaround (a hook or tool refused a legitimate action and the turn
      went around it), every warning the runtime put in context: write what is known, assumed and
      not known, then fix it. (2026-10-03: a "written, not confirmed running" caveat, a guard hook that
      misread a `cd`, a bootstrap truncation warning; the reflection followed up none.) A caveat
      that hands the owner a repair before he can use the deliverable ("check how it renders", "the
      logo is missing", "fill X yourself") is the gap itself: fix the artifact. (2026-10-09: two
      supplier rounds drafted with a typed sign-off, which was not the real signature.) A graph
      with one row far above the rest is the same gap: separate that row or ask before it ships.
      (2026-11-18: one bar was 580 times the next, and the reply told him to compare the others
      by their numbers; he had the big row taken out.)
      A reading the reply states for an ambiguous input ("I took 20×13 cm as 20 wide") is a hedge
      too: check the input's source (the sender's message, a drawing), and when it cannot settle it,
      deliver both readings. (2026-10-09: six landscape options for a print that
      was 13 wide by 20 tall, when it had to be portrait.)
- [ ] **A known limit in a design doc is a hedge that outlives the turn.** Read the "known limits"
      the turn wrote into the bible, a README or a comment. One he will meet in his own daily use
      (the phone and the laptop open at once, two windows, a reload to see the truth) hands him the
      repair: fix it while the parts are at hand, or ask him; never file it as "not a bug".
      (2026-10-27: the unread mark synced between devices only at load, filed in done-signals §2c
      as a known limit although the 2026-10-19 live tab re-sync already re-read the same file;
      2026-11-14 he asked for that exact fix, bug `unread-glow-per-device`.)
- [ ] **Waiters on someone else.** A hedge that waits on someone ("live once X happens", "when the
      other session merges", "after his answer") is covered only once you checked X can still
      happen: the session's last write, the person's reply, the job's state. A waiter on a dead
      session is a promise nobody keeps; if the blocker is dead and the repair reversible, do it.
      (2026-10-05: the Gantt tab would go live "once the shared checkout is back on develop"; that
      session had died at 09:48; two hours later the owner reported the tab still missing.)
- [ ] **Blocked-route hedges.** "Can't see it" blamed on a blocked route (an expired token, a
      missing login, "renewing is the owner's step") is not closed by naming who owns the block:
      the question was about the data. List every other read path (shared browser tabs, Copilot, a
      local cache, another channel) with the command that lists it, and try them. (2026-10-05: a reply was reported
      unreadable because a mail token had expired, while another read path that would have found it
      in one ask was never listed.)
- [ ] **Unreachable-host hedges.** "Could not reach it" about a host or a service ("no response",
      "silent from the LAN", "port closed") is covered only by a probe in THIS turn's tool calls: a
      ping and a connect to the service port. Grep the turn's own commands for the address; if none
      touched it, the hedge came from a note, and a stored negative is expired on read. Run the
      probe before the reply goes out. (2026-10-15: a colleague was told a lab machine did not
      answer, from the previous day's note, with no command to it in the turn; ping and login
      worked at the first try.)
- [ ] **Messages for another person.** A message meant to let someone DO something (log in, pay,
      show up) is read as the recipient: does it carry every input they need (address, name,
      token, date) and nothing the ask did not request (a diagnosis, tips, questions)? (2026-10-05:
      a colleague needed a token and got a note about an outage instead.) Every physical fact it depends on (a button, a port, a menu path) is checked against
      the vendor's spec for the exact model; a sibling model or a forum post is not evidence.
      (2026-10-09: a colleague was told to press a BIOS button his motherboard model does not have.)
- [ ] **Class listings.** A delivery that lists the members of a class (machines, files, people) is
      held against a census of that class from every source that names a member, retired, pending
      and commented-out entries included; name each one left out and why. (2026-10-05: the machines
      panel copied only the active rows of a hosts file and left out two machines listed in its
      comments.) A view built from DATA rows (usage, logins, activity) lists only who has data:
      build its rows from the roster and join the data on, so a member with no data shows as a
      zero. Read each name as he will: a lowercase or id-shaped name among written-out ones is a
      data defect. (2026-11-18: a tokens-per-person graph built from ledger rows left out an active
      colleague with no calls and showed another colleague's name in lowercase; its reflection had
      the people table in context, checked neither, and the owner named both.)
- [ ] **A design serves the needs that were stated.** A design or plan handed over (a network
      layout, an architecture, a list of phases) is held against what was asked. Every component
      and phase names the stated need it serves; one that serves a need nobody stated (office
      access, internet, a backup path) is drawn OPTIONAL, and the assumption behind it is asked in
      one line instead of built in. (2026-10-19: asked to keep robot traffic apart from office
      traffic, a target diagram drew a new cable from the main router to the robot switches and
      made its phase mandatory, for a need nobody had stated; the colleague asked why the switches
      needed that link at all.)
- [ ] **A rebuilt or copied artifact re-inherits every old correction.** When a turn rewrites
      content into a new artifact (a new layout, a merged version, a copy for another audience),
      list the dated corrections in the note or recipe that governs that content and grep the new
      artifact for each one before "clean". Checking only the new ask lets an error that was
      already corrected ride along into the copy. (2026-10-28: a field guide rebuilt into linear
      steps still told the reader to press a power button his robot model does not have; the
      governing note had already ruled that step out.)
- [ ] **A feature built here is a feature shipped.** TinkerClaw is a public fork: anything merged
      into `develop` reaches clones without our keys, seats or services. Hold a new capability
      against a fresh clone: bundled on, dormant or off; which key or paid service it needs; what it
      does without it (dormant, no calls, no error lines); how the user learns it needs one; what
      switches it on. An unanswered row is a gap. (2026-10-06, Broca retrieval v2, seven
      reflections, none asked how the Jev-dependent capabilities would ship; the owner had to.)
- [ ] **A moved trigger keeps its old flaws, without the old cover.** When a turn changes where or
      when something runs (same session → own session, in line → queued, one process → two),
      re-read every firing condition it inherited. (2026-10-09: the background Fractal kept firing
      on any `final`, including the early final of a prompt folded into a running turn, and started
      blind while the turn ran.)
- [ ] **The scope he named.** A class ask with no bound ("our saved X", "does X work") covers the
      whole class over its whole history; a reply that checked a slice without saying so in its
      first line is a gap. (2026-10-09: five sessions checked, he wanted every fractal turn ever
      run; the census covered 2,675; recipe `fractal-census`.)
- [ ] **Fractal waits until the longjob ends.** A job that spans turns is one task. Do not start
      a reflection on an early `final` while the card is still running; the thinking line stays
      below until the work is over. (2026-10-25, raised twice in one night.) Sister of the
      2026-10-09 moved-trigger miss above. The gate is code. This line is the doctrine so the next
      reflection does not re-derive it.
- [ ] **Long jobs need the card, in this chat, before the work.** A job that outlives the turn is
      unfinished until he can see it running: start the longjob card (skill `longjob`), then end
      the turn and let the wake come back. A question about progress, about whether the wake will
      come, or a missing progress bar is a gap: the recipe already exists, skipping it is the miss.
      (2026-09-29; 2026-10-06; 2026-10-18.)
- [ ] **A named-file delete is one inode.** `ls -li` before, delete that inode, `ls -li` after. A
      sweep, a glob or a "while I am here" tidy is a gap. (2026-10-07: an ask to delete one
      corrupted file became ~10 GB gone, two datasets among them.)
- [ ] **A status answer is a delivery too.** "Where are we", "what is pending": the recipe that
      governs that work shapes the answer, and its report artifact (a commit diagram, a Gantt, a
      test sheet) is part of what was expected. (2026-10-05: `orbis-coding`'s diagram step never
      ran; the owner noted both the missing diagram and the wrong recipe.)
- [ ] **The delivered reply is the artifact too (2026-10-04).** When a chart or image is owed
      inline, check the reply text against the channel's rendering procedure. In Tinker an
      `[embed ref=...]` alone fails the inline-diagram contract even when the file exists; a
      screenshot of a separately hosted page never satisfies it. (Origin: a Gantt chart that never
      appeared in the chat.)

### Green is what the OWNER can observe

- [ ] No "fixed" / "wired" / "works" survives without re-running the failing operation and
      watching it come back green. A build that compiles, a file that saves, a test that passes:
      none is the change appearing where he looks. Climb only as far as the claim needs, never
      claim above where you climbed:

  | claim about…                                | valid green                                                                                                                                                                                       |
  | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | text / wiring / a value being present       | find the string in the SERVED output of the URL he named, loaded as him                                                                                                                           |
  | how something LOOKS (colour, logo, spacing) | a render you actually LOOK at: screenshot or drive the browser                                                                                                                                    |
  | a motion / blink / pulse / animation        | the same LOOK: a screenshot or a driven UI. Sound is not green                                                                                                                                    |
  | a control that appears only after an action | DRIVE the interaction first, then look in THAT state                                                                                                                                              |
  | code you edited but did not deploy          | say **written, not running**: source ≠ built ≠ restarted                                                                                                                                          |
  | a file / document he should open            | a clickable path or a media attachment that opens on HIS machine; naming it is not a link. A path that was hard to click (2026-10-18 11:29, the Ink & Switch PDF) is the same miss as 2026-09-16. |
  | a file he RUNS (macros, a script, a tool)   | the delivered file, unpatched, run in HIS program                                                                                                                                                 |

- [ ] **The page he named, not the page behind it (2026-10-07).** Asked to add an item to a named
      wiki page, a turn decided that page was an alias, edited a neighbouring page, and called it
      done because that file grew. The named page renders a static one-pager and never shows that
      file; the colleague saw no change. File size on a neighbour is not green: load the exact URL
      from the ask, with his login, and find the new string there.
- [ ] **A link that opens on his machine, not on ours (2026-10-08).** Asked for an HTML index to
      open, a turn sent it as a media attachment plus a path. The gateway sends host-local files as
      media only when they are images, audio, video, PDF or Office files
      (`HOST_READ_ALLOWED_DOCUMENT_MIMES` in `src/media/web-media.ts`), and a path opens on the
      gateway host, while the colleague's browser reached the chat through a tunnel: he saw "media
      failed". Before calling a file delivered, check its type against that list and ask where the
      reader's browser runs. Anything else goes out as an http URL he can reach, fetched once with
      curl: 200, the right content type, the same md5 as the source.
- [ ] **The delivered file, in the program he runs it with (2026-11-03).** A macro workbook was
      "verified" by a harness that swapped its Excel-only calls for stand-ins and called inner
      functions instead of the buttons. The user opened the delivered file and every button raised
      a runtime error; that day's reflection had the patched lines in front of it and wrote
      nothing. A harness that edits the artifact under test proves another program: run the
      delivered file in the user's program (the download log's user agent says which), press the
      real entry points, stub only modal dialogs, and assert nothing else changed.
- [ ] A precondition in his report IS the test setup. If you cannot render it, the appearance is
      UNVERIFIED; never upgrade a string match into a claim about what he will see.
- [ ] **A write to shared data is not finished until you LOOKED at what reads it.** Count what the
      reading surface shows now (rows, chips, options, dots) against before. A count that moved by
      an order of magnitude is the finding, in either direction. Cheap count (an RPC, `grep -c`, a
      `querySelectorAll` in the live page): get it; otherwise say UNVERIFIED.
- [ ] **A threshold in someone else's units is a hostage to their rescaling.** An absolute cut on a
      vendor score, price, token count or benchmark index will one day mean something else without
      anyone editing it. Prefer an ordinal or relative cut; where an absolute one is unavoidable,
      the refresh pipeline owes it a population check that fails closed.

Each row was bought with a repeat failure: stale dist after a source edit, three times on
2026-07-30; a correct hex colour in the served DOM that rendered as nothing (2026-08-04); a control
behind an expander "verified" twice without expanding (2026-08-11, the owner's report named the expand
step as the setup); a "blink" shipped as a sound (2026-09-06). The shared-data rule (2026-09-05): Artificial
Analysis rebased its index, scores fell ~15–25 %, the cron wrote them correctly, and the literal gate
`53` cut SMART MODELS from 23 to 2. Every check was green; the owner found it in the model picker.

### Count the class: one instance is a sample, not an incident

When a defect is found in ONE instance of a class, ask how many others are like it, and count. A fix
to the one instance he noticed leaves the rest broken and fakes a repair. Trigger: any sentence of
the form "this one was in the wrong form / place / state".

- [ ] **1. Define the class** (all recipes, all routes that read a path, all outbound numbers, all
      memory files claimed but unverified).
- [ ] **2. Enumerate it** mechanically: `ls`, `grep`, an RPC listing, a query. Never from memory;
      memory produced the defect.
- [ ] **3. Report found / fixed / left.** "1 fixed" is a status; "18 found, 1 fixed, 17 left, here
      is why" is a finding.

(2026-08-22: one recipe in the wrong form; the census showed the matcher's catalog held 29 entries
while the library listed 73, because the scanner reads only `<dir>/<slug>/recipe.md` one level
deep. The owner had to ask for that count.)

### Memory, ripple, recipe, preempt

One word each when there is no signal. These sit under the core's action ladder: a recipe or code
change beats a note.

- [ ] **RECIPE: does a recipe govern this task class?** Check the real inventory, never memory.
      One fits: follow it. One nearly fits: use it AND improve it this turn. None fits a task that
      will recur: create it now in the canonical form the engine can match. A lesson about HOW to do
      a recurring task goes into the governing recipe as a step, a constraint or a Failures Overcome
      entry; a lesson parked as a "memory candidate" is the deferral this kills.
- [ ] **A named host is a catalog lookup (2026-09-03; SharePoint 2026-09-23).** A prompt naming a
      site, host, format or skill (YouTube, Gmail, Amazon, Copilot, SharePoint, a torrent, the
      programming wiki, a URL) makes the inventory check mandatory; a prompt that names the skill IS
      the scan, so run it. ("Did you forget we have a youtube skill?" 2026-04-23 and 2026-09-03;
      `sharepoint-download` shouted four times on 2026-09-23.)
- [ ] **MEMORY: does the next session need something no recipe or code can carry?** A preference,
      a decision, a correction, a hard-won gotcha: write it now and name the path. Never a one-off
      fact. A lesson he taught twice goes to high prominence in the memory index, and you say so.
- [ ] **RIPPLE: what did this make stale?** Code, docs, memory, and public surfaces you cannot edit
      from here (READMEs, sites, posts, store listings). Staleness you merely noticed counts the
      same as staleness you caused. Follow fixed cascades to their end. Under two minutes: fix it
      now; larger: a tracker entry; external: a bookmark naming the surface, what went stale and
      how to update it.
- [ ] **PREEMPT: done this twice?** Encode the trigger so it fires unasked: "When [trigger], do
      [action]" if reversible, "When [trigger], PROPOSE [action]" if not. The test: could a future
      session, reading only the stored rules, do it automatically? Never auto-encode anything that
      deletes, sends, publishes, restarts or spends.
- [ ] **A "gone" or "fixed" claim about what he SEES is checked where he sees it.** When the turn
      says a bubble, block or text is gone from his chat, read `chat.history` for that chat and count
      the user rows that still carry it, before writing "nothing to report". (2026-10-10: a turn said
      "the Fractal block is gone" at 18:28; history was already serving a 12 KB `<turn_context>` row
      as his prompt, and at 19:36 the large green blocks were still showing.)
