"""QALAT VILLAGE: a mountain village in a dry Afghan valley.
Attackers come up the wadi (south); defenders hold the malik's compound (north).
A = the walled qala (fort) in the west, B = the caravanserai in the east."""
import sys
from common import Map, ENV_DUSK, write

m = Map()
X0, Y0, X1, Y1 = -59, -63, 59, 63          # cliff lines; the playable area is about +-57.6 x +-61.6

# ------------------------------------------------------------------ ground, cliffs, mountains
m.floor(-63, -67, 63, 67, "dust")
m.add(type="terrain", inner=[[-63, -67], [63, 67]], extent=640, step=10, start=4, ramp=230, height=150, seed=23, mat="rock")
m.cliffs(X0, Y0, X1, Y1, height=9.5, seed=31)
m.floor(-57.5, -61, 57.5, -43, "gravel", decal=True)                 # wadi bed
for (x0, y0, x1, y1) in [(-46.5, -38, -40, -6.5), (-5, -38, 5, 14), (40, -38, 47, -2), (-24, -6.5, -5, -2), (5, -6.5, 29, -2),
                         (-56, -6, -24, 14), (-10, -2, 14, 33), (26, -6, 56, 13), (-25.4, 13.6, -20.2, 44), (22.4, 11, 25.4, 40),
                         (-19.5, 34.5, 21.5, 47.8)]:
    m.floor(x0, y0, x1, y1, "dirt", decal=True)

# ------------------------------------------------------------------ the wadi (attackers)
m.add(type="vehicle", kind="t55", base=[-17, -50, 0.0], heading=72, turret=150, gun_pitch=-7, seed=4)
m.add(type="vehicle", kind="btr", base=[25, -53.5, 0.0], heading=-96, seed=9)
m.add(type="vehicle", kind="hilux", base=[-47, -55, 0.0], heading=30, wreck=True)
for (x, y, s, c, sd) in [(-37, -51, 1.7, 5, 3), (7, -46.5, 1.2, 4, 4), (40, -51, 1.6, 5, 5), (-52, -45.5, 1.3, 3, 6), (52, -57, 1.9, 4, 7),
                         (-8, -60, 1.4, 3, 8), (16, -60, 1.2, 3, 9), (-28, -57, 1.0, 3, 10), (31, -45.5, 1.0, 3, 11)]:
    m.add(type="rocks", base=[x, y, 0], size=s, count=c, spread=2.2, seed=sd)
for x in (-56, -52.5, -32, -27.5, 22, 27, 33, 52.5, 56):
    m.add(type="tree", kind="poplar", base=[x, -41.2, 0], height=10 + (x % 3))
m.spawns("attack", [(-4, -56), (-2, -56.8), (0, -57.6), (2, -56.8), (4, -56)], 0)
m.add(type="zone", name="Attack buy zone", kind="buyzone", team="attack", min=[-57, -61, -1], max=[57, -39, 5])

# the village wall above the wadi: a gate in the middle, two broken gaps
m.add(type="qala_wall", p0=[-57.6, -38], p1=[-46.5, -38], height=3.4, thickness=0.7, damage=2, seed=1)
m.add(type="qala_wall", p0=[-40, -38], p1=[40, -38], height=3.6, thickness=0.7, damage=7, buttress=8, buttress_sides=[1], seed=2,
      openings=[{"at": 40, "width": 4.0, "top": 3.0, "gate": True, "mat": "metal_blue"}])
m.add(type="qala_wall", p0=[47, -38], p1=[57.6, -38], height=3.4, thickness=0.7, damage=2, seed=3)
for x in (-47.6, -39.0, 39.0, 48.1):
    m.add(type="rocks", base=[x, -39.3, 0], size=0.7, count=3, spread=0.8, mat="mud_plinth", seed=int(x) + 60)

# ------------------------------------------------------------------ west houses / A long
m.house(-56.5, -35, -47, -26, e=[("d", -29.5), ("w", -32.5)], n=[("w", -52)], roof_items=[{"kind": "tank", "x": -50.5, "y": -33}], seed=11)
m.add(type="prop", kind="charpoy", base=[-54.5, -31, 0.02], heading=0)
m.add(type="prop", kind="water_jars", base=[-52, -34.2, 0.02], heading=0)
m.add(type="prop", kind="firewood", base=[-53, -23.5, 0.02], heading=90)
m.add(type="prop", kind="cart", base=[-49.5, -23.2, 0.02], heading=-70)
m.house(-56.5, -21, -47, -7, e=[("d", -18), ("d", -9.5), ("w", -14)], n=[("w", -52.5)],
        roof_items=[{"kind": "laundry", "x": -52, "y": -10, "length": 4}], seed=12, light=False)
m.soft([-56.05, -13.5], [-47.45, -13.5], name="w3_inner", doors=[6.0])
m.bulb(-51.8, -17.3, 2.75)
m.bulb(-51.8, -10.2, 2.75)
m.house(-40, -35.5, -29, -25, h=3.2, parapet=0.35, w=[("d", -28)], n=[("d", -33)], e=[("w", -31)],
        domes=[{"x": -37.25, "y": -30.25, "r": 1.9}, {"x": -31.75, "y": -30.25, "r": 1.9}], seed=13, light=False)
