#!/usr/bin/env node
/**
 * Arc accelerator M2: a dispute raised on Arbitrum One, settled with USDC moved from Base over CCTP V2.
 *
 *   1 open     Arbitrum  escrow.openDispute(requestHash, respondent, requestURI)          Circle wallet (claimant)
 *   2 approve  Base      USDC.approve(TokenMessengerV2, amount)                            Circle wallet
 *   3 burn     Base      TokenMessengerV2.depositForBurnWithHook(amount, 3, escrow, USDC,
 *                        destinationCaller = escrow, maxFee, 1000, hookData = requestHash)   Circle wallet
 *   4 fund     Arbitrum  escrow.fund(message, attestation)  (escrow calls receiveMessage)   Circle wallet
 *   5 verdict  Arbitrum  PredgeAgentValidator.validationResponse(requestHash, score, ...)    validator key (PRIVATE_KEY)
 *   6 resolve  Arbitrum  escrow.resolve(requestHash)                                         Circle wallet (anyone)
 *
 *   node script/cctp-m2-dispute.mjs                         plan: read chain state, simulate, print calldata. Sends nothing.
 *   node script/cctp-m2-dispute.mjs --verify                re-check every recorded tx on-chain, print the proof table
 *   node script/cctp-m2-dispute.mjs --step open --yes       send one step (the owner runs this; mainnet, real USDC)
 *
 * Options: --escrow 0x..  (default deploy/arbitrum-one/PredgeCctpDisputeEscrow.json)
 *          --id <label>   dispute label, requestHash = keccak256("predge/cctp-m2/" + label)  (default m2-1)
 *          --amount 0.10  USDC burned on Base      --score 0   verdict (0 = refund the claimant)
 *          --respondent 0x..  (default Predge payTo 0x9084...1144)
 *          --circle-env PATH  env file with CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET (never printed)
 *
 * Circle steps need `npm i --no-save @circle-fin/developer-controlled-wallets`. Every Circle request carries a
 * deterministic idempotency key, and each step is recorded in deploy/arbitrum-one/cctp-m2-<id>.json before it
 * is sent, so re-running a step never sends it twice. Secrets are read from files and never printed.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Interface, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes, zeroPadValue, getAddress, parseUnits, formatUnits, formatEther } from "ethers";

const W = { address: "0x718bc0901be5008698df3ffdea616085c2970bd6", base: "5314d1fc-4611-5ff5-a58e-90aa0b6ef75a", arb: "8f518580-7d94-59d4-b488-ba1c806ee11f" };
const TM = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const MT = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
const USDC = { base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", arb: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" };
const RPC = { base: process.env.BASE_RPC_URL || "https://mainnet.base.org", arb: process.env.ARB_RPC_URL || "https://arb1.arbitrum.io/rpc" };
const SCAN = { base: "https://basescan.org/tx/", arb: "https://arbiscan.io/tx/" };
const IRIS = "https://iris-api.circle.com";
const DEPLOY = new URL("../deploy/arbitrum-one/", import.meta.url).pathname;
const REGISTRY = JSON.parse(readFileSync(DEPLOY + "PredgeAgentValidator.json", "utf8")).address;

const ERC20 = new Interface(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const TMI = new Interface(["function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)"]);
const ESC = new Interface([
  "function openDispute(bytes32 requestHash, address respondent, string requestURI)",
  "function fund(bytes message, bytes attestation) returns (uint256)",
  "function resolve(bytes32 requestHash)",
  "function disputes(bytes32) view returns (address claimant, address respondent, uint64 openedAt, bool resolved, uint8 score, uint256 pot, uint256 totalFunded)",
  "function preview(bytes32) view returns (bool ready, uint8 score, uint256 toClaimant, uint256 toRespondent)",
  "event Funded(bytes32 indexed requestHash, bytes32 indexed cctpNonce, uint32 sourceDomain, address sourceSender, uint256 burned, uint256 feeExecuted, uint256 credited)",
  "event Paid(bytes32 indexed requestHash, address indexed claimant, uint256 toClaimant, address indexed respondent, uint256 toRespondent)",
  "event DisputeOpened(bytes32 indexed requestHash, address indexed claimant, address indexed respondent, string requestURI)",
  "event Resolved(bytes32 indexed requestHash, uint8 score, bytes32 responseHash)",
]);
const REG = new Interface([
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function isValidated(bytes32) view returns (bool)",
  "function validator() view returns (address)",
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
]);

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const label = opt("--id", "m2-1");
const amount = parseUnits(opt("--amount", "0.10"), 6);
const score = Number(opt("--score", "0"));
const respondent = getAddress(opt("--respondent", "0x9084f5000e07c7133d6da5ee4f271ab6d1821144"));
const step = opt("--step", null);
const escrowFile = DEPLOY + "PredgeCctpDisputeEscrow.json";
const escrow = opt("--escrow", null) || (existsSync(escrowFile) ? JSON.parse(readFileSync(escrowFile, "utf8")).address : null);
if (amount <= 0n || amount > 1_000_000n) throw new Error("--amount must be > 0 and <= 1 USDC");
if (!(score >= 0 && score <= 100)) throw new Error("--score must be 0..100");
const requestHash = keccak256(toUtf8Bytes("predge/cctp-m2/" + label));
const requestURI = `https://api.predge.io/v1/disputes/cctp-m2/${label}`;
const STATE = DEPLOY + `cctp-m2-${label}.json`;
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { label, requestHash, requestURI, amount: amount.toString(), score, respondent, escrow, steps: {} };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
const p = { base: new JsonRpcProvider(RPC.base, 8453, { staticNetwork: true }), arb: new JsonRpcProvider(RPC.arb, 42161, { staticNetwork: true }) };
const b32 = (a) => zeroPadValue(getAddress(a), 32);
const usd = (v) => formatUnits(v, 6);
const idem = (...x) => { const h = createHash("sha256").update(x.join("|")).digest("hex").split(""); h[12] = "4"; h[16] = ((parseInt(h[16], 16) & 3) | 8).toString(16); const s = h.join(""); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`; };

async function maxFeeFor() {
  const fees = await (await fetch(`${IRIS}/v2/burn/USDC/fees/6/3`)).json();
  const bps = fees.find((f) => f.finalityThreshold === 1000)?.minimumFee ?? 1.3;
  // 2x the quoted Fast Transfer fee, rounded up, at least 1 unit. Unused fee is not charged.
  return { bps, maxFee: (amount * BigInt(Math.ceil(bps * 200)) + 999_999n) / 1_000_000n + 1n };
}

function calldata(name, extra = {}) {
  switch (name) {
    case "open": return { chain: "arb", wallet: W.arb, to: escrow, data: ESC.encodeFunctionData("openDispute", [requestHash, respondent, requestURI]) };
    case "approve": return { chain: "base", wallet: W.base, to: USDC.base, data: ERC20.encodeFunctionData("approve", [TM, amount]) };
    case "burn": return { chain: "base", wallet: W.base, to: TM, data: TMI.encodeFunctionData("depositForBurnWithHook", [amount, 3, b32(escrow), USDC.base, b32(escrow), extra.maxFee, 1000, requestHash]) };
    case "fund": return { chain: "arb", wallet: W.arb, to: escrow, data: ESC.encodeFunctionData("fund", [extra.message, extra.attestation]) };
    case "verdict": return { chain: "arb", to: REGISTRY, data: REG.encodeFunctionData("validationResponse", [requestHash, score, `${requestURI}/verdict`, keccak256(toUtf8Bytes(`predge/cctp-m2/${label}/verdict/${score}`)), "predge/cctp-dispute"]) };
    case "resolve": return { chain: "arb", wallet: W.arb, to: escrow, data: ESC.encodeFunctionData("resolve", [requestHash]) };
  }
  throw new Error("unknown step " + name);
}

async function attestation(burnHash) {
  const r = await fetch(`${IRIS}/v2/messages/6?transactionHash=${burnHash}`);
  if (r.status === 404) return null;
  const m = (await r.json()).messages?.[0];
  return m && m.status === "complete" && m.attestation && m.attestation !== "PENDING" ? m : null;
}

// ---------------------------------------------------------------- plan (read-only)
async function plan() {
  console.log(`dispute "${label}"  requestHash ${requestHash}\nescrow ${escrow ?? "(not deployed: run NETWORK=arbitrum-one node script/deploy-cctp-escrow.mjs)"}  registry ${REGISTRY}`);
  const [bU, bE, aU, aE] = await Promise.all([
    p.base.call({ to: USDC.base, data: ERC20.encodeFunctionData("balanceOf", [W.address]) }).then(BigInt), p.base.getBalance(W.address),
    p.arb.call({ to: USDC.arb, data: ERC20.encodeFunctionData("balanceOf", [W.address]) }).then(BigInt), p.arb.getBalance(W.address),
  ]);
  const validator = REG.decodeFunctionResult("validator", await p.arb.call({ to: REGISTRY, data: REG.encodeFunctionData("validator") }))[0];
  const vBal = await p.arb.getBalance(validator);
  console.log(`Circle wallet ${W.address}: Base ${usd(bU)} USDC / ${formatEther(bE)} ETH; Arbitrum ${usd(aU)} USDC / ${formatEther(aE)} ETH`);
  console.log(`validator ${validator}: Arbitrum ${formatEther(vBal)} ETH`);
  if (bU < amount) console.log(`!! Base USDC ${usd(bU)} < amount ${usd(amount)}`);
  if (aE < 500_000_000_000_000n) console.log("!! keep >= 0.0005 ETH on Arbitrum: Circle reserves gas for pending txs (mint #10 stalled on 2026-10-02 at 0.000168 ETH)");
  const { bps, maxFee } = await maxFeeFor();
  console.log(`Fast Transfer fee ${bps} bps -> maxFee ${usd(maxFee)} USDC; expected credit >= ${usd(amount - maxFee)} USDC`);
  const allowance = BigInt(await p.base.call({ to: USDC.base, data: ERC20.encodeFunctionData("allowance", [W.address, TM]) }));
  console.log(`current allowance to TokenMessengerV2: ${usd(allowance)} USDC`);
  if (escrow && (await p.arb.getCode(escrow)) === "0x") console.log(`!! no contract at ${escrow} on Arbitrum One`);
  else if (escrow) {
    const d = ESC.decodeFunctionResult("disputes", await p.arb.call({ to: escrow, data: ESC.encodeFunctionData("disputes", [requestHash]) }));
    console.log(`dispute state: openedAt ${d.openedAt} claimant ${d.claimant} respondent ${d.respondent} resolved ${d.resolved} pot ${usd(d.pot)} totalFunded ${usd(d.totalFunded)}`);
    if (d.openedAt === 0n) {
      try { await p.arb.call({ from: W.address, ...calldata("open") }); console.log("simulate open: ok"); }
      catch (e) { console.log("simulate open: REVERT", e.shortMessage || e.message); }
    }
  }
  // Base: approve then burn, simulated together on current mainnet state.
  if (escrow) {
    try {
      const sim = await p.base.send("eth_simulateV1", [{ blockStateCalls: [{ calls: [
        { from: W.address, to: USDC.base, data: calldata("approve").data },
        { from: W.address, to: TM, data: calldata("burn", { maxFee }).data },
      ] }] }, "latest"]);
      const calls = sim[0].calls;
      console.log(`simulate approve+burn: ${calls.map((c) => (c.status === "0x1" ? "ok" : "REVERT " + (c.error?.message || ""))).join(", ")}; gas ${calls.map((c) => BigInt(c.gasUsed)).join(" + ")}`);
    } catch (e) { console.log("simulate approve+burn: not available on this RPC:", e.shortMessage || e.message); }
  }
  console.log("\ncalldata (for review):");
  for (const s of ["open", "approve", "resolve", "verdict"]) if (escrow || s === "approve" || s === "verdict") console.log(` ${s.padEnd(8)} ${calldata(s).chain} -> ${calldata(s).to}  ${calldata(s).data.slice(0, 74)}…`);
  if (escrow) console.log(` burn     base -> ${TM}  ${calldata("burn", { maxFee }).data.slice(0, 74)}…`);
  console.log("\nnothing sent.");
}

// ---------------------------------------------------------------- send (owner only)
/** The dispute id is public (derived from --id), so anyone can open it first. Burn only into a dispute we own. */
async function assertOurDispute() {
  const d = ESC.decodeFunctionResult("disputes", await p.arb.call({ to: escrow, data: ESC.encodeFunctionData("disputes", [requestHash]) }));
  if (d.openedAt === 0n) throw new Error("dispute not open on Arbitrum yet: run --step open first");
  if (getAddress(d.claimant) !== getAddress(W.address) || getAddress(d.respondent) !== respondent) {
    throw new Error(`dispute ${requestHash} was opened by ${d.claimant} for ${d.respondent}, not by us for ${respondent}: pick a new --id, do not burn`);
  }
  if (d.resolved) throw new Error("dispute already resolved: pick a new --id");
  const answered = REG.decodeFunctionResult("isValidated", await p.arb.call({ to: REGISTRY, data: REG.encodeFunctionData("isValidated", [requestHash]) }))[0];
  if (answered) throw new Error("verdict already recorded before funding: pick a new --id");
}
function readEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  return out;
}
async function circleSend(name, call) {
  const envPath = opt("--circle-env", null);
  if (!envPath) throw new Error("--circle-env <path to the mainnet Circle .env> is required for Circle steps");
  const e = readEnvFile(envPath);
  const { initiateDeveloperControlledWalletsClient } = await import("@circle-fin/developer-controlled-wallets");
  const client = initiateDeveloperControlledWalletsClient({ apiKey: e.CIRCLE_API_KEY, entitySecret: e.CIRCLE_ENTITY_SECRET });
  const s = (state.steps[name] ||= { idempotencyKey: idem("predge-cctp-m2", label, name), refId: `predge-cctp-m2-${label}-${name}` });
  save();
  if (!s.circleTxId) {
    try {
      const r = await client.createContractExecutionTransaction({ walletId: call.wallet, contractAddress: call.to, callData: call.data,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } }, idempotencyKey: s.idempotencyKey, refId: s.refId });
      s.circleTxId = r.data?.id; save();
    } catch (err) { const d = err?.response?.data; throw new Error(`Circle refused ${name}: ${d?.code ?? ""} ${d?.message ?? err.message}`); }
  }
  for (let i = 0; i < 120; i++) {
    const tx = (await client.getTransaction({ id: s.circleTxId })).data?.transaction;
    if (tx?.txHash) s.txHash = tx.txHash;
    if (tx?.state === "COMPLETE" || tx?.state === "CONFIRMED") { s.state = tx.state; save(); break; }
    if (["FAILED", "DENIED", "CANCELLED"].includes(tx?.state)) { s.state = tx.state; save(); throw new Error(`${name}: Circle state ${tx.state} ${tx.errorReason ?? ""}`); }
    await new Promise((r) => setTimeout(r, 3000));
  }
  const rc = await p[call.chain].waitForTransaction(s.txHash, 1, 180_000);
  s.status = rc.status; save();
  console.log(`${name}: ${SCAN[call.chain]}${s.txHash} status ${rc.status}`);
  if (rc.status !== 1) throw new Error(`${name} reverted`);
}
async function send() {
  if (!flag("--yes")) throw new Error("sending needs --yes (mainnet, real USDC). Run without --step first to review the plan.");
  if (!escrow) throw new Error("no escrow address");
  if (state.steps[step]?.status === 1) { console.log(`${step} already done: ${state.steps[step].txHash}`); return; }
  if (step === "burn") {
    await assertOurDispute();
    const { maxFee } = await maxFeeFor();
    state.maxFee = maxFee.toString(); save();
    return circleSend("burn", calldata("burn", { maxFee }));
  }
  if (step === "fund") {
    const burn = state.steps.burn?.txHash;
    if (!burn) throw new Error("no burn recorded");
    let m = null;
    for (let i = 0; i < 120 && !(m = await attestation(burn)); i++) await new Promise((r) => setTimeout(r, 5000));
    if (!m) throw new Error("attestation not ready yet; re-run --step fund later");
    state.cctpNonce = m.eventNonce; save();
    return circleSend("fund", calldata("fund", { message: m.message, attestation: m.attestation }));
  }
  if (step === "verdict") {
    const pk = readEnvFile(new URL("../.env", import.meta.url).pathname).PRIVATE_KEY;
    if (!pk) throw new Error("PRIVATE_KEY (the validator) missing from .env");
    const w = new Wallet(pk, p.arb);
    const call = calldata("verdict");
    const s = (state.steps.verdict ||= {});
    if (!s.txHash) { const tx = await w.sendTransaction({ to: call.to, data: call.data }); s.txHash = tx.hash; save(); }
    const rc = await p.arb.waitForTransaction(s.txHash, 1, 180_000);
    s.status = rc.status; save();
    console.log(`verdict: ${SCAN.arb}${s.txHash} status ${rc.status}`);
    return;
  }
  if (["open", "approve", "resolve"].includes(step)) return circleSend(step, calldata(step));
  throw new Error("--step must be open|approve|burn|fund|verdict|resolve");
}

