/**
 * Several sources, one answer.
 *
 * The shape of this is forced by the chain: a short-running async precompile may
 * be called once per transaction, so a market cannot poll three venues inside one
 * callback. It walks them across executions instead, one source per wake-up,
 * and settles as soon as enough of them have answered.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "viem";
import { applyOracleFixture, fixture } from "./harness/localRitual.ts";
import {
  Comparator,
  MarketState,
  MAX_ATTEMPTS,
  Outcome,
  fire,
  openMarket,
  reachResolveBlock,
  setUp,
} from "./harness/market.ts";

const venues = ["coingecko-eth-usd", "coinbase-eth-usd", "kraken-eth-usd"].map(
  (name) => fixture(name),
);
const READINGS = venues.map((v) => BigInt(v.jq[0].value));
const SOURCES = venues.map((v) => ({ url: v.url, jsonPath: v.jq[0].query }));

/** The value the market should settle on: the middle of the three, by value. */
const MEDIAN = [...READINGS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[1];

async function quorumMarket(count: number, quorum: number) {
  const env = await setUp();
  const id = await openMarket(
    env.predict,
    venues[0],
    venues[0].jq[0].query,
    1n,
    Comparator.GTE,
    "Will the median clear the target?",
    { oracles: SOURCES.slice(0, count), quorum },
  );
  await env.predict.write.bet([id, true], {
    account: env.alice.account,
    value: parseEther("1"),
  });
  await env.predict.write.bet([id, false], {
    account: env.bob.account,
    value: parseEther("1"),
  });
  await reachResolveBlock(env.networkHelpers);
  const market = await env.predict.read.getMarket([id]);
  return { ...env, id, scheduleId: market.scheduleId };
}

/** Point the stand-in at one venue's recorded response, then run one execution. */
async function answerWith(env: any, index: number, execution: bigint) {
  await applyOracleFixture(env.ritual, venues[index], venues[index].jq[0].query);
  await fire(env.ritual, env.scheduleId, execution);
}

describe("declaring the sources", () => {
  it("insists on at least one and at most five", async () => {
    const { viem, predict } = await setUp();
    const base = {
      question: "q",
      quorum: 1,
      target: 1n,
      comparator: Comparator.GTE,
      bettingSeconds: 30n,
      resolveDelaySeconds: 15n,
    };
    const one = SOURCES[0];

    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([{ ...base, oracles: [] }]),
      predict,
      "BadOracleSet",
    );
    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([
        { ...base, oracles: [one, one, one, one, one, one] },
      ]),
      predict,
      "BadOracleSet",
    );
  });

  it("insists the quorum is reachable", async () => {
    const { viem, predict } = await setUp();
    const base = {
      question: "q",
      oracles: SOURCES.slice(0, 2),
      target: 1n,
      comparator: Comparator.GTE,
      bettingSeconds: 30n,
      resolveDelaySeconds: 15n,
    };

    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([{ ...base, quorum: 0 }]),
      predict,
      "BadOracleSet",
    );
    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([{ ...base, quorum: 3 }]),
      predict,
      "BadOracleSet",
    );
  });

  it("books enough executions to give every source its attempts", async () => {
    const { predict, ritual } = await setUp();
    const id = await openMarket(
      predict,
      venues[0],
      venues[0].jq[0].query,
      1n,
      Comparator.GTE,
      "three venues",
      { oracles: SOURCES, quorum: 2 },
    );
    const market = await predict.read.getMarket([id]);
    const booking = await ritual.scheduler.read.getBooking([market.scheduleId]);

    assert.equal(booking.numCalls, SOURCES.length * MAX_ATTEMPTS);
    assert.ok(booking.frequency * booking.numCalls <= 10_000);
  });
});

describe("gathering a quorum", () => {
  it("walks the sources one execution at a time", async () => {
    const env = await quorumMarket(3, 3);

    await answerWith(env, 0, 0n);
    let market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.state, MarketState.Resolving);
    assert.deepEqual(market.readings, [READINGS[0]]);
    assert.equal(market.cursor, 1);

    await answerWith(env, 1, 1n);
    market = await env.predict.read.getMarket([env.id]);
    assert.deepEqual(market.readings, [READINGS[0], READINGS[1]]);
    assert.equal(market.cursor, 2);

    await answerWith(env, 2, 2n);
    market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.state, MarketState.Resolved);
    assert.deepEqual(market.readings, READINGS);
  });

  it("settles on the middle reading, not on an average", async () => {
    const env = await quorumMarket(3, 3);
    for (let i = 0; i < 3; i++) await answerWith(env, i, BigInt(i));

    const market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.observedValue, MEDIAN);

    const average =
      READINGS.reduce((a, b) => a + b, 0n) / BigInt(READINGS.length);
    assert.notEqual(
      market.observedValue,
      average,
      "an average would invent a number no venue reported",
    );
    assert.ok(
      READINGS.includes(market.observedValue),
      "the settled value came from a real venue",
    );
  });

  it("stops as soon as the quorum is met and leaves the rest alone", async () => {
    const env = await quorumMarket(3, 2);

    await answerWith(env, 0, 0n);
    await answerWith(env, 1, 1n);

    const market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.state, MarketState.Resolved);
    assert.equal(market.readings.length, 2);
    assert.equal(market.cursor, 2, "the third venue was never consulted");
    // Two readings: the upper of the two middles.
    const pair = [READINGS[0], READINGS[1]].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    assert.equal(market.observedValue, pair[1]);
    assert.equal(
      await env.ritual.scheduler.read.getCallState([env.scheduleId]),
      3,
      "the unused executions are cancelled",
    );
  });
});

describe("a source that will not answer", () => {
  it("is abandoned after its own attempts, and the market moves on", async () => {
    const env = await quorumMarket(2, 1);
    await env.ritual.http.write.setReverting([true]);

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await fire(env.ritual, env.scheduleId, BigInt(i));
      const mid = await env.predict.read.getMarket([env.id]);
      assert.equal(mid.state, MarketState.Resolving);
      assert.equal(mid.attempts, i + 1);
      assert.equal(
        mid.cursor,
        i === MAX_ATTEMPTS - 1 ? 1 : 0,
        "the cursor only moves once the source has used its attempts",
      );
    }

    await answerWith(env, 1, BigInt(MAX_ATTEMPTS));
    const market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.state, MarketState.Resolved);
    assert.deepEqual(market.readings, [READINGS[1]]);
  });

  it("refunds rather than settling on too few readings", async () => {
    const env = await quorumMarket(3, 3);

    // The first venue never answers and burns its attempts.
    await env.ritual.http.write.setReverting([true]);
    for (let i = 0; i < MAX_ATTEMPTS; i++)
      await fire(env.ritual, env.scheduleId, BigInt(i));

    // The other two do answer, but three were required.
    await answerWith(env, 1, BigInt(MAX_ATTEMPTS));
    await answerWith(env, 2, BigInt(MAX_ATTEMPTS + 1));

    const market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.state, MarketState.Invalid);
    assert.equal(market.invalidReason, "quorum not reached");
    assert.equal(market.outcome, Outcome.Unresolved);
    assert.equal(market.readings.length, 2);

    // Everyone gets their stake back.
    await env.predict.write.claimRefund([env.id], { account: env.alice.account });
    await env.predict.write.claimRefund([env.id], { account: env.bob.account });
    assert.equal(
      await env.ritual.publicClient.getBalance({ address: env.predict.address }),
      0n,
    );
  });
});
