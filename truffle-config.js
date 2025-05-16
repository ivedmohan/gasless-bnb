require('dotenv').config();
const HDWalletProvider = require('@truffle/hdwallet-provider');

module.exports = {
  networks: {
    
    bsc_testnet: {
      provider: () => new HDWalletProvider(
        process.env.PRIVATE_KEY,
        'https://bsc-testnet.publicnode.com'
      ),
      network_id: 97,
      confirmations: 2,
      timeoutBlocks: 200,
      skipDryRun: true,
      gas: 5000000,
      gasPrice: 20000000000,
      networkCheckTimeout: 120000,
      websockets: false,
      verify: {
        apiUrl: 'https://api-testnet.bscscan.com/api',
        apiKey: process.env.BSCSCAN_API_KEY,
        explorerUrl: 'https://testnet.bscscan.com/'
      }
    }
  },
  compilers: {
    solc: {
      version: "0.8.19",
      settings: {
        optimizer: {
          enabled: true,
          runs: 200
        }
      }
    }
  },
  mocha: {
    timeout: 200000
  }
};