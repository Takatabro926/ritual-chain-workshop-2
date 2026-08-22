// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IRitualPredict {
    function bet(uint256 marketId, bool isYes) external payable;

    function claimWinnings(uint256 marketId) external;
}

/// A bettor that cannot be paid: every plain transfer to it reverts. Exists to
/// reach the one branch that decides what happens when a payout cannot land.
contract RejectsEther {
    function bet(
        address predict,
        uint256 marketId,
        bool isYes
    ) external payable {
        IRitualPredict(predict).bet{value: msg.value}(marketId, isYes);
    }

    function claim(address predict, uint256 marketId) external {
        IRitualPredict(predict).claimWinnings(marketId);
    }

    receive() external payable {
        revert("this contract does not accept ether");
    }
}
