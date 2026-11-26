import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { PublicKey } from "@solana/web3.js"
import { Transaction } from "@mysten/sui/transactions"
import { fromBase64, normalizeSuiObjectId } from "@mysten/sui/utils"
import { keccak256, pad, toBytes } from "viem"
import { fromHex, toHex, ZERO_BYTES32, type Hex } from "../src/core/bytes.ts"
import type { SuiChainRef } from "../src/core/domain.ts"
import * as Message from "../src/core/message.ts"
import { mainnet, testnet } from "../src/core/registry.ts"
import {
  addBurn,
  claimRefusal,
  claimTransaction,
  DepositForBurnEvent,
  depositForBurnEventType,
  isNonceUsedTransaction,
} from "../src/sui/ptb.ts"
import captured from "./fixtures/captured-sui.json" with { type: "json" }

interface Argument {
  $kind: string
  Input?: number
  Result?: number
  NestedResult?: [number, number]
}
interface Command {
  $kind: string
  MoveCall?: {
    package: string
    module: string
    function: string
    typeArguments: Array<string>
    arguments: Array<Argument>
  }
}
interface Input {
  $kind: string
  Pure?: { bytes: string }
  Object?: { SharedObject?: { objectId: string } }
  UnresolvedObject?: { objectId: string }
}

/**
 * A command in a form two transactions can be compared in: the call, and
 * each argument as what it is (the pure bytes, the object's id, or which
 * earlier call's result it takes, counted from `base`) rather than where in
 * the input list it happens to sit.
 */
const canonical = (
  data: { inputs: ReadonlyArray<unknown>; commands: ReadonlyArray<unknown> },
  from: number,
  skipFirstArgument = false
) =>
  (data.commands as Array<Command>).slice(from).map((command, index) => {
    const call = command.MoveCall!
    return {
      target: `${normalizeSuiObjectId(call.package)}::${call.module}::${call.function}`,
      typeArguments: call.typeArguments,
      arguments: call.arguments
        .slice(index === 0 && skipFirstArgument ? 1 : 0)
        .map((argument) => {
          if (argument.$kind === "Input") {
            const input = (data.inputs as Array<Input>)[argument.Input!]!
            if (input.Pure !== undefined) return `pure:${input.Pure.bytes}`
            const id =
              input.Object?.SharedObject?.objectId ??
              input.UnresolvedObject?.objectId
            return `object:${normalizeSuiObjectId(id!)}`
          }
          const [command, result] = argument.NestedResult ?? [
            argument.Result!,
            0,
          ]
          return `result:${command - from}:${result}`
        }),
    }
  })

