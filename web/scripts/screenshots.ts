/**
 * Drives the app through a whole market and photographs it on the way.
 *
 *   cd hardhat && npx hardhat node
 *   cd hardhat && npx hardhat run scripts/setup-local-chain.ts --network localhost
 *   cd web && NEXT_PUBLIC_PREDICT_ADDRESS=0x… pnpm dev -p 3111
 *   cd web && node scripts/screenshots.ts 0x…
 *
 * There is no wallet extension in a headless browser, so the page gets a small
 * EIP-1193 shim that forwards every call to the node. A `hardhat node` keeps its
 * accounts unlocked, so it signs — nothing here holds a key.
 *
 * The chain is driven from the same script: mining to a deadline and running a
 * scheduled execution are RPC calls, so the browser and the chain stay in step.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
} from "viem";
import { predictAbi } from "../src/lib/predict-abi.ts";

const RPC = "http://127.0.0.1:8545";
const APP = process.env.APP_URL ?? "http://127.0.0.1:3111";
const PREDICT = process.argv[2] as Address;
if (!PREDICT) throw new Error("pass the RitualPredict address as the first argument");

const SCHEDULER = "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B" as const;
// hardhat node's first two accounts.
const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

const out = fileURLToPath(new URL("../../docs/screenshots/", import.meta.url));
mkdirSync(out, { recursive: true });

const schedulerAbi = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../hardhat/artifacts/contracts/testing/LocalScheduler.sol/LocalScheduler.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
).abi;

const publicClient = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ transport: http(RPC) });

async function mine(blocks: bigint) {
  await publicClient.request({
    method: "hardhat_mine" as never,
    params: [`0x${blocks.toString(16)}`] as never,
  });
}

async function market() {
  return (await publicClient.readContract({
    address: PREDICT,
    abi: predictAbi,
    functionName: "getMarket",
    args: [1n],
  })) as any;
}

/**
 * Wait for the page to actually show a state before photographing it. The page
 * polls the chain every few seconds, so a screenshot taken on a timer catches
 * the previous state and quietly lies about it.
 */
async function settle(page: Page, expect: string | RegExp) {
  await page.getByText(expect).first().waitFor({ timeout: 40_000 });
  await page.waitForTimeout(400);
}

async function shoot(page: Page, name: string, selector?: string) {
  const path = `${out}${name}.png`;
  if (selector) await page.locator(selector).screenshot({ path });
  else await page.screenshot({ path, fullPage: false });
  console.log(`  ${name}.png`);
}

const CARD = "article.card";

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1500, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});

await context.addInitScript(
  ({ rpc, account }) => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    (window as unknown as { ethereum: unknown }).ethereum = {
      isMetaMask: true,
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts")
          return [account];
        const response = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method,
            params: params ?? [],
          }),
        });
        const json = await response.json();
        if (json.error) {
          const error = new Error(json.error.message) as Error & { code?: number };
          error.code = json.error.code;
          throw error;
        }
        return json.result;
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        (listeners[event] ??= []).push(handler);
      },
      removeListener() {},
    };
  },
  { rpc: RPC, account: ALICE },
);

const page = await context.newPage();
page.on("pageerror", (error) => console.error("page error:", error.message));

console.log("photographing:");
await page.goto(APP, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Connect wallet" }).click();
await page.getByText("0xf39F").first().waitFor({ timeout: 15_000 });
await shoot(page, "01-open");

// A bet placed through the page, and one against it placed from the other account.
await page.getByRole("button", { name: "Back YES" }).click();
await settle(page, "You hold");
await wallet.writeContract({
  account: BOB,
  chain: null,
  address: PREDICT,
  abi: predictAbi,
  functionName: "bet",
  args: [1n, false],
  value: parseEther("0.04"),
});
await settle(page, /NO 0\.04/);
await shoot(page, "02-bets");
await settle(page, /#1 · market 1/);
await shoot(page, "03-side-rail", ".columns > div:nth-child(2)");

// Past the betting window: the market is closed and waiting to be woken.
const open = await market();
const now = await publicClient.getBlockNumber();
await mine(open.closeBlock - now + 2n);
await settle(page, "Betting closed");
await shoot(page, "04-closed", CARD);

// To the scheduled block, then run the execution the Scheduler would have run.
const closed = await market();
await mine(closed.resolveBlock - (await publicClient.getBlockNumber()) + 1n);
await wallet.writeContract({
  account: ALICE,
  chain: null,
  address: SCHEDULER,
  abi: schedulerAbi,
  functionName: "fire",
  args: [closed.scheduleId, 0n],
  gas: 6_000_000n,
});
await settle(page, "Open to challenge");
await shoot(page, "05-challengeable", CARD);

// Past the challenge window: claims open.
const settled = await market();
await mine(settled.disputeUntil - (await publicClient.getBlockNumber()) + 1n);
await settle(page, "Settled");
await shoot(page, "06-settled", CARD);

await page.getByRole("button", { name: /^Claim/ }).click();
await settle(page, "already claimed");
await shoot(page, "07-claimed", CARD);

await browser.close();
console.log(`\nwritten to docs/screenshots/`);
