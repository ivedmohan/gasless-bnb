// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

contract GaslessForwarder is Ownable, ReentrancyGuard, Pausable {
    using ECDSA for bytes32;

    mapping(address => uint256) private _nonces;
    mapping(address => bool) public supportedFeeTokens;
    uint256 public maxGasLimit = 500000;
    uint256 public feeMultiplier = 110; // 1.1x in basis points

    struct MetaTx {
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
    event TransactionExecuted(
        address indexed from,
        address indexed to,
        uint256 nonce,  
        address feeToken,
        uint256 feeAmount
    );
    event MaxGasLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event FeeMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);

    constructor() {
        // BSC Testnet token addresses
        supportedFeeTokens[0xA2C7CaEf4aA9a3da0eaEd89C70Efff1b8818A156] = true; // USDT
        supportedFeeTokens[0xd9BfD73FE6B7481fF056Bf31239c2c4F019c0542] = true; // USDC
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

    function verify(MetaTx memory tx, bytes memory signature) public view returns (bool) {
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
        MetaTx memory tx,
        bytes memory signature,
        address feeToken,
        uint256 feeAmount
    ) external nonReentrant whenNotPaused {
        // Input validation
        require(supportedFeeTokens[feeToken], "Unsupported token");
        require(tx.gas <= maxGasLimit, "Gas limit too high");
        require(tx.to.code.length > 0, "Target must be a contract");
        require(verify(tx, signature), "Invalid signature");
        
        // Check token allowance
        require(
            IERC20(feeToken).allowance(tx.from, address(this)) >= feeAmount,
            "Insufficient token allowance"
        );

        // Transfer fee first (checks-effects-interactions pattern)
        IERC20(feeToken).transferFrom(tx.from, msg.sender, feeAmount);

        // Increment nonce
        unchecked {
        _nonces[tx.from]++;
        }

        // Execute the transaction
        (bool success, ) = tx.to.call{value: tx.value, gas: tx.gas}(tx.data);
        require(success, "Execution failed");

        emit TransactionExecuted(tx.from, tx.to, tx.nonce, feeToken, feeAmount);
    }

    function setMaxGasLimit(uint256 newLimit) external onlyOwner {
        require(newLimit > 0, "Gas limit must be positive");
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
}

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}