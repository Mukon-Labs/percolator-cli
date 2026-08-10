const MAX_STATUS_BYTES = 1024 * 1024;

function fail(message) {
  console.error(`Fly release gate failed: ${message}`);
  process.exit(1);
}

const [expectedApp, expectedMachineId] = process.argv.slice(2);

if (!expectedApp || !expectedMachineId) {
  fail("expected app name and machine ID arguments");
}

if (!/^[A-Za-z0-9_-]{6,64}$/.test(expectedMachineId)) {
  fail("machine ID has an unexpected format");
}

let rawStatus = "";
process.stdin.setEncoding("utf8");

for await (const chunk of process.stdin) {
  rawStatus += chunk;
  if (Buffer.byteLength(rawStatus, "utf8") > MAX_STATUS_BYTES) {
    fail("status response exceeds 1 MiB");
  }
}

let status;
try {
  status = JSON.parse(rawStatus);
} catch {
  fail("status response is not valid JSON");
}

const reportedApp =
  status.Name ??
  status.name ??
  status.App?.Name ??
  status.App?.name ??
  status.app?.Name ??
  status.app?.name ??
  status.App ??
  status.app;

if (reportedApp !== expectedApp) {
  fail(`status belongs to ${String(reportedApp)}, not ${expectedApp}`);
}

const machines = status.Machines ?? status.machines;
if (!Array.isArray(machines)) {
  fail("status response does not contain a machine list");
}

if (machines.length !== 1) {
  fail(`expected exactly one machine, found ${machines.length}`);
}

const machine = machines[0];
const machineId = machine.ID ?? machine.Id ?? machine.id;
const machineState = machine.State ?? machine.state;

if (machineId !== expectedMachineId) {
  fail(`configured machine ${expectedMachineId} does not match hosted machine ${String(machineId)}`);
}

if (machineState !== "started" && machineState !== "stopped") {
  fail(`machine must be started or stopped, found ${String(machineState)}`);
}

console.log(`Verified singleton ${expectedApp} machine ${expectedMachineId} (${machineState}).`);
