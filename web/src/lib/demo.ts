/**
 * Demo mode: the app with the chain taken out.
 *
 * This is a reimplementation of the contract's rules in TypeScript, not the
 * contract. It exists so the page can be looked at without a node, a wallet or a
 * deployment, and it says so on screen — nothing here is a transaction and no
 * money is involved.
 *
 * What it does not invent are the readings. Every number a market settles on
 * comes from src/lib/oracle-fixtures.json, recorded from live endpoints and
 * narrowed by the real jq binary. See hardhat/scripts/record-oracle-fixtures.ts.
 */
import fixtures from "./oracle-fixtures.json";
import { MarketState, Outcome, type Market } from "./market";

export const DEMO_ACCOUNT = "0xD3m0000000000000000000000000000000000001" as const;
export const DEMO_CREATOR = "0xC12a000000000000000000000000000000000002" as const;
const OTHER = "0x0the100000000000000000000000000000000003" as const;

/** The contract's own constants, restated so the demo cannot drift from them. */
export const MAX_ATTEMPTS = 3;
export const DISPUTE_WINDOW_BLOCKS = 300n;
const DISPUTE_BOND_BPS = 100n;
const MIN_DISPUTE_BOND = 1_000_000_000_000_000n; // 0.001
const ETH = 1_000_000_000_000_000_000n;

export const RECORDED = fixtures.records;
const reading = (name: string) => {
  const record = RECORDED.find((r) => r.name === name);
  if (!record) throw new Error(`no recorded reading named ${name}`);
  return record;
};

const coingecko = reading("coingecko-eth-usd");
const kraken = reading("kraken-eth-usd");
const coinbase = reading("coinbase-eth-usd");

/**
 * The same market, with its arrays mutable. `Market` is what the contract hands
 * back and is readonly on purpose; the demo owns its state and edits it, and a
 * DemoMarket is still assignable everywhere a Market is expected.
 */
export type DemoMarket = Omit<Market, "readings" | "oracles"> & {
  readings: bigint[];
  oracles: { url: string; jsonPath: string }[];
};

export type DemoPosition = {
  tokenId: bigint;
  marketId: bigint;
  isYes: boolean;
  amount: bigint;
  owner: string;
};

export type DemoState = {
  blockNumber: bigint;
  blockTimeMs: bigint;
  executionBalance: bigint;
  markets: DemoMarket[];
  positions: DemoPosition[];
  settled: Record<string, boolean>;
  nextTokenId: bigint;
  /** What the last advance actually did, so the UI can narrate it. */
  log: string[];
};

const START = 1_000_000n;

function source(record: (typeof RECORDED)[number]) {
  return { url: record.url, jsonPath: record.query };
}

function blankMarket(partial: Partial<DemoMarket> & { id: bigint }): DemoMarket {
  return {
    creator: DEMO_CREATOR,
    question: "",
    oracles: [],
    quorum: 1,
    target: 0n,
    comparator: 1,
    feeBps: 0,
    feeClaimed: false,
    closeBlock: 0n,
    resolveBlock: 0n,
    scheduleId: 1n,
    totalYes: 0n,
    totalNo: 0n,
    state: MarketState.Open,
    outcome: Outcome.Unresolved,
    attempts: 0,
    cursor: 0,
    cursorAttempts: 0,
    readings: [],
    observedValue: 0n,
    invalidReason: "",
    disputeUntil: 0n,
    challenger: "0x0000000000000000000000000000000000000000",
    bond: 0n,
    disputedOutcome: Outcome.Unresolved,
    bounty: 0n,
    bondRefundable: false,
    bondClaimed: false,
    ...partial,
  } as DemoMarket;
}

