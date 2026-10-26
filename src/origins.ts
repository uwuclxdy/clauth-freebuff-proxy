/**
 * The one upstream origin the proxy talks to: a single env seam beside the real
 * default, read at each access so a test can retarget it between calls.
 */

export const UPSTREAM_BASE_ENV = "FREEBUFF_UPSTREAM_BASE_URL";
const DEFAULT_UPSTREAM = "https://www.codebuff.com";

/**
 * The upstream base URL, no trailing slash. A schemeless value dials https;
 * a bare `codebuff.com` host normalizes to `www.`, like the CLI's own client.
 */
export function upstreamBase(): string {
  const raw = process.env[UPSTREAM_BASE_ENV];
  const candidate = raw !== undefined && raw.trim() !== "" ? raw.trim() : DEFAULT_UPSTREAM;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  const url = new URL(withScheme);
  if (url.hostname === "codebuff.com") url.hostname = "www.codebuff.com";
  return url.toString().replace(/\/+$/, "");
}
