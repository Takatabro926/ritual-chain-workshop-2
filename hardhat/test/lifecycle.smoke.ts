/**
 * The first thing that has to work: a market created, bet on, woken by the
 * Scheduler, resolved from a recorded oracle response, and paid out — with no
 * human touching it after creation.
 *
 * The broader suite comes later; this file exists to prove the harness carries
 * a whole lifecycle before anything is built on top of it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther } from "viem";
import {
  applyOracleFixture,
  DEFAULT_BLOCK_TIME_MS,
  fixture,
  installLocalRitual,
} from "./harness/localRitual.ts";

const Comparator = { GT: 0, GTE: 1, LT: 2, LTE: 3 } as const;
const MarketState = {
  Open: 0,
  Closed: 1,
  Resolving: 2,
  Resolved: 3,
  Invalid: 4,
} as const;
const Outcome = { Unresolved: 0, Yes: 1, No: 2 } as const;

describe("local lifecycle", async () => {
  const { viem, networkHelpers } = await network.create();

  it("carries a market from creation to payout", async () => {
    const ritual = await installLocalRitual(viem);
    const [creator, alice, bob] = await viem.getWalletClients();

    const predict = await viem.deployContract("RitualPredict", [
      DEFAULT_BLOCK_TIME_MS,
    ]);

    // Prepay the Scheduler and the HTTP precompile out of the contract's own
    // RitualWallet balance; it is the payer of every scheduled execution.
    await predict.write.fundExecution([1000n], { value: parseEther("0.5") });
    assert.equal(await predict.read.executionBalance(), parseEther("0.5"));

    const record = fixture("coingecko-eth-usd");
    const query = record.jq[0].query;
    const observed = await applyOracleFixture(ritual, record, query);
    assert.notEqual(observed, null, "this fixture should parse");

    // Target well below the recorded price, so the honest answer is YES.
    const target = observed! / 2n;

    await predict.write.createMarket([
      {
        question: "Will ETH/USD be above half of what it was?",
        oracleUrl: record.url,
        jsonPath: query,
        target,
        comparator: Comparator.GTE,
        bettingSeconds: 30n,
        resolveDelaySeconds: 15n,
      },
    ]);

    let market = await predict.read.getMarket([1n]);
    assert.equal(market.state, MarketState.Open);
    assert.notEqual(market.scheduleId, 0n, "the market booked its own wake-up");

    await predict.write.bet([1n, true], {
      account: alice.account,
      value: parseEther("3"),
    });
    await predict.write.bet([1n, false], {
      account: bob.account,
      value: parseEther("1"),
    });

    // Past the betting window and up to the scheduled resolution block.
    await networkHelpers.mine(240);
    market = await predict.read.getMarket([1n]);
    assert.equal(market.state, MarketState.Closed, "the view closes the window");

    const ok = await ritual.scheduler.write.fire([market.scheduleId, 0n], {
      gas: 6_000_000n,
    });
    assert.ok(ok);

    market = await predict.read.getMarket([1n]);
    assert.equal(market.state, MarketState.Resolved);
    assert.equal(market.outcome, Outcome.Yes);
    assert.equal(
      market.observedValue,
      observed,
      "the observed value is what real jq returned for the recorded body",
    );
    assert.equal(market.attempts, 1);

    // Pari-mutuel: alice staked 3 of a 4 pool on the winning side, so she takes
    // all 4. Bob backed the losing side and has nothing to claim.
    const [aliceYes, aliceNo, , aliceClaimable] = await predict.read.stakesOf([
      1n,
      alice.account.address,
    ]);
    assert.equal(aliceYes, parseEther("3"));
    assert.equal(aliceNo, 0n);
    assert.equal(aliceClaimable, parseEther("4"));

    const before = await ritual.publicClient.getBalance({
      address: bob.account.address,
    });
    await assert.rejects(
      predict.write.claimWinnings([1n], { account: bob.account }),
      "the losing side cannot claim",
    );
    assert.ok(
      (await ritual.publicClient.getBalance({ address: bob.account.address })) <=
        before,
    );

    await predict.write.claimWinnings([1n], { account: alice.account });
    const [, , alreadySettled, afterClaim] = await predict.read.stakesOf([
      1n,
      alice.account.address,
    ]);
    assert.equal(alreadySettled, true);
    assert.equal(afterClaim, 0n);
  });
});
