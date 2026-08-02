import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assessV16MarketHealth,
  formatV16MarketHealth,
  parseUsdcFloor,
  readV16MarketCollateralMint,
  readV16MarketHealthSnapshot,
} from "./v16-market-health.ts";

const MAGIC = 0x5045_5243_5631_3600n;
const MARKET_GROUP_OFF = 464;
const MARKET_ID = new Uint8Array(32).fill(3);
const LP_ID = new Uint8Array(32).fill(4);

function writeU128(data: Buffer, offset: number, value: bigint): void {
  data.writeBigUInt64LE(value & ((1n << 64n) - 1n), offset);
  data.writeBigUInt64LE(value >> 64n, offset + 8);
}

function writeI128(data: Buffer, offset: number, value: bigint): void {
  writeU128(data, offset, value < 0n ? value + (1n << 128n) : value);
}

function marketFixture(input: {
  vault?: bigint;
  capital?: bigint;
  insurance?: bigint;
  lossStale?: boolean;
} = {}): Buffer {
  const data = Buffer.alloc(MARKET_GROUP_OFF + 726);
  data.writeBigUInt64LE(MAGIC, 0);
  data.writeUInt16LE(16, 8);
  data.writeUInt8(1, 10);
  data.set(new Uint8Array(32).fill(2), 48);
  data.set(MARKET_ID, MARKET_GROUP_OFF);
  writeU128(data, MARKET_GROUP_OFF + 285, input.vault ?? 120_000_000_000n);
  writeU128(data, MARKET_GROUP_OFF + 301, input.insurance ?? 10_000_000_000n);
  writeU128(data, MARKET_GROUP_OFF + 317, input.capital ?? 100_000_000_000n);
  data.writeUInt8(input.lossStale ? 1 : 0, MARKET_GROUP_OFF + 591);
  return data;
}

function lpFixture(input: {
  capital?: bigint;
  pnl?: bigint;
  feeCredits?: bigint;
  activeBitmap?: bigint;
  certValid?: boolean;
  certifiedEquity?: bigint;
  initialRequirement?: bigint;
  maintenanceRequirement?: bigint;
} = {}): Buffer {
  const data = Buffer.alloc(9411);
  data.writeBigUInt64LE(MAGIC, 0);
  data.writeUInt16LE(16, 8);
  data.writeUInt8(2, 10);
  data.set(MARKET_ID, 16);
  data.set(LP_ID, 48);
  writeU128(data, 148, input.capital ?? 50_000_000_000n);
  writeI128(data, 164, input.pnl ?? 0n);
  writeI128(data, 308, input.feeCredits ?? 0n);
  data.writeBigUInt64LE(input.activeBitmap ?? 1n, 348);
  writeI128(data, 8932, input.certifiedEquity ?? 48_000_000_000n);
  writeU128(data, 8948, input.initialRequirement ?? 10_000_000_000n);
  writeU128(data, 8964, input.maintenanceRequirement ?? 5_000_000_000n);
  data.writeUInt8(input.certValid === false ? 0 : 1, 9052);
  return data;
}

function snapshot(input: {
  custody?: bigint;
  market?: Parameters<typeof marketFixture>[0];
  lp?: Parameters<typeof lpFixture>[0];
} = {}) {
  return readV16MarketHealthSnapshot({
    custodyBalance: input.custody ?? input.market?.vault ?? 120_000_000_000n,
    expectedLpPortfolio: LP_ID,
    expectedMarket: MARKET_ID,
    lpData: lpFixture(input.lp),
    marketData: marketFixture(input.market),
  });
}

test("healthy LP separates custody, aggregate capital, insurance, and matcher equity", () => {
  const health = assessV16MarketHealth(snapshot(), 10_000_000_000n);
  assert.equal(health.level, "healthy");
  assert.equal(health.lpCapital, 50_000_000_000n);
  assert.equal(health.lpRiskEquity, 50_000_000_000n);
  assert.equal(health.accountingResidual, 10_000_000_000n);
  assert.equal(health.custodyDelta, 0n);
  assert.deepEqual(health.reasons, []);
});

test("zero-capital negative-PnL matcher is critical even when custody is large", () => {
  const health = assessV16MarketHealth(snapshot({
    lp: { capital: 0n, pnl: -12_900_000_000n, certifiedEquity: -12_900_000_000n },
  }), 10_000_000_000n);
  assert.equal(health.level, "critical");
  assert.equal(health.lpBookEquity, -12_900_000_000n);
  assert.equal(health.lpRiskEquity, -12_900_000_000n);
  assert.ok(health.reasons.some((reason) => reason.includes("non-positive")));
  assert.ok(health.reasons.some((reason) => reason.includes("operating floor")));
  const rendered = formatV16MarketHealth(health);
  assert.match(rendered, /LP HEALTH CRITICAL/);
  assert.match(rendered, /capital \$0\.00/);
  assert.match(rendered, /pnl -\$12,900\.00/);
  assert.match(rendered, /custody \$120,000\.00/);
});

