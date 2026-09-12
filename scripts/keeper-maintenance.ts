import { KeeperFailure, readV16RecoveryStatus } from "./keeper-runtime.ts";

// Existing v16 deployment envelope: no larger batch/CU budget or engine dt.
export const MAX_MAINTENANCE_CRANKS = 9;
export const MAINTENANCE_HEADROOM_SLOTS = 40n;
const GROUP = 16 + 448;
const ASSETS = GROUP + 726;
const ASSET_BYTES = 1797;
const MAX_ACCRUAL_DT = GROUP + 32 + 118;

export interface ClockMaintenancePlan {
  assetIndexes: number[];
  blockedAssetIndexes: number[];
  observedSlot: bigint;
  maxDebtSlots: bigint;
  maxAccrualDtSlots: bigint;
  cranks: number;
  capped: boolean;
}

/** Treat the RPC envelope as untrusted, including owner and context. */
export function decodeMaintenanceResponse(payload: unknown, input: {
  expectedOwner: string; expectedMarket: Uint8Array; minimumContextSlot: bigint;
  pushedAssetIndexes: readonly number[];
}): ClockMaintenancePlan {
  const response = payload as { result?: { context?: { slot?: unknown };
    value?: { owner?: unknown; data?: unknown } } } | null;
  const value = response?.result?.value;
  const slot = response?.result?.context?.slot;
  if (!value || value.owner !== input.expectedOwner || typeof slot !== "number"
    || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value.data)
    || typeof value.data[0] !== "string" || value.data[1] !== "base64") {
    throw new KeeperFailure("onchain", "maintenance market owner/layout/context unavailable");
  }
  return planClockMaintenance({ ...input, marketData: Buffer.from(value.data[0], "base64"),
    contextSlot: BigInt(slot) });
}

/** Use individual clocks and the response context, not just the last-touched
 * asset's loss-stale summary or a 300-slot monitoring tolerance. Headroom sizes
 * work for time until execution; it never advances an asset into the future. */
export function planClockMaintenance(input: {
  marketData: Uint8Array;
  expectedMarket: Uint8Array;
  contextSlot: bigint;
  minimumContextSlot: bigint;
  pushedAssetIndexes: readonly number[];
}): ClockMaintenancePlan {
  const status = readV16RecoveryStatus(input.marketData, input.expectedMarket, 0n);
  if (input.contextSlot > BigInt(Number.MAX_SAFE_INTEGER)
    || input.contextSlot < input.minimumContextSlot || input.minimumContextSlot < 0n
    || input.contextSlot < status.marketCurrentSlot) {
    throw new KeeperFailure("onchain", "maintenance context slot is stale or inconsistent");
  }
  const view = new DataView(input.marketData.buffer, input.marketData.byteOffset, input.marketData.byteLength);
  const dt = view.getBigUint64(MAX_ACCRUAL_DT, true);
  if (dt === 0n) throw new KeeperFailure("onchain", "maintenance accrual cap is zero");
  const count = view.getUint32(GROUP + 281, true);
  const pushed = new Set(input.pushedAssetIndexes);
  if (pushed.size !== input.pushedAssetIndexes.length
    || [...pushed].some(i => !Number.isSafeInteger(i) || i < 0 || i >= count)) {
    throw new KeeperFailure("onchain", "maintenance asset indexes are invalid");
  }
  const assetIndexes: number[] = [], blockedAssetIndexes: number[] = [];
  let maxDebtSlots = 0n;
  for (let i = 0; i < count; i++) {
    const engine = ASSETS + i * ASSET_BYTES + 512;
    const lifecycle = view.getUint8(engine + 16);
    if (lifecycle !== 2 && lifecycle !== 3) continue;
    if (!pushed.has(i)) { blockedAssetIndexes.push(i); continue; }
    assetIndexes.push(i);
    const debt = input.contextSlot - view.getBigUint64(engine + 41, true);
    if (debt > maxDebtSlots) maxDebtSlots = debt;
  }
  const needed = (maxDebtSlots + MAINTENANCE_HEADROOM_SLOTS + dt - 1n) / dt;
  const capped = needed > BigInt(MAX_MAINTENANCE_CRANKS);
  return { assetIndexes, blockedAssetIndexes, observedSlot: input.contextSlot,
    maxDebtSlots, maxAccrualDtSlots: dt,
    cranks: assetIndexes.length === 0 ? 0 : Number(capped ? BigInt(MAX_MAINTENANCE_CRANKS) : needed),
    capped: assetIndexes.length > 0 && capped };
}

/** One fresh plan and at most one independently committed maintenance batch.
 * Any read/send/confirmation failure prevents LP work; pending bytes remain
 * owned by the existing send gate. No cached decisions or second heal here. */
export async function maintainBeforeLp<T>(input: {
  signal: AbortSignal;
  readPlan(): Promise<ClockMaintenancePlan>;
  maintain(plan: ClockMaintenancePlan): Promise<void>;
  crankLp(plan: ClockMaintenancePlan): Promise<T>;
}): Promise<T | undefined> {
  const checkCancelled = () => {
    if (input.signal.aborted) throw new KeeperFailure("cancelled", "clock maintenance cancelled");
  };
  checkCancelled();
  const plan = await input.readPlan();
  checkCancelled();
  if (plan.cranks === 0) return undefined;
  await input.maintain(plan);
  checkCancelled();
  return input.crankLp(plan);
}
