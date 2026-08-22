/**
 * Puts a working RitualPredict on a running `hardhat node`.
 *
 *   npx hardhat node                                   # terminal one
 *   npx hardhat run scripts/setup-local-chain.ts --network localhost
 *
 * A bare node has nothing at the precompile or system-contract addresses, and
 * the constructor calls approveScheduler, so the stand-ins go in first. Oracle
 * behaviour comes from fixtures/oracle-responses.json, the same recorded
 * responses the test suite runs against.
 *
 * Prints the address to put in web/.env.local.
 */
import { network } from "hardhat";
import { parseEther } from "viem";
import {
  BLOCK_TIME_MS,
  installStandIns,
  recorded,
  serveRecorded,
} from "./lib/local-ritual.ts";

const { viem, provider } = await network.getOrCreate("localhost");
console.log("installing the stand-ins…");
const ritual = await installStandIns(viem, provider);

const priced = recorded("coingecko-eth-usd");
const kraken = recorded("kraken-eth-usd");
await serveRecorded(ritual, priced);

console.log("deploying RitualPredict…");
const predict = await viem.deployContract("RitualPredict", [BLOCK_TIME_MS]);
await predict.write.fundExecution([100_000n], { value: parseEther("2") });

// One market to look at, priced around what the recorded snapshot actually said.
const observed = BigInt(priced.jq[0].value);
await predict.write.createMarket([
  {
    question: "Will ETH be above the recorded midpoint when this resolves?",
    oracles: [
      { url: priced.url, jsonPath: priced.jq[0].query },
      { url: kraken.url, jsonPath: kraken.jq[0].query },
    ],
    quorum: 1,
    target: observed - 500n,
    comparator: 1, // at least
    feeBps: 100,
    bettingSeconds: 120n,
    resolveDelaySeconds: 60n,
  },
]);

console.log("");
console.log(`RitualPredict  ${predict.address}`);
console.log("");
console.log("Put this in web/.env.local:");
console.log(`  NEXT_PUBLIC_PREDICT_ADDRESS=${predict.address}`);
