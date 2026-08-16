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
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  abortableSleep,
  classifyKeeperError,
  confirmConnectionTransaction,
  confirmedTransactionError,
  crankBufferSeedForMarket,
  ensureUsableCrankBuffer,
  formatUnhandledRejection,
  isUsableLeglessCrankBuffer,
  KeeperLifecycle,
  KeeperFailure,
  isCustomProgramError,
  parseKeeperSecretKey,
  PushWatchdog,
  RpcCircuitBreaker,
  RpcOperationSignalScope,
  requireConfiguredHermesFeeds,
  requireKeeperConfiguration,
  runDeadlineBoundOperation,
  runBoundedSelfHeal,
  readV16LossStaleActive,
  safeErrorMessage,
  scheduleForcedExit,
  SingleTickRunner,
  systemClock,
  retryAfterMs,
} from "./keeper-runtime.ts";
import {
  AssetQuarantine,
  BoundedShadowDecisionLog,
  executeKeeperPlan,
  FileDecisionSink,
  isolateRejectedAssets,
  keeperModeFromEnv,
  recordSuccessfulShadowDecision,
  type KeeperAction,
} from "./keeper-shadow.ts";
import {
  assessV16MarketHealth,
  formatV16MarketHealth,
  parseUsdcFloor,
  readV16MarketCollateralMint,
  readV16MarketHealthSnapshot,
} from "./v16-market-health.ts";
import {
  pythHermesHeaders,
  pythHermesUrl,
  requirePythHermesConfiguration,
} from "./pyth-hermes.ts";

const keeperConfiguration = requireKeeperConfiguration(process.env as {
  RPC_URL?: string;
  KEEPER_SECRET_KEY?: string;
});
const KEEPER_MODE = keeperModeFromEnv(process.env);
const RPC_URL = keeperConfiguration.rpcUrl;
const pythHermes = requirePythHermesConfiguration(process.env);
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "7C37Xn3NLknqmSaxASYy2uRkb1RQcXigPmJCANUNYnvq"
);
const MARKET = new PublicKey(process.env.MARKET ?? "DNhYhm8Pb2yRjTpk7SNXrevX8zNZ9eZuivxgxyNtwyPP");
const LP_PORTFOLIO = new PublicKey(process.env.LP_PORTFOLIO ?? "BWqxjf1GoYqRNZTy6h1txPxBtiiN9MyF5Hd2JtKYGVwS");

