"use client";

import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { predictContract } from "@/lib/contract";
import { useTx } from "./useTx";

/**
 * The contract pays for its own resolutions out of its RitualWallet balance. If
 * that runs dry, markets stop settling and nothing on chain complains, so the
 * balance is given a permanent place on the page rather than a status page.
 */
export function ExecutionPanel() {
  const { isConnected } = useAccount();
  const { send, status, error } = useTx();
  const [amount, setAmount] = useState("0.5");

  const { data: balance, refetch } = useReadContract({
    ...predictContract!,
    functionName: "executionBalance",
    query: { enabled: Boolean(predictContract), refetchInterval: 6000 },
  });

  const empty = balance !== undefined && (balance as bigint) === 0n;

  return (
    <section className="card tight">
      <span className="label">Execution balance</span>
      <p
        className="value big"
        style={{ margin: "0.35rem 0 0", color: empty ? "var(--red)" : "var(--lime)" }}
      >
        {balance === undefined ? "—" : formatEther(balance as bigint)}
      </p>
      <p className="muted" style={{ marginTop: "0.35rem" }}>
        Prepaid Scheduler and HTTP fees. Every market resolution is drawn from
        here, and an empty balance means markets quietly stop settling.
      </p>

      {error && <p className="notice bad">{error}</p>}

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
          disabled={!isConnected || status !== "idle"}
          onClick={async () => {
            const ok = await send({
              ...predictContract!,
              functionName: "fundExecution",
              args: [1000n],
              value: parseEther(amount || "0"),
            } as never);
            if (ok) refetch();
          }}
        >
          {status === "mining" ? "Funding…" : "Top up"}
        </button>
      </div>
    </section>
  );
}
