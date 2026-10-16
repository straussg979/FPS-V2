"""SARAI BAZAAR: a market town on the highway.
Attackers come off the highway (south); defenders hold the district centre (north).
A = the truck stop and fuel station in the west, B = the two-storey hotel and its courtyard in the east."""
import sys
from common import Map, ENV_DUSK, write

m = Map()
X0, Y0, X1, Y1 = -59, -63, 59, 63

# ------------------------------------------------------------------ ground, cliffs, mountains
m.floor(-63, -67, 63, 67, "dust")
m.add(type="terrain", inner=[[-63, -67], [63, 67]], extent=640, step=10, start=4, ramp=260, height=120, seed=41, mat="rock")
m.cliffs(X0, Y0, X1, Y1, height=8.5, seed=61)
m.floor(-57.5, -61, 57.5, -46.5, "asphalt", decal=True)                 # the highway
for (x0, y0, x1, y1, mat) in [(-6, -45, 6, 6, "gravel"), (-50.5, -45, -42, 0, "dirt"), (42, -45, 50.5, 2, "dirt"),
                              (-43.5, -38, -6, -35, "dirt"), (6, -38, 43.5, -35, "dirt"), (-42, -21.5, -6, -18, "dirt"),
                              (6, -21.5, 42, -18, "dirt"), (-27.5, -35, -24.5, -4, "dirt"), (24.5, -35, 27.5, -4, "dirt"),
                              (-50.5, -4, -6, 0, "dirt"), (6, -4, 50.5, 0, "dirt"), (-21.5, 0, 19.5, 31.5, "asphalt"),
                              (-56.8, 0.5, -22.5, 29.5, "concrete_floor"), (-15, 32.8, 17, 45.5, "gravel")]:
    m.floor(x0, y0, x1, y1, mat, decal=True)
for x in range(-56, 57, 4):
    m.add(type="paint_line", p0=[x, -54], p1=[x + 2, -54], width=0.15, z=0.02)

# ------------------------------------------------------------------ the highway (attackers)
m.add(type="vehicle", kind="tanker", base=[-31, -53, 0.0], heading=97, wreck=True)
m.add(type="vehicle", kind="jingle", base=[24, -51.5, 0.0], heading=-84, seed=31, load="tarp")
m.add(type="vehicle", kind="hilux", base=[41, -56.5, 0.0], heading=-60, wreck=True)
m.add(type="vehicle", kind="taxi", base=[-46, -57, 0.0], heading=120, wreck=True)
m.add(type="vehicle", kind="sedan", base=[10, -58.5, 0.0], heading=-95, mat="vehicle_white", mat2="vehicle_white", taxi=False)
for (x0, x1) in [(-52, -40), (-20, -9), (12, 20), (33, 50)]:
    m.add(type="jersey", p0=[x0, -50.5], p1=[x1, -50.5])
m.add(type="gabion", p0=[-6, -60.5], p1=[-6, -57.5], layers=1)
m.add(type="gabion", p0=[6, -60.5], p1=[6, -57.5], layers=1)
m.add(type="rocks", base=[-55, -60, 0], size=1.4, count=3, seed=2)
m.add(type="rocks", base=[55, -48, 0], size=1.5, count=3, seed=3)
m.add(type="power_line", points=[[-56, -45.9], [-30, -45.9], [-7, -45.9], [7, -48.9], [30, -45.9], [56, -45.9]], height=7.5)
m.spawns("attack", [(-4, -56.5), (-2, -57.3), (0, -58.1), (2, -57.3), (4, -56.5)], 0)
m.add(type="zone", name="Attack buy zone", kind="buyzone", team="attack", min=[-57, -61, -1], max=[57, -46, 5])

# ------------------------------------------------------------------ the frontage along the highway
m.house(-56.8, -44.5, -50.5, -36, h=3.2, e=[("d", -40)], s=[("w", -53.6)], seed=101)
m.house(-43.5, -44.5, -7.5, -38, h=3.4, n=[("d", -38), ("d", -26), ("d", -14), ("w", -32), ("w", -20)],
        roof_items=[{"kind": "tank", "x": -40, "y": -41}, {"kind": "dish", "x": -18, "y": -40}, {"kind": "antenna", "x": -28, "y": -42}],
        seed=102, light=False, mat="plaster_white", mat_in="plaster", floor_mat="concrete_floor")
m.soft([-32, -44.05], [-32, -38.45], h=3.4, name="front_w", doors=[2.8])
m.soft([-20, -44.05], [-20, -38.45], h=3.4, name="front_w", doors=[2.8])
for x in (-38, -26, -13.8):
    m.bulb(x, -41.2, 3.15)
for (x, goods, style, mat) in [(-39, "tires", "container", "container_red"), (-32.5, "cans", "container", "container_blue"),
                               (-26, "cloth", "container", "container_green"), (-19.5, "fruit", "mud", None), (-15.3, "sacks", "mud", None),
                               (-11.1, "rugs", "mud", None)]:
    kw = dict(type="shop", style=style, base=[x, -45.75 if style == "container" else -46.0, 0.02], heading=0, goods=goods, awning=1.4)
    if mat:
        kw["mat"] = mat
    m.add(**kw)
# the bazaar gate
for x in (-6.9, 6.9):
    m.add(type="box", base=[x, -41, 0], size=[1.5, 1.5, 6.2], mat="mud_brick")
    m.add(type="box", base=[x, -41, 6.2], size=[1.8, 1.8, 0.3], mat="mud_wall")
