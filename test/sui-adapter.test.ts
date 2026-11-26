import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Transaction } from "@mysten/sui/transactions"
import { vi } from "vitest"
import { fromHex } from "../src/core/bytes.ts"
import * as Message from "../src/core/message.ts"
import { mainnet } from "../src/core/registry.ts"
import * as SuiAdapter from "../src/sui/SuiAdapter.ts"
import type { SuiSigner } from "../src/sui/SuiSigner.ts"
import captured from "./fixtures/captured-sui.json" with { type: "json" }
import { callsOf, pureInputsOf, suiClient, suiSigner } from "./sui-client.ts"

const chain = mainnet.sui
const ALICE = `0x${"a1".repeat(32)}`
const SPONSOR = `0x${"5e".repeat(32)}`
const BUILT = Uint8Array.of(9, 9, 9)

// A real Arbitrum → Sui message and its attestation.
const real = captured.mainnet.claim.iris.body.messages[0]!
const message = fromHex(real.message)
const attestation = fromHex(real.attestation)
const decoded = Message.decodeBurnMessage(message)

const setup = (signer: Layer.Layer<SuiSigner> | "none" = suiSigner(ALICE)) => {
  const made = suiClient(chain)
  return {
    ...made,
    adapter: SuiAdapter.make(chain, { client: made.client }).pipe(
      Effect.provide(signer === "none" ? Layer.empty : signer)
    ),
  }
}

const abort = (module: string, abortCode: string) =>
  ({
    $kind: "MoveAbort",
    message: `MoveAbort in ${module}: ${abortCode}`,
    MoveAbort: { abortCode, location: { module } },
  }) as const

