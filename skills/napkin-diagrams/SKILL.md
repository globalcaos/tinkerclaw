---
name: napkin-diagrams
description: Generate beautiful conceptual diagrams from text via Napkin.ai API. Paste paper sections or descriptive text, get publication-quality PNGs. Best for architecture, flow, and concept diagrams in research papers.
metadata:
  openclaw:
    emoji: "🎨"
    requires:
      files: ["~/.openclaw/credentials/napkin.env"]
---

# Napkin Diagrams

<scope>
Generate publication-quality conceptual diagrams from text using the Napkin.ai API. Best for architecture, flow, and concept diagrams in research papers.
</scope>

## Setup

1. Create account at https://app.napkin.ai
2. Account Settings → Developers → Create API token
3. Store: `echo "NAPKIN_API_TOKEN=sk-your-token" > ~/.openclaw/credentials/napkin.env && chmod 600 ~/.openclaw/credentials/napkin.env`

<key_principle>
More context produces better diagrams. Paste the full paper section instead of summarising — Napkin's layout engine handles spatial reasoning, so your job is giving it rich semantic content. A summarised version forces the engine to invent relationships.
</key_principle>

## Usage

### Generate diagrams

```bash
bash {baseDir}/scripts/napkin-generate.sh "Your text content here" output.png [options]
```

Options:

- `--variations N` — Generate N variations (1-4, default 4)
- `--style STYLE` — Style name (default: formal-balanced)
- `--format FORMAT` — png (default), svg (requires paid plan)
- `--transparent` — Transparent background

### From a file

```bash
bash {baseDir}/scripts/napkin-generate.sh --file section.md output.png --variations 4
```

<best_practices>

1. Feed full sections — a full architecture section (200+ words) produces dramatically better diagrams than a single paragraph.
2. Include relationships — phrases like "X feeds into Y, which triggers Z" help the layout engine place arrows.
3. Name the components — use bold or caps for key elements so the engine knows what to label.
4. Request 4 variations and use the `image` tool to evaluate and pick the best — Napkin's layout is non-deterministic.
5. Credits cost ~1 per word. Free tier = 500/week. Budget accordingly.
   </best_practices>

## Available Styles

Built-in styles (use name as `--style` value):

- `formal-balanced` — Clean, professional (default for papers)
- `formal-minimal` — Less visual clutter
- `colorful-bold` — Vibrant, high contrast
- `casual-friendly` — Approachable, less formal
- `hand-drawn` — Sketch-like aesthetic
- `monochrome` — Black/white/gray only

## Watermark

Free tier adds "Made with Napkin" watermark. Remove by:

- Upgrading to paid plan, OR
- Cropping in post-processing (for personal/research use)

## Credits

- Free: 500 credits/week (~500 words of content)
- Plus ($12/mo): 10,000 credits/month
- Pro ($24/mo): 30,000 credits/month

<when_to_use_something_else>
Napkin excels at conceptual/process diagrams (architecture, pipelines, cascades, hierarchies). It can't generate:

- Literal illustrations (nature, objects, scenes)
- Visual metaphors requiring realistic imagery
- Anything where the _picture itself_ is the message, not the structure

For those, use image generation (Gemini image, GPT image) instead. Quick rule:

- "Show how components connect" → Napkin
- "Show what it looks like" → image generation
  </when_to_use_something_else>
