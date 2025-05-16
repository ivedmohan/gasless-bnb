// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract GaslessForwarder is Ownable, ReentrancyGuard, Pausable {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    mapping(address => uint256) private _nonces;
    mapping(address => bool) public supportedFeeTokens;
    mapping(address => bool) public allowedTargets;
    uint256 public maxGasLimit = 500000;
    uint256 public minGasLimit = 21000;
    uint256 public feeMultiplier = 110; // 1.1x in basis points

    struct GaslessForwarderMetaTx {
        address from;
        address to;
        uint256 value;
        uint256 gas;
        uint256 nonce;
        bytes data;
        uint256 deadline;
    }

    event TokenAdded(address indexed token);
    event TokenRemoved(address indexed token);
    event TargetAdded(address indexed target);
    event TargetRemoved(address indexed target);
    event TransactionExecuted(address indexed from, address indexed to, uint256 nonce, address feeToken, uint256 feeAmount);
    event TransactionFailed(address indexed from, address indexed to, uint256 nonce, string reason);
    event MaxGasLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event FeeMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);

    constructor(address[] memory initialTokens, address[] memory initialTargets) {
        for (uint i = 0; i < initialTokens.length; i++) {
            require(initialTokens[i] != address(0), "Zero address not allowed");
            supportedFeeTokens[initialTokens[i]] = true;
            emit TokenAdded(initialTokens[i]);
        }
        for (uint i = 0; i < initialTargets.length; i++) {
            require(initialTargets[i] != address(0), "Zero address not allowed");
            allowedTargets[initialTargets[i]] = true;
            emit TargetAdded(initialTargets[i]);
        }
    }

    function addSupportedToken(address token) external onlyOwner {
        require(token != address(0), "Zero address not allowed");
        require(!supportedFeeTokens[token], "Token already supported");
        supportedFeeTokens[token] = true;
        emit TokenAdded(token);
    }

    function removeSupportedToken(address token) external onlyOwner {
        require(supportedFeeTokens[token], "Token not supported");
        supportedFeeTokens[token] = false;
        emit TokenRemoved(token);
    }

    function addAllowedTarget(address target) external onlyOwner {
        require(target != address(0), "Zero address not allowed");
        require(!allowedTargets[target], "Target already allowed");
        allowedTargets[target] = true;
        emit TargetAdded(target);
    }

    function removeAllowedTarget(address target) external onlyOwner {
        require(allowedTargets[target], "Target not allowed");
        allowedTargets[target] = false;
        emit TargetRemoved(target);
    }

    function verify(GaslessForwarderMetaTx memory tx, bytes memory signature) public view returns (bool) {
        require(block.timestamp <= tx.deadline, "Transaction expired");
        require(tx.from != address(0), "Invalid sender address");
        require(tx.to != address(0), "Invalid target address");
        
        bytes32 hash = keccak256(abi.encode(
            tx.from,
            tx.to,
            tx.value,
            tx.gas,
            tx.nonce,
            tx.data,
            tx.deadline
        )).toEthSignedMessageHash();
        
        return hash.recover(signature) == tx.from && _nonces[tx.from] == tx.nonce;
    }

    function execute(
        GaslessForwarderMetaTx memory metaTx,
        bytes memory signature,
        address feeToken,
        uint256 feeAmount
    ) external nonReentrant whenNotPaused {
        require(supportedFeeTokens[feeToken], "Unsupported token");
        require(allowedTargets[metaTx.to], "Target not allowed");
        require(metaTx.gas >= minGasLimit && metaTx.gas <= maxGasLimit, "Invalid gas limit");
        require(verify(metaTx, signature), "Invalid signature");
        
        // Calculate minimum fee (1.1x of gas cost)
        uint256 gasPrice = tx.gasprice;
        uint256 minFee = (metaTx.gas * gasPrice * feeMultiplier) / 10000;
        require(feeAmount >= minFee, "Fee too low");

        unchecked {
            _nonces[metaTx.from]++;
        }

        // Execute the transaction
        (bool success, bytes memory returndata) = metaTx.to.call{value: metaTx.value, gas: metaTx.gas}(metaTx.data);
        if (!success) {
            string memory reason = _getRevertReason(returndata);
            emit TransactionFailed(metaTx.from, metaTx.to, metaTx.nonce, reason);
            revert(reason);
        }

        emit TransactionExecuted(metaTx.from, metaTx.to, metaTx.nonce, feeToken, feeAmount);
    }

    function _getRevertReason(bytes memory returndata) private pure returns (string memory) {
        if (returndata.length < 68) return "Execution failed";
        assembly {
            returndata := add(returndata, 0x04)
        }
        return abi.decode(returndata, (string));
    }

    function setMaxGasLimit(uint256 newLimit) external onlyOwner {
        require(newLimit > minGasLimit, "Gas limit too low");
        uint256 oldLimit = maxGasLimit;
        maxGasLimit = newLimit;
        emit MaxGasLimitUpdated(oldLimit, newLimit);
    }

    function setFeeMultiplier(uint256 newMultiplier) external onlyOwner {
        require(newMultiplier >= 100, "Fee multiplier too low");
        uint256 oldMultiplier = feeMultiplier;
        feeMultiplier = newMultiplier;
        emit FeeMultiplierUpdated(oldMultiplier, newMultiplier);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function getNonce(address from) external view returns (uint256) {
        return _nonces[from];
    }

    function estimateFee(uint256 gasAmount) external view returns (uint256) {
        uint256 gasPrice = block.basefee;
        if (gasPrice == 0) {
            gasPrice = 5 gwei; // Fallback to 5 gwei if basefee is not available
        }
        return (gasAmount * gasPrice * feeMultiplier) / 10000;
    }
}