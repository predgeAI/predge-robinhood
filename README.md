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

> Not to be confused with **mainnet** (chainId 4663, `rpc.mainnet.chain.robinhood.com`). This
> repo targets **testnet 46630** everywhere.

## Reproduce it

```bash
npm install
npm run genwallet                 # writes .env with a fresh key (mode 0600), prints only the address

# fund DEPLOYER_ADDRESS at https://faucet.testnet.chain.robinhood.com

npm run deploy-all                # compile (solc 0.8.26, cancun) + deploy all four contracts
# individual: npm run deploy-validator | deploy-bond | deploy-job | deploy-settlement
```

Deployed addresses are written to `deploy/*.json` (gitignored).

## Next steps (human — on-chain actions intentionally left undone)

This repo is prepared and compile-verified locally. **No wallet has been funded and nothing has
been deployed on-chain.** To go live, exactly two steps:

1. **Fund the deployer.** Send testnet ETH to the address printed by `npm run genwallet`
   (already in `.env` as `DEPLOYER_ADDRESS`) at **https://faucet.testnet.chain.robinhood.com**.
   A small amount is plenty — the four contracts total < 12 KB of bytecode.
2. **Deploy.** Run `npm run deploy-all`. It compiles and deploys Validator → Bond → Job →
   Settlement in one process and records addresses to `deploy/`.

(Also left for the human: creating the GitHub remote and pushing.)

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
