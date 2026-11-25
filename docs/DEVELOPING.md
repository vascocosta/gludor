# Developing Gludor

Implementation notes for Gludor. The player-facing overview is in
[../README.md](../README.md).

## Stack

Three.js and TypeScript, bundled by Vite. There is no game engine, physics
library, external model, or texture pipeline; the terrain, towns, water, clouds,
glider mesh, and audio are all generated in code.

## Glider model

The GD-81 is a fictional 15 m single-seater: 450 kg, 11 m² wing, CD0 0.010,
Oswald 0.9, CLmax 1.6. It glides at roughly 102 km/h IAS with an L/D of about
37.5 and stalls near 73 km/h. The visual model is a smooth composite
single-seater with lofted airfoil wings and winglets, a T-tail, a main wheel half
sunk into the belly, a tiny tailwheel caster, a cobalt-and-pearl livery with a
GD-81 fin decal, and a wing that flexes with G-load.

## How it works

### Simulation

The physics loop runs at a fixed **240 Hz**, decoupled from rendering with an
accumulator. The glider is a rigid body with a quaternion attitude and body
angular rates.

Forces are computed in the body frame and rotated into world space:

- Lift and drag from `CL(α)` and `CD(CL)`; stall blends the lift curve past
  `α_stall` and adds separation drag.
- Side force, roll, pitch, and yaw moments from angle of attack, sideslip, and
  the control surfaces.
- A simple inertial model (`Ixx`, `Iyy`, `Izz`) with rate damping.
- Weight is applied once, in `step()`, not again during integration.

Airspeed is wind-relative. IAS comes from the ISA density ratio, and the
total-energy vario adds a clamped acceleration term
(`v_y + (TAS/g)·dV/dt`) so it reads the energy traded in a pull-up or pushover.
The smoothed vario and TE vario both feed the HUD and the variometer audio: fast
high beeps in lift, and a continuous low tone in sink.

Two tuning notes worth knowing if you change the model:

- `cmQ` is much larger than a textbook value (`-140`). The tail is not modelled
  as a separate lifting surface, so this stands in for the missing tail volume;
  without it the phugoid diverges.
- Gravity belongs in exactly one place. Applying it in both `step()` and
  `integrate()` produces a nosedive and runaway airspeed.

The landing roll deliberately bypasses the aerodynamic model. It decomposes
ground velocity into forward and lateral components, applies rolling friction
and the wheel brake to the forward component, and scrubs the lateral component
with tyre grip. Using the total speed as the forward component would let a
crabbed touchdown gain energy instead of settling onto the wheel.

### Launch and tow

The winch is a constant-power pull with a pitch-following assist. It releases
automatically at 440 m AGL and applies a short post-release push so the glider
does not zoom. The aerotow uses a procedural high-wing tug: it rolls, lifts off
at 27 m/s, and settles into a gentle 620 m-radius climbing turn over the field.
The 60 m rope is a spring-damper with a two-metre stretch limit and a virtual
nose hook; flight assist keeps the glider in the tug's wake while the stick
always overrides it. The tow releases at 1,200 m AGL. Town strips are
winch/air-start only; aerotow stays at the home field.

### World and weather

The ground is a stateless analytic surface sampled on a world-aligned 50 m
grid, so physics and rendering can evaluate it anywhere. The renderer keeps a
moving window of 4 km tiles at 50 m (near), 8 km at 100 m (mid), and 16 km at
400 m (far); coarse tiers sit slightly below the finer ones and extend
underneath them, hiding both LOD seams and the frames while new edge tiles are
generated. Generation is seeded, so the same world position always produces the
same terrain, whatever order tiles are visited in. The airfield is flattened
around the origin, with a 2 km asphalt runway along Z, a 1.2 km parallel grass
strip, painted runway designators and dashed white grass edges.

Mountains come from a deterministic 9 km grid: each cell has a 60% chance of a
massif, made from one main peak plus up to three satellite summits. Alpine
peaks are narrower and taller than the ordinary rounded hills, and their snow
caps are shaded per fragment in the terrain material so the snow line stays
smooth at every LOD. A continuous mask fades mountain contributions to zero
inside 6 km of the airfield and back to full strength by 7.5 km, and the
combined height eases into a soft cap.

