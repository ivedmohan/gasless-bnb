const GaslessForwarder = artifacts.require("GaslessForwarder");
require('dotenv').config();

contract("GaslessForwarder", function (accounts) {
  let forwarder;
  const owner = accounts[0];
  const user = accounts[1];
  const relayer = accounts[2];
  const feeAmount = web3.utils.toWei('1', 'ether');

  // BSC Testnet token addresses
  const USDT = '0xA2C7CaEf4aA9a3da0eaEd89C70Efff1b8818A156';
  const USDC = '0xd9BfD73FE6B7481fF056Bf31239c2c4F019c0542';
  const FORWARDER_ADDRESS = '0x70882Fdb4af72073a85F1C8c15D08C3F7Bb8e2E9';

  before(async () => {
    // Use the deployed contract address
    forwarder = await GaslessForwarder.at(FORWARDER_ADDRESS);
  });

  describe("Contract State", () => {
    it("should have correct supported tokens", async () => {
      const isUSDTSupported = await forwarder.supportedFeeTokens(USDT);
      const isUSDCSupported = await forwarder.supportedFeeTokens(USDC);
      assert.isTrue(isUSDTSupported, "USDT should be supported");
      assert.isTrue(isUSDCSupported, "USDC should be supported");
    });

    it("should have correct max gas limit", async () => {
      const maxGasLimit = await forwarder.maxGasLimit();
      assert.equal(maxGasLimit.toString(), "500000", "Max gas limit should be 500000");
    });

    it("should have correct fee multiplier", async () => {
      const feeMultiplier = await forwarder.feeMultiplier();
      assert.equal(feeMultiplier.toString(), "120", "Fee multiplier should be 120");
    });
  });

  describe("Owner Functions", () => {
    it("should allow owner to pause/unpause", async () => {
      try {
        await forwarder.pause({ from: owner });
        const isPaused = await forwarder.paused();
        assert.isTrue(isPaused, "Should be paused");
        
        await forwarder.unpause({ from: owner });
        const isUnpaused = await forwarder.paused();
        assert.isFalse(isUnpaused, "Should be unpaused");
      } catch (error) {
        console.log("Error in pause/unpause test:", error.message);
        throw error;
      }
    });

    it("should not allow non-owner to pause", async () => {
      let errorThrown = false;
      try {
        await forwarder.pause({ from: user });
      } catch (error) {
        errorThrown = true;
        // Just check that an error was thrown, don't check the specific message
        console.log("Non-owner pause error:", error.message);
      }
      assert.isTrue(errorThrown, "Should have thrown an error");
    });

    it("should allow owner to update fee multiplier", async () => {
      try {
        const newMultiplier = 130;
        await forwarder.setFeeMultiplier(newMultiplier, { from: owner });
        const currentMultiplier = await forwarder.feeMultiplier();
        assert.equal(currentMultiplier.toString(), newMultiplier.toString(), "Fee multiplier not updated");
        
        // Reset back to original
        await forwarder.setFeeMultiplier(120, { from: owner });
      } catch (error) {
        console.log("Error in fee multiplier update test:", error.message);
        throw error;
      }
    });

    it("should not allow setting fee multiplier below 100", async () => {
      let errorThrown = false;
      try {
        await forwarder.setFeeMultiplier(99, { from: owner });
      } catch (error) {
        errorThrown = true;
        console.log("Fee multiplier error:", error.message);
      }
      assert.isTrue(errorThrown, "Should have thrown an error");
    });
  });

  describe("Token Management", () => {
    it("should not allow adding zero address as supported token", async () => {
      let errorThrown = false;
      try {
        await forwarder.addSupportedToken(web3.utils.padLeft(0, 40), { from: owner });
      } catch (error) {
        errorThrown = true;
        console.log("Zero address error:", error.message);
      }
      assert.isTrue(errorThrown, "Should have thrown an error");
    });

    it("should not allow adding already supported token", async () => {
      let errorThrown = false;
      try {
        await forwarder.addSupportedToken(USDT, { from: owner });
      } catch (error) {
        errorThrown = true;
        console.log("Duplicate token error:", error.message);
      }
      assert.isTrue(errorThrown, "Should have thrown an error");
    });

    it("should allow owner to remove and add supported token", async () => {
      try {
        // Get initial state
        const initialState = await forwarder.supportedFeeTokens(USDT);
        console.log("Initial token state:", initialState);

        // Remove token
        const removeTx = await forwarder.removeSupportedToken(USDT, { from: owner });
        console.log("Remove transaction:", removeTx.tx);
        
        // Wait for a few blocks to ensure state is updated
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const afterRemove = await forwarder.supportedFeeTokens(USDT);
        console.log("State after remove:", afterRemove);
        assert.isFalse(afterRemove, "Token should be removed");
        
        // Add it back
        const addTx = await forwarder.addSupportedToken(USDT, { from: owner });
        console.log("Add transaction:", addTx.tx);
        
        // Wait for a few blocks to ensure state is updated
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const afterAdd = await forwarder.supportedFeeTokens(USDT);
        console.log("State after add:", afterAdd);
        assert.isTrue(afterAdd, "Token should be added back");
      } catch (error) {
        console.log("Error in token management test:", error.message);
        throw error;
      }
    });
  });
}); 