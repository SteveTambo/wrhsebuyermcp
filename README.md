# WRHSE buyer MCP (devnet test)

This is a **customer-operated local MCP server** for testing agent-funded
checkout. It is not part of WRHSE's merchant MCP and must not be deployed by
WRHSE. The customer runs it beside their MCP client. The wallet key stays in
that local process; WRHSE and IVANA receive only the public address and signed
transaction. The existing WRHSE agent key authorizes intent creation through
the new `checkout:purchase` permission; it never signs or pays.

The initial test flow supports USDC purchases of public products from one
store, including event tickets and cinema screenings. Cinema screenings with
reserved seating require one available seat ID per ticket; general-admission
screenings use ticket quantities. A cinema screening must be checked out by
itself. The flow does not support donations, EVM, HBX, user-wallet delegation,
unattended payments, or production networks.

## Requirements

- Node.js 22 or newer.
- A dedicated, low-funded Solana devnet burner wallet.
- The WRHSE API and IVANA payments API have defaults. RPC traffic is relayed
  through IVANA's configured RPC; customers do not configure an RPC URL.
- An MCP client that supports form-mode elicitation. The server refuses to sign
  if it cannot request approval from the user.

## Configure Windows environment variables

Set these as **user-scoped** Windows environment variables so the local MCP
process inherits them:

