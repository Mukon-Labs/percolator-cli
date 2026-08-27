import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  V16_ASSET_ACTION,
  V16_OPERATION_TAG,
  V16_ORACLE_FLAG,
  V16_ORACLE_PROGRAM,
  classifyV16OracleAccount,
  encodeConfigureHybridOracle,
  encodeConfigurePermissionlessResolve,
  encodeForceCloseAbandonedAsset,
  encodeRestartAssetOracle,
  encodeResolveStalePermissionless,
  encodeUpdateAssetLifecycle,
  encodeUpdateMarketInitFeePolicy,
  expectedV16OracleFeedBinding,
} from "../src/mukon/deployed-v16.js";
import {
  encConfigureHybridOracle as encUpstreamConfigureHybridOracle,
  encConfigurePermissionlessResolve as encUpstreamConfigurePermissionlessResolve,
  encForceCloseAbandonedAsset as encUpstreamForceCloseAbandonedAsset,
  encRestartAssetOracle as encUpstreamRestartAssetOracle,
  encResolveStalePermissionless as encUpstreamResolveStalePermissionless,
  encUpdateAssetLifecycle as encUpstreamUpdateAssetLifecycle,
  encUpdateMarketInitFeePolicy as encUpstreamUpdateMarketInitFeePolicy,
} from "../src/v16/instructions.js";

const authority = new PublicKey("11111111111111111111111111111111");
const feed1 = "01".repeat(32);
const feed2 = "02".repeat(32);
const feed3 = "03".repeat(32);

assert.deepEqual(V16_ASSET_ACTION, {
  Activate: 0,
  DrainOnly: 1,
  Retire: 2,
  Shutdown: 3,
});

const hybrid = encodeConfigureHybridOracle({
  assetIndex: 3,
  nowSlot: 9n,
  nowUnixTimestamp: 10n,
  feeds: [feed1, feed2, feed3],
  flags: V16_ORACLE_FLAG.DivideLeg2,
  maxStalenessSeconds: 60n,
  hybridSoftStaleSlots: 120n,
  markEwmaHalflifeSlots: 30n,
  markMinimumFee: 4n,
  invert: true,
  unitScale: 1_000,
  confidenceFilterBps: 250,
});
assert.equal(hybrid.length, 156);
assert.equal(hybrid[0], V16_OPERATION_TAG.ConfigureHybridOracle);
assert.equal(hybrid.readUInt16LE(1), 3);
assert.equal(hybrid.readBigUInt64LE(3), 9n);
assert.equal(hybrid.readBigInt64LE(11), 10n);
assert.equal(hybrid[19], 3);
assert.equal(hybrid[20], V16_ORACLE_FLAG.DivideLeg2);
assert.equal(hybrid[53], 1);
assert.equal(hybrid.readUInt32LE(54), 1_000);
assert.equal(hybrid.readUInt16LE(58), 250);
assert.equal(hybrid.subarray(60, 92).toString("hex"), feed1);
assert.equal(hybrid.subarray(92, 124).toString("hex"), feed2);
assert.equal(hybrid.subarray(124, 156).toString("hex"), feed3);
assert.ok(hybrid.equals(encUpstreamConfigureHybridOracle({
  assetIndex: 3,
  nowSlot: 9n,
  nowUnixTs: 10n,
  oracleLegCount: 3,
  oracleLegFlags: V16_ORACLE_FLAG.DivideLeg2,
  maxStalenessSecs: 60n,
  hybridSoftStaleSlots: 120n,
  markEwmaHalflifeSlots: 30n,
  markMinFee: 4n,
  invert: 1,
  unitScale: 1_000,
  confFilterBps: 250,
  oracleLegFeeds: [feed1, feed2, feed3],
})), "deployed hybrid-oracle wire drifted from the shared upstream tag");

