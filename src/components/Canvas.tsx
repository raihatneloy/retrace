"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import "@excalidraw/excalidraw/index.css";

import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import demoGraph from "../../fixtures/graph-sketch2.json";
import { DiagramGraph } from "@/lib/diagram/schema";
import { identityTransform, toSceneBox } from "@/lib/diagram/layout";
import { graphToElements } from "@/lib/diagram/to-elements";
import { rasterizeDrawing } from "@/lib/diagram/rasterize";
import { strokesToConsume } from "@/lib/diagram/consume";
import {
  getServerSettings,
  getSettings,
  subscribeSettings,
  transformForImage,
  updateSettings,
  type Settings,
} from "@/lib/settings";
import { Toolbar } from "./Toolbar";

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((m) => m.Excalidraw),
  { ssr: false },
);

type Status = { kind: "idle" | "ok" | "error"; text: string };

const EMPTY_SCENE: ExcalidrawInitialDataState = {
  elements: [],
  appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
};

export function Canvas() {
  // Read from localStorage through an external store rather than useState: a
  // lazy initialiser would render the stored provider on the client and the
  // default on the server, which is a hydration mismatch.
  const settings = useSyncExternalStore(subscribeSettings, getSettings, getServerSettings);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "" });
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  const update = useCallback((next: Settings) => {
    updateSettings(next);
  }, []);

  const loadExample = useCallback(async () => {
    const graph = DiagramGraph.parse(demoGraph);
    const { elements } = await graphToElements(graph, identityTransform());
    apiRef.current?.updateScene({ elements, captureUpdate: "IMMEDIATELY" });
    apiRef.current?.scrollToContent(elements, { fitToContent: true });
    setStatus({
      kind: "ok",
      text: `Example graph: ${graph.nodes.length} shapes, ${graph.edges.length} connections`,
    });
  }, []);

  const convert = useCallback(
    async (file: File) => {
      setBusy(true);
      setStatus({ kind: "idle", text: `Reading ${file.name}…` });
      try {
        const { dataUrl, width, height } = await readImage(file);

        setStatus({ kind: "idle", text: "Reading the sketch…" });
        const payload = await requestGraph(settings, { image: { dataUrl, width, height } });

        const graph = DiagramGraph.parse(payload.graph);
        const { elements, warnings } = await graphToElements(
          graph,
          {
            ...transformForImage(width, height),
            imageWidth: width,
            imageHeight: height,
          },
          { idNamespace: newNamespace() },
        );

        const api = apiRef.current;
        if (!api) throw new Error("canvas is not ready yet");

        const existing = api.getSceneElements();
        const next = [...existing, ...elements];
        api.updateScene({
          elements: next,
          // One undo step: Cmd+Z removes the whole conversion, not forty elements.
          captureUpdate: "IMMEDIATELY",
        });
        api.scrollToContent(next, { fitToContent: true });

        setStatus({
          kind: "ok",
          text: `${graph.nodes.length} shapes, ${graph.edges.length} connections${
            warnings.length ? ` · ${warnings[0]}` : ""
          }`,
        });
      } catch (err) {
        setStatus({ kind: "error", text: (err as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  const retraceDrawing = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;

    const all = api.getSceneElements() as ExcalidrawElement[];
    const selectedIds = api.getAppState().selectedElementIds as Record<string, unknown>;
    const freedraw = all.filter((el) => el.type === "freedraw");
    const selected = freedraw.filter((el) => selectedIds?.[el.id]);
    // A selection wins; otherwise retrace everything drawn by hand.
    const targets = selected.length ? selected : freedraw;

    if (!targets.length) {
      setStatus({ kind: "error", text: "Draw something with the pen tool first." });
      return;
    }

    setBusy(true);
    setStatus({ kind: "idle", text: "Rendering your drawing…" });
    try {
      const raster = await rasterizeDrawing(targets);

      setStatus({ kind: "idle", text: "Reading the drawing…" });
      // EXPERIMENT (branch exp/raw-scene-prompt): send the whole document, not a
      // summary of it. The digest turned every stroke into a bounding box and a
      // point count, which is exactly the information that distinguishes a table
      // row from a rectangle. Dropping the summary and shipping the source is the
      // cheapest way to find out whether the summary was the problem.
      const scene = {
        type: "excalidraw",
        version: 2,
        source: "retrace",
        elements: all,
        appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
        files: api.getFiles?.() ?? {},
      };
      const payload = await requestGraph(settings, {
        image: { dataUrl: raster.dataUrl, width: raster.width, height: raster.height },
        scene,
        scale: raster.transform.scale,
        origin: { x: raster.transform.originX, y: raster.transform.originY },
      });

      const graph = DiagramGraph.parse(payload.graph);
      // Every conversion gets its own id namespace. Deterministic ids across
      // conversions collide, and a collision silently unbinds the arrows of the
      // diagram that was already on the canvas.
      const { elements, warnings } = await graphToElements(graph, raster.transform, {
        idNamespace: newNamespace(),
      });

      // Only strokes the answer actually accounts for may be removed. An
      // under-detected sketch must never silently lose the parts it missed.
      const nodeBoxes = new Map(graph.nodes.map((n) => [n.id, toSceneBox(n.bbox, raster.transform)]));
      const edgeBoxes = graph.edges.flatMap((e) => {
        const from = nodeBoxes.get(e.from);
        const to = nodeBoxes.get(e.to);
        return from && to ? [{ from, to }] : [];
      });
      const decision = strokesToConsume(
        targets.map((el) => ({
          id: el.id,
          box: { x: el.x, y: el.y, w: el.width, h: el.height },
          // Absolute ink path: points are stored relative to the element.
          points: (el as unknown as { points?: ReadonlyArray<readonly [number, number]> }).points?.map(
            ([px, py]) => [el.x + px, el.y + py] as const,
          ),
        })),
        [...nodeBoxes.values()],
        edgeBoxes,
      );

      const consumed = new Set(decision.consume);
      const survivorStrokes = all.filter((el) => !consumed.has(el.id));
      const next = [...survivorStrokes, ...elements];
      api.updateScene({ elements: next, captureUpdate: "IMMEDIATELY" });
      api.scrollToContent(next, { fitToContent: true });

      const shapes = graph.nodes.length;
      const base = `Retraced ${decision.consume.length} stroke${
        decision.consume.length === 1 ? "" : "s"
      } into ${shapes} shape${shapes === 1 ? "" : "s"}`;
      // Say it out loud when the model read less than was drawn.
      const keptNote = decision.keep.length
        ? ` · kept ${decision.keep.length} stroke${
            decision.keep.length === 1 ? "" : "s"
          } it did not recognise`
        : "";

      setStatus({
        kind: decision.keep.length ? "error" : "ok",
        text: `${base}${keptNote}${warnings.length ? ` · ${warnings[0]}` : ""}`,
      });
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [settings]);

  return (
    <div className="flex h-dvh w-full flex-col">
      {/* Our bar is a real row above the canvas, not an overlay: on a phone the
          overlay landed exactly on top of Excalidraw's own menu island. */}
      <Toolbar
        settings={settings}
        onChange={update}
        onConvert={convert}
        onRetraceDrawing={retraceDrawing}
        onExample={loadExample}
        busy={busy}
        status={status}
      />
      <div className="relative min-h-0 flex-1">
        <Excalidraw
          initialData={EMPTY_SCENE}
          excalidrawAPI={(api: ExcalidrawImperativeAPI) => {
            apiRef.current = api;
            // Exposed for the e2e harness in tests and demos.
            if (typeof window !== "undefined") {
              (window as unknown as { __retrace?: unknown }).__retrace = api;
            }
          }}
        />
      </div>
    </div>
  );
}

/**
 * Reads a picked file into a data URL and measures it. Downscales oversized
 * photos before upload: a phone photo is twelve megapixels of nothing useful,
 * and every unnecessary pixel is latency and money.
 */
async function readImage(
  file: File,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("could not read that file"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("that file is not a readable image"));
    el.src = original;
  });

  const MAX_EDGE = 1400;
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  if (scale === 1) return { dataUrl: original, width: img.width, height: img.height };

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { dataUrl: original, width: img.width, height: img.height };
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}

type GraphPayload = { graph: unknown; meta: { provider: string; model: string } };

/** One place that knows how to talk to our own API, whichever door is open. */
async function requestGraph(
  settings: Settings,
  body: {
    image?: { dataUrl: string; width: number; height: number };
    prompt?: string;
    digest?: unknown;
    scene?: unknown;
    scale?: number;
    origin?: { x: number; y: number };
  },
): Promise<GraphPayload> {
  const res = await fetch("/api/diagram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: settings.provider,
      model: settings.model || undefined,
      apiKey: settings.keys[settings.provider] || undefined,
      baseUrl: settings.baseUrl || undefined,
      ...body,
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error ?? `request failed (${res.status})`);
  return payload as GraphPayload;
}

/** Short, collision-resistant prefix so successive conversions never share ids. */
function newNamespace(): string {
  return Math.random().toString(36).slice(2, 8);
}
