/**
 * A scripted EVM node and a recording signer, for adapter and orchestrator
 * tests. They answer what a test sets and never decide what a chain would do.
 */
import { Effect, Layer } from "effect"
import { BaseError } from "viem"
import type { Hex } from "../src/core/bytes.ts"
import type { EvmChainRef } from "../src/core/domain.ts"
import { mainnet } from "../src/core/registry.ts"
import type * as EvmAdapter from "../src/evm/EvmAdapter.ts"
import { EvmSigner, type UnsignedEvmTransaction } from "../src/evm/EvmSigner.ts"

export const ALICE = "0x00000000000000000000000000000000000A11cE" as const

/** A scripted node: the answers a test sets, and the requests it saw. */
export const node = (chain: EvmChainRef = mainnet.base) => {
  const state = {
    chainId: chain.chainId as number,
    usdc: 1_000_000_000n,
    allowance: 0n,
    native: 10n ** 18n,
    gasPrice: 1_000_000n,
    gasEstimate: 100_000n,
    estimateFails: undefined as string | undefined,
    usedNonce: 0n,
    finalized: 1_000n,
    latest: 1_050n,
    receipt: "success" as "success" | "reverted" | "lost",
    logs: [] as Array<{ blockNumber: bigint; args: Record<string, unknown> }>,
    logRequests: [] as Array<readonly [bigint, bigint]>,
    estimates: [] as Array<{ to: Hex; data: Hex; account: Hex | undefined }>,
  }
  const client = {
    getChainId: async () => state.chainId,
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "balanceOf"
        ? state.usdc
        : functionName === "allowance"
          ? state.allowance
          : state.usedNonce,
    estimateGas: async (request: { to: Hex; data: Hex; account?: Hex }) => {
      if (state.estimateFails !== undefined) {
        const error = new BaseError(state.estimateFails)
        throw error
      }
      state.estimates.push({
        to: request.to,
        data: request.data,
        account: request.account,
      })
      return state.gasEstimate
    },
    getGasPrice: async () => state.gasPrice,
    getBalance: async () => state.native,
    getBlock: async () => ({ number: state.finalized }),
    getBlockNumber: async () => state.latest,
    getLogs: async (request: { fromBlock: bigint; toBlock: bigint }) => {
      state.logRequests.push([request.fromBlock, request.toBlock])
      return state.logs
        .filter(
          (l) =>
            l.blockNumber >= request.fromBlock &&
            l.blockNumber <= request.toBlock
        )
        .map((l) => ({
          address: chain.tokenMessenger,
          removed: false,
          transactionHash: `0xAA${l.blockNumber.toString(16).padStart(62, "0")}`,
          args: l.args,
        }))
    },
    waitForTransactionReceipt: async () => {
      if (state.receipt === "lost") throw new BaseError("timed out")
      return { status: state.receipt }
    },
  } as unknown as EvmAdapter.EvmReadClient
  return { state, client }
}

/** A signer that records what it is asked to send. */
export const wallet = (address: Hex = ALICE) => {
  const sent: Array<UnsignedEvmTransaction> = []
  const layer = Layer.succeed(
    EvmSigner,
    EvmSigner.of({
      address: () => Effect.succeed(address),
      sendTransaction: (_chain, transaction) =>
        Effect.sync(() => {
          sent.push(transaction)
          return `0xBEEF${String(sent.length).padStart(60, "0")}` as Hex
        }),
    })
  )
  return { sent, layer }
}
