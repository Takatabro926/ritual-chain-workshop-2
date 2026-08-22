"use client";

/**
 * Where the page gets its markets.
 *
 * Two implementations behind one interface: `chain` reads a deployed contract
 * through wagmi, and `demo` runs the rules in the browser against recorded oracle
 * readings. The components below this line do not know which they are talking to,
 * which is the point — the demo exercises the same screens, not a mock-up of them.
 *
 * Mode is decided once: demo when NEXT_PUBLIC_DEMO=1, or when no contract address
 * is configured. A deployment with nothing to talk to is more useful as a demo
 * than as an error message.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  useAccount,
  useBlockNumber,
  useConnect,
  useDisconnect,
  useReadContract,
} from "wagmi";
import { predictContract } from "./contract";
import {
  DEMO_ACCOUNT,
  advance,
  blocksToNextEvent,
  disputeBond as demoDisputeBond,
  initialDemoState,
  stakesOf as demoStakesOf,
  type DemoMarket,
  type DemoState,
} from "./demo";
import { MarketState, Outcome, type Market } from "./market";
import { useTx } from "@/components/useTx";

export type NewMarketInput = {
  question: string;
  oracles: { url: string; jsonPath: string }[];
  quorum: number;
  target: bigint;
  comparator: number;
  feeBps: number;
  bettingSeconds: bigint;
  resolveDelaySeconds: bigint;
};

export type Action =
  | { type: "bet"; marketId: bigint; isYes: boolean; value: bigint }
  | { type: "claimWinnings"; marketId: bigint }
  | { type: "claimRefund"; marketId: bigint }
  | { type: "claimFee"; marketId: bigint }
  | { type: "claimBond"; marketId: bigint }
  | { type: "dispute"; marketId: bigint; value: bigint }
  | { type: "fundExecution"; value: bigint }
  | { type: "createMarket"; params: NewMarketInput }
  | { type: "transfer"; tokenId: bigint; to: string };

export const DEMO_MODE =
  process.env.NEXT_PUBLIC_DEMO === "1" || predictContract === undefined;

type DemoContext = {
  state: DemoState;
  setState: (next: DemoState) => void;
};

const Demo = createContext<DemoContext | null>(null);

export function SourceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DemoState>(initialDemoState);
  const value = useMemo(() => ({ state, setState }), [state]);
  return <Demo.Provider value={value}>{children}</Demo.Provider>;
}

function useDemo() {
  const context = useContext(Demo);
  if (!context) throw new Error("SourceProvider is missing");
  return context;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function useSource() {
  const demo = useDemo();
  const account = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tx = useTx();

  const chainQuery = { enabled: !DEMO_MODE && predictContract !== undefined };
  const { data: chainBlock } = useBlockNumber({
    watch: !DEMO_MODE,
    query: { enabled: !DEMO_MODE },
  });
  const { data: chainMarkets, refetch: refetchMarkets } = useReadContract({
    ...predictContract!,
    functionName: "getMarkets",
    query: { ...chainQuery, refetchInterval: 4000 },
  });
  const { data: chainBlockTime } = useReadContract({
    ...predictContract!,
    functionName: "blockTimeMs",
    query: chainQuery,
  });
  const { data: chainBalance, refetch: refetchBalance } = useReadContract({
    ...predictContract!,
    functionName: "executionBalance",
    query: { ...chainQuery, refetchInterval: 6000 },
  });

  const perform = useCallback(
    async (action: Action) => {
      setError(null);

      if (!DEMO_MODE) {
        const call = asContractCall(action, account.address);
        const ok = await tx.send({
          ...predictContract!,
          functionName: call.functionName,
          args: call.args,
          ...(call.value === undefined ? {} : { value: call.value }),
        } as never);
        if (ok) {
          refetchMarkets();
          refetchBalance();
        }
        return ok;
      }

      setBusy(true);
      try {
        demo.setState(applyDemo(demo.state, action));
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [demo, tx, refetchMarkets, refetchBalance, account.address],
  );

  if (DEMO_MODE) {
    return {
      mode: "demo" as const,
      address: DEMO_ACCOUNT as string,
      isConnected: true,
      chainName: "Demo",
      blockNumber: demo.state.blockNumber,
      blockTimeMs: demo.state.blockTimeMs,
      executionBalance: demo.state.executionBalance,
      markets: demo.state.markets as unknown as Market[],
      positions: demo.state.positions.filter(
        (p) => p.owner.toLowerCase() === DEMO_ACCOUNT.toLowerCase(),
      ),
      perform,
      busy,
      error,
      connect: () => {},
      disconnect: () => {},
      refresh: () => {},
      demo: {
        nextEvent: blocksToNextEvent(demo.state),
        log: demo.state.log,
        advance: (blocks: bigint) => demo.setState(advance(demo.state, blocks)),
        reset: () => demo.setState(initialDemoState()),
      },
    };
  }

  return {
    mode: "chain" as const,
    address: account.address as string | undefined,
    isConnected: account.isConnected,
    chainName: account.chain?.name,
    blockNumber: chainBlock,
    blockTimeMs: chainBlockTime as bigint | undefined,
    executionBalance: chainBalance as bigint | undefined,
    markets: ((chainMarkets as readonly Market[] | undefined) ?? []) as Market[],
    positions: [] as { tokenId: bigint; marketId: bigint; isYes: boolean; amount: bigint }[],
    perform,
    busy: tx.status === "signing" || tx.status === "mining",
    error: error ?? tx.error,
    connect: () => connectors[0] && connect({ connector: connectors[0] }),
    disconnect,
    refresh: () => {
      refetchMarkets();
      refetchBalance();
    },
    demo: undefined,
  };
}

/**
 * Per-market reads. Both branches always run their hooks, in the same order, so
 * switching mode never changes the hook sequence.
 */