/** Assets listed on the v16 market group (index order is fixed on-chain). */
const ASSETS: Array<{ index: number; symbol: string; feedId: string }> = [
  { index: 0, symbol: "SOL", feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
  { index: 1, symbol: "BTC", feedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  { index: 2, symbol: "ETH", feedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
  { index: 3, symbol: "ZEC", feedId: "be9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24" },
];
const PUSH_INTERVAL_MS = 5000;
const TICK_DEADLINE_MS = 20_000;   // hard cap on one tick, releases the guard
const WATCHDOG_MS = 150_000;       // no successful push for this long -> exit(1)
const WATCHDOG_FORCE_EXIT_MS = 10_000;
const TX_TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 30_000;
const MARKET_STATUS_CHECK_MS = 30_000;
const LP_HEALTH_CHECK_MS = 5 * 60_000;
const LP_FAILURE_HEALTH_CHECK_MS = 60_000;
const LP_MIN_CAPITAL = parseUsdcFloor(process.env.LP_MIN_CAPITAL_USDC);
const PORTFOLIO_ACCOUNT_LEN = 9411;
const CATCHUP_TXS_PER_TICK = 4;    // self-heal budget per tick (~180 slots each)
const CATCHUP_CRANKS_PER_TX = 9;
const SHADOW_DECISION_LOG_MAX_BYTES = 10 * 1024 * 1024;
const shadowDecisionLog = KEEPER_MODE === "shadow"
  ? new BoundedShadowDecisionLog(
    new FileDecisionSink(process.env.SHADOW_DECISION_LOG_PATH ?? "/tmp/ninja-keeper-shadow.jsonl"),
    SHADOW_DECISION_LOG_MAX_BYTES,
  )
  : null;

function loadKeypair(): Keypair {
  try {
    return Keypair.fromSecretKey(parseKeeperSecretKey(keeperConfiguration.encodedSecretKey));
  } catch {
    // Do not leak a malformed source fragment through boot/unhandled handlers.
    throw new KeeperFailure("unknown", "invalid KEEPER_SECRET_KEY");
  }
}

const rpcOperationSignals = new RpcOperationSignalScope();
const conn = new Connection(RPC_URL, {
  commitment: "confirmed",
  // web3.js otherwise retries every 429 several times inside each logical RPC.
  // The keeper owns the retry policy so provider failures cannot amplify.
  disableRetryOnRateLimit: true,
  confirmTransactionInitialTimeout: TX_TIMEOUT_MS,
  fetchMiddleware: (url, options, fetch) => fetch(url, {
    ...(options ?? {}),
    signal: rpcOperationSignals.currentSignal() ?? options?.signal,
  }),
});
const payer = loadKeypair();
let crankBuffer: PublicKey; // legless portfolio used only for catch-up cranks
let shadowCrankBufferUsable = false;

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

async function withRpcSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new KeeperFailure("cancelled", "keeper RPC work cancelled");
  if (rpcOperationSignals.currentSignal()) {
    throw new KeeperFailure("unknown", "concurrent keeper RPC work rejected");
  }
  return rpcOperationSignals.run(signal, async () => {
    try {
      return await work();
    } catch (error) {
      if (signal.aborted) {
        throw new KeeperFailure("timeout", "keeper RPC deadline exceeded");
      }
      throw error;
    }
  });
}

async function sendIxs(
  ixs: TransactionInstruction[],
  cuLimit: number,
  signal: AbortSignal,
  intent?: { action: KeeperAction; assetIndexes: readonly number[]; observedSlot: bigint },
): Promise<{ sig: string; err: unknown | null; confirmed: boolean }> {
  if (signal.aborted) throw new Error("keeper operation cancelled");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  if (signal.aborted) throw new Error("keeper operation cancelled");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  const plannedIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    ...ixs,
  ];
  tx.add(...plannedIxs);
  tx.sign(payer);

  if (KEEPER_MODE === "shadow" && (!intent || !shadowDecisionLog)) {
    throw new KeeperFailure("unknown", "shadow keeper send intent is missing");
  }
  const execution = await executeKeeperPlan({
    mode: KEEPER_MODE,
    simulate: async () => (await conn.simulateTransaction(tx)).value.err ?? null,
    onShadowAccepted: async () => recordSuccessfulShadowDecision({
      simulationError: null,
      log: shadowDecisionLog!,
      decision: {
        action: intent!.action,
        assetIndexes: intent!.assetIndexes,
        createdAt: new Date().toISOString(),
        instructions: plannedIxs,
        market: MARKET.toBase58(),
        observedSlot: intent!.observedSlot,
        payer: payer.publicKey.toBase58(),
      },
    }),
    broadcast: async () => {
      const sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 0,
      });
      // Confirmation owns and settles all fallback work before this tick can
      // release its single-flight signal.
      const result = await confirmConnectionTransaction({
        connection: conn,
        parentSignal: signal,
        runWithOperationSignal: (operationSignal, work) => rpcOperationSignals.run(operationSignal, work),
        reportUnexpectedFallbackError: (message) => console.error(`  ${message}`),
        strategy: { signature: sig, blockhash, lastValidBlockHeight },
        timeoutMs: TX_TIMEOUT_MS,
      });
      return { sig, err: confirmedTransactionError(result), confirmed: true };
    },
  });
  if (execution.mode === "live") return execution.value;
  if (execution.simulationError !== null || !execution.value) {
    return { sig: "shadow_rejected", err: execution.simulationError, confirmed: false };
  }
  return { sig: `shadow_${execution.value.decisionId.slice(0, 16)}`, err: null, confirmed: false };
}