m.add(type="box", base=[0, -41, 5.0], size=[12.3, 1.1, 1.2], mat="mud_brick")
m.add(type="box", base=[0, -41, 6.2], size=[14.6, 1.4, 0.25], mat="mud_wall")
m.sign("SARAI BAZAAR", 0, -41.6, 5.6, 0, scale=0.55, color=(0.92, 0.84, 0.6, 1))
m.sign("SARAI BAZAAR", 0, -40.4, 5.6, 180, scale=0.55, color=(0.92, 0.84, 0.6, 1))
m.house(7.5, -44.5, 43.5, -38, h=3.4, n=[("d", 12), ("d", 26), ("d", 38), ("w", 20), ("w", 32)],
        roof_items=[{"kind": "tank", "x": 40, "y": -41}, {"kind": "laundry", "x": 18, "y": -41, "length": 5}],
        seed=103, light=False, mat="plaster_white", mat_in="plaster", floor_mat="concrete_floor")
m.soft([20, -44.05], [20, -38.45], h=3.4, name="front_e", doors=[2.8])
m.soft([32, -44.05], [32, -38.45], h=3.4, name="front_e", doors=[2.8])
for x in (14, 26, 38):
    m.bulb(x, -41.2, 3.15)
for (x, goods, style, mat) in [(11.1, "fruit", "mud", None), (15.3, "cans", "mud", None), (19.5, "tires", "mud", None),
                               (26, "rugs", "container", "corrugated_rust"), (32.5, "fruit", "container", "container_green"),
                               (39, "cloth", "container", "container_red")]:
    kw = dict(type="shop", style=style, base=[x, -45.75 if style == "container" else -46.0, 0.02], heading=0, goods=goods, awning=1.4)
    if mat:
        kw["mat"] = mat
    m.add(**kw)
m.house(50.5, -44.5, 56.8, -36, h=3.2, w=[("d", -40)], s=[("w", 53.6)], seed=104)
m.sign("CHAI", -15.3, -47.4, 3.1, 0, scale=0.3, color=(0.9, 0.82, 0.6, 1))

# ------------------------------------------------------------------ west: A long and the carpet market
m.house(-56.8, -33, -50.5, -20, e=[("d", -26.5), ("w", -30)], seed=105, roof_items=[{"kind": "wood", "x": -53.5, "y": -24}])
m.house(-56.8, -16, -50.5, -4.5, e=[("d", -10), ("w", -13.5)], seed=106)
m.add(type="container", base=[-46.3, -29, 0.02], heading=0, mat="container_green")
m.add(type="container", base=[-46.3, -29, 2.62], heading=4, mat="container_red")
m.add(type="prop", kind="drums", base=[-44.3, -12, 0.02], heading=0, count=5)
m.add(type="prop", kind="tires", base=[-49.2, -18, 0.02], count=7)
m.add(type="prop", kind="tires", base=[-48.4, -17.2, 0.02], count=5)

m.house(-42, -35, -27.5, -21.5, h=3.2, n=[("d", -38)], e=[("d", -25)], s=[("d", -32)], w=[("d", -28)],
        roof_items=[{"kind": "laundry", "x": -35, "y": -28, "length": 6}], seed=107, light=False)
m.soft([-35, -34.55], [-35, -21.95], h=3.2, name="carpet_1", doors=[6.3])
m.bulb(-38.6, -28.2, 2.95)
m.bulb(-31.2, -28.2, 2.95)
m.house(-24.5, -35, -8.6, -21.5, h=3.2, w=[("d", -31)], s=[("d", -14)], n=[("d", -20)], seed=108, light=False,
        floor_mat="carpet_red", domes=[{"x": -20, "y": -28.25, "r": 2.2}])
m.soft([-16, -34.55], [-16, -21.95], h=3.2, name="carpet_2", doors=[4.5])
m.bulb(-20, -28.2, 2.95)
m.bulb(-12.2, -28.2, 2.95)
m.house(-42, -18, -27.5, -4, h=3.0, n=[("d", -33)], e=[("d", -11)], w=[("d", -14), ("w", -8)], s=[("d", -38)], seed=109, light=False)
m.soft([-34, -17.55], [-34, -4.45], name="carpet_3", doors=[3.5])
m.bulb(-38, -11, 2.75)
m.bulb(-30.8, -11, 2.75)
m.house(-24.5, -18, -8.6, -4, h=3.2, w=[("d", -9)], n=[("d", -16)], s=[("d", -20)], seed=110, light=False,
        roof_items=[{"kind": "tank", "x": -12, "y": -15}])
m.soft([-17, -17.55], [-17, -4.45], h=3.2, name="carpet_4", doors=[9.5])
m.bulb(-20.8, -11, 2.95)
m.bulb(-12.8, -11, 2.95)
for (x, y, hd) in [(-33, -20.2, 0), (-18, -19.8, 180)]:
    m.add(type="prop", kind="cart", base=[x, y, 0.02], heading=hd + 90)
m.add(type="prop", kind="sacks", base=[-25.3, -33, 0.02], heading=90, count=4)
m.add(type="awning", min=[-27.4, -33], max=[-24.6, -24], height=3.0, mat="carpet_blue", spacing=3.0, occlude=False)
m.add(type="bunting", p0=[-42, -19.75], p1=[-8.6, -19.75], z=3.8, sag=0.4, seed=14)

# ------------------------------------------------------------------ the covered bazaar street
for (y, goods, mat) in [(-32.5, "rugs", "container_red"), (-26, "cloth", "container_blue"), (-14.9, "cans", "container_green"),
                        (-7.5, "fruit", "corrugated_rust")]:
    m.add(type="shop", style="container", base=[-7.28, y, 0.02], heading=90, goods=goods, mat=mat, awning=1.2)
for (y, goods, mat) in [(-32.5, "fruit", "container_green"), (-26, "tires", "container_red"), (-14.9, "rugs", "corrugated_rust"),
                        (-7.5, "sacks", "container_blue")]:
    m.add(type="shop", style="container", base=[7.28, y, 0.02], heading=-90, goods=goods, mat=mat, awning=1.2)
