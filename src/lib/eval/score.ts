import type { DiagramGraph, BBox } from "../diagram/schema";
import { identityTransform, toRasterPixels } from "../diagram/layout";

/**
 * Scoring a conversion against ground truth.
 *
 * The point is to turn "looks about right" into numbers that move when we change
 * one thing. Everything here is pure so the harness can run it anywhere.
 */

export type TruthNode = {
  id: string;
  label: string;
  shape: string;
  bbox: { x: number; y: number; w: number; h: number };
};
export type TruthEdge = { from: string; to: string; label: string | null; style?: string };
export type Truth = { nodes: TruthNode[]; edges: TruthEdge[] };

export type CaseResult = {
  id: string;
  difficulty: string;
  nodes: { expected: number; predicted: number; matched: number };
  edges: { expected: number; predicted: number; matched: number };
  labelExact: number;
  labelFuzzy: number;
  shapeCorrect: number;
  meanIoU: number;
  meanCentreErrorPx: number;
  hallucinatedLabels: string[];
  missingLabels: string[];
  wrongLabels: Array<{ expected: string; got: string }>;
  /** Close enough to be a misread character, not close enough to be exact. */
  nearMisses: Array<{ expected: string; got: string; similarity: number }>;
  unmatchedEdges: Array<{ from: string; to: string }>;
  inventedEdges: Array<{ from: string; to: string }>;
};

export type Summary = {
  cases: number;
  nodeRecall: number;
  nodePrecision: number;
  labelExact: number;
  labelFuzzy: number;
  shapeAccuracy: number;
  meanIoU: number;
  meanCentreErrorPx: number;
  edgeRecall: number;
  edgePrecision: number;
};

const norm = (s: string | null | undefined): string =>
  (s ?? "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "")
    .trim();

function iou(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Levenshtein distance, used to separate "misread a character" from "wrong word". */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/**
 * Pairs expected nodes with predicted ones, best overlap first. A predicted box
 * counts as the same shape only when it overlaps the drawn one — this is what
 * stops a model that lays everything out in a tidy grid from scoring well.
 */
function matchNodes(
  truth: TruthNode[],
  predicted: TruthNode[],
): Array<{ t: TruthNode; p: TruthNode; iou: number }> {
  const pairs: Array<{ ti: number; pi: number; iou: number }> = [];
  truth.forEach((t, ti) => {
    predicted.forEach((p, pi) => {
      const score = iou(t.bbox, p.bbox);
      if (score >= 0.3) pairs.push({ ti, pi, iou: score });
    });
  });
  pairs.sort((a, b) => b.iou - a.iou);

  const usedT = new Set<number>();
  const usedP = new Set<number>();
  const out: Array<{ t: TruthNode; p: TruthNode; iou: number }> = [];
  for (const pair of pairs) {
    if (usedT.has(pair.ti) || usedP.has(pair.pi)) continue;
    usedT.add(pair.ti);
    usedP.add(pair.pi);
    out.push({ t: truth[pair.ti], p: predicted[pair.pi], iou: pair.iou });
  }
  return out;
}

export function scoreCase(
  id: string,
  difficulty: string,
  truth: Truth,
  predicted: DiagramGraph,
  image: { width: number; height: number } = { width: 1000, height: 1000 },
): CaseResult {
  const t = { ...identityTransform(image.width, image.height) };
  const predictedNodes: TruthNode[] = predicted.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    shape: n.shape,
    bbox: toRasterPixels(n.bbox as BBox, t),
  }));
  const matches = matchNodes(truth.nodes, predictedNodes);

  let labelExact = 0;
  let labelFuzzy = 0;
  let shapeCorrect = 0;
  let iouSum = 0;
  let centreSum = 0;
  const wrongLabels: Array<{ expected: string; got: string }> = [];
  const nearMisses: Array<{ expected: string; got: string; similarity: number }> = [];

  for (const m of matches) {
    const a = norm(m.t.label);
    const b = norm(m.p.label);
    if (a === b) labelExact++;
    const sim = similarity(a, b);
    if (sim >= 0.8) {
      labelFuzzy++;
      if (a !== b) nearMisses.push({ expected: m.t.label, got: m.p.label, similarity: +sim.toFixed(2) });
    } else {
      wrongLabels.push({ expected: m.t.label, got: m.p.label });
    }
    if (m.t.shape === m.p.shape) shapeCorrect++;
    iouSum += m.iou;
    const cx1 = m.t.bbox.x + m.t.bbox.w / 2;
    const cy1 = m.t.bbox.y + m.t.bbox.h / 2;
    const cx2 = m.p.bbox.x + m.p.bbox.w / 2;
    const cy2 = m.p.bbox.y + m.p.bbox.h / 2;
    centreSum += Math.hypot(cx2 - cx1, cy2 - cy1);
  }

  const matchedT = new Set(matches.map((m) => m.t.id));
  const matchedP = new Set(matches.map((m) => m.p.id));
  const missingLabels = truth.nodes.filter((t) => !matchedT.has(t.id)).map((t) => t.label || "(unlabelled)");
  const hallucinatedLabels = predictedNodes
    .filter((p) => !matchedP.has(p.id))
    .map((p) => p.label || `(${p.shape})`);

  // Edges are matched through the node pairing, so an edge only scores when both
  // its endpoints were correctly identified.
  const toTruth = new Map(matches.map((m) => [m.p.id, m.t.id]));
  const edgeKey = (a: string, b: string) => `${a}->${b}`;
  const expectedEdges = new Set(truth.edges.map((e) => edgeKey(e.from, e.to)));
  const gotEdges = new Set(
    predicted.edges
      .map((e) => {
        const from = toTruth.get(e.from);
        const to = toTruth.get(e.to);
        return from && to ? edgeKey(from, to) : null;
      })
      .filter((k): k is string => k !== null),
  );

  const matchedEdges = [...gotEdges].filter((k) => expectedEdges.has(k));
  const unmatchedEdges = [...expectedEdges]
    .filter((k) => !gotEdges.has(k))
    .map((k) => {
      const [from, to] = k.split("->");
      return { from, to };
    });
  const inventedEdges = [...gotEdges]
    .filter((k) => !expectedEdges.has(k))
    .map((k) => {
      const [from, to] = k.split("->");
      return { from, to };
    });

  return {
    id,
    difficulty,
    nodes: { expected: truth.nodes.length, predicted: predictedNodes.length, matched: matches.length },
    edges: { expected: truth.edges.length, predicted: predicted.edges.length, matched: matchedEdges.length },
    labelExact,
    labelFuzzy,
    shapeCorrect,
    meanIoU: matches.length ? iouSum / matches.length : 0,
    meanCentreErrorPx: matches.length ? centreSum / matches.length : 0,
    hallucinatedLabels,
    missingLabels,
    wrongLabels,
    nearMisses,
    unmatchedEdges,
    inventedEdges,
  };
}

