import { describe, expect, it } from "vitest";

import { scoreCase, summarise, similarity } from "./score";
import type { DiagramGraph } from "../diagram/schema";
import type { Truth } from "./score";

const truth: Truth = {
  nodes: [
    { id: "n1", label: "api-gateway", shape: "rect", bbox: { x: 0, y: 0, w: 200, h: 90 } },
    { id: "n2", label: "auth", shape: "rect", bbox: { x: 400, y: 0, w: 200, h: 90 } },
  ],
  edges: [{ from: "n1", to: "n2", label: "validate" }],
};

const perfect: DiagramGraph = {
  nodes: [
    { id: "a", label: "api-gateway", shape: "rect", bbox: { x: 2, y: 1, w: 198, h: 92 } },
    { id: "b", label: "auth", shape: "rect", bbox: { x: 401, y: 2, w: 197, h: 88 } },
  ],
  edges: [{ from: "a", to: "b", label: "validate", style: "solid", arrowhead: true }],
  notes: null,
};

describe("similarity", () => {
  it("treats a one-character misread as close", () => {
    expect(similarity("redis-ttl", "redis-tt")).toBeGreaterThan(0.8);
  });
  it("treats a different word as far", () => {
    expect(similarity("postgres", "worker")).toBeLessThan(0.5);
  });
});

describe("scoreCase", () => {
  it("gives full marks for a faithful conversion", () => {
    const r = scoreCase("t", "easy", truth, perfect);
    expect(r.nodes.matched).toBe(2);
    expect(r.labelExact).toBe(2);
    expect(r.shapeCorrect).toBe(2);
    expect(r.edges.matched).toBe(1);
    expect(r.hallucinatedLabels).toEqual([]);
    expect(r.missingLabels).toEqual([]);
    expect(r.meanCentreErrorPx).toBeLessThan(3);
  });

  it("separates a misread character from a wrong word", () => {
    const misread: DiagramGraph = {
      ...perfect,
      nodes: [
        { ...perfect.nodes[0], label: "api-gatewa" },
        perfect.nodes[1],
      ],
    };
    const r = scoreCase("t", "easy", truth, misread);
    expect(r.labelExact).toBe(1); // one exact, one not
    expect(r.labelFuzzy).toBe(2); // both close
    expect(r.wrongLabels).toEqual([]);
  });

  it("does not count a split word as a misread label", () => {
    // Observed for real: "reject" came back as "r eject". The word is the same
    // word, so this must not be scored as an error.
    const splitTruth: Truth = {
      nodes: [truth.nodes[0], { ...truth.nodes[1], label: "reject" }],
      edges: [],
    };
    const split: DiagramGraph = {
      ...perfect,
      nodes: [perfect.nodes[0], { ...perfect.nodes[1], label: "r eject" }],
      edges: [],
    };
    const r = scoreCase("t", "easy", splitTruth, split);
    expect(r.labelExact).toBe(2);
    expect(r.nearMisses).toEqual([]);
  });

  it("surfaces a near-miss label rather than hiding it", () => {
    const nearTruth: Truth = {
      nodes: [truth.nodes[0], { ...truth.nodes[1], label: "postgres" }],
      edges: [],
    };
    const near: DiagramGraph = {
      ...perfect,
      nodes: [perfect.nodes[0], { ...perfect.nodes[1], label: "postgrest" }],
      edges: [],
    };
    const r = scoreCase("t", "easy", nearTruth, near);
    expect(r.labelExact).toBe(1);
    expect(r.nearMisses).toEqual([{ expected: "postgres", got: "postgrest", similarity: 0.89 }]);
  });

  it("counts an invented node as a precision problem, not a recall one", () => {
    const extra: DiagramGraph = {
      ...perfect,
      nodes: [...perfect.nodes, { id: "c", label: "ghost", shape: "rect", bbox: { x: 800, y: 300, w: 100, h: 80 } }],
    };
    const r = scoreCase("t", "easy", truth, extra);
    expect(r.nodes.matched).toBe(2);
    expect(r.nodes.predicted).toBe(3);
    expect(r.hallucinatedLabels).toEqual(["ghost"]);
  });

  it("refuses to credit a shape that was moved", () => {
    // What a model does when it "tidies up" instead of transcribing.
    const relaid: DiagramGraph = {
      ...perfect,
      nodes: [
        { ...perfect.nodes[0], bbox: { x: 600, y: 400, w: 200, h: 90 } },
        { ...perfect.nodes[1], bbox: { x: 900, y: 400, w: 200, h: 90 } },
      ],
    };
    const r = scoreCase("t", "easy", truth, relaid);
    expect(r.nodes.matched).toBe(0);
    expect(r.labelExact).toBe(0);
  });

  it("only counts an edge when both endpoints were identified", () => {
    const renamed: DiagramGraph = {
      ...perfect,
      edges: [{ from: "a", to: "nope", label: "validate", style: "solid", arrowhead: true }],
    };
    const r = scoreCase("t", "easy", truth, renamed);
    expect(r.edges.matched).toBe(0);
    expect(r.unmatchedEdges).toEqual([{ from: "n1", to: "n2" }]);
  });

  it("reports an edge pointing the wrong way as invented, not matched", () => {
    const reversed: DiagramGraph = {
      ...perfect,
      edges: [{ from: "b", to: "a", label: "validate", style: "solid", arrowhead: true }],
    };
    const r = scoreCase("t", "easy", truth, reversed);
    expect(r.edges.matched).toBe(0);
    expect(r.inventedEdges).toEqual([{ from: "n2", to: "n1" }]);
  });
});

describe("summarise", () => {
  it("micro-averages across cases", () => {
    const a = scoreCase("a", "easy", truth, perfect);
    const b = scoreCase("b", "hard", truth, { ...perfect, nodes: [perfect.nodes[0]] as never, edges: [] });
    const s = summarise([a, b]);
    expect(s.cases).toBe(2);
    expect(s.nodeRecall).toBeCloseTo(3 / 4);
    expect(s.edgeRecall).toBeCloseTo(1 / 2);
  });
});
