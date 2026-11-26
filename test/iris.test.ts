import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { toHex } from "../src/core/bytes.ts"
import { Iris, type FetchLike } from "../src/core/Iris.ts"
import captured from "./fixtures/captured.json" with { type: "json" }

/** A `fetch` that answers from a list and records what it was asked. */
const scripted = (
  ...answers: Array<{ status: number; body?: unknown } | Error>
) => {
  const requests: Array<{ url: string; method: string | undefined }> = []
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, method: init?.method })
    const answer = answers.shift()
    if (answer === undefined) throw new Error("no answer scripted")
    if (answer instanceof Error) throw answer
    return {
      status: answer.status,
      json: async () => {
        if (answer.body === undefined) throw new SyntaxError("not JSON")
        return answer.body
      },
    }
  }
  return { requests, layer: Iris.layer({ network: "mainnet", fetch }) }
}

const { transactionHash, iris: real } = captured.baseToSolana

describe("Iris", () => {
  it.effect("reads a real response: one attested message, as bytes", () => {
    const { requests, layer } = scripted({ status: 200, body: real.body })
    return Effect.gen(function* () {
      const iris = yield* Iris
      const messages = yield* iris.messages(6, transactionHash)
      assert.deepStrictEqual(requests, [
        {
          url: `https://iris-api.circle.com/v2/messages/6?transactionHash=${transactionHash}`,
          method: "GET",
        },
      ])
      assert.strictEqual(messages.length, 1)
      const [message] = messages
      assert.strictEqual(message?._tag, "Attested")
      if (message?._tag !== "Attested") return
      assert.strictEqual(toHex(message.message), real.body.messages[0]!.message)
      assert.strictEqual(message.attestation.length, 130)
    }).pipe(Effect.provide(layer))
  })

  it.effect("uses the sandbox host on testnet", () => {
    const requests: Array<string> = []
    return Effect.gen(function* () {
      const iris = yield* Iris
      yield* iris.fastAllowance
      assert.deepStrictEqual(requests, [
        "https://iris-api-sandbox.circle.com/v2/fastBurn/USDC/allowance",
      ])
    }).pipe(
      Effect.provide(
        Iris.layer({
          network: "testnet",
          fetch: async (url) => {
            requests.push(url)
            return { status: 200, json: async () => ({ allowance: 1.5 }) }
          },
        })
      )
    )
  })

  it.effect("treats 404 as not indexed yet", () => {
    const { layer } = scripted({
      status: 404,
      body: { code: 404, message: "Not Found" },
    })
    return Effect.gen(function* () {
      const iris = yield* Iris
      const error = yield* Effect.flip(iris.messages(6, transactionHash))
      assert.strictEqual(error._tag, "IrisNotIndexed")
    }).pipe(Effect.provide(layer))
  })

  it.effect("reports anything not complete and well-formed as pending", () => {
    const { layer } = scripted({
      status: 200,
      body: {
        messages: [
          {
            status: "pending_confirmations",
            message: "0x",
            attestation: "PENDING",
          },
          {
            status: "pending_confirmations",
            attestation: null,
            delayReason: "insufficient_fee",
          },
          { status: "complete", message: "0x00", attestation: "0xzz" },
          { status: "complete", message: "0x00", attestation: null },
        ],
      },
    })
    return Effect.gen(function* () {
      const iris = yield* Iris
      const messages = yield* iris.messages(6, transactionHash)
      assert.deepStrictEqual(messages, [
        { _tag: "Pending" },
        { _tag: "Pending", delayReason: "insufficient_fee" },
        { _tag: "Pending" },
        { _tag: "Pending" },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "marks 429, 5xx and transport failures retryable, and 400 and bad bodies not",
    () => {
      const { layer } = scripted(
        { status: 429 },
        { status: 503 },
        new TypeError("fetch failed"),
        { status: 400 },
        { status: 200, body: { messages: "nope" } },
        { status: 200 }
      )
      return Effect.gen(function* () {
        const iris = yield* Iris
        const next = Effect.flip(iris.messages(6, transactionHash))
        const seen = []
        for (let i = 0; i < 6; i++) {
          const error = yield* next
          seen.push(
            error._tag === "IrisError" && [error.status, error.retryable]
          )
        }
        assert.deepStrictEqual(seen, [
          [429, true],
          [503, true],
          [undefined, true],
          [400, false],
          [200, false],
          [undefined, true],
        ])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("reads fees and the Fast allowance", () => {
    const { requests, layer } = scripted(
      {
        status: 200,
        body: [
          { finalityThreshold: 1000, minimumFee: 1.3 },
          { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 1 } },
        ],
      },
      {
        status: 200,
        body: {
          allowance: 99999999225.24174,
          lastUpdated: "2025-12-02T13:17:02.453Z",
        },
      }
    )
    return Effect.gen(function* () {
      const iris = yield* Iris
      const fees = yield* iris.fees(0, 5)
      assert.deepStrictEqual(
        fees.map((f) => [f.finalityThreshold, f.minimumFee]),
        [
          [1000, 1.3],
          [2000, 0],
        ]
      )
      assert.strictEqual(
        (yield* iris.fastAllowance).allowance,
        99999999225.24174
      )
      assert.deepStrictEqual(
        requests.map((r) => r.url.replace("https://iris-api.circle.com", "")),
        ["/v2/burn/USDC/fees/0/5", "/v2/fastBurn/USDC/allowance"]
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("re-attests with a POST to the nonce", () => {
    const { requests, layer } = scripted(
      { status: 200, body: {} },
      { status: 404 }
    )
    const nonce = `0x${"ab".repeat(32)}` as const
    return Effect.gen(function* () {
      const iris = yield* Iris
      yield* iris.reattest(nonce)
      assert.deepStrictEqual(requests, [
        {
          url: `https://iris-api.circle.com/v2/reattest/${nonce}`,
          method: "POST",
        },
      ])
      const refused = yield* Effect.flip(iris.reattest(nonce))
      assert.strictEqual(refused.status, 404)
    }).pipe(Effect.provide(layer))
  })
})
