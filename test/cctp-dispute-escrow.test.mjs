// PredgeCctpDisputeEscrow against the real PredgeAgentValidator and a mock CCTP V2
// MessageTransmitter that mints a mock USDC exactly as the real TokenMessengerV2 handler does:
// `amount - feeExecuted` to `mintRecipient`, only when `destinationCaller` is the caller (or zero),
// and each nonce once. The attestation is not checked by the mock.
//
//   node test/cctp-dispute-escrow.test.mjs
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
    address public minter;
    constructor() { minter = msg.sender; }
    function setMinter(address m) external { minter = m; }
    function mint(address to, uint256 v) external { require(msg.sender == minter, "minter"); balanceOf[to] += v; }
    function transfer(address to, uint256 v) external returns (bool) {
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
        uint256 amount = uint256(bytes32(m[216:248]));
        uint256 fee = uint256(bytes32(m[312:344]));
        usdc.mint(to, amount - fee);
        return true;
    }
}`;

function compile(sources) {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources,
    // ganache 7 stops at shanghai (no MCOPY); the mainnet build uses cancun via script/_compile.mjs.
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const fatal = (out.errors || []).filter((e) => e.severity === "error");
  assert.equal(fatal.length, 0, fatal.map((e) => e.formattedMessage).join("\n"));
  return out.contracts;
}
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const C = compile({
  "Mocks.sol": { content: MOCKS },
  "PredgeAgentValidator.sol": { content: src("../contracts/PredgeAgentValidator.sol") },
  "PredgeCctpDisputeEscrow.sol": { content: src("../contracts/PredgeCctpDisputeEscrow.sol") },
});

const chain = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 5, defaultBalance: 100 } });
const provider = new BrowserProvider(chain);
const [operator, claimant, respondent, relayer, stranger] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));
const GAS = { gasLimit: 1_000_000 };

async function deploy(file, name, signer, ...args) {
  const c = C[file][name];
  const f = new ContractFactory(c.abi, "0x" + c.evm.bytecode.object, signer);
  return (await f.deploy(...args)).waitForDeployment();
}
async function reverts(contract, signer, name, args, signature) {
  const want = id(signature).slice(0, 10);
  try {
    await contract.connect(signer).getFunction(name).staticCall(...args);
  } catch (e) {
    const got = (e && (e.data || (e.info && e.info.error && e.info.error.data))) || JSON.stringify(e);
    assert.ok(String(got).includes(want), `expected ${signature} (${want}), got ${String(got).slice(0, 160)}`);
    return;
  }
  assert.fail(`expected revert ${signature}, but the call succeeded`);
}

const TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE = 6, ARB = 3;

const usdc = await deploy("Mocks.sol", "MockUSDC", operator);
const mt = await deploy("Mocks.sol", "MockMessageTransmitterV2", operator, await usdc.getAddress());
await (await usdc.setMinter(await mt.getAddress())).wait();
const registry = await deploy("PredgeAgentValidator.sol", "PredgeAgentValidator", operator, await operator.getAddress());
const escrow = await deploy("PredgeCctpDisputeEscrow.sol", "PredgeCctpDisputeEscrow", operator,
  await usdc.getAddress(), await mt.getAddress(), await registry.getAddress(), TOKEN_MESSENGER, BASE, ARB);
const ESCROW = await escrow.getAddress();
const b32 = (a) => zeroPadValue(getAddress(a), 32);
const u256 = (n) => zeroPadValue(toBeHex(n), 32);

let nonceSeq = 1;
/** A CCTP V2 message exactly as MessageTransmitterV2 emits it (header + BurnMessageV2 body). */
function message({ src = BASE, dst = ARB, sender = TOKEN_MESSENGER, caller = ESCROW, recipient = ESCROW,
  amount = 100_000n, fee = 13n, hook, depositor = "0x718bc0901be5008698df3ffdea616085c2970bd6", nonce } = {}) {
  const n = nonce ?? u256(nonceSeq++);
  const header = solidityPacked(
    ["uint32", "uint32", "uint32", "bytes32", "bytes32", "bytes32", "bytes32", "uint32", "uint32"],
    [1, src, dst, n, b32(sender), b32(TOKEN_MESSENGER), caller === 0 ? u256(0) : b32(caller), 1000, 1000],
  );
  const body = solidityPacked(
    ["uint32", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256", "uint256", "bytes"],
    [1, b32(BASE_USDC), b32(recipient), amount, b32(depositor), 1000n, fee, 0n, hook],
  );
  return header + body.slice(2);
}
const ATT = "0x";
const bal = async (s) => usdc.balanceOf(typeof s === "string" ? s : await s.getAddress());
const verdict = async (h, score) => (await registry.connect(operator).validationResponse(h, score, "ipfs://verdict", keccak256(toUtf8Bytes("v" + h + score)), "predge/cctp-dispute", GAS)).wait();
const R = await respondent.getAddress();

// 1. Full refund: verdict 0 sends the whole credited pot to the claimant.
{
  const h = keccak256(toUtf8Bytes("dispute-refund"));
  await (await escrow.connect(claimant).openDispute(h, R, "https://api.predge.io/x", GAS)).wait();
  assert.equal(await registry.isValidated(h), false);
  const [, , , , , requestedAt] = await registry.getValidationStatus(h);
  assert.ok(requestedAt > 0n, "openDispute files the ERC-8004 request");
  await reverts(escrow, relayer, "resolve", [h], "NoVerdict()");
  await (await escrow.connect(relayer).fund(message({ hook: h }), ATT, GAS)).wait();
  const d = await escrow.disputes(h);
  assert.equal(d.pot, 99_987n);
  const before = await bal(claimant);
  await verdict(h, 0);
  await (await escrow.connect(stranger).resolve(h, GAS)).wait();
  assert.equal((await bal(claimant)) - before, 99_987n);
  assert.equal(await bal(ESCROW), 0n);
  await reverts(escrow, stranger, "resolve", [h], "AlreadyResolved()");
  console.log("ok 1 verdict 0 refunds the claimant with USDC minted over CCTP");
}

// 2. Verdict 100 pays the respondent; verdict 50 splits.
{
  const h = keccak256(toUtf8Bytes("dispute-pay"));
  await (await escrow.connect(claimant).openDispute(h, R, "u", GAS)).wait();
  await (await escrow.connect(relayer).fund(message({ hook: h, amount: 50_000n, fee: 0n }), ATT, GAS)).wait();
  const before = await bal(respondent);
  await verdict(h, 100);
  await (await escrow.resolve(h, GAS)).wait();
  assert.equal((await bal(respondent)) - before, 50_000n);

  const s = keccak256(toUtf8Bytes("dispute-split"));
  await (await escrow.connect(claimant).openDispute(s, R, "u", GAS)).wait();
  await (await escrow.connect(relayer).fund(message({ hook: s, amount: 1001n, fee: 0n }), ATT, GAS)).wait();
  await verdict(s, 50);
  const [ready, score, toC, toR] = await escrow.preview(s);
  assert.deepEqual([ready, score, toC, toR], [true, 50n, 501n, 500n]);
  const c0 = await bal(claimant), r0 = await bal(respondent);
  await (await escrow.resolve(s, GAS)).wait();
  assert.equal((await bal(claimant)) - c0, 501n);
  assert.equal((await bal(respondent)) - r0, 500n);
  console.log("ok 2 verdict 100 pays the respondent, 50 splits");
}

// 3. USDC that arrives after resolution is paid out at once, never stranded.
{
  const h = keccak256(toUtf8Bytes("dispute-late"));
  await (await escrow.connect(claimant).openDispute(h, R, "u", GAS)).wait();
  await verdict(h, 0);
  await (await escrow.resolve(h, GAS)).wait();
  const before = await bal(claimant);
  await (await escrow.connect(relayer).fund(message({ hook: h, amount: 7000n, fee: 1n }), ATT, GAS)).wait();
  assert.equal((await bal(claimant)) - before, 6999n);
  assert.equal(await bal(ESCROW), 0n);
  console.log("ok 3 late funding pays out at the recorded verdict");
}

// 4. Every malformed or misrouted message is refused before anything is minted.
{
  const h = keccak256(toUtf8Bytes("dispute-guards"));
  await (await escrow.connect(claimant).openDispute(h, R, "u", GAS)).wait();
  await reverts(escrow, claimant, "openDispute", [h, R, "u"], "DisputeExists()");
  await reverts(escrow, relayer, "fund", [message({ hook: keccak256(toUtf8Bytes("nope")) }), ATT], "UnknownDispute()");
  await reverts(escrow, relayer, "fund", [message({ hook: h, src: 0 }), ATT], "WrongSourceDomain()");
  await reverts(escrow, relayer, "fund", [message({ hook: h, dst: 26 }), ATT], "WrongDestinationDomain()");
  await reverts(escrow, relayer, "fund", [message({ hook: h, sender: "0x000000000000000000000000000000000000dEaD" }), ATT], "WrongSender()");
  await reverts(escrow, relayer, "fund", [message({ hook: h, caller: 0 }), ATT], "WrongDestinationCaller()");
  await reverts(escrow, relayer, "fund", [message({ hook: h, recipient: await stranger.getAddress() }), ATT], "WrongMintRecipient()");
  await reverts(escrow, relayer, "fund", [message({ hook: h + "00" }), ATT], "BadHookData()");
  await reverts(escrow, relayer, "fund", [message({ hook: "0x" }), ATT], "BadHookData()");
  await reverts(escrow, relayer, "fund", ["0x1234", ATT], "BadMessage()");
  // Replay: the transmitter refuses a used nonce, so the same burn cannot be credited twice.
  const m = message({ hook: h, nonce: u256(999_999) });
  await (await escrow.connect(relayer).fund(m, ATT, GAS)).wait();
  await assert.rejects(escrow.connect(relayer).fund.staticCall(m, ATT), /nonce used|revert/);
  // Only the registry's validator can write the verdict; a stranger cannot settle it.
  await assert.rejects(registry.connect(stranger).validationResponse.staticCall(h, 0, "u", keccak256("0x01"), "t"));
  console.log("ok 4 misrouted, malformed and replayed messages are refused");
}

console.log("all PredgeCctpDisputeEscrow tests passed");
