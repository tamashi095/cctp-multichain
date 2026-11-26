/**
 * `cctp-multichain/evm`: the EVM family. One adapter, configured per chain
 * from the registry, and the signer service it sends through.
 */
export * as EvmAdapter from "./EvmAdapter.ts"
export type { EvmAdapterOptions, EvmReadClient } from "./EvmAdapter.ts"
export { EvmSigner, type UnsignedEvmTransaction } from "./EvmSigner.ts"
export {
  erc20Abi,
  messageTransmitterV2Abi,
  tokenMessengerV2Abi,
} from "./abi.ts"