for (y0, y1, mat) in [(-36, -29, "tarp_blue"), (-29, -22.5, "awning_stripe"), (-18, -11, "carpet_red"), (-11, -4, "tarp_blue")]:
    m.add(type="awning", min=[-4.6, y0], max=[4.6, y1], height=3.6, mat=mat, spacing=7.0, occlude=True)
for y in (-33, -25.5, -15.5, -8):
    m.lamp(0, y, 3.3, kelvin=2900, intensity=7, rng=8)
m.add(type="prop", kind="cart", base=[-2, -30.5, 0.02], heading=10)
m.add(type="prop", kind="cart", base=[2.2, -12, 0.02], heading=-170)
m.add(type="vehicle", kind="motorbike", base=[2.6, -24, 0.0], heading=-20, mat="jingle_red")
m.add(type="vehicle", kind="motorbike", base=[-2.8, -18.5, 0.0], heading=160, mat="jingle_blue", lean=-9)
m.add(type="vehicle", kind="hilux", base=[-1.2, -1.5, 0.0], heading=12, mat="vehicle_white", cargo="sacks")
m.add(type="prop", kind="sacks", base=[4.4, -39.6, 0.02], heading=0, count=6)
m.add(type="prop", kind="jerrycans", base=[-3.8, -10, 0.02], heading=90, count=6)

# ------------------------------------------------------------------ east: residential block and B long
m.house(8.6, -35, 24.5, -21.5, h=3.2, n=[("d", 12)], w=[("d", -31)], e=[("d", -25)], s=[("d", 18)], seed=111, light=False,
        roof_items=[{"kind": "dish", "x": 20, "y": -24}])
m.soft([16, -34.55], [16, -21.95], h=3.2, name="res_1", doors=[4.5])
m.bulb(12.3, -28.2, 2.95)
m.bulb(20.3, -28.2, 2.95)
m.house(27.5, -35, 42, -21.5, h=3.2, w=[("d", -28)], e=[("d", -31)], n=[("d", 38)], parapet=0.35, seed=112, light=False,
        domes=[{"x": 31.1, "y": -28.25, "r": 2.0}, {"x": 38.4, "y": -28.25, "r": 2.0}])
m.soft([34.75, -34.55], [34.75, -21.95], h=3.2, name="res_2", doors=[3.0])
m.bulb(31.1, -28.2, 2.95)
m.bulb(38.4, -28.2, 2.95)
m.house(8.6, -18, 24.5, -4, h=3.0, w=[("d", -9)], e=[("d", -12)], n=[("d", 20)], s=[("d", 14)], seed=113, light=False,
        roof_items=[{"kind": "laundry", "x": 16.5, "y": -11, "length": 5}])
m.soft([16.5, -17.55], [16.5, -4.45], name="res_3", doors=[3.5])
m.bulb(12.5, -11, 2.75)
m.bulb(20.5, -11, 2.75)
m.house(27.5, -18, 42, -4, h=3.0, w=[("d", -15)], e=[("d", -9)], n=[("d", 31)], seed=114, light=False,
        roof_items=[{"kind": "tank", "x": 39, "y": -15}])
m.soft([35, -17.55], [35, -4.45], name="res_4", doors=[9.0])
m.bulb(31.2, -11, 2.75)
m.bulb(38.8, -11, 2.75)
m.add(type="tree", kind="mulberry", base=[26, -27.5, 0], height=7)
m.add(type="prop", kind="charpoy", base=[33, -19.8, 0.02], heading=90)
m.add(type="prop", kind="tandoor", base=[14, -19.7, 0.02])
m.house(50.5, -33, 56.8, -20, w=[("d", -26), ("w", -30)], seed=115)
m.house(50.5, -16, 56.8, -4.5, w=[("d", -10.5)], seed=116, roof_items=[{"kind": "tank", "x": 53.5, "y": -8}])
m.add(type="vehicle", kind="jingle", base=[47, -20, 0.0], heading=2, seed=41, load="sacks")
m.add(type="prop", kind="drums", base=[44.2, -33, 0.02], heading=0, count=4)
m.add(type="rocks", base=[45, -6.5, 0], size=0.8, count=2, seed=33)

# ------------------------------------------------------------------ A: the truck stop
AW = dict(height=3.4, thickness=0.6, mat="mud_wall")
m.add(type="qala_wall", p0=[-57.6, 0], p1=[-22, 0], seed=120, damage=2, **AW,
      openings=[{"at": 11.6, "width": 5.0, "top": 3.0, "gate": True, "mat": "metal_blue"}, {"at": 31.6, "width": 1.8, "top": 2.3, "gate": True}])
m.add(type="qala_wall", p0=[-22, 0], p1=[-22, 30], seed=121, **AW, openings=[{"at": 15, "width": 2.2, "top": 2.4, "gate": True}])
m.add(type="qala_wall", p0=[-22, 30], p1=[-57.6, 30], seed=122, **AW, openings=[{"at": 14, "width": 4.0, "top": 3.0, "gate": True, "mat": "metal_green"}])
m.add(type="canopy", min=[-46, 8], max=[-32, 16], height=5.2, spacing=7.0, col_mat="steel_painted", roof_mat="corrugated_grey", overhang=0.8)
m.add(type="box", base=[-39, 12, 0], size=[11, 1.4, 0.18], mat="concrete_barrier")
for x in (-43.5, -39, -34.5):
    m.add(type="prop", kind="fuel_pump", base=[x, 12, 0.18], heading=0, mat="jingle_red")
