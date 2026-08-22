/**
 * The branches the main scenarios never reach: a nonsense deployment, calls
 * about markets that do not exist, a wake-up that arrives too early, a chain so
 * slow a whole window fits in one block, and a winner who cannot be paid.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "viem";
import {
  applyOracleFixture,
  fixture,
  installLocalRitual,
  RITUAL,
} from "./harness/localRitual.ts";
import {
  Comparator,
  MarketState,
  fire,
  openMarket,
  passDisputeWindow,
  reachResolveBlock,
  setUp,
} from "./harness/market.ts";
import { network } from "hardhat";

const priced = fixture("coingecko-eth-usd");
const QUERY = priced.jq[0].query;
const OBSERVED = BigInt(priced.jq[0].value);

describe("deployment", () => {
  it("refuses a block time of zero", async () => {
    const { viem } = await network.create();
    await installLocalRitual(viem);
    await assert.rejects(viem.deployContract("RitualPredict", [0n]));
  });

  it("gives a window at least one block on a chain slower than the window", async () => {
    const { viem, networkHelpers } = await network.create();
    await installLocalRitual(viem);

    // A minute per block, against a thirty second betting window.
    const predict = await viem.deployContract("RitualPredict", [60_000n]);
    await predict.write.fundExecution([1000n], { value: parseEther("0.1") });
    const before = await (await viem.getPublicClient()).getBlockNumber();

    const id = await openMarket(predict, priced, QUERY, 1n, Comparator.GTE);
    const market = await predict.read.getMarket([id]);

    assert.equal(Number(market.closeBlock), Number(before) + 1 + 1);
    assert.equal(Number(market.resolveBlock), Number(market.closeBlock) + 1);
  });
});

describe("calls about markets that do not exist", () => {
  it("rejects a bet on one", async () => {
    const { viem, predict } = await setUp();
    await viem.assertions.revertWithCustomError(
      predict.write.bet([99n, true], { value: parseEther("1") }),
      predict,
      "UnknownMarket",
    );
  });

  it("lets the Scheduler wake it about one, quietly", async () => {
    const env = await setUp();
    await env.networkHelpers.impersonateAccount(RITUAL.SCHEDULER);
    await env.networkHelpers.setBalance(RITUAL.SCHEDULER, parseEther("1"));

    // No revert: the callback must never fail on anything but authorisation.
    await env.predict.write.onScheduledResolve([0n, 99n], {
      account: RITUAL.SCHEDULER,
    });
    assert.equal(await env.predict.read.marketCount(), 0n);
  });
});

describe("a wake-up before betting closed", () => {
  it("changes nothing and does not spend an attempt", async () => {
    const env = await setUp();
    await applyOracleFixture(env.ritual, priced, QUERY);
    const id = await openMarket(env.predict, priced, QUERY, OBSERVED, Comparator.GTE);

    await env.networkHelpers.impersonateAccount(RITUAL.SCHEDULER);
    await env.networkHelpers.setBalance(RITUAL.SCHEDULER, parseEther("1"));
    await env.predict.write.onScheduledResolve([0n, id], {
      account: RITUAL.SCHEDULER,
    });

    const market = await env.predict.read.getMarket([id]);
    assert.equal(market.state, MarketState.Open);
    assert.equal(market.attempts, 0);
  });
});

describe("funding execution", () => {
  it("refuses a zero deposit", async () => {
    const { viem, predict } = await setUp();
    await viem.assertions.revertWithCustomError(
      predict.write.fundExecution([1000n], { value: 0n }),
      predict,
      "ZeroStake",
    );
  });
});

describe("a winner who cannot be paid", () => {
  it("reverts the claim rather than losing the payout", async () => {
    const env = await setUp();
    await applyOracleFixture(env.ritual, priced, QUERY);
    const id = await openMarket(env.predict, priced, QUERY, OBSERVED, Comparator.GTE);

    const stubborn = await env.viem.deployContract("RejectsEther");
    await stubborn.write.bet([env.predict.address, id, true], {
      value: parseEther("2"),
    });
    await env.predict.write.bet([id, false], {
      account: env.bob.account,
      value: parseEther("1"),
    });

    await reachResolveBlock(env.networkHelpers);
    const market = await env.predict.read.getMarket([id]);
    await fire(env.ritual, market.scheduleId, 0n);
    await passDisputeWindow(env.networkHelpers);
    assert.equal(
      (await env.predict.read.getMarket([id])).state,
      MarketState.Resolved,
    );

    await env.viem.assertions.revertWithCustomError(
      stubborn.write.claim([env.predict.address, id]),
      env.predict,
      "TransferFailed",
    );

    // The stake is still there and still claimable; nothing was written off.
    const [, , settled, claimable] = await env.predict.read.stakesOf([
      id,
      stubborn.address,
    ]);
    assert.equal(settled, false);
    assert.equal(claimable, parseEther("3"));
  });
});
