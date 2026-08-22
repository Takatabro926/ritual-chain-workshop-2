/**
 * Positions as tokens.
 *
 * A bet mints an ERC-721. Moving it moves the stake, so every view and every
 * payout keeps working off the same per-account totals — the token is the way a
 * position changes hands, not a second set of books.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "viem";
import { applyOracleFixture, fixture } from "./harness/localRitual.ts";
import {
  Comparator,
  fire,
  openMarket,
  passDisputeWindow,
  reachResolveBlock,
  setUp,
} from "./harness/market.ts";

const priced = fixture("coingecko-eth-usd");
const QUERY = priced.jq[0].query;
const OBSERVED = BigInt(priced.jq[0].value);

async function marketWithBets() {
  const env = await setUp();
  await applyOracleFixture(env.ritual, priced, QUERY);
  const id = await openMarket(env.predict, priced, QUERY, OBSERVED, Comparator.GTE);
  await env.predict.write.bet([id, true], {
    account: env.alice.account,
    value: parseEther("3"),
  });
  await env.predict.write.bet([id, false], {
    account: env.bob.account,
    value: parseEther("1"),
  });
  return { ...env, id, aliceToken: 1n, bobToken: 2n };
}

async function resolve(env: any) {
  await reachResolveBlock(env.networkHelpers);
  const market = await env.predict.read.getMarket([env.id]);
  await fire(env.ritual, market.scheduleId, 0n);
  await passDisputeWindow(env.networkHelpers);
}

describe("a bet as a token", () => {
  it("mints one, and it says what it stands for", async () => {
    const env = await marketWithBets();

    assert.equal(await env.predict.read.totalMinted(), 2n);
    assert.equal(await env.predict.read.name(), "RitualPredict Position");
    assert.equal(await env.predict.read.symbol(), "RPOS");

    assert.equal(
      (await env.predict.read.ownerOf([env.aliceToken])).toLowerCase(),
      env.alice.account.address.toLowerCase(),
    );
    assert.equal(await env.predict.read.balanceOf([env.alice.account.address]), 1n);

    const [marketId, isYes, amount] = await env.predict.read.positions([
      env.aliceToken,
    ]);
    assert.equal(marketId, env.id);
    assert.equal(isYes, true);
    assert.equal(amount, parseEther("3"));
  });

  it("announces itself as an ERC-721", async () => {
    const { predict } = await setUp();
    for (const id of ["0x01ffc9a7", "0x80ac58cd", "0x5b5e139f"])
      assert.equal(await predict.read.supportsInterface([id]), true);
    assert.equal(await predict.read.supportsInterface(["0xdeadbeef"]), false);
  });

  it("has nothing to say about a token that was never minted", async () => {
    const { viem, predict } = await setUp();
    for (const call of [predict.read.ownerOf([99n]), predict.read.getApproved([99n])])
      await viem.assertions.revertWithCustomError(call, predict, "NoSuchToken");
  });

  it("lets nobody but the owner hand out approvals", async () => {
    const env = await marketWithBets();
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.approve([env.carol.account.address, env.aliceToken], {
        account: env.bob.account,
      }),
      env.predict,
      "NotAuthorised",
    );
  });
});

describe("moving a position", () => {
  it("moves the stake with it", async () => {
    const env = await marketWithBets();

    await env.predict.write.transferFrom(
      [env.alice.account.address, env.carol.account.address, env.aliceToken],
      { account: env.alice.account },
    );

    const [aliceYes] = await env.predict.read.stakesOf([
      env.id,
      env.alice.account.address,
    ]);
    const [carolYes] = await env.predict.read.stakesOf([
      env.id,
      env.carol.account.address,
    ]);
    assert.equal(aliceYes, 0n);
    assert.equal(carolYes, parseEther("3"));

    // The pool itself did not move.
    const market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.totalYes, parseEther("3"));
    assert.equal(market.totalNo, parseEther("1"));
  });

  it("moves a NO position the same way", async () => {
    const env = await marketWithBets();
    await env.predict.write.transferFrom(
      [env.bob.account.address, env.carol.account.address, env.bobToken],
      { account: env.bob.account },
    );

    const [, bobNo] = await env.predict.read.stakesOf([
      env.id,
      env.bob.account.address,
    ]);
    const [, carolNo] = await env.predict.read.stakesOf([
      env.id,
      env.carol.account.address,
    ]);
    assert.equal(bobNo, 0n);
    assert.equal(carolNo, parseEther("1"));
  });

  it("hands the payout to whoever holds it at the end", async () => {
    const env = await marketWithBets();
    await env.predict.write.transferFrom(
      [env.alice.account.address, env.carol.account.address, env.aliceToken],
      { account: env.alice.account },
    );
    await resolve(env);

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.claimWinnings([env.id], { account: env.alice.account }),
      env.predict,
      "NothingToClaim",
    );
    await env.viem.assertions.balancesHaveChanged(
      env.predict.write.claimWinnings([env.id], { account: env.carol.account }),
      [{ address: env.carol.account.address, amount: parseEther("4") }],
    );
  });

  it("is refused once the holder has been paid", async () => {
    const env = await marketWithBets();
    await resolve(env);
    await env.predict.write.claimWinnings([env.id], { account: env.alice.account });

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.transferFrom(
        [env.alice.account.address, env.carol.account.address, env.aliceToken],
        { account: env.alice.account },
      ),
      env.predict,
      "AlreadySettled",
    );
  });

  it("respects approvals and refuses everyone else", async () => {
    const env = await marketWithBets();

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.transferFrom(
        [env.alice.account.address, env.carol.account.address, env.aliceToken],
        { account: env.bob.account },
      ),
      env.predict,
      "NotAuthorised",
    );

    await env.predict.write.approve([env.bob.account.address, env.aliceToken], {
      account: env.alice.account,
    });
    assert.equal(
      (await env.predict.read.getApproved([env.aliceToken])).toLowerCase(),
      env.bob.account.address.toLowerCase(),
    );
    await env.predict.write.transferFrom(
      [env.alice.account.address, env.carol.account.address, env.aliceToken],
      { account: env.bob.account },
    );

    // The approval does not survive the move.
    assert.equal(
      await env.predict.read.getApproved([env.aliceToken]),
      "0x0000000000000000000000000000000000000000",
    );
  });

  it("supports an operator for everything an account holds", async () => {
    const env = await marketWithBets();
    await env.predict.write.setApprovalForAll([env.bob.account.address, true], {
      account: env.alice.account,
    });
    assert.equal(
      await env.predict.read.isApprovedForAll([
        env.alice.account.address,
        env.bob.account.address,
      ]),
      true,
    );
    await env.predict.write.transferFrom(
      [env.alice.account.address, env.carol.account.address, env.aliceToken],
      { account: env.bob.account },
    );
    assert.equal(
      (await env.predict.read.ownerOf([env.aliceToken])).toLowerCase(),
      env.carol.account.address.toLowerCase(),
    );
  });

  it("refuses a wrong owner and the zero address", async () => {
    const env = await marketWithBets();
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.transferFrom(
        [env.bob.account.address, env.carol.account.address, env.aliceToken],
        { account: env.bob.account },
      ),
      env.predict,
      "NotOwner",
    );
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.transferFrom(
        [
          env.alice.account.address,
          "0x0000000000000000000000000000000000000000",
          env.aliceToken,
        ],
        { account: env.alice.account },
      ),
      env.predict,
      "ZeroRecipient",
    );
    await env.viem.assertions.revertWithCustomError(
      env.predict.read.balanceOf(["0x0000000000000000000000000000000000000000"]),
      env.predict,
      "ZeroRecipient",
    );
  });
});

describe("safe transfers", () => {
  it("refuses a contract that cannot say it accepts tokens", async () => {
    const env = await marketWithBets();
    const deaf = await env.viem.deployContract("RejectsEther");

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.safeTransferFrom([
        env.alice.account.address,
        deaf.address,
        env.aliceToken,
      ], { account: env.alice.account }),
      env.predict,
      "UnsafeRecipient",
    );
  });

  it("refuses a contract that answers with the wrong selector", async () => {
    const env = await marketWithBets();
    const impostor = await env.viem.deployContract("WrongSelectorHolder");

    await env.viem.assertions.revertWithCustomError(
      env.predict.write.safeTransferFrom([
        env.alice.account.address,
        impostor.address,
        env.aliceToken,
      ], { account: env.alice.account }),
      env.predict,
      "UnsafeRecipient",
    );
  });

  it("lets a contract hold a position and claim on it", async () => {
    const env = await marketWithBets();
    const holder = await env.viem.deployContract("PositionHolder");

    await env.predict.write.safeTransferFrom([
      env.alice.account.address,
      holder.address,
      env.aliceToken,
    ], { account: env.alice.account });
    assert.equal(
      (await env.predict.read.ownerOf([env.aliceToken])).toLowerCase(),
      holder.address.toLowerCase(),
    );

    await resolve(env);
    await env.viem.assertions.balancesHaveChanged(
      holder.write.claim([env.predict.address, env.id]),
      [{ address: holder.address, amount: parseEther("4") }],
    );
  });
});
