import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route behaviour, with the provider stubbed out.
 *
 * What matters here is everything around the model call: what we accept, what
 * we refuse, and what we leak in error messages. The call itself is the
 * provider's problem.
 */

const extractGraph = vi.fn();
const languageModelFor = vi.fn(async () => ({}) as never);

vi.mock("@/lib/diagram/extract", () => ({ extractGraph: (...a: unknown[]) => extractGraph(...a) }));
vi.mock("@/lib/providers/model", () => ({
  languageModelFor: (...a: unknown[]) => languageModelFor(...(a as [])),
}));

const { POST } = await import("./route");

const png = (bytes = 400) =>
  "data:image/png;base64," + Buffer.alloc(bytes, 1).toString("base64");

function req(body: unknown) {
  return new Request("http://localhost/api/diagram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const graph = {
  nodes: [{ id: "n1", label: "api", shape: "rect", bbox: { x: 1, y: 2, w: 30, h: 40 } }],
  edges: [],
};

beforeEach(() => {
  extractGraph.mockReset();
  languageModelFor.mockClear();
  delete process.env.RETRACE_ALLOW_ENV_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/diagram", () => {
  it("rejects a body that is not JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/diagram", { method: "POST", body: "nope" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a request with neither image nor prompt", async () => {
    const res = await POST(req({ provider: "openai", apiKey: "sk-user-key-1234" }));
    expect(res.status).toBe(400);
  });

  it("refuses a custom endpoint with no baseUrl", async () => {
    const res = await POST(
      req({ provider: "compatible", model: "x", prompt: "a box", apiKey: "k".repeat(12) }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/requires a baseUrl/);
  });

  it("tells you which env var to set when there is no key", async () => {
    const res = await POST(req({ provider: "opencode", prompt: "a box" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.expectedEnvVars).toContain("OPENCODE_GO_API_KEY");
    expect(body.serverKeyAllowed).toBe(true);
  });

  it("accepts a server-side env key when the deployment allows it", async () => {
    process.env.OPENCODE_GO_API_KEY = "oc-server-key-abcdef";
    extractGraph.mockResolvedValueOnce({ graph });
    const res = await POST(req({ provider: "opencode", image: { dataUrl: png() } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.provider).toBe("opencode");
    expect(body.meta.model).toBe("deepseek-v4.1-flash");
  });

  it("ignores the env key when the deployment forbids it", async () => {
    process.env.OPENCODE_GO_API_KEY = "oc-server-key-abcdef";
    process.env.RETRACE_ALLOW_ENV_KEY = "false";
    const res = await POST(req({ provider: "opencode", prompt: "a box" }));
    expect(res.status).toBe(401);
    expect((await res.json()).serverKeyAllowed).toBe(false);
  });

  it("returns the graph and usage metadata", async () => {
    extractGraph.mockResolvedValueOnce({ graph, usage: { inputTokens: 900, outputTokens: 80 } });
    const res = await POST(
      req({ provider: "openai", apiKey: "sk-user-key-1234", image: { dataUrl: png() } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.graph.nodes[0].label).toBe("api");
    expect(body.meta.usage.inputTokens).toBe(900);
    expect(body.meta.imageBytes).toBeGreaterThan(300);
  });

  it("maps a retryable provider failure to 503", async () => {
    extractGraph.mockRejectedValue(new Error("429 upstream overloaded"));
    vi.useFakeTimers();
    const pending = POST(
      req({ provider: "openai", apiKey: "sk-user-key-1234", image: { dataUrl: png() } }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe(503);
    // Overload is worth retrying, so it should have tried more than once.
    expect(extractGraph.mock.calls.length).toBeGreaterThan(1);
  });

  it("maps a non-retryable provider failure to 502", async () => {
    extractGraph.mockRejectedValue(new Error("invalid model id"));
    const res = await POST(
      req({ provider: "openai", apiKey: "sk-user-key-1234", image: { dataUrl: png() } }),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("invalid model id");
  });

  it("never echoes the key back in an error", async () => {
    const key = "sk-user-supersecret-abcdefgh";
    extractGraph.mockRejectedValue(new Error(`auth failed for ${key}`));
    const res = await POST(req({ provider: "openai", apiKey: key, image: { dataUrl: png() } }));
    const text = await res.text();
    expect(text).not.toContain(key);
    expect(text).toContain("[redacted]");
  });
});
