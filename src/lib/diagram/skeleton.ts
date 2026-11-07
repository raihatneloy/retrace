import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";

import { layout, edgeAnchors, type RasterTransform } from "./layout";
import { pruneGraph, type DiagramGraph, type GraphNode } from "./schema";

/**
 * Graph -> native Excalidraw elements.
 *
 * Every element is placed at the coordinates the user drew it at. We never
 * relayout: the sketch's arrangement is the user's decision, not ours.
 */

export const FONT_SIZE = 20;

/**
 * Our graph vocabulary is the one humans use ("rect"); Excalidraw's element
 * type is "rectangle". Keep the translation here and nowhere else.
 */
export const EXCALIDRAW_TYPE = {
  rect: "rectangle",
  ellipse: "ellipse",
  diamond: "diamond",
} as const;

/**
 * A bound label wraps to its container, so a narrow box turns "redis-ttl" into
 * two lines. Widen the box to fit its own label — what a person would do —
 * rather than shrink the text until it is unreadable. Fidelity is about where
 * the shape sits, not about keeping it 3px too narrow.
 */
export function fitWidthToLabel(
  width: number,
  label: string,
  fontSize = FONT_SIZE,
  maxWidth = 420,
): number {
  if (!label.trim()) return width;
  const longest = Math.max(...label.split(/\s+/).map((w) => w.length));
  const needed = Math.ceil(longest * fontSize * 0.62 + fontSize * 1.4);
  return Math.min(maxWidth, Math.max(width, needed));
}

export function slugId(prefix: string, label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return `${prefix}-${slug || "node"}-${index}`;
}

function nodeSkeleton(
  node: GraphNode,
  box: { x: number; y: number; w: number; h: number },
  id: string,
): ExcalidrawElementSkeleton {
  const label = node.label.trim();

  // A free-floating label has no container to sit in. Note "unlabelled shape"
  // is NOT this case: a box the user drew without writing in it is still a box,
  // and emitting it as an empty text element makes it invisible.
  if (node.shape === "text") {
    return {
      type: "text",
      id,
      x: box.x,
      y: box.y,
      width: Math.max(box.w, label.length * FONT_SIZE * 0.6),
      height: box.h,
      text: label,
      fontSize: FONT_SIZE,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      strokeColor: "#1e1e1e",
    } as ExcalidrawElementSkeleton;
  }

  return {
    type: EXCALIDRAW_TYPE[node.shape],
    id,
    x: box.x,
    y: box.y,
    width: fitWidthToLabel(box.w, label),
    height: box.h,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    strokeStyle: "solid",
    roughness: 1,
    ...(label
      ? {
          // Bound text: double-click edits it, the box resizes around it, and
          // the label is a real text element, not a picture of a label.
          label: {
            text: label,
            fontSize: FONT_SIZE,
            fontFamily: 1,
            textAlign: "center",
            verticalAlign: "middle",
          },
        }
      : {}),
  } as ExcalidrawElementSkeleton;
}

export function graphToSkeleton(
  graph: DiagramGraph,
  transform: RasterTransform,
): { skeleton: ExcalidrawElementSkeleton[]; warnings: string[] } {
  const { graph: clean, droppedEdges, duplicateNodeIds } = pruneGraph(graph);
  const { boxes, overlaps } = layout(clean, transform);

  const warnings: string[] = [];
  if (droppedEdges.length > 0) {
    warnings.push(
      `dropped ${droppedEdges.length} arrow(s) pointing at shapes that were not detected`,
    );
  }
  if (duplicateNodeIds.length > 0) {
    warnings.push(`dropped ${duplicateNodeIds.length} duplicate node id(s)`);
  }
  for (const [a, b] of overlaps) {
    warnings.push(`"${a}" and "${b}" overlap in the sketch — kept as drawn`);
  }

  const idOf = new Map<string, string>();
  const skeleton: ExcalidrawElementSkeleton[] = [];

  clean.nodes.forEach((node, i) => {
    const id = slugId("n", node.label || node.shape, i);
    idOf.set(node.id, id);
    skeleton.push(nodeSkeleton(node, boxes.get(node.id)!, id));
  });

  clean.edges.forEach((edge, i) => {
    const a = boxes.get(edge.from)!;
    const b = boxes.get(edge.to)!;
    const { start, end } = edgeAnchors(a, b);
    const arrowId = slugId("e", `${edge.from}-${edge.to}`, i);

    skeleton.push({
      type: "arrow",
      id: arrowId,
      x: start.x,
      y: start.y,
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
      points: [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ],
      strokeColor: "#1e1e1e",
      strokeStyle: edge.style,
      roughness: 0,
      // Bindings are what make it a diagram rather than a drawing: drag a box
      // and the arrow follows.
      start: { id: idOf.get(edge.from)! },
      end: { id: idOf.get(edge.to)! },
      startArrowhead: null,
      endArrowhead: edge.arrowhead ? "arrow" : null,
      ...(edge.label?.trim()
        ? {
            label: {
              text: edge.label.trim(),
              fontSize: 16,
              fontFamily: 1,
              textAlign: "center",
              verticalAlign: "middle",
            },
          }
        : {}),
    } as ExcalidrawElementSkeleton);
  });

  return { skeleton, warnings };
}
