// One real accountability loop on a live network, end to end, with a real Predge signal:
//
//   1. fetch a signed Predge signal from api.predge.io and verify its ed25519 signature offline
//   2. PredgeAgentValidator.validationRequest  - commit requestHash = keccak256(signed signal bytes)
//   3. AgentJob.createJob                       - client escrows ETH, evaluator = Predge validator
//   4. PredgeValidatorBond.stakeAndCommit       - stake ETH behind sha256(deliverable), bound to the job
//   5. AgentJob.submit                          - the PROVIDER, a separate key, commits the deliverable
//   6. PredgeAgentValidator.validationResponse  - verdict 100 (signature verified), responseHash
//   7. PredgeValidatorBond.recordScore          - verdict recorded behind the bond (1-day challenge window)
//   8. AgentJob.complete                        - escrow released, reason = responseHash
//   9. PredgeSettlement.payForRoute             - pay-per-call receipt for the signal route
//
//   NETWORK=rh-mainnet node script/live-loop.mjs [wallet]
//
// The client and validator share one key so the demo runs from a single funded wallet; the
// provider is always a separate key, because a bond that the verdict-writer could have signed
// proves nothing. Set PROVIDER_PRIVATE_KEY to make that key genuinely independent (see
// script/README.md). Amounts are dust (see VALUES). Receipts go to
// deploy/<network>/live-loop-<timestamp>.json.
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Contract, keccak256, toUtf8Bytes, parseEther, formatEther } from "ethers";
import {
  env, makeProvider, makeSigner, withRetry, routeHash, txLink,
  DEFAULT_RPC, NETWORK, NETWORK_NAME, IS_MAINNET, SETTLEMENT_ABI,
} from "../lib/robinhood.mjs";

const PREDGE_API = process.env.PREDGE_API || "https://api.predge.io";
const DEFAULT_WALLET = "0x0224bb9eb0a5c9fd261ac9123a72cbdd5748292a";
const PINNED_KEY = "13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9";
const VALUES = { bond: parseEther("0.00002"), escrow: parseEther("0.00001"), pay: parseEther("0.000005") };

const VALIDATOR_ABI = [
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function validator() view returns (address)",
];
const BOND_ABI = [
  "function stakeAndCommit(bytes32 requestHash, bytes32 expected, uint256 jobId) payable",
  "function recordScore(bytes32 requestHash, uint8 score)",
];
const JOB_ABI = [
  "function createJob(address provider, address evaluator, bytes32 specHash) payable returns (uint256)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function complete(uint256 jobId, bytes32 reason, bytes optParams)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed evaluator, address provider, uint96 escrow, bytes32 specHash)",
];

// Same canonical encoding the Predge signer uses: JSON with object keys sorted, recursively.
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

function verifySignal({ attestation, signature }) {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(attestation.keyId, "hex")]);
  const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  return crypto.verify(null, Buffer.from(canonicalize(attestation)), key, Buffer.from(signature, "hex"));
}

const addr = (name) => {
  const p = new URL(`../deploy/${NETWORK.deployDir}${name}.json`, import.meta.url).pathname;
  if (!existsSync(p)) throw new Error(`missing ${p}; deploy to ${NETWORK_NAME} first`);
  return JSON.parse(readFileSync(p, "utf8")).address;
};

const e = env();
const provider = makeProvider(IS_MAINNET ? e.RPC_URL || DEFAULT_RPC : e.ROBINHOOD_RPC || DEFAULT_RPC);
const wallet = await makeSigner(e.PRIVATE_KEY, provider);
// The provider must be a different party from the validator, or the bond is theatre: one key
// writing both the deliverable and the verdict can never be caught.
//
// PROVIDER_PRIVATE_KEY is that party for real: a key the operator never derives, so the
// provider is independent in fact and not merely at a different address. Without it we fall
// back to a key derived from the operator key, which keeps the loop runnable from one funded
// wallet but leaves all three roles under one person's control — so the run says which of the
// two it was, and the receipt records it. A receipt that cannot tell them apart is a receipt
// that overclaims.
const providerKey = (e.PROVIDER_PRIVATE_KEY || "").trim();
const providerIndependent = providerKey.length > 0;
let providerWallet;
if (providerIndependent) {
  try {
    providerWallet = await makeSigner(providerKey, provider);
  } catch (err) {
    throw new Error(
      `PROVIDER_PRIVATE_KEY is set but is not a usable private key (${err.shortMessage || err.message}). ` +
      `Expected 32 bytes of hex, 0x-prefixed. Generate one with \`npm run genwallet\`, or unset the ` +
      `variable to fall back to the key derived from PRIVATE_KEY.`,
    );
  }
  if (providerWallet.address.toLowerCase() === wallet.address.toLowerCase()) {
    throw new Error(
      "PROVIDER_PRIVATE_KEY resolves to the same address as PRIVATE_KEY, so the provider would " +
      "sign its own verdict and the bond would prove nothing. Use a different key.",
    );
  }
} else {
  providerWallet = await makeSigner(keccak256(toUtf8Bytes(`${e.PRIVATE_KEY}:predge-loop-provider`)), provider);
}
const validator = new Contract(addr("PredgeAgentValidator"), VALIDATOR_ABI, wallet);
const bond = new Contract(addr("PredgeValidatorBond"), BOND_ABI, wallet);
const job = new Contract(addr("AgentJob"), JOB_ABI, wallet);
const jobAsProvider = new Contract(addr("AgentJob"), JOB_ABI, providerWallet);
const settlement = new Contract(addr("PredgeSettlement"), SETTLEMENT_ABI, wallet);

