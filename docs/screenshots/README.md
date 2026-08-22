# Screenshots

Produced by `web/scripts/screenshots.ts`, not assembled by hand. The script drives
the chain and the browser together and photographs the same market at seven points
of its life.

| File | What it is |
|---|---|
| `01-open.png` | The page as it loads, wallet connected, one market taking bets |
| `02-bets.png` | After a YES bet placed through the page and a NO bet from another account |
| `03-side-rail.png` | Execution balance, the position token, and the form that creates a market |
| `04-closed.png` | Past the close block: betting shut, waiting to be woken |
| `05-challengeable.png` | Read, settled, and inside its challenge window |
| `06-settled.png` | Window closed, winnings claimable |
| `07-claimed.png` | Claimed, with the creator's cut still outstanding |

## What these are and are not

**Not a real chain.** Ritual Chain was unreachable throughout — `rpc.ritualfoundation.org`
times out. Everything here is a local `hardhat node` with the stand-ins from
`hardhat/contracts/testing/` installed at the canonical precompile and system-contract
addresses.

**The oracle answers are real.** The numbers on screen are the responses recorded in
`hardhat/fixtures/oracle-responses.json`, from live endpoints, narrowed by the real jq
binary. `244082` is what CoinGecko actually said, scaled to cents and floored by jq.

**No wallet extension is involved.** A headless browser has none, so the page is given
a small EIP-1193 shim that forwards every call to the node. A `hardhat node` keeps its
accounts unlocked and signs on its own — the script holds no key.

**The Scheduler wake-up is simulated by an explicit call.** On a real chain the
Scheduler fires the booked execution itself; here the script calls `fire()` on the
stand-in at the block the booking named. Everything downstream of that call is the real
contract doing its own work.

## Reproducing them

```bash
cd hardhat && npx hardhat node
cd hardhat && npx hardhat run scripts/setup-local-chain.ts --network localhost
cd web && printf 'NEXT_PUBLIC_PREDICT_ADDRESS=0x…\n' > .env.local
cd web && pnpm build && pnpm start -p 3111
cd web && pnpm exec playwright install chromium && pnpm screenshots 0x…
```

Use `pnpm start`, not `pnpm dev`. Next 16's dev server answers the page but returns
403 for its own JavaScript chunks to a headless browser, so the app never hydrates and
every screenshot is of an empty shell.
