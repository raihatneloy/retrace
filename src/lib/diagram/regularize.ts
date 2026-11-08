import type { DiagramGraph } from "./schema";
import type { SceneBox } from "./layout";

/**
 * The adaptive half of "adaptive vs faithful".
 *
 * A whiteboard sketch is rarely meant to be pixel-faithful: rows are nearly
 * aligned, gaps are nearly equal, a tree branches nearly symmetrically. Snapping
 * that structure to a clean grid is what makes the result look drawn rather than
 * traced — but snapping a genuinely freeform sketch would move things the author
 * placed on purpose.
 *
 * So: measure how regular the drawing already is, and only adjust when it is
 * close to regular. Any change larger than the tolerance is refused outright,
 * which keeps the pass conservative by construction.
 */

export type RegularizeReport = {
  rows: number;
  columns: number;
  trees: number;
  /** Largest distance any shape was moved, in scene units. */
  maxShift: number;
  applied: boolean;
  reason: string;
};

export type RegularizeResult = {
  boxes: Map<string, SceneBox>;
  report: RegularizeReport;
};

const centre = (b: SceneBox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export type RegularizeOptions = {
  /** How far a shape may move before the whole pass is refused. */
  maxShift?: number;
  /** How close two centres must be to count as "on the same line". */
  alignTolerance?: number;
};

export function regularize(
  graph: DiagramGraph,
  input: Map<string, SceneBox>,
  opts: RegularizeOptions = {},
): RegularizeResult {
  const sizes = [...input.values()].map((b) => Math.min(b.w, b.h));
  const typical = median(sizes) || 100;
  const align = opts.alignTolerance ?? Math.max(10, typical * 0.25);
  // How far a shape may move before we decide the arrangement was deliberate.
  // Sized generously enough to spread bunched tree children, tight enough to
  // refuse relocating a scatter.
  const maxShift = opts.maxShift ?? typical * 1.5;

  const boxes = new Map([...input].map(([id, b]) => [id, { ...b }]));
  const untouched = (reason: string): RegularizeResult => ({
    boxes: input,
    report: { rows: 0, columns: 0, trees: 0, maxShift: 0, applied: false, reason },
  });

  if (boxes.size < 2) return untouched("single shape");
  if (boxes.size > 60) return untouched("too dense to judge");

  let rows = 0;
  let trees = 0;

  // Group shapes into bands that share a vertical centre.
  const ids = [...boxes.keys()].sort((a, b) => centre(boxes.get(a)!).y - centre(boxes.get(b)!).y);
  const bands: string[][] = [];
  for (const id of ids) {
    const band = bands[bands.length - 1];
    if (band) {
      const ref = centre(boxes.get(band[0])!).y;
      if (Math.abs(centre(boxes.get(id)!).y - ref) <= align) {
        band.push(id);
        continue;
      }
    }
    bands.push([id]);
  }

  for (const band of bands) {
    if (band.length < 2) continue;
    rows++;
    const rowY = median(band.map((id) => centre(boxes.get(id)!).y));
    const ordered = [...band].sort((a, b) => boxes.get(a)!.x - boxes.get(b)!.x);

    // Put every centre on the row's line.
    for (const id of ordered) {
      const b = boxes.get(id)!;
      b.y = rowY - b.h / 2;
    }

    // Equal gaps, preserving overall extent and order.
    if (ordered.length >= 3) {
      const left = Math.min(...ordered.map((id) => boxes.get(id)!.x));
      const right = Math.max(...ordered.map((id) => boxes.get(id)!.x + boxes.get(id)!.w));
      const totalW = ordered.reduce((sum, id) => sum + boxes.get(id)!.w, 0);
      const gap = (right - left - totalW) / (ordered.length - 1);
      if (gap > 0) {
        let cursor = left;
        for (const id of ordered) {
          const b = boxes.get(id)!;
          b.x = cursor;
          cursor += b.w + gap;
        }
      }
    }
  }

  // Branch symmetry: children of one node, sitting on a shared line, get spread
  // evenly around the parent's centre.
  const byParent = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!boxes.has(edge.from) || !boxes.has(edge.to)) continue;
    byParent.set(edge.from, [...(byParent.get(edge.from) ?? []), edge.to]);
  }
  for (const [parent, children] of byParent) {
    if (children.length < 2) continue;
    const p = boxes.get(parent)!;
    const kids = [...children].sort((a, b) => boxes.get(a)!.x - boxes.get(b)!.x);
    const ys = kids.map((k) => centre(boxes.get(k)!).y);
    if (Math.max(...ys) - Math.min(...ys) > align) continue; // not a fan
    const rowY = median(ys);
    const gap = median(kids.map((k) => boxes.get(k)!.w)) * 0.6;
    const totalW = kids.reduce((sum, k) => sum + boxes.get(k)!.w, 0) + gap * (kids.length - 1);
    let cursor = centre(p).x - totalW / 2;
    for (const k of kids) {
      const b = boxes.get(k)!;
      b.x = cursor;
      b.y = rowY - b.h / 2;
      cursor += b.w + gap;
    }
    trees++;
  }

  // Refuse the whole pass if it had to move anything too far: that is a drawing
  // whose arrangement was deliberate.
  let maxMoved = 0;
  for (const [id, after] of boxes) {
    const before = input.get(id)!;
    const d = Math.hypot(
      centre(after).x - centre(before).x,
      centre(after).y - centre(before).y,
    );
    maxMoved = Math.max(maxMoved, d);
  }

  if (maxMoved > maxShift) {
    return {
      boxes: input,
      report: {
        rows,
        columns: 0,
        trees,
        maxShift: maxMoved,
        applied: false,
        reason: "layout too irregular",
      },
    };
  }

  return {
    boxes,
    report: {
      rows,
      columns: 0,
      trees,
      maxShift: Math.round(maxMoved),
      applied: maxMoved > 0.5,
      reason:
        maxMoved > 0.5
          ? "snapped near-regular structure"
          : rows || trees
            ? "already clean"
            : "nothing regular to snap",
    },
  };
}