async function simulateIxs(
  ixs: TransactionInstruction[],
  cuLimit: number,
  signal: AbortSignal,
): Promise<unknown | null> {
  if (signal.aborted) throw new KeeperFailure("cancelled", "keeper simulation cancelled");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }));
  tx.add(...ixs);
  tx.sign(payer);
  const simulation = await conn.simulateTransaction(tx);
  return simulation.value.err ?? null;
}

/** Ensure the legless crank-buffer portfolio exists (created once, ~0.066 SOL rent). */
async function ensureCrankBuffer(signal: AbortSignal): Promise<void> {
  // v1 used one authority-wide seed, so a valid buffer for an old market
  // occupied the live keeper's address. v2 scopes the deterministic address to
  // this market; old accounts are never selected, repurposed, or deleted.
  const crankBufferSeed = crankBufferSeedForMarket(MARKET.toBytes());
  crankBuffer = await PublicKey.createWithSeed(payer.publicKey, crankBufferSeed, PROGRAM_ID);
  const isUsableBuffer = (info: Awaited<ReturnType<typeof conn.getAccountInfo>>) => info !== null
    && isUsableLeglessCrankBuffer({
      data: info.data,
      expectedLength: PORTFOLIO_ACCOUNT_LEN,
      expectedMarket: MARKET.toBytes(),
      expectedPortfolio: crankBuffer.toBytes(),
      programOwnerMatches: info.owner.equals(PROGRAM_ID),
    });
  if (KEEPER_MODE === "shadow") {
    const existing = await conn.getAccountInfo(crankBuffer, "confirmed");
    shadowCrankBufferUsable = isUsableBuffer(existing);
    console.log(`  shadow crank buffer: ${shadowCrankBufferUsable ? "usable" : "unavailable (self-heal simulation disabled)"}`);
    return;
  }
  const rent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  const initData = Buffer.from([1]); // InitPortfolio (tag 1)
  await ensureUsableCrankBuffer({
    read: () => conn.getAccountInfo(crankBuffer, "confirmed"),
    isUsable: isUsableBuffer,
    create: async () => {
      const { err } = await sendIxs([
        SystemProgram.createAccountWithSeed({
          fromPubkey: payer.publicKey, newAccountPubkey: crankBuffer,
          basePubkey: payer.publicKey, seed: crankBufferSeed,
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
      ], 200_000, signal, {
        action: "loss-stale-heal",
        assetIndexes: [],
        observedSlot: BigInt(await conn.getSlot("confirmed")),
      });
      if (err) throw new KeeperFailure("onchain", "crank buffer create rejected on-chain");
    },
  });
  console.log(`  crank buffer ready: ${crankBuffer.toBase58()}`);
}

/** Loss-stale self-heal: advance asset clocks via the legless buffer. */
async function selfHeal(pushed: number[], signal: AbortSignal): Promise<void> {
  if (KEEPER_MODE === "shadow" && !shadowCrankBufferUsable) {
    console.error("  shadow self-heal skipped: crank buffer is unavailable");
    return;
  }
  await runBoundedSelfHeal({
    batchesPerTick: CATCHUP_TXS_PER_TICK,
    cranksPerBatch: CATCHUP_CRANKS_PER_TX,
    signal,
    runBatch: async (cranksPerBatch) => {
      const nowSlot = BigInt(await conn.getSlot("confirmed"));
      const ixs = Array.from({ length: cranksPerBatch }, () => ixCrank(crankBuffer, pushed, nowSlot));
      const { err } = await sendIxs(ixs, 1_400_000, signal, {
        action: "loss-stale-heal",
        assetIndexes: pushed,
        observedSlot: nowSlot,
      });
      if (err) console.log("  self-heal tx rejected");
      return err === null;
    },
  });
}

/**
 * A stale lock can persist even when the ordinary LP crank confirms: that
 * crank may settle the LP but not advance every stale asset clock. Probe at a
 * bounded cadence and use the existing legless buffer until the on-chain lock
 * clears. A failed probe never suppresses price pushes; once a lock was seen,
 * continue bounded catch-up until the next successful status read.
 */
async function fetchMarketLossStaleActive(signal: AbortSignal): Promise<boolean> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "keeper-market-status",
      method: "getAccountInfo",
      params: [MARKET.toBase58(), { commitment: "confirmed", encoding: "base64" }],
    }),
    signal,
  });
  if (!response.ok) {
    throw new KeeperFailure(
      response.status === 429 ? "rate_limit" : "transport",
      `market status HTTP ${response.status}`,
      retryAfterMs(response.headers, Date.now()),
    );
  }
  const payload: unknown = await response.json();
  const encoded = (payload as { result?: { value?: { data?: unknown } } })?.result?.value?.data;
  if (!Array.isArray(encoded) || typeof encoded[0] !== "string") {
    throw new KeeperFailure("onchain", "v16 market status account is unavailable");
  }
  return readV16LossStaleActive(Buffer.from(encoded[0], "base64"));
}

