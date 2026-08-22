// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Stands in for TEEServiceRegistry.
 *
 * Selection is seed-driven like the real one, so a contract that varies its seed
 * per retry visibly lands on different executors here too. Two failure modes are
 * switchable, because both must leave the caller standing: an empty registry,
 * and a registry that reverts.
 */
contract LocalTeeRegistry {
    enum Mode {
        Normal,
        NoneFound,
        Reverting
    }

    Mode public mode;
    address[] private _executors;

    function setExecutors(address[] calldata executors) external {
        delete _executors;
        for (uint256 i = 0; i < executors.length; i++)
            _executors.push(executors[i]);
    }

    function setMode(Mode newMode) external {
        mode = newMode;
    }

    function executorCount() external view returns (uint256) {
        return _executors.length;
    }

    function pickServiceByCapability(
        uint8,
        bool,
        uint256 seed,
        uint256 maxProbes
    ) external view returns (address teeAddress, bool found) {
        if (mode == Mode.Reverting) revert("registry unavailable");
        if (mode == Mode.NoneFound || _executors.length == 0)
            return (address(0), false);
        require(maxProbes > 0, "maxProbes must be positive");
        return (_executors[seed % _executors.length], true);
    }
}
