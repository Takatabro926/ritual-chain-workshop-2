/**
 * Puts a usable Ritual Chain under a local node.
 *
 * Nothing on a bare Hardhat node answers at the precompile or system-contract
 * addresses, and RitualPredict's constructor calls approveScheduler, so without
 * this the contract cannot even be deployed.
 *
 * The stand-ins are deployed normally and then moved to the canonical addresses
 * with setCode. That leaves their storage empty, which is why every one of them
 * is configured through setters rather than a constructor.
 *
 * Oracle behaviour comes from fixtures/oracle-responses.json — real bodies from
 * real endpoints, and jq answers produced by the real jq binary. See
 * scripts/record-oracle-fixtures.ts.
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

/** jq outputType for uint256. */
export const JQ_OUT_UINT256 = 1;

/** Ritual Chain measured about this when the workshop was written. */
export const DEFAULT_BLOCK_TIME_MS = 195n;

export type OracleFixture = {
  name: string;
  note: string;
  url: string;
  status: number;
  headerKeys: string[];
  headerValues: string[];
  body: string;
  jq: { query: string; ok: boolean; value: string }[];
};

export type FixtureFile = {
  capturedAt: string;
  jqVersion: string;
  records: OracleFixture[];
};

export function loadFixtures(): FixtureFile {
  const path = fileURLToPath(
    new URL("../../fixtures/oracle-responses.json", import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
}

export function fixture(name: string): OracleFixture {
  const found = loadFixtures().records.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no recorded fixture named ${name}`);
  return found;
}

const MOCKS = [
  ["LocalScheduler", RITUAL.SCHEDULER],
  ["LocalRitualWallet", RITUAL.RITUAL_WALLET],
  ["LocalTeeRegistry", RITUAL.TEE_SERVICE_REGISTRY],
  ["LocalHttpPrecompile", RITUAL.HTTP_PRECOMPILE],
  ["LocalJqPrecompile", RITUAL.JQ_PRECOMPILE],
] as const;

/**
 * Installs every stand-in and returns handles bound to the canonical addresses.
 * `executors` seeds the TEE registry; the default is enough for a market to
 * resolve, and tests that care about executor churn pass several.
 */
export async function installLocalRitual(
  viem: any,
  options: { executors?: `0x${string}`[] } = {},
) {
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();

  for (const [name, target] of MOCKS) {
    const staged = await viem.deployContract(name);
    const bytecode = await publicClient.getCode({ address: staged.address });
    if (bytecode === undefined || bytecode === "0x")
      throw new Error(`${name} produced no runtime bytecode`);
    await testClient.setCode({ address: target, bytecode });
  }

  const scheduler = await viem.getContractAt("LocalScheduler", RITUAL.SCHEDULER);
  const wallet = await viem.getContractAt(
    "LocalRitualWallet",
    RITUAL.RITUAL_WALLET,
  );
  const registry = await viem.getContractAt(
    "LocalTeeRegistry",
    RITUAL.TEE_SERVICE_REGISTRY,
  );
  const http = await viem.getContractAt(
    "LocalHttpPrecompile",
    RITUAL.HTTP_PRECOMPILE,
  );
  const jq = await viem.getContractAt("LocalJqPrecompile", RITUAL.JQ_PRECOMPILE);

  const executors = options.executors ?? [
    "0x000000000000000000000000000000000000E7E0" as `0x${string}`,
  ];
  await registry.write.setExecutors([executors]);

  return { scheduler, wallet, registry, http, jq, publicClient, testClient };
}

/**
 * Programs the HTTP stand-in with one recorded response, and teaches the jq
 * stand-in every answer real jq gave for that body. Returns the value the
 * contract should end up observing, or null if this fixture is a failure case.
 */
export async function applyOracleFixture(
  ritual: { http: any; jq: any },
  record: OracleFixture,
  query: string,
): Promise<bigint | null> {
  await ritual.http.write.setResponse([
    record.status,
    record.headerKeys,
    record.headerValues,
    stringToHex(record.body),
    "",
  ]);

  for (const answer of record.jq) {
    if (!answer.ok) continue; // unknown key: the stand-in returns empty, as the real one does
    await ritual.jq.write.setAnswer([
      answer.query,
      record.body,
      JQ_OUT_UINT256,
      BigInt(answer.value),
    ]);
  }

  const wanted = record.jq.find((a) => a.query === query);
  if (wanted === undefined)
    throw new Error(`fixture ${record.name} has no recorded answer for ${query}`);
  return wanted.ok ? BigInt(wanted.value) : null;
}
