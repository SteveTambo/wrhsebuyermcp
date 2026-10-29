import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDevnetGenesis,
  checkoutRpcUrl,
  parseConfig,
} from "../src/config.js";

const configEnv = {
  WRHSE_BUYER_AGENT_KEY: `wrhse_agent_123e4567-e89b-12d3-a456-426614174000.${"A".repeat(43)}`,
  WRHSE_BUYER_SOLANA_SECRET_KEY: "not-read-by-config",
};

test("requires only WRHSE agent and burner-wallet keys", () => {
  const parsed = parseConfig({
    ...configEnv,
    WRHSE_BUYER_USDC_MINT: "obsolete-mint-override",
    WRHSE_BUYER_SOLANA_RPC_URL: "https://obsolete-rpc.example",
  });
  assert.equal(parsed.maxUsdc, 5);
  assert.equal(parsed.apiBaseUrl, "https://api.wrhse.top/api");
  assert.equal(
    parsed.paymentsBaseUrl,
    "https://ivanaservertenant.onrender.com/api",
  );
  assert.equal("usdcMint" in parsed, false);
  assert.equal("rpcUrl" in parsed, false);
  assert.equal(parsed.agentKey, configEnv.WRHSE_BUYER_AGENT_KEY);
  assert.equal("secretKey" in parsed, false);

  assert.throws(
    () =>
      parseConfig({
        ...configEnv,
        WRHSE_BUYER_AGENT_KEY: "",
      }),
    /WRHSE_BUYER_AGENT_KEY must be a WRHSE agent key/,
  );
  assert.throws(
    () =>
      parseConfig({
        ...configEnv,
        WRHSE_BUYER_API_URL: "https://api.example.test/api?token=hidden",
      }),
    /must not include a query or fragment/,
  );
  assert.throws(
    () => parseConfig({ ...configEnv, WRHSE_BUYER_MAX_USDC: "1000" }),
    /at most 100/,
  );
});

test("requires the local RPC connection to be on devnet", () => {
  const expected = parseConfig(configEnv).devnetGenesisHash;
  assertDevnetGenesis(expected);
  assert.throws(
    () => assertDevnetGenesis("mainnet-genesis"),
    /not connected to devnet/,
  );
});

test("builds an intent-scoped RPC URL under IVANA's API base URL", () => {
  assert.equal(
    checkoutRpcUrl("https://payments.example/api/", "intent/1"),
    "https://payments.example/api/webthree/checkout-rpc/intent%2F1",
  );
});
