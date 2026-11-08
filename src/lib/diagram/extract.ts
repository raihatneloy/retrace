import { generateObject, type LanguageModel } from "ai";

import { DiagramGraph } from "./schema";

/**
 * The extraction contract.
 *
 * The model's whole job is to describe what a person drew: which shapes exist,
 * what they say, and what is connected to what. It never lays anything out and
 * never emits element JSON — that is the converter's job, and keeping the two
 * apart is why "Make it real" can be repeatable.
 */
export const EXTRACTION_SYSTEM = `You read hand-drawn diagrams and report their structure as JSON matching the
given schema.

You are given an image of a hand-drawn sketch: boxes, circles, diamonds, arrows
and handwriting. Transcribe it into a graph. You are NOT redrawing it and NOT
improving it.

Rules:

1. One node per drawn shape. A hand-drawn box is often one wobbly stroke; a
   sloppy rectangle is still a rectangle. Report it once, not once per stroke.
2. PLACEMENT. You are bad at estimating coordinates and good at seeing what
   belongs together. So describe structure, not arithmetic.

   If shapes are lined up, stacked, or inside a boundary, report that with
   "groups" and DO NOT give those shapes a bbox:

     groups: [{id:"g1", axis:"row"|"column", members:[ids in reading order],
               gap:"tight"|"normal"|"wide"}]

   - members are node ids, or other group ids. Groups nest: a column of rows is
     tiers; a row of rows is a tree; a row inside a container is a cluster.
   - "size" on a node is "s", "m" or "l" — relative width only. Never pixels.
   - "container" is the id of the shape this one is drawn inside (a service in
     a cluster, a pod in a namespace).
   - Counting members and their order is a job you can do reliably. Dividing a
     space into equal parts is not — that is why the group exists.

   Give bbox ONLY for shapes you could not place in any group: {x, y, w, h} as
   FRACTIONS of the image, 0 to 1, not pixels. A shape in the top-left quarter
   might be {"x":0.05,"y":0.10,"w":0.20,"h":0.15}. Never tidy, centre or
   re-space those by hand.

   Every shape needs one or the other: a group, or a bbox. A shape with neither
   cannot be placed and ends up below the drawing.

2b. Real drawings are messy and large. Group what is clearly grouped and use
   bboxes for the rest — a half-structured drawing is a correct answer, not a
   failure. Do not invent structure to look tidy, and do not skip shapes because
   the drawing is crowded.
3. shape is "rect" for boxes, "ellipse" for circles and ovals, "diamond" for
   decision/rhombus shapes, and "text" for handwriting that is not inside any
   shape (an arrow annotation, a title, a floating note).
3b. When the drawing is a standard diagram symbol rather than a plain box, keep
   shape as its bounding primitive and set symbol to the symbol's name:
   - "cylinder" for a database/drum: an oval top with a body below it, like a
     tin can seen from the side
   If a closed shape is clearly something we have no word for (a cloud, a server
   rack, a person), set shape to "unknown". Do NOT call a cylinder a rectangle:
   we would replace your drawing with the wrong shape. "unknown" leaves the ink
   untouched, which is the honest outcome.
4. label is the handwriting, transcribed exactly as written. Do not correct
   spelling, do not expand abbreviations, do not invent a label. If a shape has
   no readable text, use an empty string.
4b. If the writing sits OUTSIDE the shape — digits under a bracket, a note beside
   an arrow, a caption above a box — set labelPosition to "below", "left",
   "right" or "above" to match what you see. Default is "inside". Do not drag
   writing into the shape to make the label neat.
4c. A box divided into N cells (a table row, a B-tree node with several keys) is
   ONE node with "cells": N and "cellLabels" in left-to-right order. It is not N
   nodes, and the digits are not one label — a row of three cells with 1 2 3 under
   them is cells:3, cellLabels:["1","2","3"], labelPosition:"below".

5. edges are the arrows and connecting lines actually drawn. from/to must be
   node ids you defined. Do not invent a connection that is not drawn, and do
   not infer a sensible architecture — if the arrow is ambiguous, leave it out
   and say so in notes.
6. label on an edge is text written on or beside the arrow. Use null when the
   arrow has none.
7. style is "dashed" only if the line was drawn dashed or dotted.
8. Ignore page borders, stray marks, frames and underlines.
9. ids are n1, n2, n3 … in reading order.
10. Never drop something that was drawn. An icon or symbol you cannot name is
    still a node: report it with an empty label and describe it in notes. Saying
    nothing about a drawn object makes it disappear from the result, which is
    worse than an imperfect guess you can see and correct.
11. A symbol drawn inside a box (a database cylinder inside a service) is its own
    node. A box whose only contents are words is one node, not two.
12. notes is one short sentence about anything you could not read or were unsure
    about. Leave it null when everything was clear.

If an <excalidraw_file> block accompanies the image, it is the same drawing
described twice, and it is the complete editor document — every element, every
point of every freehand stroke, every binding:

- the file is authoritative for geometry (exact stroke coordinates) and for any
  typed text
- the image is authoritative for what an object IS (a box, a database symbol),
  for which strokes belong together, and for handwriting
- use the stroke points to decide what is one object: strokes that share edges,
  sit on one line, or meet at a corner usually belong to one shape or one row
- when they disagree, place shapes where the file says and describe them as the
  image shows, and mention the disagreement in notes

Prefer missing a faint arrow over inventing a confident one. Never omit a shape
you can see.`;