async function marketNeedsCatchUp(parentSignal: AbortSignal): Promise<boolean> {
  // Once a direct status read confirms a healthy market, Custom-21 remains the
  // trigger for reopening this recovery probe. Avoid a recurring web3 account
  // read in the ordinary push path.
  if (marketStatusSettledHealthy) return false;
  const now = Date.now();
  if (now < nextMarketStatusCheckMs) return knownLossStaleActive;
  try {
    knownLossStaleActive = await runDeadlineBoundOperation({
      parentSignal,
      timeoutMs: 5_000,
      work: fetchMarketLossStaleActive,
    });
    marketStatusSettledHealthy = !knownLossStaleActive;
    nextMarketStatusCheckMs = now + MARKET_STATUS_CHECK_MS;
  } catch (error) {
    nextMarketStatusCheckMs = now + MARKET_STATUS_CHECK_MS;
    console.error(`  market recovery status unavailable: ${safeErrorMessage(error)}`);
  }
  return knownLossStaleActive;
}

async function readLpHealth() {
  const [marketInfo, lpInfo] = await conn.getMultipleAccountsInfo(
    [MARKET, LP_PORTFOLIO],
    "confirmed",
  );
  if (!marketInfo || !marketInfo.owner.equals(PROGRAM_ID)) {
    throw new KeeperFailure("onchain", "configured v16 market account is unavailable");
  }
  if (!lpInfo || !lpInfo.owner.equals(PROGRAM_ID)) {
    throw new KeeperFailure("onchain", "configured matcher LP portfolio is unavailable");
  }
  const marketData = Buffer.from(marketInfo.data);
  const collateralMint = new PublicKey(readV16MarketCollateralMint(marketData, MARKET.toBytes()));
  const vaultAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), MARKET.toBuffer()],
    PROGRAM_ID,
  )[0];
  const vaultAta = getAssociatedTokenAddressSync(collateralMint, vaultAuthority, true);
  const custodyBalance = BigInt((await conn.getTokenAccountBalance(vaultAta, "confirmed")).value.amount);
  return assessV16MarketHealth(readV16MarketHealthSnapshot({
    custodyBalance,
    expectedLpPortfolio: LP_PORTFOLIO.toBytes(),
    expectedMarket: MARKET.toBytes(),
    lpData: Buffer.from(lpInfo.data),
    marketData,
  }), LP_MIN_CAPITAL);
}

async function reportLpHealth(
  context: "startup" | "periodic" | "crank rejected",
  signal: AbortSignal,
): Promise<void> {
  const now = Date.now();
  if (context === "crank rejected") {
    if (now < nextLpFailureHealthCheckMs) return;
    nextLpFailureHealthCheckMs = now + LP_FAILURE_HEALTH_CHECK_MS;
  } else {
    if (context !== "startup" && now < nextLpHealthCheckMs) return;
    nextLpHealthCheckMs = now + LP_HEALTH_CHECK_MS;
  }
  try {
    const assessment = await readLpHealth();
    const message = `  [${context}] ${formatV16MarketHealth(assessment)}`;
    if (assessment.level === "healthy") console.log(message);
    else console.error(message);
  } catch (error) {
    if (signal.aborted) throw error;
    console.error(`  [${context}] LP health unavailable: ${safeErrorMessage(error)}`);
  }
}