The training ridges are deliberately finite and hand-placed. North of the
airfield a 15 km central bank runs east-west, with a shorter spur and a real
col beyond each end; a north-south bank stands west of the field, crossing the
west spur. They make the first ridge runs a route from one climb to the next
rather than a lap of one wall.

Lakes are generated from a deterministic 2.5 km hash grid, which puts several
inside a short glide of the airfield. A candidate survives only if its basin is
low and gentle enough, its water level is set below the sampled shoreline so the
flat surface cannot spill down a hillside, and it does not overlap a neighbour's
basin (two water planes cannot share one shore). The carve is applied inside the
analytic ground function, which keeps physics, terrain tiles, tree placement, and
the water mesh in agreement. A 1.3 km keep-out protects the runway and the home
thermal. All visible lakes are merged into one water mesh and one draw call; the
shader adds an opaque deep-blue body, a shallow rim, and animated ripple normals.

Rivers use the same water shader, but the coarse terrain tiles cannot resolve
their channels. The terrain streamer cuts the stream corridors out of every LOD,
and a high-resolution bank mesh fills the cut with samples clustered on the
water and banks, so a sloping bank triangle cannot bridge over the ribbon. A
separate river query feeds the water mesh, the carve, ditching, and town
keep-outs from one shared station list.

Two hand-placed streams cross the home valley. The western river rises on the
snow line and runs into the western lake, widening from roughly 30 m to 125 m.
The eastern stream crosses south of the airfield into a low meadow, widening
from about 20 m to 50 m. The width changes along every course, and the water
carries a travelling flow wave so the ribbons do not look static.

Woodland streams in deterministic 1 km cells within 8 km of the glider, and
copse placement is derived from a per-cell hash, so the same wood always grows
in the same place. Each cell rolls for a main stand and often a smaller copse,
both tightly packed, so the woods read as dense canopy rather than scattered
dots. Field patchwork stays baked into the terrain vertex colours, and the
instanced tree meshes keep the farmland readable from the air without extra
draw calls. Trees avoid open water and town footprints.

Towns use a deterministic 6 km grid with a 3 km keep-out around the airfield,
plus one fixed home town in the southwest that is exempt from the keep-out
and always gets a church tower. Every town gets a stable fictional name from
its cell hash, combined from natural place-name pieces with an optional
Upper/Lower-style qualifier; the home town is **Brackenmoor**. Town airfields
are planned from the same grid: each cell's strip is a pure function of its
seed, so a runway is identical however the world is streamed. Only about half
the towns qualify, and a strip is rejected for water, a river corridor, a
crowded neighbour, or ground that would need more than a few metres of cut and
fill. A candidate is rejected if its centre or rim is too high, too steep, or
lapped by a lake; neighbours that would overlap keep the lower-indexed cell, so
the result never depends on query order. The placement and building data are
pure simulation code, shared by the physics and the renderer, so what you see is
exactly what you can hit. All walls, roofs, spires, and windows in range are
instanced (four draw calls), and the streets are one merged ribbon that follows
the ground. Buildings extend two metres below their plot to hide slopes rather
than flattening the terrain. The fixed home town is one of the largest, around
300 buildings, and always gets a church tower. Generated towns choose a 5–9 lane
street grid, a seeded radial outline, and a random plot density, so the result
ranges from a loose hamlet to a dense market town. Buildings are twice life-size
so they read from soaring altitude; tenements appear only in the larger
settlements.

Town strips follow the natural long profile of their hillside but are levelled
across their width, with a short blend back into the meadow. The finest render
tier is cut away under each graded pad and replaced with a high-resolution pad
mesh whose along-runway grid includes every profile knot. The mown ribbon,
threshold bars, shed, and windsock ride on that surface, so the coarse 50 m
terrain cannot bridge the pad and poke through the runway. Every strip also
owns a guaranteed thermal a short glide away.

Thermals come from a deterministic 2.5 km hash grid that is rebuilt around the
glider every 2 km; the dependable home thermal at (620, −720) is always present
near the field. Lake surfaces cool the boundary layer, so their cells start no
thermals. Cores are deliberately wide — roughly 1.6–3 km across at their base,
depending on the day — and flat-topped rather than sharply peaked, widen with
height, and stay fixed under their cloud markers so the sky you aim at is the
air you get. The marker cloud keeps a tighter footprint over the strong core,
so the lift fades out well beyond the visible cumulus instead of stopping at
its edge. The field also includes compensating sink and ridge lift computed
from the terrain gradient and wind. Wind uses a logarithmic boundary-layer
profile, a few degrees of veer per kilometre, and seeded multi-frequency gusts
whose amplitude scales with speed and the turbulence setting.

Clouds stream as 16 km tiles in a 5 × 5 window, with a couple of background
cumulus per tile plus one marker cloud above each thermal. A rolling 32 km
shadow bake follows the glider and re-projects the loaded cloud footprints along
the sun direction, so ground shadows stay aligned with the visible sky.

### Rendering and UI

Three.js draws a stylized low-poly scene: smooth-shaded, vertex-colored terrain
chunks, opaque lake and river surfaces, clustered towns, grass strips, a
procedural sky, soft cumulus clouds, baked cloud shadows, the GD-81 mesh, the
winch/tow cable, the procedural aerotow tug and its spinning propeller, and
thermal particles. The HUD is a separate 2D canvas with vector-drawn
instruments; it draws the nearest-thermal cue and a two-row nearest-field cue
showing each strip's town name, bearing, distance, designator, and length.

Audio is synthesized with WebAudio: filtered wind noise scaled by IAS, vario
lift beeps and a low sink tone, a stall horn, a landing thump, and a filtered
engine drone while the tug is on the rope. An optional generative score (`M`)
picks a new key and tempo for each flight and plays an A A' B A' form: a
breathing five-voice pad, a pentatonic melody and chord-tone bells locked to a
swung eighth-note grid, over a soft brushed downtempo pulse; it is off by
default.

## Streaming and performance

The streaming windows are deliberately larger than their rebuild thresholds, so
the old field stays visible while the new one is built.

- **Terrain:** 4 km near / 8 km mid / 16 km far tiles, with a 4 ms build budget.
- **Trees:** 8 km radius, rebuilt after 1.5 km of travel, 2 ms budget.
- **Towns:** 15 km radius, rebuilt after 4 km of travel, 2 ms budget.
- **Lakes:** 36 km radius, rebuilt after 2.5 km of travel; the rebuild is
  synchronous and usually cheap once the lake cache is warm.
- **Clouds:** 16 km tiles in a 5 × 5 window, 2 ms budget; the 2048² cloud-shadow
  bake is refreshed when the cloud field changes or the camera moves 3.5 km.

Only one of the tree and town fields rebuilds at a time, so their per-frame
budgets never stack. Town instances are built progressively: buildings arrive in
small batches and streets one at a time, returning to the frame loop whenever
the 2 ms budget is spent. Town *layout* is still generated when the window is
collected; the reduced house counts keep that cost small, and a lazy generation
queue is the next step if it ever shows up as a spike.

The main periodic cost to watch is a full town rebuild immediately after a
window changes; the old town field is kept visible until the new one is ready,
so the cost is CPU rather than a visual gap. Tree placement is spread over cells
and the old copse field remains until the rebuild completes.

The production bundle is roughly 700 kB of JavaScript (about 193 kB gzipped),
mostly Three.js.

## Project layout

```text
src/
  config.ts          GD-81 coefficients, weather presets, world constants
  main.ts            app state, fixed-step loop, input/UI/audio wiring
  core/              small math and seeded RNG helpers
  sim/
    terrain.ts       analytic ground, mountains, lake and river carving, airfield flattening
    towns.ts         deterministic towns, names, footprints, roof queries
    airfields.ts     deterministic town strips, runway profiles, grading, field picker
    atmosphere.ts    ISA density, wind shear, veer, turbulence
    lift.ts          thermal, ridge, and sink field
    aero.ts          lift/drag/moment coefficients
    towplane.ts      scripted aerotow tug: roll, climb, turn, release, departure
    simulation.ts    6DOF flight loop, winch and aerotow rope, ground/water/roof
                     contact, landing rollout, telemetry
  render/            Three.js scene, terrain/water/river-bank/town/airfield/glider/cloud/sky
                     meshes, and the procedural aerotow tug
  ui/                HUD instruments and menu/pause/summary wiring
  input/             keyboard state
  audio/             procedural WebAudio soundscape
docs/                player screenshots and these implementation notes
test/                aero, flight, weather, streaming, lake, river, town, airfield,
                     mountain, aerotow, and landing-rollout tests
```

## Tests

The headless suite exercises the model rather than the DOM:

- Aerodynamics: lift curve, drag polar, symmetry, stall behavior.
- Flight: trimmed glide in still air (102 km/h, L/D ≈ 37.5, sink ≈ 0.75 m/s),
  roll rate, stall and recovery, winch launch profile, and ridge lift.
- Weather: a differential test that drops the same glider through a thermal
  core and through still air, then compares the height lost.
- Thermals: the differential lift test, a broad flat-topped core profile, fixed
  columns under their cloud markers, the bearing pointing from the glider to
  the core, and the HUD's inside/core contract.
- Streaming: far-field terrain sampling, bilinear grid consistency, thermal
  grid determinism across rebuilds, home-thermal retention, and lift far from
  the field.
- Lakes: deterministic generation, airfield exclusion, sensible landmark
  density, shoreline containment, water-aware thermals, and ditching rather
  than crashing.
- Rivers: deterministic hand-placed courses, terrain-following profiles with an
  overall descent, carved beds, water-level queries, town clearance, and
  ditching on a stream.
- Landings: touchdown enters a rollout rather than ending immediately, wheel
  braking shortens the roll, rudder steering turns it, it cannot bounce back
  into the air, a crabbed touchdown cannot gain speed, air time freezes at
  touchdown, and it settles into the landed state.
- Towns: deterministic layout and names, varied street grids and outlines,
  airfield exclusion, the fixed home town and its tower, dry workable plots,
  roof queries, believable density, and a fatal roof strike.
- Airfields: deterministic streaming, sane counts and lengths, dry graded
  profiles, the near-terrain cut-out under every runway, home-plus-nearest
  ordering, two nearest-field bearings, inside-the-pad queries, wind-chosen
  runway ends, satellite winch and air starts, home-only aerotow, and a
  guaranteed thermal at every strip.
- Mountains: determinism, the six-kilometre keep-out, finite hand-placed ridges,
  alpine peaks alongside ordinary foothills, plausible height bounds, and
  snow-line summits.
- Aerotow: runway setup and rope length, a hands-off climb to 1,200 m in a
  controlled turn, stability in the standard breeze, manual release and tug
  departure, and determinism.

```bash
npm test
```

Expected: **81 passing tests**.

## Deployment

`npm run build` emits a self-contained static site in `dist/`. Serve that
directory from any static host (GitHub Pages, Netlify, Cloudflare Pages, S3, or
`npm run preview`).

If the site is hosted under a subpath, set Vite's base path at build time:

```bash
npm run build -- --base=/gludor/
```

## Technical limitations

- The flight model is "study-lite": plausible handling and energy behavior, not
  a validated engineering simulation.
- Lakes are flat surfaces; rivers follow a sloping profile. At far distances the
  400 m terrain tier only approximates small basins, so a distant lake or river
  can look simpler than it does up close.
- Town buildings sit on the existing ground instead of flattening it. Walls are
  sunk into the plot to hide slopes, but a very steep site can still show a
  small step at a building's uphill edge. Town airfield pads are graded
  separately.
- Weather is procedural and seeded: the same seed and settings always produce
  the same terrain, thermals, and gust sequence. There is no live forecast or
  dynamic task setting.
- Desktop keyboard and mouse are the supported inputs. Mobile touch is out of
  scope for V1.
- The single JavaScript bundle is roughly 700 kB (about 193 kB gzipped), mostly
  Three.js.
