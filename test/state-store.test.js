import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingCheckoutStore } from "../src/state-store.js";

test("persists only local recovery state and reloads pending checkouts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrhse-buyer-state-"));
  const filePath = join(directory, "pending.json");
  try {
    const first = new PendingCheckoutStore(filePath);
    const entry = {
      intentId: "intent-1",
      checkoutToken: "one-intent-token",
      walletAddress: "public-wallet-address",
      status: "payment_pending",
      signature: "public-transaction-signature",
    };
    await first.save(entry);
    const saved = await readFile(filePath, "utf8");
    assert.equal(saved.includes("privateKey"), false);

    const second = new PendingCheckoutStore(filePath);
    await second.load();
    assert.deepEqual(second.get("intent-1"), entry);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads an absent recovery file and rejects corrupt recovery state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrhse-buyer-state-"));
  try {
    const absent = new PendingCheckoutStore(join(directory, "absent.json"));
    await assert.doesNotReject(absent.load());

    const corruptPath = join(directory, "corrupt.json");
    await writeFile(corruptPath, "{not-json");
    const corrupt = new PendingCheckoutStore(corruptPath);
    await assert.rejects(corrupt.load(), /Could not read/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
