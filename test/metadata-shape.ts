import { expect } from "bun:test";

// The exact codebuff_metadata key set the chat wire carries (brief row d)
// plus the shapes of its volatile fields; an extra extension field fails.

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function expectMetadataShape(meta: Record<string, unknown>, runId: string, instanceId: string | null): void {
  const expectedKeys = ["client_id", "cost_mode", "run_id", "trace_session_id"];
  if (instanceId !== null) expectedKeys.push("freebuff_instance_id");
  expect(Object.keys(meta).sort()).toEqual(expectedKeys.sort());
  expect(meta.run_id).toBe(runId);
  expect(meta.cost_mode).toBe("free");
  expect(meta.client_id).toMatch(/^[0-9a-z]{13}$/);
  expect(meta.trace_session_id).toMatch(UUID_SHAPE);
  if (instanceId !== null) expect(meta.freebuff_instance_id).toBe(instanceId);
}
