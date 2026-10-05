---
name: game-assets
description: >-
  Game art and 3D models with the Imagine tools: sprites, sprite sheets,
  animation cycles and FX, tilesets and seamless terrain, character turnarounds
  and variants, UI, HUD, icons, logos; textured 3D models (.glb) from an image
  for Three.js, Unity, Godot or Unreal.
when-to-use: >-
  Any game asset or game art, 2D or 3D; a 3D model, mesh or GLB from a picture;
  "make this 3D"; /game-assets.
metadata:
  short-description: "Engine-ready game art, 2D sprites to 3D models"
---

# Game assets

One skill, six references. Read `assets.md` first for every request — it holds the
engine-ready defaults users never state, the spec checklist, style anchoring, and the
read-back verification that applies to all game art. Then read the one reference that
matches the request:

| Request | Read |
|---|---|
| anything that moves: walk/run cycles, attacks, idles, FX, flags, fire, animation sheets | `animation.md` |
| a recurring character: turnarounds, poses, outfits, palette swaps, consistency across shots | `characters.md` |
| tiles, tilesets, autotiles, seamless terrain or ground textures | `tilesets.md` |
| UI, HUD, buttons, icons, item art, logos, title screens | `ui-icons.md` |
| a 3D model, mesh or GLB from a picture or a generated image | `3d.md` (its helper is `scripts/three_d.py`) |

Prompt craft and tool choice (`image_gen` vs `image_edit` vs `reference_to_video`) live in
the `imagine` skill; load it alongside this one when the request is about how to phrase a
generation rather than what a game needs from it. Mounting a finished `.glb` in a y-up engine
so controls, camera and facing agree is the `threejs-frame-conventions` skill.

Rules that hold across every reference:

- Deliver engine-ready output: exact pixel sizes, transparent backgrounds where the engine
  expects them, consistent scale and lighting across a set, and file names the engine can
  index.
- Anchor style once and reuse the anchor; never let a set drift between generations.
- Read back what was generated before declaring it done, and flag defects honestly
  (wrong frame count, baked shadows, mismatched palette) instead of describing intent.
