import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error portable ESM helper
import { errorDetails } from "../skills/wondertoken/scripts/local.mjs";

test("fetch permission errors request host permission without declaring a service outage", () => {
  const cause = new AggregateError([Object.assign(new Error("private address"), { code: "EPERM" })]);
  const result = errorDetails(new TypeError("fetch failed", { cause }));
  assert.deepEqual(result, { error: "LOCAL_PERMISSION_DENIED", causeCodes: ["EPERM"], recovery: "request_host_permission", serviceStatus: "unknown" });
  assert.ok(!JSON.stringify(result).includes("private address"));
});

test("refused connections stay distinct from permission denial and business failures", () => {
  assert.deepEqual(errorDetails(new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) })), {
    error: "fetch failed", causeCodes: ["ECONNREFUSED"], recovery: "check_connection",
  });
  assert.deepEqual(errorDetails(new Error("PLAYER_NOT_FOUND")), { error: "PLAYER_NOT_FOUND" });
  assert.deepEqual(errorDetails(new TypeError("fetch failed")), { error: "fetch failed", causeCodes: [], recovery: "check_connection" });
});
