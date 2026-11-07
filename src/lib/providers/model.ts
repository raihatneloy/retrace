import type { LanguageModel } from "ai";

import type { ProviderSpec } from "../providers/registry";

/**
 * Provider -> AI SDK model. This is the only place that knows a provider's wire
 * format, and it exists so the route stays boring.
 *
 * `sessionId` is a stable id for one conversation. Most endpoints ignore it;
 * OpenCode Go refuses the request without it.
 */
export async function languageModelFor(
  spec: ProviderSpec,
  opts: { model: string; apiKey?: string; baseUrl?: string; sessionId?: string },
): Promise<LanguageModel> {
  switch (spec.wire) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({
        apiKey: opts.apiKey,
        baseURL: opts.baseUrl,
        headers: brandedHeaders(spec, opts.sessionId),
        fetch: brandedFetch(spec),
      }).chat(opts.model);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({
        apiKey: opts.apiKey,
        baseURL: opts.baseUrl,
        headers: brandedHeaders(spec, opts.sessionId),
        fetch: brandedFetch(spec),
      })(opts.model);
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({
        apiKey: opts.apiKey,
        baseURL: opts.baseUrl,
        headers: brandedHeaders(spec, opts.sessionId),
        fetch: brandedFetch(spec),
      })(opts.model);
    }
    case "openai-compatible": {
      // OpenRouter, OpenCode, Ollama, LM Studio, vLLM, LiteLLM: one code path.
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({
        name: spec.id,
        apiKey: opts.apiKey,
        baseURL: opts.baseUrl!,
        headers: brandedHeaders(spec, opts.sessionId),
        fetch: brandedFetch(spec),
      })(opts.model);
    }
  }
}

function brandedHeaders(
  spec: ProviderSpec,
  sessionId?: string,
): Record<string, string> | undefined {
  if (!spec.sessionHeader) return undefined;
  return { [spec.sessionHeader]: sessionId ?? "retrace-default" };
}

/**
 * The user agent cannot be relied on through the headers option — this repo's
 * OpenCode Go integration is only accepted because it identifies itself — so it
 * is set on the request itself.
 */
function brandedFetch(spec: ProviderSpec): typeof fetch | undefined {
  if (!spec.userAgent) return undefined;
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", spec.userAgent!);
    return fetch(input, { ...init, headers });
  };
}