m.lamp(-42.5, 10, 5.0, kelvin=4500, intensity=14, rng=10)
m.lamp(-35.5, 14, 5.0, kelvin=4500, intensity=14, rng=10)
m.sign("PETROL", -39, 7.1, 5.6, 0, scale=0.5, color=(0.9, 0.2, 0.12, 1))
m.house(-56.8, 4, -48, 16, h=3.8, e=[("D", 10, 3.4), ("w", 14.2)], roof_mat="corrugated_rust", parapet=0.3, seed=123, light=False,
        mat="mud_brick", beams=False, beam_ends=False)
m.lamp(-52.4, 10, 3.5, kelvin=4200, intensity=10, rng=9)
m.add(type="vehicle", kind="hilux", base=[-52.6, 10, 0.0], heading=0, mat="vehicle_tan", cargo="none")
m.add(type="furniture", kind="workbench", base=[-56, 13.5, 0.02], heading=90, length=2.4)
m.add(type="prop", kind="tires", base=[-55.4, 5.2, 0.02], count=6)
m.add(type="prop", kind="drums", base=[-50.2, 5.2, 0.02], heading=0, count=3)
m.add(type="building", min=[-30, 20], max=[-23, 27], height=3.0, wall=0.25, mat="plaster_white", mat_in="plaster", floor_mat="floor_tiles",
      roof_mat="roof_membrane", parapet=0.3, frame_mat="steel_painted",
      openings={"s": [{"x": -26.5, "width": 1.6, "bottom": 0.0, "top": 2.2}], "w": [{"y": 23.5, "width": 1.6, "bottom": 1.0, "top": 2.1}],
                "e": [{"y": 24.5, "width": 1.2, "bottom": 1.0, "top": 2.1}]})
m.bulb(-26.5, 23.5, 2.75, kelvin=4200)
m.add(type="furniture", kind="desk", base=[-26.5, 25.8, 0.02], heading=180)
m.add(type="vehicle", kind="jingle", base=[-50, 23.5, 0.0], heading=-90, seed=51, load="tarp")
m.add(type="vehicle", kind="tanker", base=[-36, 25, 0.0], heading=90, mat="jingle_green")
m.add(type="prop", kind="drums", base=[-29.6, 3.5, 0.02], heading=0, count=6)
m.add(type="prop", kind="tires", base=[-24.2, 3, 0.02], count=6)
m.add(type="prop", kind="tires", base=[-24.6, 4.1, 0.02], count=4)
m.add(type="crate_stack", base=[-26, 14, 0.02], size=1.1, layout=[[0, 0, 0], [1, 0, 0], [0, 0, 1]], seed=7)
m.add(type="prop", kind="jerrycans", base=[-44, 3.5, 0.02], heading=0, count=8)
m.add(type="sandbags", p0=[-47.5, 19], p1=[-43.5, 19], layers=5, seed=11)
m.add(type="zone", name="A", kind="bombsite", min=[-56.8, 0.5, -0.5], max=[-22.5, 29.5, 5.5])
m.sign("A", -48.5, -0.42, 2.9, 0, scale=1.3, color=(0.6, 0.1, 0.06, 1))

# ------------------------------------------------------------------ the roundabout
m.add(type="minar", base=[0, 16, 0], height=10)
m.house(-21.6, 2, -12, 12, h=3.2, e=[("D", 7, 1.8), ("w", 4), ("w", 10)], n=[("d", -17)], s=[("w", -17)], seed=124, light=False,
        floor_mat="carpet_red")
m.lamp(-16.8, 7, 2.95, kelvin=2700, intensity=9, rng=8)
m.add(type="prop", kind="samovar", base=[-20.8, 7, 0.02], heading=90)
m.add(type="prop", kind="bench", base=[-16.8, 3, 0.02], heading=0, length=3)
m.add(type="prop", kind="bench", base=[-20.2, 10.3, 0.02], heading=90, length=2.2)
m.add(type="awning", min=[-11.8, 2.6], max=[-8.4, 11.4], height=2.9, mat="awning_stripe", spacing=9.0)
m.sign("CHAI KHANA", -11.85, 7, 3.15, 90, scale=0.32, color=(0.9, 0.82, 0.6, 1))
m.house(12, 2, 19.6, 11, h=3.0, w=[("D", 6.5, 1.6), ("w", 3.5)], n=[("d", 16)], seed=125, mat="plaster_white", mat_in="plaster",
        floor_mat="floor_tiles")
m.sign("DAWAKHANA", 11.85, 6.5, 3.0, -90, scale=0.28, color=(0.15, 0.5, 0.25, 1))
m.add(type="vehicle", kind="taxi", base=[-8, 21, 0.0], heading=-35)
m.add(type="vehicle", kind="taxi", base=[9, 23.5, 0.0], heading=40)
m.add(type="vehicle", kind="jingle", base=[-10.5, 27.5, 0.0], heading=82, seed=61, load="empty")
m.add(type="vehicle", kind="hilux", base=[10.5, 12, 0.0], heading=-170, mat="vehicle_white", cargo="cans")
m.add(type="vehicle", kind="motorbike", base=[-6, 4, 0.0], heading=30, mat="jingle_green")
m.add(type="jersey", p0=[-4, 29], p1=[4, 29])
m.add(type="power_line", points=[[-21, 1], [-21, 31], [19, 31], [19, 1]], height=7.5)

# ------------------------------------------------------------------ B: the hotel
HW = dict(height=3.2, thickness=0.5, mat="plaster_white", mat_in="plaster_white")
m.add(type="qala_wall", p0=[20, 2], p1=[57.6, 2], seed=130, **HW, footing=False,
      openings=[{"at": 26, "width": 4.0, "top": 2.8, "gate": True, "mat": "metal_blue"}, {"at": 10, "width": 1.6, "top": 2.3, "gate": True}])
