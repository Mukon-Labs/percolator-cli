import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  INITIALIZE_ORDER_MARKET_INSTANCE_TAG,
  V16_MARKET,
  V16_PROGRAM_ID,
  assertExplicitSignerPath,
  assertMarketInstanceUninitialized,
  assertRpcUrl,
  generateOrderMarketInstanceId,
  initializeOrderMarketInstanceInstruction,
  parseArguments,
  readOrderMarketInstanceId,
  runOrderMarketInitializer,
  safeInitializerError,
  type InitializerDependencies,
} from "./initialize-order-market-instance-v16.ts";

const MAGIC = 0x5045_5243_5631_3600n;
const MARKET_GROUP_OFF = 464;
const MARKET_GROUP_HEADER_LEN = 726;
const ASSET_SLOT_LEN = 1797;
const ORDER_MARKET_INSTANCE_ID_OFF = 456;
const MARKET_MODE_OFF = MARKET_GROUP_OFF + 594;
const AUTHORITY_OFF = 16;
const CAPACITY_OFF = MARKET_GROUP_OFF + 281;

function marketAccount({
  authority,
  owner = V16_PROGRAM_ID,
  market = V16_MARKET,
  mode = 0,
  instanceId = 0n,
  capacity = 8,
}: {
  authority: PublicKey;
  owner?: PublicKey;
  market?: PublicKey;
  mode?: number;
  instanceId?: bigint;
  capacity?: number;
}) {
  const data = Buffer.alloc(MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN + capacity * ASSET_SLOT_LEN);
  data.writeBigUInt64LE(MAGIC, 0);
  data.writeUInt16LE(16, 8);
  data.writeUInt8(1, 10);
  authority.toBuffer().copy(data, AUTHORITY_OFF);
  data.writeBigUInt64LE(instanceId, ORDER_MARKET_INSTANCE_ID_OFF);
  market.toBuffer().copy(data, MARKET_GROUP_OFF);
  data.writeUInt32LE(capacity, CAPACITY_OFF);
  data.writeUInt8(mode, MARKET_MODE_OFF);
  return { owner, data };
}

function lifetime() {
  return {
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
  };
}

function exactRandom(instanceId: bigint): (size: number) => Uint8Array {
  return (size) => {
    assert.equal(size, 8);
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(instanceId);
    return bytes;
  };
}

test("tag 74 encoding and account order are exact", () => {
  const authority = Keypair.generate().publicKey;
  const instruction = initializeOrderMarketInstanceInstruction(authority, 0x0102_0304_0506_0708n);
  assert.equal(instruction.programId.toBase58(), V16_PROGRAM_ID.toBase58());
  assert.deepEqual([...instruction.data], [
    INITIALIZE_ORDER_MARKET_INSTANCE_TAG,
    0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
  ]);
  assert.deepEqual(instruction.keys.map((key) => ({
    pubkey: key.pubkey.toBase58(),
    signer: key.isSigner,
    writable: key.isWritable,
  })), [
    { pubkey: authority.toBase58(), signer: true, writable: false },
    { pubkey: V16_MARKET.toBase58(), signer: false, writable: true },
  ]);
  assert.throws(() => initializeOrderMarketInstanceInstruction(authority, 0n), /non-zero u64/);
});

test("market validation fails closed on owner, authority, mode, layout, and existing ID", () => {
  const authority = Keypair.generate().publicKey;
  const valid = marketAccount({ authority });
  assert.equal(readOrderMarketInstanceId(valid, authority), 0n);
  assert.doesNotThrow(() => assertMarketInstanceUninitialized(valid, authority));
  assert.throws(
    () => readOrderMarketInstanceId(
      marketAccount({ authority, owner: Keypair.generate().publicKey }),
      authority,
    ),
    /not owned/,
  );
  assert.throws(
    () => readOrderMarketInstanceId(valid, Keypair.generate().publicKey),
    /not the current market authority/,
  );
  assert.throws(
    () => readOrderMarketInstanceId(marketAccount({ authority, mode: 2 }), authority),
    /not Live/,
  );
  assert.throws(
    () => assertMarketInstanceUninitialized(
      marketAccount({ authority, instanceId: 9n }),
      authority,
    ),
    /already initialized/,
  );
  assert.throws(
    () => readOrderMarketInstanceId({
      owner: V16_PROGRAM_ID,
      data: valid.data.subarray(0, valid.data.length - 1),
    }, authority),
    /dynamic layout/,
  );
  for (const mutate of [
    (data: Buffer) => data.writeBigUInt64LE(0n, 0),
    (data: Buffer) => data.writeUInt16LE(15, 8),
    (data: Buffer) => data.writeUInt8(2, 10),
    (data: Buffer) => data.writeUInt8(1, 11),
  ]) {
    const data = Buffer.from(valid.data);
    mutate(data);
    assert.throws(
      () => readOrderMarketInstanceId({ owner: V16_PROGRAM_ID, data }, authority),
      /header or layout/,
    );
  }
  assert.throws(
    () => readOrderMarketInstanceId(
      marketAccount({ authority, market: Keypair.generate().publicKey }),
      authority,
    ),
    /identity/,
  );
});

