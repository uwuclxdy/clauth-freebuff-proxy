/**
 * The upstream model catalogue (`GET /api/v1/freebuff/models`): a row's `key`
 * (or the slug of its display name) is what a client addresses, its signed
 * `handle` is what the chat body's `model` field carries, and the chat answer
 * reports the key. The client-side contract ids name no fixed row — they
 * answer the catalogue's default open row. An id outside the catalogue is not
 * a model: `resolveRow` answers null and inference refuses it.
 */

export interface CatalogueRow {
  /** The row id the client names and the chat answer reports. */
  key: string;
  /** The signed selector the chat body's `model` field carries. */
  handle: string;
  /** The display name, unchanged. */
  label: string;
  /** The display name's slug, for addressing by short name. */
  slug: string;
  access: string;
  dataUse: string;
  premium: boolean;
}

export interface Catalogue {
  version: string;
  rows: CatalogueRow[];
}

/**
 * The client-side id `clauth proxy check` sends on its inference leg (a model
 * Claude Code itself sends); it names no fixed row, so the catalogue's
 * default open row answers it.
 */
export const CONTRACT_ALIASES: Readonly<Record<string, string>> = {
  "claude-haiku-4-5": "claude-haiku-4-5",
};

/** A display name's addressable slug: lowercase, every non-alphanumeric run
 * collapsed to one hyphen. */
export function slugOf(displayName: string): string {
  return displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Parse a catalogue answer; a row without its key and handle is unaddressable
 * and is skipped, and no rows reads as no catalogue. */
export function parseCatalogue(body: unknown): Catalogue | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const rawRows = raw["rows"];
  if (!Array.isArray(rawRows)) return null;
  const rows: CatalogueRow[] = [];
  for (const rawRow of rawRows) {
    if (typeof rawRow !== "object" || rawRow === null) continue;
    const record = rawRow as Record<string, unknown>;
    const key = typeof record["key"] === "string" ? record["key"] : "";
    const handle = typeof record["handle"] === "string" ? record["handle"] : "";
    if (key === "" || handle === "") continue;
    const label = typeof record["displayName"] === "string" ? record["displayName"] : "";
    rows.push({
      key,
      handle,
      label,
      slug: slugOf(label),
      access: typeof record["access"] === "string" ? record["access"] : "",
      dataUse: typeof record["dataUse"] === "string" ? record["dataUse"] : "",
      premium: record["premium"] === true,
    });
  }
  if (rows.length === 0) return null;
  return { version: typeof raw["version"] === "string" ? raw["version"] : "", rows };
}

/** The first open, non-premium row; the catalogue's default answer. */
export function defaultRow(catalogue: Catalogue): CatalogueRow | null {
  return catalogue.rows.find((row) => row.access === "open" && !row.premium) ?? null;
}

/** Resolve a client id: a row key, a display-name slug, or a contract alias
 * (the default row); anything else is not a model. */
export function resolveRow(catalogue: Catalogue, id: string): CatalogueRow | null {
  const byKey = catalogue.rows.find((row) => row.key === id);
  if (byKey !== undefined) return byKey;
  const bySlug = catalogue.rows.find((row) => row.slug === id);
  if (bySlug !== undefined) return bySlug;
  if (id in CONTRACT_ALIASES) return defaultRow(catalogue);
  return null;
}
