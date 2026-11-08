import { describe, expect, it } from "vitest";

import { buildInstructions } from "./extract";

describe("buildInstructions", () => {
  it("sends the document verbatim, every point included", () => {
    const points = Array.from({ length: 500 }, (_, i) => [i * 3, i * 2]);
    const scene = {
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "stroke-1", type: "freedraw", x: 10, y: 20, width: 100, height: 100, points },
        { id: "box-1", type: "rectangle", x: 200, y: 20, width: 80, height: 60, boundElements: null },
      ],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };

    const text = buildInstructions({ scene, scale: 2, origin: { x: 10, y: 20 } });

    // Nothing summarised: the exact serialised document is present.
    expect(text).toContain(JSON.stringify(scene));
    // Every point survived.
    expect(text).toContain('"points":[[0,0],[3,2],[6,4]');
    expect(text.split("495,330").length).toBe(2); // last point, once in the scene
    expect(text).toContain("<excalidraw_file>");
    expect(text).toContain("</excalidraw_file>");
  });

  it("states the transform so the two coordinate frames reconcile", () => {
    const text = buildInstructions({
      scene: { elements: [] },
      scale: 2,
      origin: { x: -40, y: 25 },
    });
    expect(text).toMatch(/2x/);
    expect(text).toMatch(/\(-40, 25\)/);
    expect(text).toContain("px = (scene - origin) * 2");
  });

  it("does not send the old summary when a scene is given", () => {
    const text = buildInstructions({
      scene: { elements: [] },
      sceneDigest: { elements: [{ id: "a" }] },
    });
    expect(text).toContain("<excalidraw_file>");
    expect(text).not.toContain("<document>");
  });

  it("still works with neither image nor document", () => {
    const text = buildInstructions({ prompt: "a login flowchart" });
    expect(text).toContain("login flowchart");
    expect(text).not.toContain("<excalidraw_file>");
  });
});
