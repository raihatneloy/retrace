import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";

import { edgeAnchors, findOverlaps, type RasterTransform, type SceneBox } from "./layout";
import { layoutGraph } from "./structure";
import { regularize, type RegularizeReport } from "./regularize";
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

export function slugId(
  prefix: string,
  label: string,
  index: number,
  namespace = "",
): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const base = `${prefix}-${slug || "node"}-${index}`;
  return namespace ? `${namespace}-${base}` : base;
}

/**
 * A label that is not inside its shape: under a bracket, beside an arrow, above
 * a row. People draw writing there and expect it back there.
 */
function placedLabel(
  id: string,
  text: string,
  box: { x: number; y: number; w: number; h: number },
  position: "inside" | "below" | "above" | "left" | "right",
): ExcalidrawElementSkeleton | null {
  if (!text.trim()) return null;
  const gap = 12;
  const lineHeight = FONT_SIZE * 1.25;
  const geometry =
    position === "inside"
      ? { x: box.x, y: box.y + box.h / 2 - lineHeight / 2, width: Math.max(box.w, 20), height: lineHeight, textAlign: "center" as const }
      : position === "below"
      ? { x: box.x, y: box.y + box.h + gap, width: Math.max(box.w, text.length * 8), height: lineHeight, textAlign: "center" as const }
      : position === "above"
        ? { x: box.x, y: box.y - lineHeight - gap, width: Math.max(box.w, text.length * 8), height: lineHeight, textAlign: "center" as const }
        : position === "left"
          ? { x: box.x - text.length * 9 - gap, y: box.y + box.h / 2 - lineHeight / 2, width: text.length * 9 + 4, height: lineHeight, textAlign: "right" as const }
          : { x: box.x + box.w + gap, y: box.y + box.h / 2 - lineHeight / 2, width: text.length * 9 + 4, height: lineHeight, textAlign: "left" as const };

  return {
    type: "text",
    id,
    ...geometry,
    text,
    fontSize: FONT_SIZE,
    fontFamily: 1,
    verticalAlign: "middle",
    strokeColor: "#1e1e1e",
  } as ExcalidrawElementSkeleton;
}

/**
 * A divided box as N adjacent rectangles sharing edges — how the drawing
 * actually reads — rather than one box with divider lines, which do not resize
 * with it and cannot be edited per cell.
 */
