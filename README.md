# cctp-multichain

Native USDC transfers through Circle CCTP V2 in any direction between EVM
chains, Solana and Sui, as an [Effect](https://effect.website) library.

A transfer is three steps, whatever the route: a burn on the source chain,
Circle's attestation of that burn, and a claim on the destination chain. This
library does the three, keeps a resumable record of where each transfer is, and
checks every message Circle returns against the burn it made before it claims.

Status: unit-tested against real captured mainnet and testnet data, and its
read-only paths checked against mainnet. **No transaction has been signed or
sent with it yet**, on mainnet or testnet. See
[What is and isn't verified](#what-is-and-isnt-verified) before using it with
funds.

## Use

```ts
import { Effect, Layer, Stream } from "effect"
import { createPublicClient, http } from "viem"
import { Connection } from "@solana/web3.js"
import {
  Adapters,
  Iris,
  mainnet,
  Transfers,
  TransferStore,
} from "cctp-multichain/core"
import { EvmAdapter, EvmSigner } from "cctp-multichain/evm"
import { SolanaAdapter, SolanaSigner } from "cctp-multichain/solana"

const live = Transfers.layer.pipe(
  Layer.provide(
    Adapters.layer([
      EvmAdapter.make(mainnet.base, {
        client: createPublicClient({ transport: http(BASE_RPC) }),
      }),
      SolanaAdapter.make(mainnet.solana, {
        connection: new Connection(SOLANA_RPC),
      }),
    ])
  ),
  Layer.provide(
    Layer.mergeAll(
      Iris.layer({ network: "mainnet" }),
      TransferStore.layerMemory, // or TransferStore.layerJson(localStorage-like)
      EvmSigner.layerWalletClient(walletClient), // browser wallet
      SolanaSigner.layerWallet(solanaWallet) // wallet adapter
    )
  )
)

const program = Effect.gen(function* () {
  const transfers = yield* Transfers
  yield* transfers
    .start({
      sourceDomain: mainnet.base.domain,
      destinationDomain: mainnet.solana.domain,
      sender: "0x…", // the EVM signer
      recipient: "…", // a Solana wallet, not a token account
      amount: 25_000_000n, // 25 USDC
      speed: "fast",
    })
    .pipe(Stream.runForEach((t) => Effect.log(t.id, t.status)))
})

Effect.runPromise(program.pipe(Effect.provide(live)))
```

Sui is the same shape, from `cctp-multichain/sui`:
`SuiAdapter.make(mainnet.sui, { client })` over any `@mysten/sui` client, with
`SuiSigner.layerWallet(wallet)` or `SuiSigner.layerKeypair(keypair)`.

On a backend the only change is the signer layers:
`EvmSigner.layerAccount(privateKeyToAccount(key), (chain) => http(rpcFor(chain)))`,
`SolanaSigner.layerKeypair(keypair)` and `SuiSigner.layerKeypair(keypair)`. An adapter built without its signer
is read-only (it can still scan burns and read nonces) and fails a write with
`SignerUnavailable`.

To resume after a reload or a crash, run the record again:
`transfers.run(id)`. It picks up from the recorded status.

## Layout

One package with four subpath exports, not a workspace. The parts version
together and share one small core, so separate packages would add release
bookkeeping and nothing else; the subpaths already keep each chain SDK out of
a bundle that does not use it (`viem`, `@solana/web3.js` and `@mysten/sui` are
optional peer dependencies). ESLint enforces the boundary: `src/core` may import neither
a chain SDK nor an adapter.

```
src/core      no chain SDK
  domain.ts        Network, Domain, ChainRef, FinalityThreshold
  registry.ts      the chains, as data (mainnet and testnet)
  message.ts       CCTP V2 message codec and validator
  policy.ts        fee and speed policy, TransfersConfig
  Iris.ts          Circle's attestation API (service)
  Transfer.ts      the serializable transfer record (Schema)
  TransferStore.ts where records live (service; memory or JSON key-value)
  Relayer.ts       optional third-party claimer (service)
  ChainAdapter.ts  what a chain family must do; the Adapters registry
  Transfers.ts     the orchestrator: state machine, resume, progress Stream
  errors.ts        every failure, as tagged errors
src/evm       viem: one adapter for every EVM chain, EvmSigner
src/solana    Circle's Solana programs: adapter, instructions, SolanaSigner
src/sui       Circle's Sui packages: adapter, PTB builders, SuiSigner
scripts/      capture-fixtures.ts, capture-sui-fixtures.ts, live-readonly.ts
              (all read-only), live-testnet.ts (opt-in, signs)
test/         unit tests and fixtures
```

### Why adapters are per family, not per route

CCTP has no pairwise logic. So the unit of extension is a chain _family_:
`ChainAdapter` (`burn`, `findBurns`, `claim`, `isNonceUsed`,
`prepareRecipient`, `estimateClaimCost`, `toBytes32`, `recipientFromAddress`,
`expirationHeight`) is implemented once each for EVM, Solana and Sui, and
`Transfers` talks to both ends of any route through it. Route-specific code
would grow as N².

- **A new EVM chain** is one entry in `src/core/registry.ts`.
- **A new family** is one adapter and its registry entries. Sui was added
  that way: `src/sui`, a `SuiChainRef`, two registry entries, and one new
  error (`RecipientDenied`). The orchestrator did not change; the one
  interface change was letting `recipientFromAddress` read the chain.

### Signers stay outside

Adapters build unsigned transactions and hand them to a signer service
provided through a Layer: `EvmSigner` (signs and broadcasts through a viem
wallet client), `SolanaSigner` (signs a `VersionedTransaction`; the adapter
sends it) and `SuiSigner` (signs built transaction bytes; the adapter executes
them). The library never sees a key.

`SuiSigner` can carry a **sponsor**: another party that pays the gas and adds
its signature (`layerKeypair(keypair, { sponsor })`). The gas check then reads
the sponsor's SUI. This is how a relayer can pay for a user's burn on Sui; for
a claim, a relayer simply claims itself.

## The state machine

```
burning ──► attesting ──► readyToMint ──► minting ──► complete
   │            ▲              │
   ▼            └── reattest ──┘   (an expired Fast message)
 failed   (only before anything was burned)
```

| Status        | What happens                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `burning`     | `approve` + `depositForBurn` (EVM), `deposit_for_burn` (Solana) or the three-call burn PTB (Sui). Once per transfer.                                                                                                           |
| `attesting`   | Poll `GET /v2/messages/{domain}?transactionHash=` with backoff until Iris returns a message that _is_ this burn.                                                                                                               |
| `readyToMint` | Read the destination nonce (anyone may have delivered). Re-attest a Fast message near its `expirationBlock`. Hand the message to the relayer if one is configured and the amount is above its minimum, and wait for the nonce. |
| `minting`     | Read the nonce again, prepare the recipient (Solana: create the USDC token account), and claim from the user's own wallet.                                                                                                     |
| `complete`    | The destination's nonce is used. `claimedBy` says who delivered: `self`, `relayer` or `other`.                                                                                                                                 |
| `failed`      | The burn was refused for a reason retrying will not cure (insufficient USDC, reverted). Nothing was burned.                                                                                                                    |

`Transfers.run(id)` returns a `Stream` that emits the record as it is and then
after every change, and ends at `complete`/`failed` or fails with the typed
error that stopped it. The record keeps that error (`error: "Tag: reason"`) and
a status to resume from. One fiber drives a transfer at a time (`TransferBusy`).

The record (`Transfer`, a `Schema.Class`) holds everything the burn committed
to, so a resumed transfer validates Circle's message against the record alone.
`TransferJson` encodes it as a JSON string; `TransferStore.layerJson` stores it
in anything with `read`/`write`/`ids`.

## Fees and speed

- Fast is `minFinalityThreshold` 1000, Standard is 2000
  ([finality thresholds](https://developers.circle.com/cctp/references/technical-guide#finality-thresholds)).
- The fee comes from `GET /v2/burn/USDC/fees/{src}/{dst}` (basis points, may be
  fractional) and is rounded up. `maxFee` is that fee plus 10% headroom
  (`feeBufferBps`), capped at 1% of the amount (`maxFeeCeilingBps`). If Circle's
  fee alone is above the ceiling, `create` fails with `FeeAboveCeiling` and
  nothing is burned. Circle keeps only what it charges (`feeExecuted`), and the
  validator refuses a message whose `feeExecuted` is above `maxFee`.
- A Fast request becomes Standard when the source chain offers no Fast Transfer
  (`fastSource: false`, Circle's "N/A": Avalanche, Polygon PoS and Sui here) or when `GET /v2/fastBurn/USDC/allowance`
  is below the amount.
- The recipient receives `amount − feeExecuted`.

`TransfersConfig` is a `Context.Reference` with defaults; override it with
`Layer.succeed(TransfersConfig, { ...defaultTransfersConfig, … })` under
`Transfers.layer`.

## Trust model

**Circle only.** A transfer trusts Circle (its contracts, its attesters and
that it attests what was burned) and the two chains. Nothing else can move
funds:

- **Our relayer is trusted for liveness only.** It receives a message and
  Circle's attestation of it, both public. Every burn uses
  `destinationCaller = 0`, so the destination mints to the message's own
  recipient no matter who submits it. A relayer can be slow, down or malicious
  and the worst outcome is a delay: the user's wallet (or anyone) claims
  instead. There is no option to set another `destinationCaller`.
- **Iris is not trusted for content.** It is an HTTP API, so each returned
  message is compared byte for byte with the burn the record describes before
  anything is claimed.
- **RPCs are trusted for what they report**, as with any wallet. The chain id
  (EVM) or genesis hash (Solana) is checked before every write and scan,
  because Circle's contracts have the same addresses on many chains.
- **A Sui recipient is not checked by the chain.** Sui mints to whatever 32
  bytes the message names; USDC minted to an object or package id is lost.
  The adapter accepts only a full `0x` + 64-hex address and refuses one an
  object lives at, but it cannot tell a real account from an id nobody
  controls. **The caller must bind the recipient to the user's real Sui
  account** before starting a transfer.
- **The store is trusted**: whoever can rewrite a transfer record can change
  what it expects. Keep it where the user's own data lives.

## What is and isn't verified

Verified on every transfer, at run time:

- The attested message equals the expected burn byte for byte once the four
  attester-filled fields are zeroed: length, both versions, source and
  destination domain, source and destination token messenger, destination
  caller (zero), `minFinalityThreshold`, burn token, mint recipient, amount,
  message sender, `maxFee` and hook data.
- Of the attester-filled fields: the nonce is non-zero, `feeExecuted ≤ maxFee`
  and `< amount`, and `finalityThresholdExecuted` is 1000 or 2000 and not below
  what was asked.
- The attestation is a non-empty multiple of 65 bytes.
- `maxFee` is within the ceiling, before the burn.
- Delivery, from the destination's own state: `usedNonces(nonce)` on EVM, the
  used-nonce account (owned by MessageTransmitterV2, flag set) on Solana, and
  `state::is_nonce_used` read by simulation on Sui. A read that fails is an
  error, never "unused".
- Burn scans (`findBurns`) read finalized blocks only.

Verified by the tests, against real data (`test/fixtures/captured.json`,
captured read-only from Iris, Base and Solana mainnet by
`scripts/capture-fixtures.ts`):

- The codec decodes three real attested messages (Base → Solana, Base →
  Arbitrum, Solana → Ethereum) to what Iris decoded and encodes them back to
  the same bytes.
- The validator accepts each of them against an expectation built from the
  registry and the source chain's own record (the EVM log's depositor; the
  Solana instruction's arguments and owner), and refuses it when any single
  committed field differs. This confirms the registry's messenger and USDC
  values and the bytes32 conventions for Solana in both directions.
- The Solana instruction builders reproduce a real mainnet `deposit_for_burn`
  and a real `receive_message` exactly: the same data and the same twenty
  accounts each, including every PDA and the fee recipient's token account.
- Discriminators, argument layout and account flags match Circle's IDLs
  (`test/fixtures/idl`, copied from `circlefin/solana-cctp-contracts` at
  `ec16e95`, Apache-2.0).
- A bare claim fits one Solana transaction (≤ 1232 bytes) without a lookup
  table.
- EVM chain ids match viem's chain definitions.
- Sui (`test/fixtures/captured-sui.json`, from Sui's public full nodes and
  Iris, mainnet and sandbox, by `scripts/capture-sui-fixtures.ts`):
  - The claim builder reproduces a real mainnet claim (Arbitrum → Sui) and a
    real testnet claim (Base Sepolia → Sui) command for command: the same four
    calls, type arguments, objects and pure bytes.
  - The burn builder reproduces the three CCTP calls of real burns (Sui → OP
    Mainnet, Sui → Solana, and a testnet burn with hook data).
  - Sui's two message identifiers (the messenger and USDC's token id) are the
    hashes Circle's Move source derives, and they are the ones in real
    messages on both networks. Iris's sandbox does attest Sui V2 routes.
  - Two real mainnet transfers are replayed through the orchestrator over the
    real adapters on scripted nodes: the record `create` writes predicts
    Circle's real attested message byte for byte (Arbitrum → Sui, Sui → OP
    Mainnet).
- Read-only, against mainnet (`scripts/live-readonly.ts`, 2026-11-26): each
  family's delivery oracle answers "used" for a nonce a fixture shows
  delivered and "unused" for a random one (Sui, Arbitrum, Solana), and Sui's
  recipient check accepts an account and refuses an object id.

**Not verified:**

- **No live transaction.** Nothing here has been signed or broadcast. The
  adapters' transaction flow (gas estimation, simulation, confirmation) is
  tested against scripted nodes only. Run `scripts/live-testnet.ts` on testnet
  before any mainnet use.
- **Attestation signatures are not checked client-side.** The destination
  chain verifies them against Circle's attesters when the message is claimed; a
  forged attestation costs gas and mints nothing.
- **Sandbox behaviour**: that `iris-api-sandbox.circle.com` attests
  EVM ↔ Solana devnet routes was not exercised. (For Sui testnet it does: the
  fixtures hold a sandbox-attested message each way.)
- **Building a Sui transaction.** The tests stand in for
  `Transaction.build`, which needs a node to resolve objects, gather the USDC
  coin and choose gas. That step, and a sponsored build, have not run.
- Circle's future fee policy, pauses, denylists and burn limits. They make a
  burn or claim fail (funds stay where they were); they are not predicted.

### Open TODOs and unverified details

1. **Solana address lookup table.** Circle's documentation names none, so none
   is built in. `SolanaAdapterOptions.lookupTables` takes addresses you have
   checked. Without one a bare claim fits, with only a few bytes to spare (the
   packet limit is 1232 bytes); a priority fee (`computeUnitPrice`) or a
   message with hook data needs a table. `TODO(unverified)` in
   `src/solana/SolanaAdapter.ts`.
2. **`reclaim_event_account` is not built.** Each Solana burn stores its
   message in a new account whose rent the sender pays and can reclaim five
   days later. The account is the burn transaction's twelfth account.
3. **Compute budget on Solana.** Claims rely on the default compute limit, as
   Circle's example does. Unmeasured.
4. **Arbitrum-stack expiry.** `expirationBlock` there is a parent-chain block
   that the chain's RPC does not report, so the pre-emptive re-attest is
   skipped for `expirationClock: "parent"` chains; expiry is caught when gas
   estimation reverts with Circle's "Message expired" text. That match is on a
   revert string from Circle's source.
5. **Relayer wire format** (`Relayer.layerHttp`: `POST { sourceDomain,
destinationDomain, message, attestation }`) is this library's own. No
   relayer exists yet. A relayer delivering to Solana must create the
   recipient's token account itself: `prepareRecipient` runs only on a
   self-claim.
6. **On-chain minimum fee.** `TokenMessengerV2.getMinFeeAmount` is not read;
   the Standard fee comes from Iris (currently 0). If Circle enforces an
   on-chain minimum above what Iris reports, the burn reverts and nothing is
   burned.
7. **Sui package upgrades.** The registry holds one id per Circle package and
   uses it both as the call target and inside type names (the handler's
   `Auth` witness, the `DepositForBurn` event type). Today they are the same.
   After an upgrade the call target changes and type names keep the original
   id: the registry will need both.
8. **Sui's minted USDC is a `Coin<USDC>` object**, as Circle's contracts mint
   it. Folding it into the recipient's address balance (`coin::send_funds`,
   which the recipient must sign) is not built.
9. **Sui failure matching.** A failed claim is classified by Move module name
   and abort code (`receive_message` 4, `handle_receive_message` 8, `treasury`
   1. from Circle's sources, without comparing package ids. `RecipientDenied`
      also covers a denied _claimer_: Circle's `treasury::mint` checks both with
      one code.
10. **Sui expiry uses this machine's clock.** On Sui `expirationBlock` is a
    time in milliseconds; a Fast message within a minute of it is re-attested.
11. **Sui burn search without a cursor** reads only the sender's newest event
    pages (`maxPages`); public nodes prune older history.
12. **Registry coverage**: Ethereum, Avalanche, OP Mainnet, Arbitrum, Base,
    Polygon PoS, Unichain, Linea, World Chain, Solana and Sui, each with its testnet.
    Circle supports more; each is a data entry. Circle's page lists both a
    "Sonic Testnet" and a "Sonic Blaze Testnet" USDC, which is why Sonic was left
    out rather than guessed.

Details that did not come from Circle's pages, and where they came from:

- **EVM chain ids**: viem's chain definitions (checked by a test).
- **Solana genesis hashes**: `getGenesisHash` on Solana's public mainnet and
  devnet RPCs.
- **Sui chain identifiers**: `getChainIdentifier` on Sui's public full nodes
  (over gRPC; another transport may spell it differently).
- **Sui's deny-list abort**: `EDeniedAddress` in `treasury.move` of
  `circlefin/stablecoin-sui`. Everything else about Sui is from Circle's Sui
  packages page, its Sui quickstart and `circlefin/sui-cctp` at `b23b83b`.
- **Associated token account derivation and `CreateIdempotent`**: the SPL
  Associated Token Account program. The derivation is confirmed by the real
  `receive_message` fixture.
- **`usedNonces`, the `DepositForBurn` event, and the Solana PDA seeds and
  account order**: Circle's contract sources
  (`circlefin/evm-cctp-contracts`, `circlefin/solana-cctp-contracts`).
- Where Circle's pages disagree with its programs, the programs and mainnet
  win: the ["Retry a failed mint"](https://developers.circle.com/cctp/howtos/retry-failed-mint)
  Solana sample derives a `used_nonces` account from the source domain (the V1
  layout) and omits the fee recipient's token account, while the V2 program and
  real transactions use `["used_nonce", nonce]` and include it. `deposit_for_burn`
  follows Circle's quickstart and mainnet in passing two accounts the IDL does
  not list.

## Failure modes

Every failure is a tagged error (`src/core/errors.ts`). What each leaves
behind:

| Failure                                                                        | State after                                       | What to do                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `FeeAboveCeiling`, `InvalidTransfer`, `InvalidAddress`, `UnsupportedDomain`    | No record                                         | Fix the request.                                                                                           |
| `SignerError` (rejected), `InsufficientGas`, `ChainError`, `ChainIdMismatch`   | `burning`, nothing sent                           | Run again.                                                                                                 |
| `InsufficientBalance`, `TransactionFailed` on the burn                         | `failed`, nothing burned                          | `retryBurn(id)` after fixing the cause, or start a new transfer.                                           |
| `SubmissionUnknown` on the burn                                                | `burning`, a burn may be in flight                | Run again: it searches finalized blocks for the burn. It never burns twice.                                |
| `BurnOutcomeUnknown`                                                           | `burning`                                         | The burn is not finalized, or was never sent. Run again later, `attachBurn(id, hash)`, or `retryBurn(id)`. |
| `IrisNotIndexed`, retryable `IrisError`                                        | (retried internally)                              | —                                                                                                          |
| `AttestationTimeout`                                                           | `attesting`                                       | Run again. A burn is never lost by waiting. `delayReason` says why a Fast attestation is slow.             |
| `MessageMismatch`                                                              | `attesting`, nothing claimed                      | The transaction named is not this burn. `attachBurn` the right one.                                        |
| `RelayerError`, relayer timeout                                                | (falls back to self-claim)                        | —                                                                                                          |
| `RecipientDenied` (Sui: the recipient or claimer is on USDC's deny list)       | `readyToMint`, nonce unused                       | Run again once Circle lifts the block. Nothing else can be done: the burn named that recipient.            |
| `RecipientAccountMissing`, `InsufficientGas`, `SignerUnavailable` on the claim | `readyToMint`                                     | Fund the claimer (SOL for rent and fees on Solana, SUI on Sui) and run again, or let anyone else claim.    |
| `SubmissionUnknown`, `ChainError`, `TransactionFailed` on the claim            | `readyToMint`, or `complete` if the nonce is used | The nonce is read before anything else; run again.                                                         |
| `MessageExpired`, or a Fast message near `expirationBlock`                     | `attesting`                                       | `POST /v2/reattest/{nonce}` was sent; run again if it stopped. Circle sets no deadline for re-attestation. |
| `NonceAlreadyUsed`                                                             | `complete`                                        | Delivered by someone else.                                                                                 |
| The process dies at any point                                                  | The last saved status                             | `run(id)`.                                                                                                 |
| The relayer and this process both disappear                                    | Burned, attested                                  | Anyone with the transaction hash can fetch the message from Iris and claim: `destinationCaller` is zero.   |

Things that cannot be recovered by this library: USDC sent to a wrong
`recipient` (the mint goes where the burn said), and a recipient Circle blocks
on the destination (the claim fails until Circle lifts it).

## Development

```sh
bun install --frozen-lockfile
bun run check    # format:check, lint, typecheck, test, build
```

Tests run on Vitest with `@effect/vitest` (`TestClock` drives the polling). No
test touches the network. The scripts do, and none runs in CI:

- `bun scripts/capture-fixtures.ts` and `bun scripts/capture-sui-fixtures.ts`
  re-capture the fixtures. Read-only.
- `bun scripts/live-readonly.ts` reads the three delivery oracles on mainnet.
  Read-only, no key.
- `CCTP_LIVE=1 … bun scripts/live-testnet.ts <from> <to> <amount>` makes a real
  **testnet** transfer with keys from the environment. It signs and sends
  transactions; it is hard-wired to the testnet registry. Never commit keys:
  `.env*` and `.transfers/` are git-ignored.

Conventions (after `misofm/sui-effect`): Effect 4.1.5; services are
`Context.Service` with static layers; errors are `Schema.TaggedError`; service
methods are `Effect.fn("Service.method")`; `Schema` decodes at every boundary;
no `Effect.run*`, `node:*` or platform package under `src/`; byte packing (the
message codec, Solana instruction data) is plain functions wrapped where they
can fail.
