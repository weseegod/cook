---
name: threejs-frame-conventions
description: >
  Rules and a self-test for writing Three.js (and other y-up, right-handed)
  game code whose controls, camera, character facing and rendered-vs-collision
  geometry agree — derive every spatial frame from one source, pin every sign
  choice with a concrete check, verify against evidence the code did not
  produce. Use whenever writing or editing movement, camera, input mapping,
  character orientation, asset mounting, or level/collision geometry code in
  a 3D game.
metadata:
  short-description: "One frame for Three.js controls, camera, and facing"
---

# Three.js frame conventions: derive once, verify by running

Almost every "the right arrow moves the character left", "W walks toward the camera",
"the character faces sideways while walking" or "the character walks backward, feet pointing away from
travel" bug is the same defect: two pieces of code compute the same spatial frame independently and
disagree on a sign. Each piece looks right on its own. The fix is structural, not careful recall.

Every such decision — operand order of a cross product, the sign of a rotation, triangle winding, which
side of a left/right pair sits at +x — is a two-way choice, and recall picks the wrong branch often
enough that no unchecked instance is trustworthy. Pin each one the same way: substitute a canonical
basis (`forward = (0,0,-1)`, `up = (0,1,0)`), write the concrete result you expect next to the code, and
check it against evidence the code under test did not produce (Rule 4).

## Rule 1 — one source of truth for every frame

- A camera-relative movement frame is **read from the camera object, every frame**. Never rebuild it
  with `sin`/`cos` of a yaw variable in a second place.
  ```js
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, UP);   // forward × up = right  (y-up, right-handed)
  move.addScaledVector(fwd, input.forward).addScaledVector(right, input.strafe);
  ```
  `crossVectors(UP, fwd)` is **left**. If you write the cross product by hand, write it as
  `right = (-fwd.z, 0, fwd.x)` and nothing else (check: camera behind the player, fwd = (0,0,-1) → right = (1,0,0)).
- If the camera is *placed* from a yaw, place it from the **same** forward vector you move with:
  `camera.position.copy(target).addScaledVector(fwd, -dist).addScaledVector(UP, height); camera.lookAt(target)`.
  Then "forward" for movement and "the direction the camera looks" cannot diverge.
- Character heading, camera yaw and movement direction must not each own a formula. Pick one
  (`player.rotation.y`), derive the others from it (`new Vector3(0,0,-1).applyQuaternion(player.quaternion)`).
- Prefer fewer frames. A fixed-angle follow camera behind the player plus world-axis WASD has one
  convention and zero reconciliation; an orbit camera plus camera-relative WASD has two frames and
  must use Rule 1 above.
- Name every vector with its frame (`fwdWorld`, `dirCam`, `hitLocal`) and never hand a module-level
  scratch vector (`_v`, `_tmp`) to another function as an argument: if the callee `.set()`s it, the
  caller's direction silently becomes whatever the callee last computed.
- A ray has one origin frame. A third-person shot or probe that starts at the *camera* hits whatever is
  between the camera and the character, and a second probe started at the character's eye along the
  camera direction lands beside the crosshair. Use one pattern everywhere: camera ray → aim point,
  then character ray from the muzzle/eye to that point.
- The same convention must hold across the pipeline boundary. A level compiler (Python, JSON) that
  emits an angle and the runtime that consumes it are two computations of one frame; give them one
  documented convention (Rule 2, top-down row) and one conversion helper per side, round-trip tested.

## Rule 2 — Three.js conventions that are easy to get wrong

