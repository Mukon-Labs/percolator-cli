import assert from "node:assert/strict";
import test from "node:test";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  abortableSleep,
  classifyKeeperError,
  confirmConnectionTransaction,
  confirmedTransactionError,
  confirmationResultFromError,
  crankBufferSeedForMarket,
  ensureUsableCrankBuffer,
  formatConfirmationFallbackError,
  formatUnhandledRejection,
  isUsableLeglessCrankBuffer,
  isCustomProgramError,
  KeeperFailure,
  KeeperLifecycle,
  linkedAbortController,
  modelCatchupCadence,
  parseKeeperSecretKey,
  PushWatchdog,
  requireConfiguredHermesFeeds,
  requireKeeperConfiguration,
  RpcCircuitBreaker,
  RpcOperationSignalScope,
  runDeadlineBoundOperation,
  runBoundedSelfHeal,
  safeErrorMessage,
  SingleTickRunner,
  type Clock,
  type IntervalScheduler,
} from "./keeper-runtime.ts";

function fakeClock(startMs = 0, random = 0.5): Clock & { advance(ms: number): void; tasks: Array<{ cancelled: boolean; callback: () => void; delayMs: number }> } {
  let nowMs = startMs;
  const tasks: Array<{ cancelled: boolean; callback: () => void; delayMs: number }> = [];
  return {
    advance(ms) { nowMs += ms; },
    clearTimeout(handle) { (handle as unknown as { cancelled: boolean }).cancelled = true; },
    now: () => nowMs,
    random: () => random,
    setTimeout(callback, delayMs) {
      const handle = { callback, cancelled: false, delayMs };
      tasks.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    tasks,
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("Retry-After is never undercut and raw web3 Errors have no header claim", () => {
  const clock = fakeClock(1_000, 0); // local jitter would choose 24 seconds
  const breaker = new RpcCircuitBreaker(clock, 30_000, 5_000, 15 * 60_000);
  const directHttpFailure = classifyKeeperError({
    headers: { "retry-after": "60" },
    status: 429,
  }, undefined, clock.now());
  assert.equal(directHttpFailure.kind, "rate_limit");
  assert.equal(directHttpFailure.retryAfterMs, 60_000);
  assert.equal(breaker.recordFailure(directHttpFailure), 60_000);
  assert.deepEqual(breaker.snapshot(), { failures: 1, openUntilMs: 61_000 });

  // web3.js typically gives an Error message only, so no synthetic header or
  // Retry-After precision is claimed when it is unavailable to the caller.
  const web3Failure = classifyKeeperError(new Error("429 Too Many Requests"), undefined, clock.now());
  assert.equal(web3Failure.kind, "rate_limit");
  assert.equal(web3Failure.retryAfterMs, undefined);
  breaker.recordConfirmedSuccess();
  assert.deepEqual(breaker.snapshot(), { failures: 0, openUntilMs: 0 });

  const capped = new RpcCircuitBreaker(clock, 30_000, 5_000, 15 * 60_000);
  assert.equal(
    capped.recordFailure(new KeeperFailure("rate_limit", "rate limited", 24 * 60 * 60_000)),
    15 * 60_000,
    "a very large header is capped at the documented 15-minute probe interval",
  );
});

test("quota and transport failures are classified without retaining provider details", () => {
  assert.equal(classifyKeeperError(new Error("quota exhausted")).kind, "rate_limit");
  assert.equal(classifyKeeperError(new Error("socket ECONNRESET")).kind, "transport");
});

test("parent already aborted before confirmation linking aborts the child immediately", () => {
  const parent = new AbortController();
  parent.abort();
  const linked = linkedAbortController(parent.signal);
  assert.equal(linked.controller.signal.aborted, true);
  linked.dispose();
});

test("owned confirmation preserves direct and nested Custom 21 results from subscription and fallback", async () => {
  for (const [source, err] of [
    ["subscription", { Custom: 21 }],
    ["subscription", { InstructionError: [3, { Custom: 21 }] }],
    ["fallback", { Custom: 21 }],
    ["fallback", { InstructionError: [3, { Custom: 21 }] }],
  ] as const) {
    const scope = new RpcOperationSignalScope();
    const result = await confirmConnectionTransaction({
      clock: fakeClock(),
      connection: {
        getSignatureStatus: async () => source === "fallback"
          ? { context: { slot: 1 }, value: { err, confirmationStatus: "confirmed" } }
          : { context: { slot: 1 }, value: null },
        onSignature: (_signature, callback) => {
          if (source === "subscription") queueMicrotask(() => callback({ err }, { slot: 1 }));
          return 1;
        },
        removeSignatureListener: async () => undefined,
      },
      parentSignal: new AbortController().signal,
      runWithOperationSignal: (signal, work) => scope.run(signal, work),
      strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
      timeoutMs: 8_000,
    });
    assert.equal(isCustomProgramError(confirmedTransactionError(result), 21), true);
    assert.equal(scope.currentSignal(), null);
  }
});

test("raw subscription setup InstructionError becomes crank.err and enters the Custom 21 self-heal branch", async () => {
  const rawTransactionError = { InstructionError: [2, { Custom: 21 }] };
  const result = await confirmConnectionTransaction({
    clock: fakeClock(),
    connection: {
      getSignatureStatus: async () => ({ context: { slot: 1 }, value: null }),
      onSignature: () => { throw rawTransactionError; },
      removeSignatureListener: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    runWithOperationSignal: async (_signal, work) => work(),
    strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
    timeoutMs: 8_000,
  });
  const crankErr = confirmedTransactionError(result);
  assert.deepEqual(crankErr, rawTransactionError);
  assert.equal(isCustomProgramError(crankErr, 21), true, "sendIxs passes the raw fallback error to self-heal detection");
});

test("only a validated raw Solana InstructionError is normalized", async () => {
  const untrusted = { InstructionError: ["two", { Custom: 21 }] };
  assert.equal(confirmationResultFromError(untrusted), null);
  await assert.rejects(
    confirmConnectionTransaction({
      clock: fakeClock(),
      connection: {
        getSignatureStatus: async () => ({ context: { slot: 1 }, value: null }),
        onSignature: () => { throw untrusted; },
        removeSignatureListener: async () => undefined,
      },
      parentSignal: new AbortController().signal,
      runWithOperationSignal: async (_signal, work) => work(),
      strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
      timeoutMs: 8_000,
    }),
    (error: unknown) => error === untrusted,
  );
  assert.equal(confirmationResultFromError({ InstructionError: [0, { Custom: 21, Other: 1 }] }), null);
});

test("owned confirmation finalization aborts and settles all operation-lifetime fallback work", async () => {
  for (const err of [null, { InstructionError: [1, { Custom: 21 }] }]) {
    const scope = new RpcOperationSignalScope();
    let activeCalls = 0;
    const result = await confirmConnectionTransaction({
      clock: fakeClock(),
      connection: {
        getSignatureStatus: () => new Promise<unknown>((_resolve, reject) => {
          activeCalls += 1;
          const signal = scope.currentSignal();
          signal?.addEventListener("abort", () => {
            activeCalls -= 1;
            reject(signal.reason);
          }, { once: true });
        }),
        onSignature: (_signature, callback) => {
          queueMicrotask(() => callback({ err }, { slot: 1 }));
          return 1;
        },
        removeSignatureListener: async () => undefined,
      },
      parentSignal: new AbortController().signal,
      runWithOperationSignal: (signal, work) => scope.run(signal, work),
      strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
      timeoutMs: 8_000,
    });
    assert.deepEqual(confirmedTransactionError(result), err);
    assert.equal(activeCalls, 0, "finally aborts success/chain-error background work");
    assert.equal(scope.currentSignal(), null);
  }
});

async function runRealConnectionFallbackRace(kind: "owner" | "independent-abort" | "transport") {
  const scope = new RpcOperationSignalScope();
  let activeFallbacks = 0;
  let unsubscribeCalls = 0;
  const ignoredUnsubscribeWarnings: string[] = [];
  let onSubscribed!: (state: string) => void;
  let deliverSubscription!: (result: { err: unknown }, context: unknown) => void;
  const customFetch: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
    activeFallbacks += 1;
    const signal = init?.signal;
    signal?.addEventListener("abort", () => {
      activeFallbacks -= 1;
      if (kind === "owner") reject(signal.reason);
      else if (kind === "independent-abort") {
        reject(Object.assign(new Error("independent abort"), { name: "AbortError" }));
      } else {
        reject(new Error("connection reset https://provider.invalid/key"));
      }
    }, { once: true });
  });
  const connection = new Connection("http://127.0.0.1:8899", {
    commitment: "confirmed",
    fetch: customFetch,
    fetchMiddleware: (url, options, next) => next(url, {
      ...(options ?? {}),
      signal: scope.currentSignal() ?? options?.signal,
    }),
  }) as unknown as {
    _onSubscriptionStateChange: (id: number, callback: (state: string) => void) => () => void;
    getSignatureStatus: (signature: string) => Promise<unknown>;
    onSignature: (signature: string, callback: (result: { err: unknown }, context: unknown) => void, commitment: "confirmed") => number;
    removeSignatureListener: (id: number) => Promise<void>;
  };
  connection.removeSignatureListener = async () => {
    unsubscribeCalls += 1;
    if (unsubscribeCalls > 1) ignoredUnsubscribeWarnings.push("ignored unsubscribe");
  };
  connection.onSignature = (_signature, callback) => {
    deliverSubscription = (result, context) => {
      callback(result, context);
      // Mirrors web3.js 1.98.4's onSignature auto-removal after callback.
      void connection.removeSignatureListener(7);
    };
    return 7;
  };
  connection._onSubscriptionStateChange = (_id, callback) => {
    onSubscribed = callback;
    return () => undefined;
  };
  const reports: string[] = [];
  const unhandled: unknown[] = [];
  const uncaught: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  const onUncaught = (error: unknown) => { uncaught.push(error); };
  process.on("unhandledRejection", onUnhandled);
  process.on("uncaughtException", onUncaught);
  try {
    const confirmation = confirmConnectionTransaction({
      clock: fakeClock(),
      connection,
      parentSignal: new AbortController().signal,
      reportUnexpectedFallbackError: (message) => { reports.push(message); },
      runWithOperationSignal: (signal, work) => scope.run(signal, work),
      strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
      timeoutMs: 8_000,
    });
    await flush();
    onSubscribed("subscribed");
    await flush();
    assert.equal(activeFallbacks, 1);
    deliverSubscription({ err: null }, { slot: 1 });
    assert.deepEqual(await confirmation, { context: { slot: 1 }, value: { err: null } });
    await flush();
    assert.equal(activeFallbacks, 0);
    assert.equal(unsubscribeCalls, 1);
    assert.deepEqual(ignoredUnsubscribeWarnings, []);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(uncaught, []);
    assert.equal(scope.currentSignal(), null);
    return reports;
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    process.removeListener("uncaughtException", onUncaught);
  }
}

test("real Connection custom-fetch fallback consumes only its exact owner abort and avoids double unsubscribe", async () => {
  assert.deepEqual(await runRealConnectionFallbackRace("owner"), []);
});

test("real Connection custom-fetch fallback reports independent abort and transport exactly once", async () => {
  assert.deepEqual(
    await runRealConnectionFallbackRace("independent-abort"),
    [formatConfirmationFallbackError(Object.assign(new Error("independent abort"), { name: "AbortError" }))],
  );
  assert.deepEqual(
    await runRealConnectionFallbackRace("transport"),
    [formatConfirmationFallbackError(new Error("connection reset https://provider.invalid/key"))],
  );
});

test("confirmation timeout and shutdown abort owned fallback work without orphaning a runner", async () => {
  const clock = fakeClock();
  const scope = new RpcOperationSignalScope();
  const runner = new SingleTickRunner(clock, 20_000);
  let unresolvedCalls = 0;
  const parent = new AbortController();
  const connection = {
    getSignatureStatus: () => new Promise<unknown>((_resolve, reject) => {
      unresolvedCalls += 1;
      const pollSignal = scope.currentSignal();
      const onAbort = () => {
        unresolvedCalls -= 1;
        reject(pollSignal?.reason);
      };
      pollSignal?.addEventListener("abort", onAbort, { once: true });
    }),
    onSignature: () => 1,
    removeSignatureListener: async () => undefined,
  };
  const first = runner.run(async (signal) => {
    await confirmConnectionTransaction({
      clock,
      connection,
      parentSignal: signal,
      runWithOperationSignal: (operationSignal, work) => scope.run(operationSignal, work),
      strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
      timeoutMs: 8_000,
    });
  });
  await flush();
  assert.equal(unresolvedCalls, 1);
  assert.equal(await runner.run(async () => undefined), false, "an active confirmation blocks a second tick");
  const confirmationTimeout = clock.tasks.find((task) => task.delayMs === 8_000);
  assert.ok(confirmationTimeout);
  confirmationTimeout.callback();
  await assert.rejects(first, (error: unknown) => error instanceof KeeperFailure && error.kind === "timeout");
  assert.equal(unresolvedCalls, 0);
  assert.equal(scope.currentSignal(), null);
  assert.equal(runner.isActive(), false);

  const shutdownClock = fakeClock();
  const shutdownScope = new RpcOperationSignalScope();
  let shutdownCalls = 0;
  const shutdown = new AbortController();
  const pending = confirmConnectionTransaction({
    clock: shutdownClock,
    connection: {
      getSignatureStatus: () => new Promise<unknown>((_resolve, reject) => {
        shutdownCalls += 1;
        shutdownScope.currentSignal()?.addEventListener("abort", () => {
          shutdownCalls -= 1;
          reject(shutdownScope.currentSignal()?.reason);
        }, { once: true });
      }),
      onSignature: () => 1,
      removeSignatureListener: async () => undefined,
    },
    parentSignal: shutdown.signal,
    runWithOperationSignal: (operationSignal, work) => shutdownScope.run(operationSignal, work),
    strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
    timeoutMs: 8_000,
  });
  await flush();
  shutdown.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof KeeperFailure && error.kind === "cancelled");
  assert.equal(shutdownCalls, 0);
  assert.equal(shutdownScope.currentSignal(), null);
});

test("deadline cancellation keeps the active tick serialized until its work settles", async () => {
  const clock = fakeClock();
  const runner = new SingleTickRunner(clock, 20_000);
  let calls = 0;
  const first = runner.run(async (signal) => {
    calls += 1;
    await abortableSleep(10_000, signal, clock);
  });
  await flush();
  assert.equal(runner.isActive(), true);
  assert.equal(await runner.run(async () => { calls += 1; }), false);
  assert.equal(calls, 1);
  const deadline = clock.tasks.find((task) => task.delayMs === 20_000);
  assert.ok(deadline);
  deadline.callback();
  await assert.rejects(first, (error: unknown) => error instanceof KeeperFailure && error.kind === "cancelled");
  assert.equal(runner.isActive(), false);
});

test("Hermes deadline spans headers, body parsing, and validation for timeout and parent abort", async () => {
  const timeoutClock = fakeClock();
  let activeBodies = 0;
  const timedOut = runDeadlineBoundOperation({
    clock: timeoutClock,
    parentSignal: new AbortController().signal,
    timeoutMs: 5_000,
    work: async (signal) => {
      // Headers have resolved, but the body is still waiting for the same signal.
      const response = { json: () => new Promise<unknown>((_resolve, reject) => {
        activeBodies += 1;
        signal.addEventListener("abort", () => {
          activeBodies -= 1;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }) };
      const data = await response.json();
      return requireConfiguredHermesFeeds(["sol"], (data as Array<{ id: string }>));
    },
  });
  await flush();
  assert.equal(activeBodies, 1);
  const bodyDeadline = timeoutClock.tasks.find((task) => task.delayMs === 5_000);
  assert.ok(bodyDeadline);
  bodyDeadline.callback();
  await assert.rejects(timedOut, (error: unknown) => error instanceof KeeperFailure && error.kind === "timeout");
  assert.equal(activeBodies, 0);

  const parent = new AbortController();
  const validation = { signal: null as AbortSignal | null };
  const cancelled = runDeadlineBoundOperation({
    clock: fakeClock(),
    parentSignal: parent.signal,
    timeoutMs: 5_000,
    work: async (signal) => {
      validation.signal = signal;
      await new Promise<void>((_resolve, reject) => signal.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      ));
      return requireConfiguredHermesFeeds(["sol"], [{ id: "sol" }]);
    },
  });
  await flush();
  assert.equal(validation.signal?.aborted, false, "the link remains active after headers until body/validation complete");
  parent.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof KeeperFailure && error.kind === "cancelled");
  assert.equal(validation.signal?.aborted, true);

  const completed = { signal: null as AbortSignal | null };
  const feeds = await runDeadlineBoundOperation({
    clock: fakeClock(),
    parentSignal: new AbortController().signal,
    timeoutMs: 5_000,
    work: async (signal) => {
      completed.signal = signal;
      const response = { json: async () => [{ id: "sol" }] };
      const data = await response.json();
      assert.equal(signal.aborted, false, "feed validation runs before final operation cleanup");
      return requireConfiguredHermesFeeds(["sol"], data);
    },
  });
  assert.equal(feeds.size, 1);
  assert.equal(completed.signal?.aborted, true, "success cleanup aborts any remaining body work");
});

test("5s cadence / 20s budget model includes wall-slot accrual and partial deadline continuation", () => {
  const model = modelCatchupCadence({
    cadenceMs: 5_000,
    tickBudgetMs: 20_000,
    pushConfirmationMs: 1_000,
    lpConfirmationMs: 1_000,
    healConfirmationMs: 3_000,
    catchupTransactionsPerTick: 4,
    cranksPerTransaction: 9,
    slotsPerCrank: 20,
    initialLagSlots: 4_000,
    simulationMs: 74_000,
    slotDurationMs: 400,
  });
  assert.equal(model.completedTicks, 5);
  assert.equal(model.completedHealTransactions, 20);
  assert.equal(model.finalLagSlots, 585, "wall time adds 185 slots while 5 × 4 × 9 × ~20 slots catch up");
  assert.equal(model.maxConcurrentTicks, 1);
  assert.equal(model.orphanedConfirmations, 0);
  assert.equal(model.skippedCadenceCallbacks, 10);
  const partial = modelCatchupCadence({
    cadenceMs: 5_000,
    tickBudgetMs: 20_000,
    pushConfirmationMs: 1_000,
    lpConfirmationMs: 1_000,
    healConfirmationMs: 5_000,
    catchupTransactionsPerTick: 4,
    cranksPerTransaction: 9,
    slotsPerCrank: 20,
    initialLagSlots: 4_000,
    simulationMs: 60_000,
    slotDurationMs: 400,
  });
  assert.equal(partial.completedTicks, 3);
  assert.equal(partial.completedHealTransactions, 9, "three confirmations land before each partial deadline");
  assert.equal(partial.partialDeadlineCancellations, 3);
  assert.ok(partial.finalLagSlots < 4_000, "next ticks continue bounded catch-up after deadline cancellation");
  assert.equal(partial.maxConcurrentTicks, 1);
  assert.equal(partial.orphanedConfirmations, 0);
});

test("SingleTickRunner marks active before synchronous re-entrant work", async () => {
  const runner = new SingleTickRunner(fakeClock(), 20_000);
  let nestedStarted: boolean | undefined;
  assert.equal(await runner.run(async () => {
    nestedStarted = await runner.run(async () => undefined);
  }), true);
  assert.equal(nestedStarted, false);
});

test("partial Hermes data fails the whole configured feed set", () => {
  assert.throws(
    () => requireConfiguredHermesFeeds(["sol", "btc"], [{ id: "sol" }]),
    (error: unknown) => error instanceof KeeperFailure && error.kind === "transport",
  );
  assert.equal(requireConfiguredHermesFeeds(["sol", "btc"], [{ id: "sol" }, { id: "btc" }]).size, 2);
});

function usableBufferData(): { data: Uint8Array; market: Uint8Array; portfolio: Uint8Array } {
  const data = new Uint8Array(9411);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, 0x5045_5243_5631_3600n, true);
  view.setUint16(8, 16, true);
  view.setUint8(10, 2);
  const market = new Uint8Array(32).fill(1);
  const portfolio = new Uint8Array(32).fill(2);
  data.set(market, 16);
  data.set(portfolio, 48);
  return { data, market, portfolio };
}

