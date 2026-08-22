/**
 * The creator's cut.
 *
 * Three things matter here: the cut is bounded so a creator cannot write their
 * bettors out of the pool, it is charged only on a market that actually
 * resolved, and the winners' share is computed from what is left rather than
 * from the whole pool.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "viem";
import { applyOracleFixture, fixture } from "./harness/localRitual.ts";
import {
  Comparator,
  MarketState,
  fire,
  openMarket,
  passDisputeWindow,
  reachResolveBlock,
  setUp,
} from "./harness/market.ts";

const priced = fixture("coingecko-eth-usd");
const QUERY = priced.jq[0].query;
const OBSERVED = BigInt(priced.jq[0].value);
const MAX_FEE_BPS = 500;

async function marketWithFee(feeBps: number, target = OBSERVED) {
  const env = await setUp();
  await applyOracleFixture(env.ritual, priced, QUERY);
  const id = await openMarket(
    env.predict,
    priced,
    QUERY,
    target,
    Comparator.GTE,
    "Will the reading clear the target?",
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
  return { ...env, id, scheduleId: market.scheduleId };
}

describe("the creator's cut", () => {
  it("cannot exceed five percent", async () => {
    const { viem, predict } = await setUp();
    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([
        {
          question: "q",
          oracles: [{ url: priced.url, jsonPath: QUERY }],
          quorum: 1,
          target: 1n,
          comparator: Comparator.GTE,
          feeBps: MAX_FEE_BPS + 1,
          bettingSeconds: 30n,
          resolveDelaySeconds: 15n,
        },
      ]),
      predict,
      "BadFee",
    );
  });

  it("comes out of the pool before the winners are paid", async () => {
    const env = await marketWithFee(MAX_FEE_BPS);
    await fire(env.ritual, env.scheduleId, 0n);
    await passDisputeWindow(env.networkHelpers);

    const pool = parseEther("4");
    const expectedFee = (pool * BigInt(MAX_FEE_BPS)) / 10_000n;
    assert.equal(await env.predict.read.feeOf([env.id]), expectedFee);

    // Alice was the whole winning side, so she takes everything that is left.
    const [, , , claimable] = await env.predict.read.stakesOf([
      env.id,
      env.alice.account.address,
    ]);
    assert.equal(claimable, pool - expectedFee);

    await env.viem.assertions.balancesHaveChanged(
      env.predict.write.claimFee([env.id], { account: env.bob.account }),
      [{ address: env.creator.account.address, amount: expectedFee }],
    );

    await env.predict.write.claimWinnings([env.id], { account: env.alice.account });
    assert.equal(
      await env.ritual.publicClient.getBalance({ address: env.predict.address }),
      0n,
      "the pool is fully distributed between the winner and the creator",
    );
  });

  it("changes nothing when it is zero", async () => {
    const env = await marketWithFee(0);
    await fire(env.ritual, env.scheduleId, 0n);
    await passDisputeWindow(env.networkHelpers);

    assert.equal(await env.predict.read.feeOf([env.id]), 0n);
    const [, , , claimable] = await env.predict.read.stakesOf([
      env.id,
      env.alice.account.address,
    ]);
    assert.equal(claimable, parseEther("4"));

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimFee([env.id]),
      env.predict,
      "NothingToClaim",
    );
  });

  it("cannot be taken twice, or before the market resolves", async () => {
    const env = await marketWithFee(MAX_FEE_BPS);

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimFee([env.id]),
      env.predict,
      "NotResolved",
    );

    await fire(env.ritual, env.scheduleId, 0n);
    await passDisputeWindow(env.networkHelpers);
    await env.predict.write.claimFee([env.id]);
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimFee([env.id]),
      env.predict,
      "AlreadySettled",
    );
  });

  it("is not charged on a market that hands the stakes back", async () => {
    const env = await setUp();
    await applyOracleFixture(env.ritual, priced, QUERY);

    // Everyone on NO, the honest answer is YES: nobody won, so everybody refunds.
    const id = await openMarket(
      env.predict,
      priced,
      QUERY,
      OBSERVED,
      Comparator.GTE,
      "nobody wins this",
      { feeBps: MAX_FEE_BPS },
    );
    await env.predict.write.bet([id, false], {
      account: env.alice.account,
      value: parseEther("2"),
    });

    await reachResolveBlock(env.networkHelpers);
    const market = await env.predict.read.getMarket([id]);
    await fire(env.ritual, market.scheduleId, 0n);

    assert.equal(
      (await env.predict.read.getMarket([id])).state,
      MarketState.Invalid,
    );
    assert.equal(await env.predict.read.feeOf([id]), 0n);
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimFee([id]),
      env.predict,
      "NotResolved",
    );

    await env.viem.assertions.balancesHaveChanged(
      env.predict.write.claimRefund([id], { account: env.alice.account }),
      [{ address: env.alice.account.address, amount: parseEther("2") }],
    );
  });
});