m.soft([-34.5, -35.05], [-34.5, -25.45], h=3.2, name="domes_w", doors=[6.5])
m.bulb(-37.2, -30.2, 2.95)
m.bulb(-31.8, -30.2, 2.95)
m.house(-40, -19, -29, -6.5, w=[("d", -13)], e=[("d", -11), ("w", -16)], n=[("w", -36), ("w", -32)],
        roof_items=[{"kind": "wood", "x": -33, "y": -16}], seed=14, light=False)
m.soft([-34.5, -18.55], [-34.5, -6.95], name="passage", doors=[6.5])
m.bulb(-37.3, -12.7, 2.75)
m.bulb(-31.7, -12.7, 2.75)
m.add(type="prop", kind="charpoy", base=[-38.2, -16.5, 0.02], heading=0)
m.add(type="prop", kind="sacks", base=[-31.5, -8, 0.02], heading=0, count=6)
m.add(type="tree", kind="apricot", base=[-26.5, -32, 0])

# ------------------------------------------------------------------ mid: the bazaar lane
m.house(-24, -37.3, -7.6, -25.5, h=3.2, w=[("d", -31)], e=[("d", -27.5)], n=[("w", -18), ("w", -12)],
        roof_items=[{"kind": "tank", "x": -20, "y": -34}, {"kind": "dish", "x": -11, "y": -28}], seed=15, light=False)
m.soft([-16, -36.85], [-16, -25.95], h=3.2, name="mid_w1", doors=[3.85])
m.bulb(-20, -31.4, 2.95)
m.bulb(-11.8, -31.4, 2.95)
m.add(type="shop", style="container", base=[-6.3, -33.6, 0.02], heading=90, goods="fruit", mat="container_blue", sign="MEWA")
m.house(-24, -21, -7.6, -6.5, w=[("d", -11)], e=[("d", -9)], n=[("w", -19), ("d", -14)], seed=16, light=False)
m.soft([-15.5, -20.55], [-15.5, -6.95], name="mid_w2", doors=[4.0])
m.bulb(-19.8, -13.7, 2.75)
m.bulb(-11.6, -13.7, 2.75)
m.add(type="shop", style="container", base=[-6.3, -15.5, 0.02], heading=90, goods="rugs", mat="container_red", sign="QALEEN")
m.house(7.6, -37.3, 24, -25.5, w=[("d", -27.5)], e=[("d", -30)], n=[("w", 12), ("w", 19)],
        roof_items=[{"kind": "antenna", "x": 20, "y": -30}], seed=17, light=False)
m.soft([15.5, -36.85], [15.5, -25.95], name="mid_e1", doors=[3.85])
m.bulb(11.5, -31.4, 2.75)
m.bulb(19.7, -31.4, 2.75)
m.add(type="shop", style="mud", base=[6.0, -35, 0.02], heading=-90, goods="tires", awning=1.2)
m.add(type="shop", style="mud", base=[6.0, -31, 0.02], heading=-90, goods="cans", awning=1.2, sign="DUKAN")
m.house(7.6, -21, 24, -6.5, h=3.2, w=[("d", -19)], e=[("d", -12)], n=[("d", 14), ("w", 20)],
        domes=[{"x": 20, "y": -13.75, "r": 2.0}], seed=18, light=False)
m.soft([16, -20.55], [16, -6.95], h=3.2, name="mid_e2", doors=[3.0])
m.bulb(11.8, -13.7, 2.95)
m.bulb(20, -13.7, 2.95)
m.add(type="shop", style="container", base=[6.3, -12.5, 0.02], heading=-90, goods="cloth", mat="container_green")
m.add(type="vehicle", kind="jingle", base=[1.2, -21, 0.0], heading=4, seed=5, load="sacks")
m.add(type="vehicle", kind="motorbike", base=[-3.6, -28, 0.0], heading=10, mat="jingle_red")
m.add(type="vehicle", kind="motorbike", base=[3.6, -3.5, 0.0], heading=170, mat="jingle_blue", lean=-8)
m.add(type="prop", kind="cart", base=[-3.2, -9.5, 0.02], heading=15)
m.add(type="prop", kind="jerrycans", base=[3.8, -27, 0.02], heading=90, count=6)
for (y0, y1, z) in [(-30, -28, 4.0), (-18.5, -19.5, 4.2), (-7, -8.5, 3.9)]:
    m.add(type="bunting", p0=[-5.2, y0], p1=[5.2, y1], z=z, sag=0.5, seed=int(-y0))
m.add(type="power_line", points=[[-5.4, -37], [-5.4, -22.5], [-5.4, -5], [-9.5, 12], [-9.5, 30]], height=7.0)

