// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Stands in for the HTTP precompile at 0x0801.
 *
 * The precompile is called with a raw ABI-encoded payload and no selector. Its
 * first word is an address, so the leading four bytes are zero and never collide
 * with a real function selector — which is why configuration can live on the same
 * contract as the fallback that answers precompile calls.
 *
 * Responses are not invented here. `setResponse` is loaded from
 * fixtures/oracle-responses.json, so the status, headers and body a test sees are
 * the ones a real endpoint actually sent.
 */
contract LocalHttpPrecompile {
    uint16 public status;
    string[] private _headerKeys;
    string[] private _headerValues;
    bytes public body;
    string public errorMessage;

    /// Short-running async has a state the chain can be in and a local node cannot:
    /// the executor has not answered yet, so actualOutput is empty.
    bool public unsettled;
    bool public reverting;

    /// The last payload the contract under test sent. Left as raw bytes on
    /// purpose: the tests decode all 13 fields themselves, so the assertion does
    /// not depend on this mock agreeing with them about the layout.
    bytes public lastRequest;

    function setResponse(
        uint16 status_,
        string[] calldata headerKeys_,
        string[] calldata headerValues_,
        bytes calldata body_,
        string calldata errorMessage_
    ) external {
        status = status_;
        delete _headerKeys;
        delete _headerValues;
        for (uint256 i = 0; i < headerKeys_.length; i++)
            _headerKeys.push(headerKeys_[i]);
        for (uint256 i = 0; i < headerValues_.length; i++)
            _headerValues.push(headerValues_[i]);
        body = body_;
        errorMessage = errorMessage_;
        unsettled = false;
        reverting = false;
    }

    function setUnsettled(bool value) external {
        unsettled = value;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        if (reverting) revert("http executor unavailable");
        lastRequest = input;

        bytes memory actualOutput = unsettled
            ? bytes("")
            : abi.encode(
                status,
                _headerKeys,
                _headerValues,
                body,
                errorMessage
            );

        // The async envelope: what was simulated, and what actually came back.
        return abi.encode(input, actualOutput);
    }
}
