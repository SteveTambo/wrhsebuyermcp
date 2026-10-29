import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import { createLocalWallet } from "./wallet.js";
import { BuyerApiError } from "./api.js";
import { saveCheckoutReceipt } from "./receipt.js";
import { assertSafeCheckoutTransaction } from "./transaction-guard.js";

const MAX_LINES = 20;
const MAX_QUANTITY = 20;
const MAX_LINE_QUANTITY = 10;

function validCustomer(customer) {
  const result = {};
  for (const key of [
    "name",
    "email",
    "phone",
    "address",
    "city",
    "province",
    "country",
  ]) {
    const value = customer?.[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 500) {
      throw new BuyerApiError(
        `Customer field "${key}" is invalid.`,
        400,
        "INVALID_CUSTOMER",
      );
    }
    result[key] = value;
  }
  if (result.country && result.country.length !== 2) {
    throw new BuyerApiError(
      "Customer country must be a two-letter code.",
      400,
      "INVALID_CUSTOMER",
    );
  }
  if (result.country) result.country = result.country.toUpperCase();
  return result;
}

function totalQuantity(items) {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

function quoteItemsFor(items) {
  const aggregated = new Map();
  for (const item of items) {
    const key = `${item.productId}:${item.size ?? ""}`;
    aggregated.set(key, (aggregated.get(key) ?? 0) + item.quantity);
  }
  return aggregated;
}

function quoteFrom(intent) {
  const total = intent?.breakdown?.total;
  const catalogItems = intent?.catalogItems;
  const expiresAt = Date.parse(intent?.expiresAt);
  if (
    typeof intent?.intentId !== "string" ||
    typeof intent.checkoutToken !== "string" ||
    !Number.isFinite(total) ||
    total <= 0 ||
    !Number.isFinite(expiresAt) ||
    !Array.isArray(catalogItems) ||
    catalogItems.length === 0
  ) {
    throw new BuyerApiError(
      "WRHSE returned an incomplete checkout quote.",
      502,
      "INVALID_CHECKOUT_QUOTE",
    );
  }
  return { total, catalogItems };
}

export class BuyerCheckout {
  constructor({
    api,
    checkout,
    checkoutForIntent,
    wallet,
    store,
    maxUsdc,
    saveReceipt = saveCheckoutReceipt,
    requestApproval = async () => {
      throw new BuyerApiError(
        "User approval is unavailable; no payment was signed or sent.",
        503,
        "APPROVAL_UNAVAILABLE",
      );
    },
    checkFunds = async () => {
      throw new BuyerApiError(
        "Burner-wallet balance checks are unavailable; no payment was signed.",
        503,
        "BALANCE_CHECK_UNAVAILABLE",
      );
    },
    now = () => Date.now(),
  }) {
    this.api = api;
    this.checkoutForIntent = checkoutForIntent ?? (() => checkout);
    this.keypair = wallet;
    this.store = store;
    this.saveReceipt = saveReceipt;
    this.maxUsdc = maxUsdc;
    this.requestApproval = requestApproval;
    this.checkFunds = checkFunds;
    this.now = now;
    this.locks = new Map();
  }

  async searchProducts({ query, buyerCountry }) {
    const results = await this.api.searchProducts({
      query: query.trim().slice(0, 100),
      buyerCountry: buyerCountry?.toUpperCase(),
    });
    return results.slice(0, 10).map((product) => ({
      id: product.id,
      title: product.title,
      price: product.price,
      quantity: product.quantity,
      sizes: product.sizes,
      tenantSlug: product.tenantSlug,
      storeName: product.store?.name,
      area: product.area?.name,
    }));
  }

  async prepareCheckout({ items, customer, idempotencyKey }) {
    if (items.length > MAX_LINES || totalQuantity(items) > MAX_QUANTITY) {
      throw new BuyerApiError(
        "A checkout may contain at most 20 lines and 20 units.",
        400,
        "CART_LIMIT",
      );
    }
    if (items.some((item) => item.quantity > MAX_LINE_QUANTITY)) {
      throw new BuyerApiError(
        "Each item is limited to 10 units per checkout.",
        400,
        "CART_LIMIT",
      );
    }

    const normalizedCustomer = validCustomer(customer);
    const selected = items.map(({ productId, quantity, size }) => ({
      productId,
      quantity,
      ...(size ? { size: size.trim() } : {}),
    }));
    const productDetails = await Promise.all(
      selected.map(async (item) => {
        const result = await this.api.getProduct(item.productId);
        return result?.data;
      }),
    );
    if (
      productDetails.some(
        (product, index) =>
          !product ||
          product.id !== selected[index].productId ||
          product.isDraft ||
          product.archivedAt ||
          product.admissionKind ||
          product.eventStage ||
          product.cinema ||
          (Array.isArray(product.acceptedPaymentMethods) &&
            !product.acceptedPaymentMethods.includes("USDC")),
      )
    ) {
      throw new BuyerApiError(
        "Only currently available non-ticket products are supported in this test flow.",
        400,
        "UNSUPPORTED_PRODUCT",
      );
    }
    const storeSlugs = new Set(
      productDetails.map((product) => product.tenantSlug),
    );
    if (storeSlugs.size !== 1) {
      throw new BuyerApiError(
        "All items must be from the same store.",
        400,
        "MULTIPLE_STORES",
      );
    }

    const existing = this.store
      .list()
      .find((entry) => entry.idempotencyKey === idempotencyKey);
    if (existing) {
      if (
        JSON.stringify(existing.requestItems) !== JSON.stringify(selected) ||
        JSON.stringify(existing.customer) !== JSON.stringify(normalizedCustomer)
      ) {
        throw new BuyerApiError(
          "This idempotency key is already associated with a different checkout.",
          409,
          "IDEMPOTENCY_CONFLICT",
        );
      }
      return this.#quoteResult(existing);
    }

    const intent = await this.api.createIntent({
      checkoutProtocol: 1,
      customer: normalizedCustomer,
      lineItems: selected,
      idempotencyKey,
      paymentMethod: "USDC",
      paymentChain: "solana",
      walletAddress: this.keypair.publicKey.toBase58(),
    });
    const quote = quoteFrom(intent);
    const requestedItems = quoteItemsFor(selected);
    const quotedItems = quoteItemsFor(quote.catalogItems);
    if (
      requestedItems.size !== quotedItems.size ||
      [...requestedItems].some(
        ([key, quantity]) => quotedItems.get(key) !== quantity,
      )
    ) {
      throw new BuyerApiError(
        "WRHSE returned checkout items that do not match the requested cart.",
        502,
        "INVALID_CHECKOUT_QUOTE",
      );
    }
    if (quote.total > this.maxUsdc) {
      throw new BuyerApiError(
        `The server-priced total exceeds the configured ${this.maxUsdc} USDC per-purchase limit.`,
        400,
        "PURCHASE_LIMIT_EXCEEDED",
      );
    }

    const entry = {
      intentId: intent.intentId,
      checkoutToken: intent.checkoutToken,
      walletAddress: this.keypair.publicKey.toBase58(),
      paymentMethod: "USDC",
      paymentChain: "solana",
      idempotencyKey,
      requestItems: selected,
      customer: normalizedCustomer,
      catalogItems: quote.catalogItems,
      total: quote.total,
      expiresAt: intent.expiresAt,
      status: "prepared",
      createdAt: new Date(this.now()).toISOString(),
    };
    if (Date.parse(entry.expiresAt) <= this.now()) {
      throw new BuyerApiError(
        "WRHSE returned an expired checkout quote.",
        502,
        "INVALID_CHECKOUT_QUOTE",
      );
    }
    await this.store.save(entry);
    return this.#quoteResult(entry);
  }

  async purchaseCheckout(intentId) {
    return this.#withLock(intentId, async () => {
      const entry = this.store.get(intentId);
      if (!entry) {
        throw new BuyerApiError(
          "Checkout not found in local recovery state.",
          404,
          "CHECKOUT_NOT_FOUND",
        );
      }
      if (entry.status === "completed") return this.#completedResult(entry);
      if (entry.status === "paid_order_pending")
        return this.#recordOrder(entry);
      if (entry.status === "payment_pending") {
        return {
          status: "payment_pending",
          message:
            "Payment outcome is unknown. Do not pay again; call recover_checkout.",
          intentId,
          signature: entry.signature,
        };
      }
      if (entry.status !== "prepared") {
        throw new BuyerApiError(
          "This checkout cannot be paid again. Use recover_checkout or prepare a new checkout.",
          409,
          "CHECKOUT_NOT_PAYABLE",
        );
      }
      if (entry.expiresAt && Date.parse(entry.expiresAt) <= this.now()) {
        entry.status = "expired";
        await this.store.save(entry);
        throw new BuyerApiError(
          "This quote has expired. Prepare a new checkout.",
          409,
          "CHECKOUT_EXPIRED",
        );
      }

      const checkout = await this.checkoutForIntent(intentId);
      const current = await checkout.getPaymentIntent(intentId);
      const currentExpiry = Date.parse(current?.expiresAt);
      if (
        current?.status !== "created" ||
        !Number.isFinite(current?.total) ||
        Math.abs(current.total - entry.total) > 0.000001 ||
        !Number.isFinite(currentExpiry) ||
        currentExpiry <= this.now()
      ) {
        entry.status = "expired";
        await this.store.save(entry);
        throw new BuyerApiError(
          "The quote is no longer payable. Prepare a new checkout.",
          409,
          "CHECKOUT_EXPIRED",
        );
      }

      const approved = await this.requestApproval(entry);
      if (!approved) return { status: "approval_declined", intentId };

      entry.status = "paying";
      await this.store.save(entry);
      const wallet = createLocalWallet(this.keypair, {
        validateTransaction: async (transaction) => {
          const paymentMint = assertSafeCheckoutTransaction(transaction, {
            walletAddress: this.keypair.publicKey,
            totalUsdc: entry.total,
          });
          await this.checkFunds({
            intentId,
            walletAddress: entry.walletAddress,
            total: entry.total,
            mint: paymentMint.toBase58(),
          });
        },
        afterSign: async (transaction) => {
          entry.signature = bs58.encode(transaction.signature);
          entry.lastValidBlockHeight = null;
          entry.status = "payment_pending";
          await this.store.save(entry);
        },
      });

      try {
        const result = await checkout.pay({
          intentId,
          wallet,
          paymentMethod: "USDC",
          onSignature: async (signature, blockhash) => {
            if (entry.signature !== signature) {
              throw new Error(
                "The signed transaction signature did not match.",
              );
            }
            entry.lastValidBlockHeight = blockhash.lastValidBlockHeight;
            entry.status = "payment_pending";
            await this.store.save(entry);
          },
        });
        if (result.verification?.success !== true) {
          entry.signature = result.signature;
          entry.status = "payment_pending";
          await this.store.save(entry);
          return {
            status: "payment_pending",
            intentId,
            signature: entry.signature,
            message:
              "Payment verification is incomplete. Do not pay again; call recover_checkout.",
          };
        }
        entry.signature = result.signature;
        entry.status = "paid_order_pending";
        await this.store.save(entry);
        return this.#recordOrder(entry);
      } catch (error) {
        if (error?.signature || entry.signature) {
          entry.signature = error.signature ?? entry.signature;
          entry.lastValidBlockHeight =
            error.lastValidBlockHeight ?? entry.lastValidBlockHeight;
          entry.status = "payment_pending";
          await this.store.save(entry);
          return {
            status: "payment_pending",
            message:
              "Payment may have been sent. Do not pay again; call recover_checkout.",
            intentId,
            signature: entry.signature,
          };
        }
        entry.status = "payment_failed";
        await this.store.save(entry);
        return {
          status: "payment_failed",
          message:
            "No payment was confirmed. Prepare a new checkout before trying again.",
          code: typeof error?.code === "string" ? error.code : "PAYMENT_FAILED",
          intentId,
        };
      }
    });
  }

  async recoverCheckout(intentId) {
    return this.#withLock(intentId, async () => {
      const entry = this.store.get(intentId);
      if (!entry) {
        throw new BuyerApiError(
          "Checkout not found in local recovery state.",
          404,
          "CHECKOUT_NOT_FOUND",
        );
      }
      if (entry.status === "completed") return this.#completedResult(entry);
      if (entry.status === "paid_order_pending")
        return this.#recordOrder(entry);
      if (entry.status !== "payment_pending" || !entry.signature) {
        return { status: entry.status, intentId };
      }

      const checkout = await this.checkoutForIntent(intentId);
      const recovery = await checkout.recoverPayment({
        intentId,
        signature: entry.signature,
        walletAddress: entry.walletAddress,
        paymentMethod: "USDC",
        lastValidBlockHeight: entry.lastValidBlockHeight,
        savedAt: Date.parse(entry.createdAt),
      });
      if (recovery === "completed") {
        entry.status = "paid_order_pending";
        await this.store.save(entry);
        return this.#recordOrder(entry);
      }
      if (recovery === "failed" || recovery === "expired") {
        entry.status = recovery === "failed" ? "payment_failed" : "expired";
        await this.store.save(entry);
        return {
          status: entry.status,
          intentId,
          message:
            "The original payment cannot complete. Prepare a new checkout; do not reuse this intent.",
        };
      }
      return {
        status: "payment_pending",
        intentId,
        signature: entry.signature,
        message:
          "Payment is not resolved yet. Do not pay again; retry recover_checkout later.",
      };
    });
  }

  async downloadReceipt(intentId) {
    const entry = this.store.get(intentId);
    if (!entry) {
      throw new BuyerApiError(
        "Checkout not found in local recovery state.",
        404,
        "CHECKOUT_NOT_FOUND",
      );
    }
    if (entry.status !== "completed" || !entry.order) {
      throw new BuyerApiError(
        "A receipt is available only after WRHSE confirms the order. Resolve pending payments with recover_checkout first.",
        409,
        "RECEIPT_NOT_AVAILABLE",
      );
    }
    try {
      return await this.saveReceipt(entry);
    } catch (error) {
      if (error instanceof BuyerApiError) throw error;
      throw new BuyerApiError(
        "The local receipt could not be generated or saved. Check that the Downloads folder is writable and the completed order data is valid, then retry download_checkout_receipt. No payment was attempted.",
        500,
        "RECEIPT_SAVE_FAILED",
      );
    }
  }

  async #recordOrder(entry) {
    try {
      const response = await this.api.recordOrder({
        checkoutToken: entry.checkoutToken,
        type: "purchase",
        productIds: [
          ...new Set(entry.requestItems.map((item) => item.productId)),
        ],
        items: entry.requestItems,
        customer: entry.customer,
        externalOrderId: entry.intentId,
        txSignature: entry.signature,
        walletAddress: entry.walletAddress,
        paymentMethod: "USDC",
      });
      const order = response?.data;
      if (!order || order.externalOrderId !== entry.intentId) {
        throw new BuyerApiError(
          "WRHSE returned an invalid order response.",
          502,
          "INVALID_ORDER_RESPONSE",
        );
      }
      entry.order = {
        id: order.id,
        externalOrderId: order.externalOrderId,
        totalAmount: order.totalAmount,
        paymentMethod: order.paymentMethod,
        collectionCode: order.collectionCode,
        tickets: order.tickets,
        completedAt: new Date(this.now()).toISOString(),
      };
      entry.status = "completed";
      await this.store.save(entry);
      return this.#completedResult(entry);
    } catch (error) {
      entry.status = "paid_order_pending";
      await this.store.save(entry);
      return {
        status: "paid_order_pending",
        intentId: entry.intentId,
        signature: entry.signature,
        message:
          "Payment was verified, but WRHSE has not confirmed the order. Call recover_checkout; do not pay again.",
        code:
          typeof error?.code === "string"
            ? error.code
            : "ORDER_RECORDING_PENDING",
      };
    }
  }

  #quoteResult(entry) {
    return {
      status: entry.status,
      intentId: entry.intentId,
      walletAddress: entry.walletAddress,
      paymentMethod: entry.paymentMethod,
      items: entry.catalogItems,
      customer: entry.customer,
      totalUsdc: entry.total,
      expiresAt: entry.expiresAt,
      maximumUsdc: this.maxUsdc,
      approvalRequired: true,
    };
  }

  #completedResult(entry) {
    return { status: "completed", intentId: entry.intentId, ...entry.order };
  }

  async #withLock(intentId, task) {
    if (this.locks.has(intentId)) {
      throw new BuyerApiError(
        "This checkout operation is already in progress.",
        409,
        "CHECKOUT_IN_PROGRESS",
      );
    }
    const lock = Promise.resolve().then(task);
    this.locks.set(intentId, lock);
    try {
      return await lock;
    } finally {
      this.locks.delete(intentId);
    }
  }
}

export function newIdempotencyKey() {
  return randomUUID();
}
