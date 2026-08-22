/**
 * Installing a usable Ritual Chain on a running node.
 *
 * Shared by scripts/setup-local-chain.ts and scripts/verify-lifecycle.ts so the
 * thing CI proves works is the same thing a person runs by hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stringToHex } from "viem";

export const RITUAL = {
  HTTP_PRECOMPILE: "0x0000000000000000000000000000000000000801",
  JQ_PRECOMPILE: "0x0000000000000000000000000000000000000803",
  SCHEDULER: "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B",
  RITUAL_WALLET: "0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948",
  TEE_SERVICE_REGISTRY: "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F",
} as const;

export const JQ_OUT_UINT256 = 1;
export const BLOCK_TIME_MS = 195n;

const STAND_INS = [
  ["LocalScheduler", RITUAL.SCHEDULER],
  ["LocalRitualWallet", RITUAL.RITUAL_WALLET],
  ["LocalTeeRegistry", RITUAL.TEE_SERVICE_REGISTRY],
  ["LocalHttpPrecompile", RITUAL.HTTP_PRECOMPILE],
  ["LocalJqPrecompile", RITUAL.JQ_PRECOMPILE],
] as const;

export type OracleRecord = {
  name: string;
  url: string;
  status: number;
  headerKeys: string[];
  headerValues: string[];
  body: string;
  jq: { query: string; ok: boolean; value: string }[];
};

export function recordedResponses(): OracleRecord[] {
  const path = fileURLToPath(
    new URL("../../fixtures/oracle-responses.json", import.meta.url),
  );
  return (JSON.parse(readFileSync(path, "utf8")) as { records: OracleRecord[] })
    .records;
}

export function recorded(name: string): OracleRecord {
  const found = recordedResponses().find((record) => record.name === name);
  if (!found) throw new Error(`no recorded fixture named ${name}`);
  return found;
}

/** Deploy each stand-in and move its runtime code to the canonical address. */
export async function installStandIns(viem: any, provider: any, log = true) {
  const publicClient = await viem.getPublicClient();

  for (const [name, target] of STAND_INS) {
    const staged = await viem.deployContract(name);
    const bytecode = await publicClient.getCode({ address: staged.address });
    if (!bytecode || bytecode === "0x")
      throw new Error(`${name} produced no runtime bytecode`);
    await provider.request({ method: "hardhat_setCode", params: [target, bytecode] });
    if (log) console.log(`  ${name.padEnd(20)} → ${target}`);
  }

  const scheduler = await viem.getContractAt("LocalScheduler", RITUAL.SCHEDULER);
  const registry = await viem.getContractAt(
    "LocalTeeRegistry",
    RITUAL.TEE_SERVICE_REGISTRY,
  );
  const http = await viem.getContractAt(
    "LocalHttpPrecompile",
    RITUAL.HTTP_PRECOMPILE,
  );
  const jq = await viem.getContractAt("LocalJqPrecompile", RITUAL.JQ_PRECOMPILE);

  await registry.write.setExecutors([["0x000000000000000000000000000000000000e7e0"]]);

  return { scheduler, registry, http, jq, publicClient };
}

/**
 * Serve one recorded response, and teach the jq stand-in every answer the real jq
 * binary gave for every recorded body.
 */
export async function serveRecorded(
  ritual: { http: any; jq: any },
  serve: OracleRecord,
) {
  await ritual.http.write.setResponse([
    serve.status,
    serve.headerKeys,
    serve.headerValues,
    stringToHex(serve.body),
    "",
  ]);

  for (const record of recordedResponses())
    for (const answer of record.jq)
      if (answer.ok)
        await ritual.jq.write.setAnswer([
          answer.query,
          record.body,
          JQ_OUT_UINT256,
          BigInt(answer.value),
        ]);
}
