# Character consistency: turnarounds, variants, palette swaps

# Character Consistency

The product is the IDENTITY, not any single image.
Users state WHAT they need, not how — apply everything here even when
the request never mentions it.


## 1. Asymmetry bookkeeping (turnarounds)

Before prompting, write the side-map table for every view. Example: "her
left arm sleeved" →

| view  | sleeved arm appears on | staff hand appears on |
|-------|------------------------|----------------------|
| front | viewer's RIGHT         | (as designed)        |
| right profile | near side = her right = BARE | ...          |
| back  | viewer's LEFT          | mirrored from front  |

Prompt each view with VIEWER-relative words from this table, never
body-relative words. Verify each output against the table, not the original
sentence.

Occlusion is not an error. In a strict profile the far-side arm and anything
on it (shield, satchel) are hidden behind the body; in a back view a
front-mounted emblem is invisible. A view that hides an asymmetric feature
still passes if the feature is on the correct side wherever it IS visible.
Do not composite hidden props back in or re-edit the view to expose them;
if the client needs the prop readable from that angle, ask for a 3/4 view
instead. Budget: one sheet, at most one fix-up edit per view, then crop and
deliver.

## 2. Hands and props

- A held item must be GRIPPED: check the hand-object contact point in every
  image. A staff floating beside an open hand = fail.
- The item stays in the SAME hand across all views/frames (mirror it
  correctly in back views).

## 3. Sheet first, then edit-chain

- TURNAROUNDS and multi-view sets: generate all views as ONE sheet in a
  single `image_edit` from the base ("this exact character in a
  turnaround: front, right profile, back, side by side at the same scale,
  same flat background") and isolate the views by segmentation
  (`assets.md` in this skill, *Isolating items from a sheet*): keyed alpha, tight
  bounds, feet on one baseline, one canvas size. One image is rendered
  in one style and one proportion set; a view-per-edit chain drifts a
  little at every step. Apply the side-map (§1) to the sheet prompt.
- Variants and states (damage, palette, equipment, expressions): one base
  image; each variant via `image_edit` from the base (or nearest neighbor
  view): "Keep this exact character — same face, colors, proportions,
  outfit, scale, background — change only <X>." Use a single edit to fix
  one bad cell of a sheet rather than regenerating the whole set.
- Views must be genuinely rotated (a side view is a strict profile: nose,
  chest, toes all pointing at the frame edge), not three slightly-turned
  fronts.
- KEEP THE STYLE WORDS in every edit prompt ("stylized 2D game art, cel
  shading" or whatever the set uses). Edits without style words drift
  toward photorealism.

## 4. Variants (damage / palette / equipment)

- State the freeze-list first in the prompt (pose, framing, background,
  everything not being changed), then the single change.
- Damage states are STATES, not action frames: worn, cracked, dented — no
  debris flying mid-air.
- Verify by viewing base and variant together: background hue, framing,
  proportions, and all unrequested details must match. Escalating states
  (hurt → critical) must be strictly ordered when viewed as a set.

## 5. Verify

For every image in the set, describe blind: which side has the marker
detail, what's in each hand, face/proportion match to base. One mismatch =
targeted retry of that image only.
