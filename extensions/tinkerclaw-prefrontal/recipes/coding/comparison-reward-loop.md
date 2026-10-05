---
schema: "kit/1.0"
slug: "comparison-reward-loop"
title: "Comparison-reward loop — change, compare, repeat until the gap is gone"
summary: "A loop is not a score you report. Render the thing, compare it to the ground truth, name the single biggest difference, change the producer of that difference, and do it again. Stop only when the comparison says the outcome is acceptable."
version: "1.1.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "method"
tags: ["loop", "comparison", "reward", "iteration", "ground-truth"]
testedHarnesses: ["OpenClaw"]
authoredBy: "jarvis-on-the-fly"
params: []
---

# Comparison-reward loop

**What this is for.** Any task where "looks right" or "matches the original" is the goal, and the first output does not. The architect, 2026-09-22, after a rebuilt deck was scored and then left: a loop means you compare, fix, and compare again until the two versions are acceptable.

**Ground truth.** Name it before the first change. A file, a screenshot, a render. If you cannot put the new result next to it, you are not in the loop.

## The cycle

1. **Produce** the artifact from the skill or script, not by hand.
2. **Compare** it to the ground truth. Look at both. Write one sentence: the single biggest difference (missing element, doubled text, wrong color, wrong place).
3. **Reward.** Acceptable means the sentence is "same elements, same text, same colors, positions close enough." Anything else is not a stop.
4. **Fix the producer.** Edit the script that generated the difference. Do not patch the output file.
5. **Repeat inside the same run.** The check is code, not a person. Build, measure, change the producer, build again, and stop only when the check passes or the same failure comes back unchanged. Waiting for someone to look between passes is not a loop. The architect, 2026-09-22: one shot and a wait is slow, and it is not iterating.

## Stop rules

- Stop when the comparison sentence meets the reward, or when the next difference is not in the data you have (say that, and what data is missing).
- Do not stop because a pixel score is high. White space inflates it.
- Do not deliver a copy of the previous file and call it a new pass.
- One pass fixes one difference. If the look still names a difference, that pass did not finish.

## Failures this recipe exists to stop

1. **Stopping on a score.** 94/100 with doubled text is a fail. The sentence from the look is the reward, not the number.
2. **Patching the output.** Recolor a pixel in the pptx and the next rebuild brings the bug back. Edit the script that produced it.
3. **Trusting a stale "impossible".** The Office skill said colors were not in the channel. They were, in `spr` runs on the shape with one paragraph per line. When a look contradicts the skill, update the skill in the same turn.
4. **Fixing one slide by eye and shipping the deck.** Re-render at least the slide you changed and look at that picture before you say what changed.
5. **Tuning what the owner cannot see.** On 2026-09-22 several passes changed point size while the bar stayed square. The gap a person sees in two seconds was the shape: `pthLst` arcs mean a rounded rectangle, and the quote is not a bullet.

## Where this came from

Rebuilding a PowerPoint deck against its own slide renders, 2026-09-22. The doubled text was a picture crop of the original words plus a second text box. The fix belonged in the builder (skip crops that cover a text box), then a new render, then another look.
