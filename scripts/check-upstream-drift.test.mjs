import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = resolve(fileURLToPath(new URL("./check-upstream-drift.mjs", import.meta.url)));

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(repository, message) {
  writeFileSync(join(repository, `${message}.txt`), message);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}

function initializeRepository(repository) {
  mkdirSync(repository, { recursive: true });
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.name", "Upstream Drift Test"]);
  git(repository, ["config", "user.email", "upstream-drift-test@example.invalid"]);
  return commit(repository, "baseline");
}

function runChecker(workspace, manifest) {
  return spawnSync(process.execPath, [checker, "--workspace", workspace, "--manifest", manifest], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("passes at the audited tip and reports a later upstream commit", () => {
  const workspace = mkdtempSync(join(tmpdir(), "upstream-drift-"));
  try {
    const repository = join(workspace, "fixture");
    const baseline = initializeRepository(repository);
    const manifest = join(workspace, "manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        repositories: [
          {
            name: "fixture",
            relativePath: "fixture",
            upstreamRef: "HEAD",
            auditedUpstreamSha: baseline,
            policy: "test",
            requiredAncestorOf: baseline,
          },
        ],
      }),
    );

    const current = runChecker(workspace, manifest);
    assert.equal(current.status, 0, current.stderr);
    assert.match(current.stdout, /OK\s+MAIN fixture/);

    const advanced = commit(repository, "upstream-fix");
    const drifted = runChecker(workspace, manifest);
    assert.equal(drifted.status, 2, drifted.stderr);
    assert.match(drifted.stdout, /DRIFT MAIN fixture: advanced/);
    assert.match(drifted.stdout, new RegExp(advanced.slice(0, 7)));
    assert.match(drifted.stdout, /upstream-fix/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
