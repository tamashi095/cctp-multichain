import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { PublicKey } from "@solana/web3.js"
import { pad } from "viem"
import { fromHex, toHex, ZERO_BYTES32, type Hex } from "../src/core/bytes.ts"
import * as Message from "../src/core/message.ts"
import { mainnet } from "../src/core/registry.ts"
import { decodeDepositForBurn } from "../src/solana/instructions.ts"
import captured from "./fixtures/captured.json" with { type: "json" }

const solanaBytes32 = (address: string): Hex =>
  toHex(new PublicKey(address).toBytes())
const evmBytes32 = (address: string): Hex =>
  pad(address.toLowerCase() as Hex, { size: 32 })

// Real attested burns (see scripts/capture-fixtures.ts). What each must say is
// built from the registry and from what the source chain recorded, not from
// the message under test.
const baseBurn = (fixture: typeof captured.baseToSolana, destination: Hex) => {
  const entry = fixture.iris.body.messages[0]!
  const body = entry.decodedMessage.decodedMessageBody
  const message = fromHex(entry.message)
  const expected: Message.ExpectedBurn = {
    sourceDomain: 6,
    destinationDomain: Number(entry.decodedMessage.destinationDomain),
    sourceMessenger: evmBytes32(mainnet.base.tokenMessenger),
    destinationMessenger: destination,
    destinationCaller: ZERO_BYTES32,
    minFinalityThreshold: Number(entry.decodedMessage.minFinalityThreshold),
    burnToken: evmBytes32(mainnet.base.usdc),
    mintRecipient: Message.decodeBurnMessage(message).mintRecipient,
    amount: BigInt(body.amount),
    messageSender: evmBytes32(fixture.depositor),
    maxFee: BigInt(body.maxFee),
    hookData: new Uint8Array(),
  }
  return { entry, message, attestation: fromHex(entry.attestation), expected }
}

const solanaBurn = () => {
  const burn = captured.solana.burn
  const entry = burn.iris.body.messages[0]!
  const args = decodeDepositForBurn(fromHex(burn.data))!
  const expected: Message.ExpectedBurn = {
    sourceDomain: 5,
    destinationDomain: args.destinationDomain,
    sourceMessenger: solanaBytes32(mainnet.solana.tokenMessengerMinter),
    destinationMessenger: evmBytes32(mainnet.ethereum.tokenMessenger),
    destinationCaller: toHex(args.destinationCaller),
    minFinalityThreshold: args.minFinalityThreshold,
    burnToken: solanaBytes32(mainnet.solana.usdc),
    mintRecipient: toHex(args.mintRecipient),
    amount: args.amount,
    // The instruction's first account is the owner who burned.
    messageSender: solanaBytes32(burn.accounts[0]!.pubkey),
    maxFee: args.maxFee,
    hookData: args.hookData,
  }
  return {
    entry,
    message: fromHex(entry.message),
    attestation: fromHex(entry.attestation),
    expected,
  }
}

const cases = [
  [
    "Base → Solana",
    baseBurn(
      captured.baseToSolana,
      solanaBytes32(mainnet.solana.tokenMessengerMinter)
    ),
  ],
  [
    "Base → Arbitrum",
    baseBurn(captured.baseToEvm, evmBytes32(mainnet.arbitrum.tokenMessenger)),
  ],
  ["Solana → Ethereum", solanaBurn()],
] as const

