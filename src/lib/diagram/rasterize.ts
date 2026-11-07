import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import type { RasterTransform } from "./layout";

/**
 * Freedraw strokes -> a raster the model can read, plus the exact transform
 * back to scene coordinates.
 *
 * The round trip is the whole trick: we know the pixel bounds of what we drew,
 * so the model's bboxes in image pixels map linearly back onto the canvas. No
 * guessing, no "close enough" — a shape returns to where it was drawn.
 */

export type RasterizedDrawing = {
  dataUrl: string;
  width: number;
  height: number;
  transform: RasterTransform;
};

export const EXPORT_SCALE = 2;
export const EXPORT_PADDING = 0;

/** Freedraw elements carry their own bounding box in x/y/width/height. */
export function drawingBounds(elements: readonly ExcalidrawElement[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.width);
    maxY = Math.max(maxY, el.y + el.height);
  }
  return {
    minX,
    minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export async function rasterizeDrawing(
  elements: readonly ExcalidrawElement[],
): Promise<RasterizedDrawing> {
  const bounds = drawingBounds(elements);
  const { exportToBlob } = await import("@excalidraw/excalidraw");

  const blob = await exportToBlob({
    elements: elements as never,
    files: null,
    exportPadding: EXPORT_PADDING,
    mimeType: "image/png",
    appState: {
      exportBackground: true,
      viewBackgroundColor: "#ffffff",
      exportWithDarkMode: false,
      exportScale: EXPORT_SCALE,
    } as never,
    getDimensions: (width: number, height: number) => ({
      width: width * EXPORT_SCALE,
      height: height * EXPORT_SCALE,
      scale: EXPORT_SCALE,
    }),
  });

  const dataUrl = await blobToDataUrl(blob);
  const { width, height } = await imageSize(dataUrl);

  // The exporter is authoritative about how many pixels it produced. Deriving
  // the scale from the actual image means a change in Excalidraw's export
  // defaults cannot silently skew every converted coordinate.
  const scaleX = width / bounds.width;
  const scaleY = height / bounds.height;
  const scale = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY) > 0.02
    ? (scaleX + scaleY) / 2
    : scaleX;

  return {
    dataUrl,
    width,
    height,
    transform: { scale, originX: bounds.minX, originY: bounds.minY },
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("could not read the rendered drawing"));
    reader.readAsDataURL(blob);
  });
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => reject(new Error("the rendered drawing is not a readable image"));
    img.src = dataUrl;
  });
}
