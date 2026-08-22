# Roadmap

What I plan to do with this fork, and how I will know each step is done.

Ritual Chain is unreachable while I work on this (`rpc.ritualfoundation.org` times out,
probed 2026-08-22), so everything below runs against a local Hardhat node. Where a claim
cannot be verified locally, I say so rather than implying otherwise.

## 0. Fork and environment

- Real fork via the GitHub API, name and visibility unchanged.
- `upstream` remote wired to `cozfuttu/ritual-chain-workshop-2`.
- Node 24, pnpm 11.

## 1. Baseline and audit

- Record `compile` and `test` output on untouched upstream code.
- Read the contract end to end; write `AUDIT.md` as a numbered register, each entry
  marked **fixed** or **deferred**, with a reason either way.
- Open entries so far:
  - `_payout` returns 0 to everyone when the winning pool is empty, and `Resolved` also
    blocks `claimRefund` — funds would be stranded. The `Invalid` docstring implies
    `onScheduledResolve` is meant to prevent this. Verify by test.
  - Integer division in `_payout` strands dust nobody can claim.
  - `hardhat.config.ts` reads `DEPLOYER_PRIVATE_KEY`; `.env.example` and the script
    docstrings say `RITUAL_PRIVATE_KEY`.

## 2. Implement the five unwritten functions

One commit each, in dependency order:

1. `createMarket`
2. `_scheduleResolution`
3. `_pickExecutor`
4. `_readOracle`
5. `onScheduledResolve`

Constraints taken from the surrounding code: `onScheduledResolve` must not revert on
anything but an authorisation failure, or a failed attempt would roll back the counter and
the market could never reach `Invalid`; `executionIndex` must stay the first parameter
because the Scheduler writes it into calldata bytes 4-35; `_readOracle` must treat an
unsettled async envelope as a retryable miss, not a failure.

**Done when:** compiles clean, smoke test per function.

## 3. Local harness

Precompiles do not exist on a Hardhat node, and the constructor calls `approveScheduler`,
so nothing deploys without one. Rather than hand-write happy-path stubs, I fetch a real
oracle response once, store it as a fixture, and have the harness replay genuine HTTP
envelopes — including not-yet-settled output, error statuses, and bodies that break jq.

Injected with `hardhat_setCode` at the Scheduler, RitualWallet, TEE registry, `0x0801`
and `0x0803`.

**Done when:** deploy succeeds and one market completes a full lifecycle locally.

## 4. Integration tests

TypeScript, viem, `node:test` — driven the way a client would drive it.

- resolution to YES and to NO, all four comparators
- one-sided market (nobody on the winning side)
- oracle down: retry, retry, `Invalid`, refund
- betting after `closeBlock`; claiming before resolution; double claim
- `stakesOf` in every state
- pari-mutuel maths with several bettors
- `fundExecution` and execution balance

**Done when:** green, with coverage measured and quoted in the README.

## 5. Extensions

Each with its own tests and an entry in `EXTENSIONS.md`.

| # | Extension | Note |
|---|---|---|
| E1 | Oracle quorum — N sources, median or agreement, otherwise `Invalid` | deepest use of the HTTP precompile |
| E2 | Fee to creator or treasury, plus dust sweep | touches pari-mutuel maths; rounding tests mandatory |
| E3 | Dispute window — bonded challenger forces a re-read | new state, second Scheduler booking |
| E4 | Positions as ERC-721 | rewrites existing accounting; done last, after E1-E3 are green |

## 6. Frontend

`web/`, Next.js with wagmi and viem. Market list with the state machine visible
(Open → Closed → Resolving → Resolved/Invalid), market creation with its resolution rule,
betting, claim and refund, execution balance, block countdowns.

## 7. Demo mode

The data source is behind an interface: `chain` via wagmi, or `demo` from fixtures with a
scrubbable market timeline. Demo mode is labelled in the UI — it never presents itself as
real transactions. Deployed so the app can be looked at without running anything.

## 8. CI, README, recording

- Workflow: compile, tests, frontend build, end-to-end lifecycle against a real node.
- README rewritten for a reviewer: demo link, a recording of a local run, extension table,
  coverage, and a plain statement of what the chain outage means for these results.

## 9. Deployment, if the chain comes back

Probe again. If Ritual answers: deploy, verify the source on the explorer, point the demo
at the real RPC, put the address and transaction hash in the README. If it does not: say
so, and let the demo stand in.
