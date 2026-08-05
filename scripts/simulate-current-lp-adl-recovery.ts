/**
 * Signed, no-broadcast proof for the current Ninja devnet LP ADL recovery.
 *
 * The recovery never rewrites a live portfolio basis. It recapitalizes the LP,
 * then invokes the authority-gated legacy A-partition reconciliation. A sole
 * zero-OI witness is settled and cleared through the normal prior-epoch path.
 */
import "dotenv/config";
import fs from "node:fs";
import process from "node:process";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AS,
  ASSET_ORACLE_WRAPPER_LEN,
  ASSET_SLOT_LEN,
  HEADER_LEN,
  LEG_LEN,
  MARKET_GROUP_OFF,
  MG,
  PA,
  PL,
  PORTFOLIO_ACCOUNT_LEN,
  PORTFOLIO_STATE_OFF,
  WC,
} from "../../_v16_cli/src/v16/constants.ts";

const PROGRAM_ID = new PublicKey("7C37Xn3NLknqmSaxASYy2uRkb1RQcXigPmJCANUNYnvq");
const MARKET = new PublicKey("DNhYhm8Pb2yRjTpk7SNXrevX8zNZ9eZuivxgxyNtwyPP");
const LP_PORTFOLIO = new PublicKey("BWqxjf1GoYqRNZTy6h1txPxBtiiN9MyF5Hd2JtKYGVwS");
const TEST_USDC_MINT = new PublicKey("5NDpr5JHMaW5ghyRTR5DyyEDpqVzbj5R4gfUJEFk3k1T");
const ADL_ONE = 1_000_000_000_000_000n;
const POST_RECOVERY_TARGET = 50_000_000_000n;
const SIMULATION_HEADROOM = 10_000_000_000n;
const PORTFOLIO_LEG_COUNT = 16;
const SIDE_LONG = 0;
const SIDE_SHORT = 1;
const MODE_NORMAL = 0;
const ASSET_NAMES = ["SOL", "BTC", "ETH", "ZEC"] as const;

export interface PartitionState {
  asset: number;
  side: number;
  oiEff: bigint;
  weightSum: bigint;
  storedCount: bigint;
  currentA: bigint;
  epoch: bigint;
  mode: number;
}

export interface PartitionWitness {
  asset: number;
  side: number;
  lossWeight: bigint;
}

export interface PartitionRepairPlan {
  asset: number;
  side: number;
  kind: "raise-a" | "epoch-reset";
  currentA: bigint;
  canonicalA: bigint;
  oiEff: bigint;
  weightSum: bigint;
  epoch: bigint;
  mode: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
}

function loadKeypair(path: string, role: string): Keypair {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    if (!Array.isArray(raw) || raw.length !== 64) fail(`${role} keypair is invalid.`);
    return Keypair.fromSecretKey(new Uint8Array(raw));
  } catch {
    fail(`${role} keypair is unavailable or invalid.`);
  }
}

function readU128(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset) | (data.readBigUInt64LE(offset + 8) << 64n);
}

function readI128(data: Buffer, offset: number): bigint {
  const value = readU128(data, offset);
  return value < (1n << 127n) ? value : value - (1n << 128n);
}

function writeU128(value: bigint): Buffer {
  if (value < 0n || value >= (1n << 128n)) fail("u128 value is out of range.");
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(value & ((1n << 64n) - 1n), 0);
  data.writeBigUInt64LE(value >> 64n, 8);
  return data;
}

