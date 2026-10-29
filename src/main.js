import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Connection } from "@solana/web3.js";
import { createIvanaCheckout } from "@habix/ivana-checkout";
import { parseConfig, assertDevnetGenesis, checkoutRpcUrl } from "./config.js";
import { BuyerApiError, createWrhseApi } from "./api.js";
import { logError } from "./logging.js";
import { BuyerCheckout } from "./buyer-checkout.js";
import { createBalanceChecker } from "./balance-check.js";
import { PendingCheckoutStore } from "./state-store.js";
import { loadBurnerWallet } from "./wallet.js";
import { registerBuyerTools } from "./tools.js";

const config = parseConfig();
let encodedSecret = process.env.WRHSE_BUYER_SOLANA_SECRET_KEY;
delete process.env.WRHSE_BUYER_SOLANA_SECRET_KEY;
const keypair = loadBurnerWallet(encodedSecret);
encodedSecret = "";
const connectionForIntent = (intentId) =>
  new Connection(checkoutRpcUrl(config.paymentsBaseUrl, intentId), "confirmed");

const api = createWrhseApi(config.apiBaseUrl, {
  agentKey: config.agentKey,
});
const store = new PendingCheckoutStore(config.statePath);
await store.load();

const server = new McpServer({
  name: "wrhse-buyer",
  version: "0.1.0",
});

const buyer = new BuyerCheckout({
  api,
  checkoutForIntent: async (intentId) => {
    const connection = connectionForIntent(intentId);
    let genesisHash;
    try {
      genesisHash = await connection.getGenesisHash();
    } catch {
      throw new BuyerApiError(
        "Could not verify IVANA's checkout RPC network, so no payment was signed.",
        503,
        "RPC_UNAVAILABLE",
      );
    }
    try {
      assertDevnetGenesis(genesisHash, config.devnetGenesisHash);
    } catch {
      logError("devnet_check_failed", new Error("Checkout RPC is not devnet."), {
        tool: "purchase_checkout",
      });
      throw new BuyerApiError(
        "IVANA's checkout RPC is not connected to devnet, so no payment was signed.",
        503,
        "NOT_DEVNET",
      );
    }
    return createIvanaCheckout({
      connection,
      baseUrl: config.paymentsBaseUrl,
    });
  },
  wallet: keypair,
  store,
  maxUsdc: config.maxUsdc,
  checkFunds: ({ intentId, ...balance }) =>
    createBalanceChecker(connectionForIntent(intentId))(balance),
  requestApproval: async (entry) => {
    const itemLines = entry.catalogItems
      .map(
        (item) =>
          `- ${item.title ?? `Product ${item.productId}`} × ${item.quantity}`,
      )
      .join("\n");
    const customer = [
      entry.customer.name,
      entry.customer.email,
      entry.customer.phone,
      entry.customer.address,
      entry.customer.city,
      entry.customer.province,
      entry.customer.country,
    ]
      .filter(Boolean)
      .join(", ");
    try {
      const result = await server.server.elicitInput({
        mode: "form",
        message: [
          "Review this devnet purchase. Approving will sign and send a USDC transaction from the configured burner wallet.",
          itemLines,
          `Total: ${entry.total} USDC`,
          `Wallet: ${entry.walletAddress}`,
          `Deliver to: ${customer || "No delivery details supplied"}`,
          `Quote expires: ${entry.expiresAt ?? "as determined by the payment service"}`,
          "Decline if anything is incorrect. WRHSE will not receive the wallet key.",
        ].join("\n\n"),
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve this devnet purchase",
              description:
                "If selected, the local server signs and broadcasts the exact WRHSE checkout transaction.",
              default: false,
            },
          },
          required: ["approve"],
        },
      });
      return result.action === "accept" && result.content?.approve === true;
    } catch (error) {
      logError("approval_request_failed", error, {
        tool: "purchase_checkout",
      });
      throw new BuyerApiError(
        "The MCP client could not request user approval; no payment was signed or sent.",
        503,
        "APPROVAL_UNAVAILABLE",
      );
    }
  },
});

registerBuyerTools(server, buyer);
const transport = new StdioServerTransport();
await server.connect(transport);

const close = async () => {
  keypair.secretKey.fill(0);
  await server.close();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
