import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/deploy-keeper.yml", import.meta.url), "utf8");

test("release builds while old keeper is live, then targets only the exact Machine", () => {
  const buildIndex = workflow.indexOf("docker buildx build");
  const updateIndex = workflow.indexOf('flyctl machine update "$EXPECTED_MACHINE_ID"');
  assert.ok(buildIndex >= 0, "candidate build is present");
  assert.ok(updateIndex > buildIndex, "candidate is built before the Machine update");
  assert.match(workflow, /existing running singleton Fly machine ID/i);
  assert.match(workflow, /verify-fly-singleton\.mjs[\s\\\n\S]*started/);
});

test("release never stages a stopped Machine or creates/scales a second Machine", () => {
  assert.doesNotMatch(workflow, /--skip-start/);
  assert.doesNotMatch(workflow, /flyctl\s+(?:machine\s+)?(?:clone|run|scale)/);
  assert.doesNotMatch(workflow, /--ha(?:=|\s+)true/);
});

test("release requires a release-specific confirmed push and includes one explicit rollback", () => {
  assert.match(workflow, /rollback_confirmation/);
  assert.match(workflow, /test "\$ROLLBACK_CONFIRMATION" = "ROLLBACK"/);
  assert.match(workflow, /verify-keeper-release-log\.mjs/);
  assert.match(workflow, /steps\.preflight\.outputs\.old_image/);
  assert.match(workflow, /exit 1/);
});

test("release gates promotion and success on operational audits with explicit floors", () => {
  const audits = workflow.match(/scripts\/check-current-market-health\.ts/g) ?? [];
  assert.equal(audits.length, 2, "workflow defines preflight and reusable post-update audits");
  assert.match(workflow, /minimum_lp_risk_equity_usdc/);
  assert.match(workflow, /minimum_domain_insurance_usdc/);
  assert.match(workflow, /AUDIT_PROFILE=operational/);
  assert.match(workflow, /Require a healthy operational audit immediately before promotion/);
  assert.match(workflow, /prove_logs[\s\S]*audit_market "Post-promotion"/);
  assert.match(workflow, /audit_market "Post-rollback"/);
});
