# web

The frontend. Next.js, wagmi and viem, talking to a deployed `RitualPredict`.

## Running it against a local node

Ritual Chain is unreachable, so this runs against `hardhat node`. Three terminals:

```bash
cd hardhat && npx hardhat node
cd hardhat && npx hardhat run scripts/setup-local-chain.ts --network localhost
cd web && pnpm install && pnpm dev
```

The setup script installs the stand-ins at the canonical precompile and system
contract addresses, deploys the contract, prepays its execution balance, loads the
recorded oracle fixtures, and opens one market. It prints the address — put it in
`web/.env.local` as `NEXT_PUBLIC_PREDICT_ADDRESS`.

Point your wallet at `http://127.0.0.1:8545`, chain id 31337, and import one of the
node's printed private keys.

## What the page shows

- **Every market, newest first**, with its phase as a colour, an icon and a word —
  never colour alone.
- **The rule**, exactly as it was fixed at creation: each source's url and jq
  program, how many readings are required, and the comparison. Sources already read
  are ticked.
- **The readings gathered so far**, because a market part-way through its quorum is
  a state worth seeing rather than a spinner.
- **Block countdowns** to betting close, to the Scheduler wake-up, and to the moment
  claims open after the challenge window.
- **The execution balance**, permanently. The contract pays for its own resolutions,
  and if that balance empties, markets stop settling with nothing on chain to say so.
- **Your positions** as ERC-721 tokens, with a field to hand one to someone else.
  The contract has no enumeration, so the list is rebuilt from `PositionOpened` logs.

Every action is gated by phase, so the page never offers a button the contract would
reject: no claiming inside the challenge window, no challenging a market that has not
resolved, no betting after the close block.

## Demo mode

The page has two data sources behind one interface. `chain` reads a deployed
contract through wagmi. `demo` runs the contract's rules in the browser against the
recorded oracle readings, so the app can be looked at with no node, no wallet and
no deployment.

Mode is decided once, in `src/lib/source.ts`: demo when `NEXT_PUBLIC_DEMO=1`, or
whenever no contract address is configured. A deployment with nothing to talk to is
more useful as a demo than as an error message.

The demo says what it is at the top of the page — nothing on it is a transaction and
no money is involved. What it does not invent are the numbers: every reading comes
from `src/lib/oracle-fixtures.json`, recorded from live endpoints and narrowed by
the real jq binary, the same values the contract's tests run against. A market that
settles on `244239` settles on what Kraken actually said.

Because there is no chain to wait for, the demo carries the clock. **Skip to next
event** jumps to whatever would happen on its own next — a betting window closing, a
Scheduler wake-up, a challenge window expiring — and reports what it did:

```
⟳ #1 read 244082 from source 1
⟳ #1 read 244239 from source 2
⟳ #1 settled YES on 244239
```

One source per wake-up, exactly as on chain, because a short-running async
precompile may be called once per transaction.

## Deploying it

Vercel, with **Root Directory** set to `web` — the Next app is not at the repository
root. Leave `NEXT_PUBLIC_PREDICT_ADDRESS` unset and the deployment runs in demo mode;
set it, and the same build talks to a real contract.

```bash
pnpm build && pnpm start   # what the deployment runs
```

## Design

Ritual's palette on black — green for trust, lime for data, pink for the opposing
side, gold for anything pending. Archivo for display, Barlow for body, JetBrains Mono
for every number and address. Buttons are bordered outlines rather than filled.

No Tailwind: the tokens are the design system, and `src/app/globals.css` carries them
as custom properties. Fonts are linked rather than bundled, so a build that cannot
reach Google Fonts still succeeds on the fallback stack.

## ABI

`src/lib/predict-abi.ts` is generated. After changing the contract:

```bash
cd hardhat && npx hardhat compile && node scripts/export-abi.ts
```
