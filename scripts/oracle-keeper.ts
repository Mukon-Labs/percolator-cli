/**
 * Oracle Keeper — pushes live Pyth prices to the Percolator slab on devnet.
 *
 * Usage: npx tsx scripts/oracle-keeper.ts
 *
 * Runs every 3 seconds:
 * 1. Fetches SOL/USD from Pyth Hermes REST API
 * 2. Pushes price to slab via PushOraclePrice instruction
 * 3. Backs off exponentially on errors; never exits
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";

// --- Config ---
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "F9ve3CUdJyeXS2Rjq3VSbFb7pfbehB5eWfWMpKRco3QS"
);
// checkpoint-v2 USDC-collateralized Hyperp markets (override single market via SLAB env)
const MARKETS: Array<{ symbol: string; slab: PublicKey; feedId: string }> = process.env.SLAB
  ? [{ symbol: "ENV", slab: new PublicKey(process.env.SLAB), feedId: process.env.FEED_ID ?? "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" }]
  : [
      { symbol: "SOL", slab: new PublicKey("DWKJEBygrZwKjqDDgsW14bix2a4u93x4bq927GnAJGuC"), feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
      { symbol: "BTC", slab: new PublicKey("Eg7TMyXdZ8e4VRwxEnytZZ3KfAJ48kKayFkEpwUfdCxj"), feedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
      { symbol: "ETH", slab: new PublicKey("BZumn9yQuQqRtbTaR6wuY1eecUSpyUuBuysq2EJPZDpK"), feedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
    ];
const DEPLOYER_PATH = `${process.env.HOME}/.config/solana/mukon-deployer.json`;
const PYTH_HERMES_URL = "https://hermes.pyth.network";
const PUSH_INTERVAL_MS = 5000; // 3 markets/tick — keep total tx rate under devnet RPC limits
const TX_TIMEOUT_MS = 8000;   // give up on confirmation after 8s; next tick will retry
const MAX_BACKOFF_MS = 30_000;

// --- Encoding helpers ---
function encU8(val: number): Buffer {
  const buf = Buffer.alloc(1);
  buf.writeUInt8(val, 0);
  return buf;
}

function encU64(val: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(val, 0);
  return buf;
}

function encI64(val: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(val, 0);
  return buf;
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

// --- Main ---
const conn = new Connection(RPC_URL, "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(DEPLOYER_PATH, "utf8")))
);

console.log(`Oracle Keeper started`);
console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
for (const m of MARKETS) console.log(`  ${m.symbol.padEnd(4)}: ${m.slab.toBase58()}`);
console.log(`  Auth:    ${payer.publicKey.toBase58()}`);
console.log(`  Push:    every ${PUSH_INTERVAL_MS}ms`);
console.log("");

let consecutiveErrors = 0;
let isPushing = false;  // prevent overlapping pushes

async function pushPrices() {
  if (isPushing) return;  // previous push still in flight — skip this tick
  isPushing = true;

  try {
    // Fetch all feeds from Pyth Hermes in one request (with timeout)
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 5000);
    let resp: Response;
    try {
      const q = MARKETS.map((m) => `ids[]=${m.feedId}`).join("&");
      resp = await fetch(`${PYTH_HERMES_URL}/v2/updates/price/latest?${q}`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(fetchTimeout);
    }

    if (!resp.ok) {
      throw new Error(`Pyth HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const parsed: Array<{ id: string; price: { price: string; expo: number; publish_time: number } }> =
      data.parsed ?? [];
    if (parsed.length === 0) throw new Error("No price data from Pyth");

    // One tx per market — a single PushOraclePrice writes one slab
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const time = new Date().toISOString().slice(11, 19);
    const lineParts: string[] = [];

    for (const market of MARKETS) {
      const item = parsed.find((p) => p.id === market.feedId);
      if (!item) { lineParts.push(`${market.symbol} n/a`); continue; }

      const price = Number(item.price.price) * Math.pow(10, item.price.expo);
      const priceE6 = BigInt(Math.round(price * 1_000_000));
      const timestamp = BigInt(item.price.publish_time);

      // Build PushOraclePrice instruction (tag 17)
      const ixData = Buffer.concat([
        encU8(17),          // tag = PushOraclePrice
        encU64(priceE6),    // price_e6
        encI64(timestamp),  // timestamp
      ]);
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.slab, isSigner: false, isWritable: true },
        ],
        data: ixData,
      });

      const tx = new Transaction();
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer.publicKey;
      tx.add(ix);
      tx.sign(payer);

      // Fire and move on; confirm with timeout per market.
      // The confirm promise may outlive the race — attach a catch so a late
      // RPC failure (e.g. ECONNRESET) can't become an unhandled rejection
      // that kills the process.
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      const confirmPromise = conn
        .confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed")
        .catch(() => null);
      const result = await Promise.race([
        confirmPromise,
        sleep(TX_TIMEOUT_MS).then(() => null),
      ]);
      if (result && result.value.err) {
        throw new Error(`${market.symbol} tx on-chain error: ${JSON.stringify(result.value.err)}`);
      }
      lineParts.push(`${market.symbol} $${price.toFixed(2)}${result === null ? '?' : '✓'}`);
    }

    console.log(`  [${time}] ${lineParts.join('  ')}`);
    consecutiveErrors = 0;

  } catch (err: unknown) {
    consecutiveErrors++;
    const msg = err instanceof Error ? err.message : String(err);
    const time = new Date().toISOString().slice(11, 19);
    console.error(`  [${time}] Error #${consecutiveErrors}: ${msg.slice(0, 120)}`);

    // Exponential backoff: 5s → 10s → 20s → 30s max. Never exit.
    if (consecutiveErrors >= 3) {
      const backoff = Math.min(PUSH_INTERVAL_MS * Math.pow(2, consecutiveErrors - 2), MAX_BACKOFF_MS);
      console.error(`  Backing off ${(backoff / 1000).toFixed(0)}s before next attempt…`);
      await sleep(backoff);
    }

  } finally {
    isPushing = false;
  }
}

// Initial push
pushPrices();

// Main loop — never exits on errors
setInterval(pushPrices, PUSH_INTERVAL_MS);

// Never die on a stray async failure — log and keep pushing
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`  [unhandledRejection] ${msg.slice(0, 120)}`);
});

// Graceful shutdown on Ctrl+C only
process.on("SIGINT", () => {
  console.log("\nOracle keeper stopping (SIGINT).");
  process.exit(0);
});