test("crank-buffer create rejection re-reads and accepts only a verified legless buffer", async () => {
  const usable = usableBufferData();
  assert.equal(isUsableLeglessCrankBuffer({
    data: usable.data,
    expectedLength: 9411,
    expectedMarket: usable.market,
    expectedPortfolio: usable.portfolio,
    programOwnerMatches: true,
  }), true);
  let reads = 0;
  await ensureUsableCrankBuffer({
    read: async () => (++reads === 1 ? null : usable.data),
    isUsable: (account) => account === usable.data,
    create: async () => { throw new KeeperFailure("onchain", "rejected"); },
  });
  assert.equal(reads, 2, "a rejected create is never treated as ready without a validating re-read");
  await assert.rejects(
    ensureUsableCrankBuffer({
      read: async () => null,
      isUsable: () => false,
      create: async () => { throw new KeeperFailure("onchain", "rejected"); },
    }),
    (error: unknown) => error instanceof KeeperFailure && error.kind === "onchain",
  );
});

test("market-scoped crank buffer ignores a legacy old-market buffer and selects an unused live candidate", async () => {
  const authority = new PublicKey(new Uint8Array(32).fill(9));
  const program = new PublicKey(new Uint8Array(32).fill(8));
  const oldMarket = new Uint8Array(32).fill(1);
  const liveMarket = new Uint8Array(32).fill(2);
  const legacy = await PublicKey.createWithSeed(authority, "ninja-crank-buffer", program);
  const liveSeed = crankBufferSeedForMarket(liveMarket);
  const liveCandidate = await PublicKey.createWithSeed(authority, liveSeed, program);
  const oldBuffer = usableBufferData();
  oldBuffer.data.set(oldMarket, 16);
  oldBuffer.data.set(legacy.toBytes(), 48);
  const accounts = new Map<string, Uint8Array>([[legacy.toBase58(), oldBuffer.data]]);

  assert.notEqual(liveSeed, "ninja-crank-buffer");
  assert.notEqual(liveSeed, crankBufferSeedForMarket(oldMarket));
  assert.notEqual(liveCandidate.toBase58(), legacy.toBase58());
  assert.equal(isUsableLeglessCrankBuffer({
    data: oldBuffer.data,
    expectedLength: 9411,
    expectedMarket: liveMarket,
    expectedPortfolio: liveCandidate.toBytes(),
    programOwnerMatches: true,
  }), false, "the old-market account can never validate for the live candidate");
  assert.equal(accounts.has(liveCandidate.toBase58()), false, "the live-market candidate starts unused");

  const liveBuffer = usableBufferData();
  liveBuffer.data.set(liveMarket, 16);
  liveBuffer.data.set(liveCandidate.toBytes(), 48);
  await ensureUsableCrankBuffer({
    read: async () => accounts.get(liveCandidate.toBase58()) ?? null,
    isUsable: (account) => account !== null && isUsableLeglessCrankBuffer({
      data: account,
      expectedLength: 9411,
      expectedMarket: liveMarket,
      expectedPortfolio: liveCandidate.toBytes(),
      programOwnerMatches: true,
    }),
    create: async () => { accounts.set(liveCandidate.toBase58(), liveBuffer.data); },
  });
  assert.equal(accounts.get(legacy.toBase58()), oldBuffer.data, "legacy buffer is never repurposed");
  assert.equal(accounts.get(liveCandidate.toBase58()), liveBuffer.data, "only the live candidate is selected");
});

