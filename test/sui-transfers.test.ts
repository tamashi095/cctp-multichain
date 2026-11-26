import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Keypair, PublicKey, type Connection } from "@solana/web3.js"
import { Transaction } from "@mysten/sui/transactions"
import { decodeFunctionData } from "viem"
import { vi } from "vitest"
import { fromHex, toHex, type Hex } from "../src/core/bytes.ts"
import { Adapters } from "../src/core/ChainAdapter.ts"
import * as Message from "../src/core/message.ts"
import { mainnet } from "../src/core/registry.ts"
import { Relayer } from "../src/core/Relayer.ts"
import type { Transfer } from "../src/core/Transfer.ts"
import { Transfers } from "../src/core/Transfers.ts"
import { TransferStore } from "../src/core/TransferStore.ts"
import { messageTransmitterV2Abi } from "../src/evm/abi.ts"
import * as EvmAdapter from "../src/evm/EvmAdapter.ts"
import {
  associatedTokenAccount,
  usedNonceAccount,
} from "../src/solana/instructions.ts"
import * as SolanaAdapter from "../src/solana/SolanaAdapter.ts"
import * as SuiAdapter from "../src/sui/SuiAdapter.ts"
import { node, wallet } from "./evm-node.ts"
import captured from "./fixtures/captured-sui.json" with { type: "json" }
import { callsOf, pureInputsOf, suiClient, suiSigner } from "./sui-client.ts"
import { attested, fakeIris, NONCE } from "./support.ts"

/** Runs a transfer's stream to its end while time passes, as polling needs. */
const collect = <E, R>(stream: Stream.Stream<Transfer, E, R>) =>
  Effect.gen(function* () {
    const seen: Array<Transfer> = []
    const fiber = yield* Effect.forkChild(
      Effect.exit(
        Stream.runForEach(stream, (t) => Effect.sync(() => seen.push(t)))
      )
    )
    yield* TestClock.adjust("2 hours")
    return { seen, exit: yield* Fiber.join(fiber) }
  })

/** The orchestrator over real adapters, each on a scripted node. */
const orchestrate = <E, R>(
  adapters: Layer.Layer<Adapters, E, R>,
  iris: ReturnType<typeof fakeIris>,
  extra: Layer.Layer<Relayer> | Layer.Layer<never> = Layer.empty
) =>
  Transfers.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(adapters, iris.layer, TransferStore.layerMemory, extra)
    )
  )

const evmNode = (chain: Parameters<typeof node>[0] & { chainId: number }) => {
  const made = node(chain)
  made.state.chainId = chain.chainId
  return made
}

