require('dotenv').config();
const ethers = require('ethers');
const axios = require('axios');
const forwarderAbi = require('./build/contracts/GaslessForwarder.json').abi;
const tokenAbi = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "function transfer(address recipient, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)"
];

const provider = new ethers.providers.JsonRpcProvider('https://bsc-testnet.publicnode.com');
const wallet = new ethers.Wallet(process.env.USER_PRIVATE_KEY, provider);
const forwarderAddress = process.env.FORWARDER_ADDRESS;
const forwarder = new ethers.Contract(forwarderAddress, forwarderAbi, wallet);
const usdcAddress = '0x64544969ed7EBf5f083679233325356EbE738930';
const usdc = new ethers.Contract(usdcAddress, tokenAbi, wallet);

console.log('Wallet Address:', wallet.address);
console.log('Forwarder Address:', forwarderAddress);

async function checkForwarderConfiguration() {
    console.log('*** Checking Forwarder Configuration ***');
    
    const isUsdcSupported = await forwarder.supportedFeeTokens(usdcAddress);
    console.log('Is USDC supported fee token:', isUsdcSupported);
    
    const isUsdcAllowed = await forwarder.allowedTargets(usdcAddress);
    console.log('Is USDC an allowed target:', isUsdcAllowed);
    
    const maxGasLimit = await forwarder.maxGasLimit();
    console.log('Max gas limit:', maxGasLimit.toString());
    
    const feeMultiplier = await forwarder.feeMultiplier();
    console.log('Fee multiplier:', feeMultiplier.toString(), '(', feeMultiplier / 100, 'x)');

    if (!isUsdcSupported) {
        console.error('ERROR: USDC is not configured as a supported fee token');
    }
    
    if (!isUsdcAllowed) {
        console.error('ERROR: USDC is not configured as an allowed target');
    }
    
    console.log('*** Configuration Check Complete ***\n');
}

async function getBNBPriceInUSDC() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd');
        return response.data.binancecoin.usd;
    } catch (error) {
        console.error('Error fetching BNB price:', error.message);
        return 600; // Fallback
    }
}

async function signMetaTx(to, data, gas = 100000, value = 0, feeToken, feeAmount) {
    try {
        const nonce = await forwarder.getNonce(wallet.address);
        const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now
        
        const metaTx = {
            from: ethers.utils.getAddress(wallet.address),
            to: ethers.utils.getAddress(to),
            value: value,
            gas,
            nonce: nonce.toNumber(),
            data,
            deadline
        };
        
        console.log('Preparing MetaTx with params:');
        console.log('- From:', metaTx.from);
        console.log('- To:', metaTx.to);
        console.log('- Value:', metaTx.value);
        console.log('- Gas:', metaTx.gas);
        console.log('- Nonce:', metaTx.nonce);
        console.log('- Deadline:', metaTx.deadline, '(', new Date(metaTx.deadline * 1000).toLocaleString(), ')');
        console.log('- Data (first 64 chars):', data.substring(0, 64) + '...');

        // Create the message hash that needs to be signed
        const hash = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
            ['address', 'address', 'uint256', 'uint256', 'uint256', 'bytes', 'uint256'],
            [metaTx.from, metaTx.to, metaTx.value, metaTx.gas, metaTx.nonce, metaTx.data, metaTx.deadline]
        ));
        
        // Sign the message hash
        const signature = await wallet.signMessage(ethers.utils.arrayify(hash));
        
        // Verify signature (for debugging)
        const recoveredAddress = ethers.utils.verifyMessage(ethers.utils.arrayify(hash), signature);
        if (recoveredAddress.toLowerCase() !== metaTx.from.toLowerCase()) {
            throw new Error(`Signature verification failed: expected ${metaTx.from}, got ${recoveredAddress}`);
        }
        console.log('Signature verification successful:', recoveredAddress);

        return { 
            metaTx, 
            signature,
            feeToken,
            feeAmount: feeAmount.toString()
        };
    } catch (error) {
        console.error('Error in signMetaTx:', error);
        throw error;
    }
}

async function sendMetaTx(metaTxData) {
    console.log('Sending meta transaction to relayer...');
    try {
        const relayerResponse = await axios.post('http://localhost:3000/relay', metaTxData, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000 // 30 second timeout
        });
        console.log('Relayer response:', relayerResponse.data);
        return relayerResponse.data;
    } catch (error) {
        if (error.response) {
            console.error('Relayer error response:', error.response.data);
            return error.response.data;
        } else {
            console.error('Relayer request failed:', error.message);
            throw new Error(`Relayer request failed: ${error.message}`);
        }
    }
}

async function approveForwarder(amount) {
    console.log(`\n*** Approving forwarder to spend ${amount} USDC ***`);
    
    try {
        const decimals = await usdc.decimals();
        const amountInWei = ethers.utils.parseUnits(amount.toString(), decimals);
        
        // First check current allowance
        const currentAllowance = await usdc.allowance(wallet.address, forwarderAddress);
        console.log('Current allowance:', ethers.utils.formatUnits(currentAllowance, decimals), 'USDC');
        
        if (currentAllowance.gte(amountInWei)) {
            console.log('Allowance already sufficient. Skipping approval.');
            return true;
        }
        
        // Direct approval (not using meta-transaction)
        console.log('Sending direct approval transaction...');
        const tx = await usdc.approve(forwarderAddress, amountInWei);
        console.log('Approval tx sent:', tx.hash);
        
        const receipt = await tx.wait();
        console.log('Approval tx confirmed:', receipt.transactionHash);
        
        // Verify new allowance
        const newAllowance = await usdc.allowance(wallet.address, forwarderAddress);
        console.log('New allowance:', ethers.utils.formatUnits(newAllowance, decimals), 'USDC');
        
        return true;
    } catch (error) {
        console.error('Error approving forwarder:', error);
        return false;
    }
}

