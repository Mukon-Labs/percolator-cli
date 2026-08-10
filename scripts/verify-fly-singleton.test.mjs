import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const verifier = new URL("./verify-fly-singleton.mjs", import.meta.url);
const APP = "ninja-oracle-keeper";
const MACHINE = "d891e161f73358";

function verify(status, app = APP, machine = MACHINE) {
  return spawnSync(process.execPath, [verifier.pathname, app, machine], {
    encoding: "utf8",
    input: JSON.stringify(status),
  });
}

test("accepts the exact started singleton", () => {
  const result = verify({ Name: APP, Machines: [{ id: MACHINE, state: "started" }] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified singleton/);
});

test("accepts the exact stopped singleton", () => {
  const result = verify({ name: APP, machines: [{ ID: MACHINE, State: "stopped" }] });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects an additional machine", () => {
  const result = verify({ Name: APP, Machines: [
    { id: MACHINE, state: "started" },
    { id: "abc123def45678", state: "stopped" },
  ] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one machine/);
});

test("rejects an app or machine mismatch", () => {
  const wrongApp = verify({ Name: "other-app", Machines: [{ id: MACHINE, state: "started" }] });
  assert.notEqual(wrongApp.status, 0);
  assert.match(wrongApp.stderr, /status belongs to/);

  const wrongMachine = verify({ Name: APP, Machines: [{ id: "abc123def45678", state: "started" }] });
  assert.notEqual(wrongMachine.status, 0);
  assert.match(wrongMachine.stderr, /does not match/);
});

test("rejects an in-flight machine state", () => {
  const result = verify({ Name: APP, Machines: [{ id: MACHINE, state: "starting" }] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be started or stopped/);
});
