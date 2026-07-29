/**
 * Simulation-first LP recapitalization for the current Ninja devnet market.
 *
 * The LP portfolio is the trading counterparty.  This tool intentionally does
 * not top up insurance/backing buckets and has no implicit send path.
 *
 * Required environment (entered manually; never committed):
 *   RPC_URL          private devnet endpoint
 *   LP_OWNER_KEYPAIR absolute path to the existing LP-owner keypair JSON
 *
 * A broadcast requires both --amount-usdc and --broadcast.  The default run
 * signs and simulates only, so operators can inspect the exact live result
 * before moving test-USDC.
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
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("7C37Xn3NLknqmSaxASYy2uRkb1RQcXigPmJCANUNYnvq");
const MARKET = new PublicKey("DNhYhm8Pb2yRjTpk7SNXrevX8zNZ9eZuivxgxyNtwyPP");
const LP_PORTFOLIO = new PublicKey("BWqxjf1GoYqRNZTy6h1txPxBtiiN9MyF5Hd2JtKYGVwS");
const TEST_USDC_MINT = new PublicKey("5NDpr5JHMaW5ghyRTR5DyyEDpqVzbj5R4gfUJEFk3k1T");
const USDC_SCALE = 1_000_000n;
const HEADER_LEN = 16;
const PORTFOLIO_STATE_OFF = HEADER_LEN;
const PROVENANCE_MARKET_OFF = PORTFOLIO_STATE_OFF;
const OWNER_OFF = PORTFOLIO_STATE_OFF + 100;
const MIN_PORTFOLIO_LEN = OWNER_OFF + 32;

function fail(message: string): never { throw new Error(message); }

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
}

export function parseUsdcAmount(value: string | undefined): bigint {
  if (!value || !/^\d+(?:\.\d{1,6})?$/.test(value)) {
    fail("--amount-usdc must be a positive decimal with at most 6 places.");
  }
  const [whole, fractional = ""] = value.split(".");
  const amount = BigInt(whole) * USDC_SCALE + BigInt((fractional + "000000").slice(0, 6));
  if (amount <= 0n) fail("--amount-usdc must be greater than zero.");
  return amount;
}

export function parseArguments(args: readonly string[]): { amount: bigint; broadcast: boolean } {
  const amountIndex = args.indexOf("--amount-usdc");
  if (amountIndex === -1 || !args[amountIndex + 1]) fail("Pass --amount-usdc <amount> explicitly.");
  const amountValue = args[amountIndex + 1];
  const broadcast = args.includes("--broadcast");
  const allowed = new Set(["--amount-usdc", amountValue, "--broadcast"]);
  if (args.some((arg) => !allowed.has(arg))) fail("Unknown argument.");
  return { amount: parseUsdcAmount(amountValue), broadcast };
}

export function assertCurrentLpPortfolio(
  account: { owner: PublicKey; data: Buffer } | null,
  expectedOwner: PublicKey,
): void {
  if (!account || !account.owner.equals(PROGRAM_ID)) fail("LP portfolio is missing or not owned by the V16 program.");
  if (account.data.length < MIN_PORTFOLIO_LEN) fail("LP portfolio data is too short.");
  const market = new PublicKey(account.data.subarray(PROVENANCE_MARKET_OFF, PROVENANCE_MARKET_OFF + 32));
  if (!market.equals(MARKET)) fail("LP portfolio does not belong to the current market.");
  const owner = new PublicKey(account.data.subarray(OWNER_OFF, OWNER_OFF + 32));
  if (!owner.equals(expectedOwner)) fail("LP_OWNER_KEYPAIR is not the owner of the current LP portfolio.");
}

export function depositInstruction(owner: PublicKey, sourceAta: PublicKey, vaultAta: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(17);
  data.writeUInt8(3, 0); // Deposit
  let remaining = amount;
  for (let index = 0; index < 16; index += 1) {
    data[1 + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
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
    data,
  });
}

function loadKeypair(path: string): Keypair {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    if (!Array.isArray(raw) || raw.length !== 64) fail("LP_OWNER_KEYPAIR is unavailable or invalid.");
    return Keypair.fromSecretKey(new Uint8Array(raw));
  } catch {
    fail("LP_OWNER_KEYPAIR is unavailable or invalid.");
  }
}

async function main(): Promise<void> {
  const { amount, broadcast } = parseArguments(process.argv.slice(2));
  const rpcUrl = requiredEnv("RPC_URL");
  if (!rpcUrl.startsWith("https://") && !rpcUrl.startsWith("http://")) fail("RPC_URL must be a complete http(s) URL.");
  const lpOwner = loadKeypair(requiredEnv("LP_OWNER_KEYPAIR"));
  const connection = new Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
  const lp = await connection.getAccountInfo(LP_PORTFOLIO, "confirmed");
  assertCurrentLpPortfolio(lp, lpOwner.publicKey);

  const sourceAta = getAssociatedTokenAddressSync(TEST_USDC_MINT, lpOwner.publicKey);
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("vault"), MARKET.toBuffer()], PROGRAM_ID)[0];
  const vaultAta = getAssociatedTokenAddressSync(TEST_USDC_MINT, vaultAuthority, true);
  const sourceBalance = BigInt((await connection.getTokenAccountBalance(sourceAta, "confirmed")).value.amount);
  if (sourceBalance < amount) fail("LP owner has insufficient test-USDC for the requested deposit.");

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: lpOwner.publicKey, recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    depositInstruction(lpOwner.publicKey, sourceAta, vaultAta, amount),
  );
  tx.sign(lpOwner);
  const simulation = await connection.simulateTransaction(tx, [lpOwner]);
  if (simulation.value.err) {
    fail(`LP deposit simulation failed: ${JSON.stringify(simulation.value.err)}; logs: ${simulation.value.logs?.slice(-16).join(" | ") ?? "no program logs"}`);
  }
  console.log(`LP deposit simulation OK (${simulation.value.unitsConsumed ?? 0} CU).`);
  if (!broadcast) return;

  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 0, skipPreflight: false });
  const confirmed = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (confirmed.value.err) fail(`LP deposit confirmation failed: ${JSON.stringify(confirmed.value.err)}`);
  console.log(`LP deposit confirmed: ${signature}`);
}

if (process.argv[1]?.endsWith("fund-current-market-lp.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "LP funding failed.");
    process.exitCode = 1;
  });
}
