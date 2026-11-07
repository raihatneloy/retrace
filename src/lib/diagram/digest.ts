import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import type { RasterTransform } from "./layout";

/**
 * A compact projection of the scene, sent alongside the image.
 *
 * Not the raw .excalidraw file: that carries appState, files and every point of
 * every stroke — tokens that add no meaning. What the image cannot tell us, and
 * the document can, is exact ink geometry, typed text, element kinds and
 * bindings. That is what goes here.
 *
 * Coordinates are expressed in pixels of the attached image, and the digest says
 * so explicitly. Handing the model two coordinate frames without reconciling
 * them is worse than handing it none.
 */
export type DigestElement = {
  id: string;
  type: string;
  bbox: { x: number; y: number; w: number; h: number };
  /** Typed text — exact, no OCR needed. Absent for freehand, which is strokes. */
  text?: string;
  points?: number;
  dashed?: boolean;
  binds?: { start?: string; end?: string };
};

export type SceneDigest = {
  note: string;
  imageWidth: number;
  imageHeight: number;
  origin: string;
  elements: DigestElement[];
};

const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const KEEP = new Set([...SHAPES, "arrow", "line", "text", "freedraw"]);

export function buildSceneDigest(
  elements: readonly ExcalidrawElement[],
  transform: RasterTransform,
): SceneDigest {
  const kept = elements.filter((el) => KEEP.has(el.type));
  const digest: DigestElement[] = [];

  // Scene -> image pixels: undo the raster transform.
  const toPx = (v: number, origin: number) => Math.round((v - origin) * transform.scale);

  for (const el of kept) {
    const entry: DigestElement = {
      id: el.id,
      type: el.type,
      bbox: {
        x: toPx(el.x, transform.originX),
        y: toPx(el.y, transform.originY),
        w: Math.round(el.width * transform.scale),
        h: Math.round(el.height * transform.scale),
      },
    };

    if (el.type === "text") {
      const text = (el as { text?: string }).text;
      if (text) entry.text = text;
    }
    if (el.type === "freedraw") {
      const points = (el as unknown as { points?: readonly unknown[] }).points;
      if (points) entry.points = points.length;
    }
    if ((el as { strokeStyle?: string }).strokeStyle === "dashed") entry.dashed = true;

    if (el.type === "arrow" || el.type === "line") {
      const a = el as { startBinding?: { elementId?: string } | null; endBinding?: { elementId?: string } | null };
      const binds: { start?: string; end?: string } = {};
      if (a.startBinding?.elementId) binds.start = a.startBinding.elementId;
      if (a.endBinding?.elementId) binds.end = a.endBinding.elementId;
      if (binds.start || binds.end) entry.binds = binds;
    }

    digest.push(entry);
  }

  return {
    note: "Geometry from the document. Authoritative for where ink is and for typed text.",
    imageWidth: transform.imageWidth,
    imageHeight: transform.imageHeight,
    origin: "top-left, pixels of the attached image",
    elements: digest,
  };
}