console.log("Oracle Keeper (v16, hardened v2) started");
console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
console.log(`  Market:  ${MARKET.toBase58()}`);
console.log(`  Assets:  ${ASSETS.map((a) => `${a.index}=${a.symbol}`).join(", ")}`);
console.log(`  Auth:    ${payer.publicKey.toBase58()}`);
console.log(`  Mode:    ${KEEPER_MODE}`);
console.log(`  Push:    every ${PUSH_INTERVAL_MS}ms\n`);

let consecutiveErrors = 0;
let healing = false;
const rpcCircuit = new RpcCircuitBreaker(systemClock);
const assetQuarantine = new AssetQuarantine(Date.now);
const tickRunner = new SingleTickRunner(systemClock, TICK_DEADLINE_MS);
const bootRunner = new SingleTickRunner(systemClock, TICK_DEADLINE_MS);
const watchdog = new PushWatchdog(Date.now());
const shutdown = new AbortController();
const lifecycle = new KeeperLifecycle(
  { clearInterval, setInterval },
  (code) => process.exit(code),
  (error) => console.error(`  keeper shutdown drain failed: ${safeErrorMessage(error)}`),
);
let watchdogSuppressedUntil = 0;
let transientBackoffUntil = 0;
let knownLossStaleActive = false;
let marketStatusSettledHealthy = false;
let nextMarketStatusCheckMs = 0;
let nextLpHealthCheckMs = 0;
let nextLpFailureHealthCheckMs = 0;

interface AssetPushPlan {
  index: number;
  instruction: TransactionInstruction;
  display: string;
}

async function pushAssetsWithIsolation(
  plans: readonly AssetPushPlan[],
  observedSlot: bigint,
  signal: AbortSignal,
): Promise<{ confirmed: boolean; plans: AssetPushPlan[]; sig: string }> {
  const eligible = assetQuarantine.eligible(plans);
  const open = assetQuarantine.snapshot().filter((state) => assetQuarantine.isOpen(state.assetIndex));
  if (open.length > 0) {
    console.error(`  degraded oracle set: quarantined asset indexes ${open.map((state) => state.assetIndex).join(",")}`);
  }
  if (eligible.length === 0) {
    throw new KeeperFailure("onchain", "all oracle assets are temporarily quarantined");
  }

  const send = (batch: readonly AssetPushPlan[]) => sendIxs(
    batch.map((plan) => plan.instruction),
    400_000,
    signal,
    { action: "oracle-push", assetIndexes: batch.map((plan) => plan.index), observedSlot },
  );
  const first = await send(eligible);
  if (first.err === null) {
    if (first.confirmed) {
      for (const plan of eligible) assetQuarantine.recordConfirmedSuccess(plan.index);
    }
    return { confirmed: first.confirmed, plans: eligible, sig: first.sig };
  }

  const isolated = await isolateRejectedAssets({
    assets: eligible,
    quarantine: assetQuarantine,
    simulate: (plan) => simulateIxs([plan.instruction], 200_000, signal),
  });
  if (isolated.rejected.length > 0) {
    console.error(`  isolated rejected oracle asset indexes ${isolated.rejected.map((state) => state.assetIndex).join(",")}`);
  }
  if (isolated.healthy.length === 0) {
    throw new KeeperFailure("onchain", "oracle push rejected for every eligible asset");
  }

  // A single smaller retry salvages healthy majors without creating an
  // unbounded retry tree or letting one bad feed stall the entire market.
  const retry = await send(isolated.healthy);
  if (retry.err !== null) {
    throw new KeeperFailure("onchain", "healthy oracle retry batch rejected on-chain");
  }
  if (retry.confirmed) {
    for (const plan of isolated.healthy) assetQuarantine.recordConfirmedSuccess(plan.index);
  }
  return { confirmed: retry.confirmed, plans: isolated.healthy, sig: retry.sig };
}