| fact | consequence |
|---|---|
| Local **forward is −z** for Object3D; `rotation.y > 0` turns **counter-clockwise seen from above** (+z toward +x) | to face direction `d` with a −z front: `rotation.y = Math.atan2(-d.x, -d.z)`; with a +z front: `Math.atan2(d.x, d.z)` |
| `Object3D.lookAt(p)` points the object's **+z** at `p` (only cameras and lights point −z) | on a −z-fronted character `lookAt` faces it **away**; use `atan2` above, or `lookAt` then `rotateY(Math.PI)` |
| `camera.up` is a hint, not the view's up; the true screen basis is the camera's world matrix columns | screen-right = `setFromMatrixColumn(camera.matrixWorld, 0)`, screen-up = column 1, view dir = `getWorldDirection` |
| World axes ≠ screen axes unless the camera sits on +z looking at −z | "right on screen" is world +x only for that camera; in front of the scene it is −x, from the +x side it is −z |
| Top-down cameras with `lookAt` straight down need an explicit `camera.up` (e.g. `(0,0,-1)`) | otherwise the screen orientation is undefined and `Right` may map to any axis |
| The ground plane (x, z) seen from above is the **mirror** of textbook (x, y): `rotation.y = θ` sends local +x to `(cos θ, 0, −sin θ)`, so a 2D angle `φ = atan2(z, x)` or matrix `[[c,−s],[s,c]]` applied to (x, z) equals `rotation.y = −φ` | `mesh.rotation.y = data.rot` is wrong whenever `rot` came from `atan2(dz, dx)` or a 2D rotation in a level compiler — the mesh sits at `2·rot` from its collider; convert through one helper (`yawFromPlanarAngle = (φ) => -φ`) and round-trip it through an `Object3D` once |
| Cross products are cyclic: `forward × up = right`, so a front derived from a left/right pair is `up × right` | `right × up` is the **back**; a mount built from it turns the model 180° so it walks feet-first away from travel, and a self-test that reuses the same vector passes anyway (Rule 4) |
| glTF humanoid rigs (Mixamo and similar) face +z with the character's own **left** at +x — the `Right*` bones sit at −x | "right bone minus left bone" points −x; feed it to `up × right`, not to intuition about which side is +x |
| glTF assets are *supposed* to face +z; generated / converted assets often face **+x** or −z | never hard-code `model.rotation.y = Math.PI`; measure the front (Rule 3) and derive the mount rotation from it |
| Hand-built `BufferGeometry` front faces are wound **counter-clockwise seen from the visible side**; `FrontSide` culls the rest | a ground quad whose `computeVertexNormals()` normal has `y < 0` is invisible from above; assert the normal sign for every custom quad, or set `DoubleSide` deliberately |
| A closed `FrontSide` mesh (`ExtrudeGeometry`, box) is opaque from outside and **invisible from inside** | rooms need inward-facing walls or `DoubleSide`; otherwise interiors look out through their own walls while collision still stops the player |

## Rule 3 — never assume an asset's orientation; measure it

1. After loading, find the front from **two independent cues** and require them to agree: a named
   marker node (`nose`, `head`, `eye`), the foot→toe bone direction, the longest asymmetric
   bounding-box axis, `up × (right − left)` from a bone pair, the format's documented convention
   (Rule 2), or render the asset from +x/−x/+z/−z and look. Prefer cues that do not depend on pose:
   arms and hands are posed differently per asset and can be tens of degrees off; feet, head markers
   and the hips→head axis are stable. If the cues disagree, stop and render — do not pick one.
   Record the result once, with the cue it came from: `const ASSET_FRONT = new THREE.Vector3(0, 0, 1); // toe bones`.
2. Mount it so that front becomes the parent's −z: `model.quaternion.setFromUnitVectors(ASSET_FRONT, new THREE.Vector3(0, 0, -1))`.
   Now the parent's yaw logic (Rule 2) is the only heading code.
3. Verify by moving the character and checking, in code, that the asset's front axis in world space
   aligns with velocity — measured through a cue **other than** `ASSET_FRONT` (see the self-test).
   If you cannot measure, say so in a comment and test visually.

## Rule 4 — verify by executing, not by reading

Reading code does not catch sign errors; running it does. **If you can run code in this environment**
(a browser tool, a test runner, a sandbox), run a control self-test in the actual game loop before
declaring movement / camera / facing done. **If you cannot** — e.g. you are answering in a single
response with no tools — do not announce that you will verify and stop: apply the Rule 6 checklist
mentally, then write the complete code in this same response. Never end a response without the code
that was asked for. Self-test to run when execution is available:

