// Robinhood Chain testnet plumbing: chain constants, a .env loader, a rate-limit-tolerant
// provider pinned to the chain id, a signer, and small formatting helpers.
//
// Robinhood Chain is an Arbitrum-Orbit L2 with the native gas token ETH. Unlike Rootstock
// (which forces legacy type-0 txs), this chain supports standard EIP-1559 — blocks carry a
// `baseFeePerGas` and the node answers `eth_maxPriorityFeePerGas`. So ethers' default 1559
// envelope is accepted and we do NOT need the RSK legacy-gasPrice override. We keep a tiny
// gasPrice fallback only as a defensive net if a given RPC ever refuses 1559.
//
// Verified 2026-08-17 against https://rpc.testnet.chain.robinhood.com/rpc :
//   eth_chainId              -> 0xb626 (46630)
//   latest block baseFeePerGas -> 0x989680 (0.01 gwei)  => EIP-1559 live
//   eth_maxPriorityFeePerGas -> 0x0                       => zero-tip accepted
import { readFileSync, existsSync } from "node:fs";
import { Contract, JsonRpcProvider, Network, Wallet, keccak256, toUtf8Bytes } from "ethers";

// --- chain constants, selected by NETWORK (env or process.env) ---
// rh-testnet (default) | rh-mainnet | arbitrum-one. Mainnet values verified 2026-09-17:
//   https://rpc.mainnet.chain.robinhood.com/rpc  eth_chainId -> 0x1237 (4663)
//   https://arb1.arbitrum.io/rpc                 eth_chainId -> 0xa4b1 (42161)
export const NETWORKS = {
  "rh-testnet": {
    name: "Robinhood Chain testnet",
    chainId: 46630n,
    rpc: "https://rpc.testnet.chain.robinhood.com/rpc",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    faucet: "https://faucet.testnet.chain.robinhood.com",
    deployDir: "",
  },
  "rh-mainnet": {
    name: "Robinhood Chain mainnet",
    chainId: 4663n,
    rpc: "https://rpc.mainnet.chain.robinhood.com/rpc",
    explorer: "https://explorer.mainnet.chain.robinhood.com",
    faucet: null,
    deployDir: "rh-mainnet/",
  },
  "arbitrum-one": {
    name: "Arbitrum One",
    chainId: 42161n,
    rpc: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
    faucet: null,
    deployDir: "arbitrum-one/",
  },
  // Celo has been an Ethereum L2 on the OP Stack since March 2025, so it takes the same
  // EIP-1559 envelope and the same cancun bytecode as the Orbit chains above — no legacy-tx
  // hack, no separate compile. What differs is the gas token: CELO, not ETH, and the public
  // Forno endpoint quotes a gas price two orders of magnitude above the Orbit chains, so read
  // the estimate in CELO before funding. Verified 2026-09-23 against https://forno.celo.org:
  //   eth_chainId -> 0xa4ec (42220), maxFeePerGas quoted => EIP-1559 live.
  "celo-mainnet": {
    name: "Celo mainnet",
    chainId: 42220n,
    rpc: "https://forno.celo.org",
    explorer: "https://celoscan.io",
    faucet: null,
    deployDir: "celo-mainnet/",
    symbol: "CELO",
  },
};

const NETWORK_KEY = process.env.NETWORK || "rh-testnet";
export const NETWORK = NETWORKS[NETWORK_KEY];
if (!NETWORK) {
  throw new Error(`Unknown NETWORK=${NETWORK_KEY}. Use one of: ${Object.keys(NETWORKS).join(", ")}`);
}
export const NETWORK_NAME = NETWORK_KEY;
export const IS_MAINNET = NETWORK.faucet === null;
export const CHAIN_ID = NETWORK.chainId;
export const DEFAULT_RPC = NETWORK.rpc;
export const EXPLORER = NETWORK.explorer;
export const FAUCET = NETWORK.faucet;
// Gas-token ticker for human-readable output. Every chain here but Celo pays gas in ETH.
export const SYMBOL = NETWORK.symbol || "ETH";

// --- tiny .env loader (no dependency); process.env wins ---
const ENV_PATH = new URL("../.env", import.meta.url).pathname;
export function env(path = ENV_PATH) {
  const out = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (/^[A-Z0-9_]+$/.test(k)) out[k] = v;
  }
  return out;
}

/** Provider pinned to the selected network's chain id (skips the auto-detect eth_chainId storm). */
export function makeProvider(rpc = DEFAULT_RPC) {
  const provider = new JsonRpcProvider(rpc || DEFAULT_RPC, undefined, {
    staticNetwork: Network.from(CHAIN_ID),
  });
  provider.pollingInterval = 2000;
  return provider;
}

/** Standard EIP-1559 signer. Robinhood Chain accepts the default 1559 envelope, so — unlike
 *  lib/rsk.mjs — we do NOT rewrite sendTransaction to force legacy type-0 gasPrice. If a
 *  future RPC rejects 1559, uncomment the legacy fallback below. */
export async function makeSigner(pk, provider) {
  return new Wallet(pk, provider);
  // Legacy fallback (only if an RPC ever rejects EIP-1559 envelopes):
  // const w = new Wallet(pk, provider);
  // const fee = await provider.getFeeData();
  // const gasPrice = ((fee.gasPrice ?? 10_000_000n) * 12n) / 10n;
  // const orig = w.sendTransaction.bind(w);
  // w.sendTransaction = (tx) => orig({ ...tx, type: 0, gasPrice, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined });
  // return w;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry transient public-RPC failures (rate limits, coalesce, detect-network). */
export async function withRetry(label, fn, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e && (e.error?.message || e.shortMessage || e.message)) || "";
      const transient =
        /request limit|rate|-32011|-32005|timeout|coalesce|failed to detect network|ETIMEDOUT|ECONNRESET|nonce/i.test(
          msg,
        );
      lastErr = e;
      if (!transient) throw e;
      const wait = 1500 * (i + 1);
      console.error(`  (${label}) transient RPC error, retry ${i + 1}/${tries} in ${wait}ms…`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// --- settlement ABI + helpers (mirrors lib/arc.mjs) ---
export const SETTLEMENT_ABI = [
  "event Paid(address indexed payer, bytes32 indexed route, uint256 amount, uint256 timestamp, string meta)",
  "function payForRoute(bytes32 route, string calldata meta) external payable",
  "function owner() view returns (address)",
  "function withdraw(address payable to) external",
];

export function settlementContract(provider, address) {
  return new Contract(address, SETTLEMENT_ABI, provider);
}

/** bytes32 route id — keccak256 over the UTF-8 route string. */
export function routeHash(route) {
  return keccak256(toUtf8Bytes(route));
}

export const txLink = (hash) => `${EXPLORER}/tx/${hash}`;
export const addressLink = (addr) => `${EXPLORER}/address/${addr}`;
