import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, Transaction } from "@solana/web3.js";
import { BuyerCheckout } from "../src/buyer-checkout.js";

const future = () => new Date(Date.now() + 60_000).toISOString();

function fakeStore() {
  const entries = new Map();
  return {
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
    save: async (entry) => entries.set(entry.intentId, entry),
  };
}

function fixture({
  approve = true,
  approvalError,
  fundsError,
  payResult,
  verificationSuccess = true,
  orderFailure = false,
  recovery = "completed",
  total = 4,
  catalogTotal = total,
  orderTotal = total,
  maxUsdc = 5,
  saveReceipt = async (entry) => ({ status: "saved", orderId: entry.order.id }),
} = {}) {
  const keypair = Keypair.generate();
  const usdcMint = Keypair.generate().publicKey;
  const store = fakeStore();
  const calls = {
    createIntent: 0,
    intentInputs: [],
    pay: 0,
    recordOrder: 0,
    approval: 0,
    checkoutForIntent: 0,
  };
  let failOrderOnce = orderFailure;
  const api = {
    async searchProducts() {
      return [{ id: 8, title: "Test shirt" }];
    },
    async getProduct() {
      return {
        data: {
          id: 8,
          title: "Test shirt",
          tenantSlug: "sample-shop",
          isDraft: false,
          archivedAt: null,
        },
      };
    },
    async createIntent(input) {
      calls.createIntent += 1;
      calls.intentInputs.push(input);
      // WRHSE pre-builds a transaction when walletAddress is present, which
      // makes IVANA reject the build the checkout SDK performs at payment
      // time. The wallet is bound by that later build instead.
      assert.equal("walletAddress" in input, false);
      return {
        intentId: "intent-1",
        checkoutToken: "private-checkout-token",
        expiresAt: future(),
        breakdown: { total },
        catalogItems: [
          {
            productId: 8,
            title: "Test shirt",
            quantity: 1,
            unitPriceUsdc: catalogTotal,
          },
        ],
      };
    },
    async recordOrder(body) {
      calls.recordOrder += 1;
      assert.equal(body.checkoutToken, "private-checkout-token");
      assert.equal(body.externalOrderId, "intent-1");
      if (failOrderOnce) {
        failOrderOnce = false;
        throw Object.assign(new Error("order service unavailable"), {
          code: "ORDER_API_UNAVAILABLE",
        });
      }
      return {
        data: { id: 12, externalOrderId: "intent-1", totalAmount: orderTotal },
      };
    },
  };
  const checkout = {
    async getPaymentIntent() {
      return { status: "created", total, expiresAt: future() };
    },
    async pay({ wallet, onSignature }) {
      calls.pay += 1;
      if (payResult instanceof Error) throw payResult;
      const tx = new Transaction({
        feePayer: wallet.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
      }).add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      );
      const recipient = Keypair.generate().publicKey;
      const source = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
      const destination = getAssociatedTokenAddressSync(usdcMint, recipient);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          destination,
          recipient,
          usdcMint,
        ),
        createTransferInstruction(
          source,
          destination,
          wallet.publicKey,
          BigInt(Math.round(total * 1_000_000)),
        ),
      );
      await wallet.signTransaction(tx);
      const signature = bs58.encode(tx.signature);
      await onSignature(signature, {
        blockhash: tx.recentBlockhash,
        lastValidBlockHeight: 100,
      });
      return { signature, verification: { success: verificationSuccess } };
    },
    async recoverPayment() {
      return recovery;
    },
  };
  const buyer = new BuyerCheckout({
    api,
    checkout,
    checkoutForIntent: async (intentId) => {
      assert.equal(intentId, "intent-1");
      calls.checkoutForIntent += 1;
      return checkout;
    },
    wallet: keypair,
    store,
    maxUsdc,
    saveReceipt,
    checkFunds: async ({ intentId, mint }) => {
      assert.equal(intentId, "intent-1");
      assert.equal(mint, usdcMint.toBase58());
      if (fundsError) throw fundsError;
    },
    requestApproval: async () => {
      if (approvalError) throw approvalError;
      calls.approval += 1;
      return approve;
    },
  });
  return { buyer, store, calls, keypair };
}

async function prepare(buyer, changes = {}) {
  return buyer.prepareCheckout({
    idempotencyKey: "test-request-123456",
    items: [{ productId: 8, quantity: 1 }],
    customer: { name: "Test Buyer", country: "KE" },
    ...changes,
  });
}

