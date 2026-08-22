import { defineChain } from "viem";

/**
 * Ritual Chain. Block time is measured, not assumed — see
 * hardhat/scripts/block-time.ts — but the contract is deployed with whatever
 * value it was given, so the UI reads `blockTimeMs()` off the contract rather
 * than hardcoding one here.
 */
export const ritual = defineChain({
  id: 1979,
  name: "Ritual",
  nativeCurrency: { name: "Ritual", symbol: "RITUAL", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_RITUAL_RPC_URL ??
          "https://rpc.ritualfoundation.org",
      ],
    },
  },
  blockExplorers: {
    default: { name: "Explorer", url: "https://explorer.ritualfoundation.org" },
  },
});

/** A local `hardhat node`, which is where this runs while the chain is down. */
export const localNode = defineChain({
  id: 31337,
  name: "Local node",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});
