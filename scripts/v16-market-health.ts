const V16_MAGIC = 0x5045_5243_5631_3600n;
const V16_VERSION = 16;
const KIND_MARKET = 1;
const KIND_PORTFOLIO = 2;
const HEADER_LEN = 16;
const MARKET_GROUP_OFF = HEADER_LEN + 448;
const MARKET_MIN_LEN = MARKET_GROUP_OFF + 726;
const MARKET_ID_OFF = MARKET_GROUP_OFF;
const COLLATERAL_MINT_OFF = HEADER_LEN + 32;
const MARKET_VAULT_OFF = MARKET_GROUP_OFF + 285;
const MARKET_INSURANCE_OFF = MARKET_GROUP_OFF + 301;
const MARKET_C_TOT_OFF = MARKET_GROUP_OFF + 317;
const MARKET_LOSS_STALE_OFF = MARKET_GROUP_OFF + 591;

const PORTFOLIO_STATE_OFF = HEADER_LEN;
const PORTFOLIO_MIN_LEN = 9411;
const PORTFOLIO_MARKET_OFF = PORTFOLIO_STATE_OFF;
const PORTFOLIO_ID_OFF = PORTFOLIO_STATE_OFF + 32;
const PORTFOLIO_CAPITAL_OFF = PORTFOLIO_STATE_OFF + 132;
const PORTFOLIO_PNL_OFF = PORTFOLIO_STATE_OFF + 148;
const PORTFOLIO_FEE_CREDITS_OFF = PORTFOLIO_STATE_OFF + 292;
const PORTFOLIO_ACTIVE_BITMAP_OFF = PORTFOLIO_STATE_OFF + 332;

// PortfolioAccountV16Account.health_cert follows 16 legs and 32 source-domain
// records. These offsets are guarded by the deployed v16 layout discriminator.
const HEALTH_CERT_OFF = PORTFOLIO_STATE_OFF + 8916;
const CERTIFIED_EQUITY_OFF = HEALTH_CERT_OFF;
const CERTIFIED_INITIAL_REQ_OFF = HEALTH_CERT_OFF + 16;
const CERTIFIED_MAINTENANCE_REQ_OFF = HEALTH_CERT_OFF + 32;
const HEALTH_CERT_VALID_OFF = HEALTH_CERT_OFF + 120;

function fail(message: string): never {
  throw new Error(message);
}

function u128(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset) | (data.readBigUInt64LE(offset + 8) << 64n);
}

