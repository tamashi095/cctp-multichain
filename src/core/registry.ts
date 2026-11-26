/**
 * The chain registry, as data. Adding an EVM chain is one entry here.
 *
 * Every value is copied from Circle's documentation (read 2026-11-26):
 *
 * - Domains and Fast-source support:
 *   https://developers.circle.com/cctp/concepts/supported-chains-and-domains
 * - TokenMessengerV2 and MessageTransmitterV2 (EVM, mainnet and testnet):
 *   https://developers.circle.com/cctp/references/contract-addresses
 * - Solana programs (the same ids on mainnet and devnet):
 *   https://developers.circle.com/cctp/references/solana-programs
 * - USDC: https://developers.circle.com/stablecoins/usdc-contract-addresses
 *
 * Addresses are written in EIP-55 checksum case. Circle's page prints World
 * Chain's USDC in another case (`0x79A0…24D1`, same address).
 *
 * Chain ids are not Circle's to assign and Circle's pages do not list them;
 * `test/registry.test.ts` checks each against viem's chain definitions.
 * Solana's genesis hashes are what `getGenesisHash` answered on
 * api.mainnet-beta.solana.com and api.devnet.solana.com (2026-11-26).
 */
import type {
  ChainRef,
  Domain,
  EvmChainRef,
  Network,
  SolanaChainRef,
} from "./domain.ts"
import type { Hex } from "./bytes.ts"

const MAINNET_EVM = {
  tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
} as const

const TESTNET_EVM = {
  tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
} as const

const evm = (
  network: Network,
  key: string,
  name: string,
  domain: Domain,
  chainId: number,
  usdc: Hex,
  fastSource: boolean,
  expirationClock: "self" | "parent" = "self"
): EvmChainRef => ({
  family: "evm",
  network,
  key,
  name,
  domain,
  chainId,
  usdc,
  fastSource,
  expirationClock,
  ...(network === "mainnet" ? MAINNET_EVM : TESTNET_EVM),
})

const solana = (
  network: Network,
  name: string,
  usdc: string,
  genesisHash: string
): SolanaChainRef => ({
  family: "solana",
  network,
  key: "solana",
  name,
  domain: 5,
  usdc,
  genesisHash,
  fastSource: true,
  messageTransmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
  tokenMessengerMinter: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
})

/** Circle's mainnet chains this library knows. */
export const mainnet = {
  ethereum: evm(
    "mainnet",
    "ethereum",
    "Ethereum",
    0,
    1,
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    true
  ),
  avalanche: evm(
    "mainnet",
    "avalanche",
    "Avalanche",
    1,
    43114,
    "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    false
  ),
  optimism: evm(
    "mainnet",
    "optimism",
    "OP Mainnet",
    2,
    10,
    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    true
  ),
  arbitrum: evm(
    "mainnet",
    "arbitrum",
    "Arbitrum",
    3,
    42161,
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    true,
    "parent"
  ),
  solana: solana(
    "mainnet",
    "Solana",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
  ),
  base: evm(
    "mainnet",
    "base",
    "Base",
    6,
    8453,
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    true
  ),
  polygon: evm(
    "mainnet",
    "polygon",
    "Polygon PoS",
    7,
    137,
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    false
  ),
  unichain: evm(
    "mainnet",
    "unichain",
    "Unichain",
    10,
    130,
    "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    true
  ),
  linea: evm(
    "mainnet",
    "linea",
    "Linea",
    11,
    59144,
    "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    true
  ),
  worldchain: evm(
    "mainnet",
    "worldchain",
    "World Chain",
    14,
    480,
    "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
    true
  ),
} as const

/** Circle's testnet chains this library knows (Iris sandbox). */
export const testnet = {
  ethereum: evm(
    "testnet",
    "ethereum",
    "Ethereum Sepolia",
    0,
    11155111,
    "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    true
  ),
  avalanche: evm(
    "testnet",
    "avalanche",
    "Avalanche Fuji",
    1,
    43113,
    "0x5425890298aed601595a70AB815c96711a31Bc65",
    false
  ),
  optimism: evm(
    "testnet",
    "optimism",
    "OP Sepolia",
    2,
    11155420,
    "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    true
  ),
  arbitrum: evm(
    "testnet",
    "arbitrum",
    "Arbitrum Sepolia",
    3,
    421614,
    "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    true,
    "parent"
  ),
  solana: solana(
    "testnet",
    "Solana Devnet",
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  ),
  base: evm(
    "testnet",
    "base",
    "Base Sepolia",
    6,
    84532,
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    true
  ),
  polygon: evm(
    "testnet",
    "polygon",
    "Polygon PoS Amoy",
    7,
    80002,
    "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
    false
  ),
  unichain: evm(
    "testnet",
    "unichain",
    "Unichain Sepolia",
    10,
    1301,
    "0x31d0220469e10c4E71834a79b1f276d740d3768F",
    true
  ),
  linea: evm(
    "testnet",
    "linea",
    "Linea Sepolia",
    11,
    59141,
    "0xFEce4462D57bD51A6A552365A011b95f0E16d9B7",
    true
  ),
  worldchain: evm(
    "testnet",
    "worldchain",
    "World Chain Sepolia",
    14,
    4801,
    "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88",
    true
  ),
} as const

/** Both networks, keyed by `Network`. */
export const Chains = { mainnet, testnet } as const

/** Every chain of `network`. */
export const chainsOf = (network: Network): ReadonlyArray<ChainRef> =>
  Object.values(Chains[network])

/** The chain with Circle domain `domain` on `network`, if the registry has it. */
export const chainByDomain = (
  network: Network,
  domain: Domain
): ChainRef | undefined => chainsOf(network).find((c) => c.domain === domain)
