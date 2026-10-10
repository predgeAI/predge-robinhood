// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  PredgeCctpDisputeEscrow
/// @notice A dispute raised on this chain, settled with USDC that arrives from another chain
///         over Circle CCTP V2.
///
///         Flow (first route: Base -> Arbitrum One):
///           1. Arbitrum  `openDispute(salt, respondent, requestURI)`. The caller is the claimant.
///              The dispute id is `disputeId(claimant, salt) = keccak256(abi.encode(this, claimant,
///              salt))`, so nobody else can open (squat) the claimant's id. The escrow files the
///              ERC-8004 validation request for the id in PredgeAgentValidator (or adopts one that
///              already exists and is still unanswered).
///           2. Base      `TokenMessengerV2.depositForBurnWithHook(amount, 3, mintRecipient = this,
///              USDC, destinationCaller = this, maxFee, minFinalityThreshold, hookData = id)`,
///              sent FROM the claimant's address.
///           3. Circle    attestation from the Iris API.
///           4. Arbitrum  `fund(message, attestation)`, callable by anyone. The escrow itself calls
///              `MessageTransmitterV2.receiveMessage`, so the mint and the credit happen in one
///              transaction; `destinationCaller = this` means nobody else can relay it. The burn's
///              depositor (`messageSender`, attested by Circle) must be the dispute's claimant.
///           5. Arbitrum  the validator records the verdict in PredgeAgentValidator
///              (`validationResponse(id, score, ...)`). It counts only if it was recorded strictly
///              after the dispute was first funded.
///           6. Arbitrum  `resolve(id)`, callable by anyone. The pot is split by the score:
///              `score`% to the respondent, the rest to the claimant (rounded down for the
///              respondent). 0 is a full refund, 100 pays the respondent in full, 50 (the registry's
///              VOID) splits 50/50. The shares are credited, not pushed.
///           7. Arbitrum  each party calls `withdraw()`.
///
///         Recovery: if no counting verdict exists `RECLAIM_DELAY` (7 days) after the LAST
///         successful `fund`, anyone may call `reclaim(id)`, which credits the whole pot to the
///         claimant. A verdict recorded before the first funding never counts, so it also ends
///         in `reclaim`.
///
///         Late funding: USDC credited to a dispute that is already settled (resolved or
///         reclaimed) is credited in full to the claimant's withdrawable balance. The verdict was
///         public before that money arrived, so it does not apply to it; `fund` never reverts
///         because of it, so a late CCTP message can always be relayed.
///
///         Payouts are pull-based (`owed` + `withdraw`): a party that USDC has blacklisted cannot
///         block the other party's share. A blacklisted party's balance stays credited to it.
///
///         USDC that reaches the escrow any other way (a plain transfer, or a burn relayed by
///         someone else) is never credited and has no withdrawal path.
///
/// @dev    No owner and no admin path. Trust assumptions: the verdict comes from whoever holds the
///         validator seat in PredgeAgentValidator, and that contract's owner can move the seat.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
}

interface IValidationRegistry {
    function validator() external view returns (address);
    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash) external;
    function isValidated(bytes32 requestHash) external view returns (bool);
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate);
}

