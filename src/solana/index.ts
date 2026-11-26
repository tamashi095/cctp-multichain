/**
 * `cctp-multichain/solana`: the Solana family. The adapter over Circle's
 * two programs, the instruction builders, and the signer service.
 */
export * as SolanaAdapter from "./SolanaAdapter.ts"
export type { SolanaAdapterOptions } from "./SolanaAdapter.ts"
export { SolanaSigner, type SolanaWallet } from "./SolanaSigner.ts"
export * as SolanaInstructions from "./instructions.ts"