async function testTokenTransfer(recipient, amount) {
    console.log(`\n*** Testing ${amount} USDC transfer to ${recipient} ***`);
    
    try {
        const decimals = await usdc.decimals();
        console.log('USDC decimals:', decimals);
        
        // Check balances
        const balance = await usdc.balanceOf(wallet.address);
        console.log('USDC Balance:', ethers.utils.formatUnits(balance, decimals));
        
        // Check allowance
        const allowance = await usdc.allowance(wallet.address, forwarderAddress);
        console.log('Current USDC Allowance:', ethers.utils.formatUnits(allowance, decimals));
        
        // Calculate gas fee
        const gasLimit = 100000;
        const gasPrice = await provider.getGasPrice();
        console.log('Current gas price:', ethers.utils.formatUnits(gasPrice, 'gwei'), 'gwei');
        
        // Ask the contract for the fee estimate to ensure consistency
        const estimatedFeeWei = await forwarder.estimateFee(gasLimit);
        console.log('Contract estimated fee (wei):', estimatedFeeWei.toString());
        
        // Convert to USDC amount
        const bnbToUsdcRate = await getBNBPriceInUSDC();
        console.log('BNB/USDC Rate:', bnbToUsdcRate);
        
        const estimatedFeeUsdc = (Number(ethers.utils.formatEther(estimatedFeeWei)) * bnbToUsdcRate);
        console.log('Estimated Fee (USDC):', estimatedFeeUsdc);
        
        // Add buffer for safety
        const feeWithBuffer = estimatedFeeUsdc * 1.2;
        const feeAmount = ethers.utils.parseUnits(feeWithBuffer.toFixed(decimals), decimals);
        const transferAmount = ethers.utils.parseUnits(amount.toString(), decimals);
        
        console.log('Final fee amount:', ethers.utils.formatUnits(feeAmount, decimals), 'USDC');
        console.log('Transfer amount:', ethers.utils.formatUnits(transferAmount, decimals), 'USDC');
        
        // Total amount needed
        const totalAmount = transferAmount.add(feeAmount);
        console.log('Total amount needed:', ethers.utils.formatUnits(totalAmount, decimals), 'USDC');
        
        // Check if we have enough balance
        if (balance.lt(totalAmount)) {
            throw new Error(`Insufficient USDC balance: ${ethers.utils.formatUnits(balance, decimals)} < ${ethers.utils.formatUnits(totalAmount, decimals)}`);
        }
        
        // Check if we have enough allowance
        if (allowance.lt(totalAmount)) {
            console.log('Insufficient allowance. Approving forwarder...');
            const approved = await approveForwarder(ethers.utils.formatUnits(totalAmount.mul(120).div(100), decimals)); // 20% buffer
            if (!approved) {
                throw new Error('Failed to approve forwarder');
            }
        }
        
        // Prepare transfer data
        const transferData = usdc.interface.encodeFunctionData('transfer', [
            recipient,
            transferAmount
        ]);
        
        // Sign meta transaction
        const { metaTx, signature } = await signMetaTx(
            usdc.address,
            transferData,
            gasLimit,
            0, // No ETH value
            usdc.address, // Using USDC as fee token
            feeAmount
        );
        
        // Add fee token and amount to metaTx object for the relay request
        const relayRequest = {
            metaTx,
            signature,
            feeToken: usdc.address,
            feeAmount: feeAmount.toString()
        };
        
        // Verify signature with contract
        const isValid = await forwarder.verify(metaTx, signature);
        console.log('Is signature valid according to contract:', isValid);
        
        if (!isValid) {
            throw new Error('Transaction signature is not valid according to the contract');
        }
        
        // Send meta-transaction to relayer
        const response = await sendMetaTx(relayRequest);
        
        // Check balances after transaction
        console.log('\n*** Post-Transaction Status ***');
        const newBalance = await usdc.balanceOf(wallet.address);
        console.log('New USDC Balance:', ethers.utils.formatUnits(newBalance, decimals));
        
        const recipientBalance = await usdc.balanceOf(recipient);
        console.log('Recipient USDC Balance:', ethers.utils.formatUnits(recipientBalance, decimals));
        
        return { success: !!response.success, txHash: response.txHash || response.transactionHash };
    } catch (error) {
        console.error('Error in testTokenTransfer:', error);
        return { success: false, error: error.message };
    }
}

async function main() {
    try {
        // First check forwarder configuration
        await checkForwarderConfiguration();
        
        // Test USDC transfer
        const recipient = '0x1234567890abcdef1234567890abcdef12345678';
        const amount = 1; // 1 USDC
        
        console.log(`Testing ${amount} USDC transfer to ${recipient}...`);
        const result = await testTokenTransfer(recipient, amount);
        
        console.log('\n*** Test Result ***');
        console.log('Success:', result.success);
        if (result.txHash) {
            console.log('Transaction hash:', result.txHash);
        }
        if (result.error) {
            console.log('Error:', result.error);
        }
    } catch (error) {
        console.error('Error in main:', error);
    }
}

main().catch(console.error);                    