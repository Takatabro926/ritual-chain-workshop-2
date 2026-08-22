"use client";

import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { predictContract } from "@/lib/contract";
import {
  COMPARATOR_SYMBOL,
  Outcome,
  approximateTime,
  blocksUntil,
  phaseOf,
  pool,
  shortAddress,
  yesShare,
  type Market,
} from "@/lib/market";
import { StateBadge } from "./StateBadge";
import { useTx } from "./useTx";

export function MarketCard({
  market,
  blockNumber,
  blockTimeMs,
  onChanged,
}: {
  market: Market;
  blockNumber: bigint | undefined;
  blockTimeMs: bigint | undefined;
  onChanged: () => void;
}) {
  const { address, isConnected } = useAccount();
  const { send, status, error } = useTx();
  const [stake, setStake] = useState("0.1");
  const phase = phaseOf(market, blockNumber);

  const { data: mine } = useReadContract({
    ...predictContract!,
    functionName: "stakesOf",
    args: address ? [market.id, address] : undefined,
    query: { enabled: Boolean(address && predictContract), refetchInterval: 4000 },
  });
  const { data: bond } = useReadContract({
    ...predictContract!,
    functionName: "disputeBond",
    args: [market.id],
    query: { enabled: Boolean(predictContract), refetchInterval: 8000 },
  });

  const [myYes, myNo, mySettled, myClaimable] = (mine as
    | readonly [bigint, bigint, boolean, bigint]
    | undefined) ?? [0n, 0n, false, 0n];

  async function call(functionName: string, args: unknown[], value?: bigint) {
    const ok = await send({
      ...predictContract!,
      functionName,
      args,
      ...(value === undefined ? {} : { value }),
    } as never);
    if (ok) onChanged();
  }

  const share = yesShare(market);
  const toClose = blocksUntil(market.closeBlock, blockNumber);
  const toResolve = blocksUntil(market.resolveBlock, blockNumber);
  const toClaims = blocksUntil(market.disputeUntil, blockNumber);
  const isCreator =
    address !== undefined &&
    address.toLowerCase() === market.creator.toLowerCase();
  const isChallenger =
    address !== undefined &&
    market.challenger !== "0x0000000000000000000000000000000000000000" &&
    address.toLowerCase() === market.challenger.toLowerCase();

  return (
    <article className="card">
      <div className="spread">
        <h3 style={{ maxWidth: "42ch" }}>{market.question}</h3>
        <StateBadge phase={phase} />
      </div>

      <div className="row" style={{ gap: "1.5rem", marginTop: "0.75rem" }}>
        <span className="hex">#{market.id.toString()}</span>
        <span className="hex">by {shortAddress(market.creator)}</span>
        {market.feeBps > 0 && (
          <span className="hex tone-gold">creator takes {market.feeBps / 100}%</span>
        )}
      </div>

      <hr className="rule-divider" />

      {/* ── the rule ─────────────────────────────────────────────── */}
      <span className="label">Resolves YES when</span>
      <p className="value" style={{ margin: "0.35rem 0 0.75rem" }}>
        median of {market.quorum} reading{market.quorum === 1 ? "" : "s"}{" "}
        <span style={{ color: "var(--lime)" }}>
          {COMPARATOR_SYMBOL[market.comparator]} {market.target.toString()}
        </span>
      </p>

      <ul className="sources">
        {market.oracles.map((oracle, index) => (
          <li key={index} className={index < market.cursor ? "answered" : undefined}>
            <span aria-hidden>{index < market.cursor ? "✓" : "⇄"}</span>
            <span>
              {oracle.url}
              <br />
              <span style={{ color: "var(--gray-500)" }}>{oracle.jsonPath}</span>
            </span>
          </li>
        ))}
      </ul>

      {market.readings.length > 0 && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Gathered:{" "}
          <span className="value">
            {market.readings.map((reading) => reading.toString()).join(", ")}
          </span>
        </p>
      )}

      <hr className="rule-divider" />

      {/* ── the pool ─────────────────────────────────────────────── */}
      <div className="spread">
        <span className="label">Pool</span>
        <span className="value big">{formatEther(pool(market))}</span>
      </div>
      <div className="pool" style={{ margin: "0.5rem 0 0.4rem" }}>
        <span style={{ width: `${share}%` }} />
      </div>
      <div className="spread">
        <span className="value tone-green">
          YES {formatEther(market.totalYes)} · {share.toFixed(0)}%
        </span>
        <span className="value tone-pink">NO {formatEther(market.totalNo)}</span>
      </div>

      {/* ── where it is in time ──────────────────────────────────── */}
      <div className="row" style={{ gap: "1.25rem", marginTop: "0.9rem" }}>
        <Countdown label="Betting closes" blocks={toClose} blockTimeMs={blockTimeMs} />
        <Countdown label="Scheduler wakes" blocks={toResolve} blockTimeMs={blockTimeMs} />
        {phase === "challengeable" && (
          <Countdown label="Claims open" blocks={toClaims} blockTimeMs={blockTimeMs} />
        )}
        {market.attempts > 0 && (
          <span className="hex">
            attempt {market.attempts} · source {Math.min(market.cursor + 1, market.oracles.length)}
          </span>
        )}
      </div>

      {/* ── the answer ───────────────────────────────────────────── */}
      {market.outcome !== Outcome.Unresolved && (
        <p className="notice" style={{ borderColor: "var(--green)" }}>
          Settled <strong>{market.outcome === Outcome.Yes ? "YES" : "NO"}</strong> on a
          reading of <span className="value">{market.observedValue.toString()}</span>
          {market.bounty > 0n && " · a failed challenge added its bond to the pool"}
        </p>
      )}
      {market.state === 4 && (
        <p className="notice bad">
          Refundable — {market.invalidReason}
        </p>
      )}
      {market.challenger !== "0x0000000000000000000000000000000000000000" && (
        <p className="muted">
          Challenged by {shortAddress(market.challenger)} for{" "}
          {formatEther(market.bond)} against{" "}
          {market.disputedOutcome === Outcome.Yes ? "YES" : "NO"}
        </p>
      )}

      {/* ── your side of it ──────────────────────────────────────── */}
      {(myYes > 0n || myNo > 0n) && (
        <p className="muted">
          You hold <span className="value">{formatEther(myYes)}</span> YES and{" "}
          <span className="value">{formatEther(myNo)}</span> NO
          {mySettled
            ? " · already claimed"
            : myClaimable > 0n
              ? ` · ${formatEther(myClaimable)} claimable`
              : ""}
        </p>
      )}

      {error && <p className="notice bad">{error}</p>}

      {/* ── what you can do about it ─────────────────────────────── */}
      <div className="row" style={{ marginTop: "1rem" }}>
        {phase === "open" && (
          <>
            <input
              aria-label="Stake"
              className="mono"
              style={{ maxWidth: "8rem" }}
              value={stake}
              onChange={(event) => setStake(event.target.value)}
            />
            <button
              className="primary"
              disabled={!isConnected || status !== "idle"}
              onClick={() => call("bet", [market.id, true], parseEther(stake || "0"))}
            >
              Back YES
            </button>
            <button
              disabled={!isConnected || status !== "idle"}
              onClick={() => call("bet", [market.id, false], parseEther(stake || "0"))}
            >
              Back NO
            </button>
          </>
        )}

        {phase === "challengeable" && (
          <button
            className="caution"
            disabled={!isConnected || status !== "idle" || bond === undefined}
            onClick={() => call("dispute", [market.id], bond as bigint)}
          >
            Challenge for {bond === undefined ? "…" : formatEther(bond as bigint)}
          </button>
        )}

        {phase === "final" && myClaimable > 0n && !mySettled && (
          <button
            className="primary"
            disabled={!isConnected || status !== "idle"}
            onClick={() => call("claimWinnings", [market.id])}
          >
            Claim {formatEther(myClaimable)}
          </button>
        )}

        {phase === "refundable" && myClaimable > 0n && !mySettled && (
          <button
            className="primary"
            disabled={!isConnected || status !== "idle"}
            onClick={() => call("claimRefund", [market.id])}
          >
            Refund {formatEther(myClaimable)}
          </button>
        )}

        {isCreator && phase === "final" && !market.feeClaimed && market.feeBps > 0 && (
          <button
            disabled={!isConnected || status !== "idle"}
            onClick={() => call("claimFee", [market.id])}
          >
            Take your cut
          </button>
        )}

        {isChallenger && market.bondRefundable && !market.bondClaimed && (
          <button
            disabled={!isConnected || status !== "idle"}
            onClick={() => call("claimBond", [market.id])}
          >
            Recover bond
          </button>
        )}

        {(phase === "closed" || phase === "resolving" || phase === "disputed") && (
          <span className="muted">
            Nothing to press. The Scheduler wakes the contract on its own.
          </span>
        )}
      </div>
    </article>
  );
}

function Countdown({
  label,
  blocks,
  blockTimeMs,
}: {
  label: string;
  blocks: bigint | null;
  blockTimeMs: bigint | undefined;
}) {
  if (blocks === null) return null;
  const wall = approximateTime(blocks, blockTimeMs);
  return (
    <span className="hex">
      {label} in{" "}
      <span style={{ color: "var(--gold)" }}>{blocks.toString()} blocks</span>
      {wall ? ` (~${wall})` : ""}
    </span>
  );
}
