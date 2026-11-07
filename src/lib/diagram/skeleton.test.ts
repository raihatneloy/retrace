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

  it("says nothing when there was nothing to change", () => {
    expect(warnings).toEqual([]);
  });
});