m.add(type="qala_wall", p0=[20, 32], p1=[20, 2], seed=131, **HW, footing=False, openings=[{"at": 10, "width": 2.0, "top": 2.4, "gate": True}])
m.add(type="qala_wall", p0=[57.6, 32], p1=[20, 32], seed=132, **HW, footing=False, openings=[{"at": 27.6, "width": 1.6, "top": 2.3, "gate": True}])
# ground floor
m.add(type="building", min=[26, 18], max=[50, 30], height=3.3, wall=0.3, roof_thickness=0.3, mat="plaster_white", mat_in="plaster",
      floor_mat="floor_tiles", roof_mat="floor_tiles", ceiling_mat="plaster", parapet=0.0, frame_mat="wood_dark",
      openings={"s": [{"x": 38, "width": 2.2, "bottom": 0.0, "top": 2.5}, {"x": 30, "width": 1.6, "bottom": 1.0, "top": 2.3},
                      {"x": 34, "width": 1.6, "bottom": 1.0, "top": 2.3}, {"x": 42, "width": 1.6, "bottom": 1.0, "top": 2.3},
                      {"x": 46, "width": 1.6, "bottom": 1.0, "top": 2.3}],
                "e": [{"y": 24, "width": 1.2, "bottom": 0.0, "top": 2.2}], "w": [{"y": 24, "width": 1.2, "bottom": 0.0, "top": 2.2}],
                "n": [{"x": 44, "width": 1.2, "bottom": 0.0, "top": 2.2}, {"x": 32, "width": 1.6, "bottom": 1.0, "top": 2.3}]})
m.soft([34, 18.3], [34, 29.7], h=3.3, name="hotel_lobby", doors=[8.0], reinforce=True)
m.soft([42, 18.3], [42, 29.7], h=3.3, name="hotel_lobby", doors=[8.0], reinforce=True, breach=True)
for x in (30, 38, 46):
    m.add(type="light", pos=[x, 24, 3.05], kind="point", fixture="panel", kelvin=3800, intensity=9, range=10, shadows=x == 38)
m.add(type="furniture", kind="desk", base=[38, 27.8, 0.02], heading=180, length=2.6)
m.add(type="prop", kind="bench", base=[36, 21, 0.02], heading=90, length=2.0)
m.add(type="prop", kind="bench", base=[40, 21, 0.02], heading=90, length=2.0)
m.add(type="furniture", kind="cabinet", base=[27, 28.9, 0.02], heading=180)
m.add(type="furniture", kind="table", base=[30, 24, 0.02], heading=0)
m.add(type="furniture", kind="table", base=[46, 24, 0.02], heading=0)
m.add(type="crate_stack", base=[48, 28, 0.02], size=0.9, layout=[[0, 0, 0], [0, 0, 1]], seed=4)
# upper floor
m.add(type="building", min=[26, 18], max=[50, 30], z=3.6, height=3.0, wall=0.3, roof_thickness=0.3, mat="plaster_white", mat_in="plaster",
      floor_mat=None, roof_mat="roof_membrane", ceiling_mat="plaster", parapet=0.8, frame_mat="wood_dark",
      openings={"s": [{"x": 30, "width": 1.2, "bottom": 0.0, "top": 2.2}, {"x": 38, "width": 1.2, "bottom": 0.0, "top": 2.2},
                      {"x": 46, "width": 1.2, "bottom": 0.0, "top": 2.2}, {"x": 34, "width": 1.6, "bottom": 0.9, "top": 2.2},
                      {"x": 42, "width": 1.6, "bottom": 0.9, "top": 2.2}],
                "n": [{"x": 30, "width": 1.6, "bottom": 0.9, "top": 2.2}, {"x": 38, "width": 1.6, "bottom": 0.9, "top": 2.2},
                      {"x": 46, "width": 1.6, "bottom": 0.9, "top": 2.2}],
                "e": [{"y": 24, "width": 1.4, "bottom": 0.9, "top": 2.2}], "w": [{"y": 24, "width": 1.4, "bottom": 0.9, "top": 2.2}]})
m.add(type="wall", soft=True, name="hotel_room", p0=[34, 18.3], p1=[34, 29.7], z=3.6, height=3.0, thickness=0.15, mat="plaster",
      openings=[{"at": 8.5, "width": 1.0}])
m.add(type="wall", soft=True, name="hotel_room", p0=[42, 18.3], p1=[42, 29.7], z=3.6, height=3.0, thickness=0.15, mat="plaster",
      openings=[{"at": 8.5, "width": 1.0}])
for x in (30, 38, 46):
    m.bulb(x, 24, 6.35, kelvin=3000, intensity=6)
for (x, y) in [(29, 28.5), (45, 28.5), (37, 28.5)]:
    m.add(type="furniture", kind="bunk", base=[x, y, 3.62], heading=90)
m.add(type="catwalk", p0=[26, 17], p1=[50, 17], z=3.6, width=2.0, mat="wood_planks", leg_mat="wood_old", rails=False)
m.add(type="railing", p0=[26, 16.05], p1=[46.7, 16.05], z=3.6, mat="wood_old")
m.add(type="railing", p0=[48.3, 16.05], p1=[50, 16.05], z=3.6, mat="wood_old")
m.add(type="railing", p0=[26.05, 16.05], p1=[26.05, 17.95], z=3.6, mat="wood_old")
m.add(type="railing", p0=[49.95, 16.05], p1=[49.95, 17.95], z=3.6, mat="wood_old")
m.add(type="stairs", base=[47.5, 12.4, 0], heading=0, steps=12, rise=3.6, run=0.3, width=1.4, mat="concrete_floor", rails=True,
      rail_mat="wood_old")