function stopKeeper(): void {
  if (lifecycle.isTerminal()) return;
  // Mark terminal before waiting: intervals are cleared immediately, then the
  // process exits only after cancellation reaches active RPC/confirmation work.
  void lifecycle.terminate(async () => {
    shutdown.abort();
    tickRunner.abortActive();
    bootRunner.abortActive();
    await Promise.all([tickRunner.drain(), bootRunner.drain()]);
  });
}

process.once("SIGINT", stopKeeper);
process.once("SIGTERM", stopKeeper);

async function tickInner(signal: AbortSignal) {
  // Keep the Hermes operation signal alive through headers, body parsing, and
  // configured-feed validation; a headers-only response must not outlive tick.
  const feeds = await runDeadlineBoundOperation({
    parentSignal: signal,
    timeoutMs: 5000,
    work: async (hermesSignal) => {
      const url = pythHermesUrl(
        pythHermes,
        "/v2/updates/price/latest",
        ASSETS.map((asset) => ["ids[]", asset.feedId] as const),
      );
      const resp = await fetch(url, {
        headers: pythHermesHeaders(pythHermes),
        signal: hermesSignal,
      });
      if (!resp.ok) {
        throw new KeeperFailure(
          resp.status === 429 ? "rate_limit" : "transport",
          `Pyth HTTP ${resp.status}`,
          retryAfterMs(resp.headers, Date.now()),
        );
      }
      const data = await resp.json();
      const parsed: Array<{ id: string; price: { price: string; expo: number } }> = data.parsed ?? [];
      return requireConfiguredHermesFeeds(ASSETS.map((asset) => asset.feedId), parsed);
    },
  });

  const nowSlot = BigInt(await conn.getSlot("confirmed"));
  const plans: AssetPushPlan[] = [];
  for (const a of ASSETS) {
    const item = feeds.get(a.feedId)!;
    const price = Number(item.price.price) * Math.pow(10, item.price.expo);
    plans.push({
      index: a.index,
      instruction: ixPushAuthMark(a.index, nowSlot, BigInt(Math.round(price * 1_000_000))),
      display: `${a.symbol} $${price.toFixed(price >= 1000 ? 0 : 2)}`,
    });
  }
  // Tx 1: PUSHES ONLY — must always land, whatever the crank thinks.
  const push = await pushAssetsWithIsolation(plans, nowSlot, signal);
  const pushed = push.plans.map((plan) => plan.index);
  const parts = push.plans.map((plan) => plan.display);
  // A watchdog/circuit recovery only advances after a confirmation that contains
  // an explicit null on-chain error, never after timeout, cancellation, or a
  // missing confirmation result.
  if (push.confirmed) {
    watchdog.recordConfirmedPush(Date.now(), true);
    rpcCircuit.recordConfirmedSuccess();
    watchdogSuppressedUntil = 0;
  }

  // Tx 2: crank the LP (settles its legs, advances effective prices).
  const crank = await sendIxs([ixCrank(LP_PORTFOLIO, pushed, nowSlot)], 600_000, signal, {
    action: "lp-crank",
    assetIndexes: pushed,
    observedSlot: nowSlot,
  });
  const time = new Date().toISOString().slice(11, 19);
  if (crank.err) {
    const isLossStale = isCustomProgramError(crank.err, 21);
    console.log(`  [${time}] ${parts.join("  ")} ${KEEPER_MODE === "shadow" ? "shadow push simulated" : "push ✓"}, crank rejected${isLossStale ? " -> self-heal" : ""}`);
    await reportLpHealth("crank rejected", signal);
    if (isLossStale && !healing) {
      knownLossStaleActive = true;
      marketStatusSettledHealthy = false;
      healing = true;
      try { await selfHeal(pushed, signal); } finally { healing = false; }
    }
  } else {
    console.log(`  [${time}] ${parts.join("  ")} ${KEEPER_MODE === "shadow" ? "shadow push+crank simulated" : "push+crank ✓"} ${crank.sig.slice(0, 8)}…`);
    await reportLpHealth("periodic", signal);
    // A normal LP crank can succeed without catching every asset clock up
    // after a keeper outage. While the market's loss-stale lock is active,
    // continue the existing bounded legless-buffer path proactively.
    if (await marketNeedsCatchUp(signal)) {
      if (!healing) {
        healing = true;
        try {
          console.log("  loss-stale lock active -> self-heal");
          await selfHeal(pushed, signal);
        } finally {
          healing = false;
        }
      }
    }
  }
  consecutiveErrors = 0;
}