export type ExtractInput = {
  model: LanguageModel;
  imageDataUrl?: string;
  prompt?: string;
  /** Optional scene text we already know exactly, so the model need not OCR it. */
  knownLabels?: string[];
  /**
   * Compact projection of the source document, if the sketch came from one.
   * Exact ink geometry and typed text; the image supplies meaning.
   */
  sceneDigest?: unknown;
  /**
   * The whole .excalidraw document, verbatim — every element and every point of
   * every stroke, nothing filtered or summarised.
   *
   * The digest was a guess at what a model needs, and a lossy one: it reduced a
   * stroke to a bounding box and a point count, which throws away the shape that
   * made it a table row rather than a rectangle. This sends the source instead
   * and lets the model decide what matters.
   */
  scene?: unknown;
  /** Image pixels per scene unit, so the two coordinate frames can be reconciled. */
  scale?: number;
  origin?: { x: number; y: number };
};

export type ExtractResult = {
  graph: DiagramGraph;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export function buildInstructions({
  imageDataUrl,
  prompt,
  knownLabels,
  sceneDigest,
  scene,
  scale,
  origin,
}: Omit<ExtractInput, "model">): string {
  return [
    imageDataUrl
      ? "Convert this sketch into a graph."
      : "Produce a diagram graph for this description.",
    prompt?.trim() ? `Additional instruction from the author: ${prompt.trim()}` : "",
    knownLabels?.length
      ? `These labels already exist as typed text in the editor, so prefer them when you see something similar: ${knownLabels.join(", ")}.`
      : "",
    sceneDigest && !scene
      ? `The sketch came from a document. Its geometry is below, in pixels of the attached image. Use it for WHERE things are and for any typed text; use the image for WHAT a thing is and for handwriting.\n\n<document>\n${JSON.stringify(sceneDigest)}\n</document>`
      : "",
    scene
      ? sceneBlock(scene, scale, origin)
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The scene verbatim. No trimming, no field selection: the point of this
 * experiment is to stop guessing what the model needs.
 */
function sceneBlock(scene: unknown, scale?: number, origin?: { x: number; y: number }): string {
  const mapping =
    scale && origin
      ? `Coordinates in the document are Excalidraw scene units. The attached image is the same drawing rendered at ${scale}x, with scene point (${origin.x}, ${origin.y}) at image pixel (0, 0). To get image pixels: px = (scene - origin) * ${scale}. bbox in your answer is still a fraction of the image, so divide those pixels by the image size.`
      : "Coordinates in the document are Excalidraw scene units.";

  return [
    "Below is the complete .excalidraw document for the drawing in the image: every element, every point of every freehand stroke, every binding, exactly as the editor has it.",
    mapping,
    "The document is authoritative for geometry and for typed text. The image is authoritative for what an object IS and for handwriting. When they disagree, trust the document for placement and the image for meaning.",
    "<excalidraw_file>",
    JSON.stringify(scene),
    "</excalidraw_file>",
  ].join("\n\n");
}

export async function extractGraph({
  model,
  imageDataUrl,
  prompt,
  knownLabels,
  sceneDigest,
  scene,
  scale,
  origin,
}: ExtractInput): Promise<ExtractResult> {
  const instructions = buildInstructions({
    imageDataUrl,
    prompt,
    knownLabels,
    sceneDigest,
    scene,
    scale,
    origin,
  });

  const { object, usage } = await generateObject({
    model,
    schema: DiagramGraph,
    schemaName: "DiagramGraph",
    schemaDescription: "Shapes and connections read off the sketch, in image pixel coordinates.",
    system: EXTRACTION_SYSTEM,
    // Low temperature: this is transcription, not creativity.
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: instructions },
          ...(imageDataUrl ? [{ type: "image" as const, image: imageDataUrl }] : []),
        ],
      },
    ],
  });

  return {
    graph: object,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
}
