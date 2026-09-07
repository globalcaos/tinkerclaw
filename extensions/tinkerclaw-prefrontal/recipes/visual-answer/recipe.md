---
schema: "kit/1.0"
slug: "visual-answer"
title: "Visual Answer — show the pictures IN the chat"
summary: "When the honest answer is a set of images, render them inline in the chat bubble — each clickable to full size and linked to its source page — instead of building a file on disk and handing over a path."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "communication"
tags:
  [
    "visual",
    "images",
    "chat",
    "gallery",
    "render",
    "pictures",
    "show me pictures",
    "show me the pictures",
    "i need pictures",
    "show me examples",
    "what does it look like",
    "for inspiration",
    "find images of",
    "photos of",
    "reference images",
    "moodboard",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
---

# Visual Answer — show the pictures IN the chat

> When the honest answer is a set of images, render them inline in the chat bubble — each clickable to full size and linked to its source page — instead of building a file on disk and handing over a path.

## Goal

End the turn with the images visible in the chat bubble: thumbnails the requester can click to open at original size, each carrying a link to the page it came from. A file path is a receipt, not a delivery.

## When to Use

- The request contains a visual verb: show, look like, see, picture, photo, image, moodboard.
- The answer is fundamentally comparative-visual — products, styles, mechanisms, references, before/after.
- You caught yourself about to write 'I've built a gallery at <path>'.
- The requester is asking a second time — that is a signal about the SURFACE, not about the content.

## Steps

### 1. Pick the delivery surface first

**Done when:** The answer is written down as visual, and one surface is chosen.

The surface is the decision and it comes first; getting it wrong wastes the whole turn, because gathering and curating for the wrong surface produces work the requester never sees. Preference order: (a) inline chat grid in an html-render block — the default; (b) inline grid PLUS a local HTML gallery file when there are more than about 25 images or the set is a durable reference — the file is a supplement, never the delivery; (c) a local file alone, only when a file was explicitly requested. Skip this recipe entirely when a sentence answers the question: a single fact does not need a lightbox.

### 2. Gather and download every candidate image

**Tools:** websearch, webfetch, exec
**Done when:** Every candidate is on disk and confirmed to be a real image with known dimensions.

Search for the sources, fetch each page asking for absolute image URLs, and download into one local folder. Download even when you intend to hotlink: it is how you learn the image is real, and it is what makes the optional gallery file possible. Two traps. First, always follow redirects — a bare host that 301s to its www form will otherwise save a few hundred bytes of redirect HTML under an image filename. Second, never author a validity check from a guessed output format; observe one real sample first, because a fail-closed guard deletes good files while printing a confident failure. Verify by opening each file and reading its pixel dimensions, not by file size alone.

### 3. Choose each image's source: remote, served, or embedded

**Tools:** exec
**Done when:** Every image has a working source and, where possible, a full-size target.

This is the crux; get it wrong and the chat shows broken boxes. Remote https URLs are the default and cost no output tokens, but must be verified before use — require both a success status and an image content type, since a success status with an HTML body is a bot wall, not a picture. For images that exist only on disk, remember that file: URLs and relative paths never resolve from a chat document served over HTTP; the image must be reachable over HTTP, so check whether the environment exposes a media route and use it. Embedding as a base64 data URI is the last resort: it always renders, but costs roughly three and a half thousand output tokens per small thumbnail and cannot be clicked through, because browsers block top-level navigation to data URLs. Budget it for one or two decisive images, never a grid.

### 4. Build the grid — clickable, sourced, captioned

**Done when:** One html-render block exists with every image linked twice — to its own full size and to its source page.

Emit one html-render block containing a responsive grid of figures. Three non-negotiables per image. Wrap the thumbnail in a link to the full-size original opening in a new tab — prefer this over a scripted lightbox, because the chat frame is height-clamped and an in-frame overlay crops the very full-size view it promises, while a new tab shows real pixels. Put a link to the source page in the caption so the context is one click away; keep a map from image to page while gathering, because reconstructing it later is guesswork. Write captions that say what to LOOK AT rather than what the thing is. Include no script in the block: a script-free block renders inline and rebuilds synchronously with the chat, while a script-bearing block becomes a frame that reloads and flickers on every streaming delta.

### 5. Verify every link, then state what is not shown

**Tools:** exec, read
**Done when:** Every source and target checked, and any omission stated in the answer.

Re-check the final list of image sources and link targets; a broken image in a chat bubble is the exact failure this recipe exists to prevent, and it is invisible to the author. If a gallery file was also produced, render it headless and LOOK at the screenshot — reading the markup is not verification. Then say explicitly what was left out and why, for example that only a subset is shown in chat with the remainder in the file, or that a local-only image is not clickable. Silent truncation reads as complete coverage.

## Constraints

- The chat is the delivery surface; a file on disk is a supplement. If the requester must open something to see what they asked for, the answer was not delivered.
- Never place an unverified URL in the answer — require a success status AND an image content type.
- file: URLs and relative paths never resolve in chat. Serve over HTTP or embed as a data URI; there is no third option.
- Budget data URIs: roughly 3500 output tokens per thumbnail. Two decisive images, not twenty.
- Every image links twice — to its own full size and to its source page. An image without provenance is an assertion the requester cannot check.
- Captions point at what to notice; they do not merely label.
- Curate to roughly 12-20 images in chat; beyond that the grid stops being scannable.
- Keep case facts out of this recipe. Specific products, dimensions or vendors belong in the project knowledge the recipe reads at runtime.

## Safety Notes

- Downloaded third-party images are reference material for private use; check rights before republishing to any public surface.
- Never send a data URI containing private imagery to an external channel — the bytes travel with the message.

## Failures Overcome

- A requester asked for pictures four times; each turn produced a better gallery file on disk and an answer containing only its path. Nothing was broken — inline image rendering had worked the whole time. The defect was treating the artifact as the deliverable and the surface as an afterthought.
- Downloads without redirect-following saved redirect HTML under image filenames; the error surfaced only on a file-size glance.
- A validity check written from a guessed format string deleted valid downloads and reported failure on good data.
