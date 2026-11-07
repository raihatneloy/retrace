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
export const EXTRACTION_SYSTEM = `You read hand-drawn diagrams and report their structure.

You are given an image of a hand-drawn sketch: boxes, circles, diamonds, arrows
and handwriting. Transcribe it into a graph. You are NOT redrawing it and NOT
improving it.

Rules:

1. One node per drawn shape. A hand-drawn box is often one wobbly stroke; a
   sloppy rectangle is still a rectangle. Report it once, not once per stroke.
2. bbox is in pixels of the image you were given, as {x, y, w, h}, with the
   origin at the top-left. Make it tight around the drawn shape, and preserve
   the shape's position and rough size. Do not normalise, centre or tidy up.
3. shape is "rect" for boxes, "ellipse" for circles and ovals, "diamond" for
   decision/rhombus shapes, and "text" for handwriting that is not inside any
   shape (an arrow annotation, a title, a floating note).
4. label is the handwriting, transcribed exactly as written. Do not correct
   spelling, do not expand abbreviations, do not invent a label. If a shape has
   no readable text, use an empty string.
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

Prefer missing a faint arrow over inventing a confident one. Never omit a shape
you can see.`;

export type ExtractInput = {
  model: LanguageModel;
  imageDataUrl?: string;
  prompt?: string;
  /** Optional scene text we already know exactly, so the model need not OCR it. */
  knownLabels?: string[];
};

export type ExtractResult = {
  graph: DiagramGraph;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export async function extractGraph({
  model,
  imageDataUrl,
  prompt,
  knownLabels,
}: ExtractInput): Promise<ExtractResult> {
  const instructions = [
    imageDataUrl
      ? "Convert this sketch into a graph."
      : "Produce a diagram graph for this description.",
    prompt?.trim() ? `Additional instruction from the author: ${prompt.trim()}` : "",
    knownLabels?.length
      ? `These labels already exist as typed text in the editor, so prefer them when you see something similar: ${knownLabels.join(", ")}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

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