function parsePortfolio(data: Buffer): {
  owner: PublicKey;
  capital: bigint;
  pnl: bigint;
  witnesses: PartitionWitness[];
  basisByAsset: Map<number, bigint>;
} {
  if (data.length !== PORTFOLIO_ACCOUNT_LEN) fail("Unexpected portfolio layout.");
  const base = PORTFOLIO_STATE_OFF;
  const witnesses: PartitionWitness[] = [];
  const basisByAsset = new Map<number, bigint>();
  for (let slot = 0; slot < PORTFOLIO_LEG_COUNT; slot += 1) {
    const leg = base + PA.legs + slot * LEG_LEN;
    if (data.readUInt8(leg + PL.active) === 0) continue;
    const asset = data.readUInt32LE(leg + PL.asset_index);
    const basis = readI128(data, leg + PL.basis_pos_q);
    const side = data.readUInt8(leg + PL.side);
    witnesses.push({ asset, side, lossWeight: readU128(data, leg + PL.loss_weight) });
    basisByAsset.set(asset, (basisByAsset.get(asset) ?? 0n) + basis);
  }
  return {
    owner: new PublicKey(data.subarray(base + PA.owner, base + PA.owner + 32)),
    capital: readU128(data, base + PA.capital),
    pnl: readI128(data, base + PA.pnl),
    witnesses,
    basisByAsset,
  };
}

function assetBase(asset: number): number {
  return MARKET_GROUP_OFF + MG.asset_slots + asset * ASSET_SLOT_LEN + ASSET_ORACLE_WRAPPER_LEN;
}

function readPartitions(market: Buffer): PartitionState[] {
  const capacity = market.readUInt32LE(MARKET_GROUP_OFF + MG.asset_slot_capacity);
  const partitions: PartitionState[] = [];
  for (let asset = 0; asset < capacity; asset += 1) {
    const base = assetBase(asset);
    partitions.push(
      {
        asset,
        side: SIDE_LONG,
        oiEff: readU128(market, base + AS.oi_eff_long_q),
        weightSum: readU128(market, base + AS.loss_weight_sum_long),
        storedCount: market.readBigUInt64LE(base + AS.stored_pos_count_long),
        currentA: readU128(market, base + AS.a_long),
        epoch: market.readBigUInt64LE(base + AS.epoch_long),
        mode: market.readUInt8(base + AS.mode_long),
      },
      {
        asset,
        side: SIDE_SHORT,
        oiEff: readU128(market, base + AS.oi_eff_short_q),
        weightSum: readU128(market, base + AS.loss_weight_sum_short),
        storedCount: market.readBigUInt64LE(base + AS.stored_pos_count_short),
        currentA: readU128(market, base + AS.a_short),
        epoch: market.readBigUInt64LE(base + AS.epoch_short),
        mode: market.readUInt8(base + AS.mode_short),
      },
    );
  }
  return partitions;
}

export function planLegacyAdlPartitionRepairs(
  partitions: readonly PartitionState[],
  witnesses: readonly PartitionWitness[],
): PartitionRepairPlan[] {
  const plans: PartitionRepairPlan[] = [];
  for (const partition of partitions) {
    if (partition.weightSum <= partition.oiEff) continue;
    const excessWeight = partition.weightSum - partition.oiEff;
    const witness = witnesses.find(
      (candidate) => candidate.asset === partition.asset && candidate.side === partition.side,
    );
    if (!witness || witness.lossWeight < excessWeight) {
      fail(`Asset ${partition.asset} side ${partition.side} lacks an LP witness for the excess partition.`);
    }
    if (partition.oiEff === 0n) {
      if (partition.storedCount === 0n || partition.weightSum === 0n) {
        fail(`Asset ${partition.asset} side ${partition.side} has inconsistent zero-OI state.`);
      }
      plans.push({
        ...partition,
        kind: "epoch-reset",
        canonicalA: ADL_ONE,
      });
      continue;
    }
    const canonicalA = partition.oiEff * ADL_ONE / partition.weightSum;
    if (canonicalA === 0n || canonicalA > ADL_ONE || canonicalA < partition.currentA) {
      fail(`Asset ${partition.asset} side ${partition.side} requires an unsafe A decrease.`);
    }
    if (canonicalA > partition.currentA) {
      plans.push({ ...partition, kind: "raise-a", canonicalA });
    }
  }
  return plans;
}

