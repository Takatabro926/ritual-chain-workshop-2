// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}

/**
 * A small ERC-721 for positions.
 *
 * Written out rather than pulled in: the project has no OpenZeppelin dependency,
 * and adding one to inherit a few hundred lines would be a heavier change than
 * the lines themselves. Enumeration is deliberately absent — nothing here needs
 * to list an owner's tokens, and the index to support it would cost storage on
 * every bet.
 *
 * `_beforePositionTransfer` is where the market keeps its own books straight.
 */
abstract contract PositionToken {
    string public constant name = "RitualPredict Position";
    string public constant symbol = "RPOS";

    uint256 public totalMinted;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operators;

    event Transfer(
        address indexed from,
        address indexed to,
        uint256 indexed tokenId
    );
    event Approval(
        address indexed owner,
        address indexed approved,
        uint256 indexed tokenId
    );
    event ApprovalForAll(
        address indexed owner,
        address indexed operator,
        bool approved
    );

    error NoSuchToken();
    error NotOwner();
    error NotAuthorised();
    error ZeroRecipient();
    error UnsafeRecipient();

    function supportsInterface(bytes4 id) public pure returns (bool) {
        return
            id == 0x01ffc9a7 || // ERC-165
            id == 0x80ac58cd || // ERC-721
            id == 0x5b5e139f; // ERC-721 Metadata
    }

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _ownerOf[tokenId];
        if (owner == address(0)) revert NoSuchToken();
    }

    function balanceOf(address owner) public view returns (uint256) {
        if (owner == address(0)) revert ZeroRecipient();
        return _balanceOf[owner];
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        if (_ownerOf[tokenId] == address(0)) revert NoSuchToken();
        return _approved[tokenId];
    }

    function isApprovedForAll(
        address owner,
        address operator
    ) public view returns (bool) {
        return _operators[owner][operator];
    }

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !_operators[owner][msg.sender])
            revert NotAuthorised();
        _approved[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (ownerOf(tokenId) != from) revert NotOwner();
        if (to == address(0)) revert ZeroRecipient();
        if (
            msg.sender != from &&
            msg.sender != _approved[tokenId] &&
            !_operators[from][msg.sender]
        ) revert NotAuthorised();

        _beforePositionTransfer(tokenId, from, to);

        delete _approved[tokenId];
        _balanceOf[from] -= 1;
        _balanceOf[to] += 1;
        _ownerOf[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId
    ) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            try
                IERC721Receiver(to).onERC721Received(
                    msg.sender,
                    from,
                    tokenId,
                    data
                )
            returns (bytes4 selector) {
                if (selector != IERC721Receiver.onERC721Received.selector)
                    revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }

    function _mintPosition(address to) internal returns (uint256 tokenId) {
        tokenId = ++totalMinted;
        _ownerOf[tokenId] = to;
        _balanceOf[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    /// Called before ownership moves. Reverting here refuses the transfer.
    function _beforePositionTransfer(
        uint256 tokenId,
        address from,
        address to
    ) internal virtual;
}