m.sign("SARAI HOTEL", 38, 17.85, 7.3, 0, scale=0.6, color=(0.75, 0.12, 0.08, 1))
# courtyard
m.add(type="prop", kind="fountain", base=[37, 9.5, 0.02], radius=2.3)
m.add(type="vehicle", kind="hilux", base=[28.5, 9, 0.0], heading=80, mat="vehicle_white", bullbar=True, cargo="none")
m.add(type="vehicle", kind="sedan", base=[53.5, 11, 0.0], heading=5, mat="vehicle_white", mat2="vehicle_white", taxi=False)
for (p0, p1) in [([22, 15.5], [33, 15.5]), ([41, 5], [44, 5])]:
    m.add(type="qala_wall", p0=p0, p1=p1, height=0.9, thickness=0.7, mat="hedge", footing=False)
m.add(type="tree", kind="poplar", base=[22.5, 4.5, 0], height=10)
m.add(type="tree", kind="apricot", base=[52.5, 27, 0])
m.add(type="tree", kind="apricot", base=[23, 27.5, 0])
m.add(type="prop", kind="bench", base=[42, 13, 0.02], heading=0, length=2.2)
m.add(type="prop", kind="water_jars", base=[51.5, 4, 0.02], heading=0)
m.add(type="sandbags", p0=[53, 16], p1=[56.5, 16], layers=5, seed=17)
m.lamp(37, 9.5, 4.2, kelvin=3400, intensity=10, rng=12)
m.add(type="zone", name="B", kind="bombsite", min=[20.6, 2.6, -0.5], max=[51, 29.6, 3.4])
m.sign("B", 41.5, 1.58, 2.6, 0, scale=1.3, color=(0.6, 0.1, 0.06, 1))

# ------------------------------------------------------------------ CT: the district centre
G2 = dict(layers=2)
for (p0, p1) in [([-16, 32], [-1.2, 32]), ([3.2, 32], [18, 32]), ([-16, 32.5], [-16, 38.6]), ([-16, 41.8], [-16, 61.6]),
                 ([18, 32.5], [18, 38.6]), ([18, 41.8], [18, 61.6])]:
    m.add(type="gabion", p0=p0, p1=p1, **G2)
m.add(type="boom_gate", base=[3.4, 31.3, 0.02], heading=180, length=4.2, raised=True)
m.add(type="building", min=[-10, 46], max=[12, 58], height=3.4, wall=0.3, mat="plaster_tan", mat_in="plaster_green", floor_mat="lino_green",
      roof_mat="roof_membrane", parapet=0.5, frame_mat="steel_painted",
      openings={"s": [{"x": 1, "width": 1.8, "bottom": 0.0, "top": 2.3}, {"x": -7, "width": 1.5, "bottom": 1.0, "top": 2.2},
                      {"x": -3, "width": 1.5, "bottom": 1.0, "top": 2.2}, {"x": 5, "width": 1.5, "bottom": 1.0, "top": 2.2},
                      {"x": 9, "width": 1.5, "bottom": 1.0, "top": 2.2}],
                "w": [{"y": 52, "width": 1.3, "bottom": 0.0, "top": 2.2}], "e": [{"y": 52, "width": 1.3, "bottom": 0.0, "top": 2.2}],
                "n": [{"x": -5, "width": 1.5, "bottom": 1.0, "top": 2.2}, {"x": 7, "width": 1.5, "bottom": 1.0, "top": 2.2}]})
m.soft([-9.7, 51], [11.7, 51], h=3.4, name="office_hall", doors=[4.0, 10.7, 17.5])
m.soft([-2, 51.075], [-2, 57.7], h=3.4, name="office_room")
m.soft([4, 51.075], [4, 57.7], h=3.4, name="office_room")
for (x, y) in [(-5, 48.5), (7, 48.5), (-6, 54.5), (1, 54.5), (8, 54.5)]:
    m.add(type="light", pos=[x, y, 3.15], kind="point", fixture="panel", kelvin=4600, intensity=8, range=9, shadows=False)
for (x, y, hd) in [(-6, 56.5, 180), (1, 56.5, 180), (8, 56.5, 180)]:
    m.add(type="furniture", kind="desk", base=[x, y, 0.02], heading=hd)
m.add(type="furniture", kind="cabinet", base=[-9, 50.2, 0.02], heading=90)
m.add(type="furniture", kind="locker", base=[10.5, 47, 0.02], heading=-90, count=3)
m.add(type="furniture", kind="flagpole", base=[-6, 42.5, 0.02], height=9.0, flag_mat="cloth_white")
m.add(type="vehicle", kind="hilux", base=[-12.5, 43, 0.0], heading=0, mat="vehicle_od", bullbar=True, cargo="none")
m.add(type="vehicle", kind="technical", base=[14.5, 43.5, 0.0], heading=180, mat="vehicle_od", gun_heading=0)
m.add(type="sandbags", p0=[-8.5, 34.5], p1=[-4.5, 34.5], layers=5, seed=21)
m.add(type="sandbags", p0=[6.5, 34.5], p1=[10.5, 34.5], layers=5, seed=22)
m.add(type="jersey", p0=[-14.5, 50], p1=[-14.5, 58])
m.add(type="jersey", p0=[16.5, 50], p1=[16.5, 58])
m.add(type="furniture", kind="generator", base=[15, 59, 0.02], heading=90)
m.spawns("defend", [(-4, 38.5), (-2, 39.1), (0, 39.7), (2, 39.1), (4, 38.5)], 180)
m.add(type="zone", name="Defend buy zone", kind="buyzone", team="defend", min=[-15, 33, -1], max=[17, 45.5, 5])
m.sign("DISTRICT CENTRE", 1, 45.78, 2.75, 0, scale=0.34, color=(0.12, 0.12, 0.1, 1))

