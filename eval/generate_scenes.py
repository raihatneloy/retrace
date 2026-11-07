#!/usr/bin/env python3
"""
Builds a realistic `.excalidraw` scene for each corpus case.

The corpus images are what a pen drawing looks like; this is what the FILE looks
like for the same drawing: freedraw strokes only, no semantic element types, no
text elements. That is deliberately the weakest useful version of the document —
if sending it helps, it helps for real drawings, not just for tidy ones.

Run:  python3 eval/generate_scenes.py
"""

import json
import math
import os
import random

HERE = os.path.dirname(__file__)
CORPUS = os.path.join(HERE, "corpus")


def strokes_for_box(x, y, w, h, rng):
    """A box drawn the way a person draws it: one stroke per side."""
    out = []
    sides = [
        ((x, y), (x + w, y)),
        ((x + w, y), (x + w, y + h)),
        ((x + w, y + h), (x, y + h)),
        ((x, y + h), (x, y)),
    ]
    for (a, b) in sides:
        out.append(line_stroke(a, b, rng))
    return out


def line_stroke(a, b, rng, n=None):
    (x1, y1), (x2, y2) = a, b
    n = n or max(4, int(math.hypot(x2 - x1, y2 - y1) / 14))
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append(
            [
                x1 + (x2 - x1) * t + rng.uniform(-1.5, 1.5),
                y1 + (y2 - y1) * t + rng.uniform(-1.5, 1.5),
            ]
        )
    return pts


def ellipse_stroke(x, y, w, h, rng, steps=36):
    cx, cy, rx, ry = x + w / 2, y + h / 2, w / 2, h / 2
    return [
        [cx + rx * math.cos(2 * math.pi * i / steps), cy + ry * math.sin(2 * math.pi * i / steps)]
        for i in range(steps + 1)
    ]


def diamond_strokes(x, y, w, h, rng):
    pts = [(x + w / 2, y), (x + w, y + h / 2), (x + w / 2, y + h), (x, y + h / 2), (x + w / 2, y)]
    return [line_stroke(pts[i], pts[i + 1], rng) for i in range(4)]


def to_element(eid, points, seed):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x, y = min(xs), min(ys)
    w, h = max(xs) - x, max(ys) - y
    return {
        "id": eid,
        "type": "freedraw",
        "x": round(x, 2),
        "y": round(y, 2),
        "width": round(max(w, 1), 2),
        "height": round(max(h, 1), 2),
        "angle": 0,
        "strokeColor": "#1e1e1e",
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 2,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "frameId": None,
        "roundness": None,
        "seed": seed,
        "version": 1,
        "versionNonce": seed,
        "isDeleted": False,
        "boundElements": None,
        "updated": 1,
        "link": None,
        "locked": False,
        "points": [[round(px - x, 2), round(py - y, 2)] for px, py in points],
        "pressures": [],
        "simulatePressure": True,
        "lastCommittedPoint": None,
    }


def build(case):
    rng = random.Random(hash(case["id"]) & 0xFFFF)
    elements = []
    n = 0

    def add(points):
        nonlocal n
        n += 1
        elements.append(to_element(f"stroke-{n}", points, n * 7919))
        return f"stroke-{n}"

    for node in case["expected"]["nodes"]:
        b = node["bbox"]
        shape = node["shape"]
        if shape == "ellipse":
            add(ellipse_stroke(b["x"], b["y"], b["w"], b["h"], rng))
        elif shape == "diamond":
            for pts in diamond_strokes(b["x"], b["y"], b["w"], b["h"], rng):
                add(pts)
        else:
            for pts in strokes_for_box(b["x"], b["y"], b["w"], b["h"], rng):
                add(pts)

        # handwriting is strokes too, not a text element
        if node["label"]:
            fw = max(24, len(node["label"]) * 11)
            add(
                line_stroke(
                    (b["x"] + (b["w"] - fw) / 2, b["y"] + b["h"] / 2),
                    (b["x"] + (b["w"] + fw) / 2, b["y"] + b["h"] / 2),
                    rng,
                    10,
                )
            )

    for edge in case["expected"]["edges"]:
        a = next(n for n in case["expected"]["nodes"] if n["id"] == edge["from"])["bbox"]
        c = next(n for n in case["expected"]["nodes"] if n["id"] == edge["to"])["bbox"]
        start = (a["x"] + a["w"] if c["x"] > a["x"] else a["x"], a["y"] + a["h"] / 2)
        end = (c["x"] if c["x"] > a["x"] else c["x"] + c["w"], c["y"] + c["h"] / 2)
        add(line_stroke(start, end, rng))

    return {
        "type": "excalidraw",
        "version": 2,
        "source": "retrace-eval",
        "elements": elements,
        "appState": {"viewBackgroundColor": "#ffffff"},
        "files": {},
    }


def main():
    files = sorted(f for f in os.listdir(CORPUS) if f.endswith(".json") and f != "scenes")
    for f in files:
        with open(os.path.join(CORPUS, f)) as fh:
            case = json.load(fh)
        scene_path = os.path.join(CORPUS, f.replace(".json", ".scene.json"))
        with open(scene_path, "w") as fh:
            json.dump(build(case), fh)
        print(f"  {case['id']:16} {len(json.load(open(scene_path))['elements'])} strokes")
    print("done")


if __name__ == "__main__":
    main()