describe("SuiAdapter", () => {
  // Building resolves objects and gas against a node. The scripted client
  // has none, so the bytes are a stand-in and the transaction itself is
  // inspected where it is simulated.
  beforeEach(() => {
    vi.spyOn(Transaction.prototype, "build").mockResolvedValue(BUILT)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.effect(
    "accepts only a full 32-byte address that no object lives at",
    () => {
      const { state, adapter } = setup("none")
      return Effect.gen(function* () {
        const a = yield* adapter
        assert.strictEqual(a.messenger, chain.messenger)
        assert.strictEqual(a.usdc, chain.usdcTokenId)
        assert.strictEqual(
          yield* a.recipientFromAddress(
            ALICE.toUpperCase().replace("0X", "0x")
          ),
          ALICE
        )
        assert.strictEqual(yield* a.toBytes32(ALICE), ALICE)

        // Short forms are not padded into another address; zero is nobody.
        for (const bad of [
          "0x2",
          "0xabc",
          ALICE.slice(0, 64),
          `0x${"00".repeat(32)}`,
          "bob",
        ])
          assert.strictEqual(
            (yield* Effect.flip(a.recipientFromAddress(bad)))._tag,
            "InvalidAddress"
          )

        // A package or object id is not an account: USDC minted to it is lost.
        state.objects.add(chain.usdcTreasury)
        const object = yield* Effect.flip(
          a.recipientFromAddress(chain.usdcTreasury)
        )
        assert.strictEqual(object._tag, "InvalidAddress")
        assert.include(JSON.stringify(object), "would be lost")

        // An unanswered lookup is an error, never "no object there".
        state.objectsFail = true
        assert.strictEqual(
          (yield* Effect.flip(a.recipientFromAddress(ALICE)))._tag,
          "ChainError"
        )
      })
    }
  )

  it.effect("reads the delivery oracle by simulating is_nonce_used", () => {
    const { state, adapter } = setup("none")
    return Effect.gen(function* () {
      const a = yield* adapter
      assert.isFalse(yield* a.isNonceUsed(decoded.nonce))
      state.usedNonces.add(decoded.nonce)
      assert.isTrue(yield* a.isNonceUsed(decoded.nonce))
      // A read that failed is an error. It is never "unused".
      state.viewFails = true
      const failed = yield* Effect.flip(a.isNonceUsed(decoded.nonce))
      assert.strictEqual(failed._tag, "ChainError")
      state.viewFails = false
      state.chainIdentifier = mainnet.sui.usdcTreasury
      assert.strictEqual(
        (yield* Effect.flip(a.isNonceUsed(decoded.nonce)))._tag,
        "ChainIdMismatch"
      )
    })
  })

  it.effect(
    "claims a real message with Circle's four calls, paying gas in SUI",
    () => {
      const { state, adapter } = setup()
      return Effect.gen(function* () {
        const a = yield* adapter
        // computation + storage − rebate, in MIST.
        assert.deepStrictEqual(
          yield* a.estimateClaimCost(message, attestation),
          {
            amount: 2_750_000n,
            unit: "MIST",
          }
        )
        const claim = yield* a.claim(message, attestation)
        assert.strictEqual(claim.transactionHash, "SuiDigest1")

        const transaction = state.simulated.at(-1)!
        assert.deepStrictEqual(callsOf(transaction), [
          "receive_message::receive_message",
          "handle_receive_message::prepare_mint",
          "handler::mint",
          "handle_receive_message::complete_mint",
        ])
        assert.strictEqual(transaction.getData().sender, ALICE)
        assert.isNull(transaction.getData().gasData.owner)
        assert.deepStrictEqual(state.executed, [
          { bytes: BUILT, signatures: ["sender-signature"] },
        ])
      })
    }
  )

  it.effect(
    "lets a sponsor pay the gas: both sign, and the sponsor's SUI is what is checked",
    () => {
      const { state, adapter } = setup(
        suiSigner(ALICE, {
          address: SPONSOR,
          sign: async () => "sponsor-signature",
        })
      )
      state.sui = 0n
      state.suiOf.set(SPONSOR, 10_000_000n)
      return Effect.gen(function* () {
        yield* (yield* adapter).claim(message, attestation)
        const data = state.simulated.at(-1)!.getData()
        assert.strictEqual(data.sender, ALICE)
        assert.strictEqual(data.gasData.owner, SPONSOR)
        assert.deepStrictEqual(state.executed[0]!.signatures, [
          "sender-signature",
          "sponsor-signature",
        ])
      })
    }
  )

  it.effect("names why a claim cannot go through, before signing", () =>
    Effect.gen(function* () {
      const errorOf = (
        prepare: (state: ReturnType<typeof suiClient>["state"]) => void,
        signer: Layer.Layer<SuiSigner> | "none" = suiSigner(ALICE),
        bytes = message
      ) => {
        const made = setup(signer)
        prepare(made.state)
        return Effect.gen(function* () {
          const error = yield* Effect.flip(
            (yield* made.adapter).claim(bytes, attestation)
          )
          assert.strictEqual(made.state.executed.length, 0)
          return error
        })
      }
      const tagOf = (...args: Parameters<typeof errorOf>) =>
        Effect.map(errorOf(...args), (e) => e._tag)

      assert.strictEqual(yield* tagOf(() => {}, "none"), "SignerUnavailable")
      assert.strictEqual(
        yield* tagOf((s) => void s.usedNonces.add(decoded.nonce)),
        "NonceAlreadyUsed"
      )
      assert.strictEqual(
        yield* tagOf(
          (s) => void (s.simulationError = abort("receive_message", "4"))
        ),
        "NonceAlreadyUsed"
      )
      assert.strictEqual(
        yield* tagOf(
          (s) => void (s.simulationError = abort("handle_receive_message", "8"))
        ),
        "MessageExpired"
      )
      assert.strictEqual(
        yield* tagOf(
          (s) => void (s.simulationError = abort("handle_receive_message", "6"))
        ),
        "TransactionFailed"
      )
      // 0.00275 SUI plus a fifth of headroom is 3 300 000 MIST.
      const poor = yield* errorOf((s) => void (s.sui = 3_299_999n))
      assert.strictEqual(poor._tag, "InsufficientGas")
      assert.deepInclude(poor, {
        address: ALICE,
        required: 3_300_000n,
        available: 3_299_999n,
      })
      // A message for another chain is not claimable here.
      const other = Message.encodeBurnMessage({
        ...decoded,
        destinationDomain: 5,
      })
      assert.strictEqual(
        yield* tagOf(() => {}, suiSigner(ALICE), other),
        "MalformedMessage"
      )
    })
  )

  it.effect(
    "reports a denied recipient as RecipientDenied, from the abort or from Sui itself",
    () =>
      Effect.gen(function* () {
        for (const error of [
          abort("treasury", "1"),
          {
            $kind: "CoinDenyListError",
            message: "address is denied",
            CoinDenyListError: {},
          } as never,
        ]) {
          const { state, adapter } = setup()
          state.simulationError = error
          const refused = yield* Effect.flip(
            (yield* adapter).claim(message, attestation)
          )
          assert.strictEqual(refused._tag, "RecipientDenied")
          // Nothing was signed and the nonce is untouched: the claim can be made again.
          assert.strictEqual(state.executed.length, 0)
          assert.isFalse(yield* (yield* adapter).isNonceUsed(decoded.nonce))
        }
      })
  )

  it.effect(
    "tells an executed failure from a send whose outcome is unknown",
    () =>
      Effect.gen(function* () {
        const denied = setup()
        denied.state.executionError = abort("treasury", "1")
        assert.strictEqual(
          (yield* Effect.flip(
            (yield* denied.adapter).claim(message, attestation)
          ))._tag,
          "RecipientDenied"
        )
        const lost = setup()
        lost.state.executeThrows = true
        assert.strictEqual(
          (yield* Effect.flip(
            (yield* lost.adapter).claim(message, attestation)
          ))._tag,
          "SubmissionUnknown"
        )
      })
  )

  const burnParams = {
    sender: ALICE,
    amount: 5_000_000n,
    destinationDomain: 6,
    mintRecipient: `0x${"00".repeat(12)}${"ab".repeat(20)}`,
    destinationCaller: `0x${"00".repeat(32)}`,
    maxFee: 0n,
    minFinalityThreshold: 2000,
    hookData: new Uint8Array(),
  } as const

  it.effect(
    "burns with deposit_for_burn, handler::burn and complete_burn",
    () => {
      const { state, adapter } = setup()
      state.usdc = 6_000_000n
      return Effect.gen(function* () {
        const burn = yield* (yield* adapter).burn(burnParams)
        assert.strictEqual(burn.transactionHash, "SuiDigest1")
        const transaction = state.simulated.at(-1)!
        assert.deepStrictEqual(callsOf(transaction).slice(-3), [
          "deposit_for_burn::deposit_for_burn",
          "handler::burn",
          "deposit_for_burn::complete_burn",
        ])
        // u32 domain, the recipient and caller as addresses, u256 fee, u32 threshold, empty hook.
        assert.deepStrictEqual(
          pureInputsOf(transaction).map((bytes) =>
            Buffer.from(bytes).toString("hex")
          ),
          [
            "06000000",
            burnParams.mintRecipient.slice(2),
            "00".repeat(32),
            "00".repeat(32),
            "d0070000",
            "00",
          ]
        )
        assert.strictEqual(transaction.getData().sender, ALICE)
      })
    }
  )

  it.effect(
    "refuses to burn more USDC than the sender has, or for another sender",
    () => {
      const { state, adapter } = setup()
      state.usdc = 4_999_999n
      return Effect.gen(function* () {
        const a = yield* adapter
        assert.strictEqual(
          (yield* Effect.flip(a.burn(burnParams)))._tag,
          "InsufficientBalance"
        )
        assert.strictEqual(
          (yield* Effect.flip(a.burn({ ...burnParams, sender: SPONSOR })))._tag,
          "SignerError"
        )
        state.usdc = 5_000_000n
        state.simulationError = abort("deposit_for_burn", "3")
        assert.strictEqual(
          (yield* Effect.flip(a.burn(burnParams)))._tag,
          "TransactionFailed"
        )
        assert.strictEqual(state.executed.length, 0)
      })
    }
  )

  it.effect(
    "finds the sender's burns from their events, after the cursor",
    () => {
      const { state, adapter } = setup("none")
      const burn = captured.mainnet.burns.toEvm
      state.events = [
        {
          eventType: "0x2::coin::Other",
          bcs: Uint8Array.of(1),
          transactionDigest: "x",
        },
        {
          eventType: burn.event.eventType,
          bcs: fromHex(burn.event.bcs),
          transactionDigest: burn.digest,
        },
      ]
      return Effect.gen(function* () {
        const a = yield* adapter
        assert.strictEqual(yield* a.burnCursor(burn.sender), "cursor-newest")
        const found = yield* Stream.runCollect(
          a.findBurns({ depositor: burn.sender, since: "cursor-newest" })
        )
        const body =
          burn.iris.body.messages[0]!.decodedMessage.decodedMessageBody
        assert.deepStrictEqual(found, [
          {
            transactionHash: burn.digest,
            amount: BigInt(body.amount),
            destinationDomain: 2,
            mintRecipient: `0x${"00".repeat(12)}${body.mintRecipient.slice(2)}`,
            destinationCaller: `0x${"00".repeat(32)}`,
            maxFee: 0n,
            minFinalityThreshold: 2000,
            hookData: "0x",
          },
        ])
        assert.deepStrictEqual(state.eventRequests.at(-1), {
          filter: { sender: burn.sender },
          limit: 50,
          after: "cursor-newest",
        })
      })
    }
  )

  it.effect(
    "treats expirationBlock as a time: the clock plus a minute's margin",
    () =>
      Effect.gen(function* () {
        const a = yield* setup("none").adapter
        yield* TestClock.setTime(1_795_735_000_000)
        assert.deepStrictEqual(
          yield* a.expirationHeight,
          Option.some(1_795_735_060_000n)
        )
        // The real Fast message to Sui testnet expires at a millisecond timestamp.
        const fast = Message.decodeBurnMessage(
          fromHex(captured.testnet.claim.message)
        )
        assert.isTrue(fast.expirationBlock > 1_700_000_000_000n)
      })
  )
})
