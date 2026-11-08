import type { BBox, DiagramGraph, GraphNode } from "./schema";

/**
 * Maps raster pixels (what the model saw) onto scene coordinates (where the
 * elements land). Excalidraw scenes are negative-coordinate legal, so the
 * origin is caller-supplied rather than assumed to be 0,0.
 */
export type RasterTransform = {
  /** Raster pixels per scene unit. 1 means the image was rendered 1:1. */
  scale: number;
  originX: number;
  originY: number;
  /** Pixel size of the raster the model saw, for de-normalising its bboxes. */
  imageWidth: number;
  imageHeight: number;
};

export const identityTransform = (imageWidth = 1000, imageHeight = 1000): RasterTransform => ({
  scale: 1,
  originX: 0,
  originY: 0,
  imageWidth,
  imageHeight,
});

/** Never let a model-produced box collapse to an unclickable sliver. */
export const MIN_NODE_W = 80;
export const MIN_NODE_H = 50;
/** Excalidraw's visual grid. Snapping to half of it keeps means aligned. */
export const GRID = 10;

export type SceneBox = { x: number; y: number; w: number; h: number };

/** A model that ignored the instruction and answered in pixels. */
export function isPixelSpace(bbox: BBox): boolean {
  return bbox.x > 1.05 || bbox.y > 1.05 || bbox.w > 1.05 || bbox.h > 1.05;
}

/** Normalised (0..1) or legacy pixel bbox -> pixels of the raster. */
export function toRasterPixels(bbox: BBox, t: RasterTransform): SceneBox {
  if (isPixelSpace(bbox)) {
    return { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h };
  }
  return {
    x: bbox.x * t.imageWidth,
    y: bbox.y * t.imageHeight,
    w: bbox.w * t.imageWidth,
    h: bbox.h * t.imageHeight,
  };
}

export function toSceneBox(bbox: BBox, t: RasterTransform): SceneBox {
  const px = toRasterPixels(bbox, t);
  return {
    x: snap(t.originX + px.x / t.scale),
    y: snap(t.originY + px.y / t.scale),
    w: Math.max(MIN_NODE_W, snap(px.w / t.scale)),
    h: Math.max(MIN_NODE_H, snap(px.h / t.scale)),
  };
}

export function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

export function centerOf(box: SceneBox): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/**
 * Where an arrow should attach, given two boxes: the point on each box's
 * bounding rectangle nearest the other box's centre. Excalidraw re-derives the
 * real path from the binding, so this only has to be a sane starting guess —
 * but a bad guess shows up as a visibly wrong preview before it settles.
 */
export function edgeAnchors(
  a: SceneBox,
  b: SceneBox,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const ca = centerOf(a);
  const cb = centerOf(b);
  return {
    start: rectBorderPoint(a, ca, cb),
    end: rectBorderPoint(b, cb, ca),
  };
}

function rectBorderPoint(
  box: SceneBox,
  from: { x: number; y: number },
  towards: { x: number; y: number },
): { x: number; y: number } {
  const dx = towards.x - from.x;
  const dy = towards.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const hw = box.w / 2;
  const hh = box.h / 2;
  // Scale the direction vector until it hits the rectangle border.
  const sx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const sy = dy === 0 ? Infinity : hh / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: from.x + dx * s, y: from.y + dy * s };
}

/**
 * Rejects the one thing that makes a diagram useless: two nodes with the same
 * visible label stacked on top of each other. Reported, never silently fixed —
 * spatial fidelity is the product, so we do not relayout.
 */
export function findOverlaps(
  boxes: Map<string, SceneBox>,
  threshold = 0.6,
): Array<[string, string]> {
  const entries = [...boxes.entries()];
  const out: Array<[string, string]> = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [ia, a] = entries[i];
      const [ib, b] = entries[j];
      const iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (iw <= 0 || ih <= 0) continue;
      const smaller = Math.min(a.w * a.h, b.w * b.h);
      if (smaller > 0 && (iw * ih) / smaller >= threshold) out.push([ia, ib]);
    }
  }
  return out;
}

export type LaidOutGraph = {
  graph: DiagramGraph;
  boxes: Map<string, SceneBox>;
  overlaps: Array<[string, string]>;
};

export function layout(graph: DiagramGraph, t: RasterTransform): LaidOutGraph {
  const boxes = new Map<string, SceneBox>();
  const nodes: GraphNode[] = graph.nodes.map((n) => {
    // Nodes described by structure alone have no coordinates to map.
    if (n.bbox) boxes.set(n.id, toSceneBox(n.bbox, t));
    return { ...n };
  });
  return { graph: { ...graph, nodes }, boxes, overlaps: findOverlaps(boxes) };
}
