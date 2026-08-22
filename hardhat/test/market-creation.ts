/**
 * Creating a market: what is rejected, what reaches storage, and what gets
 * booked with the Scheduler in the same transaction.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "viem";
import { fixture } from "./harness/localRitual.ts";
import {
  BETTING_BLOCKS,
  BETTING_SECONDS,
  Comparator,
  MarketState,
  MAX_ATTEMPTS,
  Outcome,
  RESOLVE_BLOCKS,
  RESOLVE_DELAY_SECONDS,
  RETRY_INTERVAL_BLOCKS,
  openMarket,
  setUp,
} from "./harness/market.ts";

const record = fixture("coingecko-eth-usd");
const QUERY = record.jq[0].query;

function rule(overrides: Record<string, unknown> = {}) {
  return {
    question: "Will the recorded reading clear the target?",
    oracles: [{ url: record.url, jsonPath: QUERY }],
    quorum: 1,
    target: 100000n,
    comparator: Comparator.GTE,
    bettingSeconds: BETTING_SECONDS,
    resolveDelaySeconds: RESOLVE_DELAY_SECONDS,
    ...overrides,
  };
}

describe("createMarket", () => {
  it("rejects an empty question, url or json path", async () => {
    const { viem, predict } = await setUp();
    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([rule({ question: "" })]),
      predict,
      "EmptyString",
    );
    for (const field of ["url", "jsonPath"]) {
      await viem.assertions.revertWithCustomError(
        predict.write.createMarket([
          rule({ oracles: [{ url: record.url, jsonPath: QUERY, [field]: "" }] }),
        ]),
        predict,
        "EmptyString",
      );
    }
  });

  it("rejects windows that are too short", async () => {
    const { viem, predict } = await setUp();
    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([rule({ bettingSeconds: 29n })]),
      predict,
      "BadDuration",
    );
    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([rule({ resolveDelaySeconds: 14n })]),
      predict,
      "BadDuration",
    );
  });

  it("caps the whole market at a day, not each leg", async () => {
    const { viem, predict } = await setUp();
    const day = 86_400n;

    // Either leg alone is allowed to be almost the full day.
    await predict.write.createMarket([
      rule({ bettingSeconds: day - 15n, resolveDelaySeconds: 15n }),
    ]);

    // Together they are not, even though neither exceeds the cap on its own.
    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([
        rule({ bettingSeconds: day - 15n, resolveDelaySeconds: 16n }),
      ]),
      predict,
      "BadDuration",
    );
  });

  it("turns both durations into block numbers", async () => {
    const { predict, ritual } = await setUp();
    const before = await ritual.publicClient.getBlockNumber();

    const id = await openMarket(predict, record, QUERY, 100000n, Comparator.GTE);
    const market = await predict.read.getMarket([id]);

    // createMarket itself mines a block, so the base is `before + 1`.
    assert.equal(Number(market.closeBlock), Number(before) + 1 + BETTING_BLOCKS);
    assert.equal(
      Number(market.resolveBlock),
      Number(market.closeBlock) + RESOLVE_BLOCKS,
    );
  });

  it("stores the rule and announces it separately from the market", async () => {
    const { viem, predict } = await setUp();

    await viem.assertions.emitWithArgs(
      predict.write.createMarket([rule({ target: 4242n })]),
      predict,
      "ResolutionRuleSet",
      [1n, 4242n, Comparator.GTE, 1, 1n],
    );

    const market = await predict.read.getMarket([1n]);
    assert.equal(market.oracles.length, 1);
    assert.equal(market.oracles[0].url, record.url);
    assert.equal(market.oracles[0].jsonPath, QUERY);
    assert.equal(market.quorum, 1);
    assert.equal(market.target, 4242n);
    assert.equal(market.comparator, Comparator.GTE);
    assert.equal(market.state, MarketState.Open);
    assert.equal(market.outcome, Outcome.Unresolved);
    assert.equal(market.attempts, 0);
    assert.equal(market.totalYes, 0n);
    assert.equal(market.totalNo, 0n);
  });

  it("books all three attempts in the same transaction", async () => {
    const { predict, ritual } = await setUp();
    const id = await openMarket(predict, record, QUERY, 100000n, Comparator.GTE);
    const market = await predict.read.getMarket([id]);

    assert.notEqual(market.scheduleId, 0n);
    const booking = await ritual.scheduler.read.getBooking([market.scheduleId]);

    assert.equal(booking.target.toLowerCase(), predict.address.toLowerCase());
    assert.equal(booking.numCalls, MAX_ATTEMPTS);
    assert.equal(booking.frequency, RETRY_INTERVAL_BLOCKS);
    assert.equal(Number(booking.startBlock), Number(market.resolveBlock));
    assert.equal(booking.gas, 2_000_000);
    assert.equal(booking.ttl, 150);
    assert.equal(booking.value, 0n);
    // The contract pays for its own resolution out of its RitualWallet balance.
    assert.equal(booking.payer.toLowerCase(), predict.address.toLowerCase());
    // 3 x 200 has to stay under the Scheduler's 10,000 block lifespan.
    assert.ok(booking.frequency * booking.numCalls <= 10_000);
  });

  it("numbers markets from one and lists them newest first", async () => {
    const { predict } = await setUp();
    await openMarket(predict, record, QUERY, 1n, Comparator.GTE, "first");
    await openMarket(predict, record, QUERY, 2n, Comparator.GTE, "second");

    assert.equal(await predict.read.marketCount(), 2n);
    const all = await predict.read.getMarkets();
    assert.equal(all.length, 2);
    assert.equal(all[0].question, "second");
    assert.equal(all[1].question, "first");
  });

  it("does not answer for a market that does not exist", async () => {
    const { viem, predict } = await setUp();
    for (const id of [0n, 1n, 99n]) {
      await viem.assertions.revertWithCustomError(
        predict.read.getMarket([id]),
        predict,
        "UnknownMarket",
      );
    }
  });
});

describe("bet", () => {
  it("refuses a zero stake", async () => {
    const { viem, predict } = await setUp();
    const id = await openMarket(predict, record, QUERY, 1n, Comparator.GTE);
    await viem.assertions.revertWithCustomError(
      predict.write.bet([id, true]),
      predict,
      "ZeroStake",
    );
  });

  it("adds to the right pool and to the caller's stake", async () => {
    const { predict, alice, bob } = await setUp();
    const id = await openMarket(predict, record, QUERY, 1n, Comparator.GTE);

    await predict.write.bet([id, true], {
      account: alice.account,
      value: parseEther("2"),
    });
    await predict.write.bet([id, true], {
      account: alice.account,
      value: parseEther("1"),
    });
    await predict.write.bet([id, false], {
      account: bob.account,
      value: parseEther("5"),
    });

    const market = await predict.read.getMarket([id]);
    assert.equal(market.totalYes, parseEther("3"));
    assert.equal(market.totalNo, parseEther("5"));

    const [aliceYes, aliceNo] = await predict.read.stakesOf([
      id,
      alice.account.address,
    ]);
    assert.equal(aliceYes, parseEther("3"));
    assert.equal(aliceNo, 0n);
  });

  it("closes at the block, not at a timestamp", async () => {
    const { viem, predict, networkHelpers, alice } = await setUp();
    const id = await openMarket(predict, record, QUERY, 1n, Comparator.GTE);

    // One block short of the close: still open.
    await networkHelpers.mine(BETTING_BLOCKS - 2);
    await predict.write.bet([id, true], {
      account: alice.account,
      value: parseEther("1"),
    });

    await networkHelpers.mine(2);
    await viem.assertions.revertWithCustomError(
      predict.write.bet([id, true], {
        account: alice.account,
        value: parseEther("1"),
      }),
      predict,
      "BettingClosed",
    );
  });
});
