---
schema: "kit/1.0"
slug: "visual-manual-from-tests"
title: "Visual manual from tests — a user manual whose pictures the test suite takes"
summary: "Build a customer user manual whose every picture is taken by a walkthrough test on the running product, so the manual is rebuilt from the code instead of drifting from it. Covers the screens a manual needs, a capture helper that refuses bad pictures, data that looks like a real site, pictures that are the same on every machine, language pairs, picture judges and editions."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "documentation"
tags:
  [
    "user manual",
    "visual manual",
    "manual pictures",
    "screenshots for the manual",
    "walkthrough tests",
    "playwright screenshots",
    "documentation from tests",
  ]
antiTriggers: ["api reference", "code comments", "one screenshot", "paper figures"]
testedHarnesses: ["Claude Code"]
authoredBy: "jarvis-on-the-fly"
params:
  screens_dir:
    {
      type: "string",
      description: "Where the pictures live, outside every folder a tool empties (never Playwright's outputDir, never /tmp).",
    }
---

# Visual manual from tests

> A picture in the manual is a test result. If the test cannot take a good picture, the screen or the test is
> wrong, and the manual waits.

## Goal

A user manual a customer can follow step by step, with a picture for every step, rebuilt from the product at
every turn. Derived from the AcmeVision 2.0 build (2026-10-01/02), where the user manual reached 70 pages in
English and Spanish from 130 pictures taken on the real stack.

## When to Use

- A product with a UI that changes while it is built, and a manual that must match it at the end.
- A build that already has browser tests (Playwright or similar) against a mock and a real stack.

## When NOT to use

- One screenshot for a chat or a ticket: take it by hand.
- Figures for a paper: they are drawn, not captured.

## Steps

### 1. Every action the manual teaches has a screen

**Done when:** every write operation of the API is either called by a screen or named as maintainer-only.

List the API's write routes and search the UI source for each. On AcmeVision 2.0, 7 of 42 had no screen
(users, roles, own password, motion settings, process restart), so the manual could only show API calls between
pictures. From then on a unit that adds a write route adds its screen in the same unit, or says why the route is
for maintainers only.

### 2. Walkthrough tests take the pictures

**Done when:** each chapter is one walkthrough test whose steps save one picture each, in every language.

The capture helper is shared and strict:

- It waits for the screen's own content and fails on a spinner, "Loading…" or "Connecting…" (two pictures of an
  empty frame passed every spec on 2026-10-01).
- It waits for `document.fonts.ready`.
- A picture is the viewport of a fixed window (1280 x 800) scrolled to the step's control, never a slice of a long
  page. A sticky bar never covers the subject; when a group is taller than the clear window, it scrolls to the
  target, not to the group's top.
- It refuses a picture where a row of fields wraps or a control sits under a bar, rather than saving a bad one.

### 3. The data looks like a site

**Done when:** no picture shows a test id, a key, JSON or a raw boolean.

What the walkthroughs type (rule, zone, camera, user and model names, addresses) comes from one shared list of
site-like names in the manual's language. Do not polish what the fakes report (serial numbers, stream paths,
firmware, the test machine's disk): the final edition, taken on real hardware, supplies those. The screens follow
the same line: names, never ids; dates in the reader's format; a value that is zero by construction ("0 ms", "0 cm"
from an exact fit) is never shown as a measurement; coefficients go under a Details fold. Help text names
buttons by the label they carry. A guide never tells the reader to save a red result.

### 4. Pictures are the same on every machine

**Done when:** the same step taken on two machines matches, apart from live video.

Ship the UI's fonts with the UI (an open licence, self-hosted, no network at run time). On 2026-10-02 the CSS
named Inter first and no machine had it: the laptop drew Segoe UI from three stray files, the second machine drew
DejaVu, three capture checks refused their pictures there and one picture scored SSIM 0.70 between machines. The
same wider font showed a product fault: labels placed as if each glyph were 0.6 em wide crossed zone borders.
Give the stack a disk share of its own, so storage screens do not follow whatever else writes to the disk.

### 5. Language pairs show the same state

**Done when:** a pair check over every EN/ES picture reports no pair in a different state.

Each step is taken in every language from the same seed, and a tool compares what each pair shows (AcmeVision:
`tools.pair_states`, 58 pairs).

### 6. Judge every re-taken picture

**Done when:** every new or changed picture has a judge's verdict, and the master has opened the riskiest ones.

Judges run in parallel, a few pictures each, and read each picture against its step's caption: is the subject in
view, whole, readable, in the state the text says? The master opens the pictures behind every UI claim himself.
Low picture items ride along in the next turn that exists anyway, never a turn of their own.

### 7. Build the manual and read it as a customer

**Done when:** the manual is rebuilt from the latest pictures and someone has read the new chapters as a customer.

An edition is accepted when the real-stack suite is green on one tip, every real picture has been judged, and the
new chapters have been read through as a customer would. A first edition can come from fakes on a laptop; the
final edition is taken on the real hardware, because only it supplies real devices, speeds and disks.

## Constraints

- Pictures live outside every folder a tool empties: Playwright's `outputDir` at every run, `/tmp` at a reboot.
  Mock and real pictures go to separate folders, and each is emptied at the start of the run that refills it, so
  no stale picture survives and one run never deletes the other's.
- A capture check is never loosened to make a picture pass; the screen or the scroll is fixed.

## Failures Overcome

- 2026-10-01 11:05: `admin-logic.png` and `admin-floor.png` showed "Loading…" and "Connecting…" while every spec
  around them was green. Hence the capture helper's content wait.
- 2026-10-01 13:44: a real-stack run deleted the mock run's 27 pictures (one shared `outputDir`). Hence separate
  folders outside it.
- 2026-10-02 00:26: the users and motion chapters could only show API calls. Hence Step 1.
- 2026-10-02 14:43: pictures differed between two test machines because neither had the font the CSS asked for.
  Hence Step 4.
