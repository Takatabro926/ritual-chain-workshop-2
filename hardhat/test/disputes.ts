/**
 * Buying a second opinion.
 *
 * A resolved market is not final immediately: for a while anyone can post a bond
 * and force the oracles to be asked again. The second reading stands, and the
 * bond decides who paid for it.
 *
 * A market's rule is fixed at creation, so a second reading cannot come from a
 * different endpoint or a different jq program — only from a different moment.
 * The fixtures therefore hold two snapshots of one source, recorded seconds
 * apart, and a target between them reads NO on the first and YES on the second.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "viem";
import { applyOracleFixture, fixture } from "./harness/localRitual.ts";
import {
  Comparator,
  MarketState,
  Outcome,
  fire,
  openMarket,
  passDisputeWindow,
  reachResolveBlock,
  setUp,
} from "./harness/market.ts";

const early = fixture("kraken-clock-early");
const late = fixture("kraken-clock-late");
const EARLY = BigInt(early.jq[0].value);
const LATE = BigInt(late.jq[0].value);

// Between the two snapshots, so the same rule reads NO then YES.
const TARGET = (EARLY + LATE) / 2n;
const MIN_DISPUTE_BOND = parseEther("0.001");

async function resolvedFromEarlySnapshot(feeBps = 0) {
  const env = await setUp();
  await applyOracleFixture(env.ritual, early, early.jq[0].query);
  const id = await openMarket(
    env.predict,
    early,
    early.jq[0].query,
    TARGET,
    Comparator.GTE,
    "Will the clock have passed the midpoint?",
    { feeBps },
  );
  await env.predict.write.bet([id, true], {
    account: env.alice.account,
    value: parseEther("3"),
  });
  await env.predict.write.bet([id, false], {
    account: env.bob.account,
    value: parseEther("1"),
  });
  await reachResolveBlock(env.networkHelpers);
  const market = await env.predict.read.getMarket([id]);
  await fire(env.ritual, market.scheduleId, 0n);

  const resolved = await env.predict.read.getMarket([id]);
  assert.equal(resolved.outcome, Outcome.No, "the earlier snapshot is short of the target");
  return { ...env, id };
}

/** Serve a snapshot and run the challenge's reading. */
async function reread(env: any, snapshot = late) {
  await applyOracleFixture(env.ritual, snapshot, snapshot.jq[0].query);
  const market = await env.predict.read.getMarket([env.id]);
  await fire(env.ritual, market.scheduleId, 0n);
}

describe("the challenge window", () => {
  it("holds the money until it closes", async () => {
    const env = await resolvedFromEarlySnapshot(500);

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimWinnings([env.id], { account: env.bob.account }),
      env.predict,
      "StillDisputable",
    );
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimFee([env.id]),
      env.predict,
      "StillDisputable",
    );

    await passDisputeWindow(env.networkHelpers);
    await env.predict.write.claimWinnings([env.id], { account: env.bob.account });
  });

  it("prices the bond off the pool, with a floor", async () => {
    const env = await resolvedFromEarlySnapshot();
    // 1% of a 4 ETH pool.
    assert.equal(await env.predict.read.disputeBond([env.id]), parseEther("0.04"));

    const small = await setUp();
    await applyOracleFixture(small.ritual, early, early.jq[0].query);
    const id = await openMarket(small.predict, early, early.jq[0].query, TARGET, Comparator.GTE);
    assert.equal(await small.predict.read.disputeBond([id]), MIN_DISPUTE_BOND);
  });

  it("refuses a bond that is too small, and a challenge that is too late", async () => {
    const env = await resolvedFromEarlySnapshot();
    const bond = await env.predict.read.disputeBond([env.id]);

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.dispute([env.id], { value: bond - 1n }),
      env.predict,
      "BondTooSmall",
    );

    await passDisputeWindow(env.networkHelpers);
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.dispute([env.id], { value: bond }),
      env.predict,
      "DisputeWindowClosed",
    );
  });

  it("refuses a challenge before there is anything to challenge", async () => {
    const env = await setUp();
    await applyOracleFixture(env.ritual, early, early.jq[0].query);
    const id = await openMarket(env.predict, early, early.jq[0].query, TARGET, Comparator.GTE);

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.dispute([id], { value: parseEther("1") }),
      env.predict,
      "NotResolved",
    );
  });
});

