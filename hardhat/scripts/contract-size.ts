/**
 * Reports deployed bytecode size against the EIP-170 limit.
 *
 *   node scripts/contract-size.ts        # report
 *   node scripts/contract-size.ts --check # exit non-zero if anything is over
 *
 * Worth having because the local node does not enforce the limit: a contract can
 * grow past 24,576 bytes, pass every test, and then fail to deploy on a real
 * chain. Nothing in the test suite would notice.
 *
 * Run it against a plain build. `hardhat test --coverage` instruments the
 * bytecode and leaves artifacts far larger than what would be deployed — this
 * script has no way to tell the two apart, so `hardhat compile --force` first.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 24_576;
const root = fileURLToPath(new URL("../artifacts/contracts", import.meta.url));

function* artifacts(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* artifacts(path);
    else if (entry.endsWith(".json") && !entry.endsWith(".dbg.json")) yield path;
  }
}

let worst = 0;
const rows: { name: string; size: number }[] = [];

for (const path of artifacts(root)) {
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  const raw = artifact.deployedBytecode;
  const hex = (typeof raw === "string" ? raw : raw?.object ?? "").replace(
    /^0x/,
    "",
  );
  if (hex.length <= 2) continue; // interface or library with no code
  const size = hex.length / 2;
  rows.push({ name: artifact.contractName, size });
  if (size > worst) worst = size;
}

rows.sort((a, b) => b.size - a.size);
for (const { name, size } of rows) {
  const over = size > LIMIT;
  console.log(
    `${over ? "OVER " : "     "}${name.padEnd(24)} ${String(size).padStart(6)} bytes   ${
      over ? `${size - LIMIT} over` : `${LIMIT - size} left`
    }`,
  );
}

if (process.argv.includes("--check") && worst > LIMIT) {
  console.error(`\nEIP-170 limit is ${LIMIT} bytes; the largest contract is ${worst}.`);
  process.exit(1);
}