test("prepares authoritative, idempotent quotes without exposing checkout tokens", async () => {
  const { buyer, calls, store, keypair } = fixture();
  const quote = await prepare(buyer);
  const retry = await prepare(buyer);
  assert.equal(quote.intentId, "intent-1");
  assert.equal(retry.intentId, quote.intentId);
  assert.equal(quote.totalUsdc, 4);
  assert.equal(quote.walletAddress, keypair.publicKey.toBase58());
  assert.equal(JSON.stringify(quote).includes("private-checkout-token"), false);
  assert.equal(calls.createIntent, 1);
  assert.equal(store.get("intent-1").status, "prepared");
});

test("rejects cross-store and over-limit carts before creating an intent", async () => {
  const crossStore = fixture();
  crossStore.buyer.api.getProduct = async (id) => ({
    data: {
      id,
      tenantSlug: id === 8 ? "shop-a" : "shop-b",
      isDraft: false,
    },
  });
  await assert.rejects(
    prepare(crossStore.buyer, {
      items: [
        { productId: 8, quantity: 1 },
        { productId: 9, quantity: 1 },
      ],
    }),
    /same store/,
  );
  assert.equal(crossStore.calls.createIntent, 0);

  const event = fixture();
  event.buyer.api.getProduct = async () => ({
    data: { id: 8, tenantSlug: "shop", admissionKind: "EVENT" },
  });
  await assert.rejects(
    prepare(event.buyer),
    /supported WRHSE checkout details/,
  );
  assert.equal(event.calls.createIntent, 0);

  const tooExpensive = fixture({ total: 6 });
  await assert.rejects(prepare(tooExpensive.buyer), /per-purchase limit/);
});

test("rejects server quotes whose catalog items differ from the requested cart", async () => {
  const { buyer, store } = fixture();
  const createIntent = buyer.api.createIntent;
  buyer.api.createIntent = async (input) => {
    const intent = await createIntent(input);
    return {
      ...intent,
      catalogItems: intent.catalogItems.map((item) => ({
        ...item,
        productId: 99,
      })),
    };
  };
  await assert.rejects(prepare(buyer), /do not match the requested cart/);
  assert.equal(store.list().length, 0);
});

test("prepares event admission tickets using WRHSE's server-priced quote", async () => {
  const { buyer, calls, store } = fixture();
  buyer.api.getProduct = async () => ({
    data: {
      id: 8,
      tenantSlug: "shop",
      isDraft: false,
      admissionKind: null,
      eventStage: "upcoming",
      eventDate: "2030-10-12T18:00:00.000Z",
    },
  });

  const quote = await prepare(buyer);

  assert.equal(quote.status, "prepared");
  assert.equal(calls.createIntent, 1);
  assert.equal("cinemaCheckout" in calls.intentInputs[0], false);
  assert.equal(store.get(quote.intentId).requestItems[0].productId, 8);
});

test("prepares reserved cinema seats and includes them in the approval quote", async () => {
  const { buyer, calls } = fixture();
  buyer.api.getProduct = async () => ({
    data: {
      id: 8,
      tenantSlug: "shop",
      isDraft: false,
      admissionKind: "CINEMA",
      quantity: 3,
      cinemaScreening: {
        seating: { rows: 2, seatsPerRow: 4 },
        takenSeats: ["A2"],
      },
    },
  });

  const quote = await prepare(buyer, {
    items: [{ productId: 8, quantity: 1, seatIds: ["A1"] }],
  });

  assert.equal(calls.intentInputs[0].cinemaCheckout, true);
  assert.deepEqual(calls.intentInputs[0].lineItems[0].seatIds, ["A1"]);
  assert.deepEqual(quote.items[0].seatIds, ["A1"]);
});

test("requires valid available seats for reserved cinema and allows general admission", async () => {
  const reserved = fixture();
  reserved.buyer.api.getProduct = async () => ({
    data: {
      id: 8,
      tenantSlug: "shop",
      isDraft: false,
      admissionKind: "CINEMA",
      cinemaScreening: {
        seating: { rows: 2, seatsPerRow: 4 },
        takenSeats: ["A2"],
      },
    },
  });
  await assert.rejects(prepare(reserved.buyer), /one unique seat for each/);
  await assert.rejects(
    prepare(reserved.buyer, {
      items: [{ productId: 8, quantity: 1, seatIds: ["B5"] }],
    }),
    /one unique seat for each/,
  );
  assert.equal(reserved.calls.createIntent, 0);

  reserved.buyer.api.createIntent = async () => {
    reserved.calls.createIntent += 1;
    throw Object.assign(new Error("seat taken"), {
      code: "CINEMA_SEAT_TAKEN",
      status: 409,
    });
  };
  await assert.rejects(
    prepare(reserved.buyer, {
      items: [{ productId: 8, quantity: 1, seatIds: ["A2"] }],
    }),
    (error) => error.code === "CINEMA_SEAT_TAKEN",
  );
  assert.equal(reserved.calls.createIntent, 1);

  const generalAdmission = fixture();
  generalAdmission.buyer.api.getProduct = async () => ({
    data: {
      id: 8,
      tenantSlug: "shop",
      isDraft: false,
      admissionKind: "CINEMA",
      cinemaScreening: { seating: null },
    },
  });
  const quote = await prepare(generalAdmission.buyer);
  assert.equal(generalAdmission.calls.intentInputs[0].cinemaCheckout, true);
  assert.equal(
    "seatIds" in generalAdmission.calls.intentInputs[0].lineItems[0],
    false,
  );
  assert.equal(quote.status, "prepared");
});

