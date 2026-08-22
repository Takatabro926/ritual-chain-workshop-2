/**
 * Records real HTTP responses and the real jq answers derived from them.
 *
 * The local harness cannot run jq or reach the network, so both are frozen here
 * instead of being imitated: the bodies come from live endpoints, and every jq
 * result is produced by the jq binary on this machine, not by hand.
 *
 *   node scripts/record-oracle-fixtures.ts
 *
 * Re-running rewrites fixtures/oracle-responses.json. Prices move, so expect the
 * recorded numbers to change and the tests to keep passing anyway — nothing
 * asserts a particular price, only that the pipeline yields what jq yields.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Probe = {
  name: string;
  note: string;
  url: string;
  /** jq programs to evaluate against the recorded body, uint256 output. */
  queries: string[];
};

const PROBES: Probe[] = [
  {
    name: "coingecko-eth-usd",
    note: "Nested float. The market target is in cents, so jq scales and floors.",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    queries: [".ethereum.usd * 100 | floor"],
  },
  {
    name: "coinbase-eth-usd",
    note: "Same number, different shape: the amount is a string and needs tonumber.",
    url: "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    queries: [".data.amount | tonumber * 100 | floor"],
  },
  {
    name: "github-rate-limited",
    note: "A real non-200 with a real JSON error body. Never a NO, always a miss.",
    url: "https://api.github.com/repos/ritual-foundation/ritual-dapp-skills",
    queries: [".stargazers_count"],
  },
  {
    name: "html-not-json",
    note: "A 200 that jq cannot parse. Exercises the jsonPath failure branch.",
    url: "https://example.com",
    queries: [".price"],
  },
];

/**
 * Recorded bodies land in a public repository, and error pages like to quote the
 * caller back at themselves. Addresses are removed before anything is written.
 * jq runs on the redacted body, so what the fixture stores and what the tests
 * assert are the same bytes.
 */
function redact(body: string): string {
  return body
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "0.0.0.0")
    .replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, "::");
}

function runJq(query: string, input: string): { ok: boolean; value: string } {
  try {
    const out = execFileSync("jq", ["-e", query], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!/^\d+$/.test(out)) return { ok: false, value: "0" };
    return { ok: true, value: out };
  } catch {
    return { ok: false, value: "0" };
  }
}

const jqVersion = execFileSync("jq", ["--version"], { encoding: "utf8" }).trim();
const records = [];

for (const probe of PROBES) {
  const response = await fetch(probe.url, {
    headers: { accept: "application/json" },
  });
  const body = redact(await response.text());

  const headerKeys: string[] = [];
  const headerValues: string[] = [];
  for (const [key, value] of response.headers) {
    // Only the headers a contract might plausibly branch on; the rest is noise.
    if (["content-type", "date", "server"].includes(key)) {
      headerKeys.push(key);
      headerValues.push(value);
    }
  }

  records.push({
    name: probe.name,
    note: probe.note,
    url: probe.url,
    status: response.status,
    headerKeys,
    headerValues,
    body,
    jq: probe.queries.map((query) => {
      const { ok, value } = runJq(query, body);
      return { query, ok, value };
    }),
  });

  console.log(`${probe.name}: ${response.status}, ${body.length} bytes`);
}

const out = {
  capturedAt: new Date().toISOString(),
  jqVersion,
  producedBy: "scripts/record-oracle-fixtures.ts",
  records,
};

const path = fileURLToPath(new URL("../fixtures/oracle-responses.json", import.meta.url));
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${path}`);