| Variable                        | Required | Description                                                                                                                                      |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WRHSE_BUYER_AGENT_KEY`         | Yes      | Key created in **Profile → AI agents** with **Allow agent purchases** (`checkout:purchase`) selected. Never put it in prompts or source control. |
| `WRHSE_BUYER_SOLANA_SECRET_KEY` | Yes      | Customer's dedicated burner-wallet key as base58 64-byte secret or Solana CLI JSON keypair array. Never share it with the agent or WRHSE.        |

The WRHSE API and IVANA API URLs have defaults. The payment mint is taken from
the checkout transaction built using IVANA's configured mint; the local server
validates that it is a six-decimal SPL token and checks the burner's balance for
that mint. Customers do not configure a separate mint.

The local process sends intent-scoped balance, blockhash, broadcast, and
recovery requests through IVANA. IVANA uses its configured `SOLANA_RPC_URL`;
the URL and provider credentials remain server-side. The local process verifies
that IVANA is connected to devnet for this test release. No customer RPC
account or RPC environment variable is required.

Use the Windows Environment Variables UI or your approved secret-management
process to set the two keys. Windows user environment variables are readable by
processes running as that user; only use a low-funded burner wallet with funds
you can afford to lose. Restart the MCP client after changing variables. Do not
use a production wallet or a key belonging to another person.

Optional developer overrides are `WRHSE_BUYER_API_URL`,
`WRHSE_BUYER_PAYMENTS_URL`, and `WRHSE_BUYER_MAX_USDC` (default 150 USDC, maximum
150). Ordinary customers do not need to configure them.

## VS Code Copilot install

The npm package is prepared for public publishing. Once published, install and
register the buyer MCP in one command:

```powershell
npx --yes wrhse-buyer-mcp setup
```

Setup checks the required environment variables and adds a `wrhse-buyer` entry
to the user's Copilot MCP configuration. Existing MCP server entries are
preserved. If a `wrhse-buyer` entry already exists, setup asks before replacing
it. Secret values are never written to the MCP config.

After setup, restart VS Code, start `wrhse-buyer` from the MCP server list, and
verify it with a read-only product search.

Until it is published on npm, clone the public
[wrhsebuyermcp repository](https://github.com/SteveTambo/wrhsebuyermcp),
run `npm ci` in its root, and configure Copilot to launch `node` with the
absolute path to `src/main.js`. Do not put either secret in MCP configuration.

## Agent instructions

Give the agent these rules, without including the secret:

- Use only `search_public_products` to discover products, then
  `prepare_checkout` with the customer's actual product choices and delivery
  details. For reserved-seat cinema, call `check_cinema_seat_availability`
  immediately before offering seats. Show the buyer the returned
  `availableSeatIds` list and seat map, and ask which seats they choose. Pass
  exactly one available `seatIds` value per ticket. Do not invent seats; WRHSE
  checks availability again and places the hold while creating the intent.
  If WRHSE reports a seat was taken, fetch availability again and use a new
  idempotency key for the changed selection.
- Show the returned products, server-priced total, wallet address, and delivery
  details to the customer. Do not claim a purchase succeeded until the tool
  returns `completed`.
- For completed results, report `totalUsdc` as the full quoted amount paid.
  `orderSubtotalUsdc` and the legacy `totalAmount` field are the merchandise
  subtotal recorded on the WRHSE order, before VAT and transaction fees.
- After WRHSE confirms an order, `purchase_checkout` and `recover_checkout`
  automatically save a local PDF receipt and return its result in `receipt`.
  For event/cinema orders, this PDF contains the ticket QR codes.
  Report the receipt path when saved; use `download_checkout_receipt` only to
  retry if automatic receipt generation failed.
- `purchase_checkout` always requests a separate user approval form before it
  signs. Never try to bypass a declined or unsupported approval request.
- If a result is `payment_pending` or `paid_order_pending`, do not pay again.
  Call `recover_checkout` with that intent ID until it reaches a final result.
- If a result is `payment_failed`, no transaction was broadcast. For cinema
  checkouts, WRHSE may keep the seat hold until the payment window expires and
  on-chain checks confirm it is safe to release. Refresh availability before
  asking the buyer to choose again; if the held seats still block a new
  checkout, wait for WRHSE to clear the hold.
- The completed purchase result includes the automatically saved receipt path.
  Do not copy the PDF contents or any ticket code/QR contents into chat. Ticket
  QR codes are one-time admission credentials; share the PDF privately only
  with people authorized to use every credential it contains.
- Never ask for, print, infer, or transmit the wallet secret.

Before signing, the local guard restricts the transaction to USDC transfers
from the burner wallet's associated token account, checks that their total
matches the approved quote, and caps compute-budget fees. It does not
independently allowlist the recipient token-account owners; it relies on the
configured WRHSE/IVANA checkout services to build the payment. Keep this
prototype on devnet with a low-funded burner wallet.

## Available tools

- `search_public_products`: browse approved public listings, including event
  and cinema screening details and a concise cinema availability summary.
- `check_cinema_seat_availability`: fetch the latest seat map for one cinema
  screening immediately before seat selection. For reserved seating, show
  `availableSeatIds` and ask the buyer which seats they choose; for general
  admission, report `availableCount` and explain there are no assigned seats.
  This is read-only and does not reserve seats.
- `prepare_checkout`: revalidates the products through WRHSE, creates a
  server-priced quote, applies the per-checkout cap, and stores local recovery
  state. For reserved-seat cinema, provide exactly one currently available
  seat ID per ticket (`seatIds.length` must equal `quantity`); WRHSE rechecks
  and holds seats when it creates the intent. Use a new `idempotencyKey` if
  the buyer changes seats after a failed preparation. The supplied key must
  remain the same for retries of the same preparation request.
- `purchase_checkout`: asks for MCP user approval, then signs and pays the
  exact prepared intent. After WRHSE confirms the order, it automatically saves
  a receipt and returns its path in the result. Ticket orders include
  individual admission QR codes in that private local PDF.
- `recover_checkout`: recovers an ambiguous payment or retries recording an
  already-verified order. It never makes a new payment.
- `download_checkout_receipt`: retries saving a PDF when automatic receipt
  generation failed. The PDF includes a clickable Solscan devnet transaction
  link, a collection QR code when WRHSE returned a collection code, and
  individual ticket QR codes for admissions. These are credentials: keep the
  PDF private and share it only with people authorized to use every credential
  it contains. This tool never initiates or retries payment.

Pending checkouts, their checkout tokens, and minimal customer details are
stored in the current Windows user's Local AppData directory under
`WRHSE\buyer-agent\pending-checkouts.json`. The file does not contain wallet
private keys, but completed ticket orders include ticket codes so the PDF can
be regenerated after a restart. Treat this file as sensitive and do not share
it. Completed entries remain for idempotent tool retries; remove the file only
after all pending purchases are resolved.

Buyer MCP errors are written as structured JSON lines to the process' stderr.
In VS Code, inspect the buyer MCP server's channel in **View → Output**. Logs
include the tool name and safe error diagnostics; authorization headers and
token-like fields are redacted. Do not share logs without reviewing them first.

## Test

```powershell
npm test
```

These tests use generated burner keys and mocked APIs; they do not contact a
live WRHSE or IVANA service or broadcast transactions. The first end-to-end
devnet purchase should be a separately approved, low-value transaction against
a controlled listing.
