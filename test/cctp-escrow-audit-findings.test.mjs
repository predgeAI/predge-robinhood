// Audit 2026-10-10: one focused case per finding in PredgeCctpDisputeEscrow (F1-F5). Each case asserts
// the property the escrow must have; on the audited build ee70335 all five failed.
//
//   node test/cctp-escrow-audit-findings.test.mjs       # exits 1 if any property does not hold
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import solc from "solc";
import ganache from "ganache";
import { BrowserProvider, ContractFactory, keccak256, toUtf8Bytes, id, solidityPacked, zeroPadValue, toBeHex, getAddress } from "ethers";

const MOCKS = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public isBlacklisted;
    address public minter;
    constructor() { minter = msg.sender; }
    function setMinter(address m) external { minter = m; }
    function blacklist(address a) external { isBlacklisted[a] = true; } // FiatToken: transfer to a blacklisted address reverts
    function mint(address to, uint256 v) external { require(msg.sender == minter, "minter"); balanceOf[to] += v; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(!isBlacklisted[msg.sender] && !isBlacklisted[to], "Blacklistable: account is blacklisted");
        require(balanceOf[msg.sender] >= v, "bal"); balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
}
contract MockMessageTransmitterV2 {
    MockUSDC public immutable usdc;
    mapping(bytes32 => bool) public used;
    constructor(MockUSDC u) { usdc = u; }
    function receiveMessage(bytes calldata m, bytes calldata) external returns (bool) {
        bytes32 nonce = bytes32(m[12:44]);
        require(!used[nonce], "nonce used");
        bytes32 caller = bytes32(m[108:140]);
        require(caller == bytes32(0) || caller == bytes32(uint256(uint160(msg.sender))), "destinationCaller");
        used[nonce] = true;
        address to = address(uint160(uint256(bytes32(m[184:216]))));
        usdc.mint(to, uint256(bytes32(m[216:248])) - uint256(bytes32(m[312:344])));
        return true;
    }
}`;

const escrowSrc = process.env.ESCROW_SRC || new URL("../contracts/PredgeCctpDisputeEscrow.sol", import.meta.url).pathname;
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: {
    "Mocks.sol": { content: MOCKS },
    "PredgeAgentValidator.sol": { content: readFileSync(new URL("../contracts/PredgeAgentValidator.sol", import.meta.url), "utf8") },
    "PredgeCctpDisputeEscrow.sol": { content: readFileSync(escrowSrc, "utf8") },
  },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
const fatal = (out.errors || []).filter((e) => e.severity === "error");
assert.equal(fatal.length, 0, fatal.map((e) => e.formattedMessage).join("\n"));
const C = out.contracts;

const chain = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 5, defaultBalance: 100 } });
const provider = new BrowserProvider(chain);
const [operator, claimant, respondent, relayer, attacker] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));
const GAS = { gasLimit: 1_000_000 };
const deploy = async (file, name, signer, ...args) =>
  (await new ContractFactory(C[file][name].abi, "0x" + C[file][name].evm.bytecode.object, signer).deploy(...args)).waitForDeployment();

const TM = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const usdc = await deploy("Mocks.sol", "MockUSDC", operator);
const mt = await deploy("Mocks.sol", "MockMessageTransmitterV2", operator, await usdc.getAddress());
await (await usdc.setMinter(await mt.getAddress())).wait();
const registry = await deploy("PredgeAgentValidator.sol", "PredgeAgentValidator", operator, await operator.getAddress());
const escrow = await deploy("PredgeCctpDisputeEscrow.sol", "PredgeCctpDisputeEscrow", operator,
  await usdc.getAddress(), await mt.getAddress(), await registry.getAddress(), TM, 6, 3);
const ESCROW = await escrow.getAddress();
const [CL, R, A] = await Promise.all([claimant, respondent, attacker].map((s) => s.getAddress()));
const b32 = (a) => zeroPadValue(getAddress(a), 32);
const u256 = (n) => zeroPadValue(toBeHex(n), 32);
let nonce = 1;
const message = ({ hook, amount = 100_000n, fee = 0n, depositor = CL }) =>
  solidityPacked(["uint32", "uint32", "uint32", "bytes32", "bytes32", "bytes32", "bytes32", "uint32", "uint32"],
    [1, 6, 3, u256(nonce++), b32(TM), b32(TM), b32(ESCROW), 1000, 1000]) +
  solidityPacked(["uint32", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256", "uint256", "bytes"],
    [1, b32("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), b32(ESCROW), amount, b32(depositor), 1000n, fee, 0n, hook]).slice(2);
const verdict = async (h, score) => (await registry.connect(operator).validationResponse(h, score, "u", keccak256(toUtf8Bytes("v" + h)), "t", GAS)).wait();
const tryTx = async (p) => { try { const r = await p; if (typeof r?.wait === "function") await r.wait(); return true; } catch (e) { if (process.env.DEBUG) console.log("  revert:", e.shortMessage || e.message, e.data || e.info?.error?.data || ""); return false; } };
const tick = async (sec) => { await provider.send("evm_increaseTime", [sec]); await provider.send("evm_mine", []); };
const DAY = 86400;
async function open(signer, label) {
  const salt = keccak256(toUtf8Bytes(label));
  await (await escrow.connect(signer).openDispute(salt, R, "u", GAS)).wait();
  return escrow.disputeId(await signer.getAddress(), salt);
}
const fund = (h, extra = {}) => escrow.connect(relayer).fund(message({ hook: h, ...extra }), "0x", GAS).then((t) => t.wait());
const withdrawn = async (s) => { const b = await usdc.balanceOf(await s.getAddress()); if (!(await tryTx(escrow.connect(s).withdraw(GAS)))) return null; return (await usdc.balanceOf(await s.getAddress())) - b; };

const results = [];
async function finding(name, fn) {
  try { await fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name + " -- " + (e.message || e).toString().split("\n")[0]]); }
}

await finding("F1 High: a squatted dispute id must not capture the real claimant's burn", async () => {
  const salt = keccak256(toUtf8Bytes("predge/cctp-m2/m2-1")); // even a public, predictable salt
  await (await escrow.connect(attacker).openDispute(salt, A, "u", GAS)).wait();
  const h = await open(claimant, "predge/cctp-m2/m2-1"); // still opens: the id includes the claimant
  assert.equal((await escrow.disputes(h)).claimant, CL);
  const attackersId = await escrow.disputeId(A, salt);
  assert.equal(await tryTx(fund(attackersId)), false, "the claimant's burn was credited to the attacker's dispute");
  assert.equal(await tryTx(fund(h, { depositor: A })), false, "a burn by someone else was credited");
  await fund(h);
  await tick(2); await verdict(h, 0); await (await escrow.resolve(h, GAS)).wait();
  assert.equal(await withdrawn(claimant), 100_000n);
  assert.equal(await usdc.balanceOf(A), 0n);
});

await finding("F2 Medium: the claimant recovers the pot 7 days after the LAST funding if no verdict comes", async () => {
  const h = await open(claimant, "silent-validator");
  await fund(h, { amount: 60_000n });
  await tick(6 * DAY);
  await fund(h, { amount: 40_000n }); // restarts the delay
  await tick(2 * DAY);
  assert.equal(await tryTx(escrow.reclaim(h, GAS)), false, "reclaim allowed 2 days after the last funding");
  await tick(5 * DAY + 10);
  assert.ok(await tryTx(escrow.connect(relayer).reclaim(h, GAS)), "reclaim refused 7 days after the last funding");
  assert.equal(await withdrawn(claimant), 100_000n);
  // A verdict that arrives afterwards changes nothing.
  await verdict(h, 100);
  assert.equal(await tryTx(escrow.resolve(h, GAS)), false);
  // And reclaim is refused while a counting verdict exists.
  const g = await open(claimant, "answered");
  await fund(g); await tick(2); await verdict(g, 100); await tick(8 * DAY);
  assert.equal(await tryTx(escrow.reclaim(g, GAS)), false, "reclaim overrode a recorded verdict");
  await (await escrow.resolve(g, GAS)).wait();
  assert.equal(await withdrawn(respondent), 100_000n);
});

await finding("F3 Medium: a verdict written before the pot is funded must not settle the dispute", async () => {
  const h = await open(claimant, "verdict-first");
  await verdict(h, 100); // respondent wins, nothing is locked yet
  assert.equal(await tryTx(escrow.resolve(h, GAS)), false, "resolve() settled an unfunded dispute");
  await tick(2);
  await fund(h);
  assert.equal(await tryTx(escrow.resolve(h, GAS)), false, "a verdict recorded before funding was used for the payout");
  const [ready] = await escrow.preview(h);
  assert.equal(ready, false);
  await tick(7 * DAY + 10);
  await (await escrow.reclaim(h, GAS)).wait(); // the ignored verdict ends in the claimant's refund
  assert.equal(await withdrawn(claimant), 100_000n);
});

await finding("F4 Medium: one blacklisted party must not lock the other party's share", async () => {
  const h = await open(claimant, "blacklisted-respondent");
  await fund(h);
  await tick(2);
  await verdict(h, 50);
  await (await usdc.blacklist(R)).wait(); // Circle blacklists the respondent
  assert.ok(await tryTx(escrow.resolve(h, GAS)), "resolve() reverted");
  assert.equal(await withdrawn(claimant), 50_000n, "claimant's 50% is stuck");
  assert.equal(await withdrawn(respondent), null); // the blacklisted party cannot withdraw...
  assert.equal(await escrow.owed(R), 50_000n); // ...but keeps its credit
  // A late burn after resolution still relays (credited to the claimant), even with a blacklisted respondent.
  assert.ok(await tryTx(fund(h, { amount: 5_000n })), "late fund() reverted");
  assert.equal(await withdrawn(claimant), 5_000n);
});

await finding("F5 Low: a pre-filed registry request must not block openDispute", async () => {
  const salt = keccak256(toUtf8Bytes("prefiled"));
  const h = await escrow.disputeId(CL, salt);
  await (await registry.connect(attacker).validationRequest(await registry.validator(), 0, "junk", h, GAS)).wait();
  assert.ok(await tryTx(escrow.connect(claimant).openDispute(salt, R, "u", GAS)), "openDispute reverts AlreadyRequested");
  await fund(h); await tick(2); await verdict(h, 0); await (await escrow.resolve(h, GAS)).wait();
  assert.equal(await withdrawn(claimant), 100_000n);
  // A pre-filed request that is already answered is refused (the verdict would predate the dispute).
  const s2 = keccak256(toUtf8Bytes("preanswered"));
  const h2 = await escrow.disputeId(CL, s2);
  await (await registry.connect(attacker).validationRequest(await registry.validator(), 0, "junk", h2, GAS)).wait();
  await verdict(h2, 100);
  assert.equal(await tryTx(escrow.connect(claimant).openDispute(s2, R, "u", GAS)), false, "adopted an answered request");
});

// Solvency: the escrow holds exactly what it owes plus every open pot.
await finding("Invariant: balance == totalOwed + open pots", async () => {
  const owedNow = await escrow.totalOwed();
  assert.equal(await usdc.balanceOf(ESCROW), owedNow, `balance ${await usdc.balanceOf(ESCROW)} != totalOwed ${owedNow}`);
});

for (const [s, n] of results) console.log(`${s}  ${n}`);
const passed = results.filter((r) => r[0] === "PASS").length;
console.log(`\n${passed}/${results.length} properties hold`);
if (passed !== results.length) process.exit(1);