test("search results include current event and cinema details", async () => {
  const { buyer } = fixture();
  buyer.api.searchProducts = async () => [
    { id: 8, title: "Test show", price: 4, tenantSlug: "shop" },
  ];
  buyer.api.getProduct = async () => ({
    data: {
      id: 8,
      eventStage: "upcoming",
      eventDate: "2030-10-12T18:00:00.000Z",
      admissionKind: "CINEMA",
      quantity: 7,
      cinemaScreening: {
        movieTitle: "Test show",
        salesCloseAt: future(),
        status: "SCHEDULED",
        seating: { rows: 2, seatsPerRow: 4 },
        takenSeats: ["A1", "B2"],
      },
    },
  });

  const [product] = await buyer.searchProducts({ query: "test show" });

  assert.equal(product.eventStage, "upcoming");
  assert.equal(product.quantity, 7);
  assert.deepEqual(product.cinemaScreening.seating, {
    rows: 2,
    seatsPerRow: 4,
  });
  assert.equal(product.cinemaScreening.availability.status, "on_sale");
  assert.equal(product.cinemaScreening.availability.availableCount, 6);
  assert.equal(
    "availableSeatIds" in product.cinemaScreening.availability,
    false,
  );
});

test("fresh cinema seat availability returns a complete, labeled seat map", async () => {
  const { buyer } = fixture();
  buyer.api.getProduct = async () => ({
    data: {
      id: 8,
      title: "Test screening",
      isDraft: false,
      cinemaScreening: {
        movieTitle: "Test movie",
        auditorium: "Screen 1",
        venueAddress: "1 Cinema Road",
        timezone: "Africa/Nairobi",
        startsAt: "2030-10-12T18:00:00.000Z",
        endsAt: "2030-10-12T20:00:00.000Z",
        salesCloseAt: future(),
        status: "SCHEDULED",
        seating: { rows: 2, seatsPerRow: 3 },
        takenSeats: ["A2", "B3"],
      },
    },
  });

  const result = await buyer.checkCinemaSeatAvailability({ productId: 8 });

  assert.equal(result.status, "on_sale");
  assert.deepEqual(result.availableSeatIds, ["A1", "A3", "B1", "B2"]);
  assert.deepEqual(result.unavailableSeatIds, ["A2", "B3"]);
  assert.deepEqual(
    result.seatMap.map((row) => row.seats.map((seat) => seat.status)),
    [
      ["available", "taken", "available"],
      ["available", "available", "taken"],
    ],
  );
  assert.match(result.instruction, /ask them to choose/);
});

test("retries the same held-seat checkout idempotently without rechecking seats", async () => {
  const { buyer, calls } = fixture();
  let seatIsTaken = false;
  buyer.api.getProduct = async () => ({
    data: {
      id: 8,
      tenantSlug: "shop",
      isDraft: false,
      admissionKind: "CINEMA",
      cinemaScreening: {
        salesCloseAt: future(),
        status: "SCHEDULED",
        seating: { rows: 1, seatsPerRow: 3 },
        takenSeats: seatIsTaken ? ["A1"] : [],
      },
    },
  });
  const request = {
    items: [{ productId: 8, quantity: 1, seatIds: ["A1"] }],
  };

  const first = await prepare(buyer, request);
  seatIsTaken = true;
  const retry = await prepare(buyer, request);

  assert.equal(first.intentId, retry.intentId);
  assert.equal(calls.createIntent, 1);
});