# ------------------------------------------------------------------ east houses / B lane
m.house(29, -35.5, 40, -25, h=3.2, parapet=0.35, e=[("d", -29)], w=[("d", -31)], n=[("w", 35)],
        domes=[{"x": 31.75, "y": -30.25, "r": 1.9}, {"x": 37.25, "y": -30.25, "r": 1.9}], seed=19, light=False)
m.soft([34.5, -35.05], [34.5, -25.45], h=3.2, name="domes_e", doors=[6.5])
m.bulb(31.8, -30.2, 2.95)
m.bulb(37.2, -30.2, 2.95)
m.house(29, -19, 40, -6.5, e=[("d", -12)], w=[("d", -14)], n=[("w", 33)], seed=20, light=False,
        roof_items=[{"kind": "laundry", "x": 34.5, "y": -10, "length": 5}])
m.soft([34.5, -18.55], [34.5, -6.95], name="east_passage", doors=[6.0])
m.bulb(31.7, -12.7, 2.75)
m.bulb(37.3, -12.7, 2.75)
m.house(47.5, -35, 56.5, -24, w=[("d", -29)], n=[("w", 52)], roof_items=[{"kind": "tank", "x": 52, "y": -32}], seed=21)
m.add(type="prop", kind="hay", base=[52, -22, 0], radius=1.2)
m.house(47.5, -20, 56.5, -6.5, h=3.2, w=[("d", -16), ("d", -9)], seed=22, light=False)
m.soft([47.95, -13.25], [56.05, -13.25], h=3.2, name="east_inner", doors=[4.5])
m.bulb(52, -16.6, 2.95)
m.bulb(52, -9.9, 2.95)
m.add(type="vehicle", kind="technical", base=[43.8, -14, 0.0], heading=175, mat="vehicle_tan", gun_heading=-30)
m.add(type="rocks", base=[44, -30, 0], size=0.9, count=2, seed=40)
m.add(type="prop", kind="cart", base=[45.6, -4.5, 0.02], heading=20)
m.add(type="tree", kind="apricot", base=[26.5, -32, 0])

# ------------------------------------------------------------------ west yard, guest house, chaikhana
m.house(-22, -2, -10, 13.6, h=3.2, s=[("d", -16)], e=[("d", 6), ("w", 2), ("w", 10)], w=[("d", 4)], n=[("w", -16)],
        parapet_gaps=[{"side": "e", "from": 10.7, "to": 12.3}], roof_items=[{"kind": "laundry", "x": -16, "y": 3, "length": 5}],
        seed=23, light=False)
m.soft([-21.55, 7], [-10.45, 7], h=3.2, name="guest_inner", doors=[5.5])
m.bulb(-16, 2.5, 2.95)
m.bulb(-16, 10.3, 2.95)
m.add(type="stairs", base=[-6.04, 11.5, 0], heading=90, steps=11, rise=3.55, run=0.36, width=1.4, mat="mud_plinth", solid=True)
m.add(type="prop", kind="charpoy", base=[-19, 11, 0.02], heading=90)
m.add(type="prop", kind="hay", base=[-55, 4, 0], radius=1.5)
m.add(type="prop", kind="hay", base=[-55.2, -1.5, 0], radius=1.2)
m.add(type="prop", kind="charpoy", base=[-35, 10.5, 0.02], heading=90)
m.add(type="prop", kind="tandoor", base=[-30.5, 0.5, 0.02])
m.add(type="prop", kind="well", base=[-45, 4.5, 0.02])
m.add(type="prop", kind="cart", base=[-49, 10, 0.02], heading=60)
m.add(type="tree", kind="mulberry", base=[-37, 3, 0], height=7.5)
m.add(type="qala_wall", p0=[-46, -1], p1=[-38, -1], height=1.3, thickness=0.5, footing=False, seed=50)
m.add(type="qala_wall", p0=[-34, 8], p1=[-27, 8], height=1.2, thickness=0.5, footing=False, seed=51)

m.house(-22, 16, -10.5, 27, h=3.2, e=[("D", 21.5, 1.6), ("w", 17.8), ("w", 25.2)], w=[("d", 23.5)], n=[("w", -16)], seed=24, light=False,
        floor_mat="carpet_red")
m.lamp(-16.2, 19, 2.9, kelvin=2700, intensity=8, rng=8)
m.lamp(-16.2, 24.5, 2.9, kelvin=2700, intensity=8, rng=8)
m.add(type="prop", kind="samovar", base=[-20.6, 21.5, 0.02], heading=90)
for (x, y, hd) in [(-17.5, 17.3, 0), (-14, 17.3, 0), (-17.5, 25.7, 0), (-14, 25.7, 0)]:
    m.add(type="prop", kind="bench", base=[x, y, 0.02], heading=hd, length=2.6)
m.add(type="awning", min=[-10.2, 16.5], max=[-6.5, 26.5], height=2.8, mat="awning_stripe", spacing=3.3)
m.add(type="prop", kind="bench", base=[-8.3, 18.2, 0.02], heading=90, length=2.4)
m.add(type="prop", kind="bench", base=[-8.3, 24.8, 0.02], heading=90, length=2.4)
m.sign("CHAI KHANA", -10.35, 21.5, 3.0, 90, scale=0.32, color=(0.9, 0.82, 0.6, 1))

