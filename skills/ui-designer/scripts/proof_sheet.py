#!/usr/bin/env python3
"""Proof sheet for logos and other vector artwork: one PNG to LOOK at before claiming anything.

For each SVG it renders:
  - the artwork in colour on every background (--bg), at every width (--widths)
  - a one-colour test: everything black on white, everything white on black
  - a blur test (Gaussian, --blur px) at the middle width: letters that merge here
    have uneven spacing or counters that close up at a distance

Usage:
  proof_sheet.py logo.svg [more.svg ...] -o proof.png [--bg "#FFFFFF,#000000,#1B2A4A"]
                 [--widths 96,160,320,720] [--blur 3]

Needs cairosvg and Pillow.
"""
import argparse, io, re, sys

import cairosvg
from PIL import Image, ImageDraw, ImageFilter

PAD, GAP, LABEL_W = 24, 18, 230


def render(svg_text, width):
    png = cairosvg.svg2png(bytestring=svg_text.encode(), output_width=width)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def one_colour(svg_text, colour):
    """Force every fill and stroke to one colour (keeps 'none')."""
    s = re.sub(r'fill="(?!none)[^"]*"', f'fill="{colour}"', svg_text)
    s = re.sub(r'stroke="(?!none)[^"]*"', f'stroke="{colour}"', s)
    s = re.sub(r'fill:\s*(?!none)[^;"]+', f'fill:{colour}', s)
    return s.replace("<svg ", f'<svg fill="{colour}" ', 1)


def on_bg(img, bg):
    base = Image.new("RGBA", img.size, bg)
    base.alpha_composite(img)
    return base


def row(cells, bg, label, fg):
    h = max(c.height for c in cells) + 2 * PAD
    w = LABEL_W + sum(c.width for c in cells) + GAP * (len(cells) - 1) + 2 * PAD
    out = Image.new("RGBA", (w, h), bg)
    x = LABEL_W + PAD
    for c in cells:
        out.alpha_composite(c, (x, (h - c.height) // 2))
        x += c.width + GAP
    ImageDraw.Draw(out).text((PAD, h // 2 - 6), label, fill=fg)
    return out


def luminance(hex_colour):
    h = hex_colour.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("svgs", nargs="+")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--bg", default="#FFFFFF,#000000")
    ap.add_argument("--widths", default="96,160,320,720")
    ap.add_argument("--blur", type=float, default=3.0)
    a = ap.parse_args()
    bgs = [b.strip() for b in a.bg.split(",") if b.strip()]
    widths = [int(w) for w in a.widths.split(",")]
    rows = []
    for path in a.svgs:
        svg = open(path).read()
        name = path.rsplit("/", 1)[-1]
        for bg in bgs:
            fg = "#000000" if luminance(bg) > 0.5 else "#FFFFFF"
            rows.append(row([on_bg(render(svg, w), bg) for w in widths], bg, f"{name}\non {bg}", fg))
        black = [on_bg(render(one_colour(svg, "#000000"), w), "#FFFFFF") for w in widths]
        white = [on_bg(render(one_colour(svg, "#FFFFFF"), w), "#000000") for w in widths]
        rows.append(row(black, "#FFFFFF", f"{name}\none colour", "#000000"))
        rows.append(row(white, "#000000", f"{name}\none colour, inverse", "#FFFFFF"))
        mid = widths[len(widths) // 2]
        blurred = on_bg(render(svg, mid), bgs[0]).filter(ImageFilter.GaussianBlur(a.blur))
        fg0 = "#000000" if luminance(bgs[0]) > 0.5 else "#FFFFFF"
        rows.append(row([blurred], bgs[0], f"{name}\nblur {a.blur:g}px @ {mid}", fg0))
    W = max(r.width for r in rows)
    sheet = Image.new("RGBA", (W, sum(r.height for r in rows)), "#DDDDDD")
    y = 0
    for r in rows:
        sheet.alpha_composite(r, (0, y))
        y += r.height
    sheet.convert("RGB").save(a.out)
    print(f"{a.out} {sheet.width}x{sheet.height} ({len(rows)} rows)")


if __name__ == "__main__":
    sys.exit(main())