export function useMarketExtras(marketId: bigint, market: Market) {
  const demo = useDemo();
  const account = useAccount();

  const { data: chainStakes } = useReadContract({
    ...predictContract!,
    functionName: "stakesOf",
    args: account.address ? [marketId, account.address] : undefined,
    query: {
      enabled: !DEMO_MODE && Boolean(account.address && predictContract),
      refetchInterval: 4000,
    },
  });
  const { data: chainBond } = useReadContract({
    ...predictContract!,
    functionName: "disputeBond",
    args: [marketId],
    query: { enabled: !DEMO_MODE && predictContract !== undefined, refetchInterval: 8000 },
  });

  if (DEMO_MODE) {
    return {
      stakes: demoStakesOf(demo.state, marketId, DEMO_ACCOUNT),
      bond: demoDisputeBond(market as unknown as DemoMarket),
    };
  }

  return {
    stakes: (chainStakes as readonly [bigint, bigint, boolean, bigint] | undefined) ?? [
      0n,
      0n,
      false,
      0n,
    ],
    bond: chainBond as bigint | undefined,
  };
}

/** One action, as the contract call it becomes. */
function asContractCall(action: Action, from: string | undefined): {
  functionName: string;
  args: unknown[];
  value?: bigint;
} {
  switch (action.type) {
    case "bet":
      return {
        functionName: "bet",
        args: [action.marketId, action.isYes],
        value: action.value,
      };
    case "claimWinnings":
    case "claimRefund":
    case "claimFee":
    case "claimBond":
      return { functionName: action.type, args: [action.marketId] };
    case "dispute":
      return { functionName: "dispute", args: [action.marketId], value: action.value };
    case "fundExecution":
      // A long lock: the contract must stay able to pay for resolutions it has
      // already booked, and the deposit is the payer of every one of them.
      return { functionName: "fundExecution", args: [100_000n], value: action.value };
    case "createMarket":
      return { functionName: "createMarket", args: [action.params] };
    case "transfer":
      if (from === undefined) throw new Error("Connect a wallet first");
      return {
        functionName: "safeTransferFrom",
        args: [from, action.to, action.tokenId],
      };
  }
}

// ── the demo's writes ──────────────────────────────────────────────────

function applyDemo(state: DemoState, action: Action): DemoState {
  const next: DemoState = {
    ...state,
    markets: state.markets.map((m) => ({ ...m, readings: [...m.readings] })),
    positions: [...state.positions],
    settled: { ...state.settled },
    log: [],
  };
  const find = (id: bigint) => next.markets.find((m) => m.id === id)!;
  const mark = (id: bigint) => {
    next.settled[`${id}:${DEMO_ACCOUNT.toLowerCase()}`] = true;
  };

  switch (action.type) {
    case "bet": {
      const market = find(action.marketId);
      if (market.state !== MarketState.Open) throw new Error("Betting closed");
      if (action.value <= 0n) throw new Error("Zero stake");
      if (action.isYes) market.totalYes += action.value;
      else market.totalNo += action.value;
      next.positions.push({
        tokenId: next.nextTokenId,
        marketId: action.marketId,
        isYes: action.isYes,
        amount: action.value,
        owner: DEMO_ACCOUNT,
      });
      next.nextTokenId += 1n;
      next.log = [`bet ${action.isYes ? "YES" : "NO"} on #${action.marketId}`];
      break;
    }
    case "claimWinnings":
    case "claimRefund":
      mark(action.marketId);
      next.log = [`claimed on #${action.marketId}`];
      break;
    case "claimFee":
      find(action.marketId).feeClaimed = true;
      next.log = [`creator's cut taken on #${action.marketId}`];
      break;
    case "claimBond":
      find(action.marketId).bondClaimed = true;
      next.log = [`bond returned on #${action.marketId}`];
      break;
    case "dispute": {
      const market = find(action.marketId);
      if (market.challenger !== ZERO) throw new Error("Already disputed");
      market.challenger = DEMO_ACCOUNT;
      market.bond = action.value;
      market.disputedOutcome = market.outcome;
      market.outcome = Outcome.Unresolved;
      market.state = MarketState.Disputed;
      market.readings = [];
      market.cursor = 0;
      market.cursorAttempts = 0;
      market.resolveBlock = next.blockNumber + 1n;
      next.log = [`#${action.marketId} challenged — the oracles will be asked again`];
      break;
    }
    case "fundExecution":
      next.executionBalance += action.value;
      next.log = ["execution balance topped up"];
      break;
    case "createMarket": {
      const p = action.params;
      const id = BigInt(next.markets.length + 1);
      const closeBlock =
        next.blockNumber + (p.bettingSeconds * 1000n) / next.blockTimeMs;
      next.markets.unshift({
        ...next.markets[0]!,
        id,
        creator: DEMO_ACCOUNT,
        question: p.question,
        oracles: p.oracles,
        quorum: p.quorum,
        target: p.target,
        comparator: p.comparator,
        feeBps: p.feeBps,
        feeClaimed: false,
        closeBlock,
        resolveBlock:
          closeBlock + (p.resolveDelaySeconds * 1000n) / next.blockTimeMs,
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
        challenger: ZERO,
        bond: 0n,
        disputedOutcome: Outcome.Unresolved,
        bounty: 0n,
        bondRefundable: false,
        bondClaimed: false,
      });
      next.log = [`market #${id} created and its resolution booked`];
      break;
    }
    case "transfer": {
      const position = next.positions.find((p) => p.tokenId === action.tokenId);
      if (!position) throw new Error("No such token");
      position.owner = action.to;
      next.log = [`position #${action.tokenId} handed over`];
      break;
    }
  }

  return next;
}