// ---------------------------------------------------------------- verify (read-only)
async function verify() {
  const rows = [];
  const order = ["open", "approve", "burn", "fund", "verdict", "resolve"];
  for (const name of order) {
    const s = state.steps[name];
    if (!s?.txHash) { rows.push(`| ${name} | not sent | | |`); continue; }
    const chain = name === "approve" || name === "burn" ? "base" : "arb";
    const rc = await p[chain].getTransactionReceipt(s.txHash);
    let note = "";
    for (const l of rc.logs) {
      for (const I of [ESC, REG]) { try { const ev = I.parseLog(l); if (ev) note += `${ev.name}(${ev.args.map((a) => (typeof a === "bigint" ? a.toString() : String(a).slice(0, 12))).join(",")}) `; } catch {} }
    }
    if (name === "burn") {
      const dep = rc.logs.find((l) => l.address.toLowerCase() === TM.toLowerCase());
      note += dep && dep.data.toLowerCase().includes(requestHash.slice(2).toLowerCase()) ? "DepositForBurn hookData = requestHash" : "!! hookData not found";
    }
    rows.push(`| ${name} | [${s.txHash.slice(0, 10)}…](${SCAN[chain]}${s.txHash}) | ${rc.status === 1 ? "status 1" : "FAILED"} | ${note.trim()} |`);
  }
  console.log(`requestHash ${requestHash}\n\n| Step | Tx | Receipt | Events |\n|---|---|---|---|\n${rows.join("\n")}`);
}

if (flag("--verify")) await verify();
else if (step) await send();
else await plan();
