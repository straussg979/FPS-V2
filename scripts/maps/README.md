# Map generators

`qalat.py` and `bazaar.py` write `data/maps/qalat.json` and `data/maps/bazaar.json`. `common.py` holds the
shared helpers (houses, soft walls, lights, spawns, callouts) and the environment. They only need Python 3.

    python scripts/maps/qalat.py data/maps/qalat.json
    python scripts/maps/bazaar.py data/maps/bazaar.json
    npx tsx scripts/maps/check.ts data/maps/qalat.json data/maps/bazaar.json --radar .

Coordinates are metres: x east, y north, z up. Headings are in degrees, counter-clockwise, and 0 faces +y.
`check.ts` must report OK before you ship a change: it finds blocked doorways, broken bot routes and rooms you
can't reach.