assert.throws(() => encodeConfigureHybridOracle({
  assetIndex: 0,
  nowSlot: 1n,
  nowUnixTimestamp: 1n,
  feeds: [feed1],
  flags: V16_ORACLE_FLAG.DivideLeg2,
  maxStalenessSeconds: 1n,
  hybridSoftStaleSlots: 1n,
  markEwmaHalflifeSlots: 1n,
  markMinimumFee: 0n,
}), /single-leg/);
assert.throws(() => encodeConfigureHybridOracle({
  assetIndex: 0,
  nowSlot: 1n,
  nowUnixTimestamp: 1n,
  feeds: [feed1, feed1],
  maxStalenessSeconds: 1n,
  hybridSoftStaleSlots: 1n,
  markEwmaHalflifeSlots: 1n,
  markMinimumFee: 0n,
}), /distinct/);

const permissionless = encodeConfigurePermissionlessResolve({
  staleSlots: 100n,
  forceCloseDelaySlots: 200n,
});
assert.equal(permissionless.length, 17);
assert.equal(permissionless[0], 38);
assert.equal(permissionless.readBigUInt64LE(1), 100n);
assert.equal(permissionless.readBigUInt64LE(9), 200n);
assert.ok(permissionless.equals(encUpstreamConfigurePermissionlessResolve({
  staleSlots: 100n,
  forceCloseDelaySlots: 200n,
})));

const resolve = encodeResolveStalePermissionless(300n);
assert.equal(resolve.length, 9);
assert.equal(resolve[0], 39);
assert.equal(resolve.readBigUInt64LE(1), 300n);
assert.ok(resolve.equals(encUpstreamResolveStalePermissionless(300n)));

const lifecycle = encodeUpdateAssetLifecycle({
  action: V16_ASSET_ACTION.Activate,
  assetIndex: 4,
  nowSlot: 500n,
  initialPrice: 600n,
  insuranceAuthority: authority,
  insuranceOperator: authority,
  backingBucketAuthority: authority,
  oracleAuthority: authority,
});
assert.equal(lifecycle.length, 148);
assert.equal(lifecycle[0], 40);
assert.equal(lifecycle[1], 0);
assert.equal(lifecycle.readUInt16LE(2), 4);
assert.equal(lifecycle.readBigUInt64LE(4), 500n);
assert.equal(lifecycle.readBigUInt64LE(12), 600n);
assert.ok(lifecycle.equals(encUpstreamUpdateAssetLifecycle({
  action: V16_ASSET_ACTION.Activate,
  assetIndex: 4,
  nowSlot: 500n,
  initialPrice: 600n,
  insuranceAuthority: authority,
  insuranceOperator: authority,
  backingBucketAuthority: authority,
  oracleAuthority: authority,
})));

const drainOnly = encodeUpdateAssetLifecycle({
  action: V16_ASSET_ACTION.DrainOnly,
  assetIndex: 4,
  nowSlot: 0n,
  initialPrice: 0n,
  insuranceAuthority: authority,
  insuranceOperator: authority,
  backingBucketAuthority: authority,
  oracleAuthority: authority,
});
assert.equal(drainOnly[1], 1);
assert.equal(drainOnly.readBigUInt64LE(4), 0n);
assert.ok(drainOnly.equals(encUpstreamUpdateAssetLifecycle({
  action: V16_ASSET_ACTION.DrainOnly,
  assetIndex: 4,
  nowSlot: 0n,
  initialPrice: 0n,
  insuranceAuthority: authority,
  insuranceOperator: authority,
  backingBucketAuthority: authority,
  oracleAuthority: authority,
})));
assert.throws(() => encodeUpdateAssetLifecycle({
  action: V16_ASSET_ACTION.DrainOnly,
  assetIndex: 4,
  nowSlot: 1n,
  initialPrice: 0n,
  insuranceAuthority: authority,
  insuranceOperator: authority,
  backingBucketAuthority: authority,
  oracleAuthority: authority,
}), /drain-only/);
assert.throws(() => encodeUpdateAssetLifecycle({
  action: V16_ASSET_ACTION.Retire,
  assetIndex: 4,
  nowSlot: 0n,
  initialPrice: 0n,
  insuranceAuthority: authority,
  insuranceOperator: authority,
  backingBucketAuthority: authority,
  oracleAuthority: authority,
}), /now slot/);
assert.throws(() => encodeUpdateAssetLifecycle({
  action: V16_ASSET_ACTION.Shutdown,
  assetIndex: 4,
  nowSlot: 1n,
  initialPrice: 1n,
  insuranceAuthority: authority,
  insuranceOperator: authority,
  backingBucketAuthority: authority,
  oracleAuthority: authority,
}), /zero initial price/);

