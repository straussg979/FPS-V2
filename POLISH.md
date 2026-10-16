# Polish pass: smooth playback, no tearing, lighting, building detail

This pass follows `COLD_SECTOR_POLISH_PROMPT.md` in four parts. **Gameplay is unchanged:** every collider, panel,
spawn, zone, camera and light of both maps hashes identically before and after (server build and asset build alike),
so the navmesh and the bots' tactical data are the same files. The netcode, tick rate, snapshot rate, command
sending and lag compensation are untouched; `server/` has no changes at all.

## How it was measured (read this before the numbers)

The numbers below come from a cloud workspace **without a GPU**: headless Chromium rendering through SwiftShader (a
CPU rasteriser), 480×270, a 45-second bot match per run (4 bots + you vs 5 bots, short timers), the same scripted
start for both builds. The original build ran from the untouched zip, the new build from this one.

- **Absolute FPS is meaningless here** (both builds run at 0.2–1.6 fps on the software rasteriser). The *ratio*
  between builds on the same preset is still informative for GPU cost, and hitches over 33 ms are counted, but at
  these frame rates every frame is a "hitch".
- **Game CPU time per frame** (the game's own JavaScript for one frame: prediction, interpolation, animation, effects,
  scene updates, submitting draw calls) is measured directly and is a fair comparison. Its 99th percentile is where
  stutter shows up.
- **Draw calls and triangles** are summed over every render call of a frame (shadow cascades, SSAO pre-pass, backdrop,
  main pass, weapon), so they show the real submission cost.
- Prediction corrections per minute were 0 for every run on both builds (localhost, no packet loss), except one
  new-build run (bazaar high, 1.6/min). Use `?lag=100&jitter=20`
  on a game URL with the F3 overlay to watch corrections and render-clock steering under bad network conditions.

**Please re-measure FPS on your own machine** with the F3 overlay (it shows FPS, average / p99 frame time, hitches
per minute, render-clock steering and corrections), on each preset, both maps.

### Results (original → this build)

| Map | Preset | FPS ¹ | Avg frame ms ¹ | p99 frame ms ¹ | Frames > 33 ms per min ¹ | Game CPU avg ms | Game CPU p99 ms | Draw calls / frame | Triangles / frame |
|---|---|---|---|---|---|---|---|---|---|
| Qalat | low | 1.54 → 1.42 | 651 → 704 | 933 → 983 | 91 → 85 | 29.4 → **16.7** | 584 → **33** | 317 → 423 | 297,960 → 273,473 |
| Qalat | medium | 0.78 → 0.69 | 1290 → 1454 | 2516 → 1917 | 47 → 40 | 102.4 → **27.2** | 2520 → **78** | 709 → 893 | 602,522 → 610,522 |
| Qalat | high | 0.59 → 0.54 | 1698 → 1861 | 3250 → 2467 | 34 → 32 | 158.2 → **23.4** | 3246 → **39** | 605 → 871 | 595,838 → 791,026 |
| Qalat | ultra | 0.27 → 0.26 | 3637 → 3800 | 9166 → 5450 | 12 → 16 | 1162.8 → **28.9** | 9172 → **54** | 581 → 808 | 595,002 → 786,774 |
| Bazaar | low | 0.95 → 1.32 | 1054 → 756 | 2116 → 1000 | 56 → 79 | 68.2 → **16.2** | 2117 → **45** | 388 → 468 | 339,180 → 306,021 |
| Bazaar | medium | 0.45 → 0.67 | 2230 → 1497 | 4450 → 2066 | 25 → 40 | 306.9 → **26.3** | 4450 → **56** | 621 → 906 | 667,862 → 614,812 |
| Bazaar | high | 0.41 → 0.47 | 2461 → 2148 | 5216 → 2866 | 23 → 28 | 390.8 → **35.7** | 5211 → **136** | 699 → 803 | 674,842 → 844,806 |
| Bazaar | ultra ² | 0.18 → — | 5636 → — | 10916 → — | 9 → — | 2194.7 → — | 10922 → — | 655 → 1007 | 667,418 → 866,018 |

¹ Software rasteriser: these columns measure SwiftShader's CPU cost of filling pixels, not a GPU. They are kept because
the prompt asks for them; on real hardware expect the low preset to be at least as fast as the original (fewer
triangles, same post chain, fewer CPU spikes), and medium/high/ultra to cost more GPU time for the new shadows, SSAO,
light shafts and building detail. Frames over 33 ms per minute equals the frame rate here, since every frame is a hitch.

