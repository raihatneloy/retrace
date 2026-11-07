#!/usr/bin/env python3
"""
Builds the evaluation corpus: sketches plus the exact graph each one encodes.

Ground truth is exact because the sketches are drawn FROM the graph, not the
other way round. Jitter is added to the ink so the shapes are hand-drawn, but
the recorded bboxes are the nominal ones — a model that reads the drawing
correctly lands within the tolerance the scorer allows.

Run:  python3 eval/generate_corpus.py
"""

import json
import math
import os
import random

from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "corpus")
IMG = os.path.join(OUT, "images")
os.makedirs(IMG, exist_ok=True)

HAND = "/usr/share/fonts/opentype/comic-neue/ComicNeue-Italic.otf"
BOLD = "/usr/share/fonts/opentype/comic-neue/ComicNeue-Bold.otf"


def font(size, bold=False):
    try:
        return ImageFont.truetype(BOLD if bold else HAND, size)
    except OSError:
        return ImageFont.load_default()


class Sketch:
    def __init__(self, width, height, seed):
        self.w, self.h = width, height
        self.img = Image.new("RGB", (width, height), "white")
        self.d = ImageDraw.Draw(self.img)
        self.rng = random.Random(seed)
        self.nodes = []
        self.edges = []
        self._n = 0

    # --- ink ---------------------------------------------------------------
    def _j(self, amp=1.6):
        return self.rng.uniform(-amp, amp)

    def _line(self, a, b, width=3, amp=1.6, n=None):
        (x1, y1), (x2, y2) = a, b
        n = n or max(6, int(math.hypot(x2 - x1, y2 - y1) / 12))
        for i in range(n):
            t, t2 = i / n, (i + 1) / n
            self.d.line(
                [
                    x1 + (x2 - x1) * t + self._j(amp),
                    y1 + (y2 - y1) * t + self._j(amp),
                    x1 + (x2 - x1) * t2 + self._j(amp),
                    y1 + (y2 - y1) * t2 + self._j(amp),
                ],
                fill="black",
                width=width,
            )

    def _box(self, b, dashed=False):
        x, y, w, h = b
        pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]
        for i in range(4):
            if dashed:
                self._dashed(pts[i], pts[i + 1])
            else:
                self._line(pts[i], pts[i + 1])

    def _dashed(self, a, b, dash=9, gap=7):
        (x1, y1), (x2, y2) = a, b
        length = math.hypot(x2 - x1, y2 - y1)
        if length == 0:
            return
        ux, uy = (x2 - x1) / length, (y2 - y1) / length
        pos = 0.0
        while pos < length:
            end = min(pos + dash, length)
            self._line((x1 + ux * pos, y1 + uy * pos), (x1 + ux * end, y1 + uy * end), amp=0.8)
            pos = end + gap

    def _ellipse(self, b):
        x, y, w, h = b
        cx, cy, rx, ry = x + w / 2, y + h / 2, w / 2, h / 2
        prev = None
        for i in range(41):
            a = 2 * math.pi * i / 40
            p = (cx + rx * math.cos(a) + self._j(1.2), cy + ry * math.sin(a) + self._j(1.2))
            if prev:
                self._line(prev, p, amp=0.6, n=2)
            prev = p

    def _cylinder(self, b):
        x, y, w, h = b
        ry = h * 0.16
        self._ellipse((x, y, w, ry * 2))
        self._ellipse((x, y + h - ry * 2, w, ry * 2))
        self._line((x, y + ry), (x, y + h - ry))
        self._line((x + w, y + ry), (x + w, y + h - ry))

    def _diamond(self, b):
        x, y, w, h = b
        pts = [(x + w / 2, y), (x + w, y + h / 2), (x + w / 2, y + h), (x, y + h / 2), (x + w / 2, y)]
        for i in range(4):
            self._line(pts[i], pts[i + 1])

    def _text(self, xy, txt, size=22, bold=False):
        f = font(size, bold)
        x, y = xy
        for ch in txt:  # per-character jitter reads as handwriting
            bb = self.d.textbbox((0, 0), ch, font=f)
            self.d.text((x + self._j(0.9), y + self._j(1.1)), ch, font=f, fill="black")
            x += bb[2] - bb[0] + 1.2

    def text_width(self, txt, size=22):
        f = font(size)
        bb = self.d.textbbox((0, 0), txt, font=f)
        return bb[2] - bb[0]

    def _arrow(self, a, b, dashed=False):
        (x1, y1), (x2, y2) = a, b
        if dashed:
            self._dashed(a, b)
        else:
            self._line(a, b, amp=1.2)
        ang = math.atan2(y2 - y1, x2 - x1)
        for s in (2.55, -2.55):
            self._line(b, (x2 + 18 * math.cos(ang + s), y2 + 18 * math.sin(ang + s)), amp=0.6, n=3)

    # --- graph -------------------------------------------------------------
    def node(self, b, label, shape="rect", size=22, centred=True):
        x, y, w, h = b
        if shape == "rect":
            self._box(b)
        elif shape == "ellipse":
            self._ellipse(b)
        elif shape == "diamond":
            self._diamond(b)
        elif shape == "cylinder":
            self._cylinder(b)
        if label:
            tw = self.text_width(label, size)
            tx = x + (w - tw) / 2 if centred else x + 8
            ty = y + (h - size) / 2 - 2
            self._text((tx, ty), label, size)
        nid = f"n{len(self.nodes) + 1}"
        self.nodes.append({"id": nid, "label": label, "shape": shape, "bbox": {"x": x, "y": y, "w": w, "h": h}})
        return nid

    def edge(self, a, b, label=None, dashed=False):
        na = next(n for n in self.nodes if n["id"] == a)
        nb = next(n for n in self.nodes if n["id"] == b)
        ax, ay, aw, ah = (na["bbox"][k] for k in ("x", "y", "w", "h"))
        bx, by, bw, bh = (nb["bbox"][k] for k in ("x", "y", "w", "h"))
        start = (ax + aw if bx > ax else ax, ay + ah / 2)
        end = (bx if bx > ax else bx + bw, by + bh / 2)
        self._arrow(start, end, dashed)
        if label:
            self._text(((start[0] + end[0]) / 2 - 10, (start[1] + end[1]) / 2 - 26), label, 16)
        self.edges.append(
            {"from": a, "to": b, "label": label, "style": "dashed" if dashed else "solid"}
        )
        return self

    def save(self, name, difficulty, notes):
        img_path = os.path.join(IMG, f"{name}.png")
        self.img.save(img_path)
        doc = {
            "id": name,
            "difficulty": difficulty,
            "notes": notes,
            "image": os.path.relpath(img_path, os.path.dirname(__file__)),
            "width": self.w,
            "height": self.h,
            "expected": {"nodes": self.nodes, "edges": self.edges},
        }
        with open(os.path.join(OUT, f"{name}.json"), "w") as fh:
            json.dump(doc, fh, indent=2)
        print(f"  {name:22} {len(self.nodes)} nodes {len(self.edges)} edges  ({difficulty})")


