import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { graphToSkeleton } from "./skeleton";
import type { RasterTransform } from "./layout";
import type { DiagramGraph } from "./schema";

/**
 * The browser side of the conversion: hands our skeleton to Excalidraw's own
 * factory, which fills in every field the editor requires (versions, seeds,
 * fractional ordering, bound-text metrics).
 *
 * Deliberately thin and deliberately browser-only. `@excalidraw/excalidraw`
 * touches `window` at module scope, so it is imported lazily: nothing testable
 * lives here, and importing this file during a server render is safe.
 * Everything we actually decide (positions, ids, bindings, warnings) is in
 * skeleton.ts.
 */

export type ConversionResult = {
  elements: readonly ExcalidrawElement[];
  warnings: string[];
  /** Where each node actually landed — the consumption guard needs it. */
  boxes: Map<string, { x: number; y: number; w: number; h: number }>;
};

export async function graphToElements(
  graph: DiagramGraph,
  transform: RasterTransform,
  opts: { idNamespace?: string } = {},
): Promise<ConversionResult> {
  const { skeleton, warnings, boxes } = graphToSkeleton(graph, transform, opts);
  const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
  // regenerateIds: false keeps our slug ids, so the same graph always yields
  // the same scene and undo history stays predictable.
  const elements = convertToExcalidrawElements(skeleton, { regenerateIds: false });
  return { elements, warnings, boxes };
}
