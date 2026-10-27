import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_UPSTREAM } from "../src/origins.ts";
import {
  BODY_CAP,
  captureDir,
  captureMode,
  capped,
  readFigures,
  redactedHeaders,
  refuseExistingCapture,
  scrubSecrets,
  startRelay,
  writeCapture,
  type TeeRecord,
} from "../scripts/live.ts";

const TOKEN = "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7";

function pairsOf(entries: Record<string, string>): Array<[string, string]> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(entries)) headers.set(name, value);
  return redactedHeaders(headers);
}

function serveJson(payload: unknown): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(payload) });
}

describe("the live capture's headers", () => {
  test("an authorization value never survives into the capture", () => {
    const pairs = pairsOf({ authorization: `Bearer ${TOKEN}`, "user-agent": "Bun/1.3.11" });
    expect(pairs).toEqual([
      ["authorization", "<redacted>"],
      ["user-agent", "Bun/1.3.11"],
    ]);
    expect(JSON.stringify(pairs)).not.toContain(TOKEN);
  });

  test("a scheme other than bearer is redacted too", () => {
    expect(pairsOf({ authorization: `Basic ${TOKEN}` })).toEqual([["authorization", "<redacted>"]]);
  });

  test("a header other than authorization keeps its value", () => {
    // a Headers object iterates its names sorted, so the fixture's order is the sorted one
    expect(pairsOf({ "x-freebuff-instance-id": "inst-1", "content-type": "application/json" })).toEqual([
      ["content-type", "application/json"],
      ["x-freebuff-instance-id", "inst-1"],
    ]);
  });
});

describe("the recording relay", () => {
  test("a recorded request is redacted and a compressed answer is recorded decoded and de-framed", async () => {
    const payload = '{"ok":true}';
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(Bun.gzipSync(new TextEncoder().encode(payload)), {
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
        }),
    });
    const records: TeeRecord[] = [];
    let relay: ReturnType<typeof startRelay> | undefined;
    try {
      relay = startRelay(`http://127.0.0.1:${upstream.port}`, records);
      const answer = await fetch(`${relay.base}/api/v1/freebuff/streak`, {
        headers: { authorization: `Bearer ${TOKEN}`, "x-probe": "1" },
      });
      expect(await answer.text()).toBe(payload);
      expect(answer.headers.get("content-encoding")).toBeNull();
    } finally {
      relay?.stop();
      upstream.stop(true);
    }

    expect(records.map((record) => record.direction)).toEqual(["request", "response"]);
    const [request, response] = records;
    expect(request?.path).toBe("/api/v1/freebuff/streak");
    expect(request?.headers).toContainEqual(["authorization", "<redacted>"]);
    expect(JSON.stringify(records)).not.toContain(TOKEN);
    expect(response?.status).toBe(200);
    expect(response?.body).toBe(payload);
    const responseHeaderNames = response?.headers.map(([name]) => name) ?? [];
    expect(responseHeaderNames).not.toContain("content-encoding");
    expect(responseHeaderNames).not.toContain("content-length");
    expect(responseHeaderNames).not.toContain("transfer-encoding");
  });
});

describe("the figures read", () => {
  test("requires the session window and the stats figure", async () => {
    const both = serveJson({ accounts: [{ figures: [{ id: "session" }, { id: "stats" }] }] });
    const statsOnly = serveJson({ accounts: [{ figures: [{ id: "stats" }] }] });
    try {
      expect(await readFigures(`http://127.0.0.1:${both.port}`, [TOKEN])).toHaveLength(2);
      await expect(readFigures(`http://127.0.0.1:${statsOnly.port}`, [TOKEN])).rejects.toThrow("no session figure");
    } finally {
      both.stop(true);
      statsOnly.stop(true);
    }
  });
});

describe("the capture's class", () => {
  test("the real origin writes the live capture", () => {
    expect(captureMode(DEFAULT_UPSTREAM)).toEqual({ live: true, dirSuffix: "", title: "live verification" });
  });

  test("any other origin writes a stub capture", () => {
    expect(captureMode("http://127.0.0.1:1")).toEqual({ live: false, dirSuffix: "-stub", title: "stub plumbing run" });
  });
});

describe("the capture write", () => {
  test("a stub run lands in its own dir, titled as one, and a second run is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "fbp-live-test-"));
    const mode = captureMode("http://127.0.0.1:1");
    const dir = captureDir(mode, root);
    expect(dir.endsWith("-live-stub")).toBe(true);

    const capture = { records: [], origin: "http://127.0.0.1:1", figures: [], statuses: { plain: 200, streamed: 200 }, mode };
    writeCapture(capture, dir);
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("# stub plumbing run");
    expect(() => refuseExistingCapture(dir)).toThrow("refusing to overwrite it");
    expect(() => writeCapture(capture, dir)).toThrow("refusing to overwrite it");
  });
});

describe("a red path", () => {
  test("scrubs every secret out of an upstream answer it would print", () => {
    expect(scrubSecrets(`bad token ${TOKEN} and admin`, [TOKEN, "admin", ""])).toBe("bad token <redacted> and <redacted>");
    expect(scrubSecrets("nothing to hide", [TOKEN])).toBe("nothing to hide");
  });
});

describe("the live capture's body cap", () => {
  test("a body at the cap rides whole", () => {
    const atCap = "x".repeat(BODY_CAP);
    expect(capped(atCap)).toEqual({ body: atCap });
  });

  test("a body past the cap is cut to it and marked", () => {
    const result = capped("x".repeat(BODY_CAP + 1));
    expect(result.body.length).toBe(BODY_CAP);
    expect(result.truncated).toBe(true);
  });
});
