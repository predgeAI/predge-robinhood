// PoC + fix proof for the reclaim-window flaw in PredgeValidatorBond.
//
// The deployed bond measures the dispute window from `stakedAt` (the moment the bond is posted),
// not from `recordScore` (the moment the verdict a challenge checks actually exists). Because
// `recordScore` carries no deadline, a validator can:
//   1. stakeAndCommit(expected = E),
//   2. let the whole dispute window elapse,
//   3. only THEN let the provider submit a deliverable X != E and record score 100 — a lie: it
//      claims the work passed when the provider's own on-chain submission says it did not,
//   4. reclaim the bond in the same breath, because `stakedAt + window` is already in the past.
// The verdict is slashable (`wouldSlash == true`) at the instant it is reclaimed, yet nobody ever
// had a window to challenge it. The bond's whole purpose — a verdict that stays challengeable for
// a day — is defeated, and a dishonest validator keeps its stake.
//
// The fix runs the window from `scoredAt`. This file compiles the CURRENTLY-DEPLOYED source
// (git HEAD) and the PATCHED working tree, and shows the escape succeeds on the former and is
// closed on the latter.
//
//   node test/bond-reclaim-window.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import solc from "solc";
import ganache from "ganache";
import { BrowserProvider, ContractFactory, parseEther, keccak256, toUtf8Bytes, id } from "ethers";

function compileSources(sources) {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const fatal = (out.errors || []).filter((e) => e.severity === "error");
  assert.equal(fatal.length, 0, fatal.map((e) => e.formattedMessage).join("\n"));
  return out.contracts;
}

const jobSrc = readFileSync(new URL("../contracts/AgentJob.sol", import.meta.url), "utf8");
const deployedBondSrc = execSync("git show 786b60b:contracts/PredgeValidatorBond.sol", {
  cwd: new URL("..", import.meta.url).pathname, encoding: "utf8",
});
const patchedBondSrc = readFileSync(new URL("../contracts/PredgeValidatorBond.sol", import.meta.url), "utf8");

const built = {
  deployed: compileSources({ "AgentJob.sol": { content: jobSrc }, "PredgeValidatorBond.sol": { content: deployedBondSrc } }),
  patched: compileSources({ "AgentJob.sol": { content: jobSrc }, "PredgeValidatorBond.sol": { content: patchedBondSrc } }),
};

const chain = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 100 } });
const provider = new BrowserProvider(chain);
const [validator, providerAcct, client, stranger] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
const GAS = { gasLimit: 300000 }; // fixed gas: skip ethers' estimateGas, which strips custom-error data over ganache
const warp = async (secs) => { await chain.request({ method: "evm_increaseTime", params: [secs] }); await chain.request({ method: "evm_mine", params: [] }); };

// A state-changing call expected to revert with `signature`. We read the revert via staticCall,
// which returns the raw 4-byte custom-error selector intact (estimateGas does not).
async function reverts(contract, signer, name, args, signature) {
  const want = id(signature).slice(0, 10);
  try {
    await contract.connect(signer).getFunction(name).staticCall(...args);
  } catch (e) {
    const got = (e && (e.data || (e.info && e.info.error && e.info.error.data))) || JSON.stringify(e);
    assert.ok(String(got).includes(want), `expected ${signature} (${want}), got ${String(got).slice(0, 120)}`);
    return;
  }
  assert.fail(`expected revert ${signature}, but the call succeeded`);
}

const WINDOW = 86400;
const EXPECTED = keccak256(toUtf8Bytes("the real deliverable"));
const MISMATCH = keccak256(toUtf8Bytes("not what was promised")); // contradicts a score-100 verdict