# ------------------------------------------------------------------ the square
m.add(type="tree", kind="mulberry", base=[1, 20, 0], height=8.5)
m.add(type="prop", kind="charpoy", base=[-2.5, 22.5, 0.02], heading=20)
m.add(type="prop", kind="charpoy", base=[4.2, 17.5, 0.02], heading=-70)
m.add(type="prop", kind="well", base=[-5, 9.5, 0.02])
m.add(type="vehicle", kind="jingle", base=[6.5, 5, 0.0], heading=100, seed=11, load="tarp")
m.add(type="vehicle", kind="hilux", base=[-6, 27, 0.0], heading=-40, mat="vehicle_white", cargo="sacks")
m.add(type="vehicle", kind="taxi", base=[9.5, 27.5, 0.0], heading=75)
m.add(type="vehicle", kind="motorbike", base=[11, 14, 0.0], heading=-30, mat="jingle_green")
m.add(type="bunting", p0=[-9.9, 12.8], p1=[1, 20], z=3.2, z1=5.5, sag=0.4, seed=7)
m.add(type="bunting", p0=[13.9, 9.5], p1=[1, 20], z=3.0, z1=5.5, sag=0.4, seed=8)

m.house(14, -2, 26, 11, s=[("d", 20)], w=[("d", 4)], e=[("d", 6), ("w", 2)], n=[("w", 19)], seed=25, light=False,
        roof_items=[{"kind": "dish", "x": 23, "y": 1}])
m.soft([20, -1.55], [20, 10.55], name="store_inner", doors=[7.5])
m.bulb(17, 4.5, 2.75)
m.bulb(23, 4.5, 2.75)
m.add(type="prop", kind="sacks", base=[23, 9, 0.02], heading=0, count=9)
m.add(type="prop", kind="jerrycans", base=[16, 0, 0.02], heading=0, count=8)
m.house(15, 16, 22.5, 25, w=[("d", 20.5)], e=[("d", 22)], n=[("w", 18.7)], seed=26)
m.add(type="prop", kind="charpoy", base=[19.5, 23.2, 0.02], heading=90)

# ------------------------------------------------------------------ east yard
m.add(type="vehicle", kind="hilux", base=[33, 1.5, 0.0], heading=100, mat="vehicle_white", cargo="cans")
m.add(type="prop", kind="sacks", base=[49, 6, 0.02], heading=10, count=6)
m.add(type="prop", kind="firewood", base=[31, 9.5, 0.02], heading=0)
m.add(type="prop", kind="hay", base=[52.5, -1, 0], radius=1.5)
m.add(type="tree", kind="apricot", base=[54.5, 7, 0])
m.add(type="qala_wall", p0=[36, 4], p1=[44, 4], height=1.3, thickness=0.5, footing=False, seed=52)
m.add(type="power_line", points=[[28, 11.6], [46, 11.6], [56.5, 11.6]], height=7.0)

# ------------------------------------------------------------------ A: the qala
QH = 5.0
m.add(type="qala_wall", p0=[-54, 16], p1=[-26, 16], height=QH, thickness=0.9, merlons=True, seed=70,
      openings=[{"at": 14, "width": 3.4, "top": 3.2, "gate": True, "mat": "wood_dark"}])
m.add(type="qala_wall", p0=[-26, 16], p1=[-26, 21.5], height=QH, thickness=0.9, merlons=True, seed=71)
m.add(type="wall", soft=True, reinforce=True, breach=True, name="qala_patch", p0=[-26, 21.5], p1=[-26, 26.5], height=3.0,
      thickness=0.4, mat="mud_brick")
m.add(type="wall", p0=[-26, 21.5], p1=[-26, 26.5], z=3.0, height=2.0, thickness=0.9, mat="mud_wall")
m.add(type="qala_wall", p0=[-26, 26.5], p1=[-26, 42], height=QH, thickness=0.9, merlons=True, seed=72,
      openings=[{"at": 6.5, "width": 1.4, "top": 2.3, "gate": True, "mat": "door_blue"}])
m.add(type="qala_wall", p0=[-26, 42], p1=[-54, 42], height=QH, thickness=0.9, merlons=True, seed=73,
      openings=[{"at": 4, "width": 1.6, "top": 2.3, "gate": True, "mat": "door_green"}])
m.add(type="qala_wall", p0=[-54, 42], p1=[-54, 16], height=QH, thickness=0.9, merlons=True, buttress=7, buttress_sides=[1], seed=74)
for (x, y) in [(-54, 16), (-26, 16), (-54, 42), (-26, 42)]:
    m.add(type="watchtower", base=[x, y, 0], size=3.8, height=7.6, round=True)
