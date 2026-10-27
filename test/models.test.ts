import { describe, expect, test } from "bun:test";
import { CONTRACT_ALIASES, defaultRow, parseCatalogue, resolveRow, slugOf, type Catalogue } from "../src/models.ts";

// The catalogue edges the frozen wire test does not pin: malformed rows,
// resolution precedence, and the default row's absence.

const CATALOGUE = parseCatalogue({
  version: "v0.test.1",
  rows: [
    { key: "m-0000000001", handle: "fbm1.aaaa", displayName: "MiMo v2.6 Flash Slow", access: "open", dataUse: "service", premium: false },
    { key: "m-0000000002", handle: "fbm1.bbbb", displayName: "MiMo", access: "locked", dataUse: "service", premium: false },
    { key: "mimo-v2-6-flash-slow", handle: "fbm1.cccc", displayName: "Unrelated Name", access: "open", dataUse: "service", premium: false },
  ],
}) as Catalogue;

describe("catalogue parsing", () => {
  test("a row without its key or handle is skipped; all-unaddressable rows read as no catalogue", () => {
    expect(parseCatalogue({ version: "v1", rows: [{ handle: "fbm1.x", displayName: "No Key" }] })).toBeNull();
    expect(parseCatalogue({ version: "v1", rows: [{ key: "m-1", displayName: "No Handle" }] })).toBeNull();
    expect(parseCatalogue({ version: "v1", rows: [{ key: "m-1", handle: "fbm1.x" }, "junk", null] })?.rows).toHaveLength(1);
    expect(parseCatalogue({ version: "v1", rows: [] })).toBeNull();
    expect(parseCatalogue("rows")).toBeNull();
  });

  test("absent display fields read as empty, premium only when exactly true", () => {
    const catalogue = parseCatalogue({
      version: "v1",
      rows: [{ key: "m-1", handle: "fbm1.x", premium: "yes", access: 3 }],
    }) as Catalogue;
    expect(catalogue.rows[0]!.label).toBe("");
    expect(catalogue.rows[0]!.slug).toBe("");
    expect(catalogue.rows[0]!.access).toBe("");
    expect(catalogue.rows[0]!.dataUse).toBe("");
    expect(catalogue.rows[0]!.premium).toBe(false);
  });
});

describe("row resolution", () => {
  test("a key match beats a slug collision", () => {
    expect(resolveRow(CATALOGUE, "mimo-v2-6-flash-slow")?.key).toBe("mimo-v2-6-flash-slow");
  });

  test("a slug resolves when no key holds it", () => {
    expect(resolveRow(CATALOGUE, "mimo")?.key).toBe("m-0000000002");
    expect(resolveRow(CATALOGUE, "unrelated-name")?.key).toBe("mimo-v2-6-flash-slow");
  });

  test("every contract alias answers the default row; an unknown id is not a model", () => {
    for (const alias of Object.keys(CONTRACT_ALIASES)) {
      expect(resolveRow(CATALOGUE, alias)?.key).toBe(defaultRow(CATALOGUE)?.key);
    }
    expect(resolveRow(CATALOGUE, "nope")).toBeNull();
    expect(resolveRow(CATALOGUE, "")).toBeNull();
  });

  test("the default row is the first open non-premium row, or none", () => {
    expect(defaultRow(CATALOGUE)?.key).toBe("m-0000000001");
    const locked = parseCatalogue({ version: "v1", rows: [{ key: "m-1", handle: "fbm1.x", access: "locked", premium: false }] }) as Catalogue;
    expect(defaultRow(locked)).toBeNull();
  });
});

describe("slugs", () => {
  test("every non-alphanumeric run collapses to one hyphen, edges trimmed", () => {
    expect(slugOf("A--B")).toBe("a-b");
    expect(slugOf("__ x _")).toBe("x");
    expect(slugOf("")).toBe("");
  });
});
