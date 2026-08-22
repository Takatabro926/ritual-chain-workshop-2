"use client";

import { useEffect, useState } from "react";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";

/**
 * One transaction lifecycle, shared by every button.
 *
 * A write here is not done when the wallet returns — it is done when the receipt
 * lands, and on Ritual a scheduled follow-up may still be pending after that.
 * The UI says which of those it is rather than flipping straight to "done".
 */
export function useTx() {
  const { writeContractAsync, data: hash, isPending, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (receipt.isSuccess) {
      const timer = setTimeout(() => reset(), 4000);
      return () => clearTimeout(timer);
    }
  }, [receipt.isSuccess, reset]);

  async function send(request: Parameters<typeof writeContractAsync>[0]) {
    setError(null);
    try {
      await writeContractAsync(request);
      return true;
    } catch (cause) {
      setError(readableError(cause));
      return false;
    }
  }

  const status: "idle" | "signing" | "mining" | "done" = isPending
    ? "signing"
    : receipt.isLoading
      ? "mining"
      : receipt.isSuccess
        ? "done"
        : "idle";

  return { send, status, error, hash };
}

/**
 * Wallet errors arrive as paragraphs. The first line is the useful part, and a
 * custom error name is more useful still — the contract's revert names read as
 * plain English on purpose.
 */
export function readableError(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const custom = text.match(/reverted with the following reason:\s*(\S+)/);
  if (custom) return spaceOutName(custom[1]);
  const named = text.match(/Error:\s*([A-Z][A-Za-z]+)\(\)/);
  if (named) return spaceOutName(named[1]);
  if (/User rejected|denied transaction/i.test(text)) return "Rejected in the wallet";
  return text.split("\n")[0]!.slice(0, 160);
}

function spaceOutName(name: string) {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}
