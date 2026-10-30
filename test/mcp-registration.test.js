import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BuyerApiError } from "../src/api.js";
import { registerBuyerTools } from "../src/tools.js";

test("registers buyer tools and form-mode approval with the installed MCP SDK", () => {
  const server = new McpServer({ name: "test-buyer", version: "0.1.0" });
  const buyer = {
    searchProducts: async () => [],
    checkCinemaSeatAvailability: async () => ({}),
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
    checkCinemaSeatAvailability: async ({ productId }) => ({
      productId,
      status: "on_sale",
      availableSeatIds: ["A1", "A2"],
    }),
    prepareCheckout: async () => ({}),
    purchaseCheckout: async () => ({}),
    recoverCheckout: async () => ({}),
    downloadReceipt: async (intentId) => ({ status: "saved", intentId }),
  };
  registerBuyerTools(server, buyer);

  const seatsTool = registeredTools.get("check_cinema_seat_availability");
  assert.ok(seatsTool);
  assert.match(seatsTool.config.description, /before asking the buyer to choose/i);
  assert.deepEqual(await seatsTool.handler({ productId: 8 }), {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          productId: 8,
          status: "on_sale",
          availableSeatIds: ["A1", "A2"],
        }),
      },
    ],
  });

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

test("turns seat conflicts into clear availability and retry instructions", async () => {
  const registeredTools = new Map();
  const server = {
    registerTool(name, config, handler) {
      registeredTools.set(name, { config, handler });
    },
  };
  const buyer = {
    searchProducts: async () => [],
    checkCinemaSeatAvailability: async () => ({}),
    prepareCheckout: async () => {
      throw new BuyerApiError(
        "WRHSE rejected the request (CINEMA_SEAT_TAKEN).",
        409,
        "CINEMA_SEAT_TAKEN",
      );
    },
    purchaseCheckout: async () => ({}),
    recoverCheckout: async () => ({}),
    downloadReceipt: async () => ({}),
  };
  registerBuyerTools(server, buyer);

  const result = await registeredTools.get("prepare_checkout").handler({
    idempotencyKey: "test-request-123456",
    items: [{ productId: 8, quantity: 1, seatIds: ["A1"] }],
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /check_cinema_seat_availability/);
  assert.match(result.content[0].text, /new idempotencyKey/);
});
