// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Stands in for the Scheduler system contract on a local node.
 *
 * Two behaviours are reproduced because the contract under test depends on them:
 *
 *  - bytes 4-35 of the booked calldata are overwritten with the real execution
 *    index at execution time, so a callback cannot trust what it was booked with;
 *  - a callback that reverts does not revert the execution. The booking is still
 *    consumed. Anything that treats a revert as "nothing happened" is wrong.
 *
 * One behaviour is deliberately *not* reproduced: the real Scheduler will happily
 * run an execution with less gas than booked, and the 63/64 rule then starves the
 * callback while the execution itself still succeeds. That failure is silent and
 * costs hours to find, so `fire` refuses to run instead.
 */
contract LocalScheduler {
    struct Booking {
        address target;
        bytes data;
        uint32 gas;
        uint32 startBlock;
        uint32 numCalls;
        uint32 frequency;
        uint32 ttl;
        uint256 maxFeePerGas;
        uint256 maxPriorityFeePerGas;
        uint256 value;
        address payer;
        uint32 executed;
        bool cancelled;
    }

    uint256 public callCount;
    mapping(uint256 => Booking) private _bookings;
    mapping(address => mapping(address => bool)) public approved;

    event Scheduled(uint256 indexed callId, address indexed target);
    event Executed(uint256 indexed callId, uint256 executionIndex, bool ok);
    event Cancelled(uint256 indexed callId);

    function approveScheduler(address schedulerContract) external {
        approved[msg.sender][schedulerContract] = true;
    }

    function schedule(
        bytes calldata data,
        uint32 gas,
        uint32 startBlock,
        uint32 numCalls,
        uint32 frequency,
        uint32 ttl,
        uint256 maxFeePerGas,
        uint256 maxPriorityFeePerGas,
        uint256 value,
        address payer
    ) external returns (uint256 callId) {
        require(numCalls > 0, "numCalls must be positive");
        require(uint256(frequency) * numCalls <= 10_000, "exceeds MAX_LIFESPAN");

        callId = ++callCount;
        Booking storage b = _bookings[callId];
        b.target = msg.sender;
        b.data = data;
        b.gas = gas;
        b.startBlock = startBlock;
        b.numCalls = numCalls;
        b.frequency = frequency;
        b.ttl = ttl;
        b.maxFeePerGas = maxFeePerGas;
        b.maxPriorityFeePerGas = maxPriorityFeePerGas;
        b.value = value;
        b.payer = payer;

        emit Scheduled(callId, msg.sender);
    }

    function cancel(uint256 callId) external {
        Booking storage b = _bookings[callId];
        require(b.target == msg.sender, "not the booker");
        b.cancelled = true;
        emit Cancelled(callId);
    }

    /// 0 = unknown, 1 = pending, 2 = exhausted, 3 = cancelled.
    function getCallState(uint256 callId) external view returns (uint8) {
        Booking storage b = _bookings[callId];
        if (b.target == address(0)) return 0;
        if (b.cancelled) return 3;
        if (b.executed >= b.numCalls) return 2;
        return 1;
    }

    function getBooking(uint256 callId) external view returns (Booking memory) {
        return _bookings[callId];
    }

    /// Test hook: run the next execution of a booking.
    function fire(
        uint256 callId,
        uint256 executionIndex
    ) external returns (bool ok) {
        Booking storage b = _bookings[callId];
        require(b.target != address(0), "unknown callId");
        require(!b.cancelled, "booking cancelled");
        require(b.executed < b.numCalls, "no executions left");
        require(
            gasleft() > uint256(b.gas) + 60_000,
            "caller left less gas than the booking asked for"
        );

        bytes memory data = b.data;
        // Payload starts at data+32; bytes 4-35 therefore start at data+36.
        assembly {
            mstore(add(data, 36), executionIndex)
        }

        b.executed += 1;
        (ok, ) = b.target.call{gas: b.gas}(data);
        emit Executed(callId, executionIndex, ok);
    }

    receive() external payable {}
}
