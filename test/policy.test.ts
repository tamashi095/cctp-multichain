import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { feeFor } from "../src/core/policy.ts"
import { Relayer } from "../src/core/Relayer.ts"
import { Transfer, TransferJson } from "../src/core/Transfer.ts"
import { TransferStore } from "../src/core/TransferStore.ts"
import { Schema } from "effect"

describe("feeFor", () => {
  it.each([
    [100_000_000n, 1, 10_000n],
    [100_000_000n, 0, 0n],
    [1n, 1, 1n], // rounds up: never authorize less than Circle asks
    [1_000_000n, 1.3, 130n],
    [1_000_001n, 1.3, 131n],
    [10_000_000_000_000n, 14, 14_000_000_000n],
  ])("%d subunits at %d bps is %d", (amount, bps, fee) => {
    assert.strictEqual(feeFor(amount, bps), fee)
  })
})

const record = new Transfer({
  id: "t1",
  network: "mainnet",
  status: "readyToMint",
  sourceDomain: 6,
  destinationDomain: 5,
  sender: "0xabc",
  recipient: "bob",
  amount: 2n ** 70n,
  maxFee: 7n,
  minFinalityThreshold: 1000,
  messageSender: `0x${"01".repeat(32)}`,
  mintRecipient: `0x${"02".repeat(32)}`,
  destinationCaller: `0x${"00".repeat(32)}`,
  burnToken: `0x${"03".repeat(32)}`,
  sourceMessenger: `0x${"04".repeat(32)}`,
  destinationMessenger: `0x${"05".repeat(32)}`,
  hookData: "0x",
  burnCursor: "123",
  burnStarted: true,
  burnTx: "0xdead",
  message: "0x00",
  staleExpirationBlock: 5n,
  createdAt: 1,
  updatedAt: 2,
})

describe("TransferStore", () => {
  it.effect(
    "round-trips a record through a JSON string, bigints included",
    () =>
      Effect.gen(function* () {
        const json = yield* Schema.encodeEffect(TransferJson)(record)
        assert.isString(json)
        assert.strictEqual(JSON.parse(json).amount, String(2n ** 70n))
        assert.deepStrictEqual(
          yield* Schema.decodeEffect(TransferJson)(json),
          record
        )
      })
  )

  it.effect("layerJson stores and lists through a string backend", () => {
    const strings = new Map<string, string>()
    const layer = TransferStore.layerJson({
      read: async (id) => strings.get(id),
      write: async (id, json) => void strings.set(id, json),
      ids: async () => [...strings.keys()],
    })
    return Effect.gen(function* () {
      const store = yield* TransferStore
      assert.isTrue(Option.isNone(yield* store.get("t1")))
      yield* store.put(record)
      assert.deepStrictEqual(yield* store.get("t1"), Option.some(record))
      assert.deepStrictEqual(yield* store.list, [record])

      strings.set("bad", '{"id":"bad"}')
      const error = yield* Effect.flip(store.get("bad"))
      assert.strictEqual(error._tag, "StoreError")
    }).pipe(Effect.provide(layer))
  })
})

describe("Relayer.layerHttp", () => {
  const request = {
    transferId: "t1",
    sourceDomain: 6,
    destinationDomain: 5,
    message: new Uint8Array([1, 2]),
    attestation: new Uint8Array([3]),
  }
  const relayer = (
    status: number,
    seen: Array<unknown>
  ): Layer.Layer<Relayer> =>
    Relayer.layerHttp({
      url: "https://relayer.example/claim",
      minAmount: 5n,
      fetch: async (url, init) => {
        seen.push([url, init?.method, JSON.parse(init?.body ?? "null")])
        return { status, json: async () => ({}) }
      },
    })

  it.effect("posts the message and attestation as hex", () => {
    const seen: Array<unknown> = []
    return Effect.gen(function* () {
      const service = yield* Relayer
      assert.strictEqual(service.minAmount, 5n)
      yield* service.submit(request)
      assert.deepStrictEqual(seen, [
        [
          "https://relayer.example/claim",
          "POST",
          {
            sourceDomain: 6,
            destinationDomain: 5,
            message: "0x0102",
            attestation: "0x03",
          },
        ],
      ])
    }).pipe(Effect.provide(relayer(202, seen)))
  })

  it.effect("fails with RelayerError on a refusal", () =>
    Effect.gen(function* () {
      const service = yield* Relayer
      const error = yield* Effect.flip(service.submit(request))
      assert.strictEqual(error._tag, "RelayerError")
      assert.strictEqual(error.status, 503)
    }).pipe(Effect.provide(relayer(503, [])))
  )
})
