# Oracle Keeper — Hosting Guide (Fly.io)

The keeper pushes live Pyth prices to the SOL / BTC / ETH / ZEC v16 asset slots on devnet.
If it stops, those markets freeze (no fresh oracle → trades revert / show stale PnL).
This runs it 24/7 on Fly.io — the same platform as mukon-messengr.

## 1. Configure the keeper-only devnet RPC

Use a Helius key dedicated to this keeper. Do not reuse the browser, indexer, or
demo-fleet key: all keys share the project quota, but separation makes usage,
rotation, and rate-limit incidents attributable.

- **Helius** (recommended): https://helius.dev → create app → devnet → copy the RPC URL
  (`https://devnet.helius-rpc.com/?api-key=...`)
- **QuickNode**: https://quicknode.com → create a Solana devnet endpoint

## 2. Prepare the oracle-authority key for a secret

Fly has no local keypair file, so the existing oracle-authority signer is stored
as the `KEEPER_SECRET_KEY` runtime secret. It is a Solana signer, not a Helius
credential. Prepare and enter it locally; never paste it into chat or source.

> Devnet test key = fine to host. For **mainnet**, mint a dedicated key whose
> only role is oracle authority (`set-oracle-authority`), so a host compromise
> can't touch LP capital or the upgrade authority.

## 3. Existing-machine update or resume only

This runbook assumes the named Fly app and its keeper machine already exist.
It does not authorize creating an app or machine, scaling, cloning, or high
availability. Before any authorized action, verify the intended singleton:

```bash
cd /path/to/Mukon-Perps/percolator-cli

# Read-only: expect zero local keeper processes.
pgrep -fal '[o]racle-keeper-v16|[p]npm.*[[:space:]]keeper([[:space:]]|$)' || true

# Read-only: expect exactly one hosted keeper machine, currently stopped.
fly machine list -a ninja-oracle-keeper

# Read-only names-only check; never paste or inspect secret values.
fly secrets list -a ninja-oracle-keeper
```

After code review, the operator stages required secret values without applying
them to a machine yet:

```bash
fly secrets set --stage RPC_URL=... KEEPER_SECRET_KEY=... -a ninja-oracle-keeper
```

This is not a verification command; never put values in source or chat. Do not
use `fly scale count` as singleton verification.

After review and fresh authorization, choose one operation deliberately:

- Deploy the staged release to the verified existing machine only:
  `fly deploy -a ninja-oracle-keeper --ha=false --update-only --only-machines <verified-existing-machine-id> --strategy immediate`.
  This is not a read-only resume.
- `fly machine start <id> -a ninja-oracle-keeper` is resume-only and is valid
  only when the current staged/applied secret names already apply to that
  verified stopped machine.

Neither operation may create a new machine or HA replica. Re-run the checks
above after an authorized operation.

## 4. Verify

```bash
fly logs
```

should show ticks like:

```
[12:20:30] SOL $80.77✓  BTC $61579.57✓  ETH $1721.38✓  ZEC $…✓
```

Fly restarts the machine if the process exits. The keeper owns bounded retry,
confirmation timeout/cancellation, and rate-limit circuit behavior.
Direct Hermes HTTP responses can expose `Retry-After`; web3 RPC errors often do
not retain response headers, so those failures use the bounded exponential
fallback. When a header is available, it is honored up to a 15-minute maximum;
after that the keeper performs a bounded probe rather than sleeping forever.

## Config reference

See `.env.example`. `RPC_URL` must be a dedicated keeper endpoint and
`KEEPER_SECRET_KEY` must be the existing oracle-authority signer (not LP,
upgrade, browser, or mint-authority material). Both are required. Optional
`PROGRAM_ID`, `MARKET`, and `LP_PORTFOLIO` overrides must match the intended
v16 deployment.

## Local dev

Local development also requires explicit `RPC_URL` and `KEEPER_SECRET_KEY`;
there is no Solana CLI-identity fallback:

```bash
npm run keeper
```

## When to revisit self-hosted RPC

Not now. Solana's **RPC 2.0** (Triton One + Foundation, open-source AGPL) makes the
*read* layer cheap (~$400/mo-class), but you still need a Geyser validator to feed
it, and the keeper is *write*-heavy (tx submission, which RPC 2.0 doesn't replace).
On consumer hardware it's not viable. Evaluate at mainnet scale with real volume;
until then a managed RPC (Helius/Triton) is the right call.
