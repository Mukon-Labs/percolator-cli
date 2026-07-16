/**
 * Oracle Keeper (v16) — keeps the v16 market's marks tracking live Pyth.
 *
 * v16 oracle = AuthMark: PushAuthMark sets a target mark, and a
 * PermissionlessCrank walks the stored *effective* price toward it (bounded
 * per slot) and settles a portfolio.
 *
 * v2 (2026-07-16) — hardened after the 11h silent hang that loss-stale-locked
 * the whole market (see KANBAN "loss-stale incident"):
 *  - PUSHES and CRANK are SEPARATE txs. The old bundled tx meant a failing
 *    crank also blocked every price push, so the market could never catch up.
 *  - SELF-HEAL: if the LP crank fails with Custom 21 (loss-stale deadlock —
 *    an asset's clock can't advance+settle in one call once it lags too far),
 *    run batched cranks against a LEGLESS buffer portfolio: with nothing to
 *    settle, the bounded clock advance sticks (~180 slots/tx), until the LP
 *    crank works again.
 *  - WATCHDOG: every tick is hard-timeboxed; if no successful push lands for
 *    150s the process exits(1) and Fly restarts the machine. The v1 hang was
 *    an un-timeboxed await keeping the `isPushing` guard latched forever.
 *
 * Env (Fly): RPC_URL, KEEPER_SECRET_KEY (base64 or JSON array).
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "7C37Xn3NLknqmSaxASYy2uRkb1RQcXigPmJCANUNYnvq"
);
const MARKET = new PublicKey(process.env.MARKET ?? "5R8JDc8zJyVgP34vB7fHGD5262W5qid7u8SEEbe76u6A");
const LP_PORTFOLIO = new PublicKey(process.env.LP_PORTFOLIO ?? "FrfVp5LcrwDncynm8zarmUppG624Zbf1oBdNFpZvD47i");

/** Assets listed on the v16 market group (index order is fixed on-chain). */
const ASSETS: Array<{ index: number; symbol: string; feedId: string }> = [
  { index: 0, symbol: "SOL", feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
  { index: 1, symbol: "BTC", feedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  { index: 2, symbol: "ETH", feedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
];
const PYTH_HERMES_URL = "https://hermes.pyth.network";
const PUSH_INTERVAL_MS = 5000;
const TICK_DEADLINE_MS = 20_000;   // hard cap on one tick, releases the guard
const WATCHDOG_MS = 150_000;       // no successful push for this long -> exit(1)
const TX_TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 30_000;
const PORTFOLIO_ACCOUNT_LEN = 9411;
const CATCHUP_TXS_PER_TICK = 4;    // self-heal budget per tick (~180 slots each)
const CATCHUP_CRANKS_PER_TX = 9;

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
const CRANK_BUFFER_SEED = "ninja-crank-buffer";
let crankBuffer: PublicKey; // legless portfolio used only for catch-up cranks

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
function ixCrank(portfolio: PublicKey, assetIndexes: number[], nowSlot: bigint): TransactionInstruction {
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
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: portfolio, isSigner: false, isWritable: true },
    ],
    data: d,
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function sendIxs(ixs: TransactionInstruction[], cuLimit: number): Promise<{ sig: string; err: unknown | null }> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }));
  tx.add(...ixs);
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const result = await Promise.race([
    conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed").catch(() => null),
    sleep(TX_TIMEOUT_MS).then(() => null),
  ]);
  return { sig, err: result?.value?.err ?? null };
}

/** Ensure the legless crank-buffer portfolio exists (created once, ~0.066 SOL rent). */
async function ensureCrankBuffer(): Promise<void> {
  crankBuffer = await PublicKey.createWithSeed(payer.publicKey, CRANK_BUFFER_SEED, PROGRAM_ID);
  const info = await conn.getAccountInfo(crankBuffer, "confirmed");
  if (info) return;
  const rent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  const initData = Buffer.from([1]); // InitPortfolio (tag 1)
  const { err } = await sendIxs([
    SystemProgram.createAccountWithSeed({
      fromPubkey: payer.publicKey, newAccountPubkey: crankBuffer,
      basePubkey: payer.publicKey, seed: CRANK_BUFFER_SEED,
      lamports: rent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID,
    }),
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: MARKET, isSigner: false, isWritable: true },
        { pubkey: crankBuffer, isSigner: false, isWritable: true },
      ],
      data: initData,
    }),
  ], 200_000);
  console.log(`  crank buffer ${err ? "create FAILED " + JSON.stringify(err) : "created"}: ${crankBuffer.toBase58()}`);
}

