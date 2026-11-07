/**
 * Provider catalog. Adding a provider here is the whole integration: the route
 * and the settings UI both read from this list, so there is exactly one place
 * where "which models can I call" is decided.
 *
 * BYOK is the default posture. A key is taken from the request, and only falls
 * back to the server's environment when the deployment allows it (see
 * `allowServerKey`), so a self-hoster can run with one `.env` line while a
 * public deployment can refuse to spend its own money.
 */

export const USER_AGENT = "retrace/0.1 (+https://github.com/raihatneloy/retrace)";

export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "opencode",
  "compatible",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderSpec = {
  id: ProviderId;
  label: string;
  /** Environment variables checked, in order, for a server-side key. */
  envVars: string[];
  defaultModel?: string;
  defaultBaseUrl?: string;
  /** A custom endpoint cannot guess this for you. */
  requiresBaseUrl?: boolean;
  keyHint: string;
  docsUrl: string;
  /** Some endpoints only speak the OpenAI wire format. */
  wire: "openai" | "anthropic" | "google" | "openai-compatible";
  /**
   * Header this endpoint wants a stable per-conversation id in. OpenCode Go
   * uses it for routing and prompt caching and rejects requests without it.
   */
  sessionHeader?: string;
  /** Identify ourselves rather than hiding behind the SDK's default agent. */
  userAgent?: string;
};

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    envVars: ["OPENAI_API_KEY"],
    defaultModel: "gpt-6.1-terra",
    keyHint: "sk-…",
    docsUrl: "https://platform.openai.com/api-keys",
    wire: "openai",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-5-5",
    keyHint: "sk-ant-…",
    docsUrl: "https://console.anthropic.com/settings/keys",
    wire: "anthropic",
  },
  google: {
    id: "google",
    label: "Google Gemini",
    envVars: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    defaultModel: "gemini-3.8-flash",
    keyHint: "AIza…",
    docsUrl: "https://aistudio.google.com/apikey",
    wire: "google",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    envVars: ["OPENROUTER_API_KEY"],
    defaultModel: "google/gemini-3.8-flash",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keyHint: "sk-or-…",
    docsUrl: "https://openrouter.ai/keys",
    wire: "openai-compatible",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode Zen",
    envVars: ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"],
    defaultModel: "deepseek-v4.1-flash",
    defaultBaseUrl: "https://opencode.ai/zen/go/v1",
    keyHint: "oc-…",
    docsUrl: "https://opencode.ai/auth",
    wire: "openai-compatible",
    sessionHeader: "x-opencode-session",
    userAgent: USER_AGENT,
  },
  compatible: {
    id: "compatible",
    label: "Custom (OpenAI-compatible)",
    envVars: ["OPENAI_COMPATIBLE_API_KEY", "CUSTOM_API_KEY"],
    requiresBaseUrl: true,
    keyHint: "whatever your endpoint expects",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    wire: "openai-compatible",
  },
};

export function getProvider(id: string): ProviderSpec | undefined {
  return (PROVIDERS as Record<string, ProviderSpec>)[id];
}

/**
 * A public deployment must not silently pay for strangers' conversions, so
 * env-key fallback is opt-out via `RETRACE_ALLOW_ENV_KEY=false`.
 */
export function allowServerKey(): boolean {
  return process.env.RETRACE_ALLOW_ENV_KEY !== "false";
}

export function serverKeyFor(spec: ProviderSpec): string | undefined {
  if (!allowServerKey()) return undefined;
  for (const name of spec.envVars) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

export function resolveModel(
  spec: ProviderSpec,
  opts: { model?: string; apiKey?: string; baseUrl?: string },
): { model: string; apiKey?: string; baseUrl?: string } {
  const model = opts.model?.trim() || spec.defaultModel;
  if (!model) {
    throw new Error(
      `${spec.label} needs a model id — it has no default because the endpoint is user-supplied.`,
    );
  }
  return {
    model,
    apiKey: opts.apiKey?.trim() || serverKeyFor(spec),
    baseUrl: opts.baseUrl?.trim() || spec.defaultBaseUrl,
  };
}
