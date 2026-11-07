import { describe, expect, it } from "vitest";

import { clusterStrokes, strokesToConsume } from "./consume";

const box = (x: number, y: number, w = 40, h = 30) => ({ x, y, w, h });

describe("clusterStrokes", () => {
  it("treats the four strokes of a drawn box as one drawing", () => {
    const strokes = [
      { id: "top", box: box(0, 0, 100, 2) },
      { id: "right", box: box(98, 0, 2, 60) },
      { id: "bottom", box: box(0, 58, 100, 2) },
      { id: "left", box: box(0, 0, 2, 60) },
    ];
    expect(clusterStrokes(strokes)).toHaveLength(1);
  });

  it("keeps two drawings far apart separate", () => {
    const strokes = [
      { id: "box", box: box(0, 0, 100, 100) },
      { id: "icon", box: box(300, 0, 40, 40) },
    ];
    expect(clusterStrokes(strokes)).toHaveLength(2);
  });

  it("groups a label with the box it sits in", () => {
    const strokes = [
      { id: "outline", box: box(0, 0, 200, 100) },
      { id: "label", box: box(60, 40, 70, 20) },
    ];
    expect(clusterStrokes(strokes)).toHaveLength(1);
  });
});

describe("strokesToConsume", () => {
  const boxStroke = { id: "box-stroke", box: box(0, 0, 200, 100) };
  const dbStroke = { id: "db-stroke", box: box(300, 0, 60, 80) };

  it("consumes strokes the detected shapes cover", () => {
    const decision = strokesToConsume([boxStroke, dbStroke], [
      box(0, 0, 200, 100),
      box(300, 0, 60, 80),
    ]);
    expect(decision.consume).toEqual(["box-stroke", "db-stroke"]);
    expect(decision.keep).toEqual([]);
  });

  it("keeps the drawing the model never mentioned — the real bug", () => {
    // Two things drawn, one shape returned. The icon's strokes are nowhere
    // near the detected box, so they must survive.
    const decision = strokesToConsume([boxStroke, dbStroke], [box(0, 0, 200, 100)]);
    expect(decision.clusters).toBe(2);
    expect(decision.consume).toEqual(["box-stroke"]);
    expect(decision.keep).toEqual(["db-stroke"]);
  });

  it("keeps an arrow when the result has no edge to explain it", () => {
    const arrow = { id: "arrow", box: box(210, 40, 80, 10) };
    const decision = strokesToConsume([boxStroke, arrow], [box(0, 0, 200, 100)]);
    expect(decision.consume).toEqual(["box-stroke"]);
    expect(decision.keep).toEqual(["arrow"]);
  });

  it("consumes an arrow when a detected edge runs through it", () => {
    const arrow = { id: "arrow", box: box(210, 40, 80, 10) };
    const from = box(0, 0, 200, 100);
    const to = box(400, 0, 200, 100);
    const decision = strokesToConsume([boxStroke, arrow], [from, to], [{ from, to }]);
    expect(decision.consume).toEqual(["box-stroke", "arrow"]);
  });

  it("does not let a diagonal edge swallow a neighbouring arrow — the reported bug", () => {
    // Backend with a diagonal edge down to a small database, and a horizontal
    // arrow going right to a big database that the model missed. The union box
    // of the diagonal pair used to cover the horizontal arrow, which then
    // vanished with nothing to replace it.
    const backend = box(150, 290, 300, 150);
    const smallDb = box(480, 520, 130, 120);
    const horizontalArrow = { id: "to-big-db", box: box(455, 355, 180, 30) };

    const decision = strokesToConsume(
      [{ id: "backend", box: backend }, horizontalArrow, { id: "small-db", box: smallDb }],
      [backend, smallDb],
      [{ from: backend, to: smallDb }],
    );

    expect(decision.keep).toContain("to-big-db");
    expect(decision.consume).toContain("backend");
  });

  it("keeps an icon inside a box that the model merged into it", () => {
    // The merged case: a database symbol inside a service box, reported as one
    // node. The symbol sits outside the reported bbox, so it survives.
    const icon = { id: "icon", box: box(700, 20, 50, 60) };
    const decision = strokesToConsume([boxStroke, icon], [box(0, 0, 200, 100)]);
    expect(decision.keep).toEqual(["icon"]);
  });
});
