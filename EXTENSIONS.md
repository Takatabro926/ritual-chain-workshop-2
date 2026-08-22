# Extensions

What this fork adds on top of the workshop contract, and what each one changes for
anyone already reading the old shape.

## E1 — Resolution by quorum

A market no longer trusts one endpoint. It carries up to five sources and a quorum:
the number of successful readings it needs before it may settle. It settles on the
**median** of the readings it gathered.

### Why it looks like this

The obvious design — read three venues inside the resolution callback and compare —
is not available. A short-running async precompile may be called **once per
transaction**, so three HTTP reads cannot share one execution.

So the market walks its sources across executions instead. Each scheduled wake-up
reads one source. A source that answers advances the cursor; a source that fails is
retried until its own attempts run out and is then abandoned, so one dead endpoint
cannot consume the whole budget. The Scheduler booking is sized for the worst case,
`sources × MAX_ATTEMPTS` executions, which for five sources is 15 × 200 blocks and
still inside the Scheduler's 10,000-block lifespan.

The market settles the moment the quorum is met, and cancels the executions it no
longer needs. If the sources run out first, it invalidates and everyone refunds —
`quorum not reached` — rather than settling on fewer readings than it promised.

### The median, and why nothing is averaged

`_median` sorts in place and returns the middle reading. With an even count it takes
the upper of the two middles. It does not average: an average produces a number no
source reported, and the market's whole claim is that it settled against something an
oracle actually returned. The test asserts that the settled value is one of the
recorded readings.

Three real venues at one moment, from `fixtures/oracle-responses.json`:
CoinGecko 244036, Coinbase 243779, Kraken 243689 cents. A spread of 347 cents between
the high and the low is exactly the reason a single endpoint is a weak resolver.

### What changed for readers

| Before | Now |
|---|---|
| `Market.oracleUrl`, `Market.jsonPath` | `Market.oracles` — an array of `{ url, jsonPath }` |
| — | `Market.quorum`, `Market.readings`, `Market.cursor`, `Market.cursorAttempts` |
| `ResolutionRuleSet(id, url, jsonPath, target, comparator)` | `ResolutionRuleSet(id, target, comparator, quorum, oracleCount)` plus one `OracleSource(id, index, url, jsonPath)` per source |
| — | `ReadingGathered(id, index, value)` as each source answers |
| `MAX_ATTEMPTS` attempts per market | `MAX_ATTEMPTS` attempts **per source** |

A market with one source and a quorum of one behaves exactly as before, which is how
the whole existing suite kept passing through this change.

## E2 — The creator's cut

A market may charge its creator a share of the pool, in basis points, fixed at
creation like every other part of the rule.

- **Bounded at 5%** (`MAX_FEE_BPS = 500`). Without a ceiling this is the one number a
  creator could set against their own bettors after they had already staked, so the
  contract refuses anything higher rather than leaving it to good manners.
- **Charged only on a market that resolves.** A market that refunds hands back whole
  stakes; there is no service to be paid for when the question was never answered.
- **Pull-based**, like winnings and refunds. `claimFee` pays the creator once, and
  anyone may trigger it — the money can only go to the creator either way.
- **Taken before the split, not after.** `_payout` divides `pool − fee` by the winning
  side, so the fee is not silently financed out of the rounding.

With `feeBps = 0` the arithmetic is identical to before, which is why the rest of the
suite was unaffected by this change.

## E3 — A challenge window

A resolved market is not final at once. For `DISPUTE_WINDOW_BLOCKS` (300) nobody can
claim, and anyone may post a bond and buy a second reading.

- **The bond is 1% of the pool**, with a 0.001 ether floor so a small market is not
  free to attack. It scales with what is actually at stake.
- **The second reading is taken from scratch** — cursor and readings reset, a fresh
  Scheduler booking, the same sources in the same order.
- **The second reading stands, whichever way it goes.** There is no third: one
  challenge per market. Claims open the moment it settles.
- **A challenger who was right takes the bond back.** A challenger who was wrong
  forfeits it into `bounty`, which is added to what the winners share — so the cost of
  a frivolous challenge is paid to the people it inconvenienced.
- **A challenge the oracles cannot answer refunds everyone** and returns the bond. The
  challenger asked a fair question; the oracles failed to answer it.

### Testing it needed a real constraint respected

A market's rule is fixed at creation, so a second reading cannot come from another
endpoint or another jq program — only from another *moment*. Serving a different
venue's body to the original venue's jq program is something real jq would reject, so
the fixtures instead hold **two snapshots of one source, recorded seconds apart**
(`kraken-clock-early`, `kraken-clock-late`). A target between them reads NO on the
first and YES on the second, which is a genuine disagreement rather than a
manufactured one.
