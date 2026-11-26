import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  ChainError,
  IrisError,
  RelayerError,
  SignerError,
  SubmissionUnknown,
  TransactionFailed,
} from "../src/core/errors.ts"
import { Relayer } from "../src/core/Relayer.ts"
import { Transfer, type TransferStatus } from "../src/core/Transfer.ts"
import { Transfers } from "../src/core/Transfers.ts"
import { TransferStore } from "../src/core/TransferStore.ts"
import {
  adaptersOf,
  attested,
  fakeChain,
  fakeIris,
  NONCE,
  type FakeChain,
  type FakeIris,
} from "./support.ts"

const request = {
  id: "t1",
  sourceDomain: 0,
  destinationDomain: 5,
  sender: "alice",
  recipient: "bob",
  amount: 100_000_000n,
} as const

interface World {
  readonly source: FakeChain
  readonly destination: FakeChain
  readonly iris: FakeIris
}

/** A fresh pair of chains, Iris and store, with the orchestrator over them. */
const world = (relayer?: Layer.Layer<Relayer>) => {
  const w: World = {
    source: fakeChain(0),
    destination: fakeChain(5),
    iris: fakeIris(),
  }
  const layer = Transfers.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        adaptersOf(w.source, w.destination),
        w.iris.layer,
        TransferStore.layerMemory,
        relayer ?? Layer.empty
      )
    )
  )
  return { w, layer }
}

const statuses = (transfers: ReadonlyArray<Transfer>): Array<TransferStatus> =>
  transfers.map((t) => t.status)

/** Runs a stream to its end while time passes, as polling needs. */
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

/** The record as created, with the message Circle would attest for it. */
const created = Effect.gen(function* () {
  const transfers = yield* Transfers
  return yield* transfers.create(request)
})

const failureTag = (exit: { readonly _tag: string }) =>
  JSON.stringify(exit)
    .match(/"_tag":"([A-Za-z]+)"/g)
    ?.pop()