contract PredgeCctpDisputeEscrow {
    // CCTP V2 message layout (developers.circle.com/cctp/technical-guide).
    uint256 private constant HEADER_LEN = 148;
    uint256 private constant H_SOURCE_DOMAIN = 4;
    uint256 private constant H_DEST_DOMAIN = 8;
    uint256 private constant H_NONCE = 12;
    uint256 private constant H_SENDER = 44;
    uint256 private constant H_RECIPIENT = 76;
    uint256 private constant H_DEST_CALLER = 108;
    uint256 private constant B_MINT_RECIPIENT = 36;
    uint256 private constant B_AMOUNT = 68;
    uint256 private constant B_MESSAGE_SENDER = 100;
    uint256 private constant B_FEE_EXECUTED = 164;
    uint256 private constant B_HOOK_DATA = 228;

    /// @notice How long after the last funding the claimant waits for a counting verdict.
    uint256 public constant RECLAIM_DELAY = 7 days;

    struct Dispute {
        address claimant; // opened the dispute; receives (100 - score)% of the pot
        address respondent; // receives score% of the pot
        uint64 openedAt;
        uint64 firstFundedAt; // first successful fund(); a verdict must be strictly later
        uint64 lastFundedAt; // last successful fund() before settlement; starts the reclaim delay
        bool resolved; // settled, by resolve() or reclaim()
        bool reclaimed; // settled by reclaim() (score 0, no verdict)
        uint8 score; // the verdict the pot was split by (valid once resolved)
        uint256 pot; // USDC credited and not yet settled
        uint256 totalFunded; // USDC ever credited to this dispute over CCTP
    }

    IERC20Minimal public immutable usdc;
    IMessageTransmitterV2 public immutable transmitter;
    IValidationRegistry public immutable registry;
    bytes32 public immutable tokenMessenger; // TokenMessengerV2, same address on source and destination
    uint32 public immutable sourceDomain; // 6 = Base
    uint32 public immutable localDomain; // 3 = Arbitrum One

    mapping(bytes32 => Dispute) public disputes;
    /// @notice USDC each address can withdraw.
    mapping(address => uint256) public owed;
    /// @notice Sum of `owed`; the escrow always holds at least this plus every open pot.
    uint256 public totalOwed;

    event DisputeOpened(bytes32 indexed id, address indexed claimant, address indexed respondent, bytes32 salt, string requestURI, bool adoptedRequest);
    event Funded(
        bytes32 indexed id,
        bytes32 indexed cctpNonce,
        uint32 sourceDomain,
        address sourceSender,
        uint256 burned,
        uint256 feeExecuted,
        uint256 credited
    );
    event Resolved(bytes32 indexed id, uint8 score, bytes32 responseHash);
    event Reclaimed(bytes32 indexed id, uint256 toClaimant);
    /// @notice Shares credited to the parties' withdrawable balances (not transferred yet).
    event Paid(bytes32 indexed id, address indexed claimant, uint256 toClaimant, address indexed respondent, uint256 toRespondent);
    event Withdrawn(address indexed party, uint256 amount);

    error ZeroAddress();
    error ZeroHash();
    error DisputeExists();
    error VerdictExists();
    error UnknownDispute();
    error AlreadyResolved();
    error NotFunded();
    error NoVerdict();
    error VerdictPredatesFunding();
    error TooEarly();
    error BadScore();
    error BadMessage();
    error WrongSourceDomain();
    error WrongDestinationDomain();
    error WrongSender();
    error WrongDestinationCaller();
    error WrongMintRecipient();
    error BadHookData();
    error WrongDepositor();
    error ReceiveFailed();
    error NothingMinted();
    error NothingOwed();
    error TransferFailed();

    constructor(
        address usdc_,
        address transmitter_,
        address registry_,
        address tokenMessenger_,
        uint32 sourceDomain_,
        uint32 localDomain_
    ) {
        if (usdc_ == address(0) || transmitter_ == address(0) || registry_ == address(0) || tokenMessenger_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20Minimal(usdc_);
        transmitter = IMessageTransmitterV2(transmitter_);
        registry = IValidationRegistry(registry_);
        tokenMessenger = bytes32(uint256(uint160(tokenMessenger_)));
        sourceDomain = sourceDomain_;
        localDomain = localDomain_;
    }

    /// @notice The id of `claimant`'s dispute opened with `salt` on this escrow. It is the CCTP hook
    ///         data and the ERC-8004 requestHash.
    function disputeId(address claimant, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), claimant, salt));
    }

    /// @notice Raise a dispute on this chain. The caller is the claimant. Use a fresh random salt.
    /// @dev    Files the ERC-8004 validation request for the id. If someone already filed a request
    ///         for this id and it is still unanswered, it is adopted (a verdict is written once, and
    ///         only a verdict recorded after funding counts, so this is safe); if it is already
    ///         answered, the id is refused.
    function openDispute(bytes32 salt, address respondent, string calldata requestURI) external returns (bytes32 id) {
        if (salt == bytes32(0)) revert ZeroHash();
        if (respondent == address(0)) revert ZeroAddress();
        id = disputeId(msg.sender, salt);
        Dispute storage d = disputes[id];
        if (d.openedAt != 0) revert DisputeExists();
        d.claimant = msg.sender;
        d.respondent = respondent;
        d.openedAt = uint64(block.timestamp);

        (address requestedValidator, , , , , ) = registry.getValidationStatus(id);
        bool adopted = requestedValidator != address(0);
        if (adopted) {
            if (registry.isValidated(id)) revert VerdictExists();
        } else {
            registry.validationRequest(registry.validator(), 0, requestURI, id);
        }
        emit DisputeOpened(id, msg.sender, respondent, salt, requestURI, adopted);
    }

    /// @notice Relay a CCTP V2 burn from the source chain and credit the minted USDC to the
    ///         dispute named in its hook data. Anyone may call; the message decides everything.
    ///         The source-chain depositor must be the dispute's claimant.
    function fund(bytes calldata message, bytes calldata attestation) external returns (uint256 credited) {
        if (message.length < HEADER_LEN + B_HOOK_DATA) revert BadMessage();
        if (_u32(message, H_SOURCE_DOMAIN) != sourceDomain) revert WrongSourceDomain();
        if (_u32(message, H_DEST_DOMAIN) != localDomain) revert WrongDestinationDomain();
        if (_b32(message, H_SENDER) != tokenMessenger || _b32(message, H_RECIPIENT) != tokenMessenger) revert WrongSender();
        bytes32 self = bytes32(uint256(uint160(address(this))));
        if (_b32(message, H_DEST_CALLER) != self) revert WrongDestinationCaller();
        if (_b32(message, HEADER_LEN + B_MINT_RECIPIENT) != self) revert WrongMintRecipient();
        if (message.length != HEADER_LEN + B_HOOK_DATA + 32) revert BadHookData();
        bytes32 id = _b32(message, HEADER_LEN + B_HOOK_DATA);

        Dispute storage d = disputes[id];
        if (d.openedAt == 0) revert UnknownDispute();
        if (_b32(message, HEADER_LEN + B_MESSAGE_SENDER) != bytes32(uint256(uint160(d.claimant)))) revert WrongDepositor();

        uint256 before = usdc.balanceOf(address(this));
        if (!transmitter.receiveMessage(message, attestation)) revert ReceiveFailed();
        credited = usdc.balanceOf(address(this)) - before;
        if (credited == 0) revert NothingMinted();

        d.totalFunded += credited;
        emit Funded(
            id,
            _b32(message, H_NONCE),
            sourceDomain,
            d.claimant,
            uint256(_b32(message, HEADER_LEN + B_AMOUNT)),
            uint256(_b32(message, HEADER_LEN + B_FEE_EXECUTED)),
            credited
        );

        if (d.resolved) {
            // Late funding: the verdict was public before this money arrived, so it goes back to the claimant.
            _credit(id, d, credited, 0);
        } else {
            if (d.firstFundedAt == 0) d.firstFundedAt = uint64(block.timestamp);
            d.lastFundedAt = uint64(block.timestamp);
            d.pot += credited;
        }
    }

    /// @notice Settle a funded dispute by its verdict. Anyone may call.
    function resolve(bytes32 id) external {
        Dispute storage d = disputes[id];
        if (d.openedAt == 0) revert UnknownDispute();
        if (d.resolved) revert AlreadyResolved();
        if (d.pot == 0) revert NotFunded();
        (bool counts, uint8 score, bytes32 responseHash) = _verdict(id, d);
        if (!counts) {
            if (!registry.isValidated(id)) revert NoVerdict();
            revert VerdictPredatesFunding();
        }
        d.resolved = true;
        d.score = score;
        emit Resolved(id, score, responseHash);
        uint256 pot = d.pot;
        d.pot = 0;
        uint256 toRespondent = (pot * score) / 100;
        _credit(id, d, pot - toRespondent, toRespondent);
    }

    /// @notice Credit the whole pot back to the claimant when no counting verdict exists
    ///         `RECLAIM_DELAY` after the last funding. Anyone may call.
    function reclaim(bytes32 id) external {
        Dispute storage d = disputes[id];
        if (d.openedAt == 0) revert UnknownDispute();
        if (d.resolved) revert AlreadyResolved();
        if (d.pot == 0) revert NotFunded();
        if (block.timestamp < uint256(d.lastFundedAt) + RECLAIM_DELAY) revert TooEarly();
        (bool counts, , ) = _verdict(id, d);
        if (counts) revert VerdictExists();
        d.resolved = true;
        d.reclaimed = true;
        uint256 pot = d.pot;
        d.pot = 0;
        emit Reclaimed(id, pot);
        _credit(id, d, pot, 0);
    }

    /// @notice Withdraw everything credited to the caller.
    function withdraw() external returns (uint256 amount) {
        amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        emit Withdrawn(msg.sender, amount);
        if (!usdc.transfer(msg.sender, amount)) revert TransferFailed();
    }

    /// @notice What `resolve` would credit right now. `ready` is false while the dispute is
    ///         unfunded, settled, or has no verdict recorded after its first funding.
    function preview(bytes32 id) external view returns (bool ready, uint8 score, uint256 toClaimant, uint256 toRespondent) {
        Dispute storage d = disputes[id];
        if (d.openedAt == 0 || d.resolved || d.pot == 0) return (false, 0, 0, 0);
        bool counts;
        (counts, score, ) = _verdict(id, d);
        if (!counts) return (false, 0, 0, 0);
        toRespondent = (d.pot * score) / 100;
        toClaimant = d.pot - toRespondent;
        ready = true;
    }

    /// @notice When `reclaim` becomes possible (0 while unfunded or settled).
    function reclaimableAt(bytes32 id) external view returns (uint256) {
        Dispute storage d = disputes[id];
        if (d.resolved || d.pot == 0) return 0;
        return uint256(d.lastFundedAt) + RECLAIM_DELAY;
    }

    /// @dev A verdict counts if it exists and was recorded strictly after the first funding.
    ///      Once answered, the registry's `lastUpdate` is the response time.
    function _verdict(bytes32 id, Dispute storage d) private view returns (bool counts, uint8 score, bytes32 responseHash) {
        if (d.firstFundedAt == 0 || !registry.isValidated(id)) return (false, 0, bytes32(0));
        uint256 respondedAt;
        (, , score, responseHash, , respondedAt) = registry.getValidationStatus(id);
        if (score > 100) revert BadScore();
        counts = respondedAt > d.firstFundedAt;
    }

    function _credit(bytes32 id, Dispute storage d, uint256 toClaimant, uint256 toRespondent) private {
        owed[d.claimant] += toClaimant;
        owed[d.respondent] += toRespondent;
        totalOwed += toClaimant + toRespondent;
        emit Paid(id, d.claimant, toClaimant, d.respondent, toRespondent);
    }

    function _b32(bytes calldata m, uint256 off) private pure returns (bytes32 v) {
        v = bytes32(m[off:off + 32]);
    }

    function _u32(bytes calldata m, uint256 off) private pure returns (uint32 v) {
        v = uint32(bytes4(m[off:off + 4]));
    }
}