```js
// dev-only: window.__selfTestControls()
async function selfTestControls() {
  const UP = new THREE.Vector3(0, 1, 0), V = THREE.Vector3;
  const basis = () => { const f = new V(); camera.getWorldDirection(f); f.y = 0; f.normalize(); return { f, r: new V().crossVectors(f, UP) }; };
  const press = async (code, ms) => { window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.replace('Key', '').toLowerCase() })); await run(ms); window.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const facing = () => new V(0, 0, -1).applyQuaternion(player.quaternion);   // parent heading
  // Independent oracle for the mounted asset: a cue the mount was NOT built from (toe bones, nose marker).
  const modelFront = () => { const a = new V(), b = new V(); footBone.getWorldPosition(a); toeBone.getWorldPosition(b); return b.sub(a).setY(0).normalize(); };
  for (const [code, axis, sign] of [['KeyD', 'r', +1], ['KeyA', 'r', -1], ['KeyW', 'f', +1], ['KeyS', 'f', -1], ['ArrowRight', 'r', +1], ['ArrowUp', 'f', +1]]) {
    const b = basis(), p0 = player.position.clone();
    await press(code, 500);
    const d = player.position.clone().sub(p0); d.y = 0;
    if (d.length() < 0.05) continue;                                        // key not bound
    const along = d.clone().normalize().dot(b[axis]) * sign;
    console.assert(along > 0.9, `${code}: moved ${along < -0.5 ? 'the OPPOSITE way' : 'sideways'} (cos=${along.toFixed(2)})`);
    console.assert(facing().dot(d.clone().normalize()) > 0.9, `${code}: character faces ${facing().dot(d.normalize()).toFixed(2)} off its movement`);
    console.assert(modelFront().dot(facing()) > 0.9, `${code}: mounted asset faces ${modelFront().dot(facing()).toFixed(2)} off the parent heading`);
  }
}
```
Wire `run(ms)` to step your update loop deterministically (fixed dt). If any assertion fails, fix
the *frame derivation* (Rule 1), not the symptom — flipping a sign where the error surfaced usually
moves the bug somewhere else.

**The oracle must be independent of the code under test.** Transforming `ASSET_FRONT` by the model's
world quaternion and comparing it with the parent's −z is a tautology: it passes with the mount 180°
wrong, because both sides were derived from the same vector. Compare against a cue the mount was not
built from. A check that cannot fail is documentation, not verification.

Extend the same run with the checks that dot products cannot make:
- **Render one frame and look at it** (screenshot tool, headless browser). Culled faces, colliders
  without meshes, meshes rotated away from their colliders, and slabs sitting between the camera and the
  character are invisible to numeric probes and obvious in one image.
- **Anything on a path must move**: step a few seconds and assert displacement > 0. A path parameter
  that is a constant fixed at spawn shows up here and nowhere else.
- **Camera occlusion**: sweep pitch through its full range in the tightest interior and assert the
  character stays visible. Raycast from the camera's actual position, not the rig pivot, against every
  occluder class — floors, ceilings and roofs as well as walls.

## Rule 5 — one geometry, two consumers: rendering and collision must agree

Rendered meshes and collision volumes are two computations of the same frame, and every sign error
between them is silent: the player is stopped by nothing visible, or walks through what is drawn.
- Derive both from **one record through one conversion**. `mesh.rotation.y = solid.rot` beside a
  collision routine that interprets `rot` with hand-written `cos`/`sin` is two conventions (Rule 2,
  top-down row); route both through the same helper so a wrong sign is wrong — and visible — in both.
- **Every collider has a mesh, every touchable mesh has a collider.** Keep an explicit list for the
  exceptions (decorative, invisible trigger). Provide a debug overlay that draws every collider as a
  wireframe and turn it on once before finishing; invisible colliders accumulate silently without it.
- Generated levels get **invariant checks in the generator**, not in play-testing: placed primitives do
  not intersect each other, every passage admits the player's radius, the camera clears every ceiling
  at every pitch, and no obstacle class lacks a collider. One failing check here is cheaper than one
  bug report each.

## Rule 6 — review checklist before finishing

Grep your own code and justify every hit:
- `Math.sin(` / `Math.cos(` of a yaw, heading or camera angle → is this the *only* place that frame is built? If not, delete it and import the vector.
- `new THREE.Vector3(1, 0, 0)` / `(0, 0, 1)` / `(0, 0, -1)` used as "right"/"forward" → is the camera guaranteed to be behind the player looking −z? If not, derive it.
- `.lookAt(` on a non-camera → does that object have a +z front?
- `rotation.y = Math.PI` / `Math.PI / 2` on a loaded model → where was the front measured?
- `atan2(` → argument order matches the front axis (Rule 2)? If it reads an `(x, z)` pair from level data, is the result negated before it becomes `rotation.y`?
- `cross(` / `crossVectors(` → `(forward, up)` order for right; `(up, right)` order for a front derived from a left/right pair?
- `rotation.y = <field from data>` → does the collision code interpret the same field through the same helper (Rule 5)?
- `setIndex(` / hand-built triangle lists → is the normal's sign asserted, or is `DoubleSide` deliberate?
- Module-level `_v` / `_tmp` vectors passed as arguments → does any callee `.set()` them?
- The self-test's facing oracle → does it use a cue other than the one the mount was built from (Rule 4)?

If the game has more than one of these, run the self-test (Rule 4) and look at one rendered frame.
It takes seconds and catches what review misses.
