# Audit of the fork point

Everything below was checked against `6e93b08` on Node 24.18 / pnpm 11.22, Hardhat 3.13,
solc 0.8.28. Each entry is **fixed**, **scheduled**, or **noted** — nothing is left as a
vague concern.

## Baseline

| Command | Result |
|---|---|
| `pnpm install` | 152 packages, clean (esbuild's build script is skipped by pnpm; nothing downstream needs it) |
| `npx hardhat compile` | passes — 2 Solidity files |
| `npx hardhat test` | **fails** — see F1 |

## Register

### F1 — `hardhat test` fails on a clean checkout · **fixed**

`test/Counter.ts` deploys a contract named `Counter`. No such contract exists; `contracts/`
holds only `RitualPredict.sol` and `ritual/RitualChain.sol`. Both cases fail with
`HHE1000: Artifact for contract "Counter" not found`.

Removed. The real suite arrives in step 4 of the roadmap.

### F2 — `.env` is never loaded · **fixed**

`.env.example` opens with *"Copy to hardhat/.env — loaded automatically by
hardhat.config.ts"*. Nothing in the config loads it: no `dotenv`, no keystore plugin.
Verified empirically — `hardhat run … --network ritual` produces the identical
`HHE7: Configuration Variable not found` with and without the file present.

Fixed with Node's own `process.loadEnvFile()`, no new dependency. A missing file is
tolerated so CI can pass the same names as ambient environment variables.

### F3 — the deployer key has two different names · **fixed**

`hardhat.config.ts` read `configVariable("DEPLOYER_PRIVATE_KEY")`. `.env.example` and the
docstrings in `scripts/deploy.ts`, `fund.ts` and `status.ts` all say `RITUAL_PRIVATE_KEY`.
Following the documented setup therefore could not work.

Aligned the config to the documented name — one place to change against four.

### F4 — `RITUAL_RPC_URL` is documented but ignored · **fixed**

`.env.example` offers it under "Optional overrides"; the config hardcoded the URL. Now read
from the environment with the same value as the fallback.

### F5 — five unimplemented function bodies · **scheduled (step 2)**

`createMarket`, `onScheduledResolve`, `_readOracle`, `_pickExecutor` and
`_scheduleResolution` are `// we'll fill this up`. This is the workshop, not a defect. The
root README documents the intended behaviour precisely enough to serve as the spec, down to
`numCalls = 3`, `frequency = 200`, cancelling the remainder on success, re-rolling the
executor seed per attempt, and an idempotent callback.

### F6 — an empty winning pool would strand every stake · **scheduled (step 4 test)**

`_payout` returns 0 to everyone when `winningPool == 0`. `claimWinnings` then reverts
`NothingToClaim`, and `claimRefund` reverts `NotInvalid` because the state is `Resolved`.
Nothing in the compiled code prevents this.

It is not an upstream bug: the README says *"Empty winning side → refundable"* and the
`MarketState.Invalid` docstring says *"(or nobody won)"*. So it is a requirement on
`onScheduledResolve` — record the outcome and observed value, then invalidate. Worth an
explicit test rather than trust, because the requirement lives only in prose.

### F7 — the README's dust claim is unmeasured · **noted (measure in step 4)**

*"Integer division leaves sub-wei dust in the contract; that is deliberate and negligible."*
Plausible per claimant, but the aggregate over many claimants is never stated. Measuring it
is cheap once the suite exists, so it will be measured and reported rather than repeated.

### F8 — `receive()` accepts ether nobody can recover · **noted**

`receive() external payable {}` credits no pool, so a plain transfer to the contract is
stuck forever. The comment expects Scheduler gas refunds to land in RitualWallet instead, so
in normal operation this is never hit. Adding a rescue path is a design change, not a fix;
recorded rather than done.

### F9 — nothing deploys on a bare Hardhat node · **scheduled (step 3)**

The constructor calls `IScheduler(SCHEDULER).approveScheduler(SCHEDULER)`. On a local node
that address holds no code, so the call reverts and deployment fails before any test can
run. This is the reason step 3 exists.

### F10 — `approveScheduler(SCHEDULER)` is correct · **noted, no action**

It looks redundant at first read — the Scheduler authorising itself. The interface comment
resolves it: the call is made *on* the Scheduler, and the argument is the address being
authorised to call back into the caller and draw its fees. The Scheduler is exactly that
address. Left alone deliberately, not overlooked.