test("existing valid live-market crank buffer remains usable without creation", async () => {
  const liveMarket = new Uint8Array(32).fill(4);
  const livePortfolio = new Uint8Array(32).fill(5);
  const existing = usableBufferData();
  existing.data.set(liveMarket, 16);
  existing.data.set(livePortfolio, 48);
  let creates = 0;
  await ensureUsableCrankBuffer({
    read: async () => existing.data,
    isUsable: (account) => account !== null && isUsableLeglessCrankBuffer({
      data: account,
      expectedLength: 9411,
      expectedMarket: liveMarket,
      expectedPortfolio: livePortfolio,
      programOwnerMatches: true,
    }),
    create: async () => { creates += 1; },
  });
  assert.equal(creates, 0);
});

test("hosted keeper configuration fails closed without explicit RPC and signer", () => {
  assert.throws(() => requireKeeperConfiguration({}), /explicit RPC_URL/);
  assert.throws(() => requireKeeperConfiguration({ RPC_URL: "configured" }), /explicit KEEPER_SECRET_KEY/);
  assert.deepEqual(
    requireKeeperConfiguration({ RPC_URL: "configured", KEEPER_SECRET_KEY: "configured" }),
    { rpcUrl: "configured", encodedSecretKey: "configured" },
  );
});

test("keeper secret decode failures have a fixed message and do not echo input", () => {
  for (const malformed of ["[1]", "[not-json]", "not-base64-or-json", "[256, 0]"]) {
    assert.throws(
      () => parseKeeperSecretKey(malformed),
      (error: unknown) => error instanceof KeeperFailure
        && error.message === "invalid KEEPER_SECRET_KEY"
        && !error.message.includes(malformed),
    );
  }
  assert.equal(parseKeeperSecretKey(JSON.stringify(Array(64).fill(0))).length, 64);
});

