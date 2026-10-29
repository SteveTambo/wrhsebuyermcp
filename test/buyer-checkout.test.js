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
  saveReceipt = async (entry) => ({ status: "saved", orderId: entry.order.id }),
} = {}) {
  const keypair = Keypair.generate();
  const usdcMint = Keypair.generate().publicKey;
  const store = fakeStore();
  const calls = {
    createIntent: 0,
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
      assert.equal(input.walletAddress, keypair.publicKey.toBase58());
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
            unitPriceUsdc: total,
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
        data: { id: 12, externalOrderId: "intent-1", totalAmount: total },
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
    maxUsdc: 5,
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

test("rejects cross-store, ticket, and over-limit carts before creating an intent", async () => {
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

  const ticket = fixture();
  ticket.buyer.api.getProduct = async () => ({
    data: { id: 8, tenantSlug: "shop", admissionKind: "EVENT" },
  });
  await assert.rejects(prepare(ticket.buyer), /non-ticket products/);
  assert.equal(ticket.calls.createIntent, 0);

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

test("receipt generation requires a completed checkout and uses the saved order", async () => {
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

  await buyer.purchaseCheckout(quote.intentId);
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
  await buyer.purchaseCheckout(quote.intentId);

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
