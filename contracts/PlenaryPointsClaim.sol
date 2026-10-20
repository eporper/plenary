// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 *  ██  UNDEPLOYED DRAFT. NOT AUDITED. DO NOT DEPLOY AS IS.  ██
 *
 *  Plenary participation points are NOT a token and carry no promised value.
 *  This contract only illustrates how a future, separately decided distribution could verify
 *  the published snapshot (see TOKEN.md). No token exists, no deployment is planned, and
 *  nothing here is an offer of anything.
 *
 *  Verifies the snapshot format produced by lib/merkle.mjs:
 *    leaf   = sha256(bytes("plenary-v1|evm:" + lowercase 0x-address + "|" + decimal points))
 *    parent = sha256(min(a,b) ++ max(a,b))
 *  Only EVM-keyed entries ("evm:0x...") can claim here; github: and other chains need their own claim path.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract PlenaryPointsClaim {
    bytes32 public immutable merkleRoot;   // snapshot.merkle_root
    IERC20 public immutable token;         // hypothetical token, funded separately
    uint256 public immutable unitsPerPoint;
    uint256 public immutable claimDeadline;
    mapping(address => bool) public claimed;

    event Claimed(address indexed account, uint256 points, uint256 amount);

    constructor(bytes32 root, IERC20 token_, uint256 unitsPerPoint_, uint256 deadline) {
        merkleRoot = root;
        token = token_;
        unitsPerPoint = unitsPerPoint_;
        claimDeadline = deadline;
    }

    function leafFor(address account, uint256 points) public pure returns (bytes32) {
        return sha256(abi.encodePacked("plenary-v1|evm:", _hexLower(account), "|", _dec(points)));
    }

    function verify(address account, uint256 points, bytes32[] calldata proof) public view returns (bool) {
        bytes32 h = leafFor(account, points);
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h <= p ? sha256(abi.encodePacked(h, p)) : sha256(abi.encodePacked(p, h));
        }
        return h == merkleRoot;
    }

    function claim(uint256 points, bytes32[] calldata proof) external {
        require(block.timestamp <= claimDeadline, "claim closed");
        require(!claimed[msg.sender], "already claimed");
        require(verify(msg.sender, points, proof), "invalid proof");
        claimed[msg.sender] = true;
        uint256 amount = points * unitsPerPoint;
        require(token.transfer(msg.sender, amount), "transfer failed");
        emit Claimed(msg.sender, points, amount);
    }

    function _hexLower(address a) internal pure returns (bytes memory out) {
        bytes16 digits = "0123456789abcdef";
        out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint160 v = uint160(a);
        for (uint256 i = 41; i > 1; i--) {
            out[i] = digits[v & 0xf];
            v >>= 4;
        }
    }

    function _dec(uint256 v) internal pure returns (bytes memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory out = new bytes(len);
        while (v != 0) {
            out[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return out;
    }
}
