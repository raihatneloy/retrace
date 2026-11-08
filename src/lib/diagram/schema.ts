import { z } from "zod";

/**
 * The single intermediate representation shared by every input door:
 * freedraw cleanup, image upload, and chat. Nothing downstream cares which
 * door produced it.
 */

export const NODE_SHAPES = ["rect", "ellipse", "diamond", "text", "unknown"] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];

/**
 * Standard diagram symbols that are not Excalidraw primitives.
 *
 * Excalidraw can draw a rectangle, diamond or ellipse — there is no cylinder,
 * cloud or server element. A drawn database is a *composition*: two ellipses
 * and two lines, grouped. `shape` stays the bounding primitive; `symbol` says
 * what the thing actually is, and the converter builds it.
 *
 * "unknown" is deliberately part of the vocabulary: when the model cannot tell
 * what a closed shape is, we keep the user's ink rather than relabel a cylinder
 * as a rectangle.
 */
export const LABEL_POSITIONS = ["inside", "below", "above", "left", "right"] as const;

export const PART_TYPES = ["rect", "ellipse", "line", "text"] as const;

/**
 * One primitive inside a node, described in fractions of the node's own box.
 *
 * This is the escape hatch from an enumerated shape vocabulary. Instead of a
 * word for every symbol ("cylinder", "table", "cloud", …) — a list that can only
 * ever be incomplete, and fails silently for whatever a stranger draws — the
 * model describes the shape with the primitives Excalidraw already has.
 *
 * The output space stays closed and tiny: three geometry types plus text, four
 * numbers each, all bounded to the box. Nothing here is cross-referential, so
 * there are no ids or bindings to get wrong.
 */
export const NodePart = z.object({
  type: z.enum(PART_TYPES),
  /** x, y, w, h as fractions (0..1) of the node's bounding box. */
  at: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** Only for type "text". */
  text: z.string().max(120).optional(),
});

export const SYMBOLS = ["cylinder"] as const;
export type SymbolName = (typeof SYMBOLS)[number];

/**
 * Bounding box as FRACTIONS of the image the model saw: 0 is the left/top edge,
 * 1 is the right/bottom edge.
 *
 * Not pixels, on purpose. Vision models estimate absolute pixel coordinates
 * against a canvas size they have to guess, and the guess drifts: measured on
 * the eval corpus, every shape below the vertical midpoint came back ~6.8% of
 * the image height too low. Relative coordinates remove that class of error
 * because the model only has to judge proportion, which it does far better.
 *
 * Legacy pixel output is still accepted — see `toSceneBox`.
 */
export const BBox = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
});

export const GraphNode = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  shape: z.enum(NODE_SHAPES).default("rect"),
  /** Set when the drawing is a standard symbol rather than a plain primitive. */
  symbol: z.enum(SYMBOLS).optional(),
  /** How to build a shape that has no primitive: parts, in box fractions. */
  parts: z.array(NodePart).max(16).optional(),
  /**
   * Where the writing sits relative to the shape. People draw the label under a
   * bracket, beside an arrow, above a table row — forcing every label inside the
   * box is a fidelity loss, not a feature.
   */
  labelPosition: z.enum(LABEL_POSITIONS).optional(),
  /**
   * A box divided into N cells (a table row, a B-tree node). Rendered as N
   * adjacent rectangles sharing edges, not one box with divider lines: each cell
   * then moves, resizes and takes text on its own.
   */
  cells: z.number().int().min(2).max(12).optional(),
  /** One entry per cell, used with `cells`. */
  cellLabels: z.array(z.string().max(40)).max(12).optional(),
  bbox: BBox,
  /** Model's own confidence, when it volunteers one. Never trusted for control flow. */
  confidence: z.number().min(0).max(1).optional(),
});

export const GraphEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().nullish(),
  style: z.enum(["solid", "dashed"]).default("solid"),
  arrowhead: z.boolean().default(true),
});

export const DiagramGraph = z.object({
  nodes: z.array(GraphNode).min(1).max(120),
  edges: z.array(GraphEdge).default([]),
  /** Optional prose the model returns about what it could not read. */
  notes: z.string().nullish(),
});

export type BBox = z.infer<typeof BBox>;
export type GraphNode = z.infer<typeof GraphNode>;
export type GraphEdge = z.infer<typeof GraphEdge>;
export type DiagramGraph = z.infer<typeof DiagramGraph>;

/**
 * Models invent edge endpoints that do not exist. Dropping them is better than
 * rejecting the whole conversion — a graph with one bad arrow is still useful,
 * an error toast is not.
 */
export function pruneGraph(graph: DiagramGraph): {
  graph: DiagramGraph;
  droppedEdges: GraphEdge[];
  duplicateNodeIds: string[];
} {
  const seen = new Set<string>();
  const duplicateNodeIds: string[] = [];
  const nodes = graph.nodes.filter((n) => {
    if (seen.has(n.id)) {
      duplicateNodeIds.push(n.id);
      return false;
    }
    seen.add(n.id);
    return true;
  });

  const droppedEdges: GraphEdge[] = [];
  const edges = graph.edges.filter((e) => {
    const ok = seen.has(e.from) && seen.has(e.to) && e.from !== e.to;
    if (!ok) droppedEdges.push(e);
    return ok;
  });

  return { graph: { ...graph, nodes, edges }, droppedEdges, duplicateNodeIds };
}
