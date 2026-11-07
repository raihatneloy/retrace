/**
 * Conversion evaluation harness.
 *
 * Runs every corpus case through the same extraction path the app uses, scores
 * it against ground truth, and prints a table. Gate on it in CI: a change that
 * makes the conversion worse fails here rather than in a user's drawing.
 *
 *   npm run eval                      # all cases, default provider
 *   npm run eval -- --only dense-grid # one case
 *   npm run eval -- --repeat 3        # measure run-to-run variance
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

import { DiagramGraph } from "../src/lib/diagram/schema";
import { extractGraph } from "../src/lib/diagram/extract";
import { getProvider, resolveModel } from "../src/lib/providers/registry";
import { languageModelFor } from "../src/lib/providers/model";
import { scoreCase, summarise, type Truth } from "../src/lib/eval/score";
import { buildSceneDigest } from "../src/lib/diagram/digest";

type Case = {
  id: string;
  difficulty: string;
  image: string;
  width: number;
  height: number;
  expected: Truth;
};

const root = path.resolve(__dirname);
const API = path.join(root, "corpus");
const OUT = path.join(root, "out");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  const providerId = arg("provider", process.env.EVAL_PROVIDER ?? "opencode")!;
  const only = arg("only");
  const useDigest = process.argv.includes("--digest");
  const repeat = Number(arg("repeat", "1"));

  const spec = getProvider(providerId);
  if (!spec) throw new Error(`unknown provider ${providerId}`);
  const resolved = resolveModel(spec, {
    model: arg("model"),
    baseUrl: arg("base-url"),
  });
  if (!resolved.apiKey) {
    throw new Error(
      `no key for ${spec.label}. Set ${spec.envVars[0]} in the environment before running the eval.`,
    );
  }

  const files = readdirSync(API)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".scene.json"))
    .filter((f) => (only ? f.startsWith(only) : true))
    .sort();

  if (!files.length) throw new Error(`no cases in ${API} (run: python3 eval/generate_corpus.py)`);

  console.log(`provider ${spec.id} / ${resolved.model}`);
  console.log(`input: ${useDigest ? "image + scene digest" : "image only"}`);
  console.log(`${files.length} case(s), ${repeat} run(s)\n`);

  mkdirSync(OUT, { recursive: true });
  const results = [];
  const failures: string[] = [];

  for (const file of files) {
    const testCase: Case = JSON.parse(readFileSync(path.join(API, file), "utf8"));
    const imagePath = path.join(root, testCase.image);
    const dataUrl = `data:image/png;base64,${readFileSync(imagePath).toString("base64")}`;

    let digest: unknown;
    if (useDigest) {
      const scenePath = path.join(API, file.replace(/\.json$/, ".scene.json"));
      if (!existsSync(scenePath)) throw new Error(`missing scene for ${testCase.id} (run eval/generate_scenes.py)`);
      const scene = JSON.parse(readFileSync(scenePath, "utf8"));
      digest = buildSceneDigest(scene.elements, {
        scale: 1,
        originX: 0,
        originY: 0,
        imageWidth: testCase.width,
        imageHeight: testCase.height,
      });
    }

    for (let run = 1; run <= repeat; run++) {
      const started = Date.now();
      try {
        const model = await languageModelFor(spec, {
          ...resolved,
          sessionId: `eval-${testCase.id}-${run}`,
        });
        const { graph, usage } = await extractGraph({ model, imageDataUrl: dataUrl, sceneDigest: digest });
        const ms = Date.now() - started;

        const parsed = DiagramGraph.parse(graph);
        writeFileSync(
          path.join(OUT, `${testCase.id}${repeat > 1 ? `-${run}` : ""}.json`),
          JSON.stringify({ graph: parsed, ms, usage }, null, 2),
        );

        const result = scoreCase(testCase.id, testCase.difficulty, testCase.expected, parsed, {
          width: testCase.width,
          height: testCase.height,
        });
        results.push(result);
        console.log(
          [
            testCase.id.padEnd(16),
            `${String(result.nodes.matched)}/${result.nodes.expected} shapes`,
            `${String(result.edges.matched)}/${result.edges.expected} edges`,
            `labels ${result.labelExact}/${result.nodes.matched}`,
            `iou ${result.meanIoU.toFixed(2)}`,
            `${(ms / 1000).toFixed(1)}s`,
          ].join("  "),
        );
      } catch (err) {
        const message = (err as Error).message;
        failures.push(`${testCase.id}: ${message}`);
        console.log(`${testCase.id.padEnd(16)}  FAILED  ${message.slice(0, 90)}`);
      }
    }
  }

  const summary = summarise(results);

  // Same case, different runs: this is the noise floor. Any change smaller than
  // this spread has not been demonstrated.
  const byId = new Map<string, number[]>();
  for (const r of results) byId.set(r.id, [...(byId.get(r.id) ?? []), r.meanIoU]);
  const spreads = [...byId.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([id, v]) => ({ id, spread: Math.max(...v) - Math.min(...v) }));
  if (spreads.length) {
    const worst = spreads.reduce((a, b) => (b.spread > a.spread ? b : a));
    console.log(`\n— noise floor — (${repeat} runs per case)`);
    console.log(`  mean IoU spread ${(spreads.reduce((a, s) => a + s.spread, 0) / spreads.length).toFixed(2)}`);
    console.log(`  worst           ${worst.spread.toFixed(2)} on ${worst.id}`);
  }

  console.log("\n— summary —");
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  console.log(`  shape recall      ${pct(summary.nodeRecall)}`);
  console.log(`  shape precision   ${pct(summary.nodePrecision)}`);
  console.log(`  label exact       ${pct(summary.labelExact)}`);
  console.log(`  label near (>=.8) ${pct(summary.labelFuzzy)}`);
  console.log(`  shape kind        ${pct(summary.shapeAccuracy)}`);
  console.log(`  mean bbox IoU     ${summary.meanIoU.toFixed(2)}`);
  console.log(`  mean centre error ${summary.meanCentreErrorPx.toFixed(1)}px`);
  console.log(`  edge recall       ${pct(summary.edgeRecall)}`);
  console.log(`  edge precision    ${pct(summary.edgePrecision)}`);

  writeFileSync(
    path.join(root, useDigest ? "report-digest.json" : "report.json"),
    JSON.stringify({ provider: spec.id, model: resolved.model, summary, results, failures }, null, 2),
  );
  console.log(`\n  wrote eval/${useDigest ? "report-digest.json" : "report.json"}`);

  if (failures.length) {
    console.log(`\n  ${failures.length} case(s) threw:`);
    for (const f of failures) console.log(`   - ${f}`);
  }

  // A floor, not a target: fail the build when the conversion regresses badly.
  const FLOOR = Number(arg("floor", "0.6"))!;
  const ok = summary.nodeRecall >= FLOOR && summary.edgePrecision >= FLOOR;
  if (!ok) {
    console.log(`\n  BELOW FLOOR (${FLOOR}) — shape recall or edge precision regressed`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