function i128(data: Buffer, offset: number): bigint {
  const value = u128(data, offset);
  return value < (1n << 127n) ? value : value - (1n << 128n);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertHeader(data: Buffer, kind: number, label: string): void {
  if (data.length < HEADER_LEN) fail(`${label} account is too short`);
  if (data.readBigUInt64LE(0) !== V16_MAGIC
    || data.readUInt16LE(8) !== V16_VERSION
    || data.readUInt8(10) !== kind) {
    fail(`${label} account is not the expected v16 account kind`);
  }
}

function strictBool(data: Buffer, offset: number, label: string): boolean {
  const value = data.readUInt8(offset);
  if (value === 0) return false;
  if (value === 1) return true;
  return fail(`${label} has an invalid boolean encoding`);
}

export interface V16MarketHealthSnapshot {
  accountedVault: bigint;
  aggregateCapital: bigint;
  collateralMint: Uint8Array;
  custodyBalance: bigint;
  insurance: bigint;
  lossStaleActive: boolean;
  lpActiveLegs: number;
  lpBookEquity: bigint;
  lpCapital: bigint;
  lpCertifiedEquity: bigint | null;
  lpCertifiedInitialRequirement: bigint | null;
  lpCertifiedMaintenanceRequirement: bigint | null;
  lpFeeCredits: bigint;
  lpPnl: bigint;
  lpRiskEquity: bigint;
}

export type V16MarketHealthLevel = "healthy" | "warning" | "critical" | "invalid";

export interface V16MarketHealthAssessment extends V16MarketHealthSnapshot {
  accountingResidual: bigint | null;
  custodyDelta: bigint;
  level: V16MarketHealthLevel;
  minimumLpCapital: bigint;
  reasons: string[];
}

export function readV16MarketCollateralMint(
  marketData: Buffer,
  expectedMarket: Uint8Array,
): Uint8Array {
  assertHeader(marketData, KIND_MARKET, "market");
  if (marketData.length < MARKET_MIN_LEN) fail("market account is too short for the v16 header");
  if (!sameBytes(marketData.subarray(MARKET_ID_OFF, MARKET_ID_OFF + 32), expectedMarket)) {
    fail("market account identity does not match the configured market");
  }
  return Uint8Array.from(marketData.subarray(COLLATERAL_MINT_OFF, COLLATERAL_MINT_OFF + 32));
}

export function readV16MarketHealthSnapshot(input: {
  custodyBalance: bigint;
  expectedLpPortfolio: Uint8Array;
  expectedMarket: Uint8Array;
  lpData: Buffer;
  marketData: Buffer;
}): V16MarketHealthSnapshot {
  const { lpData, marketData } = input;
  assertHeader(lpData, KIND_PORTFOLIO, "LP portfolio");
  if (lpData.length !== PORTFOLIO_MIN_LEN) fail("LP portfolio account has the wrong length");
  const collateralMint = readV16MarketCollateralMint(marketData, input.expectedMarket);
  if (!sameBytes(lpData.subarray(PORTFOLIO_MARKET_OFF, PORTFOLIO_MARKET_OFF + 32), input.expectedMarket)) {
    fail("LP portfolio belongs to a different market");
  }
  if (!sameBytes(lpData.subarray(PORTFOLIO_ID_OFF, PORTFOLIO_ID_OFF + 32), input.expectedLpPortfolio)) {
    fail("LP portfolio identity does not match the configured portfolio");
  }
  if (input.custodyBalance < 0n) fail("custody balance cannot be negative");

  const lpCapital = u128(lpData, PORTFOLIO_CAPITAL_OFF);
  const lpPnl = i128(lpData, PORTFOLIO_PNL_OFF);
  const lpFeeCredits = i128(lpData, PORTFOLIO_FEE_CREDITS_OFF);
  const feeDebt = lpFeeCredits < 0n ? -lpFeeCredits : lpFeeCredits;
  const certValid = strictBool(lpData, HEALTH_CERT_VALID_OFF, "LP health certificate");
  const activeBitmap = lpData.readBigUInt64LE(PORTFOLIO_ACTIVE_BITMAP_OFF);
  let lpActiveLegs = 0;
  for (let bitmap = activeBitmap; bitmap !== 0n; bitmap >>= 1n) {
    lpActiveLegs += Number(bitmap & 1n);
  }

  return {
    accountedVault: u128(marketData, MARKET_VAULT_OFF),
    aggregateCapital: u128(marketData, MARKET_C_TOT_OFF),
    collateralMint,
    custodyBalance: input.custodyBalance,
    insurance: u128(marketData, MARKET_INSURANCE_OFF),
    lossStaleActive: strictBool(marketData, MARKET_LOSS_STALE_OFF, "market loss-stale flag"),
    lpActiveLegs,
    lpBookEquity: lpCapital + lpPnl - feeDebt,
    lpCapital,
    lpCertifiedEquity: certValid ? i128(lpData, CERTIFIED_EQUITY_OFF) : null,
    lpCertifiedInitialRequirement: certValid ? u128(lpData, CERTIFIED_INITIAL_REQ_OFF) : null,
    lpCertifiedMaintenanceRequirement: certValid ? u128(lpData, CERTIFIED_MAINTENANCE_REQ_OFF) : null,
    lpFeeCredits,
    lpPnl,
    // Positive released PnL is not safe margin support under a locked lane.
    lpRiskEquity: lpCapital + (lpPnl < 0n ? lpPnl : 0n) - feeDebt,
  };
}

export function assessV16MarketHealth(
  snapshot: V16MarketHealthSnapshot,
  minimumLpCapital: bigint,
): V16MarketHealthAssessment {
  if (minimumLpCapital < 0n) fail("minimum LP capital cannot be negative");
  const custodyDelta = snapshot.custodyBalance - snapshot.accountedVault;
  const seniorTotal = snapshot.aggregateCapital + snapshot.insurance;
  const accountingResidual = snapshot.accountedVault >= seniorTotal
    ? snapshot.accountedVault - seniorTotal
    : null;
  const invalidReasons: string[] = [];
  const criticalReasons: string[] = [];
  const warningReasons: string[] = [];

  if (custodyDelta !== 0n) invalidReasons.push("token custody does not equal the market's accounted vault");
  if (accountingResidual === null) invalidReasons.push("accounted vault is below aggregate capital plus insurance");
  if (snapshot.lpRiskEquity <= 0n) criticalReasons.push("LP no-positive-credit risk equity is non-positive");
  if (snapshot.lpCertifiedEquity !== null
    && snapshot.lpCertifiedMaintenanceRequirement !== null
    && snapshot.lpCertifiedEquity < snapshot.lpCertifiedMaintenanceRequirement) {
    criticalReasons.push("LP certified equity is below maintenance requirement");
  }
  if (snapshot.lossStaleActive) criticalReasons.push("market loss-stale lock is active");
  if (snapshot.lpActiveLegs > 0 && snapshot.lpCertifiedEquity === null) {
    criticalReasons.push("LP has open legs without a valid health certificate");
  }
  if (snapshot.lpCapital < minimumLpCapital) warningReasons.push("LP capital is below the configured operating floor");
  if (snapshot.lpPnl < 0n) warningReasons.push("LP has negative released PnL");
  if (snapshot.lpCertifiedEquity !== null
    && snapshot.lpCertifiedInitialRequirement !== null
    && snapshot.lpCertifiedEquity < snapshot.lpCertifiedInitialRequirement) {
    warningReasons.push("LP certified equity is below initial requirement");
  }
  const reasons = invalidReasons.length
    ? invalidReasons
    : criticalReasons.length
      ? [...criticalReasons, ...warningReasons]
      : warningReasons;
  const level: V16MarketHealthLevel = invalidReasons.length
    ? "invalid"
    : criticalReasons.length
      ? "critical"
      : warningReasons.length
        ? "warning"
        : "healthy";
  return { ...snapshot, accountingResidual, custodyDelta, level, minimumLpCapital, reasons };
}

export function parseUsdcFloor(input: string | undefined, fallbackUsdc = 10_000): bigint {
  const value = input?.trim() || String(fallbackUsdc);
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) fail("LP_MIN_CAPITAL_USDC must be a non-negative decimal with at most 6 places");
  const [whole, fractional = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fractional + "000000").slice(0, 6));
}

