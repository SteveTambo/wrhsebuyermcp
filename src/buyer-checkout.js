import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import { createLocalWallet } from "./wallet.js";
import { BuyerApiError } from "./api.js";
import { logError } from "./logging.js";
import { saveCheckoutReceipt } from "./receipt.js";
import { assertSafeCheckoutTransaction } from "./transaction-guard.js";

const MAX_LINES = 20;
const MAX_QUANTITY = 20;
const MAX_LINE_QUANTITY = 10;
const MAX_CINEMA_SEATS = 10;
const SEAT_ID = /^[A-Z](?:[1-9]|[1-3][0-9]|40)$/;

function seatExists(seating, id) {
  const match = /^([A-Z])(\d+)$/.exec(id);
  return (
    Boolean(match) &&
    match[1].charCodeAt(0) - 65 < seating.rows &&
    Number(match[2]) <= seating.seatsPerRow
  );
}

function cinemaSeatAvailability(product, now = Date.now()) {
  const screening = product.cinemaScreening;
  if (!screening) {
    throw new BuyerApiError(
      "This product is not a cinema screening. Use its event ticket details instead.",
      400,
      "NOT_CINEMA_SCREENING",
    );
  }
  const seating = screening.seating;
  const checkedAt = new Date(now).toISOString();
  const salesCloseAt = Date.parse(screening.salesCloseAt);
  const unavailableSeats = Array.isArray(screening.takenSeats)
    ? [...new Set(screening.takenSeats)]
    : [];
  if (seating) {
    if (
      !Number.isInteger(seating.rows) ||
      seating.rows < 1 ||
      seating.rows > 26 ||
      !Number.isInteger(seating.seatsPerRow) ||
      seating.seatsPerRow < 1 ||
      seating.seatsPerRow > 40 ||
      !Array.isArray(screening.takenSeats)
    ) {
      throw new BuyerApiError(
        "WRHSE did not return a complete cinema seat map and availability. Refresh the screening and try again.",
        502,
        "CINEMA_AVAILABILITY_UNAVAILABLE",
      );
    }
  } else if (!Number.isFinite(product.quantity)) {
    throw new BuyerApiError(
      "WRHSE did not return the current general-admission ticket quantity. Refresh the screening and try again.",
      502,
      "CINEMA_AVAILABILITY_UNAVAILABLE",
    );
  }

  const closed =
    screening.status === "CANCELLED" ||
    !Number.isFinite(salesCloseAt) ||
    salesCloseAt <= now;
  const taken = new Set(
    seating
      ? unavailableSeats.filter((seat) => seatExists(seating, seat))
      : [],
  );
  const allSeatIds = seating
    ? Array.from({ length: seating.rows }, (_, rowIndex) =>
        Array.from(
          { length: seating.seatsPerRow },
          (_, index) => `${String.fromCharCode(65 + rowIndex)}${index + 1}`,
        ),
      ).flat()
    : [];
  const freeSeatIds = allSeatIds.filter((seat) => !taken.has(seat));
  const soldOut = seating
    ? freeSeatIds.length === 0
    : product.quantity <= 0;
  const status = closed
    ? screening.status === "CANCELLED"
      ? "cancelled"
      : "sales_closed"
    : soldOut
      ? "sold_out"
      : "on_sale";
  const availableSeats = status === "on_sale" ? freeSeatIds : [];
  const availableSet = new Set(availableSeats);
  const unavailableSeatIds = allSeatIds.filter(
    (seat) => !availableSet.has(seat),
  );
  const seatMap = seating
    ? Array.from({ length: seating.rows }, (_, rowIndex) => {
        const row = String.fromCharCode(65 + rowIndex);
        const seats = Array.from(
          { length: seating.seatsPerRow },
          (_, index) => {
            const id = `${row}${index + 1}`;
            return {
              id,
              status: availableSet.has(id)
                ? "available"
                : closed
                  ? "sales_closed"
                  : "taken",
            };
          },
        );
        return { row, seats };
      })
    : [];

  return {
    status,
    checkedAt,
    salesCloseAt: screening.salesCloseAt,
    seating: seating ?? null,
    availableCount: seating
      ? availableSeats.length
      : status === "on_sale"
        ? Math.max(0, product.quantity)
        : 0,
    unavailableCount: seating ? unavailableSeatIds.length : 0,
    availableSeatIds: availableSeats,
    unavailableSeatIds,
    seatMap,
  };
}

