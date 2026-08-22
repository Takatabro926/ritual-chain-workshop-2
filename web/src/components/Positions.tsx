"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { formatEther, isAddress } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { predictAbi, predictContract } from "@/lib/contract";
import { useTx } from "./useTx";

/**
 * Every bet mints an ERC-721, and moving it moves the stake.
 *
 * The contract has no enumeration — an index of every owner's tokens would cost
 * storage on every bet for something only this panel wants — so the list is
 * rebuilt from PositionOpened logs and filtered by current owner.
 */
export function Positions({ onChanged }: { onChanged: () => void }) {
  const { address } = useAccount();
  const client = usePublicClient();
  const { send, status, error } = useTx();
  const [recipients, setRecipients] = useState<Record<string, string>>({});

  const { data: positions, refetch } = useQuery({
    queryKey: ["positions", address],
    enabled: Boolean(address && client && predictContract),
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
        const args = log.args as {
          tokenId?: bigint;
          marketId?: bigint;
          isYes?: boolean;
          amount?: bigint;
        };
        if (args.tokenId === undefined) continue;
        const owner = (await client!.readContract({
          ...predictContract!,
          functionName: "ownerOf",
          args: [args.tokenId],
        })) as string;
        if (owner.toLowerCase() !== address!.toLowerCase()) continue;
        owned.push({
          tokenId: args.tokenId,
          marketId: args.marketId!,
          isYes: args.isYes!,
          amount: args.amount!,
        });
      }
      return owned;
    },
  });

  if (!address) return null;

  return (
    <section className="card tight">
      <span className="label">Your positions</span>
      <p className="muted" style={{ marginTop: "0.35rem" }}>
        A bet is a token. Hand it to someone else and the claim goes with it.
      </p>

      {error && <p className="notice bad">{error}</p>}

      {positions === undefined ? (
        <p className="muted">Reading logs…</p>
      ) : positions.length === 0 ? (
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
                    disabled={!isAddress(to) || status !== "idle"}
                    onClick={async () => {
                      const ok = await send({
                        ...predictContract!,
                        functionName: "safeTransferFrom",
                        args: [address, to as `0x${string}`, position.tokenId],
                      } as never);
                      if (ok) {
                        refetch();
                        onChanged();
                      }
                    }}
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
