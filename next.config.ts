import os from "node:os";
import type { NextConfig } from "next";

/**
 * Next blocks its dev-only resources (HMR and the JS chunks behind it) when the
 * request arrives from a host it does not recognise. Opening the dev server
 * from a phone on the LAN therefore served the HTML but not the app: the
 * toolbar rendered and nothing else worked, which looks like a broken canvas
 * rather than a rejected request.
 *
 * Auto-detect the machine's LAN addresses so `npm run dev` is usable from a
 * phone out of the box; RETRACE_DEV_ORIGINS overrides it.
 */
function devOrigins(): string[] {
  const explicit = (process.env.RETRACE_DEV_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;

  const detected: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) detected.push(addr.address);
    }
  }
  return detected;
}

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins(),
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
