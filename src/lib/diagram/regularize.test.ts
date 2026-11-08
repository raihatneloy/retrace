import { describe, expect, it } from "vitest";

import { regularize } from "./regularize";
import type { SceneBox } from "./layout";
import type { DiagramGraph } from "./schema";

const b = (x: number, y: number, w = 100, h = 60): SceneBox => ({ x, y, w, h });

const graph = (edges: Array<{ from: string; to: string }> = []): DiagramGraph => ({
  nodes: [],
  edges: edges.map((e) => ({ ...e, label: null, style: "solid" as const, arrowhead: true })),
  notes: null,
});

describe("regularize", () => {
  it("sets a nearly-aligned row onto one line", () => {
    const boxes = new Map([
      ["a", b(100, 200)],
      ["b", b(260, 206)],
      ["c", b(420, 196)],
    ]);
    const { boxes: out, report } = regularize(graph(), boxes);
    const ys = [...out.values()].map((x) => Math.round(x.y));
    expect(new Set(ys).size).toBe(1);
    expect(report.rows).toBe(1);
    expect(report.applied).toBe(true);
  });

  it("equalises the gaps in a row", () => {
    const boxes = new Map([
      ["a", b(100, 200)],
      ["b", b(240, 200)], // gap 40
      ["c", b(420, 200)], // gap 80
    ]);
    const { boxes: out } = regularize(graph(), boxes);
    const gaps = [
      out.get("b")!.x - (out.get("a")!.x + out.get("a")!.w),
      out.get("c")!.x - (out.get("b")!.x + out.get("b")!.w),
    ];
    expect(Math.abs(gaps[0] - gaps[1])).toBeLessThan(1);
  });

  it("centres children under their parent", () => {
    // A tree whose children are bunched to the right.
    const boxes = new Map([
      ["p", b(400, 100, 300, 80)],
      ["l", b(500, 300)],
      ["r", b(560, 300)],
    ]);
    const { boxes: out, report } = regularize(
      graph([
        { from: "p", to: "l" },
        { from: "p", to: "r" },
      ]),
      boxes,
    );
    const centre = (x: SceneBox) => x.x + x.w / 2;
    const mid = (centre(out.get("l")!) + centre(out.get("r")!)) / 2;
    expect(Math.abs(mid - centre(out.get("p")!))).toBeLessThan(2);
    expect(report.trees).toBe(1);
  });

  it("refuses to move a deliberately scattered layout", () => {
    // Nothing aligns, so snapping would relocate things the author placed.
    const boxes = new Map([
      ["a", b(100, 100)],
      ["b", b(600, 380)],
      ["c", b(180, 620)],
    ]);
    const { boxes: out, report } = regularize(graph(), boxes);
    expect(report.applied).toBe(false);
    expect(out.get("a")).toEqual(boxes.get("a"));
    expect(report.reason).toMatch(/nothing regular/);
  });

  it("refuses a row whose clean version would relocate a shape", () => {
    // Three on one line, but one is parked miles away. Equalising the gaps would
    // move it far enough that the author clearly meant it there.
    const boxes = new Map([
      ["a", b(0, 200)],
      ["b", b(110, 200)],
      ["c", b(3000, 200)],
    ]);
    const { boxes: out, report } = regularize(graph(), boxes);
    expect(report.applied).toBe(false);
    expect(report.reason).toMatch(/irregular/);
    expect(out.get("c")).toEqual(boxes.get("c"));
  });

  it("leaves a single shape alone", () => {
    const { report } = regularize(graph(), new Map([["a", b(0, 0)]]));
    expect(report.applied).toBe(false);
    expect(report.reason).toBe("single shape");
  });
});
