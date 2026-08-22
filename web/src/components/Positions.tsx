"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { formatEther, isAddress } from "viem";
import { usePublicClient } from "wagmi";
import { predictAbi, predictContract } from "@/lib/contract";
import { DEMO_MODE, useSource } from "@/lib/source";

/**
 * Every bet mints an ERC-721, and moving it moves the stake.
 *
 * The contract has no enumeration — an index of every owner's tokens would cost
 * storage on every bet for something only this panel wants — so on chain the list
 * is rebuilt from PositionOpened logs and filtered by current owner.
 */
export function Positions() {
  const source = useSource();
  const client = usePublicClient();
  const [recipients, setRecipients] = useState<Record<string, string>>({});
  const address = source.address;

  const { data: fromLogs } = useQuery({
    queryKey: ["positions", address],
    enabled: !DEMO_MODE && Boolean(address && client && predictContract),
    refetchInterval: 8000,
    queryFn: async () => {
      const logs = await client!.getContractEvents({
        address: predictContract!.address,
        abi: predictAbi,
        eventName: "PositionOpened",
        fromBlock: 0n,
      });

      const owned: {
        tokenId: bigint;
        marketId: bigint;
        isYes: boolean;
        amount: bigint;
      }[] = [];
      for (const log of logs) {
        const args = log.args as Record<string, unknown>;
        const tokenId = args.tokenId as bigint | undefined;
        if (tokenId === undefined) continue;
        const owner = (await client!.readContract({
          ...predictContract!,
          functionName: "ownerOf",
          args: [tokenId],
        })) as string;
        if (owner.toLowerCase() !== address!.toLowerCase()) continue;
        owned.push({
          tokenId,
          marketId: args.marketId as bigint,
          isYes: args.isYes as boolean,
          amount: args.amount as bigint,
        });
      }
      return owned;
    },
  });

  const positions = DEMO_MODE ? source.positions : (fromLogs ?? []);
  if (!address) return null;

  return (
    <section className="card tight">
      <span className="label">Your positions</span>
      <p className="muted" style={{ marginTop: "0.35rem" }}>
        A bet is a token. Hand it to someone else and the claim goes with it.
      </p>

      {positions.length === 0 ? (
        <p className="muted">Nothing open yet.</p>
      ) : (
        <div className="stack" style={{ gap: "0.75rem", marginTop: "0.75rem" }}>
          {positions.map((position) => {
            const key = position.tokenId.toString();
            const to = recipients[key] ?? "";
            return (
              <div key={key} className="stack" style={{ gap: "0.35rem" }}>
                <span className="value">
                  #{key} · market {position.marketId.toString()} ·{" "}
                  <span className={position.isYes ? "tone-green" : "tone-pink"}>
                    {position.isYes ? "YES" : "NO"}
                  </span>{" "}
                  {formatEther(position.amount)}
                </span>
                <div className="row" style={{ gap: "0.5rem" }}>
                  <input
                    aria-label={`Send position ${key} to`}
                    className="mono"
                    placeholder="0x… recipient"
                    value={to}
                    onChange={(event) =>
                      setRecipients((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  />
                  <button
                    disabled={!isAddress(to) || source.busy}
                    onClick={() =>
                      source.perform({
                        type: "transfer",
                        tokenId: position.tokenId,
                        to,
                      })
                    }
                  >
                    Send
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
