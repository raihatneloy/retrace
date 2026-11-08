import type { DiagramGraph, GraphGroup, GraphNode } from "./schema";
import {
  MIN_NODE_H,
  MIN_NODE_W,
  findOverlaps,
  snap,
  toSceneBox,
  type RasterTransform,
  type SceneBox,
} from "./layout";

/**
 * Structure-driven layout.
 *
 * The failure this fixes: a vision model estimating four coordinates per shape
 * gets rows crooked and gaps uneven, because it is predicting arithmetic one
 * token at a time. Here the model only says what belongs together and in what
 * order; the division is done by code, so alignment is exact by construction.
 *
 * Two rules keep it honest on large, messy drawings:
 *
 * 1. Structure is optional, per cluster. Shapes the model did not group keep
 *    exactly where they were drawn. A drawing that is half-structured comes out
 *    half-tidied, which is the correct amount of tidying.
 * 2. A cluster is tidied INSIDE the area it already occupies. We re-space its
 *    members, never relocate the cluster. So a 60-node drawing keeps its overall
 *    composition — top tier stays on top — while every cluster becomes clean.
 */

const SIZE_WEIGHT: Record<string, number> = { s: 0.7, m: 1, l: 1.5 };
const GAP_FACTOR: Record<string, number> = { tight: 0.18, normal: 0.45, wide: 1.1 };
const MIN_GAP = 24;
const MAX_GAP = 160;
const CONTAINER_PAD = 24;

export type LayoutReport = {
  /** Nodes placed by structure (not by the model's coordinates). */
  structured: number;
  /** Nodes kept exactly where they were drawn. */
  freeform: number;
  /** Nodes we had no way to place. */
  unplaced: string[];
  groupsUsed: number;
  warnings: string[];
};

export type StructuredLayout = {
  boxes: Map<string, SceneBox>;
  overlaps: Array<[string, string]>;
  report: LayoutReport;
};

type Slot = { x: number; y: number; w: number; h: number };

const union = (boxes: SceneBox[]): Slot | null => {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: x2 - x, h: y2 - y };
};

/** Weight of a member, used to divide the cluster's extent. */
function memberWeight(id: string, nodes: Map<string, GraphNode>, groups: Map<string, GraphGroup>): number {
  const node = nodes.get(id);
  if (node) {
    const base = SIZE_WEIGHT[node.size ?? "m"] ?? 1;
    // A three-cell row is roughly three boxes wide.
    return base * (node.cells ? node.cells * 0.95 : 1);
  }
  const group = groups.get(id);
  if (group) {
    const sum = group.members.reduce((acc, m) => acc + memberWeight(m, nodes, groups), 0);
    return Math.max(sum, 1);
  }
  return 1;
}

