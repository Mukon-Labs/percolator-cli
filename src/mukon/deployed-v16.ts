import { PublicKey } from "@solana/web3.js";

const encU8 = (value: number): Buffer => { const out = Buffer.alloc(1); out.writeUInt8(value); return out; };
const encU16 = (value: number): Buffer => { const out = Buffer.alloc(2); out.writeUInt16LE(value); return out; };
const encU32 = (value: number): Buffer => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
const encU64 = (value: bigint): Buffer => { const out = Buffer.alloc(8); out.writeBigUInt64LE(value); return out; };
const encI64 = (value: bigint): Buffer => { const out = Buffer.alloc(8); out.writeBigInt64LE(value); return out; };
const encU128 = (value: bigint): Buffer => {
  if (value < 0n || value >= (1n << 128n)) throw new Error("value must fit u128");
  const out = Buffer.alloc(16);
  out.writeBigUInt64LE(value & ((1n << 64n) - 1n), 0);
  out.writeBigUInt64LE(value >> 64n, 8);
  return out;
};
const encPubkey = (value: PublicKey | string): Buffer => (
  typeof value === "string" ? new PublicKey(value) : value
).toBuffer();

/**
 * Compatibility-locked v16 instructions supported by the deployed Mukon wrapper
 * (wrapper source a868895). This module is intentionally separate from the
 * legacy single-slab CLI ABI in ../abi/instructions.ts.
 */
export const V16_OPERATION_TAG = {
  ConfigureHybridOracle: 34,
  ConfigurePermissionlessResolve: 38,
  ResolveStalePermissionless: 39,
  UpdateAssetLifecycle: 40,
  UpdateMarketInitFeePolicy: 59,
  ForceCloseAbandonedAsset: 64,
  RestartAssetOracle: 69,
} as const;

export const V16_ASSET_ACTION = {
  Activate: 0,
  DrainOnly: 1,
  Retire: 2,
  Shutdown: 3,
} as const;

export const V16_ORACLE_FLAG = {
  DivideLeg2: 1 << 0,
  DivideLeg3: 1 << 1,
} as const;

const ORACLE_LEG_CAP = 3;
const ORACLE_FLAGS_MASK = V16_ORACLE_FLAG.DivideLeg2 | V16_ORACLE_FLAG.DivideLeg3;
const ZERO_FEED = Buffer.alloc(32);

export type Bytes32Input = PublicKey | Uint8Array | string;

function bytes32(value: Bytes32Input, label: string): Buffer {
  if (value instanceof PublicKey) return value.toBuffer();
  if (typeof value !== "string") {
    if (value.length !== 32) throw new Error(`${label} must be exactly 32 bytes`);
    return Buffer.from(value);
  }

  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  try {
    return new PublicKey(value).toBuffer();
  } catch {
    throw new Error(`${label} must be a 32-byte hex value or Solana public key`);
  }
}

function nonZeroU64(value: bigint, label: string): bigint {
  if (value <= 0n) throw new Error(`${label} must be greater than zero`);
  return value;
}