² Bazaar ultra on the new build loses the WebGL context in SwiftShader after a few frames (single frames of more than
10 s: 4 × 3072² shadow cascades, MSAA×4 and SMAA on a CPU rasteriser). No shader or program error is logged; the shader
that failed earlier (more than 16 texture units on the skinned glove) is fixed. A rerun with Chrome's GPU watchdog
turned off hung instead of finishing, so no clean number exists for this cell. Please check ultra on a real GPU.
Qalat ultra on the same settings ran its full 45 s cleanly.

**The fair comparison is game CPU time.** The 99th percentile fell from 0.6–11 s to 33–136 ms, because shader programs
are now compiled while the map loads instead of on first sight. The average fell 1.8–40×, because nothing is allocated
per frame and the remote-soldier, effect and world updates do less work.

## Part 1: smooth playback

| Change | Where |
|---|---|
| Own view drawn between the last two 64 Hz ticks every frame (`alpha = (now - cmdClock) / step`): position, crouch height and lean. Mouse look is applied per frame, unsmoothed. | `main.ts` `updateCamera`, `drawnPos`, `tickAlpha` |
| Due ticks run at the start of every frame as well as on the 4 ms interval; `runCommands` keeps its own clock, so a tick never runs twice and the commands sent are byte-identical. | `main.ts` `step` |
| After a reconcile, `prevPos` / `prevHeight` / the lean's previous value are left exactly where the replay put them, so drawing between ticks continues instead of stalling for a tick after every snapshot (32 times a second: this was the main source of the micro-stutter). | `main.ts` `reconcile` |
| A hidden correction is measured on the *drawn* position and decays per frame as `exp(-18 dt)`. | `main.ts` |
| Monotonic render clock: the server-clock offset is the maximum of the last 1.5 s of samples (late packets only ever lower a sample), and the render clock is steered by ±1–3 % rate instead of stepping. It never goes backwards; only a > ¼ s gap resets it (counted in the overlay). | `net.ts` `noteOffset`, `renderTick` |
| Remote soldiers: Hermite interpolation with the snapshot velocities as tangents (clamped to the path), yaw on the shortest arc; past the newest snapshot, 50 ms of linear extrapolation that then eases out (never a freeze or snap); any jump left over is absorbed and fades at `exp(-10 dt)`; respawns and teleports snap. One interpolated object per soldier, reused every frame. | `main.ts` `updateRemotes` |
| Frame-rate independent animation: the walk-cycle blend weight (`pose.ts`, bit-identical at the server's 64 Hz so the hit capsules do not change), view-bob weight, and the ragdoll now integrate at a fixed 180 Hz with an accumulator (its damping and friction used to depend on the frame rate). | `pose.ts`, `main.ts`, `soldiers.ts` |
| FPS cap paced on a fixed grid of `1000/cap` ms instead of "at least `1000/cap` since the last frame", so 144 on a 240 Hz screen alternates evenly. | `main.ts` `frame` |
| Per-frame allocations removed from the hot path: camera quaternions, `interpSoldier` spreads, soldier state maps and flag objects, tracer / casing arrays, viewmodel vectors; idle particle pools no longer re-upload their buffers every frame. | `main.ts`, `effects.ts`, `viewmodel.ts`, `soldiers.ts` |
| Shader warm-up while the map loads: every weapon / gadget / grenade model (world and first-person), both soldier kits at every LOD, decals, casings, the reinforcement plate, the shadow programs and the post chain are compiled and drawn once (`compileAsync` + a real render). This is what removed the half-second to ten-second CPU spikes in the original build. | `main.ts` `warmupShaders` |
| **F3 debug overlay**: FPS, frame-time graph (8/16/33 ms lines), average / p99 / max, hitches per minute, render-clock steering and resets, prediction corrections per second and minute, draw calls and triangles. | `perf.ts` |

## Part 2: tearing and flicker

**Depth precision (the map tearing).** The main camera ran 3 cm–600 m on a 24-bit depth buffer. Now: near plane
10 cm (the weapon has its own camera and depth clear; leaning, scoping and walls pressed against the face were
checked); **reversed-Z with a 32-bit float depth buffer** where `EXT_clip_control` exists (Chrome, Edge and Firefox
on desktop), with the shadow-map depth, the sky, decal polygon offsets, SSAO and the light shafts patched for it
(`depth.ts`). The far mountains and the sky are drawn first by a backdrop camera (1–4000 m) on their own layer, and
the main frustum ends at 400 m. `?depth=standard` switches reversed-Z off for comparison.

**Coplanar faces.** `npx tsx scripts/maps/overlaps.ts data/maps/*.json` builds each map and lists face pairs from
different pieces that are coplanar within 2 mm, face the same way and overlap by more than 1 cm². The asset build
then runs the same clean-up (`shared/src/level/overlaps.ts`) and **fails the build if anything is left**:

| | Qalat | Bazaar |
|---|---|---|
| Overlaps in the original geometry | 4,351 (970 m²) | 5,790 (1,098 m²) |
| Emitted by the new prefabs (both detail levels, before clean-up) | 6,306 | 6,321 |
| Buried faces cut (wall feet in slabs, wall ends against walls, plinth backs…) | 31,642 | 32,343 |
| Visible overlaps layered apart (detail piece moved 4 mm per layer, max 16 / 22 mm) | 1,411 → 0 | 1,960 → 0 |
| **Left in the shipped geometry** | **0** | **0** |

The systematic ones were also fixed at the source: door / window head pieces that overlapped their jambs, crate frame
bars sharing faces where they cross, railing rails flush with their posts, plinth / parapet-cap / roof-band strips
overlapping at house corners, grille bars, power-line and bunting segments overlapping at joints, charpoy rails,
container-shop corner castings, and the flat rain-stain cards under roof spouts (now part of the wall shader).

**Cracks and T-junctions.** The rounded walls (Part 4) are one watertight shell per wall: every face of every cell
shares the wall's grid lines, so neighbouring pieces meet vertex to vertex. A test builds walls with doors and windows
and checks every edge is shared by exactly two triangles (0 open edges, with and without displacement).

**Shadows.** 1–4 cascades fitted to bounding spheres of the view slices (size does not change when you turn), centres
snapped to whole shadow texels (no crawling), normal bias 1.5 texels per cascade (no acne near or far), small depth
bias, 12 % blend between cascades (no seams). `shadows.ts`.

**Shimmer.** SMAA on high / ultra (MSAA 4× + SMAA on ultra), geometric specular anti-aliasing, all textures mipmapped
with anisotropy, and thin pieces (wires, bars, grilles, rebar) in their own batch whose shader keeps only their
pixel-coverage worth of fragments once they are thinner than a pixel: they fade out with distance instead of
flickering. TAA was not added: it needs motion vectors for skinned soldiers and the viewmodel and its ghosting on
moving players is a gameplay risk in a shooter; SMAA plus specular AA plus the thin-piece fade covered what we saw.

**Decals.** Bullet holes are placed by finding the box that was hit, clamping the hole inside that face (away from
rounded edges, so it never hangs over a corner) and moving it onto the drawn surface through the same displacement
field the walls use (`organic.ts`), 2 mm out; the polygon offset flips sign with the depth mode.

**Player models.** `npx tsx scripts/assets/soldier_check.ts` finds coplanar layered parts in the soldier: 36 pairs
at LOD 0 before (33 at LOD 1/2: shoulder straps on plate sides, chest-rig straps, glasses on the face, the boom mic on the beard, boot soles
and toe caps), **0 after**. LODs switch with 8 % hysteresis, every LOD shares the one skeleton posed once per frame,
and the third-person weapon hangs from the weapon bone, so it moves with the same pose in the same frame. Skinned
meshes keep `frustumCulled = false`.

**Resizes and swaps.** The canvas and composer resize together and only on a real size change; destructible panels
already build the new mesh before swapping; building LOD variants are both built at load time and switched by
visibility within one frame.

## Part 3: lighting, shadows and shaders

- **Sun**: cascaded soft shadows (Vogel-disk PCF with `shadow_pcf_taps` taps, plus a PCSS blocker search on medium+:
  sharp at contact, softer away from the caster). One light carries the sun; the shadow-only cascades cost no lighting.
- **IBL and bounce**: the PMREM sky environment lights every standard material (diffuse and specular); a warm
  ground-bounce term lights shaded walls from below with the colour of the sunlit earth.
- **AO**: a baked per-vertex AO for all level geometry (12 rays per vertex at build time: inner corners, wall bases,
  under beams and roof edges; free on every preset) plus SSAO on medium+ (half resolution, normal-oriented samples,
  depth-aware blur, bilateral upsample) applied **to ambient light only**.
- **Materials and weathering** (world space, in the shader): dust at the foot of walls, rain streaks below spouts,
  sills and parapets, soot above some kitchen openings, a damp band at the base and sun-bleached tops on mud walls,
  plaster fallen off with brick behind it, chipped paint on doors and shutters, glass and metal reflecting the sky,
  detail normals up close. The packed ORM texture is bound once per material (a texture slot budget fix found while
  measuring: ultra on a skinned soldier exceeded WebGL's 16 units).
- **Atmosphere**: height fog with a sun-ward glow plus aerial perspective (distance haze shifts cooler away from the
  sun); on high / ultra, ray-marched light shafts through doorways and windows and dust motes that only show in sunbeams.
- **Post**: ACES (or AgX in the menu), eye adaptation over about a second, bloom threshold raised so only the sun and
  hot highlights bloom, warm-highlight / cool-shadow split toning.
- **Interiors**: on medium+ the map's lamps near you become real point lights (2 / 4 / 4), fading in and out; one or
  two of them cast shadows (shadow maps refreshed a few per frame). Soldiers get a minimum fill in dark rooms, so a
  player in a doorway is never invisible.

## Part 4: building detail

Everything here is visual only: the colliders are the original boxes (the gameplay hash is identical), and the drawn
surface stays within a few millimetres of them (rounding only takes material away; displacement is ±1.2 cm on mud,
±0.7 cm on brick, ±0.25 cm on concrete).

- `MeshBuilder.addRoundedBox` (radius, 1–4 segments, per-side rounding, a subdivision grid and a displacement field)
  and `organicWall` (a whole wall with its openings as one rounded, watertight shell).
- Walls: rounded jambs, heads and free ends; mud walls lean in slightly toward the top (8 mm) and exposed tops get an
  uneven crown; plaster bulges and sags gently. Parapets, plinths, roof bands, sills, slab edges, qala footings and
  buttresses are rounded; round watchtowers are one smooth, slightly irregular drum instead of five stacked cylinders.
- Openings: timber lintels slightly off level, worn rounded sills, frames not quite plumb.
- Roofs: beam ends (already there), reed matting under the earth roof edge, dirt drifted against parapets, spouts with
  rain streaks, domes with an irregular profile and a brick ring at the base.
- Ground contact: an earth ramp along the foot of house walls and a little rubble.
- Concrete / brick buildings: AC units with cables up to the roof, rebar stubs on flat roofs, wavy corrugated awnings.
- **LOD**: each 24 m cell has a near variant (all of the above) and a far variant (the original boxes, with baked AO
  and weathering). Cells switch at 42 m (high / ultra) or 24 m (medium) with 4 m of hysteresis; low always uses the
  far variant.

| Triangles | Qalat | Bazaar |
|---|---|---|
| Original | 248,956 | 281,402 |
| New, every cell far (low preset) | 192,159 (0.77×) | 217,603 (0.77×) |
| New, every cell near (upper bound for high) | 504,370 (2.0×) | 495,278 (1.8×) |
| Backdrop terrain (its own layer, both builds) | 32,480 | 32,480 |

## Trade-offs and things to know

- **High and ultra cost more GPU than before** (more draw calls from shadow cascades, the SSAO pre-pass, local light
  shadows and the near building detail). Low is at least as fast as before (fewer triangles, one cascade, no SSAO).
- SwiftShader cannot tell you the real GPU cost; the per-preset FPS columns above should be re-measured on hardware.
- Reversed-Z needs `EXT_clip_control`; without it (some mobile / older browsers) the game falls back to standard depth,
  still with the 10 cm near plane and 400 m far plane, which on its own fixes most of the tearing.
- No TAA (see Part 2).
- The asset build takes about a minute longer (the overlap clean-up and the AO bake: ~25 s per map).

## Checks

- `npm run typecheck` and `npm run build` pass.
- `npm run check-maps`: routes and reachability OK on both maps, 0 coplanar overlaps in the shipped geometry, 0 in the soldier.
- Bot matches on both maps, all four presets, both builds: no errors in the browser console or the server log
  (the only console message on every run is the headless browser refusing pointer lock without a real click).

## Screenshots

`docs/afghanistan/polish_<map>_<spot>_before.jpg` / `_after.jpg`: the same free-camera spots on the original and the
new build, high preset, 1280×720.
