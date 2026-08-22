"use client";

import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { useSource } from "@/lib/source";

/**
 * The contract pays for its own resolutions out of its RitualWallet balance. If
 * that runs dry, markets stop settling and nothing on chain complains, so the
 * balance is given a permanent place on the page rather than a status screen.
 */
export function ExecutionPanel() {
  const source = useSource();
  const [amount, setAmount] = useState("0.5");
  const balance = source.executionBalance;
  const empty = balance !== undefined && balance === 0n;

  return (
    <section className="card tight">
      <span className="label">Execution balance</span>
      <p
        className="value big"
        style={{ margin: "0.35rem 0 0", color: empty ? "var(--red)" : "var(--lime)" }}
      >
        {balance === undefined ? "—" : formatEther(balance)}
      </p>
      <p className="muted" style={{ marginTop: "0.35rem" }}>
        Prepaid Scheduler and HTTP fees. Every market resolution is drawn from
        here, and an empty balance means markets quietly stop settling.
      </p>

      <div className="row" style={{ marginTop: "0.75rem" }}>
        <input
          aria-label="Amount to prepay"
          className="mono"
          style={{ maxWidth: "7rem" }}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <button
          className={empty ? "caution" : ""}
          disabled={!source.isConnected || source.busy}
          onClick={() =>
            source.perform({ type: "fundExecution", value: parseEther(amount || "0") })
          }
        >
          {source.busy ? "Working…" : "Top up"}
        </button>
      </div>
    </section>
  );
}
