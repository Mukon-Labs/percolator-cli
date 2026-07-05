# Oracle Keeper — Hosting Guide

The keeper pushes live Pyth prices to the SOL / BTC / ETH Hyperp slabs on devnet.
If it stops, those markets freeze (no fresh oracle → trades revert / show stale PnL).
This runs it 24/7 on Railway with a dedicated RPC.

## 1. Get a dedicated devnet RPC (fixes the 429 rate-limiting)

The public `api.devnet.solana.com` throttles 3 markets × every 5s. Get a free key:

- **Helius** (recommended): https://helius.dev → create app → devnet → copy the RPC URL
  (`https://devnet.helius-rpc.com/?api-key=...`)
- **QuickNode**: https://quicknode.com → create a Solana devnet endpoint

## 2. Prepare the oracle-authority key for env

Railway has no local keypair file, so the key travels as an env secret:

```bash
# base64 form (single line, easiest to paste)
base64 -i ~/.config/solana/mukon-deployer.json
```

Copy the output — it goes in `KEEPER_SECRET_KEY`. (JSON-array form also works.)

> Devnet test key = fine to host. For **mainnet**, mint a dedicated key whose
> only role is oracle authority (`set-oracle-authority`), so a host compromise
> can't touch LP capital or the upgrade authority.

## 3. Deploy to Railway

The percolator-cli `origin` remote isn't ours to push to, so deploy the local
folder directly with the Railway CLI (no GitHub repo needed):

```bash
npm i -g @railway/cli
railway login
cd /Users/ash/Mukon-Perps/percolator-cli
railway init            # create a new project
railway up              # uploads this folder, builds via Nixpacks, runs `npm start`
```

Then set the env vars (dashboard → Variables, or CLI):

```bash
railway variables --set "RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
railway variables --set "KEEPER_SECRET_KEY=<base64 from step 2>"
```

`railway.json` already pins the start command (`npm start`) and an on-failure
restart policy (up to 10 retries), so a transient crash self-heals.

## 4. Verify

`railway logs` should show ticks like:

```
[12:20:30] SOL $80.77✓  BTC $61579.57✓  ETH $1721.38✓
```

## Config reference

See `.env.example`. Key vars: `RPC_URL`, `KEEPER_SECRET_KEY`, optional
`PROGRAM_ID`, and `SLAB`/`FEED_ID` to run a single market instead of all three.

## Local dev

Unchanged — with no `KEEPER_SECRET_KEY` set it falls back to
`~/.config/solana/mukon-deployer.json`:

```bash
npm run keeper
```
