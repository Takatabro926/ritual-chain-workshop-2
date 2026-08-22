"use client";

import { useBlockNumber, useReadContract } from "wagmi";
import { ConnectBar } from "@/components/ConnectBar";
import { CreateMarketForm } from "@/components/CreateMarketForm";
import { ExecutionPanel } from "@/components/ExecutionPanel";
import { MarketCard } from "@/components/MarketCard";
import { Positions } from "@/components/Positions";
import { predictContract } from "@/lib/contract";
import type { Market } from "@/lib/market";

export default function Page() {
  const { data: blockNumber } = useBlockNumber({ watch: true });

  const { data: markets, refetch } = useReadContract({
    ...predictContract!,
    functionName: "getMarkets",
    query: { enabled: Boolean(predictContract), refetchInterval: 4000 },
  });

  const { data: blockTimeMs } = useReadContract({
    ...predictContract!,
    functionName: "blockTimeMs",
    query: { enabled: Boolean(predictContract) },
  });

  const list = (markets as readonly Market[] | undefined) ?? [];

  return (
    <main className="shell">
      <ConnectBar />

      <h1>
        Markets that
        <br />
        settle themselves
      </h1>
      <p className="lede">
        Stake on YES or NO. When the betting window closes nobody presses a resolve
        button and no cron job runs: the Ritual Scheduler wakes the contract at a
        block fixed when the market was created, it reads its oracles through the
        HTTP precompile, narrows each answer to one number with jq, and settles.
      </p>

      {!predictContract && (
        <p className="notice bad" style={{ marginTop: "1.5rem" }}>
          No contract address configured. Set NEXT_PUBLIC_PREDICT_ADDRESS to the
          deployed RitualPredict and reload.
        </p>
      )}

      <hr className="rule-divider" style={{ margin: "2rem 0" }} />

      <div className="columns">
        <div className="stack" id="markets">
          <div className="spread">
            <h2>
              {list.length} market{list.length === 1 ? "" : "s"}
            </h2>
            <span className="hex">newest first</span>
          </div>

          {list.length === 0 ? (
            <p className="muted">
              Nothing here yet. Ask a question on the right and it will resolve
              itself.
            </p>
          ) : (
            list.map((market) => (
              <MarketCard
                key={market.id.toString()}
                market={market}
                blockNumber={blockNumber}
                blockTimeMs={blockTimeMs as bigint | undefined}
                onChanged={refetch}
              />
            ))
          )}
        </div>

        <div className="stack">
          <ExecutionPanel />
          <Positions onChanged={refetch} />
          <CreateMarketForm onCreated={refetch} />
        </div>
      </div>
    </main>
  );
}
