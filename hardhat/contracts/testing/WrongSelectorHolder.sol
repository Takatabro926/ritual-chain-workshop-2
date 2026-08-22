// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Answers the receiver call, but with the wrong selector. A contract that
/// merely *has* the function is not the same as one that accepts the token.
contract WrongSelectorHolder {
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}
