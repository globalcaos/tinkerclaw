---
name: d2-diagrams
description: Generate conceptual diagrams with D2 language. Architecture, flow, sequence, and integration diagrams for papers and documentation. Outputs SVG and PDF.
metadata: { "openclaw": { "emoji": "📐", "requires": { "anyBins": ["d2"] } } }
---

# D2 Diagram Generation

<role>
You generate publication-quality conceptual diagrams (architecture, flow, sequence, integration) from text descriptions using the D2 language. Output: SVG and PDF.
</role>

## Prerequisites

```bash
# Install D2
curl -fsSL https://d2lang.com/install.sh | sh

# For SVG→PDF conversion
sudo apt install librsvg2-bin
```

## Usage

### Generate a diagram

```bash
# SVG output (default)
d2 --layout elk diagram.d2 diagram.svg

# PNG output
d2 --layout elk diagram.d2 diagram.png

# With specific dimensions
d2 --layout elk --pad 20 diagram.d2 diagram.svg
```

### Convert for LaTeX

```bash
# SVG → PDF (crisp vector graphics)
rsvg-convert -f pdf diagram.svg > diagram.pdf
```

### Layout engines

| Engine            | Best for                   | Flag             |
| ----------------- | -------------------------- | ---------------- |
| `dagre` (default) | General flowcharts         | `--layout dagre` |
| `elk`             | Hierarchical architectures | `--layout elk`   |

## J-Series Paper Color Scheme

Use these consistently across all papers:

| Role                   | Color                       | Hex       |
| ---------------------- | --------------------------- | --------- |
| Storage/Memory         | Blue                        | `#4A90D9` |
| Processing             | Green                       | `#50C878` |
| Input/User             | Orange                      | `#F5A623` |
| Output/Response        | Purple                      | `#9B59B6` |
| Security               | Red                         | `#E74C3C` |
| External               | Gray                        | `#95A5A6` |
| **Novel (this paper)** | Bright green + thick border | `#2ECC71` |

## Example: Architecture Diagram

```d2
direction: down

user: "User Message" {
  style: {fill: "#F5A623"; font-color: white; border-radius: 8}
}

encoder: "Sentence Encoder\n(MiniLM, 384d)" {
  style: {fill: "#50C878"; font-color: white; border-radius: 8}
}

gru: "GRU Temporal\nProcessor" {
  style: {fill: "#2ECC71"; font-color: white; border-radius: 8; stroke-width: 3}
}

output: "Multi-Head Output" {
  action: "Action Gate" {style: {fill: "#E74C3C"; font-color: white; border-radius: 8}}
  retrieval: "Retrieval Bias" {style: {fill: "#4A90D9"; font-color: white; border-radius: 8}}
  affect: "Tone Modulation" {style: {fill: "#9B59B6"; font-color: white; border-radius: 8}}
}

user -> encoder: situation description
encoder -> gru: embedding sequence
gru -> output: hidden state
```

## Example: Pipeline/Flow

```d2
direction: right

template: "Template\nSlot Fill" {style: {fill: "#F5A623"; font-color: white; border-radius: 8}}
embed: "Embed\n(MiniLM)" {style: {fill: "#50C878"; font-color: white; border-radius: 8}}
temporal: "Temporal\nContext" {style: {fill: "#50C878"; font-color: white; border-radius: 8}}
score: "Confidence\nScore" {style: {fill: "#2ECC71"; font-color: white; border-radius: 8; stroke-width: 3}}
gate: "Proceed\nor Block" {style: {fill: "#E74C3C"; font-color: white; border-radius: 8}}

template -> embed: "serialize"
embed -> temporal: "384d vectors"
temporal -> score: "hidden state"
score -> gate: "σ(score)"
```

## When to use D2 vs Mermaid

| Use D2 for               | Use Mermaid for       |
| ------------------------ | --------------------- |
| Architecture diagrams    | Sequence diagrams     |
| System overview          | Interaction timelines |
| Component relationships  | State machines        |
| Data flow with nesting   | Git-style graphs      |
| Anything with containers | Simple flowcharts     |

## Tips

- Use `direction: down` for architectures, `direction: right` for pipelines
- Use containers (nested objects) for grouping related components
- Keep labels short (2-3 words). Details go in captions.
- Use `--layout elk` for papers (cleaner hierarchical layout)
- Always include a `style` block — D2's defaults are good but paper diagrams need the color scheme
