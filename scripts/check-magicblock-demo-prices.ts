import { Connection } from "@solana/web3.js";
import {
  MAGICBLOCK_DEMO_RPC_URL,
  readMagicBlockDemoPrices,
  requireMagicBlockDemoConfiguration,
} from "./magicblock-demo-prices.ts";

const connection = new Connection(MAGICBLOCK_DEMO_RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
const nowSecs = Math.floor(Date.now() / 1000);
const prices = await readMagicBlockDemoPrices({
  connection,
  configuration: requireMagicBlockDemoConfiguration(process.env),
  nowSecs,
});

for (const price of [...prices.values()].sort((a, b) => a.index - b.index)) {
  console.log(JSON.stringify({
    ageSeconds: nowSecs - price.publishTime,
    index: price.index,
    price: price.displayPrice,
    source: "magicblock-demo",
    symbol: price.symbol,
  }));
}