def case_clean_flow():
    s = Sketch(1000, 560, 11)
    a = s.node((80, 90, 210, 90), "api-gateway")
    b = s.node((380, 90, 180, 90), "auth")
    c = s.node((380, 300, 180, 90), "worker")
    d = s.node((700, 300, 200, 90), "postgres")
    s.edge(a, b, "validate")
    s.edge(b, c, "retry 3x")
    s.edge(c, d, "write")
    s.save("clean-flow", "easy", "reference case: four boxes, three labelled arrows")


def case_shapes_mixed():
    s = Sketch(1000, 560, 22)
    a = s.node((70, 220, 200, 90), "ingest")
    b = s.node((400, 90, 150, 90), "redis", shape="ellipse")
    c = s.node((400, 330, 180, 110), "valid?", shape="diamond")
    d = s.node((720, 330, 200, 90), "reject")
    s.edge(a, b, "publish")
    s.edge(a, c)
    s.edge(c, d, "no")
    s.save("shapes-mixed", "medium", "ellipse and diamond must not be reported as rectangles")


def case_dashed_edges():
    s = Sketch(1000, 560, 33)
    a = s.node((80, 120, 200, 90), "client")
    b = s.node((420, 120, 200, 90), "cache")
    c = s.node((760, 120, 180, 90), "origin")
    s.edge(a, b, "hit")
    s.edge(b, c, "miss", dashed=True)
    s.save("dashed-edges", "medium", "one solid and one dashed arrow")


