/**
 * What the pool does after the outcome is known: the pari-mutuel split, the
 * market nobody won, refunds, and the exact size of the rounding dust the
 * README calls negligible.
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
  reachResolveBlock,
  setUp,
} from "./harness/market.ts";

const priced = fixture("coingecko-eth-usd");
const QUERY = priced.jq[0].query;
const OBSERVED = BigInt(priced.jq[0].value);

/** A market that will resolve YES, with the given stakes already placed. */
async function resolvedMarket(stakes: { yes: bigint[]; no: bigint[] }) {
  const env = await setUp();
  await applyOracleFixture(env.ritual, priced, QUERY);
  const id = await openMarket(env.predict, priced, QUERY, OBSERVED, Comparator.GTE);

  const backers = [env.alice, env.bob, env.carol];
  for (const [i, amount] of stakes.yes.entries())
    await env.predict.write.bet([id, true], {
      account: backers[i].account,
      value: amount,
    });
  for (const [i, amount] of stakes.no.entries())
    await env.predict.write.bet([id, false], {
      account: backers[stakes.yes.length + i].account,
      value: amount,
    });

  await reachResolveBlock(env.networkHelpers);
  const market = await env.predict.read.getMarket([id]);
  await fire(env.ritual, market.scheduleId, 0n);
  return { ...env, id };
}

describe("pari-mutuel payouts", () => {
  it("pays each winner their share of the whole pool", async () => {
    const env = await resolvedMarket({
      yes: [parseEther("1"), parseEther("2")],
      no: [parseEther("1")],
    });

    // pool 4, winning side 3: 1/3 and 2/3 of everything.
    const [, , , aliceClaimable] = await env.predict.read.stakesOf([
      env.id,
      env.alice.account.address,
    ]);
    const [, , , bobClaimable] = await env.predict.read.stakesOf([
      env.id,
      env.bob.account.address,
    ]);
    assert.equal(aliceClaimable, 1333333333333333333n);
    assert.equal(bobClaimable, 2666666666666666666n);

    await env.viem.assertions.balancesHaveChanged(
      env.predict.write.claimWinnings([env.id], { account: env.alice.account }),
      [{ address: env.alice.account.address, amount: aliceClaimable }],
    );
  });

  it("leaves less than one wei per winner behind", async () => {
    const env = await resolvedMarket({
      yes: [parseEther("1"), parseEther("2")],
      no: [parseEther("1")],
    });

    await env.predict.write.claimWinnings([env.id], { account: env.alice.account });
    await env.predict.write.claimWinnings([env.id], { account: env.bob.account });

    const dust = await env.ritual.publicClient.getBalance({
      address: env.predict.address,
    });

    // Integer division truncates once per claimant, so the pool can never lose
    // more than one wei per winner. Here that ceiling is 2 and the actual
    // remainder is 1 wei out of 4 ETH.
    assert.equal(dust, 1n);
    assert.ok(dust < 2n);
  });

  it("refuses a claim before the market has resolved", async () => {
    const env = await setUp();
    await applyOracleFixture(env.ritual, priced, QUERY);
    const id = await openMarket(env.predict, priced, QUERY, OBSERVED, Comparator.GTE);
    await env.predict.write.bet([id, true], {
      account: env.alice.account,
      value: parseEther("1"),
    });

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimWinnings([id], { account: env.alice.account }),
      env.predict,
      "NotResolved",
    );
  });

  it("refuses the losing side and refuses a second claim", async () => {
    const env = await resolvedMarket({
      yes: [parseEther("1")],
      no: [parseEther("1")],
    });

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimWinnings([env.id], { account: env.bob.account }),
      env.predict,
      "NothingToClaim",
    );

    await env.predict.write.claimWinnings([env.id], { account: env.alice.account });
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimWinnings([env.id], { account: env.alice.account }),
      env.predict,
      "AlreadySettled",
    );
  });

  it("does not offer a refund on a market that resolved", async () => {
    const env = await resolvedMarket({
      yes: [parseEther("1")],
      no: [parseEther("1")],
    });
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimRefund([env.id], { account: env.bob.account }),
      env.predict,
      "NotInvalid",
    );
  });
});

describe("a market nobody won", () => {
  it("records the reading and then hands every stake back", async () => {
    const env = await setUp();
    await applyOracleFixture(env.ritual, priced, QUERY);

    // Everyone backs NO; the honest answer is YES, so the winning pool is empty.
    const id = await openMarket(env.predict, priced, QUERY, OBSERVED, Comparator.GTE);
    await env.predict.write.bet([id, false], {
      account: env.alice.account,
      value: parseEther("2"),
    });
    await env.predict.write.bet([id, false], {
      account: env.bob.account,
      value: parseEther("1"),
    });

    await reachResolveBlock(env.networkHelpers);
    const before = await env.predict.read.getMarket([id]);
    await fire(env.ritual, before.scheduleId, 0n);

    const market = await env.predict.read.getMarket([id]);
    assert.equal(market.state, MarketState.Invalid);
    assert.equal(market.invalidReason, "nobody backed the winning side");
    // The read still stands; it just has nobody to pay.
    assert.equal(market.outcome, Outcome.Yes);
    assert.equal(market.observedValue, OBSERVED);

    for (const backer of [env.alice, env.bob]) {
      const [yes, no, , claimable] = await env.predict.read.stakesOf([
        id,
        backer.account.address,
      ]);
      assert.equal(claimable, yes + no, "the whole stake comes back");
    }

    await env.viem.assertions.balancesHaveChanged(
      env.predict.write.claimRefund([id], { account: env.alice.account }),
      [{ address: env.alice.account.address, amount: parseEther("2") }],
    );
    await env.predict.write.claimRefund([id], { account: env.bob.account });

    assert.equal(
      await env.ritual.publicClient.getBalance({ address: env.predict.address }),
      0n,
      "a refunded market keeps nothing",
    );
  });

  it("refuses a second refund and refuses a stranger", async () => {
    const env = await setUp();
    await applyOracleFixture(env.ritual, priced, QUERY);
    const id = await openMarket(env.predict, priced, QUERY, OBSERVED, Comparator.GTE);
    await env.predict.write.bet([id, false], {
      account: env.alice.account,
      value: parseEther("1"),
    });

    await reachResolveBlock(env.networkHelpers);
    const market = await env.predict.read.getMarket([id]);
    await fire(env.ritual, market.scheduleId, 0n);

    await env.predict.write.claimRefund([id], { account: env.alice.account });
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimRefund([id], { account: env.alice.account }),
      env.predict,
      "AlreadySettled",
    );
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimRefund([id], { account: env.carol.account }),
      env.predict,
      "NothingToClaim",
    );
  });
});