function depositInstruction(
  owner: PublicKey,
  sourceAta: PublicKey,
  vaultAta: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: LP_PORTFOLIO, isSigner: false, isWritable: true },
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([3]), writeU128(amount)]),
  });
}

function reconcileInstruction(owner: PublicKey, plan: PartitionRepairPlan): TransactionInstruction {
  const asset = Buffer.alloc(2);
  asset.writeUInt16LE(plan.asset, 0);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: LP_PORTFOLIO, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from([75]), asset, Buffer.from([plan.side])]),
  });
}

function simulatedAccountData(account: { data: string[] } | null | undefined): Buffer {
  if (!account || account.data.length < 2 || account.data[1] !== "base64") {
    fail("Simulation did not return requested account state.");
  }
  return Buffer.from(account.data[0], "base64");
}

function assertPlanApplied(before: Buffer, after: Buffer, plan: PartitionRepairPlan): void {
  const base = assetBase(plan.asset);
  const long = plan.side === SIDE_LONG;
  const aOffset = long ? AS.a_long : AS.a_short;
  const oiOffset = long ? AS.oi_eff_long_q : AS.oi_eff_short_q;
  const weightOffset = long ? AS.loss_weight_sum_long : AS.loss_weight_sum_short;
  const epochOffset = long ? AS.epoch_long : AS.epoch_short;
  const modeOffset = long ? AS.mode_long : AS.mode_short;
  if (readU128(after, base + oiOffset) !== plan.oiEff) fail("Repair changed matched OI.");
  if (plan.kind === "raise-a") {
    if (readU128(after, base + aOffset) !== plan.canonicalA) fail("Repair did not install canonical A.");
    if (readU128(after, base + weightOffset) !== plan.weightSum) fail("Repair changed live loss weight.");
    if (after.readBigUInt64LE(base + epochOffset) !== plan.epoch) fail("Repair changed a live epoch.");
    if (after.readUInt8(base + modeOffset) !== plan.mode) fail("Repair changed live side mode.");
  } else {
    if (readU128(after, base + aOffset) !== ADL_ONE) fail("Full-drain reset did not restore unit A.");
    if (readU128(after, base + weightOffset) !== 0n) fail("Full-drain reset did not clear live weight.");
    if (after.readBigUInt64LE(base + epochOffset) !== plan.epoch + 1n) fail("Full-drain reset did not bump epoch.");
    if (after.readUInt8(base + modeOffset) !== MODE_NORMAL) fail("Full-drain reset was not finalized.");
  }
  if (before.length !== after.length) fail("Repair changed market account size.");
}