function ticketDetails(product, now = Date.now()) {
  const availability = product.cinemaScreening
    ? cinemaSeatAvailability(product, now)
    : null;
  return {
    ...(product.admissionKind ? { admissionKind: product.admissionKind } : {}),
    ...(product.eventStage ? { eventStage: product.eventStage } : {}),
    ...(product.eventDate ? { eventDate: product.eventDate } : {}),
    ...(product.cinemaScreening
      ? {
          cinemaScreening: {
            movieTitle: product.cinemaScreening.movieTitle,
            auditorium: product.cinemaScreening.auditorium,
            venueAddress: product.cinemaScreening.venueAddress,
            timezone: product.cinemaScreening.timezone,
            startsAt: product.cinemaScreening.startsAt,
            endsAt: product.cinemaScreening.endsAt,
            salesCloseAt: product.cinemaScreening.salesCloseAt,
            seating: product.cinemaScreening.seating,
            availability: {
              status: availability.status,
              checkedAt: availability.checkedAt,
              availableCount: availability.availableCount,
              seating: availability.seating,
            },
          },
        }
      : {}),
  };
}

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
    return Promise.all(
      results.slice(0, 10).map(async (product) => {
        const detail = await this.api.getProduct(product.id);
        const current = detail?.data;
        return {
          id: product.id,
          title: product.title,
          price: product.price,
          quantity: current?.quantity ?? product.quantity,
          sizes: current?.sizes ?? product.sizes,
          tenantSlug: product.tenantSlug,
          storeName: product.store?.name,
          area: product.area?.name,
          ...(current ? ticketDetails(current, this.now()) : {}),
        };
      }),
    );
  }

  async checkCinemaSeatAvailability({ productId }) {
    const result = await this.api.getProduct(productId);
    const product = result?.data;
    if (
      !product ||
      product.id !== productId ||
      product.isDraft ||
      product.archivedAt
    ) {
      throw new BuyerApiError(
        "The cinema screening could not be found or is no longer available.",
        404,
        "PRODUCT_NOT_FOUND",
      );
    }
    const availability = cinemaSeatAvailability(product, this.now());
    return {
      productId: product.id,
      title: product.title,
      movieTitle: product.cinemaScreening.movieTitle,
      auditorium: product.cinemaScreening.auditorium,
      venueAddress: product.cinemaScreening.venueAddress,
      timezone: product.cinemaScreening.timezone,
      startsAt: product.cinemaScreening.startsAt,
      endsAt: product.cinemaScreening.endsAt,
      ...availability,
      ...(availability.seating
        ? {
            instruction:
              "Show availableSeatIds to the buyer and ask them to choose. In seatMap, available means selectable, taken means held or sold, and sales_closed means no seats can be purchased. WRHSE rechecks and locks seats when preparing checkout, so availability may change.",
          }
        : {
            instruction:
              "This is general admission with no assigned seats. Use availableCount as the current ticket quantity; WRHSE rechecks inventory when preparing checkout.",
          }),
    };
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
    const selected = items.map(({ productId, quantity, size, seatIds }) => {
      if (
        seatIds !== undefined &&
        (!Array.isArray(seatIds) ||
          seatIds.length > MAX_CINEMA_SEATS ||
          seatIds.some(
            (seat) => typeof seat !== "string" || !SEAT_ID.test(seat),
          ))
      ) {
        throw new BuyerApiError(
          "Cinema seat IDs must use a valid row and seat number.",
          400,
          "CINEMA_SEATS_INVALID",
        );
      }
      return {
        productId,
        quantity,
        ...(size ? { size: size.trim() } : {}),
        ...(seatIds?.length ? { seatIds: [...seatIds] } : {}),
      };
    });
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
          (product.admissionKind != null &&
            product.admissionKind !== "CINEMA" &&
            product.eventStage == null) ||
          product.eventStage === "sold_out" ||
          (product.admissionKind === "CINEMA" && !product.cinemaScreening) ||
          (Array.isArray(product.acceptedPaymentMethods) &&
            !product.acceptedPaymentMethods.includes("USDC")),
      )
    ) {
      throw new BuyerApiError(
        "Only currently available products with supported WRHSE checkout details can be purchased.",
        400,
        "UNSUPPORTED_PRODUCT",
      );
    }
    const cinemaProducts = productDetails.filter(
      (product) => product.admissionKind === "CINEMA",
    );
    if (
      cinemaProducts.length &&
      (selected.length !== 1 ||
        new Set(selected.map((item) => item.productId)).size !== 1)
    ) {
      throw new BuyerApiError(
        "Buy one cinema screening per ticket checkout. Food needs a separate order.",
        400,
        "CINEMA_SEPARATE_CHECKOUT",
      );
    }
    const suppliedSeats = selected.flatMap((item) => item.seatIds ?? []);
    if (cinemaProducts.length) {
      const screening = cinemaProducts[0].cinemaScreening;
      if (screening.seating) {
        if (!Array.isArray(screening.takenSeats)) {
          throw new BuyerApiError(
            "WRHSE could not verify current seat availability. Refresh the screening and try again.",
            503,
            "CINEMA_AVAILABILITY_UNAVAILABLE",
          );
        }
        if (
          suppliedSeats.length !== totalQuantity(selected) ||
          suppliedSeats.length > MAX_CINEMA_SEATS ||
          new Set(suppliedSeats).size !== suppliedSeats.length ||
          suppliedSeats.some((seat) => !seatExists(screening.seating, seat))
        ) {
          throw new BuyerApiError(
            "Choose one unique seat for each cinema ticket (up to 10 seats).",
            400,
            "CINEMA_SEATS_INVALID",
          );
        }
      } else if (suppliedSeats.length) {
        throw new BuyerApiError(
          "This cinema screening does not have reserved seating.",
          400,
          "CINEMA_SEATS_INVALID",
        );
      }
    } else if (suppliedSeats.length) {
      throw new BuyerApiError(
        "Seat IDs can only be used for a reserved-seat cinema screening.",
        400,
        "CINEMA_SEATS_INVALID",
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

    // Do not send walletAddress here: WRHSE pre-builds a payment transaction
    // whenever it is present, and IVANA then refuses the build that the
    // checkout SDK performs at payment time ("A transaction was already
    // issued"). IVANA binds the burner wallet when the SDK builds the
    // transaction, before anything is signed.
    const intent = await this.api.createIntent({
      checkoutProtocol: 1,
      ...(cinemaProducts.length ? { cinemaCheckout: true } : {}),
      customer: normalizedCustomer,
      lineItems: selected,
      idempotencyKey,
      paymentMethod: "USDC",
      paymentChain: "solana",
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
      catalogItems: quote.catalogItems.map((item) => {
        const seatIds = selected
          .filter((requested) => requested.productId === item.productId)
          .flatMap((requested) => requested.seatIds ?? []);
        return seatIds.length ? { ...item, seatIds } : item;
      }),
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
      if (entry.walletAddress !== this.keypair.publicKey.toBase58()) {
        throw new BuyerApiError(
          "This checkout was prepared for a different burner wallet. Prepare a new checkout.",
          409,
          "CHECKOUT_WALLET_MISMATCH",
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
      let signedSignature;
      let paymentRejected = false;
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
          signedSignature = bs58.encode(transaction.signature);
        },
      });

      try {
        const result = await checkout.pay({
          intentId,
          wallet,
          paymentMethod: "USDC",
          onSignature: async (signature, blockhash) => {
            if (signedSignature !== signature) {
              throw new Error(
                "The signed transaction signature did not match.",
              );
            }
            entry.signature = signature;
            entry.lastValidBlockHeight = blockhash.lastValidBlockHeight;
            entry.status = "payment_pending";
            await this.store.save(entry);
          },
          onRetry: async () => {
            signedSignature = undefined;
            entry.signature = undefined;
            entry.lastValidBlockHeight = null;
            entry.status = "paying";
            await this.store.save(entry);
          },
          onRejected: async () => {
            paymentRejected = true;
            signedSignature = undefined;
            entry.signature = undefined;
            entry.lastValidBlockHeight = null;
            entry.status = "payment_failed";
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
        logError("payment_execution_failed", error, {
          tool: "purchase_checkout",
          intentId,
        });
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
          message: paymentRejected
            ? "The Solana node rejected the transaction before broadcasting it, so no payment was sent. This checkout cannot be paid again. WRHSE may keep its cinema seat hold until the payment window expires and on-chain checks confirm it is safe to release. Refresh availability before choosing seats again; if the hold remains, wait for WRHSE to clear it."
            : "No payment transaction was broadcast, so no payment was sent. This checkout cannot be paid again. WRHSE may keep its cinema seat hold until the payment window expires and on-chain checks confirm it is safe to release. Refresh availability before choosing seats again; if the hold remains, wait for WRHSE to clear it.",
          code: typeof error?.code === "string" ? error.code : "PAYMENT_FAILED",
          intentId,
          checkoutExpiresAt: entry.expiresAt,
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
      if (entry.status === "paying" && !entry.signature) {
        entry.status = "payment_failed";
        await this.store.save(entry);
        return {
          status: "payment_failed",
          intentId,
          code: "PAYMENT_FAILED",
          message:
            "The previous payment attempt stopped before a transaction signature was saved. No payment was broadcast; prepare a new checkout.",
        };
      }
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
    const receipt = await this.#ensureReceipt(entry);
    if (receipt.status !== "saved") {
      throw new BuyerApiError(
        "The local receipt could not be generated or saved. Check that the Downloads folder is writable and the completed order data is valid, then retry download_checkout_receipt. No payment was attempted.",
        500,
        "RECEIPT_SAVE_FAILED",
      );
    }
    return receipt;
  }

  async #ensureReceipt(entry) {
    if (entry.receipt?.status === "saved") return entry.receipt;
    try {
      const receipt = await this.saveReceipt(entry);
      entry.receipt = receipt;
      await this.store.save(entry);
      return receipt;
    } catch (error) {
      logError("receipt_generation_failed", error, {
        tool: "purchase_checkout",
        intentId: entry.intentId,
      });
      return {
        status: "failed",
        code: "RECEIPT_SAVE_FAILED",
        message:
          "The order is complete, but its local PDF receipt could not be saved. No payment was attempted; retry download_checkout_receipt.",
      };
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

  async #completedResult(entry) {
    const receipt = await this.#ensureReceipt(entry);
    const tickets = Array.isArray(entry.order.tickets)
      ? entry.order.tickets.map(
          ({
            productTitle,
            productId,
            eventStage,
            eventDate,
            admissionKind,
            cinema,
            seat,
          }) => ({
            productTitle,
            productId,
            eventStage,
            eventDate,
            admissionKind,
            cinema,
            seat,
          }),
        )
      : entry.order.tickets;
    return {
      status: "completed",
      intentId: entry.intentId,
      ...entry.order,
      ...(Array.isArray(tickets) ? { tickets } : {}),
      totalUsdc: entry.total,
      orderSubtotalUsdc: entry.order.totalAmount,
      receipt,
    };
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
