---
name: game-animation-frames
description: >
  Deep guide for game ANIMATION assets: motion cycles, action keyframes,
  effect sequences, and animation sprite sheets — built around a
  video-first pipeline (animate the base with image_to_video, then harvest
  the frames). Use whenever generating anything that moves: walk/run
  cycles, attacks, idles, FX, flags, fire, animation sheets. Complements
  game-asset-core.
metadata:
  short-description: "Video-first animation frames that actually cycle"
user-invocable: false
---

# Animation Frames — video-first

The image generator draws poses; the VIDEO generator understands motion —
leg alternation, arc continuity, cloth and fire dynamics come free because
video must animate them. So don't ask the image model to imagine
mid-motion poses: animate the base and harvest real frames.

## Default pipeline

1. **Base frame.** Generate the subject in its neutral/starting pose with
   full style words, flat keyable background, side/game-appropriate view
   (game-asset-core defaults apply).
2. **Animate.** `image_to_video` from the base: one clear motion, in place,
   static camera ("the knight walks in place, side view, camera locked",
   6s). Keep the shot simple — one subject, one motion.
3. **Harvest.** Extract densely: `ffmpeg -i clip.mp4 -vf fps=12 f%03d.png`
   (~72 frames from 6s). View them as a set (contact sheet or batches).
4. **Select.** Pick the frames that (a) capture the motion's distinct
   phases and (b) LOOP — the sequence's end must flow back into its start.
   Don't force a count: if the motion reads best with 8, 10, or 12 frames,
   deliver that many (more frames = smoother in-engine; they're already
   generated). For a cycle, select one full period, using motion landmarks
   (foot contacts, wing extremes, flame peaks) to find period boundaries.
5. **Clean.** Video frames may drift from the base's palette/crispness or
   background. If needed, run selected frames through `image_edit` to
   restore the flat background/style ("same pose exactly, restore the flat
   #hex background and cel-shaded style"), or key/clean with PIL. Verify
   cleaned frames didn't change pose.
6. **Package.** Deliver frames in play order (zero-padded names) and/or
   composite a sheet per game-asset-core sheet rules (uniform cells, no
   dividers). State the intended fps.

Fall back to keyframe-by-keyframe `image_edit` generation only when video
fails the motion (rare: very stylized poses, single dramatic keyframes) —
and then plan phases yourself and obey the laws below.

## Motion laws (verify against these, whatever the pipeline)

- Cycles loop; alternating gaits spend half the period mirrored.
- Continuity: limbs, props, anatomy, effects move on continuous paths —
  nothing teleports, vanishes, or duplicates between adjacent frames.
- Physics reads in stills: airborne shows air, anticipation compresses,
  follow-through overshoots; effects stay anchored to their origin unless
  the request moves them.
- Energy matches the ask: idle/subtle means barely-different frames.

## Verify — the flip test

View the final frames strictly in order and narrate the motion; check
loop closure explicitly (last→first). A hedge in your narration is a
failed frame. The video pipeline usually passes this on the first try —
that's why it's the default.
