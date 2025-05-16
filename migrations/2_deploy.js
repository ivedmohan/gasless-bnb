const GaslessForwarder = artifacts.require("GaslessForwarder");

module.exports = async function (deployer, network, accounts) {
  // Skip deployment if FORWARDER_ADDRESS is set
  if (process.env.FORWARDER_ADDRESS) {
    console.log('Using existing GaslessForwarder at:', process.env.FORWARDER_ADDRESS);
    return;
  }

  // Deploy GaslessForwarder with empty constructor arguments
  await deployer.deploy(GaslessForwarder, [], []); // Pass empty arrays for initialTokens and initialTargets
  const forwarder = await GaslessForwarder.deployed();
  
  console.log('GaslessForwarder deployed at:', forwarder.address);

  // Add supported tokens and targets after deployment
  if (network === 'bsc_testnet') {
    const USDT = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd';
    const USDC = '0x64544969ed7EBf5f083679233325356EbE738930';

    // Add supported tokens (for fees)
    await forwarder.addSupportedToken(USDT, { from: accounts[0] });
    await forwarder.addSupportedToken(USDC, { from: accounts[0] });

    // Add allowed targets (for meta-transaction calls)
    await forwarder.addAllowedTarget(USDT, { from: accounts[0] });
    await forwarder.addAllowedTarget(USDC, { from: accounts[0] });

    console.log('Added supported tokens:', { USDT, USDC });
    console.log('Added allowed targets:', { USDT, USDC });
  }
};