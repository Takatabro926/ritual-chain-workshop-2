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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { parseEther, stringToHex } from "viem";

const RITUAL = {
  HTTP_PRECOMPILE: "0x0000000000000000000000000000000000000801",
  JQ_PRECOMPILE: "0x0000000000000000000000000000000000000803",
  SCHEDULER: "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B",
  RITUAL_WALLET: "0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948",
  TEE_SERVICE_REGISTRY: "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F",
} as const;

const STAND_INS = [
  ["LocalScheduler", RITUAL.SCHEDULER],
  ["LocalRitualWallet", RITUAL.RITUAL_WALLET],
  ["LocalTeeRegistry", RITUAL.TEE_SERVICE_REGISTRY],
  ["LocalHttpPrecompile", RITUAL.HTTP_PRECOMPILE],
  ["LocalJqPrecompile", RITUAL.JQ_PRECOMPILE],
] as const;

const BLOCK_TIME_MS = 195n;
const JQ_OUT_UINT256 = 1;

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/oracle-responses.json", import.meta.url)),
    "utf8",
  ),
) as {
  records: {
    name: string;
    url: string;
    status: number;
    headerKeys: string[];
    headerValues: string[];
    body: string;
    jq: { query: string; ok: boolean; value: string }[];
  }[];
};

const pick = (name: string) => {
  const record = fixtures.records.find((r) => r.name === name);
  if (!record) throw new Error(`no recorded fixture named ${name}`);
  return record;
};

const { viem, provider } = await network.getOrCreate("localhost");
const publicClient = await viem.getPublicClient();

console.log("installing the stand-ins…");
for (const [name, target] of STAND_INS) {
  const staged = await viem.deployContract(name);
  const bytecode = await publicClient.getCode({ address: staged.address });
  await provider.request({ method: "hardhat_setCode", params: [target, bytecode] });
  console.log(`  ${name.padEnd(20)} → ${target}`);
}

const registry = await viem.getContractAt("LocalTeeRegistry", RITUAL.TEE_SERVICE_REGISTRY);
await registry.write.setExecutors([["0x000000000000000000000000000000000000e7e0"]]);

const http = await viem.getContractAt("LocalHttpPrecompile", RITUAL.HTTP_PRECOMPILE);
const jq = await viem.getContractAt("LocalJqPrecompile", RITUAL.JQ_PRECOMPILE);

// Serve the CoinGecko snapshot, and teach jq every answer the real binary gave.
const priced = pick("coingecko-eth-usd");
await http.write.setResponse([
  priced.status,
  priced.headerKeys,
  priced.headerValues,
  stringToHex(priced.body),
  "",
]);
for (const record of fixtures.records)
  for (const answer of record.jq)
    if (answer.ok)
      await jq.write.setAnswer([
        answer.query,
        record.body,
        JQ_OUT_UINT256,
        BigInt(answer.value),
      ]);

console.log("deploying RitualPredict…");
const predict = await viem.deployContract("RitualPredict", [BLOCK_TIME_MS]);
await predict.write.fundExecution([100_000n], { value: parseEther("2") });

// One market to look at, priced around what the recorded snapshot actually said.
const observed = BigInt(priced.jq[0].value);
const kraken = pick("kraken-eth-usd");
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