describe.each(cases)("a real %s message", (_name, burn) => {
  it("decodes to what Iris decoded, and encodes back to the same bytes", () => {
    const decoded = Message.decodeBurnMessage(burn.message)
    const iris = burn.entry.decodedMessage
    const body = iris.decodedMessageBody
    assert.strictEqual(decoded.version, 1)
    assert.strictEqual(decoded.bodyVersion, 1)
    assert.strictEqual(decoded.sourceDomain, Number(iris.sourceDomain))
    assert.strictEqual(
      decoded.destinationDomain,
      Number(iris.destinationDomain)
    )
    assert.strictEqual(decoded.nonce, iris.nonce)
    assert.strictEqual(
      decoded.minFinalityThreshold,
      Number(iris.minFinalityThreshold)
    )
    assert.strictEqual(
      decoded.finalityThresholdExecuted,
      Number(iris.finalityThresholdExecuted)
    )
    assert.strictEqual(decoded.amount, BigInt(body.amount))
    assert.strictEqual(decoded.maxFee, BigInt(body.maxFee))
    assert.strictEqual(decoded.feeExecuted, BigInt(body.feeExecuted))
    assert.strictEqual(decoded.expirationBlock, BigInt(body.expirationBlock))
    assert.strictEqual(decoded.hookData.length, 0)
    assert.deepStrictEqual(Message.encodeBurnMessage(decoded), burn.message)
  })

  it.effect("validates against the burn that was made", () =>
    Effect.gen(function* () {
      const decoded = yield* Message.validate(
        burn.message,
        burn.attestation,
        burn.expected
      )
      assert.strictEqual(decoded.amount, burn.expected.amount)
    })
  )

  it("is refused when any committed field differs", () => {
    const other32 = `0x${"11".repeat(32)}` as const
    const changes: Array<[string, Partial<Message.ExpectedBurn>]> = [
      ["sourceDomain", { sourceDomain: burn.expected.sourceDomain + 1 }],
      [
        "destinationDomain",
        { destinationDomain: burn.expected.destinationDomain + 1 },
      ],
      ["sender", { sourceMessenger: other32 }],
      ["recipient", { destinationMessenger: other32 }],
      ["destinationCaller", { destinationCaller: other32 }],
      [
        "minFinalityThreshold",
        { minFinalityThreshold: burn.expected.minFinalityThreshold + 1 },
      ],
      ["burnToken", { burnToken: other32 }],
      ["mintRecipient", { mintRecipient: other32 }],
      ["amount", { amount: burn.expected.amount + 1n }],
      ["messageSender", { messageSender: other32 }],
      ["maxFee", { maxFee: burn.expected.maxFee + 1n }],
      ["length", { hookData: new Uint8Array([1]) }],
    ]
    for (const [field, change] of changes)
      assert.strictEqual(
        Message.burnMessageProblem(burn.message, {
          ...burn.expected,
          ...change,
        })?.field,
        field
      )
  })

  it("is refused when an attester-filled field is out of bounds", () => {
    const decoded = Message.decodeBurnMessage(burn.message)
    const problem = (change: Partial<Message.BurnMessage>) =>
      Message.burnMessageProblem(
        Message.encodeBurnMessage({ ...decoded, ...change }),
        burn.expected
      )?.field
    assert.strictEqual(problem({ nonce: ZERO_BYTES32 }), "nonce")
    assert.strictEqual(
      problem({ feeExecuted: decoded.maxFee + 1n }),
      "feeExecuted"
    )
    assert.strictEqual(
      problem({ finalityThresholdExecuted: 500 }),
      "finalityThresholdExecuted"
    )
    // Whatever Circle fills in within bounds is accepted.
    assert.isUndefined(
      problem({ nonce: `0x${"22".repeat(32)}`, expirationBlock: 7n })
    )
  })
})

describe("Message", () => {
  const { message, attestation, expected } = cases[0][1]

  it("refuses a Standard request attested below finality", () => {
    const decoded = Message.decodeBurnMessage(message)
    assert.strictEqual(decoded.minFinalityThreshold, 2000)
    assert.strictEqual(
      Message.burnMessageProblem(
        Message.encodeBurnMessage({
          ...decoded,
          finalityThresholdExecuted: 1000,
        }),
        expected
      )?.field,
      "finalityThresholdExecuted"
    )
  })

  it.effect(
    "fails as MalformedMessage on short bytes or a ragged attestation",
    () =>
      Effect.gen(function* () {
        const short = yield* Effect.flip(Message.decode(message.slice(0, 375)))
        assert.strictEqual(short._tag, "MalformedMessage")
        const ragged = yield* Effect.flip(
          Message.validate(message, attestation.slice(1), expected)
        )
        assert.strictEqual(ragged._tag, "MalformedMessage")
        const none = yield* Effect.flip(
          Message.validate(message, new Uint8Array(), expected)
        )
        assert.strictEqual(none._tag, "MalformedMessage")
      })
  )

  it.effect("fails as MessageMismatch naming the field", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Message.validate(message, attestation, { ...expected, amount: 1n })
      )
      assert.strictEqual(error._tag, "MessageMismatch")
      assert.strictEqual(
        error._tag === "MessageMismatch" && error.field,
        "amount"
      )
    })
  )

  it("keeps hook data in the comparison", () => {
    const hookData = new Uint8Array([1, 2, 3])
    const decoded = Message.decodeBurnMessage(message)
    const hooked = Message.encodeBurnMessage({ ...decoded, hookData })
    assert.isNull(Message.burnMessageProblem(hooked, { ...expected, hookData }))
    assert.strictEqual(
      Message.burnMessageProblem(hooked, {
        ...expected,
        hookData: new Uint8Array([1, 2, 4]),
      })?.field,
      "hookData"
    )
  })
})