test("negative PnL and fee debt reduce conservative risk equity", () => {
  const health = assessV16MarketHealth(snapshot({
    lp: { capital: 50_000_000_000n, pnl: -8_000_000_000n, feeCredits: 2_000_000_000n },
  }), 10_000_000_000n);
  assert.equal(health.level, "warning");
  assert.equal(health.lpRiskEquity, 40_000_000_000n);
  assert.ok(health.reasons.some((reason) => reason.includes("negative released PnL")));
});

test("custody/accounting mismatch and an impossible senior stack fail invalid", () => {
  const custodyMismatch = assessV16MarketHealth(snapshot({ custody: 119_000_000_000n }), 0n);
  assert.equal(custodyMismatch.level, "invalid");
  assert.equal(custodyMismatch.custodyDelta, -1_000_000_000n);

  const seniorDeficit = assessV16MarketHealth(snapshot({
    market: { vault: 100n, capital: 90n, insurance: 20n },
    custody: 100n,
  }), 0n);
  assert.equal(seniorDeficit.level, "invalid");
  assert.equal(seniorDeficit.accountingResidual, null);
});

test("loss-stale and maintenance deficits are critical; invalid certificates stay explicit", () => {
  assert.equal(assessV16MarketHealth(snapshot({ market: { lossStale: true } }), 0n).level, "critical");
  const underMaintenance = assessV16MarketHealth(snapshot({
    lp: { certifiedEquity: 4_000_000_000n, maintenanceRequirement: 5_000_000_000n },
  }), 0n);
  assert.equal(underMaintenance.level, "critical");

  const unavailable = assessV16MarketHealth(snapshot({ lp: { certValid: false, activeBitmap: 3n } }), 0n);
  assert.equal(unavailable.level, "critical");
  assert.equal(unavailable.lpCertifiedEquity, null);
  assert.ok(unavailable.reasons.some((reason) => reason.includes("without a valid health certificate")));
});

test("identity, boolean, and operating-floor parsing fail closed", () => {
  const wrongLp = lpFixture();
  wrongLp.fill(9, 48, 80);
  assert.throws(() => readV16MarketHealthSnapshot({
    custodyBalance: 0n,
    expectedLpPortfolio: LP_ID,
    expectedMarket: MARKET_ID,
    lpData: wrongLp,
    marketData: marketFixture(),
  }), /identity/);

  const oversizedLp = Buffer.concat([lpFixture(), Buffer.from([0])]);
  assert.throws(() => readV16MarketHealthSnapshot({
    custodyBalance: 0n,
    expectedLpPortfolio: LP_ID,
    expectedMarket: MARKET_ID,
    lpData: oversizedLp,
    marketData: marketFixture(),
  }), /wrong length/);

  const wrongMarket = marketFixture();
  wrongMarket.fill(8, MARKET_GROUP_OFF, MARKET_GROUP_OFF + 32);
  assert.throws(
    () => readV16MarketCollateralMint(wrongMarket, MARKET_ID),
    /market account identity/,
  );

  const malformed = marketFixture();
  malformed.writeUInt8(2, MARKET_GROUP_OFF + 591);
  assert.throws(() => readV16MarketHealthSnapshot({
    custodyBalance: 0n,
    expectedLpPortfolio: LP_ID,
    expectedMarket: MARKET_ID,
    lpData: lpFixture(),
    marketData: malformed,
  }), /boolean/);

  assert.equal(parseUsdcFloor(undefined), 10_000_000_000n);
  assert.equal(parseUsdcFloor("1250.5"), 1_250_500_000n);
  assert.throws(() => parseUsdcFloor("-1"), /LP_MIN_CAPITAL_USDC/);
});

test("keeper reports startup, periodic, and rejected-crank health without funding", async () => {
  const source = await readFile(new URL("./oracle-keeper-v16.ts", import.meta.url), "utf8");
  assert.match(source, /reportLpHealth\("startup", signal\)/);
  assert.match(source, /reportLpHealth\("periodic", signal\)/);
  assert.match(source, /reportLpHealth\("crank rejected", signal\)/);
  assert.match(source, /LP_HEALTH_CHECK_MS = 5 \* 60_000/);
  assert.match(source, /LP_FAILURE_HEALTH_CHECK_MS = 60_000/);
  assert.doesNotMatch(source, /fund-current-market-lp|mintTo|topUpBacking|depositInstruction/);
});
