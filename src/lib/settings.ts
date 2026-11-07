import { PROVIDER_IDS, type ProviderId } from "./providers/registry";

/**
 * Browser-side settings. The key lives in this browser and is sent only to our
 * own /api route, which forwards it upstream per request and never stores it.
 */
export type Settings = {
  provider: ProviderId;
  /** Empty means "use the provider's default model". */
  model: string;
  baseUrl: string;
  keys: Partial<Record<ProviderId, string>>;
};

const STORAGE_KEY = "retrace.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  provider: "opencode",
  model: "",
  baseUrl: "",
  keys: {},
};

export function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      provider: PROVIDER_IDS.includes(parsed.provider as ProviderId)
        ? (parsed.provider as ProviderId)
        : DEFAULT_SETTINGS.provider,
      model: typeof parsed.model === "string" ? parsed.model : "",
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      keys: parsed.keys && typeof parsed.keys === "object" ? parsed.keys : {},
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Cached so `useSyncExternalStore` returns a stable reference between renders. */
let cache: Settings | null = null;
const listeners = new Set<() => void>();

/** Client snapshot: localStorage, read once. */
export function getSettings(): Settings {
  if (!cache) cache = loadSettings();
  return cache;
}

/** Server snapshot: never touch localStorage during SSR. */
export function getServerSettings(): Settings {
  return DEFAULT_SETTINGS;
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Writes and notifies. Kept separate from `saveSettings` so a render never
 *  has to own the update. */
export function updateSettings(next: Settings): void {
  cache = next;
  saveSettings(next);
  for (const listener of listeners) listener();
}

export function saveSettings(settings: Settings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode / quota: the app still works, it just forgets the key.
  }
}

/**
 * Raster pixels -> scene units. Keeps an upload at a size that fits on screen
 * without shrinking a small sketch into illegibility.
 */
export function transformForImage(
  width: number,
  height: number,
  targetWidth = 900,
): { scale: number; originX: number; originY: number } {
  const scale = width > targetWidth ? width / targetWidth : 1;
  return { scale, originX: 0, originY: 0 };
}
