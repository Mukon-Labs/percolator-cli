import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  V16_REANCHOR_EMPTY_MARKET_TAG,
  V16_REANCHOR_MARKET,
  V16_REANCHOR_PROGRAM_ID,
  buildReanchorEmptyMarketInstruction,
  encodeReanchorEmptyMarketV16,
} from "./guarded-empty-market-reanchor-v16.ts";

test("v16 guarded re-anchor wire format is the exact one-byte tag", () => {
  assert.deepEqual([...encodeReanchorEmptyMarketV16()], [V16_REANCHOR_EMPTY_MARKET_TAG]);
  assert.equal(V16_REANCHOR_EMPTY_MARKET_TAG, 80);
});

test("v16 guarded re-anchor account order and permissions are exact", () => {
  const authority = Keypair.generate().publicKey;
  const instruction = buildReanchorEmptyMarketInstruction({ authority });

  assert.equal(instruction.programId.toBase58(), V16_REANCHOR_PROGRAM_ID.toBase58());
  assert.deepEqual([...instruction.data], [80]);
  assert.deepEqual(
    instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({
      pubkey: pubkey.toBase58(),
      isSigner,
      isWritable,
    })),
    [
      { pubkey: authority.toBase58(), isSigner: true, isWritable: false },
      { pubkey: V16_REANCHOR_MARKET.toBase58(), isSigner: false, isWritable: true },
    ],
  );
});

test("v16 guarded re-anchor supports explicit non-production address injection", () => {
  const authority = Keypair.generate().publicKey;
  const market = Keypair.generate().publicKey;
  const programId = Keypair.generate().publicKey;
  const instruction = buildReanchorEmptyMarketInstruction({ authority, market, programId });

  assert.equal(instruction.programId.toBase58(), programId.toBase58());
  assert.equal(instruction.keys[1]?.pubkey.toBase58(), market.toBase58());
});
