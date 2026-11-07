import { z } from "zod";

import { PROVIDER_IDS } from "../providers/registry";

/**
 * Request contract for POST /api/diagram, kept out of the route so it can be
 * tested without an HTTP server.
 */

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const DiagramRequest = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    model: z.string().min(1).max(120).optional(),
    /** BYOK: forwarded upstream, never persisted, never logged. */
    apiKey: z.string().min(8).max(4096).optional(),
    baseUrl: z.string().url().max(2048).optional(),
    image: z
      .object({
        /** data: URL. The route refuses anything that is not a raster image. */
        dataUrl: z.string().min(32).max(MAX_IMAGE_BYTES * 1.4),
        width: z.number().int().positive().max(20000).optional(),
        height: z.number().int().positive().max(20000).optional(),
      })
      .optional(),
    prompt: z.string().max(4000).optional(),
    /**
     * Stable id for this conversation. Reusing one lets providers that cache on
     * session (OpenCode Go) reuse the sketch image across a follow-up request.
     */
    session: z.string().min(1).max(120).optional(),
    knownLabels: z.array(z.string().max(120)).max(200).optional(),
    /**
     * Compact projection of the source document (exact ink bounds, typed text,
     * bindings). Optional: photos have no document behind them.
     */
    digest: z
      .object({
        imageWidth: z.number().positive(),
        imageHeight: z.number().positive(),
        elements: z.array(z.record(z.string(), z.unknown())).max(500),
      })
      .passthrough()
      .optional(),
  })
  .refine((v) => Boolean(v.image?.dataUrl) || Boolean(v.prompt?.trim()), {
    message: "send an image, a prompt, or both",
    path: ["image"],
  });

export type DiagramRequest = z.infer<typeof DiagramRequest>;

export type ParsedImage = { dataUrl: string; mime: string; bytes: number };

/** Validates the data URL before a single byte goes to a paid provider. */
export function parseImageDataUrl(dataUrl: string): ParsedImage {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) throw new Error("image must be a base64 data URL");
  const mime = match[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error(`unsupported image type ${mime}; use png, jpeg, webp or gif`);
  }
  const bytes = Math.floor((match[2].replace(/\s/g, "").length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(`image is ${(bytes / 1e6).toFixed(1)}MB, limit is 8MB`);
  }
  return { dataUrl, mime, bytes };
}
