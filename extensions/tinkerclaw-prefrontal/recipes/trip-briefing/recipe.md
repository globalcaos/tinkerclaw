---
schema: "kit/1.0"
slug: "trip-briefing"
title: "Trip Briefing → WhatsApp (TripIt-style, maps + completeness gate)"
summary: "Gather a trip from your work Outlook (flight/hotel/car), assemble a TripIt-style briefing with clickable Google Maps navigation links (hotel → venue → return airport), and send it to your WhatsApp — but ONLY if the trip is complete. If any pillar is missing/unconfirmed, it enquires what to do instead of spamming a half-finished plan."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "communication"
tags:
  [
    "trip",
    "itinerary",
    "tripit",
    "gather my trip",
    "send my trip",
    "send my trip to whatsapp",
    "trip to whatsapp",
    "business trip",
    "my travel",
    "flight and hotel",
    "flight hotel car",
    "going to",
    "trip briefing",
    "briefing",
    "belgium trip",
    "viaje",
    "mi viaje",
    "itinerario",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
---

## Goal

Reproduce, as a repeatable playbook, the one-off Belgium-trip gather from
2026-07-07: pull the flight / hotel / car documents out of the architect's **work
Outlook**, assemble a TripIt-style briefing, and deliver it to his **WhatsApp**
(text now; the full itinerary+tickets **PDF** as an attachment when the channel
allows, else a documented fallback). Two enhancements over the original run:

1. **Clickable Google Maps links** on every address the architect has to _navigate to_,
   in travel order — arrival airport → **hotel** → **venue** → back to the
   **departure airport**.
2. **Completeness gate** — if any trip pillar is still TBD / unconfirmed /
   missing, DO NOT send a half-finished briefing. Send ONE short enquiry asking
   what to do, and stop. (the architect, 2026-07-08: _"account for a trip where not all
   the details are finalized… enquire what to do instead of spamming me with a
   half-finished business plan."_)

## When to Use

- the architect says he's travelling and wants his trip gathered / sent to WhatsApp.
- A trip's docs live in his work inbox and he wants them consolidated TripIt-style.
- Re-running for a new trip: same steps, new search terms (dates, city, airline).

## Trip model — the five pillars

A briefing is **COMPLETE** only when each _applicable_ pillar is present AND
confirmed (has a booking/confirmation ref and concrete times/addresses):

| Pillar           | Required fields                                                   | Confirmed when                                          |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| Outbound flight  | airline+number, date, dep/arr airport+time, seat/bag, booking ref | ref present, status Confirmed, e-ticket or booking code |
| Return flight    | same                                                              | same                                                    |
| Hotel            | name, full address, check-in/out dates, confirmation #            | conf # present                                          |
| Car (if renting) | vendor, pickup/dropoff location+time, confirmation #              | conf # present                                          |
| Venue / purpose  | full address, dates, hours                                        | address resolvable                                      |

Pillars can be legitimately **N/A** (e.g. no car — he's using trains). N/A ≠
missing. A pillar that the architect _expects_ but whose doc is absent/`TBD`/unpriced =
**missing** → triggers the gate (Step 4).

## Steps

### 1. Scope the trip

**Done when:** I know which trip (destination + dates) and can name the pillars I expect.

From the architect's ask, fix the destination, the travel window, and whether a car is
expected. If two trips are in flight (the Belgium run had a Belgium leg AND an
Amsterdam leg the next week), confirm which one he means, or brief the imminent
one and append the next as a compact continuation.

### 2. Refresh access + gather from Outlook

**Done when:** The relevant flight/hotel/car documents are downloaded locally.

Uses the `outlook-hack` skill. The Outlook SPA token dies after ~24h, so expect
to re-mint it from the shared **Teams** tab via the browser relay:

- Preflight relay: `GET http://127.0.0.1:<relayPort>/extension/status` → `connected:true`;
  `GET /json` → find the `teams.cloud.microsoft` target id. `<relayPort>` = port of
  `browser.profiles.chrome-relay.cdpUrl` in `~/.openclaw/openclaw.json` (typ. 18792).
- Extract the MSAL refresh token: attach to the Teams target over CDP
  (`ws://127.0.0.1:<relayPort>/cdp`, `Target.attachToTarget {flatten:true}` →
  `Runtime.evaluate` the localStorage `refreshtoken` snippet from the skill).
  Capture `secret`+`tenantId` to a temp file, never echo the secret.
- Store it: `teams token store --refresh-token "<secret>" --tenant-id "<tenant>"`.
- Sync + search:
  ```bash
  SK=~/.openclaw/jarvis-workspace/.claude/skills/outlook-hack/scripts
  python3 $SK/outlook-sync.py                       # incremental
  python3 $SK/outlook-sync.py --query "<city|airline|Andromeda|reserva>"
  ```
  Corporate travel is often an agency (Serra uses **Viajes Andromeda**); the
  booking email may be a colleague forwarding attachments (Mireia Peña). Query DB
  directly for attachment-bearing mail:
  ```python
  # emails JOIN attachments WHERE name LIKE '%vuelo%|%hotel%|%coche%|%ticket%'
  ```
- Download: `node $SK/../outlook-mail-fetch.mjs --get-attachments <id> --out <dir>`.
  Read PDFs with `pdftotext -layout`; flight tickets sent as PNG → read as image.

Only gather **the architect's own** documents. Colleagues' tickets in the same email
(e.g. "…D. Ortiz.pdf") are their PII — exclude them from the briefing (a shared
car/hotel booked under a colleague's name is fine to _reference_, not to attach).

### 3. Extract & normalize into the trip model

**Done when:** Every pillar is filled with concrete values or marked N/A / missing.

Pull for each pillar: numbers, times (with dates), airports+terminals,
confirmation refs, e-ticket numbers, seat, baggage allowance, full street
address. Flag anything that reads `TBD`, blank, "pending", unpriced, or a
booking status ≠ Confirmed.

### 4. ⛔ Completeness gate — decide, then either enquire OR proceed

**Done when:** Either an enquiry has been sent (and I STOP), or all pillars are COMPLETE and I continue.

Evaluate the model from Step 3:

- **COMPLETE** (every applicable pillar confirmed) → go to Step 5.
- **INCOMPLETE** (≥1 expected pillar missing/unconfirmed) → **do NOT build or
  send the briefing.** Send ONE short WhatsApp message that:
  1. states the trip is only partially booked,
  2. lists exactly which pillar(s) are missing/unconfirmed (name them),
  3. asks how he wants to proceed — offering concrete options, e.g.
     _"send what's confirmed now and follow up on the rest, wait until it's all
     booked, or do you want me to chase/​book the missing piece?"_
     Then **STOP** and wait for his answer. Do not spam a half-finished plan.

  Enquiry example (adapt):

  ```
  ✈️ Your <city> trip is only half-booked so far. Confirmed: outbound flight + hotel.
  Still missing: 🚗 car rental and the return flight. Want me to (a) send the confirmed
  bits now and update you when the rest lands, (b) hold the whole briefing until it's
  fully booked, or (c) go ahead and sort the missing pieces? 🤖
  ```

This gate is the heart of the recipe — the default on incomplete data is
**ask, not assemble**.

### 5. Build the briefing (text + Maps links + PDF)

**Done when:** A WhatsApp-ready text and a merged PDF exist, with maps links in travel order.

**Text** — TripIt-style, WhatsApp markdown (`*bold*`), one block per pillar in
chronological order. Lead with the most urgent fact (imminent departure). Include
confirmation/e-ticket numbers and any gotcha (e.g. 0 checked bags on return).

**Google Maps links** — on the addresses the architect _navigates to_, in this order:
**hotel → venue → return airport** (the arrival airport needs no link — he lands
there). Use a **directions** deep link so tapping starts navigation from his
current location:

```
https://www.google.com/maps/dir/?api=1&destination=<URL-ENCODED full address>
```

(URL-encode the full street address; spaces→`%20`, commas→`%2C`.) Bare URLs are
correct for WhatsApp — the client auto-links them; do NOT use markdown link
syntax there. Put the link on its own line right under each place so it's an easy
tap.

**PDF** — one-page TripIt-style summary (chrome headless from an HTML template)
merged with the architect's actual tickets:

```bash
google-chrome --headless --disable-gpu --no-pdf-header-footer --print-to-pdf=00-itinerary.pdf itinerary.html
img2pdf --pagesize A4 "<outbound PNG ticket>" -o 01-outbound.pdf   # if a ticket is a PNG
pdfunite 00-itinerary.pdf 01-outbound.pdf "<return ticket>.pdf" "<Name>-<Trip>.pdf"
```

Visually verify page 1 (`pdftoppm -png -r 90 -f 1 -l 1 00-itinerary.pdf _p` → Read it).

### 6. Deliver to WhatsApp (honest fallback if media is down)

**Done when:** Text is delivered with a real messageId, and the PDF reached his phone (or a documented fallback did).

the architect's own number / Note-to-Self = **+34600000000**.

```bash
# 1) text itinerary (WORKS — returns a real messageId)
openclaw message send --channel whatsapp --target +34600000000 --message "<briefing>" --json
```

⚠️ **WhatsApp media send is currently BROKEN gateway-side** — `--media` fails at
whatsmeow (`unknown field "image"/"document"/"caption"`) for every media type.
See `memory/reference_whatsapp_media_send_broken_gateway.md`. Try `--media` once;
if it errors, fall back WITHOUT rabbit-holing:

```bash
# fallback: park the PDF in the architect's own Gmail (private, opens on his phone)
gog gmail drafts create --to "$ARCHITECT_EMAIL" \
  --subject "<flag> <Trip> — itinerary + flight tickets" \
  --body "<one-line summary>" --attach "<Name>-<Trip>.pdf" --json
```

Then send a short WA text telling him the PDF is in his Gmail Drafts and why.
Do NOT host private travel docs (e-ticket numbers, names) on any public URL
(Rule 2). `gog` is send-guarded (drafts only) and himalaya isn't installed — the
Gmail draft is the sanctioned path.

Notes: `--dry-run` prints "✅ Sent via gateway" but sends NOTHING — trust only a
JSON `messageId`. `openclaw message read` is unsupported for whatsapp, so delivery
can't be verified by reading history.

### 7. Confirm honestly

**Done when:** the architect knows exactly what landed where.

Report which messages hit WhatsApp (with the fact that the PDF went to Gmail if
media was down). If the completeness gate fired at Step 4, the "delivery" is the
enquiry — say so, and that the briefing is held pending his answer.

## Constraints

- **Ask-don't-assemble on incomplete data** (Step 4) is the defining rule — never
  send a partial briefing without the architect's go-ahead.
- the architect's PII only; exclude colleagues' tickets from attachments (Rule 2).
- No irreversible outbound beyond the WhatsApp-to-self / Gmail-draft-to-self path
  without explicit ok (Rules 3/4). The message is to the architect himself, so this is in
  bounds.
- Maps links: directions deep links, bare URLs, only on places he drives to.

## Failures Overcome

- **Stale Outlook token** (SPA, 24h) → re-mint from the Teams tab via the browser
  relay before any sync.
- **WhatsApp media proto bug** → Gmail-draft fallback + WA note, not a public link.
- **`--dry-run` false "Sent"** → verify by messageId only.
- **Half-finished briefings** → the completeness gate; enquire, don't spam.
