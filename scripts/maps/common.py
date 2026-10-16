"""Shared helpers for writing COLD SECTOR map JSON (Afghanistan maps)."""
import json

class Map:
    def __init__(self):
        self.pieces = []
        self.lights = 0

    def add(self, **p):
        self.pieces.append(p)
        return p

    # ---- ground and boundary
    def floor(self, x0, y0, x1, y1, mat="dust", z=0.0, t=0.5, decal=False):
        p = dict(type="floor", min=[x0, y0], max=[x1, y1], z=z, thickness=t, mat=mat)
        if decal:
            p.update(z=0.02, thickness=0.06, occlude=False, collide=False)
        self.pieces.append(p)

    def cliffs(self, x0, y0, x1, y1, height=9.0, seed=1):
        # counter-clockwise so each segment's right-hand side faces out of the map
        self.add(type="rock_wall", p0=[x0, y0], p1=[x1, y0], height=height, seed=seed)
        self.add(type="rock_wall", p0=[x1, y0], p1=[x1, y1], height=height, seed=seed + 1)
        self.add(type="rock_wall", p0=[x1, y1], p1=[x0, y1], height=height, seed=seed + 2)
        self.add(type="rock_wall", p0=[x0, y1], p1=[x0, y0], height=height, seed=seed + 3)

    # ---- buildings
    def house(self, x0, y0, x1, y1, h=3.0, s=None, n=None, e=None, w=None, light=True, kelvin=2900, **kw):
        ops = {}
        for side, lst in (("s", s), ("n", n), ("e", e), ("w", w)):
            if not lst:
                continue
            key = "x" if side in "sn" else "y"
            out = []
            for o in lst:
                if isinstance(o, dict):
                    out.append(o)
                    continue
                kind, at = o[0], o[1]
                width = o[2] if len(o) > 2 else (1.2 if kind == "d" else 1.1)
                if kind == "d":
                    out.append({key: at, "width": width, "bottom": 0.0, "top": 2.15})
                elif kind == "D":      # wide doorway, no leaf
                    out.append({key: at, "width": width, "bottom": 0.0, "top": 2.4, "door": False})
                else:
                    out.append({key: at, "width": width, "bottom": 1.0, "top": 2.0})
            ops[side] = out
        p = dict(type="mud_house", min=[x0, y0], max=[x1, y1], height=h, openings=ops, **kw)
        self.pieces.append(p)
        if light:
            self.bulb((x0 + x1) / 2, (y0 + y1) / 2, h - 0.25, kelvin=kelvin)
        return p

    def soft(self, p0, p1, h=3.0, name="inner", doors=(), reinforce=False, breach=False, mat="mud_wall_light", t=0.2):
        ops = [{"at": a, "width": 1.0} for a in doors]
        self.add(type="wall", soft=True, name=name, p0=p0, p1=p1, height=h, thickness=t, mat=mat, openings=ops,
                 frame_mat="wood_dark", reinforce=reinforce, breach=breach)

    def bulb(self, x, y, z, kelvin=2900, intensity=6, rng=8, shadows=False):
        self.lights += 1
        self.add(type="light", pos=[x, y, z], kind="point", fixture="bulb", kelvin=kelvin, intensity=intensity, range=rng, shadows=shadows)

    def lamp(self, x, y, z, kelvin=3200, intensity=14, rng=11):
        self.lights += 1
        self.add(type="light", pos=[x, y, z], kind="point", fixture="bulb", kelvin=kelvin, intensity=intensity, range=rng, shadows=True)

    # ---- gameplay
    def spawns(self, team, pts, heading):
        for (x, y) in pts:
            self.add(type="spawn", team=team, pos=[x, y, 0.1], heading=heading)

    def callout(self, name, x0, y0, x1, y1):
        self.add(type="callout", name=name, min=[x0, y0], max=[x1, y1])

    def camera(self, name, x, y, z, heading, pitch=-15):
        self.add(type="camera", name=name, pos=[x, y, z], heading=heading, pitch=pitch)

    def sign(self, text, x, y, z, heading, scale=0.4, color=(0.12, 0.1, 0.08, 1)):
        self.add(type="sign", text=text, pos=[x, y, z], heading=heading, scale=scale, color=list(color))


ENV_DUSK = {
    "hdri": "kloofendal_48d_partly_cloudy_puresky",
    "hdri_candidates": ["syferfontein_1d_clear_puresky", "kloppenheim_06_puresky", "industrial_sunset_puresky"],
    "sun_dir": [0.5, -0.36, 0.78], "sun_intensity": 4.1, "sun_color": [1.0, 0.87, 0.7], "sky_target": 0.9,
    "ground": [0.27, 0.21, 0.15], "sun_clamp": 12.0, "ibl_diffuse": 1.0, "ibl_specular": 0.9, "exposure": 1.0,
    "ambient_floor": [0.005, 0.0045, 0.004],
    "fog": {"density": 0.0045, "height_falloff": 0.05, "base_height": 0.0, "max_opacity": 0.55, "sun_scatter": 0.55},
    "post": {
        "bloom": {"intensity": 0.4, "threshold": 1.3, "knee": 0.6, "scatter": 0.7},
        "grading": {"saturation": 0.9, "contrast": 1.07, "temperature": 0.22, "tint": 0.02,
                    "lift": [0.006, 0.005, 0.004], "gamma": [1.0, 1.0, 1.0], "gain": [1.04, 1.0, 0.95]},
        "vignette": {"strength": 0.3, "start": 0.45},
        "auto_exposure": {"strength": 0.55, "min_ev": -1.0, "max_ev": 1.25, "reference": -1.6, "speed_up": 3.0, "speed_down": 1.1},
    },
}


def write(path, header, m, extra):
    data = dict(header)
    data["pieces"] = m.pieces
    data.update(extra)
    # pieces one per line, like the hand-written maps
    lines = ["{"]
    keys = list(data.keys())
    for i, k in enumerate(keys):
        comma = "," if i < len(keys) - 1 else ""
        if k == "pieces":
            lines.append(' "pieces": [')
            for j, p in enumerate(m.pieces):
                lines.append("  " + json.dumps(p, separators=(", ", ": ")) + ("," if j < len(m.pieces) - 1 else ""))
            lines.append(" ]" + comma)
        else:
            lines.append(f' "{k}": ' + json.dumps(data[k]) + comma)
    lines.append("}")
    open(path, "w").write("\n".join(lines) + "\n")