export function initialDemoState(): DemoState {
  const markets: DemoMarket[] = [
    blankMarket({
      id: 1n,
      question: "Will ETH clear $2,420 when this market resolves?",
      oracles: [source(coingecko), source(kraken), source(coinbase)],
      quorum: 2,
      target: 242_000n,
      comparator: 1, // at least
      feeBps: 100,
      closeBlock: START + 150n,
      resolveBlock: START + 260n,
      totalYes: (ETH * 34n) / 100n,
      totalNo: (ETH * 21n) / 100n,
    }),
    blankMarket({
      id: 2n,
      question: "Will ETH have fallen under $2,000 by the close?",
      oracles: [source(coingecko)],
      quorum: 1,
      target: 200_000n,
      comparator: 2, // less than
      closeBlock: START - 900n,
      resolveBlock: START - 800n,
      totalYes: (ETH * 12n) / 100n,
      totalNo: (ETH * 48n) / 100n,
      state: MarketState.Resolved,
      outcome: Outcome.No,
      observedValue: BigInt(coingecko.value),
      readings: [BigInt(coingecko.value)],
      attempts: 1,
      cursor: 1,
      disputeUntil: START - 500n,
    }),
    blankMarket({
      id: 3n,
      question: "Will the venues agree on a price to the cent?",
      oracles: [source(coingecko), source(kraken)],
      quorum: 2,
      target: 999_999n,
      comparator: 0, // greater than
      closeBlock: START - 1_400n,
      resolveBlock: START - 1_300n,
      totalYes: (ETH * 9n) / 100n,
      totalNo: 0n,
      state: MarketState.Invalid,
      invalidReason: "nobody backed the winning side",
      outcome: Outcome.No,
      observedValue: BigInt(kraken.value),
      readings: [BigInt(coingecko.value), BigInt(kraken.value)],
      attempts: 2,
      cursor: 2,
    }),
  ];

  return {
    blockNumber: START,
    blockTimeMs: 195n,
    executionBalance: (ETH * 185n) / 100n,
    markets,
    positions: [
      { tokenId: 1n, marketId: 1n, isYes: true, amount: (ETH * 34n) / 100n, owner: OTHER },
      { tokenId: 2n, marketId: 1n, isYes: false, amount: (ETH * 21n) / 100n, owner: OTHER },
      { tokenId: 3n, marketId: 2n, isYes: false, amount: (ETH * 48n) / 100n, owner: DEMO_ACCOUNT },
      { tokenId: 4n, marketId: 2n, isYes: true, amount: (ETH * 12n) / 100n, owner: OTHER },
      { tokenId: 5n, marketId: 3n, isYes: true, amount: (ETH * 9n) / 100n, owner: DEMO_ACCOUNT },
    ],
    settled: {},
    nextTokenId: 6n,
    log: [],
  };
}

// ── the contract's arithmetic, restated ────────────────────────────────

export function feeOf(market: DemoMarket) {
  if (market.state !== MarketState.Resolved) return 0n;
  return ((market.totalYes + market.totalNo) * BigInt(market.feeBps)) / 10_000n;
}

export function disputeBond(market: DemoMarket) {
  const share = ((market.totalYes + market.totalNo) * DISPUTE_BOND_BPS) / 10_000n;
  return share < MIN_DISPUTE_BOND ? MIN_DISPUTE_BOND : share;
}

export function stakesOf(state: DemoState, marketId: bigint, owner: string) {
  let yes = 0n;
  let no = 0n;
  for (const position of state.positions) {
    if (position.marketId !== marketId) continue;
    if (position.owner.toLowerCase() !== owner.toLowerCase()) continue;
    if (position.isYes) yes += position.amount;
    else no += position.amount;
  }

  const market = state.markets.find((m) => m.id === marketId)!;
  const alreadySettled = state.settled[`${marketId}:${owner.toLowerCase()}`] === true;
  if (alreadySettled) return [yes, no, true, 0n] as const;

  if (market.state === MarketState.Resolved) {
    const won = market.outcome === Outcome.Yes;
    const stake = won ? yes : no;
    const winningPool = won ? market.totalYes : market.totalNo;
    if (stake === 0n || winningPool === 0n) return [yes, no, false, 0n] as const;
    const poolTotal = market.totalYes + market.totalNo;
    const distributable =
      poolTotal - (poolTotal * BigInt(market.feeBps)) / 10_000n + market.bounty;
    return [yes, no, false, (stake * distributable) / winningPool] as const;
  }
  if (market.state === MarketState.Invalid)
    return [yes, no, false, yes + no] as const;
  return [yes, no, false, 0n] as const;
}

