"use client";

import { useAccount, useBlockNumber, useConnect, useDisconnect } from "wagmi";
import { shortAddress } from "@/lib/market";
import { predictAddress } from "@/lib/contract";

export function ConnectBar() {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: blockNumber } = useBlockNumber({ watch: true });

  const injected = connectors[0];

  return (
    <header className="row spread" style={{ marginBottom: "2.5rem" }}>
      <div>
        <span className="label">RitualPredict</span>
        <div className="row" style={{ gap: "1rem", marginTop: "0.25rem" }}>
          <span className="hex">
            {predictAddress ? shortAddress(predictAddress) : "no contract configured"}
          </span>
          <span className="hex">
            {chain ? chain.name : "unknown chain"} · block{" "}
            <span style={{ color: "var(--lime)" }}>
              {blockNumber?.toString() ?? "—"}
            </span>
          </span>
        </div>
      </div>

      {isConnected ? (
        <div className="row">
          <span className="hex">{address ? shortAddress(address) : ""}</span>
          <button onClick={() => disconnect()}>Disconnect</button>
        </div>
      ) : (
        <button
          className="primary"
          disabled={!injected || isPending}
          onClick={() => injected && connect({ connector: injected })}
        >
          {injected ? "Connect wallet" : "No wallet found"}
        </button>
      )}
    </header>
  );
}
