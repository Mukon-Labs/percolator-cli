import assert from "node:assert/strict";
import test from "node:test";
import {
  planLegacyAdlPartitionRepairs,
  type PartitionState,
  type PartitionWitness,
} from "./simulate-current-lp-adl-recovery.ts";

const ADL_ONE = 1_000_000_000_000_000n;

function partition(overrides: Partial<PartitionState> = {}): PartitionState {
  return {
    asset: 0,
    side: 1,
    oiEff: 546_938_771n,
    weightSum: 1_921_853_997n,
    storedCount: 1n,
    currentA: 165_975_544_720_519n,
    epoch: 0n,
    mode: 0,
    ...overrides,
  };
}

const lpWitness: PartitionWitness = {
  asset: 0,
  side: 1,
  lossWeight: 1_921_853_997n,
};

test("raises a legacy reissued partition to the canonical OI/weight ratio", () => {
  const [plan] = planLegacyAdlPartitionRepairs([partition()], [lpWitness]);
  assert.equal(plan.kind, "raise-a");
  assert.equal(plan.canonicalA, 546_938_771n * ADL_ONE / 1_921_853_997n);
  assert.equal(plan.oiEff, 546_938_771n);
  assert.equal(plan.weightSum, 1_921_853_997n);
});

test("epoch-resets a fully drained side with a stored legacy leg", () => {
  const [plan] = planLegacyAdlPartitionRepairs(
    [partition({ asset: 1, oiEff: 0n, weightSum: 15_777n, currentA: 906_394_617_557_016n })],
    [{ asset: 1, side: 1, lossWeight: 15_777n }],
  );
  assert.equal(plan.kind, "epoch-reset");
  assert.equal(plan.canonicalA, ADL_ONE);
});

test("does not repair an already canonical ADL partition", () => {
  const state = partition({ currentA: 546_938_771n * ADL_ONE / 1_921_853_997n });
  assert.deepEqual(planLegacyAdlPartitionRepairs([state], [lpWitness]), []);
});

test("rejects a repair that would decrease A or lacks the affected LP witness", () => {
  const canonical = 546_938_771n * ADL_ONE / 1_921_853_997n;
  assert.throws(
    () => planLegacyAdlPartitionRepairs([partition({ currentA: canonical + 1n })], [lpWitness]),
    /unsafe A decrease/,
  );
  assert.throws(
    () => planLegacyAdlPartitionRepairs([partition()], []),
    /lacks an LP witness/,
  );
});
