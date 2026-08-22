import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { localNode, ritual } from "./chains";

/**
 * Injected wallets only. No WalletConnect project id to obtain, nothing to sign
 * up for, and no passkey flow — a reviewer with a browser wallet can drive the
 * whole app, and a reviewer without one can still read every market.
 */
export const wagmiConfig = createConfig({
  chains: [localNode, ritual],
  connectors: [injected()],
  transports: {
    [localNode.id]: http(),
    [ritual.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