async function main(): Promise<void> {
  const rpcUrl = requiredEnv("RPC_URL");
  const lpOwner = loadKeypair(requiredEnv("LP_OWNER_KEYPAIR"), "LP owner");
  const mintAuthority = loadKeypair(requiredEnv("MINT_AUTHORITY_KEYPAIR"), "mint authority");
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
  const [marketInfo, lpInfo, mint] = await Promise.all([
    connection.getAccountInfo(MARKET, "confirmed"),
    connection.getAccountInfo(LP_PORTFOLIO, "confirmed"),
    getMint(connection, TEST_USDC_MINT, "confirmed", TOKEN_PROGRAM_ID),
  ]);
  if (!marketInfo?.owner.equals(PROGRAM_ID) || !lpInfo?.owner.equals(PROGRAM_ID)) {
    fail("Current market or LP portfolio is missing or has the wrong owner.");
  }
  if (mint.decimals !== 6 || !mint.mintAuthority?.equals(mintAuthority.publicKey)) {
    fail("Configured signer is not the six-decimal test-USDC mint authority.");
  }
  const marketBefore = Buffer.from(marketInfo.data);
  const lpBefore = parsePortfolio(Buffer.from(lpInfo.data));
  if (!lpBefore.owner.equals(lpOwner.publicKey)) fail("Configured signer is not the LP owner.");
  const marketauth = new PublicKey(
    marketBefore.subarray(HEADER_LEN + WC.marketauth, HEADER_LEN + WC.marketauth + 32),
  );
  if (!marketauth.equals(lpOwner.publicKey)) fail("LP owner is not the current market authority.");

  const plans = planLegacyAdlPartitionRepairs(readPartitions(marketBefore), lpBefore.witnesses);
  if (plans.length === 0) fail("No legacy ADL partition repair is currently required.");
  console.log(`Mode: SIGNED SIMULATION ONLY | repairs: ${plans.length}`);
  for (const plan of plans) {
    const side = plan.side === SIDE_LONG ? "long" : "short";
    console.log(
      `${ASSET_NAMES[plan.asset] ?? `asset-${plan.asset}`} ${side}: ${plan.kind}, A ${plan.currentA} -> ${plan.canonicalA}, OI ${plan.oiEff}, weight ${plan.weightSum}`,
    );
  }

  const sourceAta = getAssociatedTokenAddressSync(TEST_USDC_MINT, lpOwner.publicKey);
  const vaultAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), MARKET.toBuffer()],
    PROGRAM_ID,
  )[0];
  const vaultAta = getAssociatedTokenAddressSync(TEST_USDC_MINT, vaultAuthority, true);
  const vault = await getAccount(connection, vaultAta, "confirmed", TOKEN_PROGRAM_ID);
  if (!vault.mint.equals(TEST_USDC_MINT) || !vault.owner.equals(vaultAuthority)) {
    fail("Current market vault token account is invalid.");
  }

  const recapAmount = (lpBefore.pnl < 0n ? -lpBefore.pnl : 0n)
    + POST_RECOVERY_TARGET
    + SIMULATION_HEADROOM;
  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    createAssociatedTokenAccountIdempotentInstruction(
      lpOwner.publicKey,
      sourceAta,
      lpOwner.publicKey,
      TEST_USDC_MINT,
    ),
    createMintToInstruction(
      TEST_USDC_MINT,
      sourceAta,
      mintAuthority.publicKey,
      recapAmount,
      [],
      TOKEN_PROGRAM_ID,
    ),
    depositInstruction(lpOwner.publicKey, sourceAta, vaultAta, recapAmount),
    ...plans.map((plan) => reconcileInstruction(lpOwner.publicKey, plan)),
  );
  const simulation = await connection.simulateTransaction(
    transaction,
    [lpOwner, mintAuthority],
    [MARKET, LP_PORTFOLIO],
  );
  if (simulation.value.err) {
    fail(`Recovery simulation failed: ${JSON.stringify(simulation.value.err)}.`);
  }
  const marketAfter = simulatedAccountData(simulation.value.accounts?.[0]);
  const lpAfter = parsePortfolio(simulatedAccountData(simulation.value.accounts?.[1]));
  for (const plan of plans) assertPlanApplied(marketBefore, marketAfter, plan);
  if (lpAfter.capital + lpAfter.pnl < POST_RECOVERY_TARGET) {
    fail("Recovery simulation left LP equity below the post-recovery target.");
  }
  const expectedBasis = new Map(lpBefore.basisByAsset);
  for (const plan of plans) {
    if (plan.kind === "epoch-reset") expectedBasis.delete(plan.asset);
  }
  if (
    lpAfter.basisByAsset.size !== expectedBasis.size
    || [...expectedBasis].some(
      ([asset, basis]) => lpAfter.basisByAsset.get(asset) !== basis,
    )
  ) {
    fail("Recovery simulation changed LP basis outside the fully drained reset side.");
  }
  console.log(
    `PASS: recap + ${plans.length} partition repairs (${simulation.value.unitsConsumed ?? 0} CU). No transaction was sent.`,
  );
}

if (process.argv[1]?.endsWith("simulate-current-lp-adl-recovery.ts")) {
  const rpcUrl = process.env.RPC_URL ?? "";
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "LP ADL recovery proof failed.";
    console.error(rpcUrl ? message.split(rpcUrl).join("[RPC_URL]") : message);
    process.exitCode = 1;
  });
}