const target = process.argv[2] || DEFAULT_WALLET;
console.log(`\n=== Predge live loop on ${NETWORK.name} ===`);
console.log(`operator ${wallet.address} | balance ${formatEther(await provider.getBalance(wallet.address))} ETH`);
console.log(
  `provider ${providerWallet.address} | ${providerIndependent
    ? "independent key (PROVIDER_PRIVATE_KEY)"
    : "derived from the operator key — set PROVIDER_PRIVATE_KEY for three genuinely independent parties"}\n`,
);

// 1. real signed signal
const url = `${PREDGE_API}/v1/signal/${target}`;
const res = await fetch(url);
if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
const signal = await res.json();
if (signal.attestation?.keyId !== PINNED_KEY) throw new Error(`unexpected signer ${signal.attestation?.keyId}`);
const verified = verifySignal(signal);
if (!verified) throw new Error("signature did not verify; refusing to record a verdict");
const deliverable = Buffer.from(canonicalize(signal));
const requestHash = keccak256(deliverable);
const expected = "0x" + crypto.createHash("sha256").update(deliverable).digest("hex");
const verdict = { requestHash, verified, signer: PINNED_KEY, issuedAt: signal.attestation.issuedAt, payload: signal.attestation.payload };
const responseHash = keccak256(toUtf8Bytes(canonicalize(verdict)));
console.log(`signal  ${canonicalize(signal.attestation.payload)}`);
console.log(`ed25519 verified offline: ${verified}\nrequestHash ${requestHash}\n`);

const receipts = [];
async function send(label, fn) {
  const tx = await withRetry(label, fn);
  const r = await withRetry(`${label} wait`, () => tx.wait());
  console.log(`${label.padEnd(20)} ${r.status === 1 ? "ok " : "FAIL"} ${txLink(tx.hash)}`);
  receipts.push({ step: label, tx: tx.hash, status: r.status, block: r.blockNumber });
  if (r.status !== 1) throw new Error(`${label} reverted`);
  return r;
}

await send("validationRequest", () => validator.validationRequest(wallet.address, 0, url, requestHash));
// Top the provider up so it can pay for its own submit; that transaction has to come from
// its key, not ours, for the challenge to mean anything. Priced from the chain rather than
// hardcoded, because the native unit differs per network (USDC on Arc, ETH elsewhere).
const feeData = await withRetry("feeData", () => provider.getFeeData());
const providerGas = (feeData.maxFeePerGas ?? feeData.gasPrice ?? 1000000000n) * 200000n;
if ((await provider.getBalance(providerWallet.address)) < providerGas) {
  await send("fundProvider", () => wallet.sendTransaction({ to: providerWallet.address, value: providerGas }));
}
// The job comes first now: the bond binds to it, and a challenge reads the deliverable from it.
const created = await send("createJob", () => job.createJob(providerWallet.address, wallet.address, requestHash, { value: VALUES.escrow }));
const jobId = created.logs.map((l) => { try { return job.interface.parseLog(l); } catch { return null; } })
  .find((l) => l?.name === "JobCreated").args.jobId;
await send("stakeAndCommit", () => bond.stakeAndCommit(requestHash, expected, jobId, { value: VALUES.bond }));
await send("submit", () => jobAsProvider.submit(jobId, expected, "0x"));
await send("validationResponse", () => validator.validationResponse(requestHash, 100, url, responseHash, "predge-signal-verified"));
await send("recordScore", () => bond.recordScore(requestHash, 100));
await send("complete", () => job.complete(jobId, responseHash, "0x"));
await send("payForRoute", () => settlement.payForRoute(routeHash("/v1/signal"), requestHash, { value: VALUES.pay }));

const out = new URL(`../deploy/${NETWORK.deployDir}live-loop-${Date.now()}.json`, import.meta.url).pathname;
writeFileSync(out, JSON.stringify({
  network: NETWORK_NAME, chainId: Number(NETWORK.chainId), ranAt: new Date().toISOString(),
  signalUrl: url, signal, requestHash, expectedSha256: expected, responseHash, verdict, jobId: jobId.toString(),
  parties: {
    client: wallet.address, validator: wallet.address, provider: providerWallet.address,
    providerIndependent,
  },
  values: Object.fromEntries(Object.entries(VALUES).map(([k, v]) => [k, formatEther(v)])), receipts,
}, null, 2) + "\n");
console.log(`\nreceipts -> ${out}`);
console.log("bond reclaimable after the 1-day dispute window: reclaim(requestHash)");
