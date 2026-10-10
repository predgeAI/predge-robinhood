// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  PredgeCctpDisputeEscrow
/// @notice A dispute raised on this chain, settled with USDC that arrives from another chain
///         over Circle CCTP V2.
///
///         Flow (first route: Base -> Arbitrum One):
///           1. Arbitrum  `openDispute(requestHash, respondent, requestURI)`. The caller is the
///              claimant. The escrow files the matching ERC-8004 validation request in
///              PredgeAgentValidator, so the verdict can only be written after the dispute exists.
///           2. Base      `TokenMessengerV2.depositForBurnWithHook(amount, 3, mintRecipient = this,
///              USDC, destinationCaller = this, maxFee, minFinalityThreshold, hookData = requestHash)`.
///           3. Circle    attestation from the Iris API.
///           4. Arbitrum  `fund(message, attestation)`. The escrow itself calls
///              `MessageTransmitterV2.receiveMessage`, so the mint and the credit to the dispute
///              happen in one transaction; `destinationCaller = this` means nobody else can relay it.
///           5. Arbitrum  the validator records the verdict in PredgeAgentValidator
///              (`validationResponse(requestHash, score, ...)`).
///           6. Arbitrum  `resolve(requestHash)`, callable by anyone. The pot is split by the
///              recorded score: `score`% to the respondent, the rest to the claimant. Score 0 is a
///              full refund to the claimant, 100 pays the respondent in full.
///
///         USDC that reaches the escrow any other way (a plain transfer, or a burn that names the
///         escrow as mintRecipient without naming it as destinationCaller and is relayed by
///         someone else) is never credited to a dispute and has no withdrawal path. The relay
///         script always sets both fields.
///
/// @dev    No owner and no admin path. Trust assumptions: the verdict comes from whoever holds the
///         validator seat in PredgeAgentValidator, and that contract's owner can move the seat.
///         Funding after resolution is paid out immediately at the recorded score, so a late
///         CCTP message never strands USDC.
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

    struct Dispute {
        address claimant; // opened the dispute; receives (100 - score)% of the pot
        address respondent; // receives score% of the pot
        uint64 openedAt;
        bool resolved;
        uint8 score; // the verdict the pot was split by (valid once resolved)
        uint256 pot; // USDC credited and not yet paid out
        uint256 totalFunded; // USDC ever credited to this dispute over CCTP
    }

    IERC20Minimal public immutable usdc;
    IMessageTransmitterV2 public immutable transmitter;
    IValidationRegistry public immutable registry;
    bytes32 public immutable tokenMessenger; // TokenMessengerV2, same address on source and destination
    uint32 public immutable sourceDomain; // 6 = Base
    uint32 public immutable localDomain; // 3 = Arbitrum One

    mapping(bytes32 => Dispute) public disputes;

    event DisputeOpened(bytes32 indexed requestHash, address indexed claimant, address indexed respondent, string requestURI);
    event Funded(
        bytes32 indexed requestHash,
        bytes32 indexed cctpNonce,
        uint32 sourceDomain,
        address sourceSender,
        uint256 burned,
        uint256 feeExecuted,
        uint256 credited
    );
    event Resolved(bytes32 indexed requestHash, uint8 score, bytes32 responseHash);
    event Paid(bytes32 indexed requestHash, address indexed claimant, uint256 toClaimant, address indexed respondent, uint256 toRespondent);

    error ZeroAddress();
    error ZeroHash();
    error DisputeExists();
    error UnknownDispute();
    error AlreadyResolved();
    error NoVerdict();
    error BadMessage();
    error WrongSourceDomain();
    error WrongDestinationDomain();
    error WrongSender();
    error WrongDestinationCaller();
    error WrongMintRecipient();
    error BadHookData();
    error ReceiveFailed();
    error NothingMinted();
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

    /// @notice Raise a dispute on this chain. The caller is the claimant.
    /// @dev    Also files the ERC-8004 validation request for `requestHash`, so a verdict for it
    ///         cannot predate the dispute. Reverts if that request already exists in the registry.
    function openDispute(bytes32 requestHash, address respondent, string calldata requestURI) external {
        if (requestHash == bytes32(0)) revert ZeroHash();
        if (respondent == address(0)) revert ZeroAddress();
        Dispute storage d = disputes[requestHash];
        if (d.openedAt != 0) revert DisputeExists();
        d.claimant = msg.sender;
        d.respondent = respondent;
        d.openedAt = uint64(block.timestamp);
        registry.validationRequest(registry.validator(), 0, requestURI, requestHash);
        emit DisputeOpened(requestHash, msg.sender, respondent, requestURI);
    }

    /// @notice Relay a CCTP V2 burn from the source chain and credit the minted USDC to the
    ///         dispute named in its hook data. Anyone may call; the message decides everything.
    function fund(bytes calldata message, bytes calldata attestation) external returns (uint256 credited) {
        if (message.length < HEADER_LEN + B_HOOK_DATA) revert BadMessage();
        if (_u32(message, H_SOURCE_DOMAIN) != sourceDomain) revert WrongSourceDomain();
        if (_u32(message, H_DEST_DOMAIN) != localDomain) revert WrongDestinationDomain();
        if (_b32(message, H_SENDER) != tokenMessenger || _b32(message, H_RECIPIENT) != tokenMessenger) revert WrongSender();
        bytes32 self = bytes32(uint256(uint160(address(this))));
        if (_b32(message, H_DEST_CALLER) != self) revert WrongDestinationCaller();
        if (_b32(message, HEADER_LEN + B_MINT_RECIPIENT) != self) revert WrongMintRecipient();
        if (message.length != HEADER_LEN + B_HOOK_DATA + 32) revert BadHookData();
        bytes32 requestHash = _b32(message, HEADER_LEN + B_HOOK_DATA);

        Dispute storage d = disputes[requestHash];
        if (d.openedAt == 0) revert UnknownDispute();

        uint256 before = usdc.balanceOf(address(this));
        if (!transmitter.receiveMessage(message, attestation)) revert ReceiveFailed();
        credited = usdc.balanceOf(address(this)) - before;
        if (credited == 0) revert NothingMinted();

        d.pot += credited;
        d.totalFunded += credited;
        emit Funded(
            requestHash,
            _b32(message, H_NONCE),
            sourceDomain,
            address(uint160(uint256(_b32(message, HEADER_LEN + B_MESSAGE_SENDER)))),
            uint256(_b32(message, HEADER_LEN + B_AMOUNT)),
            uint256(_b32(message, HEADER_LEN + B_FEE_EXECUTED)),
            credited
        );

        if (d.resolved) _payout(requestHash, d);
    }

    /// @notice Settle a dispute once its verdict is on-chain. Anyone may call.
    function resolve(bytes32 requestHash) external {
        Dispute storage d = disputes[requestHash];
        if (d.openedAt == 0) revert UnknownDispute();
        if (d.resolved) revert AlreadyResolved();
        if (!registry.isValidated(requestHash)) revert NoVerdict();
        (, , uint8 score, bytes32 responseHash, , ) = registry.getValidationStatus(requestHash);
        d.resolved = true;
        d.score = score; // the registry caps responses at 100
        emit Resolved(requestHash, score, responseHash);
        _payout(requestHash, d);
    }

    /// @notice What `resolve` would pay right now, given the current pot and verdict.
    function preview(bytes32 requestHash) external view returns (bool ready, uint8 score, uint256 toClaimant, uint256 toRespondent) {
        Dispute storage d = disputes[requestHash];
        if (d.openedAt == 0) return (false, 0, 0, 0);
        if (d.resolved) {
            score = d.score;
        } else {
            if (!registry.isValidated(requestHash)) return (false, 0, 0, 0);
            (, , score, , , ) = registry.getValidationStatus(requestHash);
        }
        toRespondent = (d.pot * score) / 100;
        toClaimant = d.pot - toRespondent;
        ready = true;
    }

    function _payout(bytes32 requestHash, Dispute storage d) internal {
        uint256 pot = d.pot;
        if (pot == 0) return;
        uint256 toRespondent = (pot * d.score) / 100;
        uint256 toClaimant = pot - toRespondent;
        d.pot = 0; // effects before interactions
        emit Paid(requestHash, d.claimant, toClaimant, d.respondent, toRespondent);
        if (toClaimant != 0 && !usdc.transfer(d.claimant, toClaimant)) revert TransferFailed();
        if (toRespondent != 0 && !usdc.transfer(d.respondent, toRespondent)) revert TransferFailed();
    }

    function _b32(bytes calldata m, uint256 off) private pure returns (bytes32 v) {
        v = bytes32(m[off:off + 32]);
    }

    function _u32(bytes calldata m, uint256 off) private pure returns (uint32 v) {
        v = uint32(bytes4(m[off:off + 4]));
    }
}
