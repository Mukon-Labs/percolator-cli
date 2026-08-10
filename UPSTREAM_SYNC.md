# Upstream compatibility policy

This workspace follows Toly's engine and wrapper program without treating the unrelated operational
CLI history as mergeable product source. The product boundary remains the curated-majors policy in
the workspace `KANBAN.md`, especially **Fork-derived reliability roadmap**: no permissionless market
launcher, no arbitrary-asset oracle onboarding, and exactly one transaction-writing keeper.

## Audited baseline — 2026-08-10

| Component | Audited upstream | Mukon decision |
|---|---:|---|
| Engine (`percolator`) | `143e68c` | Fully contained by Mukon's `d7d622e` engine pin. Mukon is upstream plus the bankruptcy-lock and ADL-partition fixes; it is not behind upstream master. |
| Wrapper program (`percolator-prog`) | `36fa587` | Selective port. Import `c8cf4de`'s collected-fee/EWMA fix. Treat `567c76c` as adapted because Mukon already binds private orders to market/portfolio incarnation IDs without enlarging live portfolio accounts. |
| Operational CLI (`percolator-cli`) | `7f90047` | Selective review only. The histories are disconnected and the upstream CLI contains Toly's deployment addresses, recovery operations and environment choices. Never merge it wholesale into Mukon's generic CLI/keeper. |

The exact SHAs and decisions live in `upstream-sync.json`. Two unmerged engine integration branches
are watched there because they contain potentially useful recovery/liveness work. A watched branch
moving is a review signal, not permission to deploy or import an unmerged patch.

## Open engine work is a separate upgrade package

The watched `pr135-engine-integration` branch is not a small missed master fix: it is 29 non-merge
commits beyond upstream master and changes recovery-required auto-crank, ADL residue resets,
source-lien unwind/retirement and risk-reducing trade semantics. Its diff against Mukon's engine is
roughly 4,700 inserted and 500 removed lines across the engine, proofs and fuzz/spec tests. The
stacked flat-residual work is still an open pull request whose base is that integration branch, not
master. These may be important, but adopting them requires a dedicated engine+program compatibility
package, full engine/proof coverage and live-state migration analysis; they are not safe wrapper
cherry-picks.

The ref checker watches the assembled candidates. Also review the live upstream PR queue periodically,
because a brand-new branch cannot be known by a pinned manifest:

```sh
gh pr list --repo aeyakovenko/percolator --state open --limit 100 \
  --json number,title,headRefName,baseRefName,updatedAt,url
```

## Why the portfolio-ID commit is not cherry-picked

Upstream `567c76c` adds an eight-byte ID to every portfolio account. Existing Mukon accounts were
created with the old length, so a direct port changes the account-size contract and needs a deliberate
reallocation/migration design. Mukon already stores a portfolio incarnation ID in the existing
matcher-config tail, allocates it for authorized orders, and rejects authorizations after portfolio or
market recreation. That preserves the security property needed by the current private-order system
without making old accounts unreadable.

If a future feature needs an ID on every portfolio—not only portfolios using committed orders—design
an explicit legacy-zero/lazy-allocation migration and test it against live-sized account fixtures.

## Routine upstream check

First refresh the read-only upstream refs in each repository:

```sh
git -C ../percolator fetch upstream --prune
git -C ../percolator-prog fetch upstream --prune
git fetch upstream --prune
```

Then, from `percolator-cli`, run:

```sh
node scripts/check-upstream-drift.mjs
```

Exit status `0` means every locally fetched ref is at its audited SHA and the engine containment
invariant still holds. Status `2` means a main or watched ref moved and prints the unseen commits.
Status `3` means the declared compatibility ancestry is broken. The checker intentionally never
fetches, edits files, starts a keeper, contacts Solana RPC, or changes external state.

For every new upstream delta:

1. Classify each commit as `port`, `adapted-not-cherry-picked`, `not-applicable`, or `blocked`.
2. Review engine, account-layout, instruction-layout, signer and client-codec effects together.
3. Port only the smallest compatible patch and keep upstream commit attribution in the commit body.
4. Run host tests, build SBF, run focused BPF regressions, and run the Solana program security review.
5. Update `upstream-sync.json` only after the review is complete; then commit the code, tests, manifest
   and this ledger together on a short-lived, clearly named integration branch (for example,
   `sync/toly-v16-YYYYMMDD`). Merge and delete that branch before unrelated work resumes.
6. Treat deployment, authority changes, migrations and keeper starts as fresh operational gates.

Never manufacture common ancestry between the two CLI histories, force-push a shared branch, copy
upstream deployment addresses into Mukon configuration, or infer deployment approval from a code sync.
