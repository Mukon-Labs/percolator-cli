import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  AOP,
  AS,
  ASSET_ORACLE_WRAPPER_LEN,
  ASSET_SLOT_LEN,
  HEADER_LEN,
  MARKET_GROUP_HEADER_LEN,
  MARKET_GROUP_OFF,
  MG,
  WC,
} from "../../../_v16_cli/src/v16/constants.ts";
import {
  assertReanchorSimulationEffects,
  safeSimulationError,
} from "./simulate-guarded-empty-market-reanchor-v16.ts";

function market(authority: Uint8Array): Buffer {
  const data = Buffer.alloc(MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN + ASSET_SLOT_LEN);
  Buffer.from(authority).copy(data, HEADER_LEN + WC.marketauth);
  data.writeUInt32LE(1, MARKET_GROUP_OFF + MG.asset_slot_capacity);
  data.writeBigUInt64LE(3n, HEADER_LEN + WC.oracle_target_price_e6);
  const asset = MARKET_GROUP_OFF + MG.asset_slots + ASSET_ORACLE_WRAPPER_LEN;
  data.writeUInt8(2, asset + AS.lifecycle);
  data.writeBigUInt64LE(1n, asset + AS.raw_oracle_target_price);
  data.writeBigUInt64LE(1n, asset + AS.effective_price);
  data.writeBigUInt64LE(1n, asset + AS.fund_px_last);
  data.writeBigUInt64LE(1n, asset + AS.slot_last);
  data.writeBigUInt64LE(7n, MARKET_GROUP_OFF + MG.risk_epoch);
  data.writeBigUInt64LE(8n, MARKET_GROUP_OFF + MG.oracle_epoch);
  data.writeBigUInt64LE(9n, MARKET_GROUP_OFF + MG.funding_epoch);
  data.writeBigUInt64LE(1n, MARKET_GROUP_OFF + MG.current_slot);
  data.writeUInt8(1, MARKET_GROUP_OFF + MG.loss_stale_active);
  return data;
}

test("simulation effect checker accepts only the exact re-anchor mutation", () => {
  const authority = Keypair.generate().publicKey;
  const before = market(authority.toBytes());
  const after = Buffer.from(before);
  const asset = MARKET_GROUP_OFF + MG.asset_slots + ASSET_ORACLE_WRAPPER_LEN;
  for (const field of [AS.raw_oracle_target_price, AS.effective_price, AS.fund_px_last]) {
    after.writeBigUInt64LE(3n, asset + field);
  }
  after.writeBigUInt64LE(500n, asset + AS.slot_last);
  after.writeBigUInt64LE(8n, MARKET_GROUP_OFF + MG.risk_epoch);
  after.writeBigUInt64LE(9n, MARKET_GROUP_OFF + MG.oracle_epoch);
  after.writeBigUInt64LE(500n, MARKET_GROUP_OFF + MG.slot_last);
  after.writeBigUInt64LE(500n, MARKET_GROUP_OFF + MG.current_slot);
  after.writeUInt8(0, MARKET_GROUP_OFF + MG.loss_stale_active);

  const effects = assertReanchorSimulationEffects(before, after, authority);
  assert.equal(effects.changedByteCount > 0, true);
  assert.equal(effects.activeAssets[0]?.afterSlot, 500n);
  assert.equal(effects.fundingEpoch, 9n);
});

test("simulation effect checker rejects unrelated accounting mutation", () => {
  const authority = Keypair.generate().publicKey;
  const before = market(authority.toBytes());
  const after = Buffer.from(before);
  const asset = MARKET_GROUP_OFF + MG.asset_slots + ASSET_ORACLE_WRAPPER_LEN;
  for (const field of [AS.raw_oracle_target_price, AS.effective_price, AS.fund_px_last]) {
    after.writeBigUInt64LE(3n, asset + field);
  }
  after.writeBigUInt64LE(2n, asset + AS.slot_last);
  after.writeBigUInt64LE(2n, MARKET_GROUP_OFF + MG.current_slot);
  after.writeBigUInt64LE(2n, MARKET_GROUP_OFF + MG.slot_last);
  after.writeBigUInt64LE(8n, MARKET_GROUP_OFF + MG.risk_epoch);
  after.writeBigUInt64LE(9n, MARKET_GROUP_OFF + MG.oracle_epoch);
  after.writeUInt8(0, MARKET_GROUP_OFF + MG.loss_stale_active);
  after.writeUInt8(1, MARKET_GROUP_OFF + MG.vault);
  assert.throws(
    () => assertReanchorSimulationEffects(before, after, authority),
    /forbidden market byte/,
  );
});

test("simulation errors redact credential-bearing URLs", () => {
  assert.equal(
    safeSimulationError(new Error("failed at https://rpc.invalid/?api-key=secret")),
    "failed at [rpc-url]",
  );
  assert.equal(AOP.oracle_target_price_e6, 200);
});
