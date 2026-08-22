/**
 * Copy the recorded oracle responses into the frontend, so demo mode replays the
 * same numbers the test suite runs against rather than inventing plausible ones.
 *
 *   node scripts/export-fixtures.ts
 *
 * Only the fields the UI needs travel: the bodies are recorded evidence for the
 * contract tests, but the browser only wants the source, the query and what real
 * jq made of it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const input = resolve(here, "../fixtures/oracle-responses.json");
const output = resolve(here, "../../web/src/lib/oracle-fixtures.json");

const recorded = JSON.parse(await readFile(input, "utf8")) as {
  capturedAt: string;
  jqVersion: string;
  records: {
    name: string;
    note: string;
    url: string;
    status: number;
    jq: { query: string; ok: boolean; value: string }[];
  }[];
};

const slim = {
  capturedAt: recorded.capturedAt,
  jqVersion: recorded.jqVersion,
  records: recorded.records.map((record) => ({
    name: record.name,
    note: record.note,
    url: record.url,
    status: record.status,
    query: record.jq[0]?.query ?? "",
    ok: record.jq[0]?.ok ?? false,
    value: record.jq[0]?.value ?? "0",
  })),
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(slim, null, 2) + "\n", "utf8");
console.log(`Wrote ${slim.records.length} recorded readings to ${output}`);
