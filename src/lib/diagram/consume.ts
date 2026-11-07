import type { SceneBox } from "./layout";

/**
 * Deciding what the conversion actually replaced.
 *
 * The naive rule — "delete the strokes we sent" — destroys work whenever the
 * model under-detects: send two drawings, get one shape back, and the other is
 * gone. Instead, work out which strokes the answer *explains* and remove only
 * those.
 */

export type StrokeBox = { id: string; box: SceneBox };
export type Region = { box: SceneBox };

const PAD_NODE = 10;
const PAD_EDGE = 34;

const intersectArea = (a: SceneBox, b: SceneBox): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

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
  for (const { from, to } of edges) {
    const x = Math.min(from.x, to.x);
    const y = Math.min(from.y, to.y);
    const w = Math.max(from.x + from.w, to.x + to.w) - x;
    const h = Math.max(from.y + from.h, to.y + to.h) - y;
    regions.push({ box: pad({ x, y, w, h }, PAD_EDGE) });
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
    const area = Math.max(1, stroke.box.w * stroke.box.h);
    let covered = 0;
    for (const region of regions) covered += intersectArea(stroke.box, region.box);
    (covered / area >= EXPLAINED ? consume : keep).push(stroke.id);
  }

  return { consume, keep, clusters: clusterStrokes(strokes).length };
}
