/**
 * The one upstream origin the proxy talks to: a single env seam beside the real
 * default, read at each access so a test can retarget it between calls.
 */

export const UPSTREAM_BASE_ENV = "FREEBUFF_UPSTREAM_BASE_URL";
export const DEFAULT_UPSTREAM = "https://www.codebuff.com";

/**
 * A base URL with a scheme (a schemeless value dials https), `www.` on the bare
 * `codebuff.com` host, and no trailing slash.
 */
export function normalizeUpstreamBase(raw: string): string {
  const candidate = raw.trim() === "" ? DEFAULT_UPSTREAM : raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  const url = new URL(withScheme);
  if (url.hostname === "codebuff.com") url.hostname = "www.codebuff.com";
  return url.toString().replace(/\/+$/, "");
}

/** The upstream base URL, no trailing slash. */
export function upstreamBase(): string {
  return normalizeUpstreamBase(process.env[UPSTREAM_BASE_ENV] ?? DEFAULT_UPSTREAM);
}
