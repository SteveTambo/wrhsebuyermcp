import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Connection } from "@solana/web3.js";
import { createIvanaCheckout } from "@habix/ivana-checkout";
import { readFile } from "node:fs/promises";
import { parseConfig, assertDevnetGenesis, checkoutRpcUrl } from "./config.js";
import { BuyerApiError, createWrhseApi } from "./api.js";
import { logError } from "./logging.js";
import { BuyerCheckout } from "./buyer-checkout.js";
import { createBalanceChecker } from "./balance-check.js";
import { PendingCheckoutStore } from "./state-store.js";
import { loadBurnerWallet } from "./wallet.js";
import { registerBuyerTools } from "./tools.js";

const config = parseConfig();
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
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
  version: packageJson.version,
  instructions:
    "WRHSE buyer checkout: use search_public_products to find a listing. For Cinema, call check_cinema_seat_availability immediately before offering seats, show its exact availableSeatIds, and ask the buyer to choose; never invent seat IDs. Call prepare_checkout only with the buyer's selected products, seats, and delivery details. Show the returned server-priced items, USDC total, wallet, and expiry. Call purchase_checkout only to complete the buyer's requested purchase. It requires an explicit user approval form before it signs; if approval is unavailable or declined, no payment is sent. Never claim success until status is completed. For payment_pending or paid_order_pending, call recover_checkout and never pay again. Keep ticket receipt files and QR codes private. This server pays only from its local devnet burner wallet; never ask for or expose its secret.",
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
      logError(
        "devnet_check_failed",
        new Error("Checkout RPC is not devnet."),
        {
          tool: "purchase_checkout",
        },
      );
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
  requestApproval: async (entry, payment) => {
    const amount = (value) => {
      const fixed = Number(value).toFixed(6);
      return fixed.replace(/0+$/, "").replace(/\.$/, "");
    };
    const itemLines = entry.catalogItems
      .map((item) => {
        const title = item.title ?? `Product ${item.productId}`;
        const seats = item.seatIds?.length
          ? ` (Seats: ${item.seatIds.join(", ")})`
          : "";
        const unitPrice = Number(item.unitPriceUsdc);
        const price = Number.isFinite(unitPrice)
          ? ` — ${amount(unitPrice)} USDC each; ${amount(unitPrice * item.quantity)} USDC line total`
          : "";
        return `- ${title} × ${item.quantity}${price}${seats}`;
      })
      .join("\n");
    const store = entry.merchant
      ? [
          entry.merchant.name,
          entry.merchant.areas?.map((area) => area.name).filter(Boolean).join(", "),
          [
            entry.merchant.location?.city,
            entry.merchant.location?.region,
            entry.merchant.location?.country,
          ]
            .filter(Boolean)
            .join(", "),
        ]
          .filter(Boolean)
          .join(" — ")
      : "Seller/location unavailable from the search result";
    const itemsSubtotal = entry.catalogItems.reduce(
      (sum, item) => sum + Number(item.unitPriceUsdc ?? 0) * item.quantity,
      0,
    );
    const netAmountLine =
      entry.breakdown &&
      Math.abs(entry.breakdown.netAmountUsdc - itemsSubtotal) > 0.000001
        ? [`Server net amount: ${amount(entry.breakdown.netAmountUsdc)} USDC`]
        : [];
    const pricing = [
      `Items subtotal: ${amount(itemsSubtotal)} USDC`,
      ...netAmountLine,
      ...(entry.breakdown
        ? [
            `VAT: ${amount(entry.breakdown.vatAmountUsdc)} USDC`,
            `Transaction fee: ${amount(entry.breakdown.transactionFeeUsdc)} USDC`,
          ]
        : ["Fees: included in the total; breakdown unavailable"]),
      `Total charged: ${amount(entry.total)} USDC`,
    ].join("\n");
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
          `Store: ${store}`,
          itemLines,
          pricing,
          `Network: ${payment.network}`,
          `USDC mint: ${payment.paymentMint}`,
          "Verified transaction recipients (review every address and amount):",
          ...payment.recipients.map((recipient) => {
            const baseUnits = BigInt(recipient.amountBaseUnits);
            const whole = baseUnits / 1_000_000n;
            const fraction = (baseUnits % 1_000_000n)
              .toString()
              .padStart(6, "0")
              .replace(/0+$/, "");
            return `- ${recipient.walletAddress}: ${whole}${fraction ? `.${fraction}` : ""} USDC (token account ${recipient.tokenAccount})`;
          }),
          `Wallet: ${entry.walletAddress}`,
          `Deliver to: ${customer || "No delivery details supplied"}`,
          `Quote expires: ${entry.expiresAt ?? "as determined by the payment service"}`,
          "Decline if anything is incorrect. WRHSE will not receive the wallet key.",
          "If this order includes tickets, the private local PDF receipt contains the admission QR codes. Do not copy ticket codes or QR contents into chat.",
        ].join("\n\n"),
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve this devnet purchase",
              description:
                "If selected, the local server signs and broadcasts this devnet transaction to the listed recipient wallets.",
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
