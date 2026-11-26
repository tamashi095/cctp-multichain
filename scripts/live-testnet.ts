/**
 * A live transfer on TESTNET, end to end. Opt-in and never run by the tests
 * or CI: it signs and broadcasts real testnet transactions and spends
 * testnet USDC and gas.
 *
 *   CCTP_LIVE=1 \
 *   EVM_PRIVATE_KEY=0x... SOLANA_SECRET_KEY='[1,2,...]' SUI_SECRET_KEY=suiprivkey1... \
 *   bun scripts/live-testnet.ts <from> <to> <amount in USDC subunits> [fast]
 *
 * `<from>` and `<to>` are registry keys: base, ethereum, arbitrum, solana, sui, ...
 * Only the keys of the two chains named are needed.
 * RPCs: `<KEY>_RPC_URL` (for example `BASE_RPC_URL`, `SOLANA_RPC_URL`), or
 * viem's and Solana's public defaults. The registry is `testnet` and cannot
 * be changed from the command line.
 *
 * Interrupted? Run it again with `TRANSFER_ID=<id>`: records are kept in
 * `.transfers/` and the transfer resumes from its recorded status.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Connection, Keypair } from "@solana/web3.js"
import { Effect, Layer, Stream } from "effect"
import { createPublicClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  Adapters,
  Iris,
  isEvm,
  isSolana,
  isSui,
  testnet,
  Transfers,
  TransferStore,
} from "../src/core/index.ts"
import { EvmAdapter, EvmSigner } from "../src/evm/index.ts"
import { SolanaAdapter, SolanaSigner } from "../src/solana/index.ts"
import { SuiAdapter, SuiSigner } from "../src/sui/index.ts"

if (process.env.CCTP_LIVE !== "1") {
  console.error(
    "Refusing to run: set CCTP_LIVE=1 to sign and send testnet transactions."
  )
  process.exit(1)
}

const [fromKey, toKey, amount, speed] = process.argv.slice(2)
const chains = testnet as Record<string, (typeof testnet)[keyof typeof testnet]>
const from = chains[fromKey ?? ""]
const to = chains[toKey ?? ""]
if (from === undefined || to === undefined || amount === undefined) {
  console.error(
    `usage: live-testnet.ts <from> <to> <amount> [fast]; chains: ${Object.keys(chains).join(", ")}`
  )
  process.exit(1)
}

const rpcUrl = (key: string) => process.env[`${key.toUpperCase()}_RPC_URL`]
const families = new Set([from.family, to.family])
const evmAccount = families.has("evm")
  ? privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`)
  : undefined
const solanaKeypair = families.has("solana")
  ? Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY ?? "[]"))
    )
  : undefined
const suiKeypair = families.has("sui")
  ? Ed25519Keypair.fromSecretKey(
      decodeSuiPrivateKey(process.env.SUI_SECRET_KEY ?? "").secretKey
    )
  : undefined

const adapters = Adapters.layer(
  [from, to].map((chain) =>
    isEvm(chain)
      ? EvmAdapter.make(chain, {
          client: createPublicClient({ transport: http(rpcUrl(chain.key)) }),
        })
      : isSolana(chain)
        ? SolanaAdapter.make(chain, {
            connection: new Connection(
              rpcUrl("solana") ?? "https://api.devnet.solana.com",
              "confirmed"
            ),
          })
        : isSui(chain)
          ? SuiAdapter.make(chain, {
              client: new SuiGrpcClient({
                network: "testnet",
                baseUrl: rpcUrl("sui") ?? "https://fullnode.testnet.sui.io:443",
              }),
            })
          : Effect.die("no adapter for this chain family")
  )
)

mkdirSync(".transfers", { recursive: true })
const store = TransferStore.layerJson({
  read: async (id) => {
    try {
      return readFileSync(`.transfers/${id}.json`, "utf8")
    } catch {
      return null
    }
  },
  write: async (id, json) => writeFileSync(`.transfers/${id}.json`, json),
  ids: async () =>
    readdirSync(".transfers").map((f) => f.replace(/\.json$/, "")),
})

const live = Transfers.layer.pipe(
  Layer.provide(adapters),
  Layer.provide(
    Layer.mergeAll(
      Iris.layer({ network: "testnet" }),
      store,
      evmAccount === undefined
        ? Layer.empty
        : EvmSigner.layerAccount(evmAccount, (chain) =>
            http(rpcUrl(chain.key))
          ),
      solanaKeypair === undefined
        ? Layer.empty
        : SolanaSigner.layerKeypair(solanaKeypair),
      suiKeypair === undefined
        ? Layer.empty
        : SuiSigner.layerKeypair(suiKeypair)
    )
  )
)

const address = (chain: typeof from): string =>
  (isEvm(chain)
    ? evmAccount?.address
    : isSolana(chain)
      ? solanaKeypair?.publicKey.toBase58()
      : suiKeypair?.toSuiAddress()) ?? ""

const program = Effect.gen(function* () {
  const transfers = yield* Transfers
  const stream =
    process.env.TRANSFER_ID !== undefined
      ? transfers.run(process.env.TRANSFER_ID)
      : transfers.start({
          sourceDomain: from.domain,
          destinationDomain: to.domain,
          sender: address(from),
          recipient: address(to),
          amount: BigInt(amount),
          speed: speed === "fast" ? "fast" : "standard",
        })
  yield* Stream.runForEach(stream, (t) =>
    Effect.sync(() =>
      console.log(
        t.id,
        t.status,
        t.burnTx ?? "",
        t.claimTx ?? "",
        t.error ?? ""
      )
    )
  )
})

Effect.runPromise(program.pipe(Effect.provide(live))).catch((error) => {
  console.error(error)
  process.exit(1)
})
