import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCheckoutReceipt } from "../src/receipt.js";

function completedEntry(overrides = {}) {
  return {
    status: "completed",
    intentId: "intent-1",
    createdAt: "2025-01-02T03:04:05.000Z",
    total: 23.52,
    catalogItems: [
      {
        productId: 8,
        title: "Test shirt",
        quantity: 2,
        unitPriceUsdc: 10,
      },
    ],
    customer: { name: "Test Buyer", email: "buyer@example.test" },
    signature: "transaction-signature",
    order: {
      id: "../unsafe/order-id",
      totalAmount: 20,
      paymentMethod: "USDC",
      collectionCode: "pickup-code",
      completedAt: "2025-01-02T03:05:00.000Z",
    },
    ...overrides,
  };
}

test("saves a completed checkout PDF with its collection QR locally", async (t) => {
  const downloadsDirectory = await mkdtemp(join(tmpdir(), "wrhse-receipt-"));
  t.after(() => rm(downloadsDirectory, { recursive: true, force: true }));

  const result = await saveCheckoutReceipt(completedEntry(), {
    downloadsDirectory,
  });
  const pdf = await readFile(result.filePath);
  const contents = pdf.toString("latin1");

  assert.equal(result.status, "saved");
  assert.equal(result.orderId, "../unsafe/order-id");
  assert.equal(result.collectionQrIncluded, true);
  assert.match(result.message, /keep it private/);
  assert.match(result.filePath, /wrhse-receipt-___unsafe_order-id\.pdf$/);
  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.match(contents, /\/Subtype\s*\/Image/);
  assert.match(contents, /23\.52 USDC/);
  assert.match(contents, /Test shirt/);
});

test("saves a receipt without a QR when no collection code exists", async (t) => {
  const downloadsDirectory = await mkdtemp(join(tmpdir(), "wrhse-receipt-"));
  t.after(() => rm(downloadsDirectory, { recursive: true, force: true }));

  const result = await saveCheckoutReceipt(
    completedEntry({
      order: {
        id: 12,
        totalAmount: 20,
        paymentMethod: "USDC",
        collectionCode: null,
      },
    }),
    { downloadsDirectory },
  );
  const contents = (await readFile(result.filePath)).toString("latin1");

  assert.equal(result.collectionQrIncluded, false);
  assert.match(result.message, /no collection QR code was added/);
  assert.doesNotMatch(contents, /\/Subtype\s*\/Image/);
});

test("does not create receipts for incomplete checkouts", async (t) => {
  const downloadsDirectory = await mkdtemp(join(tmpdir(), "wrhse-receipt-"));
  t.after(() => rm(downloadsDirectory, { recursive: true, force: true }));

  await assert.rejects(
    saveCheckoutReceipt(
      completedEntry({ status: "payment_pending" }),
      { downloadsDirectory },
    ),
    /only be generated for a completed order/,
  );
});
