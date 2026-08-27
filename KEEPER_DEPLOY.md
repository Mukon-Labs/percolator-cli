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

## 2. Prepare the server-only credentials

The keeper reads Pyth through authenticated Hermes. Create the API credential
in Pyth Terminal and enter it only as the `PYTH_API_KEY` runtime secret. The
default endpoint is the authenticated Core service at
`https://hermes.pyth.network`; an alternative credential-free HTTPS provider
URL may be supplied with the non-secret `PYTH_HERMES_URL` setting. Do not select
the upgraded endpoint until the configured credential passes a redacted
entitlement preflight.

Never expose `PYTH_API_KEY` through `NEXT_PUBLIC_*`, logs, source, or a command
that records shell history. Local development uses an ignored `.env` file.

Fly has no local keypair file, so the existing oracle-authority signer is stored
as the `KEEPER_SECRET_KEY` runtime secret. It is a Solana signer, not a Helius
credential. Prepare and enter it locally; never paste it into chat or source.

> Devnet test key = fine to host. For **mainnet**, mint a dedicated key whose
> only role is oracle authority (`set-oracle-authority`), so a host compromise
> can't touch LP capital or the upgrade authority.

## 3. Continuous existing-machine promotion or emergency resume

This runbook assumes the named Fly app and its keeper machine already exist.
It does not authorize creating an app or machine, scaling, cloning, or high
availability. Before any authorized action, verify the intended singleton:

```bash
cd /path/to/Mukon-Perps/percolator-cli

# Read-only: expect zero local keeper processes.
pgrep -fal '[o]racle-keeper-v16|[p]npm.*[[:space:]]keeper([[:space:]]|$)' || true

# Read-only: expect exactly one hosted keeper machine. It must be started for a
# normal promotion; stopped is valid only for a separately authorized resume.
fly machine list -a ninja-oracle-keeper

# Read-only names-only check; never paste or inspect secret values.
fly secrets list -a ninja-oracle-keeper
```

After code review and a fresh secret-change authorization, the operator enters
the three values through Fly's server-side secret manager. Use the dashboard or
an approved non-echoing/staged input flow; never put literal values in a shell
command, source, logs or chat. Re-run the names-only `fly secrets list` check
afterward. This is a mutation, not part of this read-only runbook check. Do not
use `fly scale count` as singleton verification.

Normal code promotion uses only the protected GitHub workflow documented in
`FLY_RELEASE.md`. It requires the singleton to be **started**, builds and pins
the candidate while the old process remains live, rechecks the exact old
source/image immediately before promotion, updates only that Machine, and
requires a release-specific confirmed oracle push plus an operational audit.
The dispatch must also pre-authorize one exact-image rollback; a failed
candidate either proves the old image was never displaced or restores it and
proves a fresh write.

Do not stage a normal keeper release on a stopped Machine. A stopped keeper
freezes the market clock while cluster slots continue, turning the outage into
future bounded-recovery debt.

`fly machine start <id> -a ninja-oracle-keeper` is an emergency resume-only
operation. It is valid only after a separate authorization and a fresh
singleton, source/image, signer-role, RPC-circuit and market-health preflight.
It is not part of the release workflow.

Neither path may create a new Machine or HA replica. Program/config/secret
changes remain separate work packages; the continuous workflow promotes only
the reviewed image and non-secret release metadata.

## 4. Verify

The protected workflow performs the hosted postcheck. For a separately
authorized read-only inspection, bounded Machine-specific logs should show the
release marker followed by normal ticks:

```
NINJA_KEEPER_HEALTH {"event":"confirmed-push",...}
[12:20:30] SOL $80.77  BTC $61579  ETH $1721 push+crank ✓ ...
```

Fly restarts the machine if the process exits. The keeper owns bounded retry,
confirmation timeout/cancellation, and rate-limit circuit behavior.
At startup, every five minutes, and after a crank rejection, it also reports
token custody, the separately accounted market vault, aggregate capital,
insurance, matcher-LP capital/PnL, conservative risk equity, and its current
margin certificate. `LP HEALTH CRITICAL` identifies depleted matcher capital or
maintenance failure; it does not perform or recommend an automatic top-up.
The same snapshot is available without a signer or keeper process:

```bash
npm run check:v16-health
```

That command is read-only, uses `RPC_URL`, and exits with status 2 for a
critical/invalid snapshot.
Direct Hermes HTTP responses can expose `Retry-After`; web3 RPC errors often do
not retain response headers, so those failures use the bounded exponential
fallback. When a header is available, it is honored up to a 15-minute maximum;
after that the keeper performs a bounded probe rather than sleeping forever.

## Config reference

See `.env.example`. `RPC_URL` must be a dedicated keeper endpoint,
`KEEPER_SECRET_KEY` must be the existing oracle-authority signer (not LP,
upgrade, browser, or mint-authority material), and `PYTH_API_KEY` must remain a
server-only Pyth credential. All three are required. Optional
`PROGRAM_ID`, `MARKET`, and `LP_PORTFOLIO` overrides must match the intended
v16 deployment. `PYTH_HERMES_URL` selects an alternative credential-free HTTPS
Hermes provider without putting credentials in the URL. Do not select the
upgraded endpoint until the configured credential passes a redacted entitlement
preflight. `LP_MIN_CAPITAL_USDC` controls the warning floor only and defaults to
10,000 test USDC. `MARKET_MAX_CLOCK_LAG_SLOTS` defaults to 300 and gates the
existing bounded legless-buffer recovery: catch-up continues while loss-stale
is active or an active/drain-only asset exceeds that limit, then the keeper
caches the settled state and stops the extra status read/recovery work.
`AUDIT_PROFILE=recovery` keeps the exact incident-recovery snapshot gate.
Continuous releases set `AUDIT_PROFILE=operational` and require explicit
positive `LP_MIN_RISK_EQUITY_USDC` and `MIN_DOMAIN_INSURANCE_USDC` floors; see
`FLY_RELEASE.md`. `NINJA_RELEASE_SOURCE` and `NINJA_RELEASE_ID` are non-secret
image build metadata set by the protected workflow. Operators must not
override them in runtime secret stores.

## Local dev

Local development also requires explicit `RPC_URL`, `KEEPER_SECRET_KEY`, and
`PYTH_API_KEY`; there is no Solana CLI-identity fallback:

```bash
npm run keeper
```

## When to revisit self-hosted RPC

Not now. Solana's **RPC 2.0** (Triton One + Foundation, open-source AGPL) makes the
*read* layer cheap (~$400/mo-class), but you still need a Geyser validator to feed
it, and the keeper is *write*-heavy (tx submission, which RPC 2.0 doesn't replace).
On consumer hardware it's not viable. Evaluate at mainnet scale with real volume;
until then a managed RPC (Helius/Triton) is the right call.
