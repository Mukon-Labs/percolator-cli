/**
 * Unsigned v16 guarded empty-market re-anchor instruction builder.
 *
 * This module deliberately does not load a signer, contact RPC, sign, or send.
 * Operational tooling must first inspect the exact live market, then simulate
 * the returned instruction under a separately authorized signer workflow.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const V16_REANCHOR_EMPTY_MARKET_TAG = 80;
export const V16_REANCHOR_PROGRAM_ID = new PublicKey(
  "7C37Xn3NLknqmSaxASYy2uRkb1RQcXigPmJCANUNYnvq",
);
export const V16_REANCHOR_MARKET = new PublicKey(
  "DNhYhm8Pb2yRjTpk7SNXrevX8zNZ9eZuivxgxyNtwyPP",
);

export interface ReanchorEmptyMarketAddresses {
  authority: PublicKey;
  market?: PublicKey;
  programId?: PublicKey;
}

export function encodeReanchorEmptyMarketV16(): Buffer {
  return Buffer.from([V16_REANCHOR_EMPTY_MARKET_TAG]);
}

export function buildReanchorEmptyMarketInstruction({
  authority,
  market = V16_REANCHOR_MARKET,
  programId = V16_REANCHOR_PROGRAM_ID,
}: ReanchorEmptyMarketAddresses): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
    ],
    data: encodeReanchorEmptyMarketV16(),
  });
}
