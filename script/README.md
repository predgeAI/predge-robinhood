# `script/` — environment and the three parties

Every script here loads `.env` through `env()` in [`lib/robinhood.mjs`](../lib/robinhood.mjs).
`process.env` wins over the file, so anything below can also be passed inline:

```bash
NETWORK=rh-mainnet PROVIDER_PRIVATE_KEY=0x… node script/live-loop.mjs
```

`.env` is gitignored and written `0600`. `.env.example` is the template.

## Variables

| Variable | Required | Meaning |
|---|---|---|
| `PRIVATE_KEY` | yes | Operator key. Deploys the contracts, and in `live-loop.mjs` plays **client** and **validator**. |
| `PROVIDER_PRIVATE_KEY` | no (but see below) | The **provider** party in `live-loop.mjs`. |
| `NETWORK` | no | `rh-testnet` (default), `rh-mainnet`, `arbitrum-one`, `celo-mainnet`. |
| `RPC_URL` | no | Overrides the mainnet RPC. Testnet uses `ROBINHOOD_RPC`. |
| `DEPLOYER_ADDRESS` | no | Bookkeeping; written by `npm run genwallet`. |
| `PREDGE_API` | no | Signal API base, default `https://api.predge.io`. |

## Why `PROVIDER_PRIVATE_KEY` matters

`live-loop.mjs` stages an accountability loop between three roles:

- **client** — escrows the job (`createJob`)
- **provider** — commits the deliverable (`submit`)
- **validator** — stakes a bond and writes the verdict (`stakeAndCommit`, `recordScore`)

The provider has to be a different key from the validator. If one key both produces the
deliverable and grades it, the bond is decoration: there is no configuration of the world in
which it gets slashed.

Leaving `PROVIDER_PRIVATE_KEY` unset **does** give the provider its own address — the loop
derives one as `keccak256(PRIVATE_KEY + ":predge-loop-provider")` — which is enough for the
contracts to accept the run, and it keeps the demo to a single funded wallet. But the operator
can recompute that key at will, so the separation is bookkeeping rather than a fact about who
controls what. Set `PROVIDER_PRIVATE_KEY` to a key the operator does not derive and the three
parties are independent for real.

Each run prints which mode it is in, and writes `parties.providerIndependent` into
`deploy/<network>/live-loop-<timestamp>.json`, so a receipt cannot be read as proving more
than the run actually demonstrated.

The provider key needs no prefunding. The loop measures the gas its `submit` will cost and
tops the address up from the operator wallet first.

```bash
# generate one (prints only the public address)
node -e 'import("ethers").then(({Wallet})=>{const w=Wallet.createRandom();
  console.log("add to .env:\nPROVIDER_PRIVATE_KEY="+w.privateKey);console.log("address",w.address)})'
```

## `PINNED_KEY` is a public key — leave it in the source

```js
const PINNED_KEY = "13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9";
```

This is **not** a secret and not an Ethereum key. It is the ed25519 **public** key of the
Predge signal signer, in the raw 32-byte form that `attestation.keyId` carries. The loop pins
it so a tampered or substituted `api.predge.io` cannot hand the validator a signal signed by
some other key and have it recorded on chain as verified.

Two consequences, both easy to get backwards:

- **It belongs in committed source.** A pin that an environment variable can change is not a
  pin. Moving it to `.env` would let anyone who can set the environment swap the signer the
  validator trusts, which is the exact attack the constant exists to stop.
- **It must never be "rotated" to a fresh key.** It is one half of a keypair the Predge signer
  holds. Replacing it with a newly generated value makes every real signal fail verification.
  It changes only when the signer itself rotates, and then it changes to that signer's new
  public key.

Anyone auditing this file should confirm the distinction rather than assume: a 64-character
hex literal near the word `KEY` is not automatically a credential.
