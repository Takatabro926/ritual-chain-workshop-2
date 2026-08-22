import { predictAbi } from "./predict-abi";

export { predictAbi };

/**
 * Where the contract lives. Set NEXT_PUBLIC_PREDICT_ADDRESS after deploying;
 * hardhat/scripts/deploy.ts prints it. Undefined means the app has nothing to
 * talk to, and the UI says so rather than failing silently.
 */
export const predictAddress = process.env.NEXT_PUBLIC_PREDICT_ADDRESS as
  | `0x${string}`
  | undefined;

export const predictContract = predictAddress
  ? ({ address: predictAddress, abi: predictAbi } as const)
  : undefined;
