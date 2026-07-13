/**
 * Oracle Keeper (v16) — keeps the v16 market's mark tracking live SOL.
 *
 * v16 oracle = AuthMark: PushAuthMark sets a target mark, and a
 * PermissionlessCrank walks the stored *effective* price toward it (bounded
 * per slot) and settles a portfolio. So each tick we push the live Pyth price
 * as the target, then crank the LP portfolio to advance the effective price.
 *
 * Env (same as the old keeper, for Fly): RPC_URL, KEEPER_SECRET_KEY
 * (base64 or JSON array of the oracle-authority keypair).
 *
 * Old-program keeper is `oracle-keeper.ts` (retired 2026-07-13 when the old
 * markets were torn down). This is the live one.
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "7C37Xn3NLknqmSaxASYy2uRkb1RQcXigPmJCANUNYnvq"
);
// The live v16 market group + its LP portfolio (asset 0 = SOL).
const MARKET = new PublicKey(process.env.MARKET ?? "F73ehBXD5H19oRT6ed5Z591Zrf1hx61K93CH8ugyDiSC");
const LP_PORTFOLIO = new PublicKey(process.env.LP_PORTFOLIO ?? "AsyzqWDMDe8p2HNUUeCtrQ1jnyCJvjhLfXx3suRQSjvf");

/** Assets listed on the v16 market group (index order is fixed on-chain). */
const ASSETS: Array<{ index: number; symbol: string; feedId: string }> = [
  { index: 0, symbol: "SOL", feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
  { index: 1, symbol: "BTC", feedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  { index: 2, symbol: "ETH", feedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
];
const PYTH_HERMES_URL = "https://hermes.pyth.network";
const PUSH_INTERVAL_MS = 5000;
const TX_TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 30_000;

function loadKeypair(): Keypair {
  const envKey = process.env.KEEPER_SECRET_KEY;
  if (envKey) {
    const t = envKey.trim();
    const json = t.startsWith("[") ? t : Buffer.from(t, "base64").toString("utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json)));
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/mukon-deployer.json`, "utf8")))
  );
}

const conn = new Connection(RPC_URL, "confirmed");
const payer = loadKeypair();

// PushAuthMark (tag 63): [63, asset_index:u16, now_slot:u64, mark_e6:u64]
function ixPushAuthMark(assetIndex: number, nowSlot: bigint, markE6: bigint): TransactionInstruction {
  const d = Buffer.alloc(1 + 2 + 8 + 8);
  d.writeUInt8(63, 0);
  d.writeUInt16LE(assetIndex, 1);
  d.writeBigUInt64LE(nowSlot, 3);
  d.writeBigUInt64LE(markE6, 11);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: true },
    ],
    data: d,
  });
}

// PermissionlessCrank (tag 5): [5, now_slot:u64, n:u8, (asset_index:u16, oracle_accounts:u8)×n]
// One crank covers ALL assets — n observations in a single instruction.
function ixCrank(assetIndexes: number[], nowSlot: bigint): TransactionInstruction {
  const n = assetIndexes.length;
  const d = Buffer.alloc(1 + 8 + 1 + 3 * n);
  d.writeUInt8(5, 0);
  d.writeBigUInt64LE(nowSlot, 1);
  d.writeUInt8(n, 9);
  assetIndexes.forEach((a, i) => {
    d.writeUInt16LE(a, 10 + i * 3);   // asset_index
    d.writeUInt8(0, 12 + i * 3);      // oracle_accounts = 0 (AuthMark reads the stored target)
  });
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: LP_PORTFOLIO, isSigner: false, isWritable: true },
    ],
    data: d,
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log("Oracle Keeper (v16) started");
console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
console.log(`  Market:  ${MARKET.toBase58()}`);
console.log(`  Assets:  ${ASSETS.map((a) => `${a.index}=${a.symbol}`).join(", ")}`);
console.log(`  Auth:    ${payer.publicKey.toBase58()}`);
console.log(`  Push:    every ${PUSH_INTERVAL_MS}ms\n`);

let consecutiveErrors = 0;
let isPushing = false;

async function tick() {
  if (isPushing) return;
  isPushing = true;
  try {
    // One Hermes request for every listed asset.
    const controller = new AbortController();
    const ft = setTimeout(() => controller.abort(), 5000);
    let resp: Response;
    try {
      const q = ASSETS.map((a) => `ids[]=${a.feedId}`).join("&");
      resp = await fetch(`${PYTH_HERMES_URL}/v2/updates/price/latest?${q}`, { signal: controller.signal });
    } finally { clearTimeout(ft); }
    if (!resp.ok) throw new Error(`Pyth HTTP ${resp.status}`);
    const data = await resp.json();
    const parsed: Array<{ id: string; price: { price: string; expo: number } }> = data.parsed ?? [];
    if (!parsed.length) throw new Error("No price data");

    const nowSlot = BigInt(await conn.getSlot("confirmed"));
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));

    // Push each asset's mark, then ONE crank covering all of them.
    const pushed: number[] = [];
    const parts: string[] = [];
    for (const a of ASSETS) {
      const item = parsed.find((p) => p.id === a.feedId);
      if (!item) { parts.push(`${a.symbol} n/a`); continue; }
      const price = Number(item.price.price) * Math.pow(10, item.price.expo);
      tx.add(ixPushAuthMark(a.index, nowSlot, BigInt(Math.round(price * 1_000_000))));
      pushed.push(a.index);
      parts.push(`${a.symbol} $${price.toFixed(price >= 1000 ? 0 : 2)}`);
    }
    if (!pushed.length) throw new Error("No feeds matched");
    tx.add(ixCrank(pushed, nowSlot));
    tx.sign(payer);

    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const result = await Promise.race([
      conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed").catch(() => null),
      sleep(TX_TIMEOUT_MS).then(() => null),
    ]);
    const time = new Date().toISOString().slice(11, 19);
    if (result && result.value?.err) throw new Error(`tx err: ${JSON.stringify(result.value.err)}`);
    console.log(`  [${time}] ${parts.join("  ")} push+crank ${result === null ? "(unconfirmed)" : "✓"} ${sig.slice(0, 8)}…`);
    consecutiveErrors = 0;
  } catch (err: unknown) {
    consecutiveErrors++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [${new Date().toISOString().slice(11, 19)}] Error #${consecutiveErrors}: ${msg.slice(0, 120)}`);
    if (consecutiveErrors >= 3) {
      const backoff = Math.min(PUSH_INTERVAL_MS * Math.pow(2, consecutiveErrors - 2), MAX_BACKOFF_MS);
      console.error(`  Backing off ${(backoff / 1000).toFixed(0)}s…`);
      await sleep(backoff);
    }
  } finally {
    isPushing = false;
  }
}

process.on("unhandledRejection", (reason) => {
  console.error(`  [unhandledRejection] ${reason instanceof Error ? reason.message : String(reason)}`.slice(0, 140));
});

tick();
setInterval(tick, PUSH_INTERVAL_MS);
process.on("SIGINT", () => { console.log("\nStopping (SIGINT)."); process.exit(0); });