/** Loss-stale self-heal: advance asset clocks via the legless buffer. */
async function selfHeal(pushed: number[]): Promise<void> {
  for (let i = 0; i < CATCHUP_TXS_PER_TICK; i++) {
    const nowSlot = BigInt(await conn.getSlot("confirmed"));
    const ixs = Array.from({ length: CATCHUP_CRANKS_PER_TX }, () => ixCrank(crankBuffer, pushed, nowSlot));
    const { err } = await sendIxs(ixs, 1_400_000);
    if (err) { console.log(`  self-heal tx err: ${JSON.stringify(err)}`); break; }
  }
}

console.log("Oracle Keeper (v16, hardened v2) started");
console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
console.log(`  Market:  ${MARKET.toBase58()}`);
console.log(`  Assets:  ${ASSETS.map((a) => `${a.index}=${a.symbol}`).join(", ")}`);
console.log(`  Auth:    ${payer.publicKey.toBase58()}`);
console.log(`  Push:    every ${PUSH_INTERVAL_MS}ms\n`);

let consecutiveErrors = 0;
let isPushing = false;
let lastPushOkMs = Date.now(); // watchdog anchor (boot counts as ok)
let healing = false;

async function tickInner() {
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
  const pushIxs: TransactionInstruction[] = [];
  const pushed: number[] = [];
  const parts: string[] = [];
  for (const a of ASSETS) {
    const item = parsed.find((p) => p.id === a.feedId);
    if (!item) { parts.push(`${a.symbol} n/a`); continue; }
    const price = Number(item.price.price) * Math.pow(10, item.price.expo);
    pushIxs.push(ixPushAuthMark(a.index, nowSlot, BigInt(Math.round(price * 1_000_000))));
    pushed.push(a.index);
    parts.push(`${a.symbol} $${price.toFixed(price >= 1000 ? 0 : 2)}`);
  }
  if (!pushed.length) throw new Error("No feeds matched");

  // Tx 1: PUSHES ONLY — must always land, whatever the crank thinks.
  const push = await sendIxs(pushIxs, 400_000);
  if (push.err) throw new Error(`push err: ${JSON.stringify(push.err)}`);
  lastPushOkMs = Date.now();

  // Tx 2: crank the LP (settles its legs, advances effective prices).
  const crank = await sendIxs([ixCrank(LP_PORTFOLIO, pushed, nowSlot)], 600_000);
  const time = new Date().toISOString().slice(11, 19);
  if (crank.err) {
    const isLossStale = JSON.stringify(crank.err).includes('"Custom":21');
    console.log(`  [${time}] ${parts.join("  ")} push ✓, crank err ${JSON.stringify(crank.err)}${isLossStale ? " -> self-heal" : ""}`);
    if (isLossStale && !healing) {
      healing = true;
      try { await selfHeal(pushed); } finally { healing = false; }
    }
  } else {
    console.log(`  [${time}] ${parts.join("  ")} push+crank ✓ ${crank.sig.slice(0, 8)}…`);
  }
  consecutiveErrors = 0;
}

async function tick() {
  if (isPushing) return;
  isPushing = true;
  try {
    // Hard deadline: a wedged await can never latch the guard again.
    await Promise.race([
      tickInner(),
      sleep(TICK_DEADLINE_MS).then(() => { throw new Error("tick deadline exceeded"); }),
    ]);
  } catch (err: unknown) {
    consecutiveErrors++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [${new Date().toISOString().slice(11, 19)}] Error #${consecutiveErrors}: ${msg.slice(0, 140)}`);
    if (consecutiveErrors >= 3) {
      const backoff = Math.min(PUSH_INTERVAL_MS * Math.pow(2, consecutiveErrors - 2), MAX_BACKOFF_MS);
      console.error(`  Backing off ${(backoff / 1000).toFixed(0)}s…`);
      await sleep(backoff);
    }
  } finally {
    isPushing = false;
  }
}

// WATCHDOG: if pushes stop landing, die loudly — Fly restarts the machine.
setInterval(() => {
  if (Date.now() - lastPushOkMs > WATCHDOG_MS) {
    console.error(`WATCHDOG: no successful push for ${WATCHDOG_MS / 1000}s — exiting for restart`);
    process.exit(1);
  }
}, 15_000);

process.on("unhandledRejection", (reason) => {
  console.error(`  [unhandledRejection] ${reason instanceof Error ? reason.message : String(reason)}`.slice(0, 140));
});

ensureCrankBuffer().then(() => {
  tick();
  setInterval(tick, PUSH_INTERVAL_MS);
}).catch((e) => {
  console.error("boot failed:", e.message ?? e);
  process.exit(1);
});
