/**
 * `TransferStore`: where transfer records live, so a transfer survives a
 * reload or a restart. The default is in memory; `layerJson` puts it on any
 * string key-value store (localStorage, Redis, a table).
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import { reasonOf, StoreError } from "./errors.ts"
import { Transfer, TransferJson } from "./Transfer.ts"

/** A string key-value store: what `TransferStore.layerJson` needs. */
export interface JsonBackend {
  readonly read: (id: string) => Promise<string | null | undefined>
  readonly write: (id: string, json: string) => Promise<void>
  readonly ids: () => Promise<ReadonlyArray<string>>
}

/** The transfer store. */
export class TransferStore extends Context.Service<
  TransferStore,
  {
    /** Fails with: `StoreError`. */
    readonly get: (
      id: string
    ) => Effect.Effect<Option.Option<Transfer>, StoreError>
    /** Fails with: `StoreError`. */
    readonly put: (transfer: Transfer) => Effect.Effect<void, StoreError>
    /** Fails with: `StoreError`. */
    readonly list: Effect.Effect<ReadonlyArray<Transfer>, StoreError>
  }
>()("cctp-multichain/core/TransferStore") {
  /** A store that lives as long as the layer. */
  static readonly layerMemory: Layer.Layer<TransferStore> = Layer.sync(
    TransferStore,
    () => {
      const records = new Map<string, Transfer>()
      return TransferStore.of({
        get: (id) => Effect.sync(() => Option.fromNullishOr(records.get(id))),
        put: (transfer) =>
          Effect.sync(() => void records.set(transfer.id, transfer)),
        list: Effect.sync(() => [...records.values()]),
      })
    }
  )

  /** A store over `backend`, each record one JSON string decoded on the way in. */
  static readonly layerJson = (
    backend: JsonBackend
  ): Layer.Layer<TransferStore> =>
    Layer.sync(TransferStore, () => {
      const io = <A>(operation: string, run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) =>
            new StoreError({ operation, reason: reasonOf(cause) }),
        })
      const shape = (operation: string) => (issue: Schema.SchemaError) =>
        new StoreError({ operation, reason: issue.message })
      const get = Effect.fn("TransferStore.get")(function* (id: string) {
        const json = yield* io("get", () => backend.read(id))
        if (json === null || json === undefined) return Option.none<Transfer>()
        return Option.some(
          yield* Schema.decodeEffect(TransferJson)(json).pipe(
            Effect.mapError(shape("get"))
          )
        )
      })
      return TransferStore.of({
        get,
        put: Effect.fn("TransferStore.put")(function* (transfer) {
          const json = yield* Schema.encodeEffect(TransferJson)(transfer).pipe(
            Effect.mapError(shape("put"))
          )
          yield* io("put", () => backend.write(transfer.id, json))
        }),
        list: Effect.gen(function* () {
          const ids = yield* io("list", () => backend.ids())
          const found = yield* Effect.forEach(ids, get)
          return found.flatMap(Option.toArray)
        }).pipe(Effect.withSpan("TransferStore.list")),
      })
    })
}