describe("transfers through Sui, over real adapters", () => {
  beforeEach(() => {
    // Building needs a node to resolve objects and gas: see sui-adapter.test.ts.
    vi.spyOn(Transaction.prototype, "build").mockResolvedValue(Uint8Array.of(1))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("Arbitrum → Sui: replaying a real mainnet transfer", () => {
    // What Circle attested for a real burn on Arbitrum, and what claimed it on Sui.
    const real = captured.mainnet.claim.iris.body.messages[0]!
    const body = real.decodedMessage.decodedMessageBody
    const request = {
      id: "arb-sui",
      sourceDomain: 3,
      destinationDomain: 8,
      sender: body.messageSender,
      recipient: body.mintRecipient,
      amount: BigInt(body.amount),
    }
    const world = () => {
      const arbitrum = evmNode(mainnet.arbitrum)
      arbitrum.state.usdc = request.amount
      const signer = wallet(request.sender as Hex)
      const sui = suiClient(mainnet.sui)
      const iris = fakeIris("mainnet")
      iris.messages = [
        [
          {
            _tag: "Attested",
            message: fromHex(real.message),
            attestation: fromHex(real.attestation),
          },
        ],
      ]
      const layer = orchestrate(
        Adapters.layer([
          EvmAdapter.make(mainnet.arbitrum, { client: arbitrum.client }),
          SuiAdapter.make(mainnet.sui, { client: sui.client }),
        ]).pipe(
          Layer.provide(
            Layer.mergeAll(signer.layer, suiSigner(request.recipient))
          )
        ),
        iris
      )
      return { arbitrum, signer, sui, iris, layer }
    }

    it.effect(
      "burns on Arbitrum, accepts Circle's real message, and claims on Sui",
      () => {
        const { signer, sui, layer } = world()
        return Effect.gen(function* () {
          const transfers = yield* Transfers
          const { seen, exit } = yield* collect(transfers.start(request))

          assert.strictEqual(exit._tag, "Success")
          assert.deepStrictEqual(
            seen.map((t) => t.status),
            ["burning", "attesting", "readyToMint", "minting", "complete"]
          )
          const done = seen.at(-1)!
          // The record named Sui exactly as the real message does.
          assert.strictEqual(done.destinationMessenger, mainnet.sui.messenger)
          assert.strictEqual(done.mintRecipient, body.mintRecipient)
          assert.strictEqual(done.message, real.message)
          assert.strictEqual(done.claimTx, "SuiDigest1")
          // An approval and a burn on Arbitrum; Circle's four calls on Sui.
          assert.strictEqual(signer.sent.length, 2)
          assert.deepStrictEqual(callsOf(sui.state.simulated.at(-1)!), [
            "receive_message::receive_message",
            "handle_receive_message::prepare_mint",
            "handler::mint",
            "handle_receive_message::complete_mint",
          ])
          assert.strictEqual(sui.state.executed.length, 1)
        }).pipe(Effect.provide(layer))
      }
    )

    it.effect(
      "a denied recipient leaves the transfer ready to mint, and it completes once lifted",
      () => {
        const { sui, layer } = world()
        sui.state.simulationError = {
          $kind: "MoveAbort",
          message: "MoveAbort in treasury::mint: 1",
          MoveAbort: { abortCode: "1", location: { module: "treasury" } },
        }
        return Effect.gen(function* () {
          const transfers = yield* Transfers
          const denied = yield* collect(transfers.start(request))
          assert.include(
            JSON.stringify(denied.exit),
            '"_tag":"RecipientDenied"'
          )
          const stored = yield* transfers.get(request.id)
          assert.strictEqual(stored.status, "readyToMint")
          assert.match(stored.error ?? "", /^RecipientDenied: /)
          assert.strictEqual(sui.state.executed.length, 0)

          sui.state.simulationError = null
          const lifted = yield* collect(transfers.run(request.id))
          assert.deepStrictEqual(
            lifted.seen.map((t) => t.status),
            ["readyToMint", "minting", "complete"]
          )
        }).pipe(Effect.provide(layer))
      }
    )

    it.effect(
      "refuses a recipient that is an object id before anything is burned",
      () => {
        const { sui, signer, layer } = world()
        sui.state.objects.add(request.recipient)
        return Effect.gen(function* () {
          const transfers = yield* Transfers
          const error = yield* Effect.flip(transfers.create(request))
          assert.strictEqual(error._tag, "InvalidAddress")
          assert.strictEqual(signer.sent.length, 0)
        }).pipe(Effect.provide(layer))
      }
    )
  })

  it.effect("Sui → OP Mainnet: replaying a real mainnet transfer", () => {
    const real = captured.mainnet.burns.toEvm
    const entry = real.iris.body.messages[0]!
    const body = entry.decodedMessage.decodedMessageBody
    const request = {
      id: "sui-op",
      sourceDomain: 8,
      destinationDomain: 2,
      sender: real.sender,
      recipient: body.mintRecipient,
      amount: BigInt(body.amount),
    }
    const sui = suiClient(mainnet.sui)
    sui.state.usdc = request.amount
    sui.state.digest = real.digest
    const optimism = evmNode(mainnet.optimism)
    const claimer = wallet()
    const iris = fakeIris("mainnet")
    iris.messages = [
      [
        {
          _tag: "Attested",
          message: fromHex(entry.message),
          attestation: fromHex(entry.attestation),
        },
      ],
    ]
    const layer = orchestrate(
      Adapters.layer([
        SuiAdapter.make(mainnet.sui, { client: sui.client }),
        EvmAdapter.make(mainnet.optimism, { client: optimism.client }),
      ]).pipe(
        Layer.provide(Layer.mergeAll(suiSigner(real.sender), claimer.layer))
      ),
      iris
    )
    return Effect.gen(function* () {
      const transfers = yield* Transfers
      const { seen, exit } = yield* collect(transfers.start(request))

      assert.strictEqual(exit._tag, "Success")
      const done = seen.at(-1)!
      assert.strictEqual(done.status, "complete")
      // The record predicted the real message: Sui's messenger, USDC's token id, the sender.
      assert.strictEqual(done.sourceMessenger, mainnet.sui.messenger)
      assert.strictEqual(done.burnToken, mainnet.sui.usdcTokenId)
      assert.strictEqual(done.messageSender, real.sender)
      assert.strictEqual(done.burnTx, real.digest)
      // Iris was asked by Sui's base58 digest.
      assert.deepStrictEqual(iris.calls, [`messages:${real.digest}`])
      assert.deepStrictEqual(callsOf(sui.state.simulated.at(-1)!).slice(-3), [
        "deposit_for_burn::deposit_for_burn",
        "handler::burn",
        "deposit_for_burn::complete_burn",
      ])
      // The claim on OP Mainnet carries the real message and attestation.
      assert.strictEqual(
        claimer.sent[0]!.to,
        mainnet.optimism.messageTransmitter
      )
      assert.deepStrictEqual(
        decodeFunctionData({
          abi: messageTransmitterV2Abi,
          data: claimer.sent[0]!.data,
        }).args,
        [entry.message as Hex, entry.attestation as Hex]
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "Sui → Solana: burns to the recipient's token account and a relayer delivers",
    () => {
      const sender = `0x${"a1".repeat(32)}`
      const recipient = Keypair.generate().publicKey
      const tokenAccount = toHex(
        associatedTokenAccount(
          recipient,
          new PublicKey(mainnet.solana.usdc)
        ).toBytes()
      )
      const sui = suiClient(mainnet.sui)
      sui.state.usdc = 50_000_000n
      // A Solana cluster that is only read: the relayer is the one who claims.
      const accounts = new Map<string, { owner: PublicKey; data: Buffer }>()
      const connection = {
        getGenesisHash: async () => mainnet.solana.genesisHash,
        getAccountInfo: async (key: PublicKey) =>
          accounts.get(key.toBase58()) ?? null,
      } as unknown as Connection
      const relayed: Array<number> = []
      const relayer = Layer.succeed(
        Relayer,
        Relayer.of({
          minAmount: 1n,
          submit: (request) =>
            Effect.sync(() => {
              relayed.push(request.destinationDomain)
              accounts.set(
                usedNonceAccount(mainnet.solana, fromHex(NONCE)).toBase58(),
                {
                  owner: new PublicKey(mainnet.solana.messageTransmitter),
                  data: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 1]),
                }
              )
            }),
        })
      )
      const iris = fakeIris("mainnet")
      const layer = orchestrate(
        Adapters.layer([
          SuiAdapter.make(mainnet.sui, { client: sui.client }),
          SolanaAdapter.make(mainnet.solana, { connection }),
        ]).pipe(Layer.provide(suiSigner(sender))),
        iris,
        relayer
      )
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* transfers.create({
          id: "sui-sol",
          sourceDomain: 8,
          destinationDomain: 5,
          sender,
          recipient: recipient.toBase58(),
          amount: 37_500_000n,
          // Sui offers no Fast Transfer: the request becomes Standard.
          speed: "fast",
        })
        assert.strictEqual(transfer.minFinalityThreshold, 2000)
        assert.strictEqual(transfer.mintRecipient, tokenAccount)
        iris.messages = [[attested(transfer)]]

        const { seen, exit } = yield* collect(transfers.run("sui-sol"))
        assert.strictEqual(exit._tag, "Success")
        assert.strictEqual(seen.at(-1)!.status, "complete")
        assert.strictEqual(seen.at(-1)!.claimedBy, "relayer")
        assert.deepStrictEqual(relayed, [5])
        // The burn on Sui names the Solana token account as its recipient.
        const burn = sui.state.simulated.at(-1)!
        assert.include(
          pureInputsOf(burn).map((bytes) => toHex(bytes)),
          tokenAccount
        )
        const message = Message.decodeBurnMessage(
          fromHex(seen.at(-1)!.message!)
        )
        assert.strictEqual(message.sender, mainnet.sui.messenger)
      }).pipe(Effect.provide(layer))
    }
  )
})
