// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IRitualPredictClaims {
    function claimWinnings(uint256 marketId) external;
}

/// A contract that accepts position tokens, for the safeTransferFrom path.
contract PositionHolder {
    event Received(address operator, address from, uint256 tokenId);

    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata
    ) external returns (bytes4) {
        emit Received(operator, from, tokenId);
        return this.onERC721Received.selector;
    }

    function claim(address predict, uint256 marketId) external {
        IRitualPredictClaims(predict).claimWinnings(marketId);
    }

    receive() external payable {}
}
