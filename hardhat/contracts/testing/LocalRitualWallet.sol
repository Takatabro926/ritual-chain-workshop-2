// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Stands in for RitualWallet: prepaid balances keyed by depositor, with a lock.
contract LocalRitualWallet {
    mapping(address => uint256) private _balances;
    mapping(address => uint256) private _lockUntil;

    event Deposited(address indexed account, uint256 amount, uint256 lockUntil);

    function deposit(uint256 lockDuration) external payable {
        _balances[msg.sender] += msg.value;
        uint256 until = block.number + lockDuration;
        if (until > _lockUntil[msg.sender]) _lockUntil[msg.sender] = until;
        emit Deposited(msg.sender, msg.value, _lockUntil[msg.sender]);
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function lockUntil(address account) external view returns (uint256) {
        return _lockUntil[account];
    }

    receive() external payable {}
}
