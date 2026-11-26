import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Stream } from "effect"
import { BaseError, decodeFunctionData, pad } from "viem"
import type { Hex } from "../src/core/bytes.ts"
import type { ChainAdapter } from "../src/core/ChainAdapter.ts"
import { SubmissionUnknown } from "../src/core/errors.ts"
import { mainnet } from "../src/core/registry.ts"
import {
  erc20Abi,
  messageTransmitterV2Abi,
  tokenMessengerV2Abi,
} from "../src/evm/abi.ts"
import * as EvmAdapter from "../src/evm/EvmAdapter.ts"
import { EvmSigner, type UnsignedEvmTransaction } from "../src/evm/EvmSigner.ts"
import captured from "./fixtures/captured.json" with { type: "json" }

const chain = mainnet.base
const ALICE = "0x00000000000000000000000000000000000A11cE" as const
const RECIPIENT = `0x${"cd".repeat(32)}` as const
const ZERO32 = `0x${"00".repeat(32)}` as const

/** A scripted node: the answers a test sets, and the requests it saw. */
const node = () => {
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
const wallet = (address: Hex = ALICE) => {
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

const burnParams = {
  sender: ALICE,
  amount: 25_000_000n,
  destinationDomain: 5,
  mintRecipient: RECIPIENT,
  destinationCaller: ZERO32,
  maxFee: 2_500n,
  minFinalityThreshold: 1000,
  hookData: new Uint8Array(),
} as const

const setup = (signer: Layer.Layer<EvmSigner> | undefined, n = node()) => ({
  ...n,
  adapter: EvmAdapter.make(chain, { client: n.client, logRange: 100n }).pipe(
    Effect.provide(signer ?? Layer.empty)
  ) as Effect.Effect<ChainAdapter>,
})

const real = captured.baseToEvm.iris.body.messages[0]!
const hexToBytes = (hex: string) =>
  Uint8Array.from(Buffer.from(hex.slice(2), "hex"))

describe("EvmAdapter", () => {
  it.effect("turns addresses into bytes32 and refuses what is not one", () =>
    Effect.gen(function* () {
      const adapter = yield* setup(undefined).adapter
      assert.strictEqual(
        adapter.messenger,
        pad(chain.tokenMessenger.toLowerCase() as Hex)
      )
      assert.strictEqual(adapter.usdc, pad(chain.usdc.toLowerCase() as Hex))
      assert.strictEqual(
        yield* adapter.toBytes32(ALICE),
        pad(ALICE.toLowerCase() as Hex)
      )
      assert.strictEqual(
        yield* adapter.recipientFromAddress(ALICE),
        pad(ALICE.toLowerCase() as Hex)
      )
      for (const bad of ["0x1234", "bob", "0x" + "00".repeat(20)])
        assert.strictEqual(
          (yield* Effect.flip(adapter.toBytes32(bad)))._tag,
          "InvalidAddress"
        )
    })
  )

  it.effect(
    "approves exactly the amount, then burns with the estimate plus 30% as gas",
    () => {
      const { sent, layer } = wallet()
      const { state, adapter } = setup(layer)
      return Effect.gen(function* () {
        const burn = yield* (yield* adapter).burn(burnParams)
        assert.strictEqual(
          burn.transactionHash,
          `0xbeef${"2".padStart(60, "0")}`
        )
        assert.strictEqual(sent.length, 2)

        const [approve, deposit] = sent
        assert.strictEqual(approve!.to, chain.usdc)
        assert.deepStrictEqual(
          decodeFunctionData({ abi: erc20Abi, data: approve!.data }),
          {
            functionName: "approve",
            args: [chain.tokenMessenger, 25_000_000n],
          }
        )
        assert.strictEqual(deposit!.to, chain.tokenMessenger)
        assert.strictEqual(deposit!.gas, 130_000n)
        assert.deepStrictEqual(
          decodeFunctionData({ abi: tokenMessengerV2Abi, data: deposit!.data }),
          {
            functionName: "depositForBurn",
            args: [25_000_000n, 5, RECIPIENT, chain.usdc, ZERO32, 2_500n, 1000],
          }
        )
        // Estimated from the sender, so a revert shows before anything is signed.
        assert.isTrue(state.estimates.every((e) => e.account === ALICE))
      })
    }
  )

  it.effect(
    "skips the approval when the allowance covers it, and attaches hook data",
    () => {
      const { sent, layer } = wallet()
      const { state, adapter } = setup(layer)
      state.allowance = 25_000_000n
      return Effect.gen(function* () {
        yield* (yield* adapter).burn({
          ...burnParams,
          hookData: new Uint8Array([1, 2]),
        })
        assert.strictEqual(sent.length, 1)
        const call = decodeFunctionData({
          abi: tokenMessengerV2Abi,
          data: sent[0]!.data,
        })
        assert.strictEqual(call.functionName, "depositForBurnWithHook")
        assert.strictEqual(call.args.at(-1), "0x0102")
      })
    }
  )

  it.effect("refuses to burn before signing when something is wrong", () =>
    Effect.gen(function* () {
      const tagOf = (
        prepare: (state: ReturnType<typeof node>["state"]) => void,
        signer: Layer.Layer<EvmSigner> | "none" = wallet().layer
      ) => {
        const made = setup(signer === "none" ? undefined : signer)
        prepare(made.state)
        return Effect.gen(function* () {
          const error = yield* Effect.flip(
            (yield* made.adapter).burn(burnParams)
          )
          return error._tag
        })
      }
      assert.strictEqual(yield* tagOf(() => {}, "none"), "SignerUnavailable")
      assert.strictEqual(
        yield* tagOf(() => {}, wallet(chain.usdc).layer),
        "SignerError"
      )
      assert.strictEqual(
        yield* tagOf((s) => void (s.chainId = 1)),
        "ChainIdMismatch"
      )
      assert.strictEqual(
        yield* tagOf((s) => void (s.usdc = 1n)),
        "InsufficientBalance"
      )
      assert.strictEqual(
        yield* tagOf((s) => void (s.native = 1n)),
        "InsufficientGas"
      )
      assert.strictEqual(
        yield* tagOf((s) => void (s.estimateFails = "execution reverted")),
        "TransactionFailed"
      )
    })
  )

  it.effect("tells a reverted burn from one whose receipt never came", () =>
    Effect.gen(function* () {
      const outcome = (receipt: "reverted" | "lost") => {
        const made = setup(wallet().layer)
        made.state.receipt = receipt
        made.state.allowance = 10n ** 12n
        return Effect.gen(function* () {
          return yield* Effect.flip((yield* made.adapter).burn(burnParams))
        })
      }
      assert.strictEqual((yield* outcome("reverted"))._tag, "TransactionFailed")
      const lost = yield* outcome("lost")
      assert.strictEqual(lost._tag, "SubmissionUnknown")
      assert.isDefined((lost as SubmissionUnknown).transactionHash)
    })
  )

  it.effect(
    "reads the delivery oracle, and fails rather than guess on a wrong chain",
    () => {
      const { state, adapter } = setup(undefined)
      return Effect.gen(function* () {
        const a = yield* adapter
        assert.isFalse(yield* a.isNonceUsed(ZERO32))
        state.usedNonce = 1n
        assert.isTrue(yield* a.isNonceUsed(ZERO32))
        state.chainId = 10
        assert.strictEqual(
          (yield* Effect.flip(a.isNonceUsed(ZERO32)))._tag,
          "ChainIdMismatch"
        )
      })
    }
  )

  it.effect(
    "claims a real message with receiveMessage on the transmitter",
    () => {
      const arbitrum = node()
      arbitrum.state.chainId = mainnet.arbitrum.chainId
      const { sent, layer } = wallet()
      return Effect.gen(function* () {
        const adapter = yield* EvmAdapter.make(mainnet.arbitrum, {
          client: arbitrum.client,
        })
        const cost = yield* adapter.estimateClaimCost(
          hexToBytes(real.message),
          hexToBytes(real.attestation)
        )
        assert.deepStrictEqual(cost, {
          amount: 130_000n * 1_000_000n,
          unit: "wei",
        })
        const claim = yield* adapter.claim(
          hexToBytes(real.message),
          hexToBytes(real.attestation)
        )
        assert.match(claim.transactionHash, /^0xbeef/)
        assert.strictEqual(sent[0]!.to, mainnet.arbitrum.messageTransmitter)
        assert.strictEqual(sent[0]!.gas, 130_000n)
        assert.deepStrictEqual(
          decodeFunctionData({
            abi: messageTransmitterV2Abi,
            data: sent[0]!.data,
          }),
          {
            functionName: "receiveMessage",
            args: [real.message as Hex, real.attestation as Hex],
          }
        )
        // Arbitrum compares expirationBlock with the parent chain's height.
        assert.isTrue(Option.isNone(yield* adapter.expirationHeight))
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("names why a claim cannot go through, before signing", () =>
    Effect.gen(function* () {
      const tagOf = (
        prepare: (state: ReturnType<typeof node>["state"]) => void,
        message = real.message
      ) => {
        const n = node()
        n.state.chainId = mainnet.arbitrum.chainId
        prepare(n.state)
        const { sent, layer } = wallet()
        return Effect.gen(function* () {
          const adapter = yield* EvmAdapter.make(mainnet.arbitrum, {
            client: n.client,
          })
          const error = yield* Effect.flip(
            adapter.claim(hexToBytes(message), hexToBytes(real.attestation))
          )
          assert.strictEqual(sent.length, 0)
          return error._tag
        }).pipe(Effect.provide(layer))
      }
      assert.strictEqual(
        yield* tagOf((s) => void (s.usedNonce = 1n)),
        "NonceAlreadyUsed"
      )
      assert.strictEqual(
        yield* tagOf(
          (s) =>
            void (s.estimateFails = "Message expired and must be re-signed")
        ),
        "MessageExpired"
      )
      assert.strictEqual(
        yield* tagOf((s) => void (s.estimateFails = "Nonce already used")),
        "NonceAlreadyUsed"
      )
      assert.strictEqual(
        yield* tagOf(
          (s) => void (s.estimateFails = "Invalid attestation length")
        ),
        "TransactionFailed"
      )
      assert.strictEqual(
        yield* tagOf((s) => void (s.native = 0n)),
        "InsufficientGas"
      )
      // A message for Solana is not claimable on Arbitrum.
      assert.strictEqual(
        yield* tagOf(
          () => {},
          captured.baseToSolana.iris.body.messages[0]!.message
        ),
        "MalformedMessage"
      )
    })
  )

  it.effect("scans burns in pages, only up to the finalized block", () => {
    const { state, adapter } = setup(undefined)
    const args = {
      amount: 7n,
      destinationDomain: 5,
      mintRecipient: RECIPIENT,
      destinationCaller: ZERO32,
      maxFee: 1n,
      minFinalityThreshold: 2000,
      hookData: "0x",
    }
    state.logs = [
      { blockNumber: 850n, args },
      { blockNumber: 999n, args: { ...args, amount: 8n } },
      // Not final yet: must not be reported.
      { blockNumber: 1_020n, args: { ...args, amount: 9n } },
    ]
    return Effect.gen(function* () {
      const a = yield* adapter
      assert.strictEqual(yield* a.burnCursor(ALICE), "1000")
      const burns = yield* Stream.runCollect(
        a.findBurns({ depositor: ALICE, since: "799" })
      )
      assert.deepStrictEqual(
        burns.map((b) => b.amount),
        [7n, 8n]
      )
      assert.strictEqual(
        burns[0]!.transactionHash,
        `0xaa${(850).toString(16).padStart(62, "0")}`
      )
      assert.deepStrictEqual(state.logRequests, [
        [800n, 899n],
        [900n, 999n],
        [1_000n, 1_000n],
      ])
      assert.deepStrictEqual(yield* a.expirationHeight, Option.some(1_050n))
    })
  })
})
