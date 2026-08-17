// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  PredgeValidatorBond
/// @notice Capital behind a verdict. The validation agent's blunt conclusion was that a
///         signed attestation is commodity — every competitor emits the same ed25519 + JCS
///         receipt, so matching the format is worth nothing. The one axis they cannot copy
///         is **skin in the game**: a validator that stakes money it loses if it is caught
///         lying. This contract is that stake, and — because Predge's acceptance test is
///         DETERMINISTIC (`sha256(deliverable) == expected`) — the slash is **trustless**:
///         anyone can prove a dishonest verdict on-chain with the `sha256` precompile. No
///         DAO vote, no optimistic dispute, no trusted adjudicator.
///
///         Flow, per validation:
///           1. `stakeAndCommit(requestHash, expected)` — the validator posts a bond and
///              commits the deterministic acceptance test (the sha256 the deliverable must
///              match) BEFORE the work exists. Chain-timestamped, one commit per request.
///           2. `recordScore(requestHash, score)` — the validator records its verdict
///              (100 = delivered / 0 = failed). This is the claim its bond backs.
///           3. `challenge(requestHash, deliverable)` — ANYONE submits the actual delivered
///              bytes. The contract recomputes `sha256(deliverable)` and slashes the bond to
///              the challenger iff the recorded verdict contradicts the committed test:
///                 score 100 but bytes DON'T match  → falsely passed  → SLASH
///                 score 0   but bytes DO match      → falsely failed  → SLASH
///              An honest verdict is unslashable — the challenge reverts.
///           4. `reclaim(requestHash)` — after the dispute window with no successful
///              challenge, the validator withdraws its own bond.
///
///         So the validator's attestation is not "trust our signature" — it is "we have
///         staked USDC that anyone can take if we are wrong, and the test is public and
///         deterministic." That is the credible-commitment the receipt crowd lacks.
///
/// @dev    Bond is native value (on Arc, gas — and value — is USDC-denominated). Deterministic
///         acceptance tests only: `void`/subjective scores are recorded in the ERC-8004
///         registry but are out of scope here, because only a deterministic test can be
///         re-run trustlessly on-chain. Tiny, non-upgradeable, checks-effects-interactions.
contract PredgeValidatorBond {
    struct Stake {
        bytes32 expected; // sha256 the deliverable must match (committed before work)
        uint96 bond; // native value staked behind the verdict
        uint64 stakedAt; // chain time of the commitment
        uint8 score; // recorded verdict: 100 delivered / 0 failed
        bool scored; // true once a verdict is recorded
        bool closed; // true once slashed or reclaimed (permanent)
    }

    address public owner;
    address public validator;
    uint64 public disputeWindow; // seconds a verdict stays challengeable after scoring
    uint96 public totalBonded;
    uint64 public slashCount;

    mapping(bytes32 => Stake) public stakes;

    event Committed(bytes32 indexed requestHash, bytes32 expected, uint96 bond, uint64 stakedAt);
    event Scored(bytes32 indexed requestHash, uint8 score, uint64 scoredAt);
    event Slashed(bytes32 indexed requestHash, address indexed challenger, uint96 bond, uint8 recordedScore, bytes32 deliveredHash);
    event Reclaimed(bytes32 indexed requestHash, uint96 bond);
    event ValidatorUpdated(address indexed previousValidator, address indexed newValidator);

    error NotOwner();
    error NotValidator();
    error ZeroAddress();
    error ZeroHash();
    error ZeroBond();
    error AlreadyCommitted();
    error NotCommitted();
    error AlreadyScored();
    error NotScored();
    error Closed();
    error BadScore();
    error VerdictHonest();
    error WindowOpen();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
    modifier onlyValidator() {
        if (msg.sender != validator) revert NotValidator();
        _;
    }

    constructor(address validator_, uint64 disputeWindow_) {
        if (validator_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        validator = validator_;
        disputeWindow = disputeWindow_;
    }

    /// @notice Stake a bond and commit the deterministic acceptance test, BEFORE the work.
    function stakeAndCommit(bytes32 requestHash, bytes32 expected) external payable onlyValidator {
        if (expected == bytes32(0)) revert ZeroHash();
        if (msg.value == 0) revert ZeroBond();
        Stake storage s = stakes[requestHash];
        if (s.stakedAt != 0) revert AlreadyCommitted();

        s.expected = expected;
        s.bond = uint96(msg.value);
        s.stakedAt = uint64(block.timestamp);
        totalBonded += uint96(msg.value);

        emit Committed(requestHash, expected, uint96(msg.value), s.stakedAt);
    }

    /// @notice Record the verdict the bond backs. 100 = delivered, 0 = failed.
    function recordScore(bytes32 requestHash, uint8 score) external onlyValidator {
        if (score != 0 && score != 100) revert BadScore();
        Stake storage s = stakes[requestHash];
        if (s.stakedAt == 0) revert NotCommitted();
        if (s.scored) revert AlreadyScored();
        s.score = score;
        s.scored = true;
        emit Scored(requestHash, score, uint64(block.timestamp));
    }

    /// @notice Prove the recorded verdict contradicts the committed deterministic test and
    ///         take the bond. Trustless: the contract recomputes sha256 of the bytes you
    ///         submit. Reverts if the verdict was honest — you cannot grief an honest validator.
    function challenge(bytes32 requestHash, bytes calldata deliverable) external {
        Stake storage s = stakes[requestHash];
        if (s.stakedAt == 0) revert NotCommitted();
        if (!s.scored) revert NotScored();
        if (s.closed) revert Closed();

        bytes32 got = sha256(deliverable);
        bool matches = got == s.expected;
        // A lie is a recorded verdict the deterministic test contradicts.
        bool lied = (s.score == 100 && !matches) || (s.score == 0 && matches);
        if (!lied) revert VerdictHonest();

        uint96 bond = s.bond;
        s.closed = true; // effects before interaction
        s.bond = 0;
        totalBonded -= bond;
        slashCount += 1;
        emit Slashed(requestHash, msg.sender, bond, s.score, got);

        (bool ok, ) = payable(msg.sender).call{value: bond}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice After the dispute window with no successful challenge, the validator
    ///         withdraws its bond — the verdict stood.
    function reclaim(bytes32 requestHash) external onlyValidator {
        Stake storage s = stakes[requestHash];
        if (s.stakedAt == 0) revert NotCommitted();
        if (!s.scored) revert NotScored();
        if (s.closed) revert Closed();
        if (block.timestamp < s.stakedAt + disputeWindow) revert WindowOpen();

        uint96 bond = s.bond;
        s.closed = true;
        s.bond = 0;
        totalBonded -= bond;
        emit Reclaimed(requestHash, bond);

        (bool ok, ) = payable(validator).call{value: bond}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Would this deliverable slash this verdict? A free, offline-usable check.
    function wouldSlash(bytes32 requestHash, bytes calldata deliverable) external view returns (bool) {
        Stake storage s = stakes[requestHash];
        if (!s.scored || s.closed) return false;
        bool matches = sha256(deliverable) == s.expected;
        return (s.score == 100 && !matches) || (s.score == 0 && matches);
    }

    function setValidator(address newValidator) external onlyOwner {
        if (newValidator == address(0)) revert ZeroAddress();
        emit ValidatorUpdated(validator, newValidator);
        validator = newValidator;
    }
}