m.house(-52.6, 34.6, -36, 41.0, h=3.2, s=[("d", -48), ("d", -40), ("w", -45), ("w", -51.5)], e=[("d", 37.8)],
        parapet_gaps=[{"side": "s", "from": -38.8, "to": -37.2}], roof_items=[{"kind": "wood", "x": -47, "y": 38.5}],
        door_mat="wood_dark", seed=27, light=False)
m.soft([-44, 35.05], [-44, 40.55], h=3.2, name="qala_room", doors=[4.0], reinforce=True)
m.lamp(-48.3, 37.8, 2.9, kelvin=2800, intensity=9, rng=9)
m.lamp(-40, 37.8, 2.9, kelvin=2800, intensity=9, rng=9)
m.add(type="stairs", base=[-38, 30.64, 0], heading=0, steps=11, rise=3.55, run=0.36, width=1.4, mat="mud_plinth", solid=True)
m.add(type="awning", min=[-53, 19], max=[-49.5, 29], height=2.8, mat="corrugated_rust", spacing=3.4)
m.add(type="prop", kind="hay", base=[-51.5, 21.8, 0], radius=1.1)
m.add(type="prop", kind="hay", base=[-51.3, 26.5, 0], radius=1.0, squash=1.0)
m.add(type="prop", kind="well", base=[-44, 25, 0.02])
m.add(type="vehicle", kind="technical", base=[-32, 22, 0.0], heading=15, mat="vehicle_white", gun_heading=160)
m.add(type="prop", kind="sacks", base=[-47, 30.5, 0.02], heading=0, count=6)
m.add(type="prop", kind="firewood", base=[-29, 38, 0.02], heading=90)
m.add(type="prop", kind="jerrycans", base=[-35.5, 18, 0.02], heading=0, count=6)
m.add(type="prop", kind="cart", base=[-47.5, 19.6, 0.02], heading=100)
m.add(type="tree", kind="apricot", base=[-30.5, 31.5, 0])
m.add(type="zone", name="A", kind="bombsite", min=[-53.1, 16.9, -0.5], max=[-26.9, 41.1, 5.5])
m.sign("A", -43.5, 15.38, 3.6, 0, scale=1.4, color=(0.6, 0.1, 0.06, 1))

# ------------------------------------------------------------------ B: the caravanserai
CH = 4.4
m.add(type="qala_wall", p0=[26, 14], p1=[54, 14], height=CH, thickness=0.8, seed=80,
      openings=[{"at": 14, "width": 4.0, "top": 3.6, "gate": True, "mat": "metal_blue"}])
for x in (36.5, 43.5):        # the iwan's pylons
    m.add(type="box", base=[x, 13.55, 0], size=[1.6, 1.3, 6.4], mat="mud_brick")
m.add(type="box", base=[40, 13.55, 3.75], size=[5.4, 1.3, 2.65], mat="mud_brick")
m.add(type="box", base=[40, 12.88, 3.75], size=[4.6, 0.04, 2.4], mat="mud_wall", collide=False, occlude=False)
m.add(type="qala_wall", p0=[26, 40], p1=[26, 14], height=CH, thickness=0.8, seed=81,
      openings=[{"at": 12, "width": 1.6, "top": 2.3, "gate": True}])
m.add(type="qala_wall", p0=[54, 40], p1=[26, 40], height=CH, thickness=0.8, seed=82,
      openings=[{"at": 6, "width": 1.6, "top": 2.3, "gate": True}])
m.add(type="qala_wall", p0=[54, 14], p1=[54, 40], height=CH, thickness=0.8, buttress=6, buttress_sides=[1], seed=83)
for (x, y) in [(26, 14), (54, 14), (26, 40), (54, 40)]:
    m.add(type="watchtower", base=[x, y, 0], size=3.0, height=6.2, round=False, taper=0.4)
m.house(27.6, 32.5, 46, 39.4, h=3.2, parapet=0.3, s=[("d", 30.6), ("d", 36.8), ("d", 43), ("w", 33.7 - 1.4)],
        domes=[{"x": 30.6, "y": 35.95, "r": 1.7}, {"x": 36.8, "y": 35.95, "r": 1.7}, {"x": 43, "y": 35.95, "r": 1.7}],
        parapet_gaps=[{"side": "s", "from": 44.2, "to": 45.8}], seed=28, light=False)
m.soft([33.7, 32.95], [33.7, 38.95], h=3.2, name="serai_room", doors=[4.5], reinforce=True)
m.soft([39.9, 32.95], [39.9, 38.95], h=3.2, name="serai_room", doors=[4.5])
for x in (30.6, 36.8, 43):
    m.bulb(x, 35.9, 2.95, kelvin=2800, intensity=7)
