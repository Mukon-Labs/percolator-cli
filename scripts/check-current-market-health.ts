/** Read-only current-market custody and matcher-capital diagnostic. */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { safeErrorMessage } from "./keeper-runtime.ts";
import {
  assessV16MarketHealth,
  formatV16MarketHealth,
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

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL?.trim();
  if (!rpcUrl) throw new Error("RPC_URL is required for the read-only market health check");
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
  const [marketInfo, lpInfo] = await connection.getMultipleAccountsInfo(
    [MARKET, LP_PORTFOLIO],
    "confirmed",
  );
  if (!marketInfo || !marketInfo.owner.equals(PROGRAM_ID)) {
    throw new Error("configured v16 market account is unavailable");
  }
  if (!lpInfo || !lpInfo.owner.equals(PROGRAM_ID)) {
    throw new Error("configured matcher LP portfolio is unavailable");
  }
  const marketData = Buffer.from(marketInfo.data);
  const collateralMint = new PublicKey(readV16MarketCollateralMint(marketData, MARKET.toBytes()));
  const vaultAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), MARKET.toBuffer()],
    PROGRAM_ID,
  )[0];
  const vaultAta = getAssociatedTokenAddressSync(collateralMint, vaultAuthority, true);
  const custodyBalance = BigInt(
    (await connection.getTokenAccountBalance(vaultAta, "confirmed")).value.amount,
  );
  const assessment = assessV16MarketHealth(readV16MarketHealthSnapshot({
    custodyBalance,
    expectedLpPortfolio: LP_PORTFOLIO.toBytes(),
    expectedMarket: MARKET.toBytes(),
    lpData: Buffer.from(lpInfo.data),
    marketData,
  }), parseUsdcFloor(process.env.LP_MIN_CAPITAL_USDC));
  console.log(formatV16MarketHealth(assessment));
  if (assessment.level === "critical" || assessment.level === "invalid") process.exitCode = 2;
}

if (process.argv[1]?.endsWith("check-current-market-health.ts")) {
  main().catch((error: unknown) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}
