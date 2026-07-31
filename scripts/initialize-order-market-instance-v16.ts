/**
 * One-time v16 order-market generation initializer.
 *
 * Required environment (entered manually; never committed):
 *   RPC_URL                     complete http(s) endpoint
 *   MARKET_AUTHORITY_KEYPAIR    absolute path to the current market-authority keypair
 *
 * The default mode signs and simulates only. A send requires the explicit
 * `--execute` flag, a second unchanged-state check, confirmation, and exact
 * on-chain readback of the generated instance ID.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export const V16_PROGRAM_ID = new PublicKey("7C37Xn3NLknqmSaxASYy2uRkb1RQcXigPmJCANUNYnvq");
export const V16_MARKET = new PublicKey("DNhYhm8Pb2yRjTpk7SNXrevX8zNZ9eZuivxgxyNtwyPP");
export const INITIALIZE_ORDER_MARKET_INSTANCE_TAG = 74;

const MAGIC = 0x5045_5243_5631_3600n;
const VERSION = 16;
const KIND_MARKET = 1;
const HEADER_LEN = 16;
const WRAPPER_CONFIG_LEN = 448;
const MARKET_GROUP_OFF = HEADER_LEN + WRAPPER_CONFIG_LEN;
const MARKET_GROUP_HEADER_LEN = 726;
const ASSET_SLOT_LEN = 1797;
const MARKET_AUTHORITY_OFF = HEADER_LEN;
const ORDER_MARKET_INSTANCE_ID_OFF = HEADER_LEN + WRAPPER_CONFIG_LEN - 8;
const MARKET_GROUP_ID_OFF = MARKET_GROUP_OFF;
const ASSET_SLOT_CAPACITY_OFF = MARKET_GROUP_OFF + 281;
const MARKET_MODE_OFF = MARKET_GROUP_OFF + 594;
const MARKET_MODE_LIVE = 0;

type MarketAccount = { owner: PublicKey; data: Buffer } | null;
type BlockhashLifetime = { blockhash: string; lastValidBlockHeight: number };
type Confirmation = { value: { err: unknown | null } };
type Simulation = { value: { err: unknown | null; unitsConsumed?: number } };

export interface InitializerDependencies {
  readMarket(): Promise<MarketAccount>;
  latestBlockhash(): Promise<BlockhashLifetime>;
  simulate(transaction: Transaction): Promise<Simulation>;
  send(rawTransaction: Buffer): Promise<string>;
  confirm(strategy: BlockhashLifetime & { signature: string }): Promise<Confirmation>;
}

export interface InitializerResult {
  executed: boolean;
  instanceId: bigint;
  signature: string | null;
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseArguments(args: readonly string[]): { execute: boolean } {
  if (args.some((argument) => argument !== "--execute")
    || args.filter((argument) => argument === "--execute").length > 1) {
    fail("The only supported argument is --execute.");
  }
  return { execute: args.includes("--execute") };
}

export function assertRpcUrl(value: string | undefined): string {
  const input = value?.trim();
  if (!input) fail("RPC_URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    fail("RPC_URL must be a complete http(s) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    fail("RPC_URL must be a complete http(s) URL.");
  }
  return input;
}

export function assertExplicitSignerPath(value: string | undefined): string {
  const input = value?.trim();
  if (!input || !path.isAbsolute(input)) {
    fail("MARKET_AUTHORITY_KEYPAIR must be an explicit absolute path.");
  }
  return input;
}

export function loadMarketAuthority(keypairPath: string): Keypair {
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

export function readOrderMarketInstanceId(
  account: MarketAccount,
  expectedAuthority: PublicKey,
): bigint {
  if (!account || !account.owner.equals(V16_PROGRAM_ID)) {
    fail("Current market is missing or not owned by the v16 program.");
  }
  const data = Buffer.from(account.data);
  if (data.length < MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN
    || data.readBigUInt64LE(0) !== MAGIC
    || data.readUInt16LE(8) !== VERSION
    || data.readUInt8(10) !== KIND_MARKET
    || data.subarray(11, HEADER_LEN).some((byte) => byte !== 0)) {
    fail("Current market header or layout is invalid.");
  }
  const capacity = data.readUInt32LE(ASSET_SLOT_CAPACITY_OFF);
  const expectedLength = MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN + capacity * ASSET_SLOT_LEN;
  if (capacity < 1 || capacity > 64 || data.length !== expectedLength) {
    fail("Current market dynamic layout is invalid.");
  }
  const marketId = new PublicKey(
    data.subarray(MARKET_GROUP_ID_OFF, MARKET_GROUP_ID_OFF + 32),
  );
  if (!marketId.equals(V16_MARKET)) {
    fail("Current market identity is invalid.");
  }
  const configuredAuthority = new PublicKey(
    data.subarray(MARKET_AUTHORITY_OFF, MARKET_AUTHORITY_OFF + 32),
  );
  if (!configuredAuthority.equals(expectedAuthority)) {
    fail("MARKET_AUTHORITY_KEYPAIR is not the current market authority.");
  }
  if (data.readUInt8(MARKET_MODE_OFF) !== MARKET_MODE_LIVE) {
    fail("Current market is not Live.");
  }
  return data.readBigUInt64LE(ORDER_MARKET_INSTANCE_ID_OFF);
}

export function assertMarketInstanceUninitialized(
  account: MarketAccount,
  expectedAuthority: PublicKey,
): void {
  if (readOrderMarketInstanceId(account, expectedAuthority) !== 0n) {
    fail("Order market instance is already initialized.");
  }
}

export function generateOrderMarketInstanceId(
  random: (size: number) => Uint8Array = randomBytes,
): bigint {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = Buffer.from(random(8));
    if (bytes.length !== 8) fail("Secure random source returned an invalid length.");
    const instanceId = bytes.readBigUInt64LE(0);
    if (instanceId !== 0n) return instanceId;
  }
  fail("Secure random source failed to generate a non-zero instance ID.");
}

export function initializeOrderMarketInstanceInstruction(
  authority: PublicKey,
  instanceId: bigint,
): TransactionInstruction {
  if (instanceId <= 0n || instanceId > 0xffff_ffff_ffff_ffffn) {
    fail("Order market instance ID must be a non-zero u64.");
  }
  const data = Buffer.alloc(9);
  data.writeUInt8(INITIALIZE_ORDER_MARKET_INSTANCE_TAG, 0);
  data.writeBigUInt64LE(instanceId, 1);
  return new TransactionInstruction({
    programId: V16_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: V16_MARKET, isSigner: false, isWritable: true },
    ],
    data,
  });
}

export function safeInitializerError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Order market initialization failed.";
  return raw
    .replace(/https?:\/\/[^\s]+/gi, "[rpc-url]")
    .replace(/\b(api[-_]?key|token|authorization)\s*([=:])\s*[^\s,;]+/gi, "$1$2[redacted]")
    .slice(0, 500);
}

export async function runOrderMarketInitializer({
  authority,
  dependencies,
  execute,
  random = randomBytes,
  log = console.log,
}: {
  authority: Keypair;
  dependencies: InitializerDependencies;
  execute: boolean;
  random?: (size: number) => Uint8Array;
  log?: (message: string) => void;
}): Promise<InitializerResult> {
  const initialAccount = await dependencies.readMarket();
  assertMarketInstanceUninitialized(initialAccount, authority.publicKey);
  const instanceId = generateOrderMarketInstanceId(random);
  const lifetime = await dependencies.latestBlockhash();
  const transaction = new Transaction({
    feePayer: authority.publicKey,
    recentBlockhash: lifetime.blockhash,
  }).add(initializeOrderMarketInstanceInstruction(authority.publicKey, instanceId));
  transaction.sign(authority);

  log(`Mode: ${execute ? "EXECUTE" : "SIMULATE ONLY"}`);
  log(`Program: ${V16_PROGRAM_ID.toBase58()}`);
  log(`Market: ${V16_MARKET.toBase58()}`);
  log(`Authority: ${authority.publicKey.toBase58()}`);
  log(`Proposed order market instance ID: ${instanceId.toString()}`);

  const simulation = await dependencies.simulate(transaction);
  if (simulation.value.err) {
    fail(`Initialization simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  log(`Simulation OK (${simulation.value.unitsConsumed ?? 0} CU).`);
  if (!execute) {
    log("No transaction was sent. Re-run with --execute only after reviewing this summary.");
    return { executed: false, instanceId, signature: null };
  }

  const preSendAccount = await dependencies.readMarket();
  assertMarketInstanceUninitialized(preSendAccount, authority.publicKey);
  const signature = await dependencies.send(transaction.serialize());
  let confirmation: Confirmation;
  try {
    confirmation = await dependencies.confirm({ signature, ...lifetime });
  } catch {
    fail(`Initialization was submitted as ${signature}, but confirmation could not be verified. Inspect that signature before retrying.`);
  }
  if (confirmation.value.err) {
    fail(`Initialization confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  const readback = readOrderMarketInstanceId(
    await dependencies.readMarket(),
    authority.publicKey,
  );
  if (readback !== instanceId) {
    fail("Initialization confirmed, but market instance readback did not match.");
  }
  log(`Initialization confirmed: ${signature}`);
  log(`Verified order market instance ID: ${instanceId.toString()}`);
  return { executed: true, instanceId, signature };
}

function connectionDependencies(connection: Connection): InitializerDependencies {
  return {
    readMarket: () => connection.getAccountInfo(V16_MARKET, "confirmed"),
    latestBlockhash: () => connection.getLatestBlockhash("confirmed"),
    simulate: (transaction) => connection.simulateTransaction(transaction),
    send: (rawTransaction) => connection.sendRawTransaction(rawTransaction, {
      maxRetries: 0,
      skipPreflight: false,
    }),
    confirm: (strategy) => connection.confirmTransaction(strategy, "confirmed"),
  };
}

async function main(): Promise<void> {
  const { execute } = parseArguments(process.argv.slice(2));
  const rpcUrl = assertRpcUrl(process.env.RPC_URL);
  const keypairPath = assertExplicitSignerPath(process.env.MARKET_AUTHORITY_KEYPAIR);
  const authority = loadMarketAuthority(keypairPath);
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
  await runOrderMarketInitializer({
    authority,
    dependencies: connectionDependencies(connection),
    execute,
  });
}

if (process.argv[1]?.endsWith("initialize-order-market-instance-v16.ts")) {
  main().catch((error: unknown) => {
    console.error(safeInitializerError(error));
    process.exitCode = 1;
  });
}
