import { z } from "zod";

/**
 * The single intermediate representation shared by every input door:
 * freedraw cleanup, image upload, and chat. Nothing downstream cares which
 * door produced it.
 */

export const NODE_SHAPES = ["rect", "ellipse", "diamond", "text"] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];

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
