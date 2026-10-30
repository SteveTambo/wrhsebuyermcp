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
  let message =
    error instanceof BuyerApiError
      ? error.message
      : "The buyer checkout operation failed. Use recover_checkout to check any pending payment.";
  if (error instanceof BuyerApiError) {
    if (error.code === "CINEMA_SEAT_TAKEN") {
      message =
        "WRHSE could not reserve those seats because one or more were taken. Call check_cinema_seat_availability again, show the buyer the updated availableSeatIds, ask them to choose replacements, then retry with a new idempotencyKey. No payment was made.";
    } else if (error.code === "CINEMA_SEATS_REQUIRED") {
      message =
        "This cinema screening has reserved seating. Call check_cinema_seat_availability, show the buyer the availableSeatIds, and pass exactly one chosen seat ID per ticket.";
    } else if (error.code === "CINEMA_SEATS_INVALID") {
      message =
        "The cinema seat selection is invalid. Refresh with check_cinema_seat_availability, show availableSeatIds, and pass distinct valid seat IDs equal in number to the tickets.";
    } else if (error.code === "CINEMA_CAPACITY_UNAVAILABLE") {
      message =
        "WRHSE could not reserve enough places for that screening. Check availability again and show the buyer the current seats or ticket count.";
    } else if (error.code === "CINEMA_SALES_CLOSED") {
      message = "Ticket sales for this cinema screening have closed.";
    } else if (error.code === "CINEMA_SEPARATE_CHECKOUT") {
      message =
        "Cinema tickets must be checked out as a single-screening cart. Remove all other products and use one line for the screening.";
    } else if (error.code === "CINEMA_ATTEMPT_CONFLICT") {
      message =
        "WRHSE still has an open seat hold for this screening. If the previous prepare_checkout response was lost, retry the exact same items and idempotencyKey. To change seats, first resolve the previous checkout or wait for its hold to clear; then check availability and use a new idempotencyKey.";
    } else if (error.code === "CINEMA_HOLD_LIMIT") {
      message =
        "Too many cinema seats are currently held from this network. Do not retry with new seat selections; finish the open checkout or wait for its hold to clear, then check availability again.";
    }
  }
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function registerBuyerTools(server, buyer) {
  server.registerTool(
    "search_public_products",
    {
      title: "Search WRHSE public products",
      description:
        "Search approved public WRHSE listings. Read-only. Results include event and cinema details plus a cinema availability summary. Before offering or selecting cinema seats, call check_cinema_seat_availability for the fresh seat map; show its availableSeatIds and get the buyer's seat choices.",
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
    "check_cinema_seat_availability",
    {
      title: "Check available cinema seats",
      description:
        "Read current WRHSE availability for one cinema screening. Always call this before asking the buyer to choose. For reserved seating, show availableSeatIds exactly and ask which seats they want; unavailable seats cannot be selected. For general admission, show availableCount and explain there are no assigned seats. Read-only: this does not hold seats. prepare_checkout rechecks availability and places the hold.",
      inputSchema: {
        productId: z
          .number()
          .int()
          .positive()
          .describe("Cinema screening productId from search_public_products."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        return asToolResult(await buyer.checkCinemaSeatAvailability(args));
      } catch (error) {
        return asToolError("check_cinema_seat_availability", error);
      }
    },
  );

  server.registerTool(
    "prepare_checkout",
    {
      title: "Prepare a WRHSE checkout",
      description:
        "Create a server-priced, single-store USDC checkout quote for public products, including event and cinema tickets. Does not sign or pay. For reserved-seat cinema, first call check_cinema_seat_availability, show its availableSeatIds, and ask the buyer which seats they choose. Supply one seatIds entry per ticket (seatIds.length must equal quantity). Cinema screenings must be checked out separately. If a seat was taken, refresh availability and use a NEW idempotencyKey for the changed selection. WRHSE rechecks and atomically holds seats when creating the intent.",
      inputSchema: {
        idempotencyKey: z.string().trim().min(16).max(255),
        items: z
          .array(
            z.object({
              productId: z.number().int().positive(),
              quantity: z
                .number()
                .int()
                .positive()
                .max(10)
                .describe(
                  "Number of tickets. For reserved-seat cinema, must equal the number of seatIds.",
                ),
              size: z.string().trim().min(1).max(20).optional(),
              seatIds: z
                .array(
                  z
                    .string()
                    .regex(
                      /^[A-Z](?:[1-9]|[1-3][0-9]|40)$/,
                      "Use a valid cinema seat ID such as A1.",
                    ),
                )
                .max(10)
                .describe(
                  "For reserved-seat cinema only: one currently available seat ID per ticket, selected from check_cinema_seat_availability.",
                )
                .optional(),
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
