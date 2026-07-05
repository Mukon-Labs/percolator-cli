# Oracle Keeper — Hosting Guide (Fly.io)

The keeper pushes live Pyth prices to the SOL / BTC / ETH Hyperp slabs on devnet.
If it stops, those markets freeze (no fresh oracle → trades revert / show stale PnL).
This runs it 24/7 on Fly.io — the same platform as mukon-messengr.

## 1. Get a dedicated devnet RPC (fixes the 429 rate-limiting)

The public `api.devnet.solana.com` throttles 3 markets × every 5s. Get a free key:

- **Helius** (recommended): https://helius.dev → create app → devnet → copy the RPC URL
  (`https://devnet.helius-rpc.com/?api-key=...`)
- **QuickNode**: https://quicknode.com → create a Solana devnet endpoint

## 2. Prepare the oracle-authority key for a secret

Fly has no local keypair file, so the key travels as a secret (base64, single line):

```bash
base64 -i ~/.config/solana/mukon-deployer.json
```

> Devnet test key = fine to host. For **mainnet**, mint a dedicated key whose
> only role is oracle authority (`set-oracle-authority`), so a host compromise
> can't touch LP capital or the upgrade authority.

## 3. Deploy to Fly

```bash
cd /Users/ash/Mukon-Perps/percolator-cli

# Create the app from the committed fly.toml (don't deploy yet)
fly launch --no-deploy --copy-config --name ninja-oracle-keeper

# Secrets (never commit these)
fly secrets set RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
fly secrets set KEEPER_SECRET_KEY="$(base64 -i ~/.config/solana/mukon-deployer.json)"

# Singleton — exactly one keeper (two would double-push prices)
fly deploy
fly scale count 1
```

Set `primary_region` in `fly.toml` to match your other Mukon apps before launch.

## 4. Verify

```bash
fly logs
```

should show ticks like:

```
[12:20:30] SOL $80.77✓  BTC $61579.57✓  ETH $1721.38✓
```

Fly restarts the machine automatically if the process exits, and the keeper's
own backoff + unhandledRejection guard keep it alive through transient RPC blips.

## Config reference

See `.env.example`. Keeper vars: `RPC_URL`, `KEEPER_SECRET_KEY`, optional
`PROGRAM_ID`, and `SLAB`/`FEED_ID` to run a single market instead of all three.

## Local dev

Unchanged — with no `KEEPER_SECRET_KEY` set it falls back to
`~/.config/solana/mukon-deployer.json`:

```bash
npm run keeper
```

## When to revisit self-hosted RPC

Not now. Solana's **RPC 2.0** (Triton One + Foundation, open-source AGPL) makes the
*read* layer cheap (~$400/mo-class), but you still need a Geyser validator to feed
it, and the keeper is *write*-heavy (tx submission, which RPC 2.0 doesn't replace).
On consumer hardware it's not viable. Evaluate at mainnet scale with real volume;
until then a managed RPC (Helius/Triton) is the right call.
