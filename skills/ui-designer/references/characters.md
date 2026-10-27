# Characters and mascots

**What this is for.** Drawing a brand character as code (SVG) that is cute, stays on palette and
survives the same proofs as a logo. **How it was made.** From the OrbisVision mascot round on
2026-10-02: a baby robot with a camera for a head, four head constructions, five accent palettes,
lockups with the wordmark. Generator: a private Python generator (one body, four heads, palettes as dicts).
**What changes it.** The owner rejecting a character, or a proof that missed something he saw.

## Cute is a set of proportions

- Head at least 1.2× the body's height (the OrbisVision robot is about 1.3×). Short, thick limbs.
- Eyes in the lower half of the head, pupils at least half the iris, two catchlights: a big one
  top-left (about 20% of the eye radius) and a small one bottom-right (about 8%).
- Round shapes everywhere; small cheeks or a tiny smile in the accent colour.
- A head tilt of 5 to 7 degrees reads as curious. Waving arms read as friendly.

## Cartoon, not realistic and not manga

- One ink outline of constant width (about 1.2% of the character's height), round joins.
- One cel shade per shape and nothing else: fill the shape with its shade colour, then draw the
  base colour shifted up-left and clipped to the shape. No gradients, no texture.
- Directions must differ in construction (the head idea), not in colour. Share the body.

## Palettes

- Colours are roles in one dict (ink, blue, shade, glass, accent, white), so a palette swaps
  without redrawing. Show palettes as rows of the same characters, not as swatches alone.
- Give the accent enough area to judge. The first OrbisVision sheet put the accent only on LEDs
  and cheeks, and all five palettes looked the same; accent shoes fixed it.

## Proofs

- 120, 64 and 40 px, plus a one-ink version: white lines cut the shape apart and the iris turns
  white, or the eyes vanish into the silhouette.
- A black outline disappears on black. For dark backgrounds draw a white sticker edge under the
  character: the same drawing, all white, outlines widened.
- Lockup with the wordmark: side by side the character is about 3× the wordmark's height,
  stacked about 4.6×. The character is the vertical element against a horizontal logo.

## Prints: orientation, full body, prop size

- **A print size given as two numbers does not say which side is the width.** "20x13 cm" for a
  sticker on a machine front was rendered landscape; it was 13 wide by 20 tall. For a standing
  figure assume portrait and say so in the first line, or render both orientations when the
  source cannot settle it. Show every option inside a frame of the true print ratio.
- **Full body is the default for a character print.** A crop ("waist up", "knees up") written next
  to the usual "whole figure in frame, nothing cropped" gives a contradictory brief and cut legs.
  Crop only when the owner asks for one.
- **"Big" does not make a prop big.** Give an image model a size anchor against the body ("as long
  as the hand, a third of the chest width"). A prop pressed against the head may still not grow.

Failures overcome:

- 2026-10-09, ORBIS cabinet-front robot: six referee options at 1536x1024 with three cropped
  bodies. The owner: "I want a full body image. The image needs to be vertical, not horizontal."
  The next round asked for a "BIG, oversized" whistle and got a normal one; the size anchor grew it
  1.2 to 3.2 times on four of five poses.