async function deployPair(build) {
  const jobF = new ContractFactory(build["AgentJob.sol"].AgentJob.abi, "0x" + build["AgentJob.sol"].AgentJob.evm.bytecode.object, client);
  const job = await (await jobF.deploy()).waitForDeployment();
  const bondF = new ContractFactory(build["PredgeValidatorBond.sol"].PredgeValidatorBond.abi, "0x" + build["PredgeValidatorBond.sol"].PredgeValidatorBond.evm.bytecode.object, validator);
  const bond = await (await bondF.deploy(await validator.getAddress(), await job.getAddress(), WINDOW)).waitForDeployment();
  return { job, bond };
}

// Stake, let the window elapse, THEN submit a contradicting deliverable and record score 100.
async function lieAfterWindow(build) {
  const { job, bond } = await deployPair(build);
  const requestHash = keccak256(toUtf8Bytes(`req-${Math.random()}`));
  await (await job.connect(client).createJob(await providerAcct.getAddress(), await validator.getAddress(), requestHash, { value: parseEther("0.01") })).wait();
  await (await bond.connect(validator).stakeAndCommit(requestHash, EXPECTED, 1n, { value: parseEther("0.1"), ...GAS })).wait();
  await warp(WINDOW + 10);                                                            // the whole window elapses BEFORE the verdict exists
  await (await job.connect(providerAcct).submit(1n, MISMATCH, "0x", GAS)).wait();     // provider's on-chain deliverable != expected
  await (await bond.connect(validator).recordScore(requestHash, 100, GAS)).wait();    // validator claims it passed anyway — a lie
  return { bond, requestHash };
}

let passed = 0;
const check = async (label, fn) => { await fn(); console.log(`  ok  ${label}`); passed += 1; };

console.log("\nPredgeValidatorBond reclaim window (stakedAt vs scoredAt)");

await check("DEPLOYED build: a lying validator reclaims a provably-slashable bond (the flaw)", async () => {
  const { bond, requestHash } = await lieAfterWindow(built.deployed);
  assert.equal(await bond.wouldSlash(requestHash), true, "the verdict IS a lie the moment it is recorded");
  await (await bond.connect(validator).reclaim(requestHash, GAS)).wait(); // window ran from stakedAt → already closed
  assert.equal(await bond.slashCount(), 0n, "nobody got to slash it");
  assert.equal(await bond.totalBonded(), 0n, "the bond left via reclaim, not via a challenge");
});

await check("PATCHED build: the same lie cannot be reclaimed while the window from the verdict is open", async () => {
  const { bond, requestHash } = await lieAfterWindow(built.patched);
  assert.equal(await bond.wouldSlash(requestHash), true);
  await reverts(bond, validator, "reclaim", [requestHash], "WindowOpen()"); // window now runs from scoredAt — still open
  await (await bond.connect(stranger).challenge(requestHash, GAS)).wait();  // anyone can take the bond for the lie
  assert.equal(await bond.slashCount(), 1n);
  assert.equal(await bond.totalBonded(), 0n);
});

await check("PATCHED build: an honest verdict still reclaims after the window from the verdict", async () => {
  const { job, bond } = await deployPair(built.patched);
  const requestHash = keccak256(toUtf8Bytes("honest"));
  await (await job.connect(client).createJob(await providerAcct.getAddress(), await validator.getAddress(), requestHash, { value: parseEther("0.01") })).wait();
  await (await bond.connect(validator).stakeAndCommit(requestHash, EXPECTED, 1n, { value: parseEther("0.1"), ...GAS })).wait();
  await (await job.connect(providerAcct).submit(1n, EXPECTED, "0x", GAS)).wait(); // provider delivered what was expected
  await (await bond.connect(validator).recordScore(requestHash, 100, GAS)).wait(); // honest pass
  await reverts(bond, validator, "reclaim", [requestHash], "WindowOpen()");        // right after scoring: still open
  await warp(WINDOW + 10);
  await (await bond.connect(validator).reclaim(requestHash, GAS)).wait();           // window from scoredAt has now passed
  assert.equal(await bond.slashCount(), 0n);
  assert.equal(await bond.totalBonded(), 0n);
});

console.log(`\n${passed} passed\n`);
await chain.disconnect();