describe("Transfers", () => {
  it.effect(
    "burns, waits for the attestation, claims, and reports every state",
    () => {
      const { w, layer } = world()
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* created
        w.iris.messages = [
          "notIndexed",
          [{ _tag: "Pending" }],
          [attested(transfer)],
        ]

        const { seen, exit } = yield* collect(transfers.run("t1"))

        assert.strictEqual(exit._tag, "Success")
        assert.deepStrictEqual(statuses(seen), [
          "burning",
          "attesting",
          "readyToMint",
          "minting",
          "complete",
        ])
        const done = seen.at(-1)!
        assert.strictEqual(done.burnTx, "burn-0")
        assert.strictEqual(done.claimTx, "claim-5")
        assert.strictEqual(done.claimedBy, "self")
        assert.strictEqual(done.nonce, NONCE)
        assert.deepStrictEqual(w.source.calls, ["burn"])
        // The nonce is read before the relayer step and again before the claim.
        assert.deepStrictEqual(w.destination.calls, [
          "isNonceUsed",
          "isNonceUsed",
          "prepareRecipient",
          "claim",
        ])
        // Polled three times: not indexed, pending, attested.
        assert.strictEqual(w.iris.calls.length, 3)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "records zero destinationCaller and a quoted, capped maxFee",
    () => {
      const { w, layer } = world()
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const standard = yield* transfers.create(request)
        assert.strictEqual(standard.destinationCaller, "0x" + "00".repeat(32))
        assert.strictEqual(standard.minFinalityThreshold, 2000)
        assert.strictEqual(standard.maxFee, 0n)

        // 1 bps of 100 USDC is 10 000 subunits, plus 10% headroom.
        const fast = yield* transfers.create({
          ...request,
          id: "t2",
          speed: "fast",
        })
        assert.strictEqual(fast.minFinalityThreshold, 1000)
        assert.strictEqual(fast.maxFee, 11_000n)

        w.iris.minimumFeeBps = 150
        const tooDear = yield* Effect.flip(
          transfers.create({ ...request, id: "t3", speed: "fast" })
        )
        assert.strictEqual(tooDear._tag, "FeeAboveCeiling")

        w.iris.minimumFeeBps = 1
        w.iris.allowance = 5
        const downgraded = yield* transfers.create({
          ...request,
          id: "t4",
          speed: "fast",
        })
        assert.strictEqual(downgraded.minFinalityThreshold, 2000)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "refuses a transfer to the same chain, of nothing, or with a taken id",
    () => {
      const { layer } = world()
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const tag = (r: Parameters<typeof transfers.create>[0]) =>
          Effect.map(Effect.flip(transfers.create(r)), (e) => e._tag)
        assert.strictEqual(
          yield* tag({ ...request, destinationDomain: 0 }),
          "InvalidTransfer"
        )
        assert.strictEqual(
          yield* tag({ ...request, amount: 0n }),
          "InvalidTransfer"
        )
        assert.strictEqual(
          yield* tag({ ...request, destinationDomain: 9 }),
          "UnsupportedDomain"
        )
        yield* transfers.create(request)
        assert.strictEqual(yield* tag(request), "InvalidTransfer")
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("never claims a message that is not the burn it made", () => {
    const { w, layer } = world()
    return Effect.gen(function* () {
      const transfers = yield* Transfers
      const transfer = yield* created
      // Circle (or whoever answers for it) attests a different recipient.
      w.iris.messages = [
        [attested(transfer, { mintRecipient: `0x${"ab".repeat(32)}` })],
      ]

      const { seen, exit } = yield* collect(transfers.run("t1"))

      assert.strictEqual(failureTag(exit), '"_tag":"MessageMismatch"')
      assert.strictEqual(seen.at(-1)!.status, "attesting")
      assert.notInclude(w.destination.calls, "claim")
      const stored = yield* transfers.get("t1")
      assert.match(stored.error ?? "", /^MessageMismatch: /)
    }).pipe(Effect.provide(layer))
  })

  it.effect("picks its own message out of a transaction with several", () => {
    const { w, layer } = world()
    return Effect.gen(function* () {
      const transfers = yield* Transfers
      const transfer = yield* created
      w.iris.messages = [
        [attested(transfer, { amount: 5n }), attested(transfer)],
      ]
      const { seen } = yield* collect(transfers.run("t1"))
      assert.strictEqual(seen.at(-1)!.status, "complete")
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "times out waiting, stays attesting, and resumes without burning again",
    () => {
      const { w, layer } = world()
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* created
        w.iris.messages = [
          [{ _tag: "Pending", delayReason: "insufficient_fee" }],
        ]

        const first = yield* collect(transfers.run("t1"))
        assert.strictEqual(
          failureTag(first.exit),
          '"_tag":"AttestationTimeout"'
        )
        assert.include(JSON.stringify(first.exit), "insufficient_fee")
        assert.strictEqual((yield* transfers.get("t1")).status, "attesting")

        w.iris.messages = [[attested(transfer)]]
        const second = yield* collect(transfers.run("t1"))
        assert.deepStrictEqual(statuses(second.seen), [
          "attesting",
          "readyToMint",
          "minting",
          "complete",
        ])
        assert.deepStrictEqual(w.source.calls, ["burn"])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "keeps polling through retryable Iris failures and stops on others",
    () => {
      const { w, layer } = world()
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* created
        const busy = new IrisError({
          endpoint: "messages",
          retryable: true,
          status: 429,
          reason: "HTTP 429",
        })
        w.iris.messages = [busy, busy, [attested(transfer)]]
        const ok = yield* collect(transfers.run("t1"))
        assert.strictEqual(ok.seen.at(-1)!.status, "complete")

        const other = yield* transfers.create({ ...request, id: "t2" })
        w.iris.messages = [
          new IrisError({
            endpoint: "messages",
            retryable: false,
            status: 400,
            reason: "HTTP 400",
          }),
          [attested(other)],
        ]
        const stopped = yield* collect(transfers.run("t2"))
        assert.strictEqual(failureTag(stopped.exit), '"_tag":"IrisError"')
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("a refused signature burns nothing and the next run burns", () => {
    const { w, layer } = world()
    return Effect.gen(function* () {
      const transfers = yield* Transfers
      const transfer = yield* created
      w.iris.messages = [[attested(transfer)]]
      w.source.burn = () =>
        Effect.fail(new SignerError({ family: "fake", reason: "rejected" }))

      const refused = yield* collect(transfers.run("t1"))
      assert.strictEqual(failureTag(refused.exit), '"_tag":"SignerError"')
      const stored = yield* transfers.get("t1")
      assert.strictEqual(stored.status, "burning")
      assert.strictEqual(stored.burnStarted, false)

      w.source.burn = () => Effect.succeed({ transactionHash: "burn-again" })
      const second = yield* collect(transfers.run("t1"))
      assert.strictEqual(second.seen.at(-1)!.status, "complete")
      assert.strictEqual(second.seen.at(-1)!.burnTx, "burn-again")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a reverted burn fails the transfer until retryBurn", () => {
    const { w, layer } = world()
    return Effect.gen(function* () {
      const transfers = yield* Transfers
      yield* created
      w.source.burn = () =>
        Effect.fail(new TransactionFailed({ domain: 0, reason: "reverted" }))
      const failed = yield* collect(transfers.run("t1"))
      assert.strictEqual(failed.seen.at(-1)!.status, "burning")
      assert.strictEqual((yield* transfers.get("t1")).status, "failed")

      // A failed transfer does nothing when run again.
      const again = yield* collect(transfers.run("t1"))
      assert.deepStrictEqual(statuses(again.seen), ["failed"])
      assert.deepStrictEqual(w.source.calls, ["burn"])

      const reset = yield* transfers.retryBurn("t1")
      assert.strictEqual(reset.status, "burning")
      assert.strictEqual(reset.burnStarted, false)
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "after a burn of unknown outcome it searches the chain and never burns twice",
    () => {
      const { w, layer } = world()
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* created
        w.iris.messages = [[attested(transfer)]]
        w.source.burn = () =>
          Effect.fail(
            new SubmissionUnknown({ domain: 0, reason: "socket hang up" })
          )

        const lost = yield* collect(transfers.run("t1"))
        assert.strictEqual(failureTag(lost.exit), '"_tag":"SubmissionUnknown"')
        assert.strictEqual((yield* transfers.get("t1")).burnStarted, true)

        // Not found on chain yet: it stops rather than burn again.
        const unknown = yield* collect(transfers.run("t1"))
        assert.strictEqual(
          failureTag(unknown.exit),
          '"_tag":"BurnOutcomeUnknown"'
        )
        assert.deepStrictEqual(w.source.calls, ["burn", "findBurns"])

        // The burn is final now, beside another burn of the same sender.
        const mine = {
          transactionHash: "burn-found",
          amount: transfer.amount,
          destinationDomain: 5,
          mintRecipient: transfer.mintRecipient as `0x${string}`,
          destinationCaller: transfer.destinationCaller as `0x${string}`,
          maxFee: transfer.maxFee,
          minFinalityThreshold: transfer.minFinalityThreshold,
          hookData: "0x" as const,
        }
        w.source.found.push(
          { ...mine, transactionHash: "other", amount: 1n },
          mine
        )
        const found = yield* collect(transfers.run("t1"))
        assert.strictEqual(found.seen.at(-1)!.status, "complete")
        assert.strictEqual(found.seen.at(-1)!.burnTx, "burn-found")
        assert.strictEqual(w.source.calls.filter((c) => c === "burn").length, 1)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "attachBurn names a burn made elsewhere; a burned transfer cannot burn again",
    () => {
      const { w, layer } = world()
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* created
        w.iris.messages = [[attested(transfer)]]
        const attached = yield* transfers.attachBurn("t1", "0xabc")
        assert.strictEqual(attached.status, "attesting")
        assert.strictEqual(
          (yield* Effect.flip(transfers.retryBurn("t1")))._tag,
          "InvalidTransfer"
        )
        const { seen } = yield* collect(transfers.run("t1"))
        assert.strictEqual(seen.at(-1)!.status, "complete")
        assert.deepStrictEqual(w.source.calls, [])
        assert.deepStrictEqual(w.iris.calls, ["messages:0xabc"])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "a failed claim is settled by the nonce: used means delivered",
    () => {
      const { w, layer } = world()
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* created
        w.iris.messages = [[attested(transfer)]]
        // The claim lands, but the node drops the connection before answering.
        w.destination.claim = () =>
          Effect.suspend(() => {
            w.destination.used.add(NONCE)
            return Effect.fail(
              new SubmissionUnknown({ domain: 5, reason: "timeout" })
            )
          })
        const { seen, exit } = yield* collect(transfers.run("t1"))
        assert.strictEqual(exit._tag, "Success")
        assert.strictEqual(seen.at(-1)!.status, "complete")
        assert.strictEqual(seen.at(-1)!.claimedBy, "other")
        assert.deepStrictEqual(w.destination.calls.slice(-2), [
          "claim",
          "isNonceUsed",
        ])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "a failed claim with the nonce unused returns to readyToMint and can be resumed",
    () => {
      const { w, layer } = world()
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* created
        w.iris.messages = [[attested(transfer)]]
        const claim = w.destination.claim
        w.destination.claim = () =>
          Effect.fail(
            new ChainError({ domain: 5, method: "send", reason: "down" })
          )

        const failed = yield* collect(transfers.run("t1"))
        assert.strictEqual(failureTag(failed.exit), '"_tag":"ChainError"')
        const stored = yield* transfers.get("t1")
        assert.strictEqual(stored.status, "readyToMint")
        assert.strictEqual(stored.error, "ChainError: down")

        w.destination.claim = claim
        const resumed = yield* collect(transfers.run("t1"))
        assert.deepStrictEqual(statuses(resumed.seen), [
          "readyToMint",
          "minting",
          "complete",
        ])
        assert.strictEqual(w.iris.calls.length, 1)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "finds a transfer someone else delivered and does not claim",
    () => {
      const { w, layer } = world()
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* created
        w.iris.messages = [[attested(transfer)]]
        w.destination.used.add(NONCE)
        const { seen } = yield* collect(transfers.run("t1"))
        assert.strictEqual(seen.at(-1)!.status, "complete")
        assert.strictEqual(seen.at(-1)!.claimedBy, "other")
        assert.notInclude(w.destination.calls, "claim")
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "re-attests a Fast message near its expiration and claims the new one",
    () => {
      const { w, layer } = world()
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* transfers.create({ ...request, speed: "fast" })
        const stale = attested(transfer, {
          expirationBlock: 1_000n,
          feeExecuted: 10_000n,
        })
        const fresh = attested(transfer, {
          expirationBlock: 9_000n,
          feeExecuted: 10_000n,
        })
        // Iris serves the old attestation once more before the new one.
        w.iris.messages = [[stale], [stale], [fresh]]
        w.destination.height = Option.some(990n)

        const { seen, exit } = yield* collect(transfers.run("t1"))

        assert.strictEqual(exit._tag, "Success")
        assert.deepStrictEqual(statuses(seen), [
          "burning",
          "attesting",
          "readyToMint",
          "attesting",
          "readyToMint",
          "minting",
          "complete",
        ])
        assert.include(w.iris.calls, `reattest:${NONCE}`)
        assert.strictEqual(
          w.destination.calls.filter((c) => c === "claim").length,
          1
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("re-attests when the destination says the message expired", () => {
    const { w, layer } = world()
    return Effect.gen(function* () {
      const transfers = yield* Transfers
      const transfer = yield* transfers.create({ ...request, speed: "fast" })
      const stale = attested(transfer, { expirationBlock: 1_000n })
      w.iris.messages = [
        [stale],
        [
          attested(transfer, {
            expirationBlock: 0n,
            finalityThresholdExecuted: 2000,
          }),
        ],
      ]
      const claim = w.destination.claim
      let first = true
      w.destination.claim = (message) =>
        first
          ? Effect.suspend(() => {
              first = false
              return Effect.fail({ _tag: "MessageExpired", domain: 5 } as never)
            })
          : claim(message)
      const { seen } = yield* collect(transfers.run("t1"))
      assert.strictEqual(seen.at(-1)!.status, "complete")
      assert.include(w.iris.calls, `reattest:${NONCE}`)
    }).pipe(Effect.provide(layer))
  })

  describe("with a relayer", () => {
    const relayerOf = (
      minAmount: bigint,
      submit: Relayer["Service"]["submit"]
    ) => Layer.succeed(Relayer, Relayer.of({ minAmount, submit }))

    it.effect("lets the relayer deliver and never asks the wallet", () => {
      let w!: World
      const made = world(
        relayerOf(1n, (r) =>
          Effect.sync(() => {
            assert.strictEqual(r.destinationDomain, 5)
            w.destination.used.add(NONCE)
          })
        )
      )
      w = made.w
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* created
        w.iris.messages = [[attested(transfer)]]
        const { seen } = yield* collect(transfers.run("t1"))
        assert.strictEqual(seen.at(-1)!.status, "complete")
        assert.strictEqual(seen.at(-1)!.claimedBy, "relayer")
        assert.notInclude(w.destination.calls, "claim")
      }).pipe(Effect.provide(made.layer))
    })

    it.effect(
      "falls back to a self-claim when the relayer fails or stalls",
      () => {
        const failing = world(
          relayerOf(1n, () =>
            Effect.fail(new RelayerError({ reason: "HTTP 503" }))
          )
        )
        const stalling = world(relayerOf(1n, () => Effect.void))
        const run = ({ w, layer }: typeof failing) =>
          Effect.gen(function* () {
            const transfers = yield* Transfers
            const transfer = yield* created
            w.iris.messages = [[attested(transfer)]]
            const { seen } = yield* collect(transfers.run("t1"))
            assert.strictEqual(seen.at(-1)!.status, "complete")
            assert.strictEqual(seen.at(-1)!.claimedBy, "self")
          }).pipe(Effect.provide(layer))
        return Effect.andThen(run(failing), run(stalling))
      }
    )

    it.effect("skips the relayer below its minimum amount", () => {
      let asked = false
      const { w, layer } = world(
        relayerOf(1_000_000_000n, () => Effect.sync(() => void (asked = true)))
      )
      return Effect.gen(function* () {
        const transfers = yield* Transfers
        const transfer = yield* created
        w.iris.messages = [[attested(transfer)]]
        const { seen } = yield* collect(transfers.run("t1"))
        assert.strictEqual(seen.at(-1)!.claimedBy, "self")
        assert.isFalse(asked)
      }).pipe(Effect.provide(layer))
    })
  })

  it.effect("lets one fiber drive a transfer at a time", () => {
    const { w, layer } = world()
    return Effect.gen(function* () {
      const transfers = yield* Transfers
      yield* created
      w.iris.messages = [[{ _tag: "Pending" }]]
      const running = yield* Effect.forkChild(
        Stream.runDrain(transfers.run("t1"))
      )
      yield* TestClock.adjust("1 minute")
      const busy = yield* Effect.flip(Stream.runDrain(transfers.run("t1")))
      assert.strictEqual(busy._tag, "TransferBusy")
      yield* Fiber.interrupt(running)
      // The lock is released with the stream.
      const attached = yield* transfers.attachBurn("t1", "0x1")
      assert.strictEqual(attached.burnTx, "0x1")
    }).pipe(Effect.provide(layer))
  })

  it.effect("start creates and runs; an unknown id is TransferNotFound", () => {
    const { w, layer } = world()
    return Effect.gen(function* () {
      const transfers = yield* Transfers
      w.iris.messages = [[{ _tag: "Pending" }]]
      const { seen } = yield* collect(transfers.start(request))
      assert.deepStrictEqual(statuses(seen), ["burning", "attesting"])
      const missing = yield* Effect.flip(Stream.runDrain(transfers.run("nope")))
      assert.strictEqual(missing._tag, "TransferNotFound")
    }).pipe(Effect.provide(layer))
  })
})