export function layoutGraph(graph: DiagramGraph, t: RasterTransform): StructuredLayout {
  /**
   * Where a cluster goes when it has no drawn extent and no parent to borrow
   * one from: the canvas the model was looking at. Root clusters stack down it
   * in declaration order, which is how a tree described purely as "row, row,
   * row" ends up tiers high.
   */
  const canvas: Slot = {
    x: snap(t.originX + 40),
    y: snap(t.originY + 40),
    w: snap(Math.max(MIN_NODE_W * 2, t.imageWidth / t.scale - 80)),
    h: snap(Math.max(MIN_NODE_H * 2, t.imageHeight / t.scale - 80)),
  };
  const warnings: string[] = [];
  const boxes = new Map<string, SceneBox>();
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const groups = new Map((graph.groups ?? []).map((g) => [g.id, g]));

  // Drawn positions first: they are both the fidelity fallback and the extent a
  // cluster is tidied inside.
  for (const node of graph.nodes) {
    if (node.bbox) boxes.set(node.id, toSceneBox(node.bbox, t));
  }

  // A member may only be claimed by one group — otherwise two layouts fight for
  // the same shape and the result depends on iteration order.
  const claimedBy = new Map<string, string>();
  for (const g of groups.values()) {
    g.members = g.members.filter((m) => {
      if (!nodes.has(m) && !groups.has(m)) {
        warnings.push(`group "${g.id}" refers to "${m}", which was not drawn`);
        return false;
      }
      if (m === g.id) {
        warnings.push(`group "${g.id}" contains itself`);
        return false;
      }
      const owner = claimedBy.get(m);
      if (owner) {
        warnings.push(`"${m}" belongs to two groups — kept it in "${owner}"`);
        return false;
      }
      claimedBy.set(m, g.id);
      return true;
    });
  }

  // Break cycles: a group reachable from itself cannot be laid out.
  const cyclic = new Set<string>();
  const walk = (id: string, path: Set<string>): boolean => {
    if (path.has(id)) return true;
    const g = groups.get(id);
    if (!g) return false;
    const next = new Set(path).add(id);
    if (g.members.some((m) => walk(m, next))) return true;
    return false;
  };
  for (const id of groups.keys()) {
    if (cyclic.has(id)) continue;
    const g = groups.get(id)!;
    if (g.members.some((m) => walk(m, new Set([id])))) {
      cyclic.add(id);
      warnings.push(`group "${id}" refers to itself indirectly — left as drawn`);
    }
  }

  const roots = [...groups.keys()].filter((id) => !claimedBy.has(id) && !cyclic.has(id));

  /** Places a group's members inside `slot`, recursing into nested groups. */
  const placeGroup = (gid: string, inherited?: Slot): void => {
    const g = groups.get(gid)!;
    const members = g.members.filter((m) => !cyclic.has(m));
    if (!members.length) return;

    // Prefer the area the cluster already occupies; only fall back to what the
    // parent handed us. Re-spacing in place is the whole point.
    const drawn = members.map((m) => boxes.get(m)).filter((b): b is SceneBox => Boolean(b));
    const slot = union(drawn) ?? inherited;
    if (!slot) return;

    const weights = members.map((m) => Math.max(memberWeight(m, nodes, groups), 0.1));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const baseGap = Math.max(
      MIN_GAP,
      Math.min(MAX_GAP, (GAP_FACTOR[g.gap ?? "normal"] ?? 0.45) * Math.min(slot.w, slot.h)),
    );
    const gap = members.length > 1 ? baseGap : 0;
    const horizontal = g.axis === "row";
    const extent = (horizontal ? slot.w : slot.h) - gap * (members.length - 1);

    let cursor = horizontal ? slot.x : slot.y;
    members.forEach((m, i) => {
      const share = Math.max(MIN_NODE_W, (extent * weights[i]) / totalWeight);
      // A row sizes its members to a sane box height and centres them in the
      // band; it does not stretch every box to fill the tier.
      const rowH = Math.min(slot.h, Math.max(MIN_NODE_H, 110));
      const child: Slot = horizontal
        ? {
            x: snap(cursor),
            y: snap(slot.y + (slot.h - rowH) / 2),
            w: snap(share),
            h: snap(Math.max(MIN_NODE_H, rowH)),
          }
        : { x: snap(slot.x), y: snap(cursor), w: snap(Math.max(MIN_NODE_W, slot.w)), h: snap(share) };

      if (nodes.has(m)) boxes.set(m, { x: child.x, y: child.y, w: child.w, h: child.h });
      if (groups.has(m) && !cyclic.has(m)) placeGroup(m, child);
      cursor += share + gap;
    });
  };

  // Top-level clusters, in the order they were declared (deterministic).
  const bandH = roots.length ? canvas.h / roots.length : canvas.h;
  roots.forEach((gid, i) => {
    placeGroup(gid, {
      x: canvas.x,
      y: snap(canvas.y + bandH * i),
      w: canvas.w,
      h: snap(bandH),
    });
  });

  // Inside a boundary: place children within the container's drawn box.
  for (const node of graph.nodes) {
    if (!node.container) continue;
    const outer = boxes.get(node.container);
    const inner = boxes.get(node.id);
    if (!outer) continue;
    if (!node.bbox && inner) continue;
    const avail: Slot = {
      x: outer.x + CONTAINER_PAD,
      y: outer.y + CONTAINER_PAD,
      w: Math.max(MIN_NODE_W, outer.w - CONTAINER_PAD * 2),
      h: Math.max(MIN_NODE_H, outer.h - CONTAINER_PAD * 2),
    };
    if (!inner) {
      boxes.set(node.id, { x: snap(avail.x), y: snap(avail.y), w: snap(avail.w), h: snap(avail.h) });
    }
  }

  // A container drawn too small for its children grows instead of clipping them.
  for (const node of graph.nodes) {
    if (!node.container) continue;
    const outer = boxes.get(node.container);
    if (!outer) continue;
    const kids = graph.nodes.filter((n) => n.container === node.container && n.id !== node.id);
    if (kids.length < 2) continue;
    const span = union(kids.map((k) => boxes.get(k.id)).filter((b): b is SceneBox => Boolean(b)));
    if (!span) continue;
    boxes.set(node.container, {
      x: snap(Math.min(outer.x, span.x - CONTAINER_PAD)),
      y: snap(Math.min(outer.y, span.y - CONTAINER_PAD)),
      w: snap(Math.max(outer.x + outer.w, span.x + span.w + CONTAINER_PAD) - Math.min(outer.x, span.x - CONTAINER_PAD)),
      h: snap(Math.max(outer.y + outer.h, span.y + span.h + CONTAINER_PAD) - Math.min(outer.y, span.y - CONTAINER_PAD)),
    });
  }

  // Nothing may disappear. A shape the model gave no position and no group for
  // is placed under everything else rather than dropped: silently losing ink is
  // the failure this project has spent the most rounds fixing.
  const unplaced = graph.nodes.filter((n) => !boxes.has(n.id)).map((n) => n.id);
  if (unplaced.length) {
    const bottom = boxes.size
      ? Math.max(...[...boxes.values()].map((b) => b.y + b.h))
      : canvas.y;
    const y = snap(bottom + 80);
    const slotW = boxes.size ? Math.max(...[...boxes.values()].map((b) => b.x + b.w)) : canvas.w;
    const share = Math.max(MIN_NODE_W, snap((slotW - canvas.x) / unplaced.length));
    unplaced.forEach((id, i) => {
      boxes.set(id, {
        x: snap(canvas.x + share * i),
        y,
        w: Math.max(MIN_NODE_W, share - MIN_GAP),
        h: MIN_NODE_H,
      });
    });
    warnings.push(
      `${unplaced.length} shape${unplaced.length > 1 ? "s" : ""} had no group and no position — placed below the drawing`,
    );
  }

  const structured = graph.nodes.filter((n) => !n.bbox && boxes.has(n.id)).length;
  const freeform = graph.nodes.filter((n) => n.bbox && boxes.has(n.id)).length;

  const placed = new Map([...boxes].filter(([id]) => nodes.has(id)));
  return {
    boxes: placed,
    overlaps: findOverlaps(placed),
    report: {
      structured,
      freeform,
      unplaced,
      groupsUsed: roots.length,
      warnings,
    },
  };
}
