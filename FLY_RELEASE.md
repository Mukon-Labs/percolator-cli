# Oracle keeper continuous release

The keeper is promoted only through the manually dispatched
`Promote oracle keeper (continuous singleton)` workflow. Pushes and pull
requests never deploy it.

## Boundary

This is a single-Machine continuity flow, not high availability. It removes the
human/offline gap from planned image releases. It does not create a standby and
does not make two writers safe. True host-failure failover still requires the
on-chain lease/fencing design in the private root `KEEPER_HA.md`.

## One-time GitHub setup

1. Keep the protected `production` environment and required reviewer.
2. Keep the app-scoped Fly token only as environment secret `FLY_API_TOKEN`.
3. Do not add oracle, RPC or Pyth runtime values to GitHub Actions.

## Dispatch inputs

From a reviewed exact commit, enter:

- app `ninja-oracle-keeper`;
- the existing running singleton Machine ID;
- its full recorded source revision and `sha256:` image digest;
- the next `vN` release label;
- reviewed positive USDC floors for LP conservative risk equity and aggregate
  domain insurance;
- `DEPLOY`; and
- `ROLLBACK`, authorizing at most one restoration of the captured old image if
  the candidate cannot prove readiness.

The environment reviewer must compare those values with the private release
checkpoint before approval. The operational floors are explicit policy inputs,
not secret values and not automatically derived from the current account.

## Audit profiles

The default `recovery` profile retains the exact recovered-snapshot gate:
`$100,000` conservative/certified LP equity, exactly `$100,000` domain
insurance and full source-credit rates. It is used for incident recovery and
pristine-state verification.

Continuous releases use `AUDIT_PROFILE=operational`. That profile keeps all
identity, custody/accounting, maintenance, lock, OI/A/residue, backing,
authority and live-clock checks. It requires the two reviewed positive floors
above. Legitimate fee/PnL movement and a source-credit haircut become explicit
warnings rather than pretending a trading market remains at its genesis
snapshot. A credit rate above one remains invalid, and stale backing or a
breached financial floor remains release-blocking.

## Workflow contract

1. Reject a stopped, missing, duplicate, wrong-source or wrong-image Machine.
2. Run all local checks and push a digest-pinned candidate while the old keeper
   remains live.
3. Re-read the old Machine immediately before mutation.
4. Run the operational audit inside that exact Machine and reject unhealthy
   custody, risk equity, insurance, OI/A, authority or clock state.
5. Update only that exact Machine. There is no stopped-image staging, clone or
   scale operation.
6. Require the Machine to return to `started` on the candidate source/digest.
7. Require a fresh log marker bound to the candidate source, workflow run and
   Machine after the promotion cutoff, then rerun the operational audit.
8. If the candidate fails, avoid mutation when the old image is still running;
   otherwise perform exactly one captured-image rollback and prove a new
   push+crank plus healthy operational audit before failing the workflow.

The workflow failing after a successful rollback is intentional: the old
service is restored, but the candidate is not approved.

## Bootstrap note

The currently deployed v30 image predates the operational audit profile. The
first release containing this workflow must therefore use the same reviewed
build-while-live, digest-pinned exact-Machine promotion procedure manually,
without stopping v30. After that one bootstrap, the protected workflow can run
its pre-promotion operational audit inside the deployed image for every later
release. The bootstrap still requires its own deployment authorization.

## Not covered

- changing Fly secrets, resource configuration or scale;
- starting an already-stopped keeper;
- changing keeper/program signer authority;
- deploying a v16 program upgrade; or
- automatic active/passive failover.

Each requires its own reviewed package and fresh authorization.
