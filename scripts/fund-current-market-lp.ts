/**
 * Simulation-first LP recapitalization for the current Ninja devnet market.
 *
 * The LP portfolio is the trading counterparty.  This tool intentionally does
 * not top up insurance/backing buckets and has no implicit send path.
 *
 * Required environment (entered manually; never committed):
 *   RPC_URL          private devnet endpoint
 *   LP_OWNER_KEYPAIR absolute path to the existing LP-owner keypair JSON
 *   MINT_AUTHORITY_KEYPAIR only when --mint-shortfall is explicitly requested
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
import {
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("7C37Xn3NLknqmSaxASYy2uRkb1RQcXigPmJCANUNYnvq");
const MARKET = new PublicKey("DNhYhm8Pb2yRjTpk7SNXrevX8zNZ9eZuivxgxyNtwyPP");
const LP_PORTFOLIO = new PublicKey("BWqxjf1GoYqRNZTy6h1txPxBtiiN9MyF5Hd2JtKYGVwS");
const TEST_USDC_MINT = new PublicKey("5NDpr5JHMaW5ghyRTR5DyyEDpqVzbj5R4gfUJEFk3k1T");
const DEVNET_HOSTS = new Set(["api.devnet.solana.com", "devnet.helius-rpc.com"]);
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

export function parseArguments(args: readonly string[]): {
  amount: bigint;
  broadcast: boolean;
  mintShortfall: boolean;
} {
  const amountIndex = args.indexOf("--amount-usdc");
  if (amountIndex === -1 || !args[amountIndex + 1]) fail("Pass --amount-usdc <amount> explicitly.");
  const amountValue = args[amountIndex + 1];
  const broadcast = args.includes("--broadcast");
  const mintShortfall = args.includes("--mint-shortfall");
  const allowed = new Set(["--amount-usdc", amountValue, "--broadcast", "--mint-shortfall"]);
  if (args.some((arg) => !allowed.has(arg))) fail("Unknown argument.");
  return { amount: parseUsdcAmount(amountValue), broadcast, mintShortfall };
}

export function assertDevnetRpc(rpcUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    fail("RPC_URL must be a complete http(s) URL.");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || !DEVNET_HOSTS.has(parsed.hostname.toLowerCase())) {
    fail("RPC_URL must be a devnet endpoint for this funding tool.");
  }
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

export function transactionPrelude(): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
  ];
}

function loadKeypair(path: string, role: string): Keypair {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    if (!Array.isArray(raw) || raw.length !== 64) fail(`${role} is unavailable or invalid.`);
    return Keypair.fromSecretKey(new Uint8Array(raw));
  } catch {
    fail(`${role} is unavailable or invalid.`);
  }
}

async function main(): Promise<void> {
  const { amount, broadcast, mintShortfall } = parseArguments(process.argv.slice(2));
  const rpcUrl = requiredEnv("RPC_URL");
  assertDevnetRpc(rpcUrl);
  const lpOwner = loadKeypair(requiredEnv("LP_OWNER_KEYPAIR"), "LP_OWNER_KEYPAIR");
  const connection = new Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
  const lp = await connection.getAccountInfo(LP_PORTFOLIO, "confirmed");
  assertCurrentLpPortfolio(lp, lpOwner.publicKey);

  const sourceAta = getAssociatedTokenAddressSync(TEST_USDC_MINT, lpOwner.publicKey);
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("vault"), MARKET.toBuffer()], PROGRAM_ID)[0];
  const vaultAta = getAssociatedTokenAddressSync(TEST_USDC_MINT, vaultAuthority, true);
  const sourceBalance = BigInt((await connection.getTokenAccountBalance(sourceAta, "confirmed")).value.amount);
  let mintInstruction: TransactionInstruction | undefined;
  let mintAuthority: Keypair | undefined;
  if (sourceBalance < amount) {
    if (!mintShortfall) {
      fail("LP owner has insufficient test-USDC; use --mint-shortfall with an explicit MINT_AUTHORITY_KEYPAIR.");
    }
    mintAuthority = loadKeypair(requiredEnv("MINT_AUTHORITY_KEYPAIR"), "MINT_AUTHORITY_KEYPAIR");
    const mint = await getMint(connection, TEST_USDC_MINT, "confirmed", TOKEN_PROGRAM_ID);
    if (!mint.mintAuthority?.equals(mintAuthority.publicKey)) {
      fail("MINT_AUTHORITY_KEYPAIR is not the authority for the configured test-USDC mint.");
    }
    mintInstruction = createMintToInstruction(
      TEST_USDC_MINT,
      sourceAta,
      mintAuthority.publicKey,
      amount - sourceBalance,
      [],
      TOKEN_PROGRAM_ID,
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: lpOwner.publicKey, recentBlockhash: blockhash }).add(
    ...transactionPrelude(),
    ...(mintInstruction ? [mintInstruction] : []),
    depositInstruction(lpOwner.publicKey, sourceAta, vaultAta, amount),
  );
  const signers = mintAuthority ? [lpOwner, mintAuthority] : [lpOwner];
  tx.sign(...signers);
  const simulation = await connection.simulateTransaction(tx, signers);
  if (simulation.value.err) {
    fail(`LP deposit simulation failed: ${JSON.stringify(simulation.value.err)}; logs: ${simulation.value.logs?.slice(-16).join(" | ") ?? "no program logs"}`);
  }
  console.log(`LP deposit simulation OK (${simulation.value.unitsConsumed ?? 0} CU${mintInstruction ? "; exact shortfall mint included" : ""}${broadcast ? "; broadcast preflight" : "; no tokens were minted or moved"}).`);
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
