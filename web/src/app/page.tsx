"use client";

import { ConnectBar } from "@/components/ConnectBar";
import { CreateMarketForm } from "@/components/CreateMarketForm";
import { DemoBar } from "@/components/DemoBar";
import { ExecutionPanel } from "@/components/ExecutionPanel";
import { MarketCard } from "@/components/MarketCard";
import { Positions } from "@/components/Positions";
import { useSource } from "@/lib/source";

export default function Page() {
  const source = useSource();
  const markets = source.markets;

  return (
    <main className="shell">
      <ConnectBar />
      <DemoBar />

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

      <hr className="rule-divider" style={{ margin: "2rem 0" }} />

      <div className="columns">
        <div className="stack" id="markets">
          <div className="spread">
            <h2>
              {markets.length} market{markets.length === 1 ? "" : "s"}
            </h2>
            <span className="hex">newest first</span>
          </div>

          {markets.length === 0 ? (
            <p className="muted">
              Nothing here yet. Ask a question on the right and it will resolve
              itself.
            </p>
          ) : (
            markets.map((market) => (
              <MarketCard key={market.id.toString()} market={market} />
            ))
          )}
        </div>

        <div className="stack">
          <ExecutionPanel />
          <Positions />
          <CreateMarketForm />
        </div>
      </div>
    </main>
  );
}