function median(values: bigint[]) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)]!;
}

function compare(observed: bigint, target: bigint, comparator: number) {
  if (comparator === 0) return observed > target;
  if (comparator === 1) return observed >= target;
  if (comparator === 2) return observed < target;
  return observed <= target;
}

// ── the scheduler, as a clock ──────────────────────────────────────────

/**
 * Moves the clock and does what the Scheduler would have done on the way. One
 * source is read per wake-up, exactly as on chain: a short-running async
 * precompile may be called once per transaction.
 */
export function advance(state: DemoState, blocks: bigint): DemoState {
  const next: DemoState = {
    ...state,
    blockNumber: state.blockNumber + blocks,
    markets: state.markets.map((m) => ({ ...m, readings: [...m.readings] })),
    log: [],
  };

  for (const market of next.markets) {
    if (market.state === MarketState.Open && next.blockNumber >= market.closeBlock) {
      market.state = MarketState.Closed;
      next.log.push(`#${market.id} betting closed at block ${market.closeBlock}`);
    }

    const settling =
      market.state === MarketState.Closed ||
      market.state === MarketState.Resolving ||
      market.state === MarketState.Disputed;
    if (!settling || next.blockNumber < market.resolveBlock) continue;

    // One reading per wake-up, until the quorum is met or the sources run out.
    while (
      market.readings.length < market.quorum &&
      market.cursor < market.oracles.length
    ) {
      const record = RECORDED.find(
        (r) => r.url === market.oracles[market.cursor]!.url,
      );
      market.attempts += 1;
      market.state = MarketState.Resolving;

      if (record?.ok) {
        market.readings.push(BigInt(record.value));
        next.log.push(
          `#${market.id} read ${record.value} from source ${market.cursor + 1}`,
        );
        market.cursor += 1;
        market.cursorAttempts = 0;
      } else {
        market.cursorAttempts += 1;
        next.log.push(
          `#${market.id} source ${market.cursor + 1} missed (attempt ${market.cursorAttempts})`,
        );
        if (market.cursorAttempts >= MAX_ATTEMPTS) {
          market.cursor += 1;
          market.cursorAttempts = 0;
        }
      }
    }

    if (market.readings.length >= market.quorum) {
      const observed = median(market.readings);
      market.observedValue = observed;
      market.outcome = compare(observed, market.target, market.comparator)
        ? Outcome.Yes
        : Outcome.No;
      const winningPool =
        market.outcome === Outcome.Yes ? market.totalYes : market.totalNo;

      if (winningPool === 0n) {
        market.state = MarketState.Invalid;
        market.invalidReason = "nobody backed the winning side";
        next.log.push(`#${market.id} nobody won — everyone refunds`);
      } else {
        market.state = MarketState.Resolved;
        market.disputeUntil = next.blockNumber + DISPUTE_WINDOW_BLOCKS;
        next.log.push(
          `#${market.id} settled ${market.outcome === Outcome.Yes ? "YES" : "NO"} on ${observed}`,
        );
      }
    } else if (market.cursor >= market.oracles.length) {
      market.state = MarketState.Invalid;
      market.invalidReason = "quorum not reached";
      next.log.push(`#${market.id} quorum not reached — everyone refunds`);
    }
  }

  return next;
}

/** Blocks until the next thing that would happen on its own. */
export function blocksToNextEvent(state: DemoState): bigint {
  let soonest: bigint | null = null;
  const consider = (target: bigint) => {
    if (target <= state.blockNumber) return;
    const delta = target - state.blockNumber;
    if (soonest === null || delta < soonest) soonest = delta;
  };

  for (const market of state.markets) {
    if (market.state === MarketState.Open) consider(market.closeBlock);
    if (market.state === MarketState.Closed || market.state === MarketState.Resolving)
      consider(market.resolveBlock);
    if (market.state === MarketState.Resolved) consider(market.disputeUntil);
  }
  return soonest ?? 100n;
}