test("configuration is explicit and random generation rejects zero", () => {
  assert.deepEqual(parseArguments([]), { execute: false });
  assert.deepEqual(parseArguments(["--execute"]), { execute: true });
  assert.throws(() => parseArguments(["--broadcast"]), /only supported argument/);
  assert.equal(assertRpcUrl("https://rpc.example.invalid/path"), "https://rpc.example.invalid/path");
  assert.throws(() => assertRpcUrl("not-a-url"), /complete http/);
  assert.equal(assertExplicitSignerPath("/private/key.json"), "/private/key.json");
  assert.throws(() => assertExplicitSignerPath("relative.json"), /absolute path/);
  let calls = 0;
  assert.equal(generateOrderMarketInstanceId(() => {
    calls += 1;
    return calls === 1 ? Buffer.alloc(8) : exactRandom(55n)(8);
  }), 55n);
  assert.equal(calls, 2);
  assert.equal(
    safeInitializerError(new Error("failed at https://rpc.invalid/?api-key=secret")),
    "failed at [rpc-url]",
  );
});

test("dry-run simulates a signed transaction and never sends", async () => {
  const authority = Keypair.generate();
  let simulated = 0;
  let sent = 0;
  let confirmed = 0;
  let reads = 0;
  const dependencies: InitializerDependencies = {
    readMarket: async () => {
      reads += 1;
      return marketAccount({ authority: authority.publicKey });
    },
    latestBlockhash: async () => lifetime(),
    simulate: async (transaction) => {
      simulated += 1;
      assert.ok(transaction instanceof Transaction);
      assert.equal(transaction.verifySignatures(), true);
      return { value: { err: null, unitsConsumed: 321 } };
    },
    send: async () => { sent += 1; return "signature"; },
    confirm: async () => { confirmed += 1; return { value: { err: null } }; },
  };
  const logs: string[] = [];
  const result = await runOrderMarketInitializer({
    authority,
    dependencies,
    execute: false,
    random: exactRandom(77n),
    log: (message) => logs.push(message),
  });
  assert.deepEqual(result, { executed: false, instanceId: 77n, signature: null });
  assert.equal(reads, 1);
  assert.equal(simulated, 1);
  assert.equal(sent, 0);
  assert.equal(confirmed, 0);
  assert.equal(logs.some((line) => line.includes("SIMULATE ONLY")), true);
  assert.equal(logs.some((line) => /https?:\/\//.test(line)), false);
});

test("execute rechecks state, confirms once, and verifies exact readback", async () => {
  const authority = Keypair.generate();
  const instanceId = 88n;
  const accounts = [
    marketAccount({ authority: authority.publicKey }),
    marketAccount({ authority: authority.publicKey }),
    marketAccount({ authority: authority.publicKey, instanceId }),
  ];
  let sent = 0;
  let confirmed = 0;
  const dependencies: InitializerDependencies = {
    readMarket: async () => accounts.shift() ?? null,
    latestBlockhash: async () => lifetime(),
    simulate: async () => ({ value: { err: null } }),
    send: async (raw) => {
      sent += 1;
      assert.ok(raw.length > 0);
      return "confirmed-signature";
    },
    confirm: async (strategy) => {
      confirmed += 1;
      assert.equal(strategy.signature, "confirmed-signature");
      return { value: { err: null } };
    },
  };
  const result = await runOrderMarketInitializer({
    authority,
    dependencies,
    execute: true,
    random: exactRandom(instanceId),
    log: () => {},
  });
  assert.deepEqual(result, {
    executed: true,
    instanceId,
    signature: "confirmed-signature",
  });
  assert.equal(sent, 1);
  assert.equal(confirmed, 1);
});

test("execute refuses changed pre-send state and readback mismatch", async () => {
  const authority = Keypair.generate();
  let sent = 0;
  await assert.rejects(
    runOrderMarketInitializer({
      authority,
      execute: true,
      random: exactRandom(99n),
      log: () => {},
      dependencies: {
        readMarket: async () => marketAccount({
          authority: authority.publicKey,
          instanceId: sent === 0 ? 0n : 7n,
        }),
        latestBlockhash: async () => lifetime(),
        simulate: async () => {
          sent += 1;
          return { value: { err: null } };
        },
        send: async () => { throw new Error("must not send"); },
        confirm: async () => { throw new Error("must not confirm"); },
      },
    }),
    /already initialized/,
  );

  const accounts = [
    marketAccount({ authority: authority.publicKey }),
    marketAccount({ authority: authority.publicKey }),
    marketAccount({ authority: authority.publicKey, instanceId: 100n }),
  ];
  await assert.rejects(
    runOrderMarketInitializer({
      authority,
      execute: true,
      random: exactRandom(99n),
      log: () => {},
      dependencies: {
        readMarket: async () => accounts.shift() ?? null,
        latestBlockhash: async () => lifetime(),
        simulate: async () => ({ value: { err: null } }),
        send: async () => "signature",
        confirm: async () => ({ value: { err: null } }),
      },
    }),
    /readback did not match/,
  );
});

test("execute treats an on-chain confirmation error as terminal and skips readback", async () => {
  const authority = Keypair.generate();
  let reads = 0;
  await assert.rejects(
    runOrderMarketInitializer({
      authority,
      execute: true,
      random: exactRandom(101n),
      log: () => {},
      dependencies: {
        readMarket: async () => {
          reads += 1;
          return marketAccount({ authority: authority.publicKey });
        },
        latestBlockhash: async () => lifetime(),
        simulate: async () => ({ value: { err: null } }),
        send: async () => "signature",
        confirm: async () => ({
          value: { err: { InstructionError: [0, { Custom: 9 }] } },
        }),
      },
    }),
    /confirmation failed/,
  );
  assert.equal(reads, 2);
});
