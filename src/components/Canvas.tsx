"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import "@excalidraw/excalidraw/index.css";

import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

import demoGraph from "../../fixtures/graph-sketch2.json";
import { DiagramGraph } from "@/lib/diagram/schema";
import { IDENTITY_TRANSFORM } from "@/lib/diagram/layout";
import { graphToElements } from "@/lib/diagram/to-elements";

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((m) => m.Excalidraw),
  { ssr: false },
);

/**
 * Builds a scene from a DiagramGraph. In production these graphs come from the
 * model (image, freedraw, or chat); today, from a checked-in fixture so the
 * conversion path can be inspected in a real editor.
 */
function sceneFromGraph(raw: unknown): Promise<ExcalidrawInitialDataState> {
  const graph = DiagramGraph.parse(raw);
  return graphToElements(graph, IDENTITY_TRANSFORM).then(({ elements, warnings }) => {
    if (warnings.length) console.warn("[retrace]", warnings);
    return {
      elements,
      appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
    };
  });
}

export function Canvas() {
  const [data, setData] = useState<ExcalidrawInitialDataState | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  useEffect(() => {
    let alive = true;
    sceneFromGraph(demoGraph).then((scene) => {
      if (alive) setData(scene);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!data) {
    return <div className="grid h-dvh place-items-center text-sm opacity-60">loading canvas…</div>;
  }

  return (
    <div className="relative h-dvh w-full">
      <Excalidraw
        initialData={data}
        excalidrawAPI={(api: ExcalidrawImperativeAPI) => {
          apiRef.current = api;
          // Exposed for e2e checks and for the future test harness.
          if (typeof window !== "undefined") {
            (window as unknown as { __retrace?: unknown }).__retrace = api;
          }
        }}
      />
    </div>
  );
}
