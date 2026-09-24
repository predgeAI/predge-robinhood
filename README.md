# predge-robinhood — a resolution & dispute-verification oracle for Robinhood Chain

The neutral **verdict layer** for on-chain prediction markets and RWA perps on
[Robinhood Chain](https://docs.robinhood.com/chain) — a slashable, commit-before-outcome
oracle that answers one question trustlessly: **"did the resolution match the committed
acceptance test?"**

This is the Predge agent-settlement stack ([`predge-arc`](https://github.com/predgeAI/predge-arc),
[`predge-rootstock`](https://github.com/predgeAI/predge-rootstock)) ported to Robinhood Chain
testnet. Same three EVM-portable primitives; a new L2.

## The wedge — win a primitive, not a position

Robinhood Chain will carry prediction markets and tokenized real-world-asset perps. Every one
of those needs an **independent, on-chain answer to "what actually happened / was this settled
honestly?"** that is not the market operator marking its own homework. That resolution/dispute
primitive is missing, neutral, and composable — so that is what we build.

- We are **not** a market, an exchange, or a broker. No order book, no matching, no custody.
- We touch **no Stock Tokens, no securities, no US-persons flow.** We take a `bytes32` commitment
  and a set of bytes and recompute a `sha256` on-chain. The primitive is asset-agnostic and
  jurisdiction-neutral by construction.
- We settle in the chain's **native ETH** for bonds/escrow — no stablecoin, no synthetic asset.

The result is infrastructure a prediction-market or RWA-perp builder on Robinhood Chain composes
*against*, the same way they'd compose against an oracle — not a competitor for their users.

## The three primitives (portable Ethereum semantics)

- **`PredgeAgentValidator`** — a native ERC-8004 Validation Registry (`validationRequest` /
  `validationResponse` / `getValidationStatus` / `getSummary`, canonical signatures) with the
  guarantee the standard leaves open: the response reverts unless the request was recorded first,
  and is written exactly once. Any ERC-8004 consumer settles against it with no adapter.
- **`PredgeValidatorBond`** — the validator stakes native ETH behind every verdict; anyone can
  slash a dishonest verdict on-chain via the `sha256` precompile (`0x02`) against a deterministic
  acceptance test committed *before* the work/outcome existed. Honest verdicts are unslashable.
  The validator reclaims the bond after a dispute window.
- **`AgentJob`** — a minimal ERC-8183 job (`createJob` / `submit` / `complete` / `reject`,
  evaluator-gated signatures preserved) where the *client* names Predge as the independent
  evaluator, escrows native ETH, and the evaluator settles on the committed test — closing the
  "client is also the evaluator" hole.

Plus **`PredgeSettlement`** — a tiny pay-per-call receipt contract carried over from the Arc
deployment (see the portability note below).

## Robinhood Chain testnet parameters (verified 2026-08-17)

| Field | Value |
|---|---|
| Chain ID | **46630** (`0xb626`) — verified live via `eth_chainId` |
| RPC URL | `https://rpc.testnet.chain.robinhood.com/rpc` (bare `…/robinhood.com` also answers) |
| Explorer | `https://explorer.testnet.chain.robinhood.com` (Blockscout) |
| Faucet | `https://faucet.testnet.chain.robinhood.com` |
| Native gas token | **ETH** |
| Fee model | **Standard EIP-1559** — latest block carries `baseFeePerGas` (0.01 gwei); `eth_maxPriorityFeePerGas` answers `0x0` |
| L2 type | Arbitrum Orbit (Nitro) |

> Mainnet is chainId 4663 (`rpc.mainnet.chain.robinhood.com`). Scripts default to testnet 46630;
> set `NETWORK=rh-mainnet` or `NETWORK=arbitrum-one` to target a mainnet (see below).

## Reproduce it

```bash
npm install
npm run genwallet                 # writes .env with a fresh key (mode 0600), prints only the address

# fund DEPLOYER_ADDRESS at https://faucet.testnet.chain.robinhood.com

npm run deploy-all                # compile (solc 0.8.26, cancun) + deploy all four contracts
# individual: npm run deploy-validator | deploy-bond | deploy-job | deploy-settlement
```

Deployed addresses are written to `deploy/*.json` (gitignored).

## Live on-chain (testnet 46630 — deployed 2026-08-17)

All four primitives are **deployed and verified on Robinhood Chain testnet.** Every deploy
transaction confirmed with status `0x1`; each address returns non-empty bytecode from
`eth_getCode`. Deployer: [`0x1d48…cF3c`](https://explorer.testnet.chain.robinhood.com/address/0x1d48382F0Fe3Fc7fC569cd04aabcf183Ee97cF3c).

| Contract | Address | Explorer |
|---|---|---|
| **PredgeAgentValidator** (ERC-8004) | `0x45774F0a2a56Df6578B25E2662E601Ba29816b2D` | [view](https://explorer.testnet.chain.robinhood.com/address/0x45774F0a2a56Df6578B25E2662E601Ba29816b2D) |
| **PredgeValidatorBond** (slashable ETH) | `0xf4749E4C23355e84f545322160C8A0831ba7f335` | [view](https://explorer.testnet.chain.robinhood.com/address/0xf4749E4C23355e84f545322160C8A0831ba7f335) |
| **AgentJob** (ERC-8183) | `0xB00776BBdb177EF003A071a6D90B7236b54c1030` | [view](https://explorer.testnet.chain.robinhood.com/address/0xB00776BBdb177EF003A071a6D90B7236b54c1030) |
| **PredgeSettlement** (pay-per-call receipt) | `0xB9CC5F71830743664a912cA0f70e019280c1893B` | [view](https://explorer.testnet.chain.robinhood.com/address/0xB9CC5F71830743664a912cA0f70e019280c1893B) |

Reproduce independently — the deploy metadata (tx hashes, block, args) is in [`deploy/*.json`](deploy/).

## Live on mainnet (deployed 2026-09-17)

The same byte-identical contracts are live on **Robinhood Chain mainnet (chainId 4663)** and
**Arbitrum One (chainId 42161)**. The deployer's nonces lined up, so three of the four addresses
match the testnet ones. `PredgeValidatorBond` does not: it was redeployed on 2026-09-18 to close
a flaw where `challenge()` slashed on arbitrary bytes, which made an honest verdict slashable by
anyone. That redeploy happened independently on each chain, so the bond has a **different address
per chain** — the table below gives both. Every deploy tx confirmed with status `0x1`, every
address returns bytecode, and `PredgeValidatorBond.disputeWindow()` reads `86400` (1 day) on both
chains.

| Contract | Address | Robinhood Chain | Arbitrum One |
|---|---|---|---|
| **PredgeAgentValidator** (ERC-8004) | `0x45774F0a2a56Df6578B25E2662E601Ba29816b2D` | [view](https://explorer.mainnet.chain.robinhood.com/address/0x45774F0a2a56Df6578B25E2662E601Ba29816b2D) | [view](https://arbiscan.io/address/0x45774F0a2a56Df6578B25E2662E601Ba29816b2D) |
| **PredgeValidatorBond** (slashable ETH) | per chain, see right | [`0xD808FdDa…`](https://explorer.mainnet.chain.robinhood.com/address/0xD808FdDa0aD9839e4a527D2DA32ab550CCb9D350) | [`0x97d59279…`](https://arbiscan.io/address/0x97d592796Aa3c72cf7920fC204A963bd3Bd8ac0B) |
| **AgentJob** (ERC-8183) | `0xB00776BBdb177EF003A071a6D90B7236b54c1030` | [view](https://explorer.mainnet.chain.robinhood.com/address/0xB00776BBdb177EF003A071a6D90B7236b54c1030) | [view](https://arbiscan.io/address/0xB00776BBdb177EF003A071a6D90B7236b54c1030) |
| **PredgeSettlement** (pay-per-call receipt) | `0xB9CC5F71830743664a912cA0f70e019280c1893B` | [view](https://explorer.mainnet.chain.robinhood.com/address/0xB9CC5F71830743664a912cA0f70e019280c1893B) | [view](https://arbiscan.io/address/0xB9CC5F71830743664a912cA0f70e019280c1893B) |

Deploy metadata (tx hashes, args) is in [`deploy/rh-mainnet/`](deploy/rh-mainnet/) and
[`deploy/arbitrum-one/`](deploy/arbitrum-one/). To redeploy elsewhere:

```bash
NETWORK=rh-mainnet node script/estimate-deploy.mjs   # dry-run gas estimate
npm run deploy-all:rh-mainnet                        # or deploy-all:arbitrum-one
```

## A real loop on mainnet (2026-09-17)

`script/live-loop.mjs` runs one full accountability loop with a real, live Predge signal:
fetch `api.predge.io/v1/signal/<wallet>`, verify its ed25519 signature offline against the pinned
signer `13fa3d18…52d9`, then `validationRequest` → `stakeAndCommit` → `createJob` → `submit` →
`validationResponse(100)` → `recordScore(100)` → `complete` → `payForRoute`. All eight
transactions confirmed on both mainnets:

| Step | Robinhood Chain | Arbitrum One |
|---|---|---|
| validationRequest | [tx](https://explorer.mainnet.chain.robinhood.com/tx/0x7fdca94d2076e72da466b06e6d007188459e6344f8f0fdf7103d3bc62e88ed23) | [tx](https://arbiscan.io/tx/0x9e7a0609d27564569ce3c0ae1b2e9db7a8ba3428edc9a4b79bf5a55acee67c93) |
| stakeAndCommit | [tx](https://explorer.mainnet.chain.robinhood.com/tx/0xeac9bd17bfc5f36b6bc53b22b9593e72e005ab60823277ef6805315356c61f49) | [tx](https://arbiscan.io/tx/0xf7753b4d5a643921c13cad5532ef3904fd4c02bf745267aedf26f2565d2321e8) |
| createJob | [tx](https://explorer.mainnet.chain.robinhood.com/tx/0x4cb36f610a0d65d2c5596a6f44eae11e0eb4660c25a1179d0e24414bf1370ece) | [tx](https://arbiscan.io/tx/0x3c7e5e6c4ac095e5232df0a8ee9bc38c2a2e4c851ed468069f3d222c47dc961f) |
| submit | [tx](https://explorer.mainnet.chain.robinhood.com/tx/0xbf993fd6c6bdbdfe9fd6f3614d0df31a8c9a9a52891653e3ee16a69ba51b907f) | [tx](https://arbiscan.io/tx/0x2bdb5370c1555aebf3719d24ccaccd56cea736d39a439fdf7b20bae81164ee34) |
| validationResponse | [tx](https://explorer.mainnet.chain.robinhood.com/tx/0xda3556246e2b75a1cd1a606799f9be1f2cf478888ae54ce14255baa344d16d7a) | [tx](https://arbiscan.io/tx/0x9a1b755c3d0fd7e369d4a19bd333b44f84d7f2f9280decc71c2c83e0e8d8dea1) |
| recordScore | [tx](https://explorer.mainnet.chain.robinhood.com/tx/0xd149550fb2a42b90807a5883bc187742a297b960c0f487364963d6149ffeafe2) | [tx](https://arbiscan.io/tx/0x8c342dbd5967d4b7761a0fa9e659a46a57c6c3ef9a2fca14f7dd4a1f2bdb03a2) |
| complete | [tx](https://explorer.mainnet.chain.robinhood.com/tx/0x363c332bba19968046d29378b004886a8743a5fa98f44daf4ec478c4841495fc) | [tx](https://arbiscan.io/tx/0x6066e1afaadc24c43e19cb1c04ffd3d4d34d869b1f1d157982b2d0e4cf4a1f1b) |
| payForRoute | [tx](https://explorer.mainnet.chain.robinhood.com/tx/0x9aae27b51087711c8ce344f83977e76c3db2e16fece4f7b365ed01048976bd7b) | [tx](https://arbiscan.io/tx/0xa61a1a46764ae401100359ba5e9f3c6980a6966458d0a9a60d6c034bca728b0a) |

The full record (signed signal, hashes, verdict, receipts) is in `deploy/<network>/live-loop-*.json`.
In this demo one key plays client, provider and validator; in production those are three parties.

```bash
NETWORK=rh-mainnet node script/live-loop.mjs [wallet]
```

## Portability notes — what changes moving from Arc/Rootstock to Robinhood Chain

- **Fee model — standard EIP-1559, no legacy hack.** Unlike Rootstock (which forces legacy
  `type: 0` txs in `lib/rsk.mjs`), Robinhood Chain supports EIP-1559: blocks carry
  `baseFeePerGas` and the node answers `eth_maxPriorityFeePerGas`. `lib/robinhood.mjs` uses the
  plain ethers signer with no `sendTransaction` override. (A commented legacy fallback is kept
  in the file in case a specific RPC ever refuses 1559 envelopes.)
- **Opcodes / `evmVersion: cancun`.** Arbitrum Nitro shipped full Cancun (PUSH0, MCOPY,
  TLOAD/TSTORE, BASEFEE) in the ArbOS 32 "Bianca" upgrade (2024); Robinhood Chain is a
  post-Bianca Orbit L2, so `cancun` compiles and deploys clean. In practice these contracts use
  **no** transient-storage opcodes — the only precompile touched is `0x02` SHA-256, which is
  bit-identical on every EVM chain, so the trustless slash works as-is.
- **Native token semantics (`PredgeSettlement`).** On Circle Arc, USDC is the *native* token, so
  `msg.value` on `payForRoute` is a USDC payment. On Robinhood Chain the native gas token is
  **ETH**, so the same bytecode records **ETH**-denominated receipts. The contract is correct
  and unchanged; only the economic meaning of the paid token differs. If a stablecoin-denominated
  pay-per-call receipt is wanted later, add an ERC-20 variant (as Rootstock did with `MockUSDC`).
  The bond/escrow layer (`PredgeValidatorBond`, `AgentJob`) already uses native ETH, which is the
  intended collateral on this chain.
- **Contracts are byte-identical** to the Arc deployment (`pragma solidity ^0.8.24`); nothing in
  the Solidity was altered for this port. Only the deploy plumbing (`lib/`, `script/`) is chain-specific.

## Contact

hello@predge.io · [@predgeAI](https://x.com/predgeAI) · build-in-public.
Companions: [`predge-arc`](https://github.com/predgeAI/predge-arc) ·
[`predge-rootstock`](https://github.com/predgeAI/predge-rootstock).

## Support the work

Predge is independent and self-funded. If it's useful, you can back development directly — any chain works:

| Chain | Address |
|---|---|
| **EVM** (ETH / Arc / Rootstock / Robinhood / Base) | `0x9084f5000E07C7133D6dA5eE4f271AB6D1821144` |
| **Bitcoin** | `bc1q50nqg5lxkac9mwqdnj6lt0369mg8snkfam0e3p` |
| **Solana** | `9dxMRRtC7RKZH5rFZpUywjmnQ87H9qHhtW43u5LYmpV` |
| **TRON** (TRX / USDT-TRC20) | `TVeWNcGwisQaL5Ge5B3GHG4tN5xX5VGxuU` |

More at [data.predge.io/settlement](https://data.predge.io/settlement).