test("fresh cinema availability handles general admission and closed screenings", async () => {
  const { buyer } = fixture();
  let screening = {
    salesCloseAt: future(),
    status: "SCHEDULED",
    seating: null,
  };
  buyer.api.getProduct = async () => ({
    data: {
      id: 8,
      title: "General admission",
      quantity: 12,
      isDraft: false,
      cinemaScreening: screening,
    },
  });

  const open = await buyer.checkCinemaSeatAvailability({ productId: 8 });
  assert.equal(open.status, "on_sale");
  assert.equal(open.availableCount, 12);
  assert.deepEqual(open.availableSeatIds, []);
  assert.match(open.instruction, /general admission/);

  screening = { ...screening, salesCloseAt: "2000-01-01T00:00:00.000Z" };
  const closed = await buyer.checkCinemaSeatAvailability({ productId: 8 });
  assert.equal(closed.status, "sales_closed");
  assert.equal(closed.availableCount, 0);
});

test("cinema availability fails closed when seat inventory is missing", async () => {
  const { buyer } = fixture();
  buyer.api.getProduct = async () => ({
    data: {
      id: 8,
      title: "Test screening",
      isDraft: false,
      cinemaScreening: {
        salesCloseAt: future(),
        seating: { rows: 2, seatsPerRow: 3 },
      },
    },
  });

  await assert.rejects(
    buyer.checkCinemaSeatAvailability({ productId: 8 }),
    (error) => error.code === "CINEMA_AVAILABILITY_UNAVAILABLE",
  );
});

test("requires approval and only records one order after verified payment", async () => {
  const { buyer, calls, keypair } = fixture();
  const quote = await prepare(buyer);
  const result = await buyer.purchaseCheckout(quote.intentId);
  assert.equal(result.status, "completed");
  assert.equal(result.walletAddress, undefined);
  assert.equal(calls.approval, 1);
  assert.equal(calls.checkoutForIntent, 1);
  assert.equal(calls.pay, 1);
  assert.equal(calls.recordOrder, 1);
  assert.equal(keypair.publicKey.toBase58().length > 32, true);

  await buyer.purchaseCheckout(quote.intentId);
  assert.equal(calls.pay, 1);
  assert.equal(calls.recordOrder, 1);
});

test("completed results distinguish the paid total from the order subtotal", async () => {
  const { buyer } = fixture({
    total: 5.29,
    catalogTotal: 4.5,
    orderTotal: 4.5,
    maxUsdc: 6,
  });
  const quote = await prepare(buyer);
  const result = await buyer.purchaseCheckout(quote.intentId);

  assert.equal(quote.totalUsdc, 5.29);
  assert.equal(result.status, "completed");
  assert.equal(result.totalUsdc, 5.29);
  assert.equal(result.orderSubtotalUsdc, 4.5);
  assert.equal(result.totalAmount, 4.5);

  const repeated = await buyer.purchaseCheckout(quote.intentId);
  assert.equal(repeated.totalUsdc, 5.29);
  assert.equal(repeated.orderSubtotalUsdc, 4.5);
});

test("ticket credentials stay in local recovery state and are omitted from MCP results", async () => {
  const { buyer, store } = fixture();
  buyer.api.recordOrder = async () => ({
    data: {
      id: 12,
      externalOrderId: "intent-1",
      totalAmount: 4,
      tickets: [
        {
          code: "ABCDEFGHIJKLMNOPQRSTUV",
          productTitle: "Opening night",
          productId: 8,
          eventStage: "upcoming",
          eventDate: "2030-10-12T18:00:00.000Z",
          seat: "A1",
        },
      ],
    },
  });
  const quote = await prepare(buyer);

  const result = await buyer.purchaseCheckout(quote.intentId);

  assert.equal(result.status, "completed");
  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0].seat, "A1");
  assert.equal(JSON.stringify(result).includes("ABCDEFGHIJKLMNOPQRSTUV"), false);
  assert.equal(
    store.get(quote.intentId).order.tickets[0].code,
    "ABCDEFGHIJKLMNOPQRSTUV",
  );
});

test("checkout automatically saves one receipt and reuses it on receipt requests", async () => {
  const savedEntries = [];
  const { buyer, calls } = fixture({
    saveReceipt: async (entry) => {
      savedEntries.push(entry);
      return { status: "saved", orderId: entry.order.id };
    },
  });
  const quote = await prepare(buyer);

  await assert.rejects(buyer.downloadReceipt(quote.intentId), /only after WRHSE confirms/);
  assert.equal(savedEntries.length, 0);

  const completed = await buyer.purchaseCheckout(quote.intentId);
  assert.deepEqual(completed.receipt, { status: "saved", orderId: 12 });
  assert.equal(savedEntries.length, 1);
  const result = await buyer.downloadReceipt(quote.intentId);
  assert.deepEqual(result, { status: "saved", orderId: 12 });
  assert.equal(savedEntries.length, 1);
  assert.equal(savedEntries[0].status, "completed");
  assert.equal(calls.pay, 1);
});

