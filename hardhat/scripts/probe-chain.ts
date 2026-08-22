/**
 * Is Ritual Chain reachable?
 *
 *   node scripts/probe-chain.ts
 *
 * This repository claims throughout that the chain was unreachable. That claim
 * should be checkable rather than taken on trust, so this is the check: four
 * hosts, resolved and then contacted, with whatever they answer printed.
 *
 * Exits 0 if the RPC answers eth_chainId, 1 if it does not.
 */
import { lookup } from "node:dns/promises";

const TIMEOUT_MS = 15_000;

const TARGETS = [
  { name: "rpc", url: "https://rpc.ritualfoundation.org", rpc: true },
  { name: "explorer", url: "https://explorer.ritualfoundation.org", rpc: false },
  { name: "faucet", url: "https://faucet.ritualfoundation.org", rpc: false },
  { name: "docs", url: "https://docs.ritualfoundation.org", rpc: false },
];

async function resolve(host: string) {
  try {
    return (await lookup(host)).address;
  } catch {
    return "does not resolve";
  }
}

async function contact(target: (typeof TARGETS)[number]) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(target.url, {
      signal: controller.signal,
      ...(target.rpc
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_chainId",
              params: [],
            }),
          }
        : {}),
    });
    const body = target.rpc ? await response.text() : "";
    return {
      ok: response.ok,
      detail: `HTTP ${response.status} in ${Date.now() - started}ms${body ? ` — ${body.trim().slice(0, 80)}` : ""}`,
    };
  } catch (cause) {
    return { ok: false, detail: describe(cause) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "fetch failed" is not a finding. The useful part is underneath it: whether the
 * connection was refused, reset, or simply never answered.
 */
function describe(cause: unknown): string {
  if (cause instanceof Error && cause.name === "AbortError")
    return `no response in ${TIMEOUT_MS / 1000}s (timed out)`;
  const codes: string[] = [];
  let current: unknown = cause;
  while (current instanceof Error) {
    const code = (current as Error & { code?: string }).code;
    if (code && !codes.includes(code)) codes.push(code);
    current = (current as Error & { cause?: unknown }).cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return codes.length > 0 ? `${message} (${codes.join(", ")})` : message;
}

console.log(`probed ${new Date().toISOString()}\n`);

let rpcAnswered = false;
for (const target of TARGETS) {
  const host = new URL(target.url).hostname;
  const address = await resolve(host);
  const { ok, detail } = await contact(target);
  if (target.rpc && ok) rpcAnswered = true;
  console.log(`${target.name.padEnd(9)} ${address.padEnd(17)} ${detail}`);
}

console.log(
  `\n${rpcAnswered ? "The chain is reachable." : "The chain is not reachable."}`,
);
process.exit(rpcAnswered ? 0 : 1);
