/**
 * Resolution: the comparator table, every way an oracle read can miss, what a
 * miss costs, and what happens once the attempts run out.
 *
 * The rule under all of it: a failed read is never a NO.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodePacked, keccak256, parseEther, stringToHex } from "viem";
import {
  applyOracleFixture,
  fixture,
  JQ_OUT_UINT256,
  RITUAL,
} from "./harness/localRitual.ts";
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

const priced = fixture("coingecko-eth-usd");
const QUERY = priced.jq[0].query;
const OBSERVED = BigInt(priced.jq[0].value);

async function readyMarket(
  target: bigint,
  comparator: number,
  options: { executors?: `0x${string}`[] } = {},
) {
  const env = await setUp(options);
  await applyOracleFixture(env.ritual, priced, QUERY);
  const id = await openMarket(env.predict, priced, QUERY, target, comparator);

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

async function failedReasons(predict: any, ritual: any) {
  const logs = await ritual.publicClient.getContractEvents({
    address: predict.address,
    abi: predict.abi,
    eventName: "ResolutionFailed",
    fromBlock: 0n,
  });
  return logs.map((l: any) => l.args.reason as string);
}

describe("comparators", () => {
  const cases = [
    { name: "GT above target", comparator: Comparator.GT, target: OBSERVED - 1n, outcome: Outcome.Yes },
    { name: "GT at target", comparator: Comparator.GT, target: OBSERVED, outcome: Outcome.No },
    { name: "GTE at target", comparator: Comparator.GTE, target: OBSERVED, outcome: Outcome.Yes },
    { name: "GTE above target", comparator: Comparator.GTE, target: OBSERVED + 1n, outcome: Outcome.No },
    { name: "LT below target", comparator: Comparator.LT, target: OBSERVED + 1n, outcome: Outcome.Yes },
    { name: "LT at target", comparator: Comparator.LT, target: OBSERVED, outcome: Outcome.No },
    { name: "LTE at target", comparator: Comparator.LTE, target: OBSERVED, outcome: Outcome.Yes },
    { name: "LTE below target", comparator: Comparator.LTE, target: OBSERVED - 1n, outcome: Outcome.No },
  ];

  for (const c of cases) {
    it(`resolves ${c.name}`, async () => {
      const env = await readyMarket(c.target, c.comparator);
      await fire(env.ritual, env.scheduleId, 0n);

      const market = await env.predict.read.getMarket([env.id]);
      assert.equal(market.state, MarketState.Resolved);
      assert.equal(market.outcome, c.outcome);
      assert.equal(market.observedValue, OBSERVED);
      assert.equal(market.attempts, 1);
    });
  }
});

describe("a resolved market", () => {
  it("stops paying for the retries it no longer needs", async () => {
    const env = await readyMarket(OBSERVED, Comparator.GTE);
    assert.equal(await env.ritual.scheduler.read.getCallState([env.scheduleId]), 1);

    await fire(env.ritual, env.scheduleId, 0n);
    assert.equal(
      await env.ritual.scheduler.read.getCallState([env.scheduleId]),
      3,
      "the booking is cancelled once the outcome is final",
    );
  });

  it("ignores a leftover execution instead of re-resolving", async () => {
    const env = await readyMarket(OBSERVED, Comparator.GTE);
    await fire(env.ritual, env.scheduleId, 0n);
    const settled = await env.predict.read.getMarket([env.id]);

    // Straight from the Scheduler address, bypassing the cancelled booking.
    await env.networkHelpers.impersonateAccount(RITUAL.SCHEDULER);
    await env.networkHelpers.setBalance(RITUAL.SCHEDULER, parseEther("1"));
    await env.predict.write.onScheduledResolve([1n, env.id], {
      account: RITUAL.SCHEDULER,
    });

    const after = await env.predict.read.getMarket([env.id]);
    assert.equal(after.attempts, settled.attempts);
    assert.equal(after.outcome, settled.outcome);
    assert.equal(after.observedValue, settled.observedValue);
  });

  it("only answers the Scheduler", async () => {
    const env = await readyMarket(OBSERVED, Comparator.GTE);
    await env.viem.assertions.revertWithCustomError(
      env.predict.write.onScheduledResolve([0n, env.id], {
        account: env.alice.account,
      }),
      env.predict,
      "OnlyScheduler",
    );
  });
});

describe("a missed read", () => {
  const misses: {
    name: string;
    reason: string;
    arrange: (env: any) => Promise<void>;
  }[] = [
    {
      name: "no executor in the registry",
      reason: "no TEE executor available",
      arrange: async (env) => env.ritual.registry.write.setMode([1]),
    },
    {
      name: "a registry that reverts",
      reason: "no TEE executor available",
      arrange: async (env) => env.ritual.registry.write.setMode([2]),
    },
    {
      name: "a precompile that refuses the call",
      reason: "http precompile call failed",
      arrange: async (env) => env.ritual.http.write.setReverting([true]),
    },
    {
      name: "an async output that has not settled",
      reason: "http response undecodable or unsettled",
      arrange: async (env) => env.ritual.http.write.setUnsettled([true]),
    },
    {
      name: "an executor error message",
      reason: "tee executor timed out",
      arrange: async (env) =>
        env.ritual.http.write.setResponse([
          200,
          [],
          [],
          stringToHex("{}"),
          "tee executor timed out",
        ]),
    },
    {
      name: "a non-200 response",
      reason: "oracle returned non-200",
      arrange: async (env) => {
        const rec = fixture("github-not-found");
        await applyOracleFixture(env.ritual, rec, rec.jq[0].query);
      },
    },
    {
      name: "an empty body",
      reason: "oracle returned an empty body",
      arrange: async (env) =>
        env.ritual.http.write.setResponse([200, [], [], "0x", ""]),
    },
    {
      name: "a body jq cannot read",
      reason: "jsonPath did not yield a number",
      arrange: async (env) => {
        const rec = fixture("html-not-json");
        await env.ritual.http.write.setResponse([
          rec.status,
          rec.headerKeys,
          rec.headerValues,
          stringToHex(rec.body),
          "",
        ]);
      },
    },
  ];

  for (const miss of misses) {
    it(`is never a NO: ${miss.name}`, async () => {
      const env = await readyMarket(OBSERVED, Comparator.GTE);
      await miss.arrange(env);

      await fire(env.ritual, env.scheduleId, 0n);

      const market = await env.predict.read.getMarket([env.id]);
      assert.equal(market.state, MarketState.Resolving);
      assert.equal(market.outcome, Outcome.Unresolved);
      assert.equal(market.attempts, 1);
      assert.deepEqual(await failedReasons(env.predict, env.ritual), [
        miss.reason,
      ]);
    });
  }

  it("gives up only after the booked attempts are exhausted", async () => {
    const env = await readyMarket(OBSERVED, Comparator.GTE);
    await env.ritual.http.write.setReverting([true]);

    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      await fire(env.ritual, env.scheduleId, BigInt(i));
      const mid = await env.predict.read.getMarket([env.id]);
      assert.equal(mid.state, MarketState.Resolving, `still trying after ${i + 1}`);
      assert.equal(mid.attempts, i + 1);
    }

    await fire(env.ritual, env.scheduleId, BigInt(MAX_ATTEMPTS - 1));
    const market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.state, MarketState.Invalid);
    assert.equal(market.attempts, MAX_ATTEMPTS);
    assert.equal(market.invalidReason, "http precompile call failed");
    assert.equal(market.outcome, Outcome.Unresolved);
  });

  it("recovers if a later attempt reaches the oracle", async () => {
    const env = await readyMarket(OBSERVED, Comparator.GTE);
    await env.ritual.http.write.setReverting([true]);
    await fire(env.ritual, env.scheduleId, 0n);

    await applyOracleFixture(env.ritual, priced, QUERY);
    await fire(env.ritual, env.scheduleId, 1n);

    const market = await env.predict.read.getMarket([env.id]);
    assert.equal(market.state, MarketState.Resolved);
    assert.equal(market.attempts, 2);
    assert.equal(market.observedValue, OBSERVED);
  });
});

describe("executor selection", () => {
  const executors = [
    "0x00000000000000000000000000000000000000a1",
    "0x00000000000000000000000000000000000000b2",
    "0x00000000000000000000000000000000000000c3",
    "0x00000000000000000000000000000000000000d4",
  ] as `0x${string}`[];

  it("derives the seed from the market, the attempt, the block and itself", async () => {
    const env = await readyMarket(OBSERVED, Comparator.GTE, { executors });

    const hash = await fire(env.ritual, env.scheduleId, 7n);
    const receipt = await env.ritual.publicClient.getTransactionReceipt({ hash });

    const seed = BigInt(
      keccak256(
        encodePacked(
          ["uint256", "uint256", "uint256", "address"],
          [env.id, 7n, receipt.blockNumber, env.predict.address],
        ),
      ),
    );
    const expected = executors[Number(seed % BigInt(executors.length))];

    const logs = await env.ritual.publicClient.getContractEvents({
      address: env.predict.address,
      abi: env.predict.abi,
      eventName: "ResolutionAttempted",
      fromBlock: 0n,
    });
    assert.equal(logs.length, 1);
    assert.equal(
      (logs[0].args.executor as string).toLowerCase(),
      expected.toLowerCase(),
    );
  });
});
