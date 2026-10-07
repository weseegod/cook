# Core discipline for every game asset

# Asset Core

Game developers ask for WHAT they need, not HOW to make it engine-ready.
The how is your job. Apply these defaults whenever the request doesn't say
otherwise — an asset that needs manual cleanup is a miss even if the user
never mentioned the requirement.

## Unprompted engine-ready defaults

| When asked for... | Deliver, without being told... |
|---|---|
| a character/creature/prop sprite | isolated subject, flat single-color keyable background, clean silhouette, no baked ground scene or cast shadow |
| anything that moves/animates | a frame SEQUENCE that loops cleanly (see `animation.md` in this skill — video-first) |
| a sprite sheet | uniform implicit cells, NO divider lines, subject at the identical position per cell so frames crop at width/cols × height/rows — or build it yourself: frames + PIL composite |
| ground/terrain/water/walls | seamlessly tileable (verify with a real 2×2 composite), no landmark motifs, non-directional lighting where rotation might be used |
| UI panels/frames/buttons | scale-survivable (9-slice: corner ornament, uniform edges), no text ever (games localize), state variants geometry-identical |
| the same character/object again | edit-chained from your existing base image, never regenerated fresh |
| side-view sprites & cycles | face RIGHT (screen +x) unless the brief says otherwise - engines flip for left; mirror the reference first if it faces left, then animate |
| icons | one style contract across the set, uniform padding, legible at 32px |
| several items rendered as one sheet (cast, icon set, turnaround) | each item ISOLATED into its own file by segmentation (below), never by blind grid slicing: true alpha, tight bounds + uniform padding, one consistent canvas size, nothing clipped, count == expected |
| a 3D model/mesh of a character, creature, or prop | a source image with the sprite defaults above (isolated subject, flat plain background, full object in frame, 3/4 view, even lighting, no cast shadow), then `3d.md` in this skill; a recurring character starts from its existing canonical base image (`characters.md` in this skill), never a fresh generation |

Deliver organized, exactly-named files; if the request leaves counts or
naming to you, choose sensible names and document them in a manifest/record.

## Isolating items from a sheet

A sheet (lineup, icon grid, turnaround) is one render; the deliverables are
the items. Grid slicing at width/cols cuts limbs, keeps neighbours' edges,
and leaves the background baked in. Segment instead:

1. **Key the background** — the sheet was generated on a flat single color;
   build a mask by color distance to that key (sample a corner), soften the
   edge 1–2 px so the alpha is not jagged.
2. **Find the items** — connected components of the mask
   (`scipy.ndimage.label` or OpenCV `connectedComponentsWithStats`); merge
   components whose bounding boxes overlap or sit closer than ~3% of the
   sheet width (a detached plume, sword tip, or particle belongs to its
   figure); drop specks under ~0.05% of the sheet area. Sort left→right,
   top→bottom.
3. **Crop with the mask** — per item: bounding box + uniform padding
   (~6% of the item's larger side), cut to RGBA with the mask as alpha; never
   the raw crop with the key color still in it.
4. **Normalize** — one canvas size for the whole set (max item w/h + padding,
   power-of-two if the engine wants it), items centred or baseline-aligned
   (feet on one line for characters), exported as PNG.
5. **Verify, pass/fail** — component count equals the expected item count;
   no item bbox touches the sheet border (clipped in the render → regenerate
   the sheet, don't patch); no alpha at the crop border; each file opens as
   RGBA with transparent corners. Re-key at a tighter tolerance if the mask
   eats light edges (glass, glow, hair).

If two items touch on the sheet, regenerate with "clear gaps between items"
rather than hand-splitting them. Do not ask the image model for a
"segmentation mask" of the sheet — it renders a line-art interpretation, not
a silhouette (measured: IoU 0.49 against the key mask, 120+ fragments for 3
figures). When keying genuinely fails (item colors near the key, glow or hair
edges), use a real matting/segmentation model (e.g. `rembg`) on each keyed
crop, still verified by the count and border checks above.

## Working discipline

1. **Spec checklist (private).** List every stated property PLUS the
   applicable defaults above. Verify against it; never paste it into
   prompts.
2. **Prompt in the generator's language.** 2–5 vivid sentences, always with
   style/medium words. Express geometry/quantity as nameable visual
   configurations (clock positions, pie wedges, colored markers), never as
   numbers or abstractions.
3. **Verify by describing blind, then diffing.** Write what the image shows
   before re-reading the spec. Every stated property AND every applicable
   default is pass/fail — no "good enough", no self-negotiated waivers. A
   hedge in your own description = failed check.
4. **Escalate representation, then strategy.** Retry once with a more
   concrete visual re-expression. If the generator repeats the same failure,
   it's a prior: build compositionally (parts + PIL rotate/mirror/assemble —
   mind mirrored asymmetries) or keep the best and FLAG it. ~2 discards max
   per point being proven.
5. **Deliver and report.** Final pass across all files for cohesion and the
   checklist; state every unfixed defect and every default you consciously
   deviated from.
