/**
 * Test doubles for the orchestrator: two scripted chains and a scripted Iris.
 * Each records what it was asked; none decides what a real chain would do.
 */
import { Effect, Layer, Option, Stream } from "effect"
import { leftPad32, toHex, type Hex } from "../src/core/bytes.ts"
import {
  Adapters,
  type BurnParams,
  type ChainAdapter,
  type FoundBurn,
} from "../src/core/ChainAdapter.ts"
import type { ChainRef } from "../src/core/domain.ts"
import {
  IrisNotIndexed,
  type BurnError,
  type ClaimError,
  type IrisError,
} from "../src/core/errors.ts"
import { Iris, type IrisMessage } from "../src/core/Iris.ts"
import * as Message from "../src/core/message.ts"
import { expectedBurnOf, type Transfer } from "../src/core/Transfer.ts"

const bytes32 = (text: string): Hex =>
  toHex(leftPad32(new TextEncoder().encode(text)))

/** What a scripted chain does next, and what it has been asked. */
export interface FakeChain {
  readonly adapter: ChainAdapter
  readonly calls: Array<string>
  readonly used: Set<string>
  readonly found: Array<FoundBurn>
  burn: (
    params: BurnParams
  ) => Effect.Effect<{ transactionHash: string }, BurnError>
  claim: (
    message: Uint8Array
  ) => Effect.Effect<{ transactionHash: string }, ClaimError>
  height: Option.Option<bigint>
}

export const fakeChain = (domain: number, fastSource = true): FakeChain => {
  const chain: ChainRef = {
    key: `chain${domain}`,
    name: `Chain ${domain}`,
    network: "testnet",
    domain,
    family: "fake",
    usdc: `usdc${domain}`,
    fastSource,
  }
  const state: FakeChain = {
    calls: [],
    used: new Set(),
    found: [],
    height: Option.none(),
    burn: () => Effect.succeed({ transactionHash: `burn-${domain}` }),
    claim: (message) =>
      Effect.sync(() => {
        state.used.add(Message.decodeBurnMessage(message).nonce)
        return { transactionHash: `claim-${domain}` }
      }),
    adapter: {
      chain,
      messenger: bytes32(`messenger${domain}`),
      usdc: bytes32(`usdc${domain}`),
      toBytes32: (address) => Effect.succeed(bytes32(address)),
      recipientFromAddress: (address) => Effect.succeed(bytes32(address)),
      burnCursor: () => Effect.succeed("cursor"),
      burn: (params) =>
        Effect.suspend(() => {
          state.calls.push("burn")
          return state.burn(params)
        }),
      findBurns: () =>
        Stream.suspend(() => {
          state.calls.push("findBurns")
          return Stream.fromIterable(state.found)
        }),
      prepareRecipient: () =>
        Effect.sync(() => void state.calls.push("prepareRecipient")),
      estimateClaimCost: () => Effect.succeed({ amount: 1n, unit: "wei" }),
      claim: (message) =>
        Effect.suspend(() => {
          state.calls.push("claim")
          return state.claim(message)
        }),
      isNonceUsed: (nonce) =>
        Effect.sync(() => {
          state.calls.push("isNonceUsed")
          return state.used.has(nonce)
        }),
      expirationHeight: Effect.sync(() => state.height),
    },
  }
  return state
}

export const NONCE = toHex(new Uint8Array(32).fill(7))

/** Circle's attested form of `transfer`'s burn. */
export const attested = (
  transfer: Transfer,
  overrides: Partial<Message.BurnMessage> = {}
): IrisMessage => {
  const burn = Message.decodeBurnMessage(
    Message.expectedBurnMessage(expectedBurnOf(transfer))
  )
  return {
    _tag: "Attested",
    message: Message.encodeBurnMessage({
      ...burn,
      nonce: NONCE,
      finalityThresholdExecuted: burn.minFinalityThreshold,
      ...overrides,
    }),
    attestation: new Uint8Array(130).fill(1),
  }
}

/** What a scripted Iris answers, and what it has been asked. */
export interface FakeIris {
  readonly layer: Layer.Layer<Iris>
  readonly calls: Array<string>
  /** Answers to `messages`, in order; the last one repeats. */
  messages: Array<ReadonlyArray<IrisMessage> | "notIndexed" | IrisError>
  minimumFeeBps: number
  allowance: number
}

export const fakeIris = (): FakeIris => {
  const state: FakeIris = {
    calls: [],
    messages: [],
    minimumFeeBps: 1,
    allowance: 1_000_000,
    layer: Layer.sync(Iris, () =>
      Iris.of({
        network: "testnet",
        fees: () =>
          Effect.sync(() => [
            { finalityThreshold: 1000, minimumFee: state.minimumFeeBps },
            { finalityThreshold: 2000, minimumFee: 0 },
          ]),
        fastAllowance: Effect.sync(() => ({ allowance: state.allowance })),
        messages: (sourceDomain, transactionHash) =>
          Effect.suspend(
            (): Effect.Effect<
              ReadonlyArray<IrisMessage>,
              IrisNotIndexed | IrisError
            > => {
              state.calls.push(`messages:${transactionHash}`)
              const next =
                state.messages.length > 1
                  ? state.messages.shift()
                  : state.messages[0]
              if (next === undefined || next === "notIndexed")
                return Effect.fail(
                  new IrisNotIndexed({ sourceDomain, transactionHash })
                )
              return Array.isArray(next)
                ? Effect.succeed(next as ReadonlyArray<IrisMessage>)
                : Effect.fail(next as IrisError)
            }
          ),
        reattest: (nonce) =>
          Effect.sync(() => void state.calls.push(`reattest:${nonce}`)),
      })
    ),
  }
  return state
}

/** The adapters registry over scripted chains. */
export const adaptersOf = (...chains: ReadonlyArray<FakeChain>) =>
  Layer.succeed(Adapters, Adapters.make(chains.map((c) => c.adapter)))