m.add(type="stairs", base=[45, 28.54, 0], heading=0, steps=11, rise=3.55, run=0.36, width=1.4, mat="mud_plinth", solid=True)
m.add(type="awning", min=[49, 17], max=[53.1, 30], height=2.8, mat="tarp_blue", spacing=3.3)
m.add(type="prop", kind="sacks", base=[51.2, 19.5, 0.02], heading=90, count=9)
m.add(type="prop", kind="sacks", base=[51.2, 26, 0.02], heading=90, count=6)
m.add(type="vehicle", kind="jingle", base=[37, 22, 0.0], heading=95, seed=23, load="sacks")
m.add(type="prop", kind="well", base=[46, 24.5, 0.02])
m.add(type="prop", kind="cart", base=[31, 19.5, 0.02], heading=-20)
m.add(type="prop", kind="water_jars", base=[29, 30, 0.02], heading=90)
m.add(type="prop", kind="charpoy", base=[49.5, 33.5, 0.02], heading=90)
m.add(type="zone", name="B", kind="bombsite", min=[26.9, 14.9, -0.5], max=[53.1, 39.5, 5.5])
m.sign("B", 47.5, 13.38, 3.2, 0, scale=1.4, color=(0.6, 0.1, 0.06, 1))
m.lamp(40, 26, 4.2, kelvin=3000, intensity=12, rng=13)

# ------------------------------------------------------------------ CT: the malik's compound
m.add(type="qala_wall", p0=[-20, 34], p1=[22, 34], height=3.4, thickness=0.6, seed=90, damage=2,
      openings=[{"at": 21, "width": 3.2, "top": 2.8, "gate": True, "mat": "metal_green"}])
m.add(type="qala_wall", p0=[-20, 61.6], p1=[-20, 34], height=3.4, thickness=0.6, seed=91,
      openings=[{"at": 21.6, "width": 2.4, "top": 2.4, "gate": True}])
m.add(type="qala_wall", p0=[22, 34], p1=[22, 61.6], height=3.4, thickness=0.6, seed=92,
      openings=[{"at": 6, "width": 2.4, "top": 2.4, "gate": True}])
m.house(-12, 48, 14, 58.5, h=3.4, parapet=0.6, s=[("D", 1, 2.0), ("w", -8), ("w", -4), ("w", 6), ("w", 10)],
        w=[("d", 53)], e=[("d", 53)], roof_items=[{"kind": "dish", "x": -9, "y": 56}, {"kind": "tank", "x": 10, "y": 56}],
        door_mat="metal_green", seed=29, light=False)
m.soft([-11.55, 52.5], [13.55, 52.5], h=3.4, name="malik_hall", doors=[4.5, 13, 21.5])
m.soft([-3, 52.575], [-3, 58.05], h=3.4, name="malik_room")
m.soft([5, 52.575], [5, 58.05], h=3.4, name="malik_room")
for x in (-6, 1, 8):
    m.bulb(x, 50.2, 3.15, kelvin=3000, intensity=8)
for x in (-7.5, 1, 9.5):
    m.bulb(x, 55.3, 3.15, kelvin=2800, intensity=5)
m.add(type="vehicle", kind="hilux", base=[-15.5, 43, 0.0], heading=0, mat="vehicle_tan", bullbar=True, cargo="none")
m.add(type="vehicle", kind="sedan", base=[17.5, 44, 0.0], heading=180, mat="vehicle_white", mat2="vehicle_white", taxi=False)
m.add(type="tree", kind="poplar", base=[-18.3, 47.5, 0], height=11)
m.add(type="tree", kind="poplar", base=[20.3, 47.5, 0], height=11)
m.add(type="prop", kind="charpoy", base=[-9, 46.5, 0.02], heading=90)
m.add(type="prop", kind="charpoy", base=[11, 46.5, 0.02], heading=90)
m.spawns("defend", [(-4, 40), (-2, 40.6), (0, 41.2), (2, 40.6), (4, 40)], 180)
m.add(type="zone", name="Defend buy zone", kind="buyzone", team="defend", min=[-19.5, 34.5, -1], max=[21.5, 47.8, 5])

# ------------------------------------------------------------------ NW orchard and NE threshing yard
m.house(-56.5, 51, -46.5, 60.5, e=[("d", 55.5)], s=[("w", -51.5)], seed=30)
for x in (-43, -37.5, -32, -26.5):
    for y in (45.5, 50.5, 56, 60):
        if (x, y) in ((-26.5, 45.5),):
            continue
        m.add(type="tree", kind="apricot", base=[x + (y % 2) * 0.6, y, 0], height=4.2 + (abs(int(x * y)) % 3) * 0.4)
m.add(type="qala_wall", p0=[-45, 48], p1=[-29, 48], height=1.2, thickness=0.5, footing=False, seed=53, openings=[{"at": 8, "width": 1.6, "top": 1.4}])
m.add(type="qala_wall", p0=[-45, 53.5], p1=[-24, 53.5], height=1.2, thickness=0.5, footing=False, seed=54, openings=[{"at": 13, "width": 1.6, "top": 1.4}])
m.house(47.5, 50, 56.5, 60.5, w=[("d", 55)], s=[("w", 52)], seed=31, roof_items=[{"kind": "wood", "x": 52, "y": 57}])
for (x, y, r) in [(31, 50, 1.6), (36, 55.5, 1.4), (40.5, 48.5, 1.3), (29, 56, 1.2)]:
    m.add(type="prop", kind="hay", base=[x, y, 0], radius=r)