function cellsSkeleton(
  node: GraphNode,
  box: { x: number; y: number; w: number; h: number },
  id: string,
): ExcalidrawElementSkeleton[] {
  const count = node.cells!;
  const groupId = `${id}-group`;
  const cellW = box.w / count;
  const out: ExcalidrawElementSkeleton[] = [];

  for (let i = 0; i < count; i++) {
    const x = box.x + cellW * i;
    const width = i === count - 1 ? box.x + box.w - x : cellW;
    out.push({
      type: "rectangle",
      id: i === 0 ? id : `${id}-c${i}`,
      x,
      y: box.y,
      width,
      height: box.h,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      strokeStyle: "solid",
      roughness: 1,
      groupIds: [groupId],
    } as ExcalidrawElementSkeleton);

    const text = node.cellLabels?.[i];
    if (text) {
      const placed = placedLabel(
        `${id}-t${i}`,
        text,
        { x, y: box.y, w: width, h: box.h },
        node.labelPosition ?? "inside",
      );
      if (placed) out.push(placed);
    }
  }

  // A node-level label still belongs somewhere.
  const position = node.labelPosition ?? "inside";
  const placedNodeLabel =
    position === "inside" ? null : placedLabel(`${id}-label`, node.label, box, position);
  if (placedNodeLabel) out.push(placedNodeLabel);

  return out;
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
    // "unknown" never reaches here: the caller leaves unrecognised shapes as
    // the user's ink rather than inventing a primitive for them.
    type: EXCALIDRAW_TYPE[node.shape as keyof typeof EXCALIDRAW_TYPE],
    id,
    x: box.x,
    y: box.y,
    width: fitWidthToLabel(box.w, label),
    height: box.h,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    strokeStyle: "solid",
    roughness: 1,
    ...(label && (node.labelPosition ?? "inside") === "inside"
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

/**
 * A database cylinder: top ellipse, bottom ellipse, two sides, all grouped so
 * it drags and resizes as one object. Excalidraw has no cylinder element, so
 * this is how the shape is actually preserved instead of being flattened.
 */
function cylinderSkeleton(
  node: GraphNode,
  box: { x: number; y: number; w: number; h: number },
  id: string,
): ExcalidrawElementSkeleton[] {
  const groupId = `${id}-group`;
  const ry = Math.max(10, Math.round(box.h * 0.16));
  const label = node.label.trim();
  const stroke = "#1e1e1e";
  const common = {
    strokeColor: stroke,
    backgroundColor: "transparent",
    strokeStyle: "solid",
    roughness: 1,
    groupIds: [groupId],
  };

  const parts = [
    {
      type: "ellipse" as const,
      id,
      x: box.x,
      y: box.y,
      width: box.w,
      height: ry * 2,
      ...common,
    },
    {
      type: "ellipse" as const,
      id: `${id}-bottom`,
      x: box.x,
      y: box.y + box.h - ry * 2,
      width: box.w,
      height: ry * 2,
      ...common,
    },
    {
      type: "line" as const,
      id: `${id}-left`,
      x: box.x,
      y: box.y + ry,
      width: 0,
      height: box.h - ry * 2,
      points: [
        [0, 0],
        [0, box.h - ry * 2],
      ],
      ...common,
    },
    {
      type: "line" as const,
      id: `${id}-right`,
      x: box.x + box.w,
      y: box.y + ry,
      width: 0,
      height: box.h - ry * 2,
      points: [
        [0, 0],
        [0, box.h - ry * 2],
      ],
      ...common,
    },
  ] as unknown as ExcalidrawElementSkeleton[];

  if (label) {
    parts.push({
      type: "text",
      id: `${id}-label`,
      x: box.x,
      y: box.y + box.h / 2 - FONT_SIZE / 2,
      width: box.w,
      text: label,
      fontSize: FONT_SIZE,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      strokeColor: stroke,
    } as ExcalidrawElementSkeleton);
  }

  return parts;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Builds a node out of parts described in box fractions. This is how a shape
 * with no Excalidraw primitive — a database drum, a table with dividers, a
 * cloud — keeps its form instead of being relabelled as a rectangle.
 */
function partsSkeleton(
  node: GraphNode,
  box: { x: number; y: number; w: number; h: number },
  id: string,
): ExcalidrawElementSkeleton[] {
  const groupId = `${id}-group`;
  const stroke = "#1e1e1e";
  const out: ExcalidrawElementSkeleton[] = [];
  let firstShapeId: string | null = null;

  node.parts!.forEach((part, i) => {
    const [fx, fy, fw, fh] = part.at.map(clamp01) as [number, number, number, number];
    const x = box.x + fx * box.w;
    const y = box.y + fy * box.h;
    const w = Math.max(0, fw * box.w);
    const h = Math.max(0, fh * box.h);

    if (part.type === "text") {
      if (!part.text?.trim()) return;
      out.push({
        type: "text",
        id: `${id}-p${i}`,
        x,
        y,
        width: Math.max(w, 20),
        height: Math.max(h, FONT_SIZE),
        text: part.text,
        fontSize: FONT_SIZE,
        fontFamily: 1,
        textAlign: "center",
        verticalAlign: "middle",
        strokeColor: stroke,
      } as ExcalidrawElementSkeleton);
      return;
    }

    // The node's own id goes on the first shape, so arrows bind to something.
    const elementId = firstShapeId ? `${id}-p${i}` : id;
    if (!firstShapeId) firstShapeId = elementId;

    if (part.type === "line") {
      out.push({
        type: "line",
        id: elementId,
        x,
        y,
        width: w,
        height: h,
        points: [
          [0, 0],
          [w, h],
        ],
        strokeColor: stroke,
        strokeStyle: "solid",
        roughness: 1,
        groupIds: [groupId],
      } as ExcalidrawElementSkeleton);
      return;
    }

    out.push({
      type: part.type === "ellipse" ? "ellipse" : "rectangle",
      id: elementId,
      x,
      y,
      width: Math.max(1, w),
      height: Math.max(1, h),
      strokeColor: stroke,
      backgroundColor: "transparent",
      strokeStyle: "solid",
      roughness: 1,
      groupIds: [groupId],
      ...(i === 0 && node.label.trim()
        ? {
            label: {
              text: node.label.trim(),
              fontSize: FONT_SIZE,
              fontFamily: 1,
              textAlign: "center" as const,
              verticalAlign: "middle" as const,
            },
          }
        : {}),
    } as ExcalidrawElementSkeleton);
  });

  return out;
}

export function graphToSkeleton(
  graph: DiagramGraph,
  transform: RasterTransform,
  opts: { idNamespace?: string; regularize?: boolean } = {},
): {
  skeleton: ExcalidrawElementSkeleton[];
  warnings: string[];
  layoutReport?: RegularizeReport;
  boxes: Map<string, SceneBox>;
} {
  const ns = opts.idNamespace ?? "";
  const { graph: clean, droppedEdges, duplicateNodeIds } = pruneGraph(graph);
  // Structure-first: clusters the model grouped are re-spaced by arithmetic;
  // everything else keeps the coordinates it was drawn at.
  const laid = layoutGraph(clean, transform);

  // Adaptive: snap near-regular structure, leave deliberate arrangements alone.
  const regular = opts.regularize === false
    ? { boxes: laid.boxes, report: { rows: 0, columns: 0, trees: 0, maxShift: 0, applied: false, reason: "disabled" } }
    : regularize(clean, laid.boxes);
  const boxes = regular.boxes;
  const overlaps = findOverlaps(boxes);

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
    const box = boxes.get(node.id);
    if (!box) {
      warnings.push(`"${node.label || node.id}" had nowhere to go — left out`);
      return;
    }
    const id = slugId("n", node.label || node.symbol || node.shape, i, ns);

    // Nothing we could honestly call a shape: emit no element, so the strokes
    // that drew it are left alone by the consumption pass.
    if (node.shape === "unknown") {
      warnings.push(`"${node.label || "a shape"}" was not recognised — left as drawn`);
      return;
    }

    idOf.set(node.id, id);
    if (node.cells && node.cells > 1) {
      skeleton.push(...cellsSkeleton(node, box, id));
    } else if (node.parts?.length) {
      const built = partsSkeleton(node, box, id);
      if (!built.length) {
        idOf.delete(node.id);
        warnings.push(`"${node.label || "a shape"}" had no usable parts — left as drawn`);
        return;
      }
      skeleton.push(...built);
    } else if (node.symbol === "cylinder") {
      skeleton.push(...cylinderSkeleton(node, box, id));
    } else {
      skeleton.push(nodeSkeleton(node, box, id));
      // A label outside the shape is a separate element; the container only
      // carries bound text when the writing actually sits inside it.
      const position = node.labelPosition ?? "inside";
      if (position !== "inside" && node.label.trim()) {
        const placed = placedLabel(`${id}-label`, node.label, box, position);
        if (placed) skeleton.push(placed);
      }
    }
  });

  clean.edges.forEach((edge, i) => {
    if (!idOf.has(edge.from) || !idOf.has(edge.to)) {
      // One end was left unrecognised, so the arrow has nothing to attach to.
      warnings.push("dropped an arrow whose endpoint was not recognised");
      return;
    }
    const a = boxes.get(edge.from)!;
    const b = boxes.get(edge.to)!;
    const { start, end } = edgeAnchors(a, b);
    const arrowId = slugId("e", `${edge.from}-${edge.to}`, i, ns);

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

  return {
    skeleton,
    warnings,
    layoutReport: regular.report,
    boxes: boxes as Map<string, SceneBox>,
  };
}
