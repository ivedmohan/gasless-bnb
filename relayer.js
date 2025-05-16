const express = require('express');
const ethers = require('ethers');
require('dotenv').config();

const app = express();
app.use(express.json());

const provider = new ethers.providers.JsonRpcProvider('https://bsc-testnet.publicnode.com');
const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
const forwarderAbi = require('./build/contracts/GaslessForwarder.json').abi;
const forwarderAddress = process.env.FORWARDER_ADDRESS;
const forwarder = new ethers.Contract(forwarderAddress, forwarderAbi, wallet);

// Add token ABI for checking balances and allowances
const tokenAbi = [
    "function balanceOf(address account) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

// Enable detailed logging for better debugging
const enableDebugLogging = true;

// Middleware to log every request
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Healthcheck endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        relayer: wallet.address,
        forwarder: forwarderAddress
    });
});

// Relay endpoint
app.post('/relay', async (req, res) => {
    const startTime = Date.now();
    console.log(`\n[${new Date().toISOString()}] Processing relay request`);
    
    try {
        const { metaTx, signature, feeToken, feeAmount } = req.body;
        console.log('Request payload:', JSON.stringify({...req.body, signature: signature.substring(0, 10) + '...'}, null, 2));
        
        if (!metaTx || !signature || !feeToken || !feeAmount) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters',
                details: 'metaTx, signature, feeToken, and feeAmount are required'
            });
        }

        // Format the meta transaction object correctly for the contract
        const formattedMetaTx = {
            from: ethers.utils.getAddress(metaTx.from),
            to: ethers.utils.getAddress(metaTx.to),
            value: ethers.BigNumber.from(metaTx.value || 0),
            gas: ethers.BigNumber.from(metaTx.gas),
            nonce: ethers.BigNumber.from(metaTx.nonce),
            data: metaTx.data,
            deadline: ethers.BigNumber.from(metaTx.deadline)
        };

        // Log key details
        console.log('Relayer Address:', wallet.address);
        console.log('Forwarder Address:', forwarderAddress);
        console.log('User Address:', formattedMetaTx.from);
        console.log('Target Contract:', formattedMetaTx.to);
        console.log('Fee Token:', feeToken);
        
        // Check if the token contract is valid
        const token = new ethers.Contract(feeToken, tokenAbi, provider);
        let decimals;
        try {
            decimals = await token.decimals();
            console.log('Token decimals:', decimals);
        } catch (err) {
            console.warn('Failed to get decimals, assuming 18:', err.message);
            decimals = 18;
        }
        
        // Verify the forwarder configuration
        if (enableDebugLogging) {
            const isTargetAllowed = await forwarder.allowedTargets(formattedMetaTx.to);
            console.log('Is target contract allowed:', isTargetAllowed);
            
            const isFeeTokenSupported = await forwarder.supportedFeeTokens(feeToken);
            console.log('Is fee token supported:', isFeeTokenSupported);
            
            const maxGasLimit = await forwarder.maxGasLimit();
            console.log('Max gas limit:', maxGasLimit.toString());
            console.log('Requested gas limit:', formattedMetaTx.gas.toString());
            
            if (!isTargetAllowed) {
                return res.status(400).json({
                    success: false,
                    error: 'Target contract not allowed',
                    details: `${formattedMetaTx.to} is not in the allowedTargets list`
                });
            }
            
            if (!isFeeTokenSupported) {
                return res.status(400).json({
                    success: false,
                    error: 'Fee token not supported',
                    details: `${feeToken} is not in the supportedFeeTokens list`
                });
            }
            
            if (formattedMetaTx.gas.gt(maxGasLimit)) {
                return res.status(400).json({
                    success: false,
                    error: 'Gas limit too high',
                    details: `Requested gas ${formattedMetaTx.gas.toString()} > max ${maxGasLimit.toString()}`
                });
            }
        }
        
        // Check user's token balance and allowance
        const userBalance = await token.balanceOf(formattedMetaTx.from);
        const userAllowance = await token.allowance(formattedMetaTx.from, forwarderAddress);
        const formattedFeeAmount = ethers.BigNumber.from(feeAmount);
        
        console.log('User token balance:', ethers.utils.formatUnits(userBalance, decimals));
        console.log('User allowance for forwarder:', ethers.utils.formatUnits(userAllowance, decimals));
        console.log('Required fee amount:', ethers.utils.formatUnits(formattedFeeAmount, decimals));
        
        if (userBalance.lt(formattedFeeAmount)) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient token balance',
                details: `User has ${ethers.utils.formatUnits(userBalance, decimals)} but needs at least ${ethers.utils.formatUnits(formattedFeeAmount, decimals)}`
            });
        }
        
        if (userAllowance.lt(formattedFeeAmount)) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient token allowance',
                details: `Allowance is ${ethers.utils.formatUnits(userAllowance, decimals)} but needs at least ${ethers.utils.formatUnits(formattedFeeAmount, decimals)}`
            });
        }

        // Verify the signature
        const isValid = await forwarder.verify(formattedMetaTx, signature);
        console.log('Signature verification result:', isValid);
        
        if (!isValid) {
            return res.status(400).json({
                success: false,
                error: 'Invalid signature',
                details: 'The contract could not verify the signature'
            });
        }

        // Try a static call first for more detailed error info
        let staticCallSucceeded = false;
        try {
            await forwarder.callStatic.execute(
                formattedMetaTx,
                signature,
                feeToken,
                formattedFeeAmount,
                { gasLimit: 750000 }
            );
            staticCallSucceeded = true;
            console.log('Static call successful');
        } catch (staticError) {
            console.error('Static call failed with reason:', staticError.reason || staticError.message);
            console.error('Error details:', JSON.stringify({
                code: staticError.code,
                method: staticError.method,
                transaction: staticError.transaction ? {
                    from: staticError.transaction.from,
                    to: staticError.transaction.to,
                    data: staticError.transaction.data ? staticError.transaction.data.slice(0, 66) + '...' : null
                } : null
            }));
            
            // Don't abort here, still try the actual transaction
            console.log('Proceeding with actual transaction despite static call failure');
        }

        // Execute the transaction
        console.log('Executing transaction...');
        const tx = await forwarder.execute(
            formattedMetaTx,
            signature,
            feeToken,
            formattedFeeAmount,
            { 
                gasLimit: 750000,
                gasPrice: await provider.getGasPrice()
            }
        );
        console.log('Transaction sent:', tx.hash);
        
        // Wait for confirmation
        const receipt = await tx.wait();
        console.log('Transaction confirmed in block', receipt.blockNumber);
        console.log('Gas used:', receipt.gasUsed.toString());
        
        const duration = Date.now() - startTime;
        console.log(`Request completed in ${duration}ms`);
        
        res.json({ 
            success: true, 
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString()
        });
    } catch (error) {
        console.error('Error executing relay request:', error);
        
        // Detailed error logging
        let errorDetails = {
            message: error.message,
            code: error.code
        };
        
        if (error.transaction) {
            errorDetails.transaction = {
                from: error.transaction.from,
                to: error.transaction.to,
                data: error.transaction.data ? error.transaction.data.slice(0, 66) + '...' : null
            };
        }
        
        if (error.receipt) {
            errorDetails.receipt = {
                status: error.receipt.status,
                gasUsed: error.receipt.gasUsed.toString(),
                blockNumber: error.receipt.blockNumber
            };
        }
        
        console.error('Detailed error info:', JSON.stringify(errorDetails, null, 2));
        
        const duration = Date.now() - startTime;
        console.log(`Request failed in ${duration}ms`);
        
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.reason || 'Transaction failed',
            transactionHash: error.transactionHash || null,
            code: error.code || null
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Relayer service running on port ${PORT}`);
    console.log(`Relayer wallet address: ${wallet.address}`);
    console.log(`Forwarder contract address: ${forwarderAddress}`);
});