m.add(type="prop", kind="charpoy", base=[44, 58.5, 0.02], heading=0)
m.add(type="prop", kind="cart", base=[42, 53, 0.02], heading=120)
m.add(type="tree", kind="mulberry", base=[27, 59, 0], height=7)
m.add(type="qala_wall", p0=[32, 44.5], p1=[44, 44.5], height=1.2, thickness=0.5, footing=False, seed=55)
m.add(type="qala_wall", p0=[44, 44.5], p1=[44, 51], height=1.2, thickness=0.5, footing=False, seed=56)

# ------------------------------------------------------------------ cameras, callouts
m.camera("Qala gate", -36.5, 15.3, 4.3, 180, -18)
m.camera("A courtyard", -27.6, 40.4, 4.4, 135, -22)
m.camera("B courtyard", 52.9, 38.9, 3.9, 135, -22)
m.camera("Iwan", 44.5, 12.8, 3.6, 180, -14)
m.camera("Square", -9.75, 12.9, 3.0, -90, -12)
m.camera("Bazaar", -7.4, -7.1, 3.0, 180, -8)

for (name, *r) in [
    ("T Spawn", -57.6, -61.6, 57.6, -38), ("A Long", -47, -38, -40, -6.5), ("West Houses", -57.6, -37.4, -47, -6.5),
    ("Back Alley", -29, -37.4, -24, -6.5), ("Twin Domes", -40, -37.4, -29, -19), ("Passage", -40, -19, -29, -6.5),
    ("Mid Gate", -5, -40, 5, -30), ("Bazaar", -5, -30, 5, -2), ("Mid West", -24, -37.4, -7.6, -6.5), ("Mid East", 7.6, -37.4, 24, -6.5),
    ("A Connector", -24, -6.5, -5, -2), ("B Connector", 5, -6.5, 29, -2), ("West Yard", -57.6, -6.5, -22, 15.4),
    ("Guest House", -22, -2, -10, 13.6), ("Square", -10, -2, 14, 34), ("Chaikhana", -22, 16, -10.5, 27), ("A Alley", -25.4, 13.6, -20, 44),
    ("A Site", -53.1, 16.9, -26.9, 41.1), ("A Back", -57.6, 14, -54, 42), ("Store", 14, -2, 26, 11), ("Dukan", 15, 16, 22.5, 25),
    ("B Alley", 22.5, 11, 25.4, 40), ("East Back Alley", 24, -37.4, 29, -6.5), ("Domes East", 29, -37.4, 40, -6.5),
    ("B Lane", 40, -38, 47, -2), ("East Houses", 47, -37.4, 57.6, -6.5), ("East Yard", 26, -6.5, 57.6, 13.4),
    ("B Site", 26.9, 14.9, 53.1, 39.6), ("B Back", 54, 12, 57.6, 40.4), ("CT Spawn", -20, 34, 22, 48), ("Malik House", -12, 48, 14, 58.5),
    ("Orchard", -57.6, 42.4, -20, 61.6), ("Threshing Yard", 22, 40.4, 57.6, 61.6)]:
    m.callout(name, *r)

