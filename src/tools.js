import { z } from "zod";
import { BuyerApiError } from "./api.js";
import { logError } from "./logging.js";

function asToolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function asToolError(tool, error) {
  logError("tool_failed", error, { tool });
  const message =
    error instanceof BuyerApiError
      ? error.message
      : "The buyer checkout operation failed. Use recover_checkout to check any pending payment.";
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function registerBuyerTools(server, buyer) {
  server.registerTool(
    "search_public_products",
    {
      title: "Search WRHSE public products",
      description:
        "Search approved public WRHSE listings. Read-only. Use product IDs from these results to prepare a checkout.",
      inputSchema: {
        query: z.string().trim().min(2).max(100),
        buyerCountry: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/)
          .optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        return asToolResult(await buyer.searchProducts(args));
      } catch (error) {
        return asToolError("search_public_products", error);
      }
    },
  );

  server.registerTool(
    "prepare_checkout",
    {
      title: "Prepare a WRHSE checkout",
      description:
        "Create a server-priced, single-store USDC checkout quote for public non-ticket products. Does not sign or pay. Supply a stable UUID idempotencyKey and the buyer's own delivery/contact fields.",
      inputSchema: {
        idempotencyKey: z.string().trim().min(16).max(255),
        items: z
          .array(
            z.object({
              productId: z.number().int().positive(),
              quantity: z.number().int().positive().max(10),
              size: z.string().trim().min(1).max(20).optional(),
            }),
          )
          .min(1)
          .max(20),
        customer: z
          .object({
            name: z.string().max(120).optional(),
            email: z.string().email().max(254).or(z.literal("")).optional(),
            phone: z.string().max(40).optional(),
            address: z.string().max(500).optional(),
            city: z.string().max(120).optional(),
            province: z.string().max(120).optional(),
            country: z
              .string()
              .regex(/^[A-Za-z]{2}$/)
              .optional(),
          })
          .optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        return asToolResult(await buyer.prepareCheckout(args));
      } catch (error) {
        return asToolError("prepare_checkout", error);
      }
    },
  );

  server.registerTool(
    "purchase_checkout",
    {
      title: "Pay for a WRHSE checkout",
      description:
        "Pay one prepared checkout from the configured devnet burner wallet. Always triggers an explicit user-approval form showing the server-priced cart and total before signing. After WRHSE confirms the order, automatically saves a local PDF receipt and includes its path in the result. Requires a client that supports MCP elicitation; otherwise payment is refused.",
      inputSchema: { intentId: z.string().trim().min(1).max(255) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ intentId }) => {
      try {
        return asToolResult(await buyer.purchaseCheckout(intentId));
      } catch (error) {
        return asToolError("purchase_checkout", error);
      }
    },
  );

  server.registerTool(
    "recover_checkout",
    {
      title: "Recover a WRHSE checkout",
      description:
        "Resolve an existing payment or retry recording its already-verified order. Never makes a new payment.",
      inputSchema: { intentId: z.string().trim().min(1).max(255) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ intentId }) => {
      try {
        return asToolResult(await buyer.recoverCheckout(intentId));
      } catch (error) {
        return asToolError("recover_checkout", error);
      }
    },
  );

  server.registerTool(
    "download_checkout_receipt",
    {
      title: "Save a WRHSE checkout receipt",
      description:
        "Retry saving the local PDF receipt for a completed checkout if automatic receipt generation failed. Includes the WRHSE collection QR when the completed order has a collection code. Never creates or retries a payment.",
      inputSchema: { intentId: z.string().trim().min(1).max(255) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ intentId }) => {
      try {
        return asToolResult(await buyer.downloadReceipt(intentId));
      } catch (error) {
        return asToolError("download_checkout_receipt", error);
      }
    },
  );
}