# ------------------------------------------------------------------ NW depot and NE hotel garden
m.add(type="container", base=[-52, 37, 0.02], heading=0, mat="container_green")
m.add(type="container", base=[-52, 37, 2.62], heading=2, mat="container_blue")
m.add(type="container", base=[-42, 46, 0.02], heading=90, mat="corrugated_rust")
m.add(type="container", base=[-30, 53, 0.02], heading=10, mat="container_red")
m.add(type="container", base=[-26, 40, 0.02], heading=90, mat="container_green", open=True)
m.add(type="container", base=[-53, 55, 0.02], heading=90, mat="container_red")
m.add(type="container", base=[-53, 55, 2.62], heading=88, mat="container_green")
m.add(type="vehicle", kind="btr", base=[-40, 56, 0.0], heading=20, seed=7)
m.add(type="vehicle", kind="truck", base=[-34, 37, 0.02], heading=80, mat="vehicle_tan", cover_mat="tarp_blue")
m.add(type="prop", kind="drums", base=[-22, 50, 0.02], heading=0, count=6)
m.add(type="prop", kind="tires", base=[-46, 33, 0.02], count=8)
m.add(type="rocks", base=[-20.5, 58, 0], size=1.0, count=3, seed=19)

for x in (21, 25, 29, 33, 37, 41, 45, 49, 53, 57):
    if x not in (29,):
        m.add(type="tree", kind="poplar", base=[x, 34.5, 0], height=10 + (x % 3))
for x in (22, 27, 32, 47, 52, 56.5):
    m.add(type="tree", kind="poplar", base=[x, 60.5, 0], height=11)
m.add(type="awning", min=[33, 45], max=[41, 51], height=3.0, mat="awning_stripe", spacing=4.0)
m.add(type="prop", kind="charpoy", base=[35, 48, 0.02], heading=0)
m.add(type="prop", kind="charpoy", base=[39, 48, 0.02], heading=0)
m.add(type="prop", kind="fountain", base=[46.5, 48, 0.02], radius=1.6)
for (p0, p1) in [([21, 40], [31, 40]), ([35, 40], [55, 40]), ([24, 55], [44, 55]), ([50, 44], [50, 56])]:
    m.add(type="qala_wall", p0=p0, p1=p1, height=1.1, thickness=0.8, mat="hedge", footing=False)
m.add(type="tree", kind="mulberry", base=[28, 48, 0], height=7)
m.add(type="tree", kind="mulberry", base=[54, 50, 0], height=7)

# ------------------------------------------------------------------ cameras, callouts
m.camera("Truck stop", -22.65, 29.0, 3.2, 135, -18)
m.camera("A gate", -41, -0.35, 3.2, 180, -12)
m.camera("Hotel balcony", 49.6, 16.2, 6.3, 135, -20)
m.camera("Hotel gate", 49.2, 1.7, 3.0, 180, -12)
m.camera("Roundabout", -11.75, 11.5, 3.0, -90, -12)
m.camera("Bazaar", 0, -3.0, 3.4, 180, -6)

for (name, *r) in [
    ("Highway", -57.6, -61.6, 57.6, -45), ("A Long", -50.5, -45, -42, -4), ("Bazaar Gate", -7.5, -45, 7.5, -36),
    ("Bazaar", -6, -36, 6, 0), ("Truck Stop Shops", -43.5, -44.5, -7.5, -38), ("Highway Shops", 7.5, -44.5, 43.5, -38),
    ("Back Lane West", -43.5, -38, -7.5, -35), ("Back Lane East", 7.5, -38, 43.5, -35), ("Carpet Market", -42, -35, -8.6, -4),
    ("Carpet Lane", -42, -21.5, -8.6, -18), ("Cloth Alley", -27.5, -35, -24.5, -4), ("A Connector", -50.5, -4, -6, 0),
    ("West Houses", -57.6, -36, -50.5, -4), ("A Site", -56.8, 0.5, -22.5, 29.5), ("Workshop", -56.8, 4, -48, 16), ("Fuel Pumps", -46, 8, -32, 16),
    ("Roundabout", -21.6, 0, 19.6, 32), ("Chaikhana", -21.6, 2, -12, 12), ("Pharmacy", 12, 2, 19.6, 11),
    ("Residential", 8.6, -35, 42, -4), ("Res Lane", 8.6, -21.5, 42, -18), ("Res Alley", 24.5, -35, 27.5, -4), ("B Connector", 6, -4, 50.5, 0),
    ("B Long", 42, -45, 50.5, 2), ("East Houses", 50.5, -36, 57.6, -4), ("B Site", 20.6, 2.6, 51, 18), ("Hotel", 26, 18, 50, 30),
    ("Hotel Back", 50, 18, 57.6, 32), ("CT Spawn", -16, 32, 18, 46), ("District Office", -10, 46, 12, 58), ("Depot", -57.6, 30, -16, 61.6),
    ("Garden", 18, 32, 57.6, 61.6)]:
    m.callout(name, *r)