header = {
    "name": "Qalat Village",
    "description": "Mountain village in a dry Afghan valley: the wadi and its tank wreck, a bazaar lane, a walled qala (A), "
                   "a caravanserai (B) and the malik's compound.",
    "environment": ENV_DUSK,
    "bounds": [[-63, -67, -1.0], [63, 67, 16]],
    "skyvis_spacing": [1.5, 1.5, 1.0],
    "briefing": {'region': 'Central highlands, Afghanistan (fictional village)', 'attack': 'Come up the dry wadi past the old T-55 and plant the charge in the qala or the caravanserai.', 'defend': "Hold the malik's compound and rotate through the orchard (A) or the threshing yard (B).", 'A': 'The qala: a walled mud fort with four round towers, a south gate, an east door, a north door and a weak patched wall to blow.', 'B': 'The caravanserai: a courtyard behind a tall iwan gate, domed rooms on the north side with a roof you can climb to.'},
}
extra = {
    "camera_shots": [
        {"name": "overview", "pos": [-30, -50, 30], "hpr": [-30, -32, 0]},
        {"name": "t_spawn", "pos": [0, -58, 1.75], "hpr": [0, 2, 0]},
        {"name": "bazaar", "pos": [0, -36, 1.75], "hpr": [0, 1, 0]},
        {"name": "square", "pos": [-4, 2, 1.75], "hpr": [-20, 3, 0]},
        {"name": "a_site", "pos": [-30, 18.5, 1.75], "hpr": [60, 2, 0]},
        {"name": "b_site", "pos": [40, 15.5, 1.75], "hpr": [0, 2, 0]},
        {"name": "wadi", "pos": [-30, -46, 1.75], "hpr": [-70, 0, 0]},
        {"name": "ct", "pos": [1, 36, 1.75], "hpr": [0, 2, 0]},
    ],
    "test_routes": [
        {"name": "A long", "start": [-43, -44, 0.1, 0], "waypoints": [[-43, -36], [-43, -20], [-43, -8], [-47.5, -3], [-47.5, 2],
                                                                   [-42, 9], [-40, 13], [-40, 18], [-40, 26, 0.02]]},
        {"name": "A via domes", "start": [-43, -46, 0.1, 0], "waypoints": [[-43, -36], [-43, -22], [-35, -22], [-26.5, -22], [-26.5, -10],
                                                                        [-26.5, -4], [-30, 4], [-38, 11.5], [-40, 14], [-40, 18], [-41, 23, 0.02]]},
        {"name": "A alley", "start": [0, -50, 0.1, 0], "waypoints": [[0, -37], [-2.5, -30], [-2.5, -12], [-3, -4], [-15, -4], [-23, -4],
                                                                   [-23.5, 0], [-23.5, 13], [-23, 20], [-23, 33], [-25, 33], [-28, 33], [-32, 30, 0.02]]},
        {"name": "A north door", "start": [-2, -52, 0.1, 0], "waypoints": [[0, -37], [-2.5, -30], [-2.5, -12], [-2, 0], [-1, 12], [-8, 29],
                                                                          [-18, 30.5], [-23, 31], [-23, 38], [-23, 44], [-30, 44], [-30, 41], [-30, 38, 0.02]]},
        {"name": "B lane", "start": [43, -44, 0.1, 0], "waypoints": [[43, -36], [41, -20], [41, -8], [46, 1], [45.5, 8], [40, 11],
                                                                   [40, 16], [40, 27, 0.02]]},
        {"name": "B connector", "start": [3, -50, 0.1, 0], "waypoints": [[1, -37], [3, -28], [3, -12], [2, -5], [15, -4], [28, -4],
                                                                       [32, 5], [38, 10], [40, 13], [40, 18], [44, 28, 0.02]]},
        {"name": "B alley", "start": [0, -50, 0.1, 0], "waypoints": [[0, -37], [-2.5, -30], [-2.5, -12], [-1.5, -1], [6, 11], [14, 13],
                                                                    [24, 14], [24, 28], [28, 28], [33, 28, 0.02]]},
        {"name": "B via domes", "start": [43, -46, 0.1, 0], "waypoints": [[43, -36], [43, -22], [35, -22], [26.5, -22], [26.5, -4],
                                                                         [30, 3], [37, 9], [40, 13], [39, 18], [34, 26, 0.02]]},
        {"name": "CT to A", "start": [-2, 40, 0.1, 90], "waypoints": [[-12, 40], [-19, 40], [-23, 40], [-23, 36], [-23, 33], [-28, 33],
                                                                    [-34, 30, 0.02]]},
        {"name": "CT to B", "start": [2, 40, 0.1, -90], "waypoints": [[12, 40], [21, 40], [24, 40], [24, 30], [24, 28], [28, 28],
                                                                    [34, 28, 0.02]]},
        {"name": "CT to B north", "start": [3, 41, 0.1, -90], "waypoints": [[16, 40.5], [24, 41.5], [30, 42.5], [46, 42.5], [48, 41],
                                                                           [48, 38], [48, 32, 0.02]]},
    ],
    "practice_positions": {
        "defend": [[-35, 24, 0.02, 200, 0], [-30, 38.5, 0.02, 200, 1], [-48.5, 31.5, 0.02, 170, 0], [-44, 38.5, 3.57, 180, 0],
                   [-28.5, 18, 0.02, 230, 1], [44, 30, 0.02, 180, 0], [32, 25, 0.02, 150, 1], [50.5, 22.5, 0.02, 170, 0],
                   [36.8, 34, 0.02, 180, 0], [45.3, 33.4, 3.57, 180, 0], [1, 32, 0.02, 180, 1], [-12, 30, 0.02, 180, 0], [18, 28, 0.02, 200, 0]],
        "attack": [[-43, -10, 0.02, 0, 0], [-26.5, -12, 0.02, 0, 0], [0, -10, 0.02, 0, 1], [-15, -4, 0.02, 90, 0], [18, -4, 0.02, -90, 0],
                   [43, -10, 0.02, 0, 0], [26.5, -12, 0.02, 0, 1], [-36, 7, 0.02, 0, 0], [38, 7, 0.02, 0, 0], [-1, 2, 0.02, 0, 0]],
    },
    "modes": {"duel": {
        "_comment": "1v1 duels: site A only (the qala); a player-clip wall along x = 6.5 closes the east half (bazaar east side, B).",
        "sites": ["A"],
        "spawns": [{"team": "attack", "pos": [-3, -56, 0.1], "heading": 0}, {"team": "defend", "pos": [-3, 40, 0.1], "heading": 180}],
        "clips": [{"center": [6.5, 0.0, 6.0], "size": [0.4, 128.0, 20.0]}],
    }},
}
write(sys.argv[1], header, m, extra)
print("pieces", len(m.pieces), "lights", m.lights)