export type AggregateInput = { weights?: { labels?: number; shapes?: number; edges?: number } } & {
  results?: CaseResult[];
};

/** Micro-average: sum the counts, then divide, so big cases count as much as they weigh. */
export function summarise(results: CaseResult[]): Summary {
  const sum = (f: (r: CaseResult) => number) => results.reduce((acc, r) => acc + f(r), 0);

  const matched = sum((r) => r.nodes.matched);
  const expectedNodes = sum((r) => r.nodes.expected);
  const predictedNodes = sum((r) => r.nodes.predicted);
  const expectedEdges = sum((r) => r.edges.expected);
  const predictedEdges = sum((r) => r.edges.predicted);
  const matchedEdges = sum((r) => r.edges.matched);

  const weighted = (f: (r: CaseResult) => number) => {
    const total = results.reduce((acc, r) => acc + (r.nodes.matched || 0), 0);
    if (!total) return 0;
    return results.reduce((acc, r) => acc + f(r) * r.nodes.matched, 0) / total;
  };

  return {
    cases: results.length,
    nodeRecall: expectedNodes ? matched / expectedNodes : 0,
    nodePrecision: predictedNodes ? matched / predictedNodes : 0,
    labelExact: weighted((r) => (r.nodes.matched ? r.labelExact / r.nodes.matched : 0)),
    labelFuzzy: weighted((r) => (r.nodes.matched ? r.labelFuzzy / r.nodes.matched : 0)),
    shapeAccuracy: weighted((r) => (r.nodes.matched ? r.shapeCorrect / r.nodes.matched : 0)),
    meanIoU: weighted((r) => r.meanIoU),
    meanCentreErrorPx: weighted((r) => r.meanCentreErrorPx),
    edgeRecall: expectedEdges ? matchedEdges / expectedEdges : 0,
    edgePrecision: predictedEdges ? matchedEdges / predictedEdges : 0,
  };
}