header = {
    "name": "Sarai Bazaar",
    "description": "Market town on the highway: a covered bazaar street, the carpet market, a truck stop and fuel station (A), "
                   "the two-storey Sarai Hotel (B) and the district centre.",
    "environment": {**ENV_DUSK, "sun_dir": [-0.42, -0.4, 0.81], "sun_color": [1.0, 0.9, 0.76],
                    "fog": {"density": 0.0038, "height_falloff": 0.05, "base_height": 0.0, "max_opacity": 0.5, "sun_scatter": 0.5}},
    "bounds": [[-63, -67, -1.0], [63, 67, 16]],
    "skyvis_spacing": [1.5, 1.5, 1.0],
    "briefing": {'region': 'Highway town, Afghanistan (fictional)', 'attack': 'Push off the burnt-out highway through the bazaar gate, the carpet market or the side alleys.', 'defend': 'Hold the district centre behind its HESCO walls; the roundabout links both sites.', 'A': "The truck stop: fuel pumps under a canopy, a mechanic's workshop, a parked tanker and jingle truck.", 'B': 'The Sarai Hotel courtyard and ground floor; outside stairs climb to a balcony over the courtyard.'},
}
extra = {
    "camera_shots": [
        {"name": "overview", "pos": [30, -55, 30], "hpr": [30, -32, 0]},
        {"name": "t_spawn", "pos": [0, -58, 1.75], "hpr": [0, 2, 0]},
        {"name": "bazaar", "pos": [0, -40, 1.75], "hpr": [0, 1, 0]},
        {"name": "roundabout", "pos": [-4, 2, 1.75], "hpr": [-10, 4, 0]},
        {"name": "a_site", "pos": [-30, 2, 1.75], "hpr": [60, 2, 0]},
        {"name": "b_site", "pos": [46, 3, 1.75], "hpr": [20, 4, 0]},
        {"name": "ct", "pos": [1, 34, 1.75], "hpr": [0, 2, 0]},
    ],
    "test_routes": [
        {"name": "A long", "start": [-46, -50, 0.1, 0], "waypoints": [[-46, -44], [-46, -34], [-44, -20], [-47, -6], [-46, -2], [-46, 1],
                                                                   [-46, 6], [-40, 18, 0.02]]},
        {"name": "A carpet market", "start": [-2, -52, 0.1, 0], "waypoints": [[-2, -44], [-3, -36.5], [-26, -36.5], [-26, -27], [-26, -19.75],
                                                                            [-26, -10], [-26, -2], [-26, 1], [-28, 6, 0.02]]},
        {"name": "A via carpet lane", "start": [-46, -52, 0.1, 0], "waypoints": [[-46, -44], [-46, -36.5], [-44, -19.75], [-30, -19.75],
                                                                               [-26, -16], [-26, -2], [-26, 1], [-30, 8, 0.02]]},
        {"name": "A via roundabout", "start": [0, -50, 0.1, 0], "waypoints": [[0, -44], [0, -36], [-3.5, -20], [-3.5, -3], [-12, 1],
                                                                            [-18, 15], [-20, 15], [-23, 15], [-28, 15, 0.02]]},
        {"name": "B long", "start": [46, -50, 0.1, 0], "waypoints": [[46, -44], [44, -34], [44, -22], [44, -10], [46, -3], [46, 0], [46, 3],
                                                                   [44, 9, 0.02]]},
        {"name": "B res alley", "start": [3, -52, 0.1, 0], "waypoints": [[2, -44], [3, -36.5], [26, -36.5], [26, -26], [26, -19.75],
                                                                       [26, -10], [26, -2], [30, 0.5], [30, 2], [30, 5, 0.02]]},
        {"name": "B via res lane", "start": [46, -52, 0.1, 0], "waypoints": [[46, -44], [45, -36.5], [43, -19.75], [30, -19.75], [26, -16],
                                                                           [26, -2], [30, 0.5], [30, 2], [32, 6, 0.02]]},
        {"name": "B via roundabout", "start": [0, -50, 0.1, 0], "waypoints": [[0, -44], [0, -36], [3.5, -20], [3.5, -3], [8, 4], [14, 16],
                                                                            [19, 22], [21, 22], [24, 18, 0.02]]},
        {"name": "CT to A", "start": [-2, 39, 0.1, 90], "waypoints": [[-10, 40], [-16, 40.2], [-20, 40], [-30, 36], [-36, 32], [-36, 30],
                                                                    [-36, 22, 0.02]]},
        {"name": "CT to A south", "start": [-2, 38, 0.1, 90], "waypoints": [[-1, 33], [1, 30], [-12, 20], [-19, 15], [-23, 15],
                                                                          [-28, 15, 0.02]]},
        {"name": "CT to B", "start": [2, 39, 0.1, -90], "waypoints": [[10, 40], [18, 40.2], [24, 38], [30, 33], [30, 31], [44, 31], [44, 29.5],
                                                                    [40, 24, 0.02]]},
        {"name": "CT to B south", "start": [2, 38, 0.1, -90], "waypoints": [[1, 33], [1, 30], [14, 24], [19, 22], [21, 22], [25, 13, 0.02]]},
    ],
    "practice_positions": {
        "defend": [[-40, 20, 0.02, 180, 0], [-25, 22, 0.02, 200, 0], [-52, 14.2, 0.02, 150, 1], [-30, 6, 0.02, 220, 1],
                   [-45, 21, 0.02, 180, 1], [37, 22, 0.02, 180, 0], [30, 25, 0.02, 160, 0], [46, 17, 3.62, 200, 0], [30, 17, 3.62, 160, 1],
                   [25, 12, 0.02, 150, 1], [52, 14.5, 0.02, 200, 1], [0, 30.5, 0.02, 180, 1], [-14, 15, 0.02, 160, 0], [15, 15, 0.02, 200, 0]],
        "attack": [[-46, -20, 0.02, 0, 0], [-26, -28, 0.02, 0, 1], [0, -20, 0.02, 0, 0], [26, -31, 0.02, 0, 1], [46, -12, 0.02, 0, 0],
                   [-30, -19.75, 0.02, 90, 0], [30, -19.75, 0.02, -90, 0], [-20, -2, 0.02, 90, 0], [20, -2, 0.02, -90, 0], [0, -1, 0.02, 0, 1]],
    },
    "modes": {"duel": {
        "_comment": "1v1 duels: site A only (the truck stop); a player-clip wall along x = 6.5 closes the east half (residential, hotel).",
        "sites": ["A"],
        "spawns": [{"team": "attack", "pos": [-3, -56.5, 0.1], "heading": 0}, {"team": "defend", "pos": [-3, 38.5, 0.1], "heading": 180}],
        "clips": [{"center": [6.5, 0.0, 6.0], "size": [0.4, 128.0, 20.0]}],
    }},
}
write(sys.argv[1], header, m, extra)
print("pieces", len(m.pieces), "lights", m.lights)
