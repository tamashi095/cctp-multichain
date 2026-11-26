/**
 * The domain model: networks, chains and transfer speeds.
 *
 * Nothing here imports a chain SDK. A chain is data (`ChainRef`); what can be
 * done on it belongs to its family's `ChainAdapter`.
 */
import type { Hex } from "./bytes.ts"

/** Circle's two environments. Testnet attestations come from the Iris sandbox. */
export type Network = "mainnet" | "testnet"

/**
 * A Circle domain id: Circle's own identifier for a chain, unrelated to chain ids.
 * https://developers.circle.com/cctp/concepts/supported-chains-and-domains#domain-identifiers
 */
export type Domain = number

/**
 * Finality thresholds. Circle supports exactly these two.
 * https://developers.circle.com/cctp/references/technical-guide#finality-thresholds
 */
export const FinalityThreshold = { fast: 1000, standard: 2000 } as const

/** A transfer speed: Fast is attested at `confirmed`, Standard at `finalized`. */
export type Speed = keyof typeof FinalityThreshold

/**
 * A chain CCTP runs on, as data. `family` names the adapter that speaks to it;
 * the family-specific fields live on the extending interfaces.
 */
export interface ChainRef {
  /** Stable key, unique within a network: `"base"`, `"solana"`. */
  readonly key: string
  readonly name: string
  readonly network: Network
  readonly domain: Domain
  /** The adapter family: `"evm"`, `"solana"`, `"sui"`. */
  readonly family: string
  /** Native USDC in the family's own address form. */
  readonly usdc: string
  /**
   * Whether Circle offers Fast Transfer with this chain as the source. Where
   * Standard attestation is already fast Circle offers none ("N/A").
   * https://developers.circle.com/cctp/concepts/supported-chains-and-domains#supported-blockchains
   */
  readonly fastSource: boolean
}

/** An EVM chain: TokenMessengerV2 and MessageTransmitterV2 addresses. */
export interface EvmChainRef extends ChainRef {
  readonly family: "evm"
  /** EIP-155 chain id, checked against the RPC before every write and scan. */
  readonly chainId: number
  readonly usdc: Hex
  readonly tokenMessenger: Hex
  readonly messageTransmitter: Hex
  /**
   * What a message's `expirationBlock` is compared against on this chain.
   * `"parent"`: an Arbitrum-stack chain, where `block.number` is the parent
   * (Ethereum) block, which this chain's RPC does not report.
   * https://developers.circle.com/cctp/references/technical-guide#message-body
   */
  readonly expirationClock: "self" | "parent"
}

/** Solana: the two CCTP V2 programs. */
export interface SolanaChainRef extends ChainRef {
  readonly family: "solana"
  /**
   * The cluster's genesis hash, checked against the RPC before every write
   * and scan: Circle's programs have the same ids on mainnet and devnet.
   */
  readonly genesisHash: string
  readonly messageTransmitter: string
  readonly tokenMessengerMinter: string
}

/**
 * Sui: Circle's three packages, their shared state objects, and the two
 * identifiers a message carries for Sui.
 * https://developers.circle.com/cctp/references/sui-packages
 */
export interface SuiChainRef extends ChainRef {
  readonly family: "sui"
  /**
   * The network's chain identifier (its genesis checkpoint digest), checked
   * against the RPC before every write and scan.
   */
  readonly chainIdentifier: string
  /** USDC's coin type: `0x…::usdc::USDC`. */
  readonly usdc: string
  /** Package ids: the call targets, which change when Circle upgrades a package. */
  readonly messageTransmitterPackage: string
  readonly tokenMessengerMinterPackage: string
  readonly stablecoinHandlerPackage: string
  /** Shared state objects, passed as arguments. */
  readonly messageTransmitterState: string
  readonly tokenMessengerMinterState: string
  readonly stablecoinHandlerState: string
  readonly usdcTreasury: string
  /**
   * The token messenger as messages name it: keccak256 of the type name
   * `<package>::message_transmitter_authenticator::MessageTransmitterAuthenticator`
   * (circlefin/sui-cctp, `message_transmitter_v2::auth::auth_caller_identifier`).
   */
  readonly messenger: Hex
  /**
   * USDC as messages name it: keccak256 of the type name `<package>::usdc::USDC`
   * (`token_messenger_minter_v2::token_utils::calculate_token_id`).
   */
  readonly usdcTokenId: Hex
}

/** Whether `chain` belongs to the EVM family. */
export const isEvm = (chain: ChainRef): chain is EvmChainRef =>
  chain.family === "evm"

/** Whether `chain` belongs to the Solana family. */
export const isSolana = (chain: ChainRef): chain is SolanaChainRef =>
  chain.family === "solana"

/** Whether `chain` belongs to the Sui family. */
export const isSui = (chain: ChainRef): chain is SuiChainRef =>
  chain.family === "sui"
