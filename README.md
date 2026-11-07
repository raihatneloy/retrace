# retrace

Draw a diagram by hand — boxes, arrows, labels — press one button, and get a **real
Excalidraw diagram** back: every box draggable, every arrow bound to what it points at,
every label editable text.

Not a picture of your sketch. Not a tidy template that no longer looks like what you
drew. Native elements, in the positions you drew them.

![retrace canvas](docs/canvas.png)

## Status

Working end to end for a **sketch image**: upload a photo or drawing, and real
editable elements appear on the canvas. Freedraw-on-canvas and chat come next.

**Working today**

- Upload a sketch → `DiagramGraph` → native Excalidraw elements, in one undo step
- BYOK across OpenAI, Anthropic, Google Gemini, OpenRouter, OpenCode Zen, and any
  OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, LiteLLM)
- `DiagramGraph` — one intermediate representation, shared by every input door
- Bound arrows and bound (editable) text labels: drag a box, the arrow follows;
  double-click a label, edit it
- Spatial fidelity: elements land where they were drawn, snapped to a 10-unit grid.
  We never re-layout your diagram — the arrangement is your decision, not ours
- 36 tests: conversion logic is pure and DOM-free; route behaviour is tested with
  the provider stubbed

**Not built yet**

- Draw on the canvas and press "Retrace" on your own freedraw strokes
- Chat: describe a diagram, get one
- Scene persistence and share links

## Setup

```bash
npm install
npm run dev
```

Open the app, click the provider name in the toolbar, pick a provider and paste a
key. The key is stored in **your browser's localStorage** and forwarded per request
to this app's own `/api/diagram` route, which does not persist it.

Or give the server a key (`cp .env.example .env.local`). Request keys win over
env keys. A public deployment should set `RETRACE_ALLOW_ENV_KEY=false` so
strangers cannot spend your key.


## How it works

The pipeline is deliberately one-way and narrow:

```
image / freedraw / prompt
        │
        ▼
  DiagramGraph  { nodes: [{id, label, shape, bbox}], edges: [{from, to, label}] }
        │        ← the model's only output. Validated with zod. Never raw element JSON.
        ▼
   skeleton      ← pure TS: ids, positions, bindings, warnings
        │
        ▼
Excalidraw elements   ← @excalidraw/excalidraw's own factory fills in the rest
```

Two rules that drive the design:

1. **The model emits a graph, never elements.** Free-form element JSON from an LLM is
   unvalidatable and unlayoutable. A node/edge graph is checkable, and a deterministic
   converter turns it into a scene.
2. **Geometry is cheap, semantics are expensive.** Snapping a sloppy rectangle to a
   real one is maths. Deciding *what the rectangle is* and *what it connects to* is the
   AI's job. Mixing the two wastes the model on the easy half.

## Development

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # conversion tests
npm run typecheck
```

`src/lib/diagram/` holds the conversion. It is pure TypeScript on purpose — if a test
ever needs a browser, something browser-only has leaked into the wrong module.
`to-elements.ts` is the single file allowed to import Excalidraw, and it does so lazily.

Fixtures live in `fixtures/`. `fixtures/graph-sketch2.json` is a graph read off a
hand-drawn sketch by a vision model, kept as the regression case.

## Roadmap

BYOK is a design requirement, not an afterthought: bring your own key, pick your
provider. Planned support is OpenAI, Anthropic, Google Gemini, OpenRouter, and any
OpenAI-compatible endpoint (which covers OpenCode, Ollama, LM Studio, vLLM and friends).

## License

MIT