test("terminal shutdown clears intervals and exits only after active work drains", async () => {
  const handles: Array<{ callback: () => void; cleared: boolean }> = [];
  const scheduler: IntervalScheduler = {
    setInterval(callback) {
      const handle = { callback, cleared: false };
      handles.push(handle);
      return handle as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(handle) { (handle as unknown as { cleared: boolean }).cleared = true; },
  };
  const exits: number[] = [];
  const lifecycle = new KeeperLifecycle(scheduler, (code) => exits.push(code));
  let ticks = 0;
  lifecycle.every(() => { ticks += 1; }, 5000);
  handles[0].callback();
  assert.equal(ticks, 1);
  const gate = deferred<void>();
  const terminating = lifecycle.terminate(async () => { await gate.promise; });
  assert.equal(handles[0].cleared, true);
  handles[0].callback();
  assert.equal(ticks, 1, "terminal wrapper cannot revive recurring work");
  assert.deepEqual(exits, []);
  gate.resolve();
  await terminating;
  assert.deepEqual(exits, [0]);
});

test("confirmation success, on-chain error, timeout, and cancellation remain distinct", () => {
  assert.equal(confirmedTransactionError({ value: { err: null } }), null);
  assert.deepEqual(confirmedTransactionError({ value: { err: { Custom: 21 } } }), { Custom: 21 });
  assert.throws(() => confirmedTransactionError(null), (error: unknown) => error instanceof KeeperFailure && error.kind === "timeout");
  assert.throws(() => confirmedTransactionError({ value: {} }), (error: unknown) => error instanceof KeeperFailure && error.kind === "timeout");
  const controller = new AbortController();
  controller.abort();
  assert.equal(classifyKeeperError(new Error("aborted"), controller.signal).kind, "cancelled");
});

test("watchdog never advances on timeout or cancellation, only confirmed pushes", () => {
  const watchdog = new PushWatchdog(1_000);
  watchdog.recordConfirmedPush(2_000, false);
  assert.equal(watchdog.lastSuccessMs(), null);
  assert.equal(watchdog.shouldRestart(151_001, 150_000), true);
  watchdog.recordConfirmedPush(160_000, true);
  assert.equal(watchdog.lastSuccessMs(), 160_000);
  assert.equal(watchdog.shouldRestart(300_000, 150_000), false);
});

test("sanitizers redact HTTP/WSS URLs, authorization/api-key forms, and unhandled rejections", () => {
  const raw = "wss://provider.example/socket?token=private Authorization: Bearer private bearer private x-api-key: private {\"apiKey\":\"private\"}";
  const safe = safeErrorMessage(raw);
  assert.equal(safe.includes("provider.example"), false);
  assert.equal(safe.includes("private"), false);
  assert.equal(formatUnhandledRejection(new Error(raw)).includes("private"), false);
});
