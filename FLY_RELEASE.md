# Oracle keeper release

The keeper is released only through the manually dispatched
`Deploy oracle keeper (manual)` GitHub Actions workflow. Pushes and pull
requests never deploy it.

Before enabling the workflow:

1. Create a GitHub environment named `production` and require a reviewer.
2. Add an app-scoped Fly deploy token as the environment secret
   `FLY_API_TOKEN`. Never add the value to this repository.
3. Confirm Fly contains exactly one intended `ninja-oracle-keeper` machine and
   copy that machine's ID without changing its state.

To release, dispatch the workflow, select `ninja-oracle-keeper`, enter the
existing machine ID, and type `DEPLOY`. The job runs the keeper tests, fetches
live Fly status, rejects zero or multiple machines, rejects an ID mismatch, and
then uses an immediate update restricted to that existing machine.

The workflow does not create, clone, scale, start, or stop machines. Secret
configuration, restarts, rollback, and post-release health checks remain
separate explicitly authorized operations.
