import { NextResponse } from "next/server";

import { DiagramRequest, parseImageDataUrl } from "@/lib/diagram/request";
import { extractGraph } from "@/lib/diagram/extract";
import { getProvider, resolveModel, allowServerKey } from "@/lib/providers/registry";
import { languageModelFor } from "@/lib/providers/model";

// A sketch conversion is a single uncacheable request. `cacheComponents` (the
// app's Next config) rejects route segment config, so this is a plain POST
// handler — POST is never cached, and the provider call must not be.

const RETRYABLE = /rate.?limit|429|overloaded|timeout|503|502|ECONNRESET/i;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = DiagramRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const spec = getProvider(input.provider);
  if (!spec) {
    return NextResponse.json({ error: `unknown provider ${input.provider}` }, { status: 400 });
  }
  if (spec.requiresBaseUrl && !input.baseUrl) {
    return NextResponse.json(
      { error: `${spec.label} requires a baseUrl` },
      { status: 400 },
    );
  }

  let image;
  try {
    image = input.image ? parseImageDataUrl(input.image.dataUrl) : undefined;
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  let resolved;
  try {
    resolved = resolveModel(spec, input);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  if (!resolved.apiKey) {
    return NextResponse.json(
      {
        error: `no API key for ${spec.label}. Send one with the request, or set ${
          spec.envVars[0]
        } on the server.`,
        expectedEnvVars: spec.envVars,
        serverKeyAllowed: allowServerKey(),
      },
      { status: 401 },
    );
  }

  const started = Date.now();
  try {
    const model = await languageModelFor(spec, {
      ...resolved,
      sessionId: input.session ?? crypto.randomUUID(),
    });
    const { graph, usage } = await withRetry(() =>
      extractGraph({
        model,
        imageDataUrl: image?.dataUrl,
        prompt: input.prompt,
        knownLabels: input.knownLabels,
        sceneDigest: input.digest,
        scene: input.scene,
        scale: input.scale,
        origin: input.origin,
      }),
    );

    return NextResponse.json({
      graph,
      meta: {
        provider: spec.id,
        model: resolved.model,
        ms: Date.now() - started,
        usage,
        imageBytes: image?.bytes,
        sceneBytes: input.scene ? JSON.stringify(input.scene).length : undefined,
        sceneElements: input.scene?.elements.length,
      },
    });
  } catch (err) {
    const message = (err as Error).message ?? "conversion failed";
    // Never echo a key back, whatever the provider said.
    const safe = redact(message, resolved.apiKey);
    const status = RETRYABLE.test(safe) ? 503 : 502;
    return NextResponse.json({ error: safe, provider: spec.id, model: resolved.model }, { status });
  }
}

function redact(text: string, secret?: string): string {
  let out = text;
  if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out.replace(/\b(sk|sk-ant|sk-or|oc)-[A-Za-z0-9_\-]{8,}/g, "[redacted]");
}

/**
 * Providers get overloaded; a retry costs less than making the user press the
 * button again. Two attempts, short backoff, only for retryable failures.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = (err as Error).message ?? "";
      if (i === attempts - 1 || !RETRYABLE.test(message)) break;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastError;
}