/** The bytes of a BCS `vector<u8>` pure input. */
const vectorU8 = (base64: string): Uint8Array => {
  const bcs = fromBase64(base64)
  let length = 0
  let shift = 0
  let offset = 0
  for (;;) {
    const byte = bcs[offset++]!
    length |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return Uint8Array.from(bcs.subarray(offset, offset + length))
}

const evm32 = (address: string): Hex =>
  pad(address.toLowerCase() as Hex, { size: 32 })

const claims = [
  ["mainnet", mainnet.sui, captured.mainnet.claim, mainnet.arbitrum],
  ["testnet", testnet.sui, captured.testnet.claim, testnet.base],
] as const

describe.each(claims)(
  "a real %s claim on Sui",
  (_name, chain, real, source) => {
    const message = fromHex(real.message)
    const attestation = vectorU8((real.inputs[1] as Input).Pure!.bytes)

    it("is reproduced command for command", () => {
      assert.isTrue(real.status.success)
      const built = claimTransaction(chain, message, attestation).getData()
      assert.deepStrictEqual(canonical(built, 0), canonical(real, 0))
      assert.deepStrictEqual(
        canonical(built, 0).map((c) =>
          c.target.split("::").slice(1).join("::")
        ),
        [
          "receive_message::receive_message",
          "handle_receive_message::prepare_mint",
          "handler::mint",
          "handle_receive_message::complete_mint",
        ]
      )
    })

    it("carried the message Iris attested", () => {
      const [entry] = real.iris.body.messages
      assert.strictEqual(real.iris.httpStatus, 200)
      assert.strictEqual(entry!.message, real.message)
      assert.strictEqual(entry!.attestation, toHex(attestation))
    })

    it.effect("names Sui the way the registry does", () =>
      Effect.gen(function* () {
        const decoded = Message.decodeBurnMessage(message)
        // Everything the registry is responsible for comes from the registry.
        const validated = yield* Message.validate(message, attestation, {
          sourceDomain: source.domain,
          destinationDomain: 8,
          sourceMessenger: evm32(source.tokenMessenger),
          destinationMessenger: chain.messenger,
          destinationCaller: ZERO_BYTES32,
          minFinalityThreshold: decoded.minFinalityThreshold,
          burnToken: evm32(source.usdc),
          mintRecipient: decoded.mintRecipient,
          amount: decoded.amount,
          messageSender: decoded.messageSender,
          maxFee: decoded.maxFee,
          hookData: decoded.hookData,
        })
        assert.strictEqual(validated.recipient, chain.messenger)
      })
    )
  }
)

const burns = [
  [
    "mainnet Sui → OP Mainnet",
    mainnet.sui,
    captured.mainnet.burns.toEvm,
    evm32(mainnet.optimism.tokenMessenger),
  ],
  [
    "mainnet Sui → Solana",
    mainnet.sui,
    captured.mainnet.burns.toSolana,
    toHex(new PublicKey(mainnet.solana.tokenMessengerMinter).toBytes()),
  ],
  [
    "testnet Sui → Base Sepolia",
    testnet.sui,
    captured.testnet.burns.toEvm,
    evm32(testnet.base.tokenMessenger),
  ],
] as const

describe.each(burns)(
  "a real %s burn",
  (_name, chain, real, destinationMessenger) => {
    const event = DepositForBurnEvent.parse(fromHex(real.event.bcs))
    const args = {
      amount: BigInt(event.amount),
      destinationDomain: event.destination_domain,
      mintRecipient: event.mint_recipient as Hex,
      destinationCaller: event.destination_caller as Hex,
      maxFee: BigInt(event.max_fee),
      minFinalityThreshold: event.min_finality_threshold,
      hookData: Uint8Array.from(event.hook_data),
    }

    it("emitted the event type the adapter looks for", () => {
      assert.strictEqual(real.event.eventType, depositForBurnEventType(chain))
      assert.strictEqual(event.depositor, real.sender)
      assert.strictEqual(event.burn_token, chain.usdcTokenId)
      assert.strictEqual(
        event.destination_token_messenger,
        destinationMessenger
      )
    })

    it("is reproduced call for call, after however the coin was gathered", () => {
      const tx = new Transaction()
      // The coin is whatever the sender's funds resolve to: here, a stand-in.
      addBurn(tx, chain, tx.gas, args)
      const at = (real.commands as Array<Command>).findIndex(
        (c) => c.MoveCall?.function === "deposit_for_burn"
      )
      assert.strictEqual(real.commands.length, at + 3)
      assert.deepStrictEqual(
        canonical(tx.getData(), 0, true),
        canonical(real, at, true)
      )
    })

    it.effect("produced the message the registry and the event predict", () =>
      Effect.gen(function* () {
        const [entry] = real.iris.body.messages
        const decoded = yield* Message.validate(
          fromHex(entry!.message),
          fromHex(entry!.attestation),
          {
            sourceDomain: 8,
            destinationDomain: args.destinationDomain,
            sourceMessenger: chain.messenger,
            destinationMessenger,
            destinationCaller: args.destinationCaller,
            minFinalityThreshold: args.minFinalityThreshold,
            burnToken: chain.usdcTokenId,
            mintRecipient: args.mintRecipient,
            amount: args.amount,
            // On Sui the message sender is the transaction's sender.
            messageSender: real.sender as Hex,
            maxFee: args.maxFee,
            hookData: args.hookData,
          }
        )
        assert.strictEqual(decoded.sourceDomain, 8)
      })
    )
  }
)

describe("Sui identifiers", () => {
  const typeName = (type: string) => type.replace(/^0x/, "")
  it.each([
    ["mainnet", mainnet.sui],
    ["testnet", testnet.sui],
  ] as const)(
    "on %s are the hashes of the type names, as Circle's Move derives them",
    (_n, chain: SuiChainRef) => {
      assert.strictEqual(
        keccak256(
          toBytes(
            `${typeName(chain.tokenMessengerMinterPackage)}::message_transmitter_authenticator::MessageTransmitterAuthenticator`
          )
        ),
        chain.messenger
      )
      assert.strictEqual(
        keccak256(toBytes(typeName(chain.usdc))),
        chain.usdcTokenId
      )
      assert.strictEqual(
        chain.chainIdentifier,
        captured[chain.network].chainIdentifier
      )
      assert.isFalse(chain.fastSource)
      assert.strictEqual(chain.domain, 8)
    }
  )
})

describe("Sui views and refusals", () => {
  it("reads the nonce with state::is_nonce_used(state, u256)", () => {
    const nonce = `0x${"00".repeat(31)}07` as const
    const data = isNonceUsedTransaction(mainnet.sui, nonce).getData()
    const [call] = canonical(data, 0)
    assert.strictEqual(
      call!.target,
      `${mainnet.sui.messageTransmitterPackage}::state::is_nonce_used`
    )
    assert.strictEqual(
      call!.arguments[0],
      `object:${mainnet.sui.messageTransmitterState}`
    )
    // A u256, little-endian: 7 then 31 zero bytes.
    assert.deepStrictEqual(
      [...fromBase64(call!.arguments[1]!.slice(5))],
      [7, ...new Array(31).fill(0)]
    )
  })

  it.each([
    ["receive_message", "4", "NonceAlreadyUsed"],
    ["handle_receive_message", "8", "MessageExpired"],
    ["treasury", "1", "RecipientDenied"],
    ["treasury", "9", undefined],
    ["receive_message", "0", undefined],
    ["handle_receive_message", "9", undefined],
  ] as const)("reads abort %s:%s as %s", (module, abortCode, expected) => {
    assert.strictEqual(
      claimRefusal({
        $kind: "MoveAbort",
        message: "abort",
        MoveAbort: { abortCode, location: { module } },
      }),
      expected
    )
  })

  it("reads Sui's own deny-list error as RecipientDenied, and nothing else as a refusal", () => {
    assert.strictEqual(
      claimRefusal({
        $kind: "CoinDenyListError",
        message: "denied",
        CoinDenyListError: {} as never,
      }),
      "RecipientDenied"
    )
    assert.isUndefined(
      claimRefusal({ $kind: "Unknown", message: "?", Unknown: null })
    )
  })
})
