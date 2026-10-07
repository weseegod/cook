# UI, HUD, icons and logos

# Game UI & Icons

UI is a SYSTEM: the set matters more than any piece.
Users state WHAT they need, not how — apply everything here even when
the request never mentions it.


## 1. Interaction states (normal/hover/pressed)

- Generate NORMAL first; hover and pressed are `image_edit`s of it with an
  explicit freeze-list: "same shape, same size, same ornament, same frame
  thickness, same background — change ONLY <state treatment>".
- Standard treatments: hover = subtle outer glow / slight brighten;
  pressed = darker + inset/inner shadow. States must be distinguishable at
  a glance AND identical in geometry — overlay-compare: outlines should
  coincide, frame thickness included.

## 2. Icon sets

- One style contract for the whole set, decided before generating: same
  stroke weight, same fill treatment (all outlined OR all solid — never
  mixed), same palette family, same padding, same background, same visual
  weight. Verify the set side by side; one icon with a different treatment
  (e.g. sitting in a filled tile while others float) fails the SET even if
  it's individually fine.
- Generate the SET as one sheet: a single `image_gen` of all icons in a
  tidy grid (equal cells, flat keyable background, one per cell), so the
  contract is rendered once rather than inherited edit by edit. Isolate
  each icon by segmentation (`assets.md` in this skill, *Isolating items from a
  sheet*): keyed alpha, uniform padding, one canvas size — not grid cuts. Edit-chain from the sheet only for state variants or
  to fix a single cell; regenerate the whole sheet if the style drifted.
- Each icon must read at 32px: squint-test the thumbnail.

## 3. Panels, bars, wordmarks

- Panels/dialogs: blank, text-ready, borders that survive 9-slicing
  (uniform edges, ornament concentrated in corners).
- Bars: clear frame vs fill separation; fill design must work at any
  percentage.
- Wordmark logos: image models garble text — generate, then READ THE TEXT
  BACK letter by letter; any wrong/merged/extra letter = retry. Deliver as
  an isolated asset on flat/keyable background, not a full scene, unless a
  title SCREEN is requested.

## 4. No text anywhere else

Buttons, panels, icons: no lettering unless explicitly requested — models
garble it and engines localize it.
