import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBuyerTools } from "../src/tools.js";

test("registers buyer tools and form-mode approval with the installed MCP SDK", () => {
  const server = new McpServer({ name: "test-buyer", version: "0.1.0" });
  const buyer = {
    searchProducts: async () => [],
    prepareCheckout: async () => ({}),
    purchaseCheckout: async () => ({}),
    recoverCheckout: async () => ({}),
    downloadReceipt: async () => ({}),
  };

  assert.doesNotThrow(() => registerBuyerTools(server, buyer));
  assert.equal(typeof server.server.elicitInput, "function");
});

test("exposes the receipt tool and delegates only to local receipt generation", async () => {
  const registeredTools = new Map();
  const server = {
    registerTool(name, config, handler) {
      registeredTools.set(name, { config, handler });
    },
  };
  const buyer = {
    searchProducts: async () => [],
    prepareCheckout: async () => ({}),
    purchaseCheckout: async () => ({}),
    recoverCheckout: async () => ({}),
    downloadReceipt: async (intentId) => ({ status: "saved", intentId }),
  };
  registerBuyerTools(server, buyer);

  const receiptTool = registeredTools.get("download_checkout_receipt");
  assert.ok(receiptTool);
  assert.match(receiptTool.config.description, /never/i);
  assert.deepEqual(await receiptTool.handler({ intentId: "intent-1" }), {
    content: [
      {
        type: "text",
        text: JSON.stringify({ status: "saved", intentId: "intent-1" }),
      },
    ],
  });
});