const initFee = encodeUpdateMarketInitFeePolicy(700n);
assert.equal(initFee.length, 17);
assert.equal(initFee[0], 59);
assert.equal(initFee.readBigUInt64LE(1), 700n);
assert.equal(initFee.readBigUInt64LE(9), 0n);
assert.ok(initFee.equals(encUpstreamUpdateMarketInitFeePolicy(700n)));

const forceClose = encodeForceCloseAbandonedAsset({ assetIndex: 2, nowSlot: 800n, closeQuantity: 900n });
assert.equal(forceClose.length, 27);
assert.equal(forceClose[0], 64);
assert.equal(forceClose.readUInt16LE(1), 2);
assert.equal(forceClose.readBigUInt64LE(3), 800n);
assert.equal(forceClose.readBigUInt64LE(11), 900n);
assert.ok(forceClose.equals(encUpstreamForceCloseAbandonedAsset({
  assetIndex: 2,
  nowSlot: 800n,
  closeQ: 900n,
})));

const restart = encodeRestartAssetOracle({ assetIndex: 1, nowSlot: 1_000n, initialPrice: 1_100n });
assert.equal(restart.length, 19);
assert.equal(restart[0], 69);
assert.equal(restart.readUInt16LE(1), 1);
assert.equal(restart.readBigUInt64LE(3), 1_000n);
assert.equal(restart.readBigUInt64LE(11), 1_100n);
assert.ok(restart.equals(encUpstreamRestartAssetOracle({
  assetIndex: 1,
  nowSlot: 1_000n,
  initialPrice: 1_100n,
})));

const pythData = Buffer.alloc(134);
Buffer.from([0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]).copy(pythData);
pythData[40] = 1;
assert.equal(classifyV16OracleAccount(V16_ORACLE_PROGRAM.PythReceiver, pythData), "pyth");
pythData[40] = 0;
assert.throws(() => classifyV16OracleAccount(V16_ORACLE_PROGRAM.PythReceiver, pythData), /fully verified/);

const switchboardData = Buffer.alloc(3_208);
Buffer.from([196, 27, 108, 196, 10, 215, 219, 40]).copy(switchboardData);
assert.equal(classifyV16OracleAccount(V16_ORACLE_PROGRAM.SwitchboardDevnet, switchboardData), "switchboard");

const chainlinkData = Buffer.alloc(248);
Buffer.from([96, 179, 69, 66, 128, 129, 73, 117]).copy(chainlinkData);
assert.equal(classifyV16OracleAccount(V16_ORACLE_PROGRAM.ChainlinkStore, chainlinkData), "chainlink");

assert.equal(expectedV16OracleFeedBinding({
  provider: "pyth",
  account: authority,
  pythFeedId: feed1,
}).toString("hex"), feed1);
assert.ok(expectedV16OracleFeedBinding({
  provider: "switchboard",
  account: authority,
}).equals(authority.toBuffer()));
assert.throws(() => expectedV16OracleFeedBinding({
  provider: "chainlink",
  account: authority,
  pythFeedId: feed1,
}), /non-Pyth/);

console.log("v16 operations tests: 51/51 pass");
