/**
 * The 13-field payload the contract sends to 0x0801.
 *
 * The stand-in stores it raw and this test decodes it independently, so the
 * assertion does not rely on the stand-in and the contract agreeing about the
 * layout — an agreement that would be worthless if both were wrong.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeAbiParameters, parseEther } from "viem";
import { applyOracleFixture, fixture } from "./harness/localRitual.ts";
import {
  Comparator,
  fire,
  openMarket,
  reachResolveBlock,
  setUp,
} from "./harness/market.ts";

const HTTP_REQUEST_FIELDS = [
  { type: "address" }, //  0 executor
  { type: "bytes[]" }, //  1 encryptedSecrets
  { type: "uint256" }, //  2 ttl
  { type: "bytes[]" }, //  3 secretSignatures
  { type: "bytes" }, //  4 userPublicKey
  { type: "string" }, //  5 url
  { type: "uint8" }, //  6 method
  { type: "string[]" }, //  7 headersKeys
  { type: "string[]" }, //  8 headersValues
  { type: "bytes" }, //  9 body
  { type: "uint256" }, // 10 dkmsKeyIndex
  { type: "uint8" }, // 11 dkmsKeyFormat
  { type: "bool" }, // 12 piiEnabled
] as const;

const priced = fixture("coingecko-eth-usd");
const QUERY = priced.jq[0].query;

describe("the HTTP request", () => {
  it("carries the market's own url and nothing it was not given", async () => {
    const env = await setUp();
    await applyOracleFixture(env.ritual, priced, QUERY);

    const id = await openMarket(
      env.predict,
      priced,
      QUERY,
      1n,
      Comparator.GTE,
    );
    await env.predict.write.bet([id, true], {
      account: env.alice.account,
      value: parseEther("1"),
    });
    await reachResolveBlock(env.networkHelpers);

    const market = await env.predict.read.getMarket([id]);
    await fire(env.ritual, market.scheduleId, 0n);

    const raw = await env.ritual.http.read.lastRequest();
    const [
      executor,
      encryptedSecrets,
      ttl,
      secretSignatures,
      userPublicKey,
      url,
      method,
      headerKeys,
      headerValues,
      body,
      dkmsKeyIndex,
      dkmsKeyFormat,
      piiEnabled,
    ] = decodeAbiParameters(HTTP_REQUEST_FIELDS, raw);

    const attempts = await env.ritual.publicClient.getContractEvents({
      address: env.predict.address,
      abi: env.predict.abi,
      eventName: "ResolutionAttempted",
      fromBlock: 0n,
    });
    assert.equal(
      executor.toLowerCase(),
      (attempts[0].args.executor as string).toLowerCase(),
      "the request goes to the executor the registry chose",
    );

    assert.equal(url, priced.url, "the url is the market's, unchanged");
    assert.equal(method, 1, "GET; 0 is rejected by the chain");
    assert.equal(ttl, 100n, "HTTP_TTL_BLOCKS");

    // A price read needs no credentials, no headers and no body. Anything here
    // would be something the contract invented on the caller's behalf.
    assert.deepEqual(encryptedSecrets, []);
    assert.deepEqual(secretSignatures, []);
    assert.equal(userPublicKey, "0x", "no output encryption requested");
    assert.deepEqual(headerKeys, []);
    assert.deepEqual(headerValues, []);
    assert.equal(body, "0x");
    assert.equal(dkmsKeyIndex, 0n);
    assert.equal(dkmsKeyFormat, 0);
    assert.equal(piiEnabled, false);
  });

  it("sends one request per attempt and no more", async () => {
    const env = await setUp();
    await env.ritual.http.write.setUnsettled([true]);

    const id = await openMarket(env.predict, priced, QUERY, 1n, Comparator.GTE);
    await env.predict.write.bet([id, true], {
      account: env.alice.account,
      value: parseEther("1"),
    });
    await reachResolveBlock(env.networkHelpers);
    const market = await env.predict.read.getMarket([id]);

    await fire(env.ritual, market.scheduleId, 0n);
    await fire(env.ritual, market.scheduleId, 1n);

    const attempts = await env.ritual.publicClient.getContractEvents({
      address: env.predict.address,
      abi: env.predict.abi,
      eventName: "ResolutionAttempted",
      fromBlock: 0n,
    });
    assert.equal(attempts.length, 2);
    assert.equal((await env.predict.read.getMarket([id])).attempts, 2);
  });
});
