"use client";

import { predictAddress } from "@/lib/contract";
import { shortAddress } from "@/lib/market";
import { useSource } from "@/lib/source";

export function ConnectBar() {
  const source = useSource();

  return (
    <header className="row spread" style={{ marginBottom: "2.5rem" }}>
      <div>
        <span className="label">RitualPredict</span>
        <div className="row" style={{ gap: "1rem", marginTop: "0.25rem" }}>
          <span className="hex">
            {source.mode === "demo"
              ? "recorded data, no contract"
              : predictAddress
                ? shortAddress(predictAddress)
                : "no contract configured"}
          </span>
          <span className="hex">
            {source.chainName ?? "unknown chain"} · block{" "}
            <span style={{ color: "var(--lime)" }}>
              {source.blockNumber?.toString() ?? "—"}
            </span>
          </span>
        </div>
      </div>

      {source.mode === "demo" ? (
        <span className="hex">{shortAddress(source.address!)} · demo account</span>
      ) : source.isConnected ? (
        <div className="row">
          <span className="hex">
            {source.address ? shortAddress(source.address) : ""}
          </span>
          <button onClick={() => source.disconnect()}>Disconnect</button>
        </div>
      ) : (
        <button className="primary" onClick={() => source.connect()}>
          Connect wallet
        </button>
      )}
    </header>
  );
}
