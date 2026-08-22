/**
 * Drives one market from creation to payout on a real node and checks the
 * result. Exits non-zero if anything is off, which is what makes it worth
 * running in CI.
 *
 *   npx hardhat node
 *   npx hardhat run scripts/verify-lifecycle.ts --network localhost
 *
 * The unit suite runs against an in-process chain. This runs against a node
 * started as a separate process, over JSON-RPC, exactly as a person would.
 */
import assert from "node:assert/strict";
import { network } from "hardhat";
import { formatEther, parseEther } from "viem";
import {
  BLOCK_TIME_MS,
  RITUAL,
  installStandIns,
  recorded,
  serveRecorded,
} from "./lib/local-ritual.ts";

const MarketState = { Open: 0, Closed: 1, Resolving: 2, Resolved: 3, Invalid: 4, Disputed: 5 };
const Outcome = { Unresolved: 0, Yes: 1, No: 2 };

const { viem, provider } = await network.getOrCreate("localhost");
const publicClient = await viem.getPublicClient();
const [creator, alice, bob] = await viem.getWalletClients();

const mine = (blocks: bigint) =>
  provider.request({ method: "hardhat_mine", params: [`0x${blocks.toString(16)}`] });

console.log("installing stand-ins");
const ritual = await installStandIns(viem, provider, false);

const priced = recorded("coingecko-eth-usd");
const observed = BigInt(priced.jq[0].value);
await serveRecorded(ritual, priced);

console.log("deploying and funding");
const predict = await viem.deployContract("RitualPredict", [BLOCK_TIME_MS]);
await predict.write.fundExecution([100_000n], { value: parseEther("1") });
assert.equal(await predict.read.executionBalance(), parseEther("1"));

console.log("creating a market");
await predict.write.createMarket([
  {
    question: "Will the recorded reading clear the target?",
    oracles: [{ url: priced.url, jsonPath: priced.jq[0].query }],
    quorum: 1,
    target: observed - 1000n,
    comparator: 1, // at least
    feeBps: 100,
    bettingSeconds: 30n,
    resolveDelaySeconds: 15n,
  },
]);

await predict.write.bet([1n, true], {
  account: alice.account,
  value: parseEther("3"),
});
await predict.write.bet([1n, false], {
  account: bob.account,
  value: parseEther("1"),
});

let market = await predict.read.getMarket([1n]);
assert.equal(market.state, MarketState.Open, "market should be taking bets");
assert.equal(market.totalYes, parseEther("3"));
assert.equal(market.totalNo, parseEther("1"));

console.log("mining to the scheduled block");
await mine(market.resolveBlock - (await publicClient.getBlockNumber()) + 1n);
market = await predict.read.getMarket([1n]);
assert.equal(market.state, MarketState.Closed, "betting should have closed");

console.log("running the scheduled execution");
await ritual.scheduler.write.fire([market.scheduleId, 0n], { gas: 6_000_000n });

market = await predict.read.getMarket([1n]);
assert.equal(market.state, MarketState.Resolved, "market should have resolved");
assert.equal(market.outcome, Outcome.Yes, "the reading clears the target");
assert.equal(market.observedValue, observed, "settled on the recorded reading");
assert.equal(market.attempts, 1, "one attempt was enough");
assert.equal(
  await ritual.scheduler.read.getCallState([market.scheduleId]),
  3,
  "the unused executions should be cancelled",
);

console.log("waiting out the challenge window");
await assert.rejects(
  predict.write.claimWinnings([1n], { account: alice.account }),
  "claims must be shut while the market can still be challenged",
);
await mine(market.disputeUntil - (await publicClient.getBlockNumber()) + 1n);

console.log("claiming");
const pool = parseEther("4");
const fee = (pool * 100n) / 10_000n;
const [, , , claimable] = await predict.read.stakesOf([1n, alice.account.address]);
assert.equal(claimable, pool - fee, "alice takes the pool less the creator's cut");

await predict.write.claimWinnings([1n], { account: alice.account });
await predict.write.claimFee([1n], { account: creator.account });

const left = await publicClient.getBalance({ address: predict.address });
assert.ok(left < 10n, `contract should be all but empty, holds ${left} wei`);

console.log("");
console.log(`settled on ${observed}, paid ${formatEther(pool - fee)}, fee ${formatEther(fee)}`);
console.log(`${left} wei of rounding dust left behind`);
console.log("lifecycle OK");
