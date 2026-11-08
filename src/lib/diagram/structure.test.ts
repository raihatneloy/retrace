import { describe, expect, it } from "vitest";

import { layoutGraph } from "./structure";
import { identityTransform, type RasterTransform } from "./layout";
import { DiagramGraph } from "./schema";

const t: RasterTransform = identityTransform(1000, 1000);

/** Plenty of room: the canvas fallback is 920x920 at 1:1. */
const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  shape: "rect" as const,
  ...extra,
});

const graph = (g: unknown) => DiagramGraph.parse(g);

describe("layoutGraph", () => {
  it("spaces a row evenly with no coordinates from the model", () => {
    const g = graph({
      nodes: [node("a"), node("b"), node("c")],
      groups: [{ id: "g1", axis: "row", members: ["a", "b", "c"] }],
    });
    const { boxes, report } = layoutGraph(g, t);

    const a = boxes.get("a")!;
    const b = boxes.get("b")!;
    const c = boxes.get("c")!;

    // Same line, equal widths, equal gaps — arithmetic, not estimation.
    expect(a.y).toBe(b.y);
    expect(b.y).toBe(c.y);
    expect(b.x - (a.x + a.w)).toBe(c.x - (b.x + b.w));
    expect(report.structured).toBe(3);
    expect(report.freeform).toBe(0);
  });

  it("keeps row members a sensible height instead of filling the band", () => {
    const g = graph({
      nodes: [node("a"), node("b")],
      groups: [{ id: "g1", axis: "row", members: ["a", "b"] }],
    });
    const { boxes } = layoutGraph(g, t);
    // The root band is ~920 tall; boxes must not become 920-tall slabs.
    expect(boxes.get("a")!.h).toBeLessThanOrEqual(120);
    expect(boxes.get("a")!.h).toBeGreaterThanOrEqual(50);
  });

  it("gives a three-cell row three times the width of a plain box", () => {
    const g = graph({
      nodes: [node("wide", { cells: 3, cellLabels: ["1", "2", "3"] }), node("narrow")],
      groups: [{ id: "g1", axis: "row", members: ["wide", "narrow"] }],
    });
    const { boxes } = layoutGraph(g, t);
    expect(boxes.get("wide")!.w).toBeGreaterThan(boxes.get("narrow")!.w * 2);
  });

  it("stacks root clusters down the canvas — a tree from structure alone", () => {
    const g = graph({
      nodes: [node("r1"), node("r2"), node("r3")],
      groups: [
        { id: "top", axis: "row", members: ["r1"] },
        { id: "mid", axis: "row", members: ["r2"] },
        { id: "bottom", axis: "row", members: ["r3"] },
      ],
    });
    const { boxes } = layoutGraph(g, t);
    expect(boxes.get("r1")!.y).toBeLessThan(boxes.get("r2")!.y);
    expect(boxes.get("r2")!.y).toBeLessThan(boxes.get("r3")!.y);
  });

  it("tidies a crooked row inside the area it already occupies", () => {
    const g = graph({
      nodes: [
        node("a", { bbox: { x: 0.1, y: 0.2, w: 0.1, h: 0.1 } }),
        node("b", { bbox: { x: 0.3, y: 0.23, w: 0.1, h: 0.1 } }),
        node("c", { bbox: { x: 0.55, y: 0.19, w: 0.1, h: 0.1 } }),
      ],
      groups: [{ id: "g1", axis: "row", members: ["a", "b", "c"] }],
    });
    const { boxes } = layoutGraph(g, t);

    const ys = ["a", "b", "c"].map((id) => boxes.get(id)!.y);
    expect(new Set(ys).size).toBe(1);
    // The cluster stays where it was: it does not jump to the canvas origin.
    expect(boxes.get("a")!.x).toBeGreaterThan(60);
    expect(boxes.get("a")!.y).toBeGreaterThan(150);
  });

  it("leaves ungrouped shapes exactly where they were drawn", () => {
    const drawn = { x: 0.4, y: 0.6, w: 0.12, h: 0.08 };
    const g = graph({
      nodes: [node("a"), node("b", { bbox: drawn })],
      groups: [{ id: "g1", axis: "row", members: ["a"] }],
    });
    const { boxes, report } = layoutGraph(g, t);
    // 0.4 * 1000 = 400, snapped to the 10 grid.
    expect(boxes.get("b")).toEqual({ x: 400, y: 600, w: 120, h: 80 });
    expect(report.freeform).toBe(1);
  });

  it("nests rows inside a column — tiers of services", () => {
    const g = graph({
      nodes: [node("client"), node("s1"), node("s2"), node("db")],
      groups: [
        { id: "tier1", axis: "row", members: ["client"] },
        { id: "tier2", axis: "row", members: ["s1", "s2"] },
        { id: "tier3", axis: "row", members: ["db"] },
        { id: "stack", axis: "column", members: ["tier1", "tier2", "tier3"] },
      ],
    });
    const { boxes } = layoutGraph(g, t);
    const y = (id: string) => boxes.get(id)!.y;
    expect(y("client")).toBeLessThan(y("s1"));
    // Services share a line with each other.
    expect(boxes.get("s1")!.y).toBe(boxes.get("s2")!.y);
    expect(y("s2")).toBeLessThan(y("db"));
  });

  it("survives a group that refers to itself", () => {
    const g = graph({
      nodes: [node("a")],
      groups: [{ id: "g1", axis: "row", members: ["a", "g1"] }],
    });
    const { report } = layoutGraph(g, t);
    expect(report.warnings.join(" ")).toMatch(/itself/);
  });

  it("keeps a shape in the first group that claims it", () => {
    const g = graph({
      nodes: [node("a"), node("b")],
      groups: [
        { id: "g1", axis: "row", members: ["a"] },
        { id: "g2", axis: "row", members: ["a", "b"] },
      ],
    });
    const { report } = layoutGraph(g, t);
    expect(report.warnings.join(" ")).toMatch(/two groups/);
  });

  it("handles a big messy drawing without NaN, overlap storms or a hang", () => {
    // 60 shapes: four tidy rows, one nested tier, and the rest loose.
    const nodes = Array.from({ length: 60 }, (_, i) => node(`n${i}`));
    const rows = [0, 1, 2, 3].map((r) => ({
      id: `row${r}`,
      axis: "row" as const,
      members: Array.from({ length: 8 }, (_, i) => `n${r * 8 + i}`),
    }));
    const g = graph({
      nodes,
      groups: [...rows, { id: "stack", axis: "column", members: rows.map((r) => r.id) }],
    });

    const started = Date.now();
    const { boxes, overlaps, report } = layoutGraph(g, t);
    const elapsed = Date.now() - started;

    expect(boxes.size).toBe(60);
    expect(report.structured).toBe(60);
    expect(elapsed).toBeLessThan(500);
    for (const b of boxes.values()) {
      expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
      expect(b.w).toBeGreaterThan(0);
      expect(b.h).toBeGreaterThan(0);
    }
    // A tidy 8-wide grid must not pile shapes on top of each other.
    expect(overlaps.length).toBeLessThan(4);
  });

  it("places a child inside its container", () => {
    const g = graph({
      nodes: [
        node("cluster", { bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }),
        node("pod", { container: "cluster" }),
      ],
    });
    const { boxes } = layoutGraph(g, t);
    const outer = boxes.get("cluster")!;
    const inner = boxes.get("pod")!;
    expect(inner.x).toBeGreaterThanOrEqual(outer.x);
    expect(inner.y).toBeGreaterThanOrEqual(outer.y);
    expect(inner.x + inner.w).toBeLessThanOrEqual(outer.x + outer.w);
  });

  it("places a shape with no group and no coordinates instead of dropping it", () => {
    const g = graph({ nodes: [node("lonely")] });
    const { boxes, report } = layoutGraph(g, t);
    expect(boxes.size).toBe(1);
    expect(report.unplaced).toEqual(["lonely"]);
    expect(report.warnings.join(" ")).toMatch(/placed below/);
  });

  it("never loses a shape in a partly-structured drawing", () => {
    const g = graph({
      nodes: [node("a"), node("b"), node("loose1"), node("loose2")],
      groups: [{ id: "g1", axis: "row", members: ["a", "b"] }],
    });
    const { boxes } = layoutGraph(g, t);
    expect(boxes.size).toBe(4);
  });
});