def case_dense():
    s = Sketch(1100, 680, 44)
    ids = []
    rows = [
        [("edge", 70, 70), ("cdn", 330, 70), ("waf", 590, 70)],
        [("api", 70, 280), ("auth", 330, 280), ("cache", 590, 280)],
        [("queue", 70, 490), ("worker", 330, 490), ("db", 590, 490)],
    ]
    for row in rows:
        line = []
        for label, x, y in row:
            line.append(s.node((x, y, 190, 80), label))
        ids.append(line)
    for r in range(3):
        for c in range(3):
            if c + 1 < 3:
                s.edge(ids[r][c], ids[r][c + 1])
    s.edge(ids[0][1], ids[1][1])
    s.edge(ids[1][2], ids[2][2])
    s.save("dense-grid", "hard", "nine nodes, eight edges, unlabelled arrows")


def case_small_text():
    s = Sketch(1000, 480, 55)
    a = s.node((90, 120, 190, 80), "svc-a", size=15)
    b = s.node((420, 120, 190, 80), "svc-b", size=15)
    c = s.node((750, 120, 190, 80), "svc-c", size=15)
    s.edge(a, b)
    s.edge(b, c)
    s.save("small-text", "hard", "15px labels: tests OCR on small handwriting")


def case_two_columns():
    s = Sketch(1000, 620, 66)
    left = [s.node((80, 80 + i * 150, 200, 80), t) for i, t in enumerate(["one", "two", "three"])]
    right = [s.node((640, 80 + i * 150, 220, 80), t) for i, t in enumerate(["alpha", "beta", "gamma"])]
    s.edge(left[0], right[0])
    s.edge(left[1], right[1])
    s.edge(left[2], right[2])
    s.edge(left[0], right[2], "skip")
    s.save("two-columns", "medium", "cross-links between columns, one labelled")


def case_no_edges():
    s = Sketch(900, 420, 77)
    s.node((80, 100, 210, 90), "frontend")
    s.node((360, 100, 210, 90), "api")
    s.node((640, 100, 200, 90), "db")
    s.save("no-edges", "easy", "labels only, no connections drawn")


def case_wide_labels():
    s = Sketch(1000, 500, 88)
    a = s.node((70, 140, 250, 90), "payment-service")
    b = s.node((420, 140, 250, 90), "ledger")
    s.edge(a, b, "post-ledger")
    s.save("wide-labels", "medium", "long labels in narrow boxes: wrapping traps")


def case_multi_target():
    """The reported drawing: two boxes and two databases, three arrows.

    The horizontal arrow to the far database went missing in real use. This case
    exists to tell whether the model drops it or the converter does."""
    s = Sketch(1100, 700, 123)
    front = s.node((80, 80, 240, 110), "Frontend")
    back = s.node((150, 290, 300, 150), "Backend")
    big = s.node((640, 250, 240, 210), "", shape="cylinder")
    small = s.node((480, 520, 130, 120), "", shape="cylinder")
    s.edge(front, back)
    s.edge(back, big)
    s.edge(back, small)
    s.save("multi-target", "medium", "2 boxes + 2 databases, 3 arrows, only 2 labelled boxes")


def case_unlabelled():
    """The real failure from testing: a bare box, a database cylinder and an
    arrow, with nothing written anywhere. Every other case had labels, which is
    how a converter bug that ate unlabelled shapes went unnoticed."""
    s = Sketch(900, 520, 99)
    a = s.node((70, 170, 220, 110), "")
    b = s.node((560, 120, 110, 140), "", shape="ellipse")
    s.edge(a, b)
    s.save("unlabelled", "easy", "no text at all: shapes must still be reported")


def main():
    print("writing corpus to", OUT)
    case_clean_flow()
    case_shapes_mixed()
    case_dashed_edges()
    case_dense()
    case_small_text()
    case_two_columns()
    case_no_edges()
    case_wide_labels()
    case_unlabelled()
    case_multi_target()
    print("done")


if __name__ == "__main__":
    main()
