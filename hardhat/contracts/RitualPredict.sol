// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RitualChain, IScheduler, IRitualWallet, ITEEServiceRegistry} from "./ritual/RitualChain.sol";
import {PositionToken} from "./PositionToken.sol";

/**
 * RitualPredict — a self-resolving binary prediction market.
 *
 * Users stake native RITUAL on YES or NO. When the betting window closes, nobody
 * clicks "resolve" and no backend cron runs: the Ritual Scheduler wakes the contract
 * at a block chosen at market-creation time. The contract then calls the HTTP
 * precompile (0x0801) to read the configured oracle URL, extracts one number with the
 * jq precompile (0x0803), compares it to the target, and settles the market.
 *
 * Payouts are pari-mutuel and pull-based: each winner claims
 * `stake * totalPool / winningPool`. Nothing loops over participants.
 *
 * Every deadline is a BLOCK NUMBER, so "betting is closed" and "the Scheduler woke us"
 * can never disagree. Human durations are converted at `blockTimeMs`, measured from the
 * live chain at deploy time (`scripts/block-time.ts`).
 */
contract RitualPredict is PositionToken {
    // ─────────────────────────────── Types ───────────────────────────────

    enum MarketState {
        Open, // accepting bets
        Closed, // betting window over, waiting for the scheduled wake-up
        Resolving, // a resolution attempt has run and failed; retries pending
        Resolved, // outcome final, winners can claim once the window passes
        Invalid, // could not be resolved (or nobody won); everyone refunds
        Disputed // a bonded challenger forced a second reading
    }

    enum Comparator {
        GT, // observed >  target
        GTE, // observed >= target
        LT, // observed <  target
        LTE // observed <= target
    }

    enum Outcome {
        Unresolved,
        Yes,
        No
    }

    /// One place to read a number from. A market carries several.
    struct Oracle {
        string url;
        string jsonPath;
    }

    /// Storage layout *and* the shape returned by `getMarket` / `getMarkets`.
    struct Market {
        uint256 id;
        address creator;
        string question;
        // ── resolution rule: fixed at creation, no setter exists ──
        Oracle[] oracles;
        /// Successful readings needed before the market may settle.
        uint8 quorum;
        uint256 target;
        Comparator comparator;
        /// Creator's cut of the pool, in basis points. Charged only on a market
        /// that resolves; a refunded market hands back whole stakes.
        uint16 feeBps;
        bool feeClaimed;
        uint64 closeBlock;
        uint64 resolveBlock;
        uint256 scheduleId;
        // ── mutable state ──
        uint256 totalYes;
        uint256 totalNo;
        MarketState state;
        Outcome outcome;
        uint8 attempts;
        /// The source being read now, and how many attempts it has already cost.
        /// A source that keeps failing is abandoned rather than retried forever.
        uint8 cursor;
        uint8 cursorAttempts;
        /// Every reading gathered so far, in the order the sources answered.
        uint256[] readings;
        /// The median of `readings` once the market settled.
        uint256 observedValue;
        string invalidReason;
        // ── dispute ──
        /// Claims open at this block. Set when the market first resolves.
        uint64 disputeUntil;
        address challenger;
        uint256 bond;
        /// The outcome the challenger is arguing against.
        Outcome disputedOutcome;
        /// A forfeited bond, added to what the winners share.
        uint256 bounty;
        bool bondRefundable;
        bool bondClaimed;
    }

    /// A stake, as an object that can change hands. One per bet.
    struct Position {
        uint256 marketId;
        bool isYes;
        uint256 amount;
    }

    /// Arguments to `createMarket`, grouped so the whole rule reads as one unit at the
    /// call site (and to keep the stack shallow).
    struct NewMarket {
        string question;
        Oracle[] oracles;
        uint8 quorum;
        uint256 target;
        Comparator comparator;
        uint16 feeBps;
        uint256 bettingSeconds;
        uint256 resolveDelaySeconds;
    }

    // ────────────────────────────── Constants ────────────────────────────

    /// Sources one market may consult. The Scheduler books
    /// `oracles * MAX_ATTEMPTS` executions, and `frequency * numCalls` has to stay
    /// under its MAX_LIFESPAN of 10,000.
    uint256 public constant MAX_ORACLES = 5;

    /// Resolution attempts per oracle, booked up front as part of the Scheduler's
    /// `numCalls`,
    /// `RETRY_INTERVAL_BLOCKS` apart. `frequency * numCalls` must stay under the
    /// Scheduler's MAX_LIFESPAN of 10,000.
    uint32 public constant MAX_ATTEMPTS = 3;
    uint32 public constant RETRY_INTERVAL_BLOCKS = 200;

    /// Gas per scheduled execution — one HTTP call, one jq call, a few storage writes.
    uint32 public constant RESOLVE_GAS_LIMIT = 2_000_000;

    /// Scheduler TTL. Must cover trigger drift *and* async HTTP settlement, because the
    /// settlement replay re-runs Scheduler.execute() and re-checks the TTL.
    uint32 public constant SCHEDULER_TTL_BLOCKS = 150;

    /// Blocks the TEE executor has to fulfil the HTTP request.
    uint256 public constant HTTP_TTL_BLOCKS = 100;

    /// Registry slots to probe when picking a TEE executor.
    uint256 public constant EXECUTOR_PROBES = 8;

    /// Floor for the fee authorised per scheduled execution.
    uint256 public constant MIN_MAX_FEE_PER_GAS = 1 gwei;

    /// Ceiling on the creator's cut. 5% of the pool, and the only number in the
    /// contract a market creator could otherwise have set against their bettors.
    uint16 public constant MAX_FEE_BPS = 500;

    /// How long a resolved market can be challenged before claims open.
    uint64 public constant DISPUTE_WINDOW_BLOCKS = 300;

    /// What a challenge costs: a share of the pool, with a floor so a tiny
    /// market is not free to attack.
    uint16 public constant DISPUTE_BOND_BPS = 100;
    uint256 public constant MIN_DISPUTE_BOND = 0.001 ether;

    uint256 public constant MIN_BETTING_SECONDS = 30;
    uint256 public constant MIN_RESOLVE_DELAY_SECONDS = 15;
    uint256 public constant MAX_MARKET_SECONDS = 1 days;

    // ────────────────────────────── Storage ──────────────────────────────

    /// Assumed block time, used only to turn human durations into block counts.
    /// Ritual Chain ran ~195ms when this was written.
    uint256 public immutable blockTimeMs;

    uint256 public marketCount;
    mapping(uint256 => Market) private _markets;

    mapping(uint256 => mapping(address => uint256)) public yesStake;
    mapping(uint256 => mapping(address => uint256)) public noStake;
    mapping(uint256 => mapping(address => bool)) public settled;

    /// What each position token stands for.
    mapping(uint256 => Position) public positions;

    // ────────────────────────────── Events ───────────────────────────────

    event MarketCreated(
        uint256 indexed marketId,
        address indexed creator,
        string question,
        uint64 closeBlock,
        uint64 resolveBlock,
        uint256 scheduleId
    );
    /// The resolution rule, emitted separately from MarketCreated. None of these values
    /// can change afterwards — there is no setter.
    event ResolutionRuleSet(
        uint256 indexed marketId,
        uint256 target,
        Comparator comparator,
        uint8 quorum,
        uint256 oracleCount
    );
    /// One per source, so a reader can reconstruct the rule from logs alone.
    event OracleSource(
        uint256 indexed marketId,
        uint256 indexed index,
        string url,
        string jsonPath
    );
    /// A source answered. Emitted before the market has enough to settle.
    event ReadingGathered(
        uint256 indexed marketId,
        uint256 indexed index,
        uint256 value
    );
    event BetPlaced(
        uint256 indexed marketId,
        address indexed bettor,
        bool isYes,
        uint256 amount
    );
    /// The token that stands for the bet just placed.
    event PositionOpened(
        uint256 indexed marketId,
        uint256 indexed tokenId,
        address indexed owner,
        bool isYes,
        uint256 amount
    );
    event ResolutionAttempted(
        uint256 indexed marketId,
        uint8 attempt,
        address executor
    );
    event ResolutionFailed(
        uint256 indexed marketId,
        uint8 attempt,
        string reason
    );
    event MarketResolved(
        uint256 indexed marketId,
        Outcome outcome,
        uint256 observedValue
    );
    event MarketInvalidated(uint256 indexed marketId, string reason);
    event FeeClaimed(
        uint256 indexed marketId,
        address indexed creator,
        uint256 amount
    );
    event MarketDisputed(
        uint256 indexed marketId,
        address indexed challenger,
        Outcome disputedOutcome,
        uint256 bond
    );
    event DisputeSettled(
        uint256 indexed marketId,
        bool challengerWasRight,
        Outcome outcome
    );
    event BondReturned(
        uint256 indexed marketId,
        address indexed challenger,
        uint256 amount
    );
    event WinningsClaimed(
        uint256 indexed marketId,
        address indexed claimant,
        uint256 amount
    );
    event StakeRefunded(
        uint256 indexed marketId,
        address indexed claimant,
        uint256 amount
    );

    // ────────────────────────────── Errors ───────────────────────────────

    error UnknownMarket();
    error OnlyScheduler();
    error BettingClosed();
    error ZeroStake();
    error NotResolved();
    error NotInvalid();
    error NothingToClaim();
    error AlreadySettled();
    error BadDuration();
    error EmptyString();
    error TransferFailed();
    error BadOracleSet();
    error BadFee();
    error StillDisputable();
    error AlreadyDisputed();
    error DisputeWindowClosed();
    error BondTooSmall();

    constructor(uint256 blockTimeMs_) {
        if (blockTimeMs_ == 0) revert BadDuration();
        blockTimeMs = blockTimeMs_;

        // Let the Scheduler call back into this contract and draw execution fees from
        // this contract's RitualWallet balance.
        IScheduler(RitualChain.SCHEDULER).approveScheduler(
            RitualChain.SCHEDULER
        );
    }

    // ───────────────────────── Market lifecycle ──────────────────────────

    /**
     * Create a market and, in the same transaction, book its own resolution with the
     * Scheduler: `MAX_ATTEMPTS` executions starting at `resolveBlock`.
     */
    function createMarket(
        NewMarket calldata p
    ) external returns (uint256 marketId) {
        if (bytes(p.question).length == 0) revert EmptyString();

        uint256 sources = p.oracles.length;
        if (sources == 0 || sources > MAX_ORACLES) revert BadOracleSet();
        if (p.quorum == 0 || p.quorum > sources) revert BadOracleSet();
        if (p.feeBps > MAX_FEE_BPS) revert BadFee();
        for (uint256 i = 0; i < sources; i++) {
            if (bytes(p.oracles[i].url).length == 0) revert EmptyString();
            if (bytes(p.oracles[i].jsonPath).length == 0) revert EmptyString();
        }

        if (p.bettingSeconds < MIN_BETTING_SECONDS) revert BadDuration();
        if (p.resolveDelaySeconds < MIN_RESOLVE_DELAY_SECONDS)
            revert BadDuration();
        if (p.bettingSeconds + p.resolveDelaySeconds > MAX_MARKET_SECONDS)
            revert BadDuration();

        // Both deadlines are blocks from here on; seconds never reach storage.
        uint64 closeBlock = uint64(
            block.number + _secondsToBlocks(p.bettingSeconds)
        );
        uint64 resolveBlock = closeBlock +
            uint64(_secondsToBlocks(p.resolveDelaySeconds));

        marketId = ++marketCount;

        Market storage m = _markets[marketId];
        m.id = marketId;
        m.creator = msg.sender;
        m.question = p.question;
        for (uint256 i = 0; i < sources; i++) m.oracles.push(p.oracles[i]);
        m.quorum = p.quorum;
        m.target = p.target;
        m.comparator = p.comparator;
        m.feeBps = p.feeBps;
        m.closeBlock = closeBlock;
        m.resolveBlock = resolveBlock;
        // state stays Open, outcome stays Unresolved, attempts stays 0.

        // Booking resolution here is the whole point: after this transaction the
        // market needs nobody's attention to settle.
        // Each source gets its own attempts: one short-running async call is
        // allowed per transaction, so several sources cannot share one execution.
        uint32 executionBudget = uint32(sources) * MAX_ATTEMPTS;
        uint256 scheduleId = _scheduleResolution(
            marketId,
            resolveBlock,
            executionBudget
        );
        m.scheduleId = scheduleId;

        emit MarketCreated(
            marketId,
            msg.sender,
            p.question,
            closeBlock,
            resolveBlock,
            scheduleId
        );
        emit ResolutionRuleSet(
            marketId,
            p.target,
            p.comparator,
            p.quorum,
            sources
        );
        for (uint256 i = 0; i < sources; i++)
            emit OracleSource(
                marketId,
                i,
                p.oracles[i].url,
                p.oracles[i].jsonPath
            );
    }

    function bet(uint256 marketId, bool isYes) external payable {
        Market storage m = _market(marketId);
        if (msg.value == 0) revert ZeroStake();
        if (m.state != MarketState.Open || block.number >= m.closeBlock)
            revert BettingClosed();

        if (isYes) {
            yesStake[marketId][msg.sender] += msg.value;
            m.totalYes += msg.value;
        } else {
            noStake[marketId][msg.sender] += msg.value;
            m.totalNo += msg.value;
        }

        uint256 tokenId = _mintPosition(msg.sender);
        positions[tokenId] = Position(marketId, isYes, msg.value);

        emit BetPlaced(marketId, msg.sender, isYes, msg.value);
        emit PositionOpened(marketId, tokenId, msg.sender, isYes, msg.value);
    }

    /**
     * A position changing hands moves the stake with it, so every view and every
     * payout keeps working off the same per-account totals as before.
     *
     * The one refusal: an account that has already claimed has been paid for all
     * of its stake, so its tokens are spent. Letting one move would pay the same
     * stake twice.
     */
    function _beforePositionTransfer(
        uint256 tokenId,
        address from,
        address to
    ) internal override {
        Position memory p = positions[tokenId];
        if (settled[p.marketId][from]) revert AlreadySettled();

        if (p.isYes) {
            yesStake[p.marketId][from] -= p.amount;
            yesStake[p.marketId][to] += p.amount;
        } else {
            noStake[p.marketId][from] -= p.amount;
            noStake[p.marketId][to] += p.amount;
        }
    }

    /**
     * Scheduler callback. `executionIndex` is written into calldata bytes 4-35 by the
     * Scheduler, so it must be the first parameter.
     *
     * Deliberately revert-free for anything that is not an authorisation failure: a
     * reverted execution would roll back the attempt counter, and the market could then
     * never reach `Invalid`.
     */
    function onScheduledResolve(
        uint256 executionIndex,
        uint256 marketId
    ) external {
        if (msg.sender != RitualChain.SCHEDULER) revert OnlyScheduler();

        Market storage m = _markets[marketId];
        // Everything below returns instead of reverting. A revert would undo the
        // attempt counter and the market could never exhaust its attempts.
        if (m.closeBlock == 0) return; // unknown market
        if (m.state == MarketState.Resolved || m.state == MarketState.Invalid)
            return; // already final; a leftover execution is harmless
        if (block.number < m.closeBlock) return; // woken before betting closed

        uint8 attempt = m.attempts + 1;
        m.attempts = attempt;
        m.state = MarketState.Resolving;

        address executor = _pickExecutor(marketId, executionIndex);
        emit ResolutionAttempted(marketId, attempt, executor);
        if (executor == address(0)) {
            _fail(m, marketId, attempt, "no TEE executor available");
            return;
        }

        // The next source in line. One short-running async call is allowed per
        // transaction, so a quorum is gathered across executions, not within one.
        uint256 source = m.cursor;
        (bool ok, uint256 reading, string memory reason) = _readOracle(
            m,
            source,
            executor
        );
        if (!ok) {
            _fail(m, marketId, attempt, reason);
            return;
        }

        m.readings.push(reading);
        m.cursor += 1;
        m.cursorAttempts = 0;
        emit ReadingGathered(marketId, source, reading);

        if (m.readings.length < m.quorum) {
            // Not enough sources have answered yet. If none are left, the market
            // cannot settle honestly, so it refunds instead of guessing.
            if (m.cursor >= m.oracles.length)
                _invalidate(m, marketId, "quorum not reached");
            return;
        }

        uint256 observed = _median(m.readings);
        m.observedValue = observed;
        Outcome outcome = _compare(observed, m.target, m.comparator)
            ? Outcome.Yes
            : Outcome.No;
        m.outcome = outcome;

        uint256 winningPool = outcome == Outcome.Yes ? m.totalYes : m.totalNo;
        if (winningPool == 0) {
            // Pari-mutuel has no denominator when nobody backed the winning
            // answer. The read stands; the money goes back.
            _invalidate(m, marketId, "nobody backed the winning side");
        } else {
            m.state = MarketState.Resolved;
            emit MarketResolved(marketId, outcome, observed);

            if (m.disputedOutcome == Outcome.Unresolved) {
                // First reading. Nobody may claim until the window closes.
                m.disputeUntil = uint64(block.number) + DISPUTE_WINDOW_BLOCKS;
            } else {
                // A second reading, paid for by a challenger.
                bool challengerWasRight = outcome != m.disputedOutcome;
                if (challengerWasRight) m.bondRefundable = true;
                else m.bounty = m.bond;
                // One challenge per market: claims open immediately.
                m.disputeUntil = uint64(block.number);
                emit DisputeSettled(marketId, challengerWasRight, outcome);
            }
        }

        // The outcome is final either way, so stop paying for the retries.
        try IScheduler(RitualChain.SCHEDULER).cancel(m.scheduleId) {} catch {}
    }

    /// A failed oracle read is never interpreted as NO. The source is retried
    /// until its own attempts run out, then the market moves on to the next one.
    /// Only when the sources are exhausted does the market become refundable.
    function _fail(
        Market storage m,
        uint256 marketId,
        uint8 attempt,
        string memory reason
    ) private {
        emit ResolutionFailed(marketId, attempt, reason);

        m.cursorAttempts += 1;
        if (m.cursorAttempts >= MAX_ATTEMPTS) {
            m.cursor += 1;
            m.cursorAttempts = 0;
        }
        if (m.cursor >= m.oracles.length) _invalidate(m, marketId, reason);
    }

    function _invalidate(
        Market storage m,
        uint256 marketId,
        string memory reason
    ) private {
        // A challenger who asked a question the oracles could not answer was not
        // wrong; they get their bond back.
        if (m.challenger != address(0)) m.bondRefundable = true;
        m.state = MarketState.Invalid;
        m.invalidReason = reason;
        emit MarketInvalidated(marketId, reason);
    }

    // ────────────────────────────── Payouts ──────────────────────────────

    // ────────────────────────────── Dispute ─────────────────────────────

    /// What it costs to challenge this market's reading.
    function disputeBond(uint256 marketId) public view returns (uint256) {
        Market storage m = _market(marketId);
        uint256 share = ((m.totalYes + m.totalNo) * DISPUTE_BOND_BPS) / 10_000;
        return share < MIN_DISPUTE_BOND ? MIN_DISPUTE_BOND : share;
    }

    /**
     * Buy a second reading.
     *
     * The oracles are consulted again from scratch. If the answer changes, the
     * challenger was right and takes their bond back. If it does not, the bond
     * joins the pool and the winners share it. Either way the market settles on
     * the second reading, and there is no third: one challenge per market.
     */
    function dispute(uint256 marketId) external payable {
        Market storage m = _market(marketId);
        if (m.state != MarketState.Resolved) revert NotResolved();
        if (m.challenger != address(0)) revert AlreadyDisputed();
        if (block.number >= m.disputeUntil) revert DisputeWindowClosed();
        if (msg.value < disputeBond(marketId)) revert BondTooSmall();

        m.challenger = msg.sender;
        m.bond = msg.value;
        m.disputedOutcome = m.outcome;
        m.outcome = Outcome.Unresolved;
        m.state = MarketState.Disputed;

        // Ask again from the first source, with a fresh budget.
        delete m.readings;
        m.cursor = 0;
        m.cursorAttempts = 0;
        m.scheduleId = _scheduleResolution(
            marketId,
            uint64(block.number) + 1,
            uint32(m.oracles.length) * MAX_ATTEMPTS
        );

        emit MarketDisputed(marketId, msg.sender, m.disputedOutcome, msg.value);
    }

    /// Return a bond to a challenger the second reading vindicated.
    function claimBond(uint256 marketId) external {
        Market storage m = _market(marketId);
        if (!m.bondRefundable) revert NothingToClaim();
        if (m.bondClaimed) revert AlreadySettled();

        m.bondClaimed = true;
        emit BondReturned(marketId, m.challenger, m.bond);
        _pay(m.challenger, m.bond);
    }

    // ────────────────────────────── Payouts ──────────────────────────────

    /// Pull-based, proportional share of the whole pool. No loops over participants.
    function claimWinnings(uint256 marketId) external {
        Market storage m = _market(marketId);
        if (m.state != MarketState.Resolved) revert NotResolved();
        if (block.number < m.disputeUntil) revert StillDisputable();
        if (settled[marketId][msg.sender]) revert AlreadySettled();

        uint256 payout = _payout(m, marketId, msg.sender);
        if (payout == 0) revert NothingToClaim();

        settled[marketId][msg.sender] = true;
        emit WinningsClaimed(marketId, msg.sender, payout);
        _pay(msg.sender, payout);
    }

    /// Reclaim the original stake from an invalid market.
    function claimRefund(uint256 marketId) external {
        Market storage m = _market(marketId);
        if (m.state != MarketState.Invalid) revert NotInvalid();
        if (settled[marketId][msg.sender]) revert AlreadySettled();

        uint256 amount = yesStake[marketId][msg.sender] +
            noStake[marketId][msg.sender];
        if (amount == 0) revert NothingToClaim();

        settled[marketId][msg.sender] = true;
        emit StakeRefunded(marketId, msg.sender, amount);
        _pay(msg.sender, amount);
    }

    /// The creator's cut of a resolved market's pool. Zero for a market that
    /// refunds: a stake that comes back comes back whole.
    function feeOf(uint256 marketId) public view returns (uint256) {
        Market storage m = _market(marketId);
        if (m.state != MarketState.Resolved) return 0;
        return ((m.totalYes + m.totalNo) * m.feeBps) / 10_000;
    }

    /// Pay the creator their cut. Pull-based like everything else here, and
    /// available only once the market has actually resolved.
    function claimFee(uint256 marketId) external {
        Market storage m = _market(marketId);
        if (m.state != MarketState.Resolved) revert NotResolved();
        if (block.number < m.disputeUntil) revert StillDisputable();
        if (m.feeClaimed) revert AlreadySettled();

        uint256 amount = feeOf(marketId);
        if (amount == 0) revert NothingToClaim();

        m.feeClaimed = true;
        emit FeeClaimed(marketId, m.creator, amount);
        _pay(m.creator, amount);
    }

    /// `stake * distributable / winningPool`, or 0 if this account backed the
    /// losing side. `distributable` is the pool after the creator's cut.
    function _payout(
        Market storage m,
        uint256 marketId,
        address account
    ) private view returns (uint256) {
        bool yesWon = m.outcome == Outcome.Yes;
        uint256 stake = yesWon
            ? yesStake[marketId][account]
            : noStake[marketId][account];
        uint256 winningPool = yesWon ? m.totalYes : m.totalNo;
        if (stake == 0 || winningPool == 0) return 0;

        uint256 pool = m.totalYes + m.totalNo;
        uint256 distributable = pool - (pool * m.feeBps) / 10_000 + m.bounty;
        return (stake * distributable) / winningPool;
    }

    // ─────────────────────────────── Views ───────────────────────────────

    function getMarket(uint256 marketId) public view returns (Market memory m) {
        m = _markets[marketId];
        if (m.closeBlock == 0) revert UnknownMarket();
        // No transaction exists to flip Open → Closed, so the view does it.
        if (m.state == MarketState.Open && block.number >= m.closeBlock)
            m.state = MarketState.Closed;
    }

    /// Every market, newest first. A workshop has a handful; there is no pagination.
    function getMarkets() external view returns (Market[] memory all) {
        uint256 total = marketCount;
        all = new Market[](total);
        for (uint256 i = 0; i < total; i++) {
            all[i] = getMarket(total - i);
        }
    }

    function stakesOf(
        uint256 marketId,
        address account
    )
        external
        view
        returns (
            uint256 yes,
            uint256 no,
            bool alreadySettled,
            uint256 claimable
        )
    {
        Market storage m = _market(marketId);
        (yes, no, alreadySettled) = (
            yesStake[marketId][account],
            noStake[marketId][account],
            settled[marketId][account]
        );
        if (alreadySettled) return (yes, no, true, 0);

        if (m.state == MarketState.Resolved)
            claimable = _payout(m, marketId, account);
        else if (m.state == MarketState.Invalid) claimable = yes + no;
    }

    // ───────────────────────── Execution funding ─────────────────────────

    /// Prepay Scheduler + HTTP precompile fees. Anyone may top the contract up; the
    /// balance lives in RitualWallet under this contract's address, which is the
    /// `payer` of every scheduled execution.
    function fundExecution(uint256 lockDurationBlocks) external payable {
        if (msg.value == 0) revert ZeroStake();
        IRitualWallet(RitualChain.RITUAL_WALLET).deposit{value: msg.value}(
            lockDurationBlocks
        );
    }

    function executionBalance() external view returns (uint256) {
        return
            IRitualWallet(RitualChain.RITUAL_WALLET).balanceOf(address(this));
    }

    // ───────────────────── Ritual: oracle read path ──────────────────────

    /// HTTP (0x0801) → jq (0x0803), both inside this one scheduled transaction.
    function _readOracle(
        Market storage m,
        uint256 sourceIndex,
        address executor
    ) private returns (bool ok, uint256 value, string memory reason) {
        // 0x0801 takes 13 fields. Only the executor, the TTL, the URL and the
        // method carry anything here: no secrets, no headers, no body, no dKMS.
        bytes memory request = abi.encode(
            executor, //  0 executor
            new bytes[](0), //  1 encryptedSecrets
            HTTP_TTL_BLOCKS, //  2 ttl
            new bytes[](0), //  3 secretSignatures
            bytes(""), //  4 userPublicKey (empty = no output encryption)
            m.oracles[sourceIndex].url, //  5 url
            RitualChain.HTTP_GET, //  6 method
            new string[](0), //  7 headersKeys
            new string[](0), //  8 headersValues
            bytes(""), //  9 body
            uint256(0), // 10 dkmsKeyIndex
            uint8(0), // 11 dkmsKeyFormat
            false // 12 piiEnabled
        );

        // Not a staticcall: this is short-running async, and the executor's
        // response is injected into the replay of this same transaction.
        (bool called, bytes memory raw) = RitualChain.HTTP_PRECOMPILE.call(
            request
        );
        if (!called || raw.length == 0)
            return (false, 0, "http precompile call failed");

        try this.decodeHttpResponse(raw) returns (
            uint16 status,
            bytes memory body,
            string memory errorMessage
        ) {
            if (bytes(errorMessage).length != 0)
                return (false, 0, errorMessage);
            if (status != 200) return (false, 0, "oracle returned non-200");
            if (body.length == 0)
                return (false, 0, "oracle returned an empty body");

            (bool parsed, uint256 observed) = _jqUint(
                m.oracles[sourceIndex].jsonPath,
                string(body)
            );
            if (!parsed)
                return (false, 0, "jsonPath did not yield a number");

            return (true, observed, "");
        } catch {
            // Either the envelope is malformed, or the async output has not
            // settled yet. Both are a miss for this attempt, never a NO.
            return (false, 0, "http response undecodable or unsettled");
        }
    }

    /**
     * Unwraps the short-running async envelope `(bytes simmedInput, bytes actualOutput)`
     * and the 5-field HTTP response inside it.
     *
     * External so `_readOracle` can call it through `try`. Reverting on malformed input
     * is exactly the signal the caller wants.
     */
    function decodeHttpResponse(
        bytes calldata raw
    )
        external
        pure
        returns (uint16 status, bytes memory body, string memory errorMessage)
    {
        (, bytes memory actualOutput) = abi.decode(raw, (bytes, bytes));
        // Empty during simulation, before the executor has run.
        require(actualOutput.length > 0, "async output not settled");
        (status, , , body, errorMessage) = abi.decode(
            actualOutput,
            (uint16, string[], string[], bytes, string)
        );
    }

    /// jq is synchronous. A wrong outputType returns ok=true with zero-length output,
    /// so the length check is load-bearing.
    function _jqUint(
        string memory query,
        string memory json
    ) private view returns (bool, uint256) {
        (bool ok, bytes memory result) = RitualChain.JQ_PRECOMPILE.staticcall(
            abi.encode(query, json, RitualChain.JQ_OUT_UINT256)
        );
        if (!ok || result.length < 32) return (false, 0);
        return (true, abi.decode(result, (uint256)));
    }

    function _pickExecutor(
        uint256 marketId,
        uint256 executionIndex
    ) private view returns (address) {
        // executionIndex is in the seed so every retry probes a different slot:
        // one unhealthy executor must not be able to sink a market.
        uint256 seed = uint256(
            keccak256(
                abi.encodePacked(
                    marketId,
                    executionIndex,
                    block.number,
                    address(this)
                )
            )
        );

        // A reverting registry must not revert the execution, or the attempt
        // counter would roll back and the market could never reach Invalid.
        try
            ITEEServiceRegistry(RitualChain.TEE_SERVICE_REGISTRY)
                .pickServiceByCapability(
                    RitualChain.CAPABILITY_HTTP_CALL,
                    true,
                    seed,
                    EXECUTOR_PROBES
                )
        returns (address teeAddress, bool found) {
            return found ? teeAddress : address(0);
        } catch {
            return address(0);
        }
    }

    // ────────────────────── Ritual: scheduling ───────────────────────────

    function _scheduleResolution(
        uint256 marketId,
        uint64 resolveBlock,
        uint32 executionBudget
    ) private returns (uint256 callId) {
        // executionIndex is encoded as 0 on purpose: the Scheduler overwrites
        // calldata bytes 4-35 with the real index at execution time.
        bytes memory data = abi.encodeCall(
            this.onScheduledResolve,
            (0, marketId)
        );

        // The first attempt may be thousands of blocks away, so authorise room
        // above the current base fee rather than the base fee itself.
        uint256 maxFeePerGas = block.basefee * 2;
        if (maxFeePerGas < MIN_MAX_FEE_PER_GAS)
            maxFeePerGas = MIN_MAX_FEE_PER_GAS;

        callId = IScheduler(RitualChain.SCHEDULER).schedule(
            data,
            RESOLVE_GAS_LIMIT,
            uint32(resolveBlock),
            executionBudget,
            RETRY_INTERVAL_BLOCKS,
            SCHEDULER_TTL_BLOCKS,
            maxFeePerGas,
            MIN_MAX_FEE_PER_GAS,
            0, // no value forwarded with the callback
            address(this) // this contract's RitualWallet balance pays
        );
    }

    // ────────────────────────────── Helpers ──────────────────────────────

    function _market(uint256 marketId) private view returns (Market storage m) {
        m = _markets[marketId];
        if (m.closeBlock == 0) revert UnknownMarket();
    }

    function _compare(
        uint256 observed,
        uint256 target,
        Comparator comparator
    ) private pure returns (bool) {
        if (comparator == Comparator.GT) return observed > target;
        if (comparator == Comparator.GTE) return observed >= target;
        if (comparator == Comparator.LT) return observed < target;
        return observed <= target;
    }

    /**
     * The middle reading, by value. Nothing is averaged: an average invents a
     * number no source reported, and the market settles against a number that
     * some oracle actually returned. With an even count the upper middle wins.
     *
     * Sorts in place; `readings` is capped at MAX_ORACLES entries.
     */
    function _median(
        uint256[] memory readings
    ) private pure returns (uint256) {
        for (uint256 i = 1; i < readings.length; i++) {
            uint256 value = readings[i];
            uint256 j = i;
            while (j > 0 && readings[j - 1] > value) {
                readings[j] = readings[j - 1];
                j--;
            }
            readings[j] = value;
        }
        return readings[readings.length / 2];
    }

    function _secondsToBlocks(
        uint256 seconds_
    ) private view returns (uint256 blocks) {
        blocks = (seconds_ * 1000) / blockTimeMs;
        if (blocks == 0) blocks = 1;
    }

    function _pay(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// Scheduler gas refunds land in RitualWallet, but accept plain transfers anyway.
    receive() external payable {}
}