describe("a challenger who was right", () => {
  it("flips the outcome and takes the bond back", async () => {
    const env = await resolvedFromEarlySnapshot();
    const bond = await env.predict.read.disputeBond([env.id]);

    await env.predict.write.dispute([env.id], {
      account: env.carol.account,
      value: bond,
    });
    let market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.state, MarketState.Disputed);
    assert.equal(market.disputedOutcome, Outcome.No);
    assert.equal(market.outcome, Outcome.Unresolved);
    assert.equal(market.readings.length, 0, "the readings start again");

    await reread(env);

    market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.state, MarketState.Resolved);
    assert.equal(market.outcome, Outcome.Yes, "the second reading disagrees");
    assert.equal(market.observedValue, LATE);
    assert.equal(market.bounty, 0n);

    // Settled by a second reading, so there is nothing left to wait for.
    await env.predict.write.claimWinnings([env.id], { account: env.alice.account });

    await env.viem.assertions.balancesHaveChanged(
      env.predict.write.claimBond([env.id]),
      [{ address: env.carol.account.address, amount: bond }],
    );
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimBond([env.id]),
      env.predict,
      "AlreadySettled",
    );
  });
});

describe("a challenger who was wrong", () => {
  it("loses the bond to the winners", async () => {
    const env = await resolvedFromEarlySnapshot();
    const bond = await env.predict.read.disputeBond([env.id]);

    await env.predict.write.dispute([env.id], {
      account: env.carol.account,
      value: bond,
    });
    await reread(env, early); // the same snapshot, the same answer

    const market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.outcome, Outcome.No, "the reading stands");
    assert.equal(market.bounty, bond);

    // Bob was the whole winning side: he takes the pool and the forfeited bond.
    const [, , , claimable] = await env.predict.read.stakesOf([
      env.id,
      env.bob.account.address,
    ]);
    assert.equal(claimable, parseEther("4") + bond);

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimBond([env.id]),
      env.predict,
      "NothingToClaim",
    );

    await env.predict.write.claimWinnings([env.id], { account: env.bob.account });
    assert.equal(
      await env.ritual.publicClient.getBalance({ address: env.predict.address }),
      0n,
    );
  });

  it("gets one challenge and no more", async () => {
    const env = await resolvedFromEarlySnapshot();
    const bond = await env.predict.read.disputeBond([env.id]);

    await env.predict.write.dispute([env.id], {
      account: env.carol.account,
      value: bond,
    });
    await reread(env, early);

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.dispute([env.id], {
        account: env.bob.account,
        value: bond,
      }),
      env.predict,
      "AlreadyDisputed",
    );
  });
});

describe("a challenge the oracles cannot answer", () => {
  it("refunds everyone and returns the bond", async () => {
    const env = await resolvedFromEarlySnapshot();
    const bond = await env.predict.read.disputeBond([env.id]);

    await env.predict.write.dispute([env.id], {
      account: env.carol.account,
      value: bond,
    });

    await env.ritual.http.write.setReverting([true]);
    const market = await env.predict.read.getMarket([env.id]);
    for (let i = 0; i < 3; i++) await fire(env.ritual, market.scheduleId, BigInt(i));

    const after = await env.predict.read.getMarket([env.id]);
    assert.equal(after.state, MarketState.Invalid);
    assert.equal(after.bondRefundable, true);

    await env.predict.write.claimRefund([env.id], { account: env.alice.account });
    await env.predict.write.claimRefund([env.id], { account: env.bob.account });
    await env.viem.assertions.balancesHaveChanged(
      env.predict.write.claimBond([env.id]),
      [{ address: env.carol.account.address, amount: bond }],
    );
    assert.equal(
      await env.ritual.publicClient.getBalance({ address: env.predict.address }),
      0n,
      "nothing is left stranded",
    );
  });
});
