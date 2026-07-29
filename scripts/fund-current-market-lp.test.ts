import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  assertCurrentLpPortfolio,
  depositInstruction,
  parseArguments,
  parseUsdcAmount,
} from "./fund-current-market-lp.ts";

const PROGRAM = new PublicKey("7C37Xn3NLknqmSaxASYy2uRkb1RQcXigPmJCANUNYnvq");
const MARKET = new PublicKey("DNhYhm8Pb2yRjTpk7SNXrevX8zNZ9eZuivxgxyNtwyPP");

function portfolioData(owner: PublicKey, market = MARKET): Buffer {
  const data = Buffer.alloc(148);
  market.toBuffer().copy(data, 16);
  owner.toBuffer().copy(data, 116);
  return data;
}

const owner = Keypair.generate().publicKey;
assert.equal(parseUsdcAmount("25000"), 25_000_000_000n);
assert.equal(parseUsdcAmount("0.000001"), 1n);
assert.throws(() => parseUsdcAmount("0"), /greater than zero/);
assert.deepEqual(parseArguments(["--amount-usdc", "25", "--broadcast"]), { amount: 25_000_000n, broadcast: true });
assert.throws(() => parseArguments(["--broadcast"]), /Pass --amount-usdc/);
assertCurrentLpPortfolio({ owner: PROGRAM, data: portfolioData(owner) }, owner);
assert.throws(() => assertCurrentLpPortfolio({ owner: PROGRAM, data: portfolioData(Keypair.generate().publicKey) }, owner), /not the owner/);
assert.throws(() => assertCurrentLpPortfolio({ owner: PROGRAM, data: portfolioData(owner, Keypair.generate().publicKey) }, owner), /current market/);

const ix = depositInstruction(owner, Keypair.generate().publicKey, Keypair.generate().publicKey, 25_000_000n);
assert.equal(ix.programId.toBase58(), PROGRAM.toBase58());
assert.equal(ix.data.readUInt8(0), 3);
assert.equal(ix.data.readBigUInt64LE(1), 25_000_000n);
assert.equal(ix.data.readBigUInt64LE(9), 0n);
assert.equal(ix.keys.length, 6);
assert.equal(ix.keys[0].isSigner, true);
console.log("fund-current-market-lp tests: 8/8 pass");
