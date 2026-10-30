import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { jsPDF } from "jspdf";
import QRCode from "qrcode";

const COLLECTION_BASE_URL = "https://www.wrhse.top/collect/";
const VAT_RATE = 0.16;
const TRANSACTION_FEE_RATE = 0.016;
const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const LEFT = 18;
const RIGHT = 192;
const FOOTER_Y = PAGE_HEIGHT - 12;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function money(cents) {
  return `${(cents / 100).toFixed(2)} USDC`;
}

function productRows(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("The completed checkout has no receipt items.");
  }
  return items.map((item) => {
    const quantity = Number(item?.quantity);
    const unitPriceCents = Math.round(Number(item?.unitPriceUsdc) * 100);
    const title = text(item?.title) || `Product ${item?.productId ?? ""}`;
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      !Number.isInteger(unitPriceCents) ||
      unitPriceCents < 0
    ) {
      throw new Error("The completed checkout contains invalid receipt items.");
    }
    return {
      title: `${title}${text(item?.size) ? ` (Size: ${text(item.size)})` : ""}`,
      quantity,
      unitPriceCents,
      lineTotalCents: unitPriceCents * quantity,
    };
  });
}

function drawHeader(doc, continued = false) {
  doc.setFillColor(0, 0, 0);
  doc.rect(0, 0, PAGE_WIDTH, 34, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(23);
  doc.text("wrhse", LEFT, 21);
  doc.setFontSize(13);
  doc.text(continued ? "RECEIPT CONTINUED" : "RECEIPT COPY", RIGHT, 17, {
    align: "right",
  });
  doc.setFont("helvetica", "normal");
  doc.setTextColor(190, 190, 190);
  doc.setFontSize(9);
  doc.text("wrhse.top - generated locally", RIGHT, 24, { align: "right" });
}

function drawFooter(doc, pageNumber, totalPages) {
  doc.setFillColor(17, 17, 17);
  doc.rect(0, FOOTER_Y, PAGE_WIDTH, 12, "F");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(230, 230, 230);
  doc.text(
    "Keep the collection QR private. Questions? Contact the seller.",
    LEFT,
    FOOTER_Y + 7.5,
  );
  doc.text(`${pageNumber} / ${totalPages}`, RIGHT, FOOTER_Y + 7.5, {
    align: "right",
  });
}

function drawLabel(doc, label, value, x, y, width) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  doc.setTextColor(110, 110, 110);
  doc.text(label.toUpperCase(), x, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(35, 35, 35);
  const lines = doc.splitTextToSize(value, width);
  doc.text(lines, x, y + 5);
  return Math.max(1, lines.length) * 4 + 7;
}

export async function saveCheckoutReceipt(
  entry,
  { downloadsDirectory = join(homedir(), "Downloads") } = {},
) {
  if (entry?.status !== "completed" || !entry.order) {
    throw new Error("A receipt can only be generated for a completed order.");
  }
  const items = productRows(entry.catalogItems);
  const totalCents = Math.round(Number(entry.total) * 100);
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new Error("The completed checkout has an invalid paid total.");
  }

  const subtotalCents = items.reduce(
    (sum, item) => sum + item.lineTotalCents,
    0,
  );
  const vatCents = Math.round(subtotalCents * VAT_RATE);
  const feeCents = Math.round(subtotalCents * TRANSACTION_FEE_RATE);
  const hasKnownBreakdown = subtotalCents + vatCents + feeCents === totalCents;
  const customer = entry.customer ?? {};
  const rawOrderId = entry.order.id ?? entry.intentId;
  const orderId = rawOrderId == null ? "" : text(String(rawOrderId));
  const completedDate = new Date(
    entry.order.completedAt || entry.createdAt || Date.now(),
  );
  const signature = text(entry.signature);
  const collectionCode = text(entry.order.collectionCode);
  const collectionUrl = collectionCode
    ? `${COLLECTION_BASE_URL}${encodeURIComponent(collectionCode)}`
    : null;

  const doc = new jsPDF({ format: "a4", unit: "mm" });
  let pageNumber = 1;
  let y = 44;
  const pageBottom = FOOTER_Y - 10;

  const addPage = () => {
    drawFooter(doc, pageNumber, pageNumber);
    doc.addPage();
    pageNumber += 1;
    drawHeader(doc, true);
    y = 44;
  };
  const ensureRoom = (height) => {
    if (y + height > pageBottom) addPage();
  };
  const drawSectionTitle = (title) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(25, 25, 25);
    doc.text(title, LEFT, y);
    y += 7;
  };

  drawHeader(doc);
  doc.setFillColor(232, 243, 233);
  doc.setDrawColor(46, 125, 50);
  doc.roundedRect(LEFT, y, 24, 8, 3, 3, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(31, 90, 36);
  doc.text("PAID", LEFT + 12, y + 5.3, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.text("Thank you for your order", RIGHT, y + 5.3, { align: "right" });
  y += 14;

  drawSectionTitle("ORDER DETAILS");
  const details = [
    ["Order", orderId],
    [
      "Date",
      Number.isNaN(completedDate.getTime())
        ? "Not available"
        : completedDate.toLocaleString(),
    ],
    ["Payment", text(entry.order.paymentMethod) || "USDC"],
  ];
  for (const [label, value] of details) {
    ensureRoom(13);
    y += drawLabel(doc, label, value, LEFT, y, RIGHT - LEFT);
  }

  const buyerDetails = [
    ["Name", customer.name],
    ["Email", customer.email],
    ["Phone", customer.phone],
    [
      "Delivery address",
      [customer.address, customer.city, customer.province, customer.country]
        .map(text)
        .filter(Boolean)
        .join(", "),
    ],
  ].filter(([, value]) => text(value));
  if (buyerDetails.length) {
    ensureRoom(10);
    y += 2;
    drawSectionTitle("CUSTOMER");
    for (const [label, value] of buyerDetails) {
      const lines = doc.splitTextToSize(text(value), RIGHT - LEFT);
      ensureRoom(lines.length * 4 + 10);
      y += drawLabel(doc, label, text(value), LEFT, y, RIGHT - LEFT);
    }
  }

  ensureRoom(22);
  y += 2;
  drawSectionTitle("ITEMS");
  doc.setFillColor(245, 245, 245);
  doc.rect(LEFT, y - 2, RIGHT - LEFT, 8, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(70, 70, 70);
  doc.text("PRODUCT", LEFT + 2, y + 3);
  doc.text("QTY", 143, y + 3, { align: "right" });
  doc.text("UNIT", 166, y + 3, { align: "right" });
  doc.text("AMOUNT", RIGHT - 2, y + 3, { align: "right" });
  y += 9;

  for (const item of items) {
    const titleLines = doc.splitTextToSize(item.title, 105);
    const rowHeight = Math.max(9, titleLines.length * 4 + 4);
    ensureRoom(rowHeight);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(45, 45, 45);
    doc.text(titleLines, LEFT + 2, y + 3);
    doc.text(String(item.quantity), 143, y + 3, { align: "right" });
    doc.text(money(item.unitPriceCents), 166, y + 3, { align: "right" });
    doc.text(money(item.lineTotalCents), RIGHT - 2, y + 3, {
      align: "right",
    });
    y += rowHeight;
    doc.setDrawColor(225, 225, 225);
    doc.line(LEFT, y, RIGHT, y);
  }

  ensureRoom(hasKnownBreakdown ? 45 : 28);
  y += 5;
  if (hasKnownBreakdown) {
    for (const [label, amount] of [
      ["Subtotal", subtotalCents],
      ["VAT (16%)", vatCents],
      ["Transaction fee (1.6%)", feeCents],
    ]) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(75, 75, 75);
      doc.text(label, 125, y);
      doc.text(money(amount), RIGHT, y, { align: "right" });
      y += 6;
    }
  }
  doc.setDrawColor(40, 40, 40);
  doc.line(120, y, RIGHT, y);
  y += 7;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  doc.text("TOTAL PAID", 125, y);
  doc.text(money(totalCents), RIGHT, y, { align: "right" });
  y += 10;

  if (signature) {
    const paymentUrl = new URL(
      `/tx/${encodeURIComponent(signature)}`,
      "https://solscan.io",
    );
    paymentUrl.searchParams.set("cluster", "devnet");
    const linkLines = doc.splitTextToSize(paymentUrl.toString(), RIGHT - LEFT);
    ensureRoom(10 + linkLines.length * 4);
    drawSectionTitle("PAYMENT REFERENCE");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(0, 77, 153);
    doc.text(linkLines, LEFT, y);
    doc.link(LEFT, y - 3, RIGHT - LEFT, linkLines.length * 4, {
      url: paymentUrl.toString(),
    });
    y += linkLines.length * 4 + 3;
  }

  let qrIncluded = false;
  if (collectionUrl) {
    ensureRoom(61);
    drawSectionTitle("COLLECTION");
    const qr = await QRCode.toDataURL(collectionUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
    });
    doc.addImage(qr, "PNG", LEFT, y, 40, 40);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(35, 35, 35);
    doc.text("Show this QR code when collecting your order.", LEFT + 47, y + 7);
    doc.setFont("courier", "normal");
    doc.setFontSize(9);
    doc.text(
      doc.splitTextToSize(collectionCode, RIGHT - LEFT - 50),
      LEFT + 47,
      y + 15,
    );
    qrIncluded = true;
  }

  for (let page = 1; page <= pageNumber; page += 1) {
    doc.setPage(page);
    drawFooter(doc, page, pageNumber);
  }

  const filenameId = orderId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  if (!filenameId) throw new Error("The completed order ID is invalid.");
  const filePath = join(downloadsDirectory, `wrhse-receipt-${filenameId}.pdf`);
  await mkdir(downloadsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(filePath, new Uint8Array(doc.output("arraybuffer")), {
    mode: 0o600,
  });

  return {
    status: "saved",
    orderId,
    filePath,
    collectionQrIncluded: qrIncluded,
    message: qrIncluded
      ? "Receipt saved locally. The PDF contains a collection QR code; keep it private and share it only with the person collecting the order."
      : "Receipt saved locally. WRHSE did not return a collection code, so no collection QR code was added.",
  };
}
