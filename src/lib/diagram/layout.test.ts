import { describe, expect, it } from "vitest";

import { identityTransform, isPixelSpace, toRasterPixels, toSceneBox } from "./layout";

const t = { ...identityTransform(1000, 500), originX: 200, originY: 100 };

describe("bbox interpretation", () => {
  it("treats small values as fractions of the image", () => {
    const px = toRasterPixels({ x: 0.25, y: 0.4, w: 0.1, h: 0.2 }, t);
    expect(px).toEqual({ x: 250, y: 200, w: 100, h: 100 });
  });

  it("still accepts a model that answered in pixels", () => {
    // Some endpoints ignore the instruction. Reading 640 as a fraction would
    // put the shape 640 images off-screen; reading it as pixels is right.
    expect(isPixelSpace({ x: 640, y: 120, w: 200, h: 90 })).toBe(true);
    expect(toRasterPixels({ x: 640, y: 120, w: 200, h: 90 }, t)).toEqual({
      x: 640,
      y: 120,
      w: 200,
      h: 90,
    });
  });

  it("maps fractions onto scene coordinates through the raster transform", () => {
    const box = toSceneBox({ x: 0.25, y: 0.4, w: 0.1, h: 0.2 }, { ...t, scale: 2 });
    // 250px at 2x = 125 scene units, offset by the origin.
    expect(box.x).toBe(330); // 200 + 125, snapped
    expect(box.y).toBe(200); // 100 + 100
    expect(box.w).toBe(80); // 100px / 2 = 50, raised to the 80-unit minimum
  });

  it("keeps a huge fraction out of the fallback", () => {
    expect(isPixelSpace({ x: 1, y: 1, w: 0.5, h: 0.5 })).toBe(false);
  });
});
