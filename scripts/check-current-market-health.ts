/** Read-only current-market custody and matcher-capital diagnostic. */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  AccountLayout,
  AccountState,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  abortableSleep,
  RpcOperationSignalScope,
  runDeadlineBoundOperation,
  safeErrorMessage,
} from "./keeper-runtime.ts";
import {
  DEFAULT_COHERENCE_WINDOW_MS,
  formatV16HealthCoherence,
  monitorV16HealthCoherence,
} from "./v16-market-coherence.ts";
import {
  assessV16MarketHealth,
  formatV16MarketHealth,
  parseUsdcAmount,
  parseUsdcFloor,
  readV16MarketCollateralMint,
  readV16MarketHealthSnapshot,
} from "./v16-market-health.ts";

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "7C37Xn3NLknqmSaxASYy2uRkb1RQcXigPmJCANUNYnvq",
);
const MARKET = new PublicKey(
  process.env.MARKET ?? "DNhYhm8Pb2yRjTpk7SNXrevX8zNZ9eZuivxgxyNtwyPP",
);
const LP_PORTFOLIO = new PublicKey(
  process.env.LP_PORTFOLIO ?? "BWqxjf1GoYqRNZTy6h1txPxBtiiN9MyF5Hd2JtKYGVwS",
);

function parseSlotLimit(value: string | undefined, fallback: bigint): bigint {
  const normalized = value?.trim() || fallback.toString();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("MARKET_MAX_CLOCK_LAG_SLOTS must be a non-negative integer");
  }
  return BigInt(normalized);
}

function parseStrictBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error("REQUIRE_AUTHORITY_PARITY must be true, false, 1, or 0");
}

function safeSlotNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("RPC context slot is outside the safe integer range");
  }
  return Number(value);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL?.trim();
  if (!rpcUrl) throw new Error("RPC_URL is required for the read-only market health check");
  const rpcSignals = new RpcOperationSignalScope();
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetchMiddleware: (url, options, fetch) => fetch(url, {
      ...(options ?? {}),
      signal: rpcSignals.currentSignal() ?? options?.signal,
    }),
  });
  const coherence = await runDeadlineBoundOperation({
    parentSignal: new AbortController().signal,
    timeoutMs: DEFAULT_COHERENCE_WINDOW_MS + 15_000,
    work: (signal) => rpcSignals.run(signal, async () => {
      const discovery = await connection.getAccountInfoAndContext(MARKET, {
        commitment: "confirmed",
      });
      if (!discovery.value || !discovery.value.owner.equals(PROGRAM_ID)) {
        throw new Error("configured v16 market account is unavailable");
      }
      const collateralMint = new PublicKey(readV16MarketCollateralMint(
        Buffer.from(discovery.value.data),
        MARKET.toBytes(),
      ));
      const vaultAuthority = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), MARKET.toBuffer()],
        PROGRAM_ID,
      )[0];
      const vaultAta = getAssociatedTokenAddressSync(collateralMint, vaultAuthority, true);

      return monitorV16HealthCoherence({
        readSample: async (previousContextSlot) => {
          const requestedContextSlot = previousContextSlot === undefined
            ? BigInt(discovery.context.slot)
            : previousContextSlot > BigInt(discovery.context.slot)
              ? previousContextSlot
              : BigInt(discovery.context.slot);
          const accounts = await connection.getMultipleAccountsInfoAndContext(
            [MARKET, LP_PORTFOLIO, vaultAta],
            {
              commitment: "confirmed",
              minContextSlot: safeSlotNumber(requestedContextSlot),
            },
          );
          const [marketInfo, lpInfo, custodyInfo] = accounts.value;
          if (!marketInfo || !marketInfo.owner.equals(PROGRAM_ID)) {
            throw new Error("configured v16 market account is unavailable");
          }
          if (!lpInfo || !lpInfo.owner.equals(PROGRAM_ID)) {
            throw new Error("configured matcher LP portfolio is unavailable");
          }
          if (!custodyInfo || !custodyInfo.owner.equals(TOKEN_PROGRAM_ID)) {
            throw new Error("configured market custody token account is unavailable");
          }
          if (custodyInfo.data.length !== AccountLayout.span) {
            throw new Error("configured market custody token account has the wrong length");
          }

          const marketData = Buffer.from(marketInfo.data);
          const sampledCollateralMint = new PublicKey(readV16MarketCollateralMint(
            marketData,
            MARKET.toBytes(),
          ));
          if (!sampledCollateralMint.equals(collateralMint)) {
            throw new Error("market collateral mint changed inside the coherence window");
          }
          const custody = AccountLayout.decode(custodyInfo.data);
          if (!custody.mint.equals(collateralMint) || !custody.owner.equals(vaultAuthority)) {
            throw new Error("configured market custody token account identity is invalid");
          }
          if (custody.state !== AccountState.Initialized) {
            throw new Error("configured market custody token account is not initialized");
          }

          return assessV16MarketHealth(readV16MarketHealthSnapshot({
            custodyBalance: custody.amount,
            expectedLpPortfolio: LP_PORTFOLIO.toBytes(),
            expectedMarket: MARKET.toBytes(),
            lpData: Buffer.from(lpInfo.data),
            marketData,
            observedClusterSlot: BigInt(accounts.context.slot),
          }), parseUsdcFloor(process.env.LP_MIN_CAPITAL_USDC), {
            expectedDomainInsurance: parseUsdcAmount(
              process.env.EXPECTED_DOMAIN_INSURANCE_USDC,
              100_000,
              "EXPECTED_DOMAIN_INSURANCE_USDC",
            ),
            maxClockLagSlots: parseSlotLimit(process.env.MARKET_MAX_CLOCK_LAG_SLOTS, 300n),
            minimumLpRiskEquity: parseUsdcAmount(
              process.env.LP_MIN_RISK_EQUITY_USDC,
              100_000,
              "LP_MIN_RISK_EQUITY_USDC",
            ),
            requireAuthorityParity: parseStrictBoolean(process.env.REQUIRE_AUTHORITY_PARITY, true),
          });
        },
        sleep: (ms) => abortableSleep(ms, signal),
      });
    }),
  });
  console.log(formatV16MarketHealth(coherence.assessment));
  console.log(formatV16HealthCoherence(coherence));
  if (coherence.kind === "failed"
    || coherence.assessment.level === "critical"
    || coherence.assessment.level === "invalid") {
    process.exitCode = 2;
  }
}

if (process.argv[1]?.endsWith("check-current-market-health.ts")) {
  main().catch((error: unknown) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}
