import { afterEach, describe, expect, it } from "vitest";

import { DiagramRequest, parseImageDataUrl, MAX_IMAGE_BYTES } from "./request";

const png = (bytes: number) =>
  "data:image/png;base64," + Buffer.alloc(bytes, 1).toString("base64");

describe("diagram request contract", () => {
  it("requires an image or a prompt", () => {
    const r = DiagramRequest.safeParse({ provider: "openai" });
    expect(r.success).toBe(false);
  });

  it("accepts a prompt-only request", () => {
    const r = DiagramRequest.safeParse({ provider: "openai", prompt: "a queue and a worker" });
    expect(r.success).toBe(true);
  });

  it("accepts an image-only request", () => {
    const r = DiagramRequest.safeParse({
      provider: "openai",
      image: { dataUrl: png(1200), width: 900, height: 520 },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown provider", () => {
    const r = DiagramRequest.safeParse({ provider: "cohere", prompt: "x" });
    expect(r.success).toBe(false);
  });

  it("treats whitespace as no prompt", () => {
    const r = DiagramRequest.safeParse({ provider: "openai", prompt: "   " });
    expect(r.success).toBe(false);
  });
});

describe("image data url validation", () => {
  it("measures decoded bytes, not base64 length", () => {
    const url = png(3000);
    const parsed = parseImageDataUrl(url);
    expect(parsed.mime).toBe("image/png");
    expect(parsed.bytes).toBeGreaterThan(2900);
    expect(parsed.bytes).toBeLessThanOrEqual(3100);
  });

  it("refuses an svg, which is a script container, not a raster image", () => {
    const svg =
      "data:image/svg+xml;base64," +
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>').toString("base64");
    expect(() => parseImageDataUrl(svg)).toThrow(/unsupported image type/);
  });

  it("refuses a plain URL", () => {
    expect(() => parseImageDataUrl("https://example.com/x.png")).toThrow(/data URL/);
  });

  it("refuses an oversized image before it reaches a paid provider", () => {
    expect(() => parseImageDataUrl(png(MAX_IMAGE_BYTES + 1024))).toThrow(/limit is 8MB/);
  });
});

describe("provider registry", () => {
  afterEach(() => {
    delete process.env.RETRACE_ALLOW_ENV_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("falls back to the provider default model", async () => {
    const { getProvider, resolveModel } = await import("../providers/registry");
    const spec = getProvider("openai")!;
    expect(resolveModel(spec, { apiKey: "sk-test-1234" }).model).toBe(spec.defaultModel);
  });

  it("refuses to guess a model for a custom endpoint", async () => {
    const { getProvider, resolveModel } = await import("../providers/registry");
    const spec = getProvider("compatible")!;
    expect(() => resolveModel(spec, { apiKey: "k".repeat(12) })).toThrow(/needs a model id/);
  });

  it("can refuse to spend the deployment's own key", async () => {
    const { getProvider, serverKeyFor, allowServerKey } = await import("../providers/registry");
    process.env.OPENAI_API_KEY = "sk-server-key-1234";
    const spec = getProvider("openai")!;
    expect(serverKeyFor(spec)).toBe("sk-server-key-1234");

    process.env.RETRACE_ALLOW_ENV_KEY = "false";
    expect(allowServerKey()).toBe(false);
    expect(serverKeyFor(spec)).toBeUndefined();
  });

  it("prefers a request key over the server key", async () => {
    const { getProvider, resolveModel } = await import("../providers/registry");
    process.env.OPENAI_API_KEY = "sk-server-key-1234";
    const spec = getProvider("openai")!;
    expect(resolveModel(spec, { apiKey: "sk-user-key-5678" }).apiKey).toBe("sk-user-key-5678");
  });
});
