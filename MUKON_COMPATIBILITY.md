# Mukon overlay on true upstream history

Status: local compatibility package only. Nothing in this document authorizes a transaction,
program upgrade, keeper change, deployment, commit or push.

## Why this is a behavioral port, not a Git cherry-pick

`Mukon-Labs/percolator-cli` and `aeyakovenko/percolator-cli` have different root commits and no
merge base. Toly's current head (`7f90047`) also targets a materially newer wrapper/engine layout
than Mukon's deployed wrapper (`a868895`): market and portfolio lengths, matcher configuration,
crank wire shape and several accounting fields differ. Copying current upstream parsers, constants,
deployment manifests or complete operational scripts would therefore make the CLI compile while
silently reading or writing the wrong ABI.

The safe strategy is to port only operations whose exact tag and wire layout are present in the
byte-verified deployed wrapper, then build transaction planners against Mukon's current account
layout and health auditor.

## Compatibility ledger

| Capability | Deployed wrapper support | Local CLI state | Release decision |
|---|---|---|---|
| Hybrid/composite oracle configuration | Tag 34; one to three Pyth Receiver, Switchboard On-Demand or Chainlink Store legs; multiply/divide composition | Exact encoder, feed-shape validation, provider-owner/discriminator classifier and feed-binding helper in `src/mukon/deployed-v16.ts` | Compatible foundation. Add a read-only account preflight and simulation-only planner before any signer path. |
| Permissionless stale-market resolution policy | Admin tag 38 plus permissionless tag 39 | Exact encoders implemented | Compatible foundation. Do not configure live values until limits and customer wind-down policy are reviewed. |
| Permissionless market/asset listing | Admin tag 59 sets the minimum listing fee; tag 40 activation accepts authority or permissionless fee-paying paths | Exact fee/lifecycle encoders implemented | Compatible foundation. A product factory still needs isolated custody/risk policy, oracle admission, liquidity bootstrap, caps and deterministic wind-down. |
| Asset drain/recovery/retirement | Tag 40 activate/drain-only/retire/shutdown actions, tag 64 paired force-close after recovery delay, tag 69 empty-asset oracle restart | Exact action-code encoders and action-specific input validation implemented | Compatible foundation. Build state-aware planners; never replay Toly's deployment-specific scripts or targets. |
| Re-anchor after extreme drift | Tag 34 re-applies a validated hybrid oracle and atomically resets only an empty, eligible asset anchor; tag 69 restarts an empty asset in Recovery | Wire support implemented | Not a generic clock reset. The program's positive-PnL, OI, lifecycle, authority and lock gates remain authoritative. |
| Current upstream parsers/layout constants | Newer 448-byte wrapper config, 726-byte group header, different portfolio tail and dynamic sizing | Deliberately excluded | Incompatible with current deployed account layout; requires a coordinated program migration. |
| Current upstream crank and matcher flow | Newer permissionless crank and matcher configuration semantics | Deliberately excluded | Keep Mukon's v30 keeper and ABI-v3 matcher until a coordinated migration is designed. |
| Historical v12→v16 recovery/migration scripts | Deployment-specific | Deliberately excluded | Redundant and unsafe for current Mukon state. |

## Safety boundary for the next work package

1. Read the market, target asset and every oracle account at one confirmed context.
2. Verify program owner, market identity/generation, dynamic account length and the expected signer
   role before constructing an instruction.
3. For hybrid oracles, verify each provider owner and discriminator. Pyth binds to its canonical
   feed ID; Switchboard and Chainlink bind to the oracle account public key.
4. Default every operational command to plan-only. Simulation must be separately requested and
   sending must require a fresh transaction summary and explicit approval.
5. Re-run the independent custody/equity/OI/clock audit before and after every simulated transition.
6. Never combine lifecycle, oracle, wind-down and custody withdrawals into an unreviewed one-shot
   executor.

## Source provenance

- Upstream reference inspected: `aeyakovenko/percolator-cli` `7f9004768e5f6cbc4fb8c08fc1e5a8751669d990`.
- Deployed-wrapper ABI authority: `percolator-prog` `a8688958fbbf5ac95185e5073207416311415f08`.
- Hosted keeper remains v30/source `f5a47d30d316215367d42f6210b53ca6e9ad3511` and is outside this package.
