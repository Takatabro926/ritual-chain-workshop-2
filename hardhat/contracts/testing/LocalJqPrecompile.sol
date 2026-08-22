// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Stands in for the jq precompile at 0x0803.
 *
 * jq cannot be reimplemented in Solidity, and imitating it would only encode my
 * guesses about it. Instead this is a lookup table: every entry is filled from
 * fixtures/oracle-responses.json, where the answers were produced by running the
 * real jq binary over the real recorded body.
 *
 * An unknown key returns zero-length output rather than reverting, which is how
 * the real precompile reports a wrong outputType. That makes this mock unable to
 * distinguish "jq found nothing" from "wrong output type" — a real limitation,
 * and the reason the contract under test checks output length rather than the
 * call's success flag.
 */
contract LocalJqPrecompile {
    mapping(bytes32 => uint256) private _answers;
    mapping(bytes32 => bool) private _known;

    uint256 public callCount;

    function keyOf(
        string calldata query,
        string calldata json,
        uint8 outputType
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(query, json, outputType));
    }

    function setAnswer(
        string calldata query,
        string calldata json,
        uint8 outputType,
        uint256 value
    ) external {
        bytes32 key = keyOf(query, json, outputType);
        _answers[key] = value;
        _known[key] = true;
    }

    function isKnown(
        string calldata query,
        string calldata json,
        uint8 outputType
    ) external view returns (bool) {
        return _known[keyOf(query, json, outputType)];
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        (string memory query, string memory json, uint8 outputType) = abi
            .decode(input, (string, string, uint8));

        bytes32 key = keccak256(abi.encode(query, json, outputType));
        if (!_known[key]) return bytes("");
        return abi.encode(_answers[key]);
    }
}
