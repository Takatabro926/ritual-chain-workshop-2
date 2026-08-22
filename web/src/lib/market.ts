/**
 * The contract's vocabulary, in one place: the enums, the shape `getMarkets`
 * returns, and the small derivations the UI needs on top of it.
 */

export const MarketState = {
  Open: 0,
  Closed: 1,
  Resolving: 2,
  Resolved: 3,
  Invalid: 4,
  Disputed: 5,
} as const;

export const Outcome = { Unresolved: 0, Yes: 1, No: 2 } as const;

export const Comparator = { GT: 0, GTE: 1, LT: 2, LTE: 3 } as const;

export const COMPARATOR_LABEL = ["greater than", "at least", "less than", "at most"];
export const COMPARATOR_SYMBOL = [">", "≥", "<", "≤"];

export type Oracle = { url: string; jsonPath: string };

export type Market = {
  id: bigint;
  creator: `0x${string}`;
  question: string;
  oracles: readonly Oracle[];
  quorum: number;
  target: bigint;
  comparator: number;
  feeBps: number;
  feeClaimed: boolean;
  closeBlock: bigint;
  resolveBlock: bigint;
  scheduleId: bigint;
  totalYes: bigint;
  totalNo: bigint;
  state: number;
  outcome: number;
  attempts: number;
  cursor: number;
  cursorAttempts: number;
  readings: readonly bigint[];
  observedValue: bigint;
  invalidReason: string;
  disputeUntil: bigint;
  challenger: `0x${string}`;
  bond: bigint;
  disputedOutcome: number;
  bounty: bigint;
  bondRefundable: boolean;
  bondClaimed: boolean;
};

/**
 * The nine display states the UI actually distinguishes, which is more than the
 * contract's six: a resolved market behaves very differently inside and outside
 * its challenge window, and a market with no bets on it cannot resolve at all.
 */
export type Phase =
  | "open"
  | "closed"
  | "resolving"
  | "challengeable"
  | "final"
  | "disputed"
  | "refundable";

export function phaseOf(market: Market, blockNumber: bigint | undefined): Phase {
  switch (market.state) {
    case MarketState.Open:
      return "open";
    case MarketState.Closed:
      return "closed";
    case MarketState.Resolving:
      return "resolving";
    case MarketState.Disputed:
      return "disputed";
    case MarketState.Invalid:
      return "refundable";
    default:
      if (blockNumber !== undefined && blockNumber < market.disputeUntil)
        return "challengeable";
      return "final";
  }
}

export const PHASE_LABEL: Record<Phase, string> = {
  open: "Taking bets",
  closed: "Betting closed",
  resolving: "Reading oracles",
  challengeable: "Open to challenge",
  final: "Settled",
  disputed: "Second reading",
  refundable: "Refundable",
};

/** Colour, icon and animation per phase. Never colour alone — see the icons. */
export const PHASE_STYLE: Record<Phase, { tone: string; icon: string; pulse: boolean }> = {
  open: { tone: "green", icon: "◉", pulse: false },
  closed: { tone: "gold", icon: "◌", pulse: true },
  resolving: { tone: "gold", icon: "⟳", pulse: true },
  challengeable: { tone: "gold", icon: "◎", pulse: false },
  final: { tone: "green", icon: "✓", pulse: false },
  disputed: { tone: "pink", icon: "◇", pulse: true },
  refundable: { tone: "red", icon: "⊘", pulse: false },
};

export function pool(market: Market) {
  return market.totalYes + market.totalNo;
}

/** Share of the pool backing YES, as a percentage. Half when nobody has bet. */
export function yesShare(market: Market) {
  const total = pool(market);
  if (total === 0n) return 50;
  return Number((market.totalYes * 10_000n) / total) / 100;
}

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Blocks to a deadline, or null once it has passed. */
export function blocksUntil(target: bigint, now: bigint | undefined) {
  if (now === undefined || now >= target) return null;
  return target - now;
}

/** Rough wall-clock for a block count, using the contract's own block time. */
export function approximateTime(blocks: bigint, blockTimeMs: bigint | undefined) {
  if (blockTimeMs === undefined || blockTimeMs === 0n) return null;
  const seconds = Number((blocks * blockTimeMs) / 1000n);
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 360) / 10}h`;
}

export function formatUnitsFixed(value: bigint, decimals: number, places: number) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  if (places === 0) return whole.toString();
  const padded = fraction.toString().padStart(decimals, "0").slice(0, places);
  return `${whole}.${padded}`;
}
