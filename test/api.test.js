import test from "node:test";
import assert from "node:assert/strict";
import { createWrhseApi, BuyerApiError } from "../src/api.js";

test("builds public checkout URLs under the configured API prefix", async () => {
  const calls = [];
  const api = createWrhseApi("https://api.example.test/api", {
    agentKey: "test-agent-key",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({ data: [] });
    },
  });

  await api.searchProducts({ query: "blue shirt", buyerCountry: "KE" });
  await api.createIntent({ checkoutProtocol: 1 });
  assert.equal(
    calls[0].url,
    "https://api.example.test/api/products/search?q=blue+shirt&limit=10&buyerCountry=KE",
  );
  assert.equal(
    calls[1].url,
    "https://api.example.test/api/webthree/agent/create-payment-intent",
  );
  assert.equal(calls[1].options.method, "POST");
  assert.equal(
    calls[0].options.headers.Authorization,
    undefined,
    "public product browsing does not send the agent credential",
  );
  assert.equal(calls[1].options.headers.Authorization, "Bearer test-agent-key");
});

test("normalizes API errors without exposing response bodies", async () => {
  const api = createWrhseApi("https://api.example.test/api", {
    fetchImpl: async () =>
      Response.json(
        { error: { code: "CHECKOUT_REFUSED", message: "private details" } },
        { status: 409 },
      ),
  });
  await assert.rejects(api.recordOrder({}), (error) => {
    assert.ok(error instanceof BuyerApiError);
    assert.equal(error.code, "CHECKOUT_REFUSED");
    assert.equal(error.message.includes("private details"), false);
    return true;
  });
});
