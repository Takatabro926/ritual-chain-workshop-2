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

### F7 — the README's dust claim, now measured · **verified, no change**

*"Integer division leaves sub-wei dust in the contract; that is deliberate and negligible."*
Plausible per claimant, but the aggregate over many claimants was never stated, so it was
measured instead of repeated.

`_payout` truncates once per claimant, so the pool can lose at most one wei per winner, and
the aggregate is bounded by the number of winners rather than by the size of the pool. A
market with a 4 ETH pool and two winners on a 3 ETH winning side leaves **1 wei** behind
after both claims. The claim is accurate; the bound is now asserted in `test/payouts.ts`
rather than assumed.

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

## Found while building the harness

### F11 — jq arithmetic is IEEE-754, and the market target sits on that boundary · **noted**

The recorded CoinGecko body is `{"ethereum":{"usd":2428.18}}`. Real jq 1.8.2 evaluates
`.ethereum.usd * 100 | floor` to **242817**, not 242818, because 2428.18 is not exactly
representable and the product lands just below the integer.

This matters because a market compares one integer against a fixed target. A market whose
target is exactly the observed cent resolves the other way from what a reader would predict
from the quoted price. No change is proposed — the behaviour belongs to jq and to floating
point, not to this contract — but it is the reason the harness replays recorded jq output
instead of imitating jq: a hand-written stand-in would have answered 242818 and the
discrepancy would never have surfaced.

### F12 — the bundled viem skill documents an API the installed plugin does not have · **fixed**

`.claude/skills/hardhat-toolbox-viem/SKILL.md` (and its `.agents` twin) show
`balancesHaveChanged` taking an address-keyed object:

```ts
await viem.assertions.balancesHaveChanged(game.write.claim(), { [winner]: PRIZE });
```

The installed `@nomicfoundation/hardhat-viem-assertions@3.1.2` takes
`Array<{ address, amount }>` and fails with `changes.map is not a function` on the
documented form. Both copies of the skill now show the array.

### F13 — a fresh install ends with an unresolved placeholder file · **fixed**

`pnpm install` on pnpm 11 skips esbuild's build script, exits with
`ERR_PNPM_IGNORED_BUILDS`, and writes `hardhat/pnpm-workspace.yaml` containing the literal
text `esbuild: set this to true or false`. A clean checkout therefore gains an untracked,
unfinished file on first install.

esbuild's script only fetches its native binary, and nothing in the compile, test or
coverage path reaches it, so the file now answers the question with `false` and is
committed. Verified by deleting node_modules and installing again: no warning, and the
suite still passes.

## Coverage

`npx hardhat test nodejs --coverage` — 50 tests, **100.00% line and statement coverage on
`contracts/RitualPredict.sol`**. Every branch listed as uncovered at 97% turned out to be
reachable, so the gap was closed with tests rather than explained away.
