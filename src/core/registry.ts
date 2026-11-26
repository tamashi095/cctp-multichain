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
 * - Sui packages and state objects (mainnet and testnet):
 *   https://developers.circle.com/cctp/references/sui-packages
 * - USDC: https://developers.circle.com/stablecoins/usdc-contract-addresses
 *
 * Addresses are written in EIP-55 checksum case. Circle's page prints World
 * Chain's USDC in another case (`0x79A0…24D1`, same address).
 *
 * Chain ids are not Circle's to assign and Circle's pages do not list them;
 * `test/registry.test.ts` checks each against viem's chain definitions.
 * Solana's genesis hashes are what `getGenesisHash` answered on
 * api.mainnet-beta.solana.com and api.devnet.solana.com (2026-11-26), and
 * Sui's chain identifiers what `getChainIdentifier` answered on
 * fullnode.mainnet.sui.io and fullnode.testnet.sui.io.
 *
 * Sui's `messenger` and `usdcTokenId` are hashes of type names, as Circle's
 * Move source derives them. `test/registry.test.ts` recomputes them and
 * `test/sui-ptb.test.ts` finds them in real messages on both networks.
 */
import type {
  ChainRef,
  Domain,
  EvmChainRef,
  Network,
  SolanaChainRef,
  SuiChainRef,
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

const sui = (
  network: Network,
  name: string,
  ids: Omit<
    SuiChainRef,
    "family" | "network" | "key" | "name" | "domain" | "fastSource"
  >
): SuiChainRef => ({
  family: "sui",
  network,
  key: "sui",
  name,
  domain: 8,
  // "N/A" in Circle's table: Standard attestation on Sui already takes about half a second.
  fastSource: false,
  ...ids,
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
  sui: sui("mainnet", "Sui", {
    chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
    usdc: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    messageTransmitterPackage:
      "0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87",
    tokenMessengerMinterPackage:
      "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830",
    stablecoinHandlerPackage:
      "0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf",
    messageTransmitterState:
      "0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c",
    tokenMessengerMinterState:
      "0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167",
    stablecoinHandlerState:
      "0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41",
    usdcTreasury:
      "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
    messenger:
      "0xf47842a2b5ac4483731927a7500175a9354d2eccd94312aa591ec50b9e8657e6",
    usdcTokenId:
      "0x3f2e28d163e25042ac7c9543c15675af5aa5d3c27dbc656a67f37f4293a3fdef",
  }),
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
  sui: sui("testnet", "Sui Testnet", {
    chainIdentifier: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD",
    usdc: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
    messageTransmitterPackage:
      "0xe9678cd42a81886e18e21361088071f275105636a4d3751e1d7f255211f73bbe",
    tokenMessengerMinterPackage:
      "0x267d3c0cb776eace2840f27e4d33da9c6d952f9749403f1fe6579f4962ed3c64",
    stablecoinHandlerPackage:
      "0xbe8479044396a45e07de2c7f14789c35b8338406eebc53b2527da56839a91561",
    messageTransmitterState:
      "0xfee3a2b47f9ef2de2405fc63d79194307945f8ea768815cfc46083bc20fbe6ed",
    tokenMessengerMinterState:
      "0x72cb55cd14d01e6361386d6ea93eecda9fa1efc3c202b8dd69c1e4683e4c0ca0",
    stablecoinHandlerState:
      "0xfbd9c0517c4f0e1817445ee2be598806e3c392a465d7e3d773d1055f3f0eed32",
    usdcTreasury:
      "0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe",
    messenger:
      "0xe3e567f5d3598022563be19ee9da09b6c7190400ce48e6155a872e569f9e7a51",
    usdcTokenId:
      "0xba0aeb4444ae728084b1536f72ce7f6424c5e59a1d63b7c3af70e9bff3ed3823",
  }),
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
