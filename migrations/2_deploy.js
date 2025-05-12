const GaslessForwarder = artifacts.require("GaslessForwarder");

module.exports = async function (deployer, network, accounts) {
  // Skip deployment if FORWARDER_ADDRESS is set
  if (process.env.FORWARDER_ADDRESS) {
    console.log('Using existing GaslessForwarder at:', process.env.FORWARDER_ADDRESS);
    return;
  }

  // Deploy GaslessForwarder only if no address is provided
  await deployer.deploy(GaslessForwarder);
  const forwarder = await GaslessForwarder.deployed();
  
  console.log('GaslessForwarder deployed at:', forwarder.address);
  
  // If you want to add initial supported tokens after deployment
  if (network === 'bsc_testnet') {
    const USDT = '0xA2C7CaEf4aA9a3da0eaEd89C70Efff1b8818A156';
    const USDC = '0xd9BfD73FE6B7481fF056Bf31239c2c4F019c0542';
    
    await forwarder.addSupportedToken(USDT);
    await forwarder.addSupportedToken(USDC);
    
    console.log('Added supported tokens:', { USDT, USDC });
  }
};