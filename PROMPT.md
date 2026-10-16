# The redesign prompt

This is the brief this update was built from. Reuse it to extend the maps, or give it to another AI coding
tool together with this repository.

---

**Redo the maps of COLD SECTOR (a browser tactical 5v5 shooter: Node/TypeScript server, Three.js client, maps
as JSON built from prefabs in `shared/src/level/`) so the game is set in Afghanistan, with more detailed
buildings and vehicles and two map options.**

**Setting and look**
- Rural and small-town Afghanistan: dry valleys, mountains on the horizon, dust and warm light.
- Buildings are mud brick (*khesht*) and rammed earth with flat earth roofs. Detail them: a darker plinth, timber
  ceiling beams whose ends poke through the walls, wooden lintels, painted wooden doors (blue or green), shutters
  and iron window bars, wooden roof spouts with rain streaks, rounded parapets, brick domes, and roof clutter
  (water tanks, satellite dishes, firewood, laundry lines, antennas).
- Landmarks: a walled *qala* (fort) with round towers and crenellations, a caravanserai behind an *iwan* gate, a
  covered bazaar of container shops and mud stalls, a tea house (*chaikhana*), a fuel station and truck stop, a
  two-storey hotel with an outside stair and balcony, a district centre behind HESCO barriers, a tiled minaret
  monument on a roundabout.
- Vehicles, much more detailed than plain boxes: real wheel arches, rims and wheel nuts, glass, mirrors, lights,
  bumpers, door seams and cargo. Build Toyota Hilux pickups, technicals (a roll bar and a pedestal machine gun),
  Corolla taxis (yellow with a white top), painted jingle trucks (decorated panels, a crown over the cab, chains of
  bells), a fuel tanker, motorbikes, and wrecks: a burnt BTR on its rims and a rusting T-55 with a thrown track.
- Props: charpoys (rope beds), tandoors, wells, hand carts, hay, sacks, jerrycans, drums, tyre stacks, carpets,
  bunting, power lines, poplar, mulberry and apricot trees, boulders.
- Close the map with cliffs of jumbled boulders and big mountains behind them (visual terrain).
- Keep everything original: fictional place names, no real people, no flags or insignia.

**Two maps**
1. *Qalat Village*: a mountain village. Attackers come up a dry wadi past a T-55 wreck; defenders hold the
   malik's compound. A = the qala (with a breachable patched wall); B = the caravanserai (domed rooms with a
   climbable roof). Mid is a bazaar lane and a village square with a tea house.
2. *Sarai Bazaar*: a market town on a highway. Attackers spawn on the highway among burnt-out vehicles;
   defenders hold the district centre. A = the truck stop and fuel station; B = the hotel courtyard and ground
   floor, with stairs to a balcony. Mid is a covered bazaar street and a roundabout; the flanks are a carpet
   market and a residential block.

**Gameplay requirements (both maps)**
- About 120 × 125 m of play space. Attack spawn south, defend spawn north, two bomb sites with three or more
  ways into each, buy zones, about 30 callouts, 6 defender cameras, soft (breakable or reinforceable) walls inside
  buildings, and at least one breachable wall at a site.
- Bot data: `test_routes` from the attack side into each site, defender rotation routes, and
  `practice_positions`. Add a `modes.duel` layout: site A only, one spawn per side, and a player-clip wall closing
  the other half.
- Every room must be reachable: no prop blocking a doorway, no awning pole in a door. Verify spawns → sites and
  every route on the navmesh.
- Collision must not depend on the geometry flag: the server build and the asset build must produce identical
  colliders.

**Integration**
- Add the new pieces as prefabs (`shared/src/level/afghan.ts`) and new procedural materials in
  `data/materials.json`. No external downloads.
- Make the village the default map. Point the public servers at a rotation of both maps. Show map names, not
  keys, in the map menus, and add map cards on the Play page.
- Add an in-game briefing on the loading screen: map name, region, description, each side's task, sites A and B.
- Document everything (README section and a tour with screenshots). Ship the map generators and a map checker.
  Package the result as a zip.

**Follow-up (update 2)**
- Remove the preparation phase for the attacking side when a player is attacking bots: the defending bots
  should already be set up (in position, walls reinforced) when the round goes live.
- Redo how the players look: realistic and fitting the location. That means real faces with varied skin tones
  and beards, and two factions dressed for Afghanistan (one in arid multicam, helmets and plate carriers; one
  in olive camo, pakol caps and chest rigs). The first-person arms should match.