async function tick() {
  if (lifecycle.isTerminal() || shutdown.signal.aborted || rpcCircuit.isOpen() || Date.now() < transientBackoffUntil) return;
  try {
    const started = await tickRunner.run((signal) => withRpcSignal(signal, () => tickInner(signal)));
    if (!started) return;
  } catch (err: unknown) {
    consecutiveErrors++;
    const failure = classifyKeeperError(err);
    console.error(`  [${new Date().toISOString().slice(11, 19)}] Error #${consecutiveErrors}: ${safeErrorMessage(failure).slice(0, 140)}`);
    const circuitBackoff = rpcCircuit.recordFailure(failure);
    if (circuitBackoff !== null) {
      // A provider outage must not create a Fly restart loop. Give a recovered
      // endpoint a full watchdog window to land the first push.
      watchdogSuppressedUntil = Date.now() + circuitBackoff + WATCHDOG_MS;
      console.error(`  RPC circuit open for ${(circuitBackoff / 1000).toFixed(0)}s`);
    } else if (consecutiveErrors >= 3) {
      const backoff = Math.min(PUSH_INTERVAL_MS * Math.pow(2, consecutiveErrors - 2), MAX_BACKOFF_MS);
      transientBackoffUntil = Date.now() + backoff;
      console.error(`  Backing off ${(backoff / 1000).toFixed(0)}s…`);
    }
  }
}

// WATCHDOG: if pushes stop landing, die loudly — Fly restarts the machine.
lifecycle.every(() => {
  if (KEEPER_MODE === "shadow") return;
  if (Date.now() < watchdogSuppressedUntil) return;
  if (watchdog.shouldRestart(Date.now(), WATCHDOG_MS)) {
    console.error(`WATCHDOG: no successful push for ${WATCHDOG_MS / 1000}s — exiting for restart`);
    const cancelForcedExit = scheduleForcedExit({
      delayMs: WATCHDOG_FORCE_EXIT_MS,
      code: 1,
      exit: (code) => process.exit(code),
    });
    void lifecycle.terminate(async () => {
      shutdown.abort();
      tickRunner.abortActive();
      bootRunner.abortActive();
      await Promise.all([tickRunner.drain(), bootRunner.drain()]);
    }, 1).finally(cancelForcedExit);
  }
}, 15_000);

process.on("unhandledRejection", (reason) => {
  console.error(`  ${formatUnhandledRejection(reason)}`);
});

async function boot(): Promise<void> {
  for (;;) {
    try {
      if (shutdown.signal.aborted) throw new KeeperFailure("cancelled", "keeper shutdown requested");
      await bootRunner.run((signal) => withRpcSignal(signal, async () => {
        await ensureCrankBuffer(signal);
        await reportLpHealth("startup", signal);
      }));
      break;
    } catch (error) {
      const failure = classifyKeeperError(error);
      const backoff = rpcCircuit.recordFailure(failure);
      if (backoff === null) throw failure;
      watchdogSuppressedUntil = Date.now() + backoff + WATCHDOG_MS;
      console.error(`boot RPC circuit open for ${Math.ceil(backoff / 1000)}s`);
      await abortableSleep(backoff, shutdown.signal);
    }
  }
  if (lifecycle.isTerminal()) return;
  void tick();
  lifecycle.every(() => { void tick(); }, PUSH_INTERVAL_MS);
}

boot().catch((error) => {
  if (lifecycle.isTerminal()) return;
  console.error("boot failed:", safeErrorMessage(error));
  void lifecycle.terminate(async () => {
    shutdown.abort();
    tickRunner.abortActive();
    bootRunner.abortActive();
    await Promise.all([tickRunner.drain(), bootRunner.drain()]);
  }, 1);
});