function formatAtoms(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const fractional = (absolute % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${sign}$${whole.toLocaleString("en-US")}.${fractional}`;
}

export function formatV16MarketHealth(assessment: V16MarketHealthAssessment): string {
  const cert = assessment.lpCertifiedEquity === null
    ? "cert unavailable"
    : `cert equity ${formatAtoms(assessment.lpCertifiedEquity)} / maint ${formatAtoms(assessment.lpCertifiedMaintenanceRequirement ?? 0n)}`;
  const residual = assessment.accountingResidual === null
    ? "invalid"
    : formatAtoms(assessment.accountingResidual);
  const reason = assessment.reasons.length ? ` | ${assessment.reasons.join("; ")}` : "";
  return [
    `LP HEALTH ${assessment.level.toUpperCase()}`,
    `capital ${formatAtoms(assessment.lpCapital)}`,
    `pnl ${formatAtoms(assessment.lpPnl)}`,
    `risk equity ${formatAtoms(assessment.lpRiskEquity)}`,
    cert,
    `custody ${formatAtoms(assessment.custodyBalance)}`,
    `accounted vault ${formatAtoms(assessment.accountedVault)}`,
    `aggregate capital ${formatAtoms(assessment.aggregateCapital)}`,
    `insurance ${formatAtoms(assessment.insurance)}`,
    `other accounted pools/residual ${residual}`,
  ].join(" | ") + reason;
}
