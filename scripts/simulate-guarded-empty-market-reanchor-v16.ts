/**
 * Signed, simulation-only proof for v16 ReanchorEmptyMarket.
 *
 * Required environment (entered locally; never committed):
 *   RPC_URL                    complete devnet RPC URL
 *   MARKET_AUTHORITY_KEYPAIR   absolute path to the current market authority
 *
 * There is intentionally no send or execute mode in this script.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  AOP,
  AS,
  ASSET_ORACLE_WRAPPER_LEN,
  ASSET_SLOT_LEN,
  HEADER_LEN,
  MARKET_GROUP_HEADER_LEN,
  MARKET_GROUP_OFF,
  MG,
  WC,
} from "../../../_v16_cli/src/v16/constants.ts";
import {
  V16_REANCHOR_MARKET,
  V16_REANCHOR_PROGRAM_ID,
  buildReanchorEmptyMarketInstruction,
} from "./guarded-empty-market-reanchor-v16.ts";

export const SOLANA_DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const MAX_MARKET_CAPACITY = 64;
const ASSET_ACTIVE = 2;
const ASSET_DRAIN_ONLY = 3;
const ASSET_RETIRED = 4;
const ASSET_RECOVERY = 5;

function fail(message: string): never {
  throw new Error(message);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
}

export function assertRpcUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("RPC_URL must be a complete http(s) URL.");
  }
  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) {
    fail("RPC_URL must be a complete http(s) URL.");
  }
  return value;
}

export function loadMarketAuthority(keypairPath: string): Keypair {
  if (!path.isAbsolute(keypairPath)) {
    fail("MARKET_AUTHORITY_KEYPAIR must be an absolute path.");
  }
  try {
    const decoded: unknown = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
    if (!Array.isArray(decoded)
      || decoded.length !== 64
      || decoded.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      fail("invalid");
    }
    return Keypair.fromSecretKey(Uint8Array.from(decoded));
  } catch {
    fail("MARKET_AUTHORITY_KEYPAIR is unavailable or invalid.");
  }
}

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function assetWrapperBase(assetIndex: number): number {
  return MARKET_GROUP_OFF + MG.asset_slots + assetIndex * ASSET_SLOT_LEN;
}

function assetEngineBase(assetIndex: number): number {
  return assetWrapperBase(assetIndex) + ASSET_ORACLE_WRAPPER_LEN;
}

function oracleTarget(data: Buffer, assetIndex: number): bigint {
  return assetIndex === 0
    ? readU64(data, HEADER_LEN + WC.oracle_target_price_e6)
    : readU64(data, assetWrapperBase(assetIndex) + AOP.oracle_target_price_e6);
}

function addRange(allowed: Set<number>, offset: number, length: number): void {
  for (let index = offset; index < offset + length; index += 1) allowed.add(index);
}

export interface ReanchorSimulationEffects {
  beforeCurrentSlot: bigint;
  afterCurrentSlot: bigint;
  beforeOracleEpoch: bigint;
  afterOracleEpoch: bigint;
  beforeRiskEpoch: bigint;
  afterRiskEpoch: bigint;
  fundingEpoch: bigint;
  changedByteCount: number;
  activeAssets: Array<{
    assetIndex: number;
    beforeSlot: bigint;
    afterSlot: bigint;
    stagedPrice: bigint;
  }>;
  terminalAssets: number[];
}

export function assertReanchorSimulationEffects(
  before: Buffer,
  after: Buffer,
  expectedAuthority: PublicKey,
): ReanchorSimulationEffects {
  if (before.length !== after.length
    || before.length < MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN
    || !before.subarray(HEADER_LEN + WC.marketauth, HEADER_LEN + WC.marketauth + 32)
      .equals(expectedAuthority.toBuffer())) {
    fail("Market layout, length or authority is invalid.");
  }
  const capacity = before.readUInt32LE(MARKET_GROUP_OFF + MG.asset_slot_capacity);
  const expectedLength = MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN + capacity * ASSET_SLOT_LEN;
  if (capacity < 1 || capacity > MAX_MARKET_CAPACITY || before.length !== expectedLength) {
    fail("Market dynamic layout is invalid.");
  }

  const allowed = new Set<number>();
  for (const field of [MG.risk_epoch, MG.oracle_epoch, MG.slot_last, MG.current_slot]) {
    addRange(allowed, MARKET_GROUP_OFF + field, 8);
  }
  addRange(allowed, MARKET_GROUP_OFF + MG.loss_stale_active, 1);

  const activeAssets: ReanchorSimulationEffects["activeAssets"] = [];
  const terminalAssets: number[] = [];
  for (let assetIndex = 0; assetIndex < capacity; assetIndex += 1) {
    const base = assetEngineBase(assetIndex);
    const lifecycle = before.readUInt8(base + AS.lifecycle);
    if (lifecycle === ASSET_ACTIVE || lifecycle === ASSET_DRAIN_ONLY) {
      for (const field of [
        AS.raw_oracle_target_price,
        AS.effective_price,
        AS.fund_px_last,
        AS.slot_last,
      ]) {
        addRange(allowed, base + field, 8);
      }
      const stagedPrice = oracleTarget(before, assetIndex);
      const afterSlot = readU64(after, base + AS.slot_last);
      if (readU64(after, base + AS.raw_oracle_target_price) !== stagedPrice
        || readU64(after, base + AS.effective_price) !== stagedPrice
        || readU64(after, base + AS.fund_px_last) !== stagedPrice) {
        fail(`Asset ${assetIndex} did not adopt its staged authenticated mark.`);
      }
      activeAssets.push({
        assetIndex,
        beforeSlot: readU64(before, base + AS.slot_last),
        afterSlot,
        stagedPrice,
      });
    } else if (lifecycle === ASSET_RETIRED || lifecycle === ASSET_RECOVERY) {
      if (!before.subarray(assetWrapperBase(assetIndex), assetWrapperBase(assetIndex) + ASSET_SLOT_LEN)
        .equals(after.subarray(assetWrapperBase(assetIndex), assetWrapperBase(assetIndex) + ASSET_SLOT_LEN))) {
        fail(`Terminal asset ${assetIndex} changed during simulation.`);
      }
      terminalAssets.push(assetIndex);
    }
  }
  if (activeAssets.length === 0) fail("Simulation contains no Active/DrainOnly assets.");

  const changedOffsets: number[] = [];
  for (let offset = 0; offset < before.length; offset += 1) {
    if (before[offset] === after[offset]) continue;
    changedOffsets.push(offset);
    if (!allowed.has(offset)) fail(`Simulation changed forbidden market byte ${offset}.`);
  }

  const beforeCurrentSlot = readU64(before, MARKET_GROUP_OFF + MG.current_slot);
  const afterCurrentSlot = readU64(after, MARKET_GROUP_OFF + MG.current_slot);
  const beforeOracleEpoch = readU64(before, MARKET_GROUP_OFF + MG.oracle_epoch);
  const afterOracleEpoch = readU64(after, MARKET_GROUP_OFF + MG.oracle_epoch);
  const beforeRiskEpoch = readU64(before, MARKET_GROUP_OFF + MG.risk_epoch);
  const afterRiskEpoch = readU64(after, MARKET_GROUP_OFF + MG.risk_epoch);
  const fundingEpochBefore = readU64(before, MARKET_GROUP_OFF + MG.funding_epoch);
  const fundingEpochAfter = readU64(after, MARKET_GROUP_OFF + MG.funding_epoch);
  if (afterCurrentSlot <= beforeCurrentSlot
    || afterOracleEpoch !== beforeOracleEpoch + 1n
    || afterRiskEpoch !== beforeRiskEpoch + 1n
    || fundingEpochAfter !== fundingEpochBefore
    || after.readUInt8(MARKET_GROUP_OFF + MG.loss_stale_active) !== 0
    || activeAssets.some((asset) => asset.afterSlot !== afterCurrentSlot)) {
    fail("Simulation did not produce the exact guarded re-anchor transition.");
  }

  return {
    beforeCurrentSlot,
    afterCurrentSlot,
    beforeOracleEpoch,
    afterOracleEpoch,
    beforeRiskEpoch,
    afterRiskEpoch,
    fundingEpoch: fundingEpochAfter,
    changedByteCount: changedOffsets.length,
    activeAssets,
    terminalAssets,
  };
}

export function safeSimulationError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Re-anchor simulation failed.";
  return raw
    .replace(/https?:\/\/[^\s]+/gi, "[rpc-url]")
    .replace(/\b(api[-_]?key|token|authorization)\s*([=:])\s*[^\s,;]+/gi, "$1$2[redacted]")
    .slice(0, 800);
}

async function main(): Promise<void> {
  const rpcUrl = assertRpcUrl(requiredEnv("RPC_URL"));
  const authority = loadMarketAuthority(requiredEnv("MARKET_AUTHORITY_KEYPAIR"));
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
  if (await connection.getGenesisHash() !== SOLANA_DEVNET_GENESIS_HASH) {
    fail("RPC_URL is not Solana devnet.");
  }
  const program = await connection.getAccountInfo(V16_REANCHOR_PROGRAM_ID, "confirmed");
  if (!program?.executable || !program.owner.equals(UPGRADEABLE_LOADER)) {
    fail("Reviewed v16 program identity is unavailable or invalid.");
  }
  const marketContext = await connection.getAccountInfoAndContext(V16_REANCHOR_MARKET, {
    commitment: "confirmed",
  });
  if (!marketContext.value?.owner.equals(V16_REANCHOR_PROGRAM_ID)) {
    fail("Reviewed v16 market identity is unavailable or invalid.");
  }
  const before = Buffer.from(marketContext.value.data);
  if (!before.subarray(HEADER_LEN + WC.marketauth, HEADER_LEN + WC.marketauth + 32)
    .equals(authority.publicKey.toBuffer())) {
    fail("MARKET_AUTHORITY_KEYPAIR is not the current market authority.");
  }

  const lifetime = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: authority.publicKey,
    recentBlockhash: lifetime.blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    buildReanchorEmptyMarketInstruction({ authority: authority.publicKey }),
  );
  transaction.sign(authority);
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: true,
    replaceRecentBlockhash: false,
    minContextSlot: marketContext.context.slot,
    accounts: {
      encoding: "base64",
      addresses: [V16_REANCHOR_MARKET.toBase58()],
    },
  });
  if (simulation.value.err) {
    fail(`Simulation rejected: ${JSON.stringify(simulation.value.err)}; logs=${JSON.stringify(simulation.value.logs ?? [])}`);
  }
  const simulatedMarket = simulation.value.accounts?.[0];
  if (!simulatedMarket
    || simulatedMarket.owner !== V16_REANCHOR_PROGRAM_ID.toBase58()
    || simulatedMarket.data[1] !== "base64") {
    fail("RPC did not return the expected post-simulation market account.");
  }
  const after = Buffer.from(simulatedMarket.data[0], "base64");
  const effects = assertReanchorSimulationEffects(before, after, authority.publicKey);

  console.log(JSON.stringify({
    mode: "SIMULATION_ONLY",
    cluster: "devnet",
    program: V16_REANCHOR_PROGRAM_ID.toBase58(),
    market: V16_REANCHOR_MARKET.toBase58(),
    authority: authority.publicKey.toBase58(),
    feePayer: authority.publicKey.toBase58(),
    instructionDataHex: "50",
    accounts: [
      { role: "marketAuthority", signer: true, writable: false },
      { role: "market", signer: false, writable: true },
    ],
    unitsConsumed: simulation.value.unitsConsumed ?? null,
    logs: simulation.value.logs ?? [],
    effects,
    sent: false,
  }, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
}

if (process.argv[1]?.endsWith("simulate-guarded-empty-market-reanchor-v16.ts")) {
  main().catch((error: unknown) => {
    console.error(safeSimulationError(error));
    process.exitCode = 1;
  });
}