function assertU16(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${label} must fit u16`);
  }
}

function normalizeOracleFeeds(
  feeds: readonly Bytes32Input[],
  flags: number,
): [Buffer, Buffer, Buffer] {
  if (!Number.isInteger(flags) || flags < 0 || (flags & ~ORACLE_FLAGS_MASK) !== 0) {
    throw new Error("oracle leg flags contain unsupported bits");
  }
  if (feeds.length < 1 || feeds.length > ORACLE_LEG_CAP) {
    throw new Error("hybrid oracle requires one to three feeds");
  }
  if (feeds.length === 1 && flags !== 0) {
    throw new Error("single-leg hybrid oracle cannot use divide flags");
  }
  if (feeds.length === 2 && (flags & V16_ORACLE_FLAG.DivideLeg3) !== 0) {
    throw new Error("DivideLeg3 requires a third oracle leg");
  }

  const normalized = feeds.map((feed, index) => bytes32(feed, `oracle feed ${index + 1}`));
  if (normalized.some((feed) => feed.equals(ZERO_FEED))) {
    throw new Error("configured oracle feeds must be non-zero");
  }
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      if (normalized[i].equals(normalized[j])) {
        throw new Error("configured oracle feeds must be distinct");
      }
    }
  }

  return [normalized[0], normalized[1] ?? ZERO_FEED, normalized[2] ?? ZERO_FEED];
}

export interface ConfigureHybridOracleArgs {
  assetIndex: number;
  nowSlot: bigint;
  nowUnixTimestamp: bigint;
  feeds: readonly Bytes32Input[];
  flags?: number;
  maxStalenessSeconds: bigint;
  hybridSoftStaleSlots: bigint;
  markEwmaHalflifeSlots: bigint;
  markMinimumFee: bigint;
  invert?: boolean;
  unitScale?: number;
  confidenceFilterBps?: number;
}

export function encodeConfigureHybridOracle(args: ConfigureHybridOracleArgs): Buffer {
  assertU16(args.assetIndex, "asset index");
  const flags = args.flags ?? 0;
  const feeds = normalizeOracleFeeds(args.feeds, flags);
  const unitScale = args.unitScale ?? 0;
  const confidenceFilterBps = args.confidenceFilterBps ?? 0;
  if (!Number.isInteger(unitScale) || unitScale < 0 || unitScale > 0xffff_ffff) {
    throw new Error("unit scale must fit u32");
  }
  assertU16(confidenceFilterBps, "confidence filter bps");

  return Buffer.concat([
    encU8(V16_OPERATION_TAG.ConfigureHybridOracle),
    encU16(args.assetIndex),
    encU64(nonZeroU64(args.nowSlot, "now slot")),
    encI64(args.nowUnixTimestamp),
    encU8(args.feeds.length),
    encU8(flags),
    encU64(nonZeroU64(args.maxStalenessSeconds, "max staleness seconds")),
    encU64(nonZeroU64(args.hybridSoftStaleSlots, "hybrid soft-stale slots")),
    encU64(nonZeroU64(args.markEwmaHalflifeSlots, "mark EWMA half-life slots")),
    encU64(args.markMinimumFee),
    encU8(args.invert ? 1 : 0),
    encU32(unitScale),
    encU16(confidenceFilterBps),
    ...feeds,
  ]);
}

export function encodeConfigurePermissionlessResolve(args: {
  staleSlots: bigint;
  forceCloseDelaySlots: bigint;
}): Buffer {
  return Buffer.concat([
    encU8(V16_OPERATION_TAG.ConfigurePermissionlessResolve),
    encU64(nonZeroU64(args.staleSlots, "stale slots")),
    encU64(nonZeroU64(args.forceCloseDelaySlots, "force-close delay slots")),
  ]);
}

export function encodeResolveStalePermissionless(nowSlot: bigint): Buffer {
  return Buffer.concat([
    encU8(V16_OPERATION_TAG.ResolveStalePermissionless),
    encU64(nonZeroU64(nowSlot, "now slot")),
  ]);
}

export interface UpdateAssetLifecycleArgs {
  action: number;
  assetIndex: number;
  nowSlot: bigint;
  initialPrice: bigint;
  insuranceAuthority: PublicKey | string;
  insuranceOperator: PublicKey | string;
  backingBucketAuthority: PublicKey | string;
  oracleAuthority: PublicKey | string;
}

export function encodeUpdateAssetLifecycle(args: UpdateAssetLifecycleArgs): Buffer {
  if (!Object.values(V16_ASSET_ACTION).includes(args.action as never)) {
    throw new Error("asset lifecycle action is unsupported");
  }
  assertU16(args.assetIndex, "asset index");
  if (args.action === V16_ASSET_ACTION.Activate) {
    nonZeroU64(args.initialPrice, "initial price");
  } else if (args.initialPrice !== 0n) {
    throw new Error("non-activation lifecycle actions require a zero initial price");
  }
  if (args.action === V16_ASSET_ACTION.DrainOnly) {
    if (args.nowSlot !== 0n) throw new Error("drain-only requires a zero now slot");
  } else if (args.action !== V16_ASSET_ACTION.Activate) {
    nonZeroU64(args.nowSlot, "now slot");
  }
  return Buffer.concat([
    encU8(V16_OPERATION_TAG.UpdateAssetLifecycle),
    encU8(args.action),
    encU16(args.assetIndex),
    encU64(args.nowSlot),
    encU64(args.initialPrice),
    encPubkey(args.insuranceAuthority),
    encPubkey(args.insuranceOperator),
    encPubkey(args.backingBucketAuthority),
    encPubkey(args.oracleAuthority),
  ]);
}

export function encodeUpdateMarketInitFeePolicy(minimumInitFee: bigint): Buffer {
  return Buffer.concat([
    encU8(V16_OPERATION_TAG.UpdateMarketInitFeePolicy),
    encU128(minimumInitFee),
  ]);
}

export function encodeForceCloseAbandonedAsset(args: {
  assetIndex: number;
  nowSlot: bigint;
  closeQuantity: bigint;
}): Buffer {
  assertU16(args.assetIndex, "asset index");
  return Buffer.concat([
    encU8(V16_OPERATION_TAG.ForceCloseAbandonedAsset),
    encU16(args.assetIndex),
    encU64(nonZeroU64(args.nowSlot, "now slot")),
    encU128(nonZeroU64(args.closeQuantity, "close quantity")),
  ]);
}

export function encodeRestartAssetOracle(args: {
  assetIndex: number;
  nowSlot: bigint;
  initialPrice: bigint;
}): Buffer {
  assertU16(args.assetIndex, "asset index");
  return Buffer.concat([
    encU8(V16_OPERATION_TAG.RestartAssetOracle),
    encU16(args.assetIndex),
    encU64(nonZeroU64(args.nowSlot, "now slot")),
    encU64(nonZeroU64(args.initialPrice, "initial price")),
  ]);
}

export const V16_ORACLE_PROGRAM = {
  PythReceiver: new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"),
  SwitchboardMainnet: new PublicKey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv"),
  SwitchboardDevnet: new PublicKey("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2"),
  ChainlinkStore: new PublicKey("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"),
} as const;

export type V16OracleProvider = "pyth" | "switchboard" | "chainlink";

const ORACLE_ACCOUNT_LAYOUT = {
  pyth: { discriminator: Buffer.from([0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]), minLength: 134 },
  switchboard: { discriminator: Buffer.from([196, 27, 108, 196, 10, 215, 219, 40]), minLength: 3_208 },
  chainlink: { discriminator: Buffer.from([96, 179, 69, 66, 128, 129, 73, 117]), minLength: 248 },
} as const;

export function classifyV16OracleAccount(owner: PublicKey, data: Uint8Array): V16OracleProvider {
  let provider: V16OracleProvider;
  if (owner.equals(V16_ORACLE_PROGRAM.PythReceiver)) provider = "pyth";
  else if (owner.equals(V16_ORACLE_PROGRAM.SwitchboardMainnet)
    || owner.equals(V16_ORACLE_PROGRAM.SwitchboardDevnet)) provider = "switchboard";
  else if (owner.equals(V16_ORACLE_PROGRAM.ChainlinkStore)) provider = "chainlink";
  else throw new Error("oracle account owner is not supported by deployed v16");

  const layout = ORACLE_ACCOUNT_LAYOUT[provider];
  if (data.length < layout.minLength) throw new Error(`${provider} oracle account is too short`);
  if (!Buffer.from(data.subarray(0, 8)).equals(layout.discriminator)) {
    throw new Error(`${provider} oracle discriminator is invalid`);
  }
  if (provider === "pyth" && data[40] !== 1) {
    throw new Error("Pyth price update is not fully verified");
  }
  return provider;
}

export function expectedV16OracleFeedBinding(args: {
  provider: V16OracleProvider;
  account: PublicKey;
  pythFeedId?: string;
}): Buffer {
  if (args.provider === "pyth") {
    if (!args.pythFeedId) throw new Error("Pyth requires its canonical feed ID");
    return bytes32(args.pythFeedId, "Pyth feed ID");
  }
  if (args.pythFeedId) throw new Error("non-Pyth feeds bind to the oracle account public key");
  return args.account.toBuffer();
}
