/**
 * Shared setup for the integration suite.
 *
 * Every test gets its own network connection. The stand-ins keep storage, so a
 * shared connection would let one test's programmed oracle response or spent
 * booking leak into the next one.
 */
import { network } from "hardhat";
import { parseEther } from "viem";
import {
  DEFAULT_BLOCK_TIME_MS,
  installLocalRitual,
  type OracleFixture,
} from "./localRitual.ts";

export const Comparator = { GT: 0, GTE: 1, LT: 2, LTE: 3 } as const;
export const MarketState = {
  Open: 0,
  Closed: 1,
  Resolving: 2,
  Resolved: 3,
  Invalid: 4,
  Disputed: 5,
} as const;
export const Outcome = { Unresolved: 0, Yes: 1, No: 2 } as const;

/** The contract's own constants, restated so a test can say why it mines. */
export const MAX_ATTEMPTS = 3;
export const RETRY_INTERVAL_BLOCKS = 200;

/** 30 s and 15 s at 195 ms a block, floored the way _secondsToBlocks floors. */
export const BETTING_SECONDS = 30n;
export const RESOLVE_DELAY_SECONDS = 15n;
export const BETTING_BLOCKS = Number((BETTING_SECONDS * 1000n) / DEFAULT_BLOCK_TIME_MS);
export const RESOLVE_BLOCKS = Number(
  (RESOLVE_DELAY_SECONDS * 1000n) / DEFAULT_BLOCK_TIME_MS,
);

export async function setUp(options: { executors?: `0x${string}`[] } = {}) {
  const connection = await network.create();
  const { viem, networkHelpers } = connection;

  const ritual = await installLocalRitual(viem, options);
  const predict = await viem.deployContract("RitualPredict", [
    DEFAULT_BLOCK_TIME_MS,
  ]);
  await predict.write.fundExecution([1000n], { value: parseEther("0.5") });

  const [creator, alice, bob, carol] = await viem.getWalletClients();
  return {
    viem,
    networkHelpers,
    ritual,
    predict,
    creator,
    alice,
    bob,
    carol,
  };
}

/**
 * A market whose rule points at recorded fixtures. One source and a quorum of
 * one unless the caller asks for more. Returns the new market's id.
 */
export async function openMarket(
  predict: any,
  record: OracleFixture,
  query: string,
  target: bigint,
  comparator: number,
  question = "Will the recorded reading clear the target?",
  options: {
    oracles?: { url: string; jsonPath: string }[];
    quorum?: number;
    feeBps?: number;
  } = {},
): Promise<bigint> {
  const oracles = options.oracles ?? [{ url: record.url, jsonPath: query }];
  await predict.write.createMarket([
    {
      question,
      oracles,
      quorum: options.quorum ?? 1,
      target,
      comparator,
      feeBps: options.feeBps ?? 0,
      bettingSeconds: BETTING_SECONDS,
      resolveDelaySeconds: RESOLVE_DELAY_SECONDS,
    },
  ]);
  return predict.read.marketCount();
}

/** Mine past the betting window and up to the scheduled resolution block. */
export async function reachResolveBlock(networkHelpers: any) {
  await networkHelpers.mine(BETTING_BLOCKS + RESOLVE_BLOCKS + 2);
}

/** Claims stay shut for this many blocks after a market first resolves. */
export const DISPUTE_WINDOW_BLOCKS = 300;

/** Move past the challenge window so winnings and fees can be claimed. */
export async function passDisputeWindow(networkHelpers: any) {
  await networkHelpers.mine(DISPUTE_WINDOW_BLOCKS + 1);
}

/** Run one scheduled execution with enough gas to honour the booking. */
export async function fire(
  ritual: any,
  scheduleId: bigint,
  executionIndex: bigint,
) {
  return ritual.scheduler.write.fire([scheduleId, executionIndex], {
    gas: 6_000_000n,
  });
}
