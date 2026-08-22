import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

// Hardhat does not read .env by itself, so `cp .env.example .env` alone leaves every
// configuration variable undefined. Node's own loader fills process.env, which is where
// configVariable() looks. Missing file is fine — CI passes the same names as real env vars.
try {
  process.loadEnvFile(new URL(".env", import.meta.url));
} catch {
  // no .env; rely on the ambient environment
}

const RITUAL_RPC_URL =
  process.env.RITUAL_RPC_URL ?? "https://rpc.ritualfoundation.org";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    // Ritual Chain testnet. Requires EIP-1559 (type-2) transactions; viem sends
    // those by default.
    ritual: {
      type: "http",
      chainType: "l1",
      chainId: 1979,
      url: RITUAL_RPC_URL,
      accounts: [configVariable("RITUAL_PRIVATE_KEY")],
    },
  },
});
