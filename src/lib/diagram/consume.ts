import { centerOf, type SceneBox } from "./layout";

/**
 * Deciding what the conversion actually replaced.
 *
 * The naive rule — "delete the strokes we sent" — destroys work whenever the
 * model under-detects: send two drawings, get one shape back, and the other is
 * gone. Instead, work out which strokes the answer *explains* and remove only
 * those.
 */

export type StrokeBox = {
  id: string;
  box: SceneBox;
  /**
   * The ink itself, in scene coordinates. Without it we can only sample the
   * bounding box — and a wobbly hand-drawn arrow's box is much wider than its
   * line, so it reads as "not covered" and survives while a converted arrow is
   * drawn on top of it. Two marks of the same arrow is the duplicate the user sees.
   */
  points?: ReadonlyArray<readonly [number, number]>;
};
export type Region = { box: SceneBox };

const PAD_NODE = 10;
const PAD_EDGE = 34;

/**
 * Fraction of a stroke's area that falls inside any region, by sampling. Sampling
 * a grid rather than summing intersections matters because corridors now consist
 * of many overlapping boxes, and summing would count the same pixel repeatedly.
 */
function coveredRatio(stroke: StrokeBox, regions: Region[]): number {
  const inside = (x: number, y: number) =>
    regions.some(
      (r) => x >= r.box.x && x <= r.box.x + r.box.w && y >= r.box.y && y <= r.box.y + r.box.h,
    );

  // Preferred: sample the actual ink. A stroke is "explained" when the answer
  // covers its path, not when it covers its bounding box.
  if (stroke.points?.length) {
    let hits = 0;
    for (const [x, y] of stroke.points) if (inside(x, y)) hits++;
    return hits / stroke.points.length;
  }

  const N = 5;
  let hits = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = stroke.box.x + (stroke.box.w * (i + 0.5)) / N;
      const y = stroke.box.y + (stroke.box.h * (j + 0.5)) / N;
      if (inside(x, y)) hits++;
    }
  }
  return hits / (N * N);
}

/** Groups strokes that belong to the same drawing, for reporting. */
export function clusterStrokes(strokes: StrokeBox[], margin = 12): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const s of strokes) parent.set(s.id, s.id);

  for (let i = 0; i < strokes.length; i++) {
    for (let j = i + 1; j < strokes.length; j++) {
      const a = strokes[i].box;
      const b = strokes[j].box;
      const touching =
        a.x - margin < b.x + b.w &&
        b.x - margin < a.x + a.w &&
        a.y - margin < b.y + b.h &&
        b.y - margin < a.y + a.h;
      if (touching) {
        const ra = find(strokes[i].id);
        const rb = find(strokes[j].id);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const s of strokes) {
    const root = find(s.id);
    groups.set(root, [...(groups.get(root) ?? []), s.id]);
  }
  return [...groups.values()];
}

const pad = (b: SceneBox, by: number): SceneBox => ({
  x: b.x - by,
  y: b.y - by,
  w: b.w + by * 2,
  h: b.h + by * 2,
});

/**
 * The areas the answer accounts for: every detected shape, plus a corridor
 * along every detected edge (an arrow is drawn between two shapes and its
 * strokes sit in that corridor).
 */
export function consumedRegions(
  nodeBoxes: SceneBox[],
  edges: Array<{ from: SceneBox; to: SceneBox }>,
): Region[] {
  const regions: Region[] = nodeBoxes.map((box) => ({ box: pad(box, PAD_NODE) }));

  // A corridor along the line, not the union of both node boxes. The union of a
  // diagonal pair is a huge rectangle that swallows unrelated ink — that is how
  // a horizontal arrow next to a diagonal edge got deleted with nothing to
  // replace it.
  for (const { from, to } of edges) {
    const a = centerOf(from);
    const b = centerOf(to);
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = a.x + (b.x - a.x) * t;
      const cy = a.y + (b.y - a.y) * t;
      regions.push({
        box: { x: cx - PAD_EDGE, y: cy - PAD_EDGE, w: PAD_EDGE * 2, h: PAD_EDGE * 2 },
      });
    }
  }
  return regions;
}

export type Consumption = {
  consume: string[];
  keep: string[];
  clusters: number;
};

const EXPLAINED = 0.6;

/**
 * A stroke is consumed when the answer explains most of it. Strokes that
 * nothing in the result covers stay exactly where the user drew them.
 */
export function strokesToConsume(
  strokes: StrokeBox[],
  nodeBoxes: SceneBox[],
  edges: Array<{ from: SceneBox; to: SceneBox }> = [],
): Consumption {
  const regions = consumedRegions(nodeBoxes, edges);

  const consume: string[] = [];
  const keep: string[] = [];
  for (const stroke of strokes) {
    (coveredRatio(stroke, regions) >= EXPLAINED ? consume : keep).push(stroke.id);
  }

  return { consume, keep, clusters: clusterStrokes(strokes).length };
}
