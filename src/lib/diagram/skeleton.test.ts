import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/graph-sketch2.json";
import { DiagramGraph } from "./schema";
import { graphToSkeleton } from "./skeleton";
import { identityTransform, MIN_NODE_H, MIN_NODE_W } from "./layout";

const graph = DiagramGraph.parse(fixture);

/**
 * Skeleton entries are loose by design (they are partial elements), so tests
 * read the handful of fields they care about through this narrow shape.
 */
type S = {
  type: string;
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  label?: { text: string; verticalAlign?: string };
  start?: { id: string };
  end?: { id: string };
  points?: readonly (readonly [number, number])[];
};

describe("graph -> excalidraw skeleton", () => {
  const { skeleton, warnings } = graphToSkeleton(graph, identityTransform());
  const sk = skeleton as unknown as S[];
  const byId = new Map<string, S>(sk.map((s) => [s.id, s]));

  it("emits one container per node, one arrow per edge", () => {
    const types = sk.map((s) => s.type);
    expect(types.filter((t) => t === "rectangle")).toHaveLength(4);
    expect(types.filter((t) => t === "ellipse")).toHaveLength(1);
    expect(types.filter((t) => t === "arrow")).toHaveLength(2);
  });

  it("carries the label on the container so Excalidraw binds real text", () => {
    const redis = byId.get("n-redis-ttl-1")!;
    expect(redis.type).toBe("ellipse");
    expect(redis.label!.text).toBe("redis-ttl");
    expect(redis.label!.verticalAlign).toBe("middle");

    const publish = sk.find((s) => s.type === "arrow")!;
    expect(publish.label!.text).toBe("publish");
  });

  it("keeps the drawn positions, snapped to the grid", () => {
    const ingest = byId.get("n-ingest-svc-0")!;
    expect(ingest.x).toBe(70);
    expect(ingest.y).toBe(230);
    expect(ingest.width).toBe(220); // drawn 215
    expect(ingest.height).toBe(100); // drawn 95
  });

  it("binds arrows by element id, so drags keep the connection", () => {
    const arrows = sk.filter((s) => s.type === "arrow");
    for (const a of arrows) {
      expect(byId.has(a.start!.id)).toBe(true);
      expect(byId.has(a.end!.id)).toBe(true);
      const start = byId.get(a.start!.id)!;
      expect(start.type).toMatch(/rectangle|ellipse/);
    }
  });

  it("draws arrows from edge to edge, not centre to centre", () => {
    const arrow = sk.find((s) => s.type === "arrow" && s.start!.id === "n-order-svc-3")!;
    // order-svc sits directly above pg-replica: the arrow should run vertically
    // between their facing borders, so its x offset is ~0.
    expect(Math.abs(arrow.points![1][0])).toBeLessThan(1);
    expect(arrow.points![1][1]).toBeGreaterThan(100);
  });

  it("gives successive conversions disjoint ids", () => {
    // Two conversions on one canvas used to share ids, and the collision
    // silently unbound the arrows of the diagram already there.
    const first = graphToSkeleton(graph, identityTransform(), { idNamespace: "aaa111" });
    const second = graphToSkeleton(graph, identityTransform(), { idNamespace: "bbb222" });
    const idsFirst = (first.skeleton as unknown as S[]).map((s) => s.id);
    const idsSecond = (second.skeleton as unknown as S[]).map((s) => s.id);

    expect(idsFirst.every((id) => id.startsWith("aaa111-"))).toBe(true);
    expect(idsSecond.every((id) => id.startsWith("bbb222-"))).toBe(true);
    expect(idsFirst.filter((id) => idsSecond.includes(id))).toEqual([]);
  });

  it("keeps arrow bindings pointing at its own namespaced nodes", () => {
    const spaced = graphToSkeleton(graph, identityTransform(), { idNamespace: "zzz" });
    const sk = spaced.skeleton as unknown as S[];
    const ids = new Set(sk.map((s) => s.id));
    for (const el of sk.filter((s) => s.type === "arrow")) {
      expect(ids.has(el.start!.id)).toBe(true);
      expect(ids.has(el.end!.id)).toBe(true);
    }
  });

  it("is deterministic: same graph in, identical scene out", () => {
    const again = graphToSkeleton(graph, identityTransform());
    expect(JSON.stringify(again.skeleton)).toBe(JSON.stringify(skeleton));
  });

  it("drops arrows to shapes the model never detected", () => {
    const broken = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [{ id: "a", label: "only", shape: "rect", bbox: { x: 0, y: 0, w: 100, h: 60 } }],
        edges: [{ from: "a", to: "ghost" }, { from: "a", to: "a" }],
      }),
      identityTransform(),
    );
    expect((broken.skeleton as unknown as S[]).filter((s) => s.type === "arrow")).toHaveLength(0);
    expect(broken.warnings[0]).toContain("dropped 2 arrow(s)");
  });

  it("enforces a minimum clickable size on tiny detections", () => {
    const tiny = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [{ id: "a", label: "a", shape: "rect", bbox: { x: 0, y: 0, w: 4, h: 3 } }],
        edges: [],
      }),
      identityTransform(),
    );
    const node = tiny.skeleton[0] as S;
    expect(node.width).toBe(MIN_NODE_W);
    expect(node.height).toBe(MIN_NODE_H);
  });

  it("keeps an unlabelled shape a shape, not an invisible text element", () => {
    // Reported from real use: a box and a cylinder with nothing written in them
    // both came back as empty text elements and vanished from the canvas.
    const bare = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [
          { id: "a", label: "", shape: "rect", bbox: { x: 0, y: 0, w: 200, h: 100 } },
          { id: "b", label: "  ", shape: "ellipse", bbox: { x: 300, y: 0, w: 120, h: 120 } },
        ],
        edges: [],
      }),
      identityTransform(),
    );
    const els = bare.skeleton as unknown as S[];
    expect(els.map((e) => e.type)).toEqual(["rectangle", "ellipse"]);
    for (const el of els) {
      expect(el.label).toBeUndefined();
      expect(el.text).toBeUndefined();
    }
  });

  it("converts a free-floating label into a text element, not a box", () => {
    const free = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [{ id: "t", label: "retry 3x", shape: "text", bbox: { x: 10, y: 10, w: 90, h: 30 } }],
        edges: [],
      }),
      identityTransform(),
    );
    expect((free.skeleton[0] as S).type).toBe("text");
    expect((free.skeleton[0] as S).text).toBe("retry 3x");
  });

  it("reports overlap instead of silently moving the user's shapes", () => {
    const stacked = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [
          { id: "a", label: "api", shape: "rect", bbox: { x: 0, y: 0, w: 100, h: 100 } },
          { id: "b", label: "db", shape: "rect", bbox: { x: 5, y: 5, w: 100, h: 100 } },
        ],
        edges: [],
      }),
      identityTransform(),
    );
    expect(stacked.warnings.join(" ")).toContain("overlap");
    // ...and the position is untouched: fidelity beats tidiness.
    expect((stacked.skeleton[0] as S).x).toBe(0);
  });

  it("maps raster pixels through the transform instead of assuming 1:1", () => {
    const scaled = graphToSkeleton(graph, { scale: 2, originX: 1000, originY: 500, imageWidth: 768, imageHeight: 300 });
    const scaledSk = scaled.skeleton as unknown as S[];
    const ingest = scaledSk.find((s) => s.id === "n-ingest-svc-0")!;
    expect(ingest.x).toBe(1040); // 70px at scale 2 => 1035, snapped to the grid (half rounds up)
    expect(ingest.height).toBe(50); // 95px at scale 2, snapped
    expect(ingest.width).toBeGreaterThanOrEqual(110); // 215px at scale 2, possibly widened for the label
  });

  it("widens a box so its own label fits instead of wrapping it", () => {
    const narrow = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [
          { id: "a", label: "pg-replica", shape: "ellipse", bbox: { x: 0, y: 0, w: 100, h: 100 } },
        ],
        edges: [],
      }),
      identityTransform(),
    );
    const node = (narrow.skeleton as unknown as S[])[0];
    expect(node.width).toBeGreaterThan(100);
    expect(node.height).toBe(100);
  });

  it("builds a drawn database as a grouped cylinder, not a rectangle", () => {
    // Excalidraw has no cylinder element. Reporting one as a rectangle
    // replaces the drawing with the wrong shape, which is worse than useless.
    const drum = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [
          {
            id: "db",
            label: "orders",
            shape: "rect",
            symbol: "cylinder",
            bbox: { x: 100, y: 100, w: 200, h: 300 },
          },
        ],
        edges: [],
      }),
      identityTransform(),
    );
    const parts = drum.skeleton as unknown as S[] & Array<{ groupIds?: string[] }>;

    expect(parts.filter((p) => p.type === "ellipse")).toHaveLength(2);
    expect(parts.filter((p) => p.type === "line")).toHaveLength(2);

    const groups = new Set(
      parts
        .filter((p) => p.type !== "text")
        .map((p) => (p as unknown as { groupIds: string[] }).groupIds[0]),
    );
    expect(groups.size).toBe(1); // drags and resizes as one object

    // The node's own id stays on the top ellipse so arrows can bind to it.
    const top = parts.find((p) => p.type === "ellipse")!;
    expect(top.id).toBe("n-orders-0");
  });

  it("leaves a shape it cannot name as the user's ink", () => {
    const mystery = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [{ id: "x", label: "cloud", shape: "unknown", bbox: { x: 0, y: 0, w: 100, h: 80 } }],
        edges: [],
      }),
      identityTransform(),
    );
    expect(mystery.skeleton).toHaveLength(0);
    expect(mystery.warnings.join(" ")).toContain("not recognised");
  });

  it("drops an arrow whose endpoint was left unrecognised", () => {
    const partial = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [
          { id: "a", label: "api", shape: "rect", bbox: { x: 0, y: 0, w: 100, h: 80 } },
          { id: "b", label: "thing", shape: "unknown", bbox: { x: 300, y: 0, w: 100, h: 80 } },
        ],
        edges: [{ from: "a", to: "b" }],
      }),
      identityTransform(),
    );
    expect((partial.skeleton as unknown as S[]).filter((s) => s.type === "arrow")).toHaveLength(0);
  });

  it("builds a shape from parts — a drum, with no symbol vocabulary involved", () => {
    const drum = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [
          {
            id: "db",
            label: "",
            shape: "rect",
            bbox: { x: 0, y: 0, w: 200, h: 300 },
            parts: [
              { type: "ellipse", at: [0, 0, 1, 0.16] },
              { type: "ellipse", at: [0, 0.84, 1, 0.16] },
              { type: "line", at: [0, 0.08, 0, 0.84] },
              { type: "line", at: [1, 0.08, 0, 0.84] },
            ],
          },
        ],
        edges: [],
      }),
      identityTransform(),
    );
    const els = drum.skeleton as unknown as S[];
    expect(els.filter((e) => e.type === "ellipse")).toHaveLength(2);
    expect(els.filter((e) => e.type === "line")).toHaveLength(2);
    // The first shape carries the node id so arrows can bind.
    expect(els[0].id).toBe("n-rect-0");
    // Top ellipse is one sixth of the way down a 300-tall box.
    const top = els[0] as unknown as { height: number; y: number };
    expect(Math.round(top.height)).toBe(48); // 0.16 of a 300-tall box
  });

  it("builds a divided table from parts — the B-tree box", () => {
    const cells = ["1", "2", "3", "4", "5"];
    const table = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [
          {
            id: "root",
            label: "",
            shape: "rect",
            bbox: { x: 100, y: 100, w: 500, h: 100 },
            parts: [
              { type: "rect", at: [0, 0, 1, 1] },
              // four dividers, at 1/5 … 4/5
              { type: "line", at: [0.2, 0, 0, 1] },
              { type: "line", at: [0.4, 0, 0, 1] },
              { type: "line", at: [0.6, 0, 0, 1] },
              { type: "line", at: [0.8, 0, 0, 1] },
              ...cells.map((c, i) => ({ type: "text" as const, at: [i / 5, 0.3, 0.2, 0.4], text: c })),
            ],
          },
        ],
        edges: [],
      }),
      identityTransform(),
    );
    const els = table.skeleton as unknown as S[];
    expect(els.filter((e) => e.type === "line")).toHaveLength(4);
    expect(els.filter((e) => e.type === "text")).toHaveLength(5);
    expect(els.map((e) => e.text).filter(Boolean)).toEqual(cells);
    // First cell sits at the left edge of the box.
    const firstText = els.find((e) => e.text === "1") as unknown as { x: number };
    expect(Math.round(firstText.x)).toBe(100);
  });

  it("clamps a part that points outside its box", () => {
    const wild = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [
          {
            id: "x",
            label: "",
            shape: "rect",
            bbox: { x: 0, y: 0, w: 100, h: 100 },
            parts: [{ type: "rect", at: [-0.5, 2, 3, 1] }],
          },
        ],
        edges: [],
      }),
      identityTransform(),
    );
    const el = (wild.skeleton as unknown as S[])[0] as unknown as {
      x: number;
      y: number;
      width: number;
    };
    expect(el.x).toBe(0);
    expect(el.y).toBe(100); // clamped to the bottom edge, then snapped
    expect(el.width).toBe(100); // never three times the box
  });

  it("draws a divided box as adjacent rectangles sharing edges", () => {
    const row = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [
          {
            id: "root",
            label: "",
            shape: "rect",
            cells: 3,
            cellLabels: ["1", "2", "3"],
            labelPosition: "below",
            bbox: { x: 0, y: 0, w: 300, h: 100 },
          },
        ],
        edges: [],
      }),
      identityTransform(),
      { regularize: false },
    );
    const els = row.skeleton as unknown as S[];
    const rects = els.filter((e) => e.type === "rectangle");

    expect(rects).toHaveLength(3);
    // Cells share edges: each starts where the previous one ends.
    expect(rects.map((r) => Math.round((r as unknown as { x: number }).x))).toEqual([0, 100, 200]);
    expect(els.map((e) => e.text).filter(Boolean)).toEqual(["1", "2", "3"]);
  });

  it("puts a label under the shape when that is where it was drawn", () => {
    const under = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [
          {
            id: "a",
            label: "2",
            shape: "rect",
            labelPosition: "below",
            bbox: { x: 0, y: 0, w: 100, h: 60 },
          },
        ],
        edges: [],
      }),
      identityTransform(),
      { regularize: false },
    );
    const els = under.skeleton as unknown as S[];
    const container = els.find((e) => e.type === "rectangle")!;
    // No bound text: the label is a separate element below the box.
    expect(container.label).toBeUndefined();

    const text = els.find((e) => e.type === "text") as unknown as { y: number };
    expect(text.y).toBeGreaterThan(60);
  });

  it("keeps the label inside when no position is given", () => {
    const inside = graphToSkeleton(
      DiagramGraph.parse({
        nodes: [{ id: "a", label: "api", shape: "rect", bbox: { x: 0, y: 0, w: 100, h: 60 } }],
        edges: [],
      }),
      identityTransform(),
      { regularize: false },
    );
    const container = (inside.skeleton as unknown as S[]).find((e) => e.type === "rectangle")!;
    expect(container.label!.text).toBe("api");
  });

  it("says nothing when there was nothing to change", () => {
    expect(warnings).toEqual([]);
  });
});