test("receipt generation refuses an unresolved payment", async () => {
  const { buyer, calls } = fixture({ verificationSuccess: false });
  const quote = await prepare(buyer);
  await buyer.purchaseCheckout(quote.intentId);

  await assert.rejects(
    buyer.downloadReceipt(quote.intentId),
    /only after WRHSE confirms/,
  );
  assert.equal(calls.pay, 1);
});

test("receipt save failures are explicit and do not retry payment", async () => {
  const { buyer, calls } = fixture({
    saveReceipt: async () => {
      throw new Error("local filesystem detail");
    },
  });
  const quote = await prepare(buyer);
  const completed = await buyer.purchaseCheckout(quote.intentId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.receipt.status, "failed");
  assert.equal(
    buyer.store.get(quote.intentId).status,
    "completed",
  );

  await assert.rejects(
    buyer.downloadReceipt(quote.intentId),
    /Downloads folder is writable.*No payment was attempted/,
  );
  assert.equal(calls.pay, 1);
});

test("declined approval never signs or pays", async () => {
  const { buyer, calls } = fixture({ approve: false });
  const quote = await prepare(buyer);
  const result = await buyer.purchaseCheckout(quote.intentId);
  assert.equal(result.status, "approval_declined");
  assert.equal(calls.pay, 0);
  assert.equal(calls.recordOrder, 0);
});

test("cannot pay when approval or a balance check fails", async () => {
  const approvalFailure = fixture({ approvalError: new Error("unavailable") });
  const approvalQuote = await prepare(approvalFailure.buyer);
  await assert.rejects(
    approvalFailure.buyer.purchaseCheckout(approvalQuote.intentId),
    /unavailable/,
  );
  assert.equal(approvalFailure.calls.pay, 0);

  const insufficientFunds = fixture({
    fundsError: new Error("insufficient funds"),
  });
  const fundsQuote = await prepare(insufficientFunds.buyer);
  const fundsResult = await insufficientFunds.buyer.purchaseCheckout(
    fundsQuote.intentId,
  );
  assert.equal(fundsResult.status, "payment_failed");
  assert.equal(insufficientFunds.calls.pay, 1);
  assert.equal(
    insufficientFunds.buyer.store.get(fundsQuote.intentId).signature,
    undefined,
  );
});

test("unverified payment remains pending and is never paid twice", async () => {
  const { buyer, calls } = fixture({ verificationSuccess: false });
  const quote = await prepare(buyer);
  const pending = await buyer.purchaseCheckout(quote.intentId);
  assert.equal(pending.status, "payment_pending");
  assert.equal(calls.recordOrder, 0);
  assert.equal(calls.pay, 1);
});

test("ambiguous payments are recovered, never paid a second time", async () => {
  const signature = "2".repeat(64);
  const pendingError = Object.assign(new Error("private underlying details"), {
    signature,
    lastValidBlockHeight: 100,
    code: "VERIFY_FAILED",
  });
  const { buyer, calls } = fixture({
    payResult: pendingError,
    recovery: "pending",
  });
  const quote = await prepare(buyer);
  const pending = await buyer.purchaseCheckout(quote.intentId);
  assert.equal(pending.status, "payment_pending");
  assert.equal(pending.message.includes("private underlying details"), false);
  const stillPending = await buyer.recoverCheckout(quote.intentId);
  assert.equal(stillPending.status, "payment_pending");
  assert.equal(calls.pay, 1);
  assert.equal(calls.recordOrder, 0);
});

test("recovery records an already-completed payment without paying again", async () => {
  const pendingError = Object.assign(new Error("uncertain"), {
    signature: "3".repeat(64),
    lastValidBlockHeight: 100,
  });
  const { buyer, calls } = fixture({
    payResult: pendingError,
    recovery: "completed",
  });
  const quote = await prepare(buyer);
  await buyer.purchaseCheckout(quote.intentId);
  const recovered = await buyer.recoverCheckout(quote.intentId);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.receipt.status, "saved");
  assert.equal(calls.pay, 1);
  assert.equal(calls.recordOrder, 1);
});

test("order-recording failure recovers without repeating payment", async () => {
  const { buyer, calls } = fixture({ orderFailure: true });
  const quote = await prepare(buyer);
  const pendingOrder = await buyer.purchaseCheckout(quote.intentId);
  assert.equal(pendingOrder.status, "paid_order_pending");
  assert.equal(calls.pay, 1);
  assert.equal(calls.recordOrder, 1);

  const recovered = await buyer.recoverCheckout(quote.intentId);
  assert.equal(recovered.status, "completed");
  assert.equal(calls.pay, 1);
  assert.equal(calls.recordOrder, 2);
});
