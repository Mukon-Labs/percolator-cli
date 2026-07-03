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
// Default: checkpoint-v2 USDC-collateralized SOL-PERP market
const SLAB = new PublicKey(
  process.env.SLAB ?? "DWKJEBygrZwKjqDDgsW14bix2a4u93x4bq927GnAJGuC"
);
const DEPLOYER_PATH = `${process.env.HOME}/.config/solana/mukon-deployer.json`;
const PYTH_HERMES_URL = "https://hermes.pyth.network";
const SOL_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PUSH_INTERVAL_MS = 3000;
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
console.log(`  Slab:    ${SLAB.toBase58()}`);
console.log(`  Auth:    ${payer.publicKey.toBase58()}`);
console.log(`  Push:    every ${PUSH_INTERVAL_MS}ms`);
console.log("");

let consecutiveErrors = 0;
let isPushing = false;  // prevent overlapping pushes

async function pushPrice() {
  if (isPushing) return;  // previous push still in flight — skip this tick
  isPushing = true;

  try {
    // Fetch price from Pyth Hermes (with timeout)
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 5000);
    let resp: Response;
    try {
      resp = await fetch(
        `${PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=${SOL_FEED_ID}`,
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(fetchTimeout);
    }

    if (!resp.ok) {
      throw new Error(`Pyth HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const item = data.parsed?.[0];
    if (!item) throw new Error("No price data from Pyth");

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
        { pubkey: SLAB, isSigner: false, isWritable: true },
      ],
      data: ixData,
    });

    // Send without waiting indefinitely — fire and move on.
    // If it doesn't confirm in TX_TIMEOUT_MS we just try again next tick.
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(ix);
    tx.sign(payer);

    const rawTx = tx.serialize();
    const sig = await conn.sendRawTransaction(rawTx, { skipPreflight: true });

    // Confirm with timeout — don't block the loop if RPC is slow
    const confirmPromise = conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    const timeoutPromise = sleep(TX_TIMEOUT_MS).then(() => null);
    const result = await Promise.race([confirmPromise, timeoutPromise]);

    const time = new Date().toISOString().slice(11, 19);
    if (result === null) {
      console.log(`  [${time}] SOL $${price.toFixed(2)} sent (unconfirmed) ${sig.slice(0, 8)}…`);
    } else if (result.value.err) {
      // tx included in block but failed on-chain (e.g. EngineUnauthorized)
      throw new Error(`tx on-chain error: ${JSON.stringify(result.value.err)}`);
    } else {
      console.log(`  [${time}] SOL $${price.toFixed(2)} (${priceE6}) ✓ ${sig.slice(0, 8)}…`);
    }

    consecutiveErrors = 0;

  } catch (err: unknown) {
    consecutiveErrors++;
    const msg = err instanceof Error ? err.message : String(err);
    const time = new Date().toISOString().slice(11, 19);
    console.error(`  [${time}] Error #${consecutiveErrors}: ${msg.slice(0, 120)}`);

    // Exponential backoff: 3s → 6s → 12s → 24s → 30s max. Never exit.
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
pushPrice();

// Main loop — never exits on errors
setInterval(pushPrice, PUSH_INTERVAL_MS);

// Graceful shutdown on Ctrl+C only
process.on("SIGINT", () => {
  console.log("\nOracle keeper stopping (SIGINT).");
  process.exit(0);
});
