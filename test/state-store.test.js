import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("failed writes do not leak unpersisted entries into memory or later saves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrhse-buyer-state-"));
  try {
    const blockerPath = join(directory, "not-a-directory");
    await writeFile(blockerPath, "blocker");
    const store = new PendingCheckoutStore(join(blockerPath, "pending.json"));
    const unpersisted = {
      intentId: "intent-unpersisted",
      checkoutToken: "token-unpersisted",
      walletAddress: "wallet",
    };

    await assert.rejects(store.save(unpersisted), /persist/);
    assert.equal(store.get(unpersisted.intentId), undefined);

    await rm(blockerPath);
    const persisted = {
      intentId: "intent-persisted",
      checkoutToken: "token-persisted",
      walletAddress: "wallet",
    };
    await store.save(persisted);

    assert.deepEqual(JSON.parse(await readFile(join(blockerPath, "pending.json"), "utf8")), {
      [persisted.intentId]: persisted,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed removals keep the persisted entry in memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrhse-buyer-state-"));
  const filePath = join(directory, "pending.json");
  try {
    const store = new PendingCheckoutStore(filePath);
    const entry = {
      intentId: "intent-1",
      checkoutToken: "token",
      walletAddress: "wallet",
    };
    await store.save(entry);
    await rm(filePath);
    await mkdir(filePath);

    await assert.rejects(store.remove(entry.intentId), /persist/);
    assert.deepEqual(store.get(entry.intentId), entry);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed updates preserve the previous entry despite caller mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrhse-buyer-state-"));
  const filePath = join(directory, "pending.json");
  try {
    const store = new PendingCheckoutStore(filePath);
    const original = {
      intentId: "intent-1",
      checkoutToken: "token",
      walletAddress: "wallet",
      status: "prepared",
    };
    await store.save(original);

    const updated = store.get(original.intentId);
    updated.status = "payment_pending";
    await rm(filePath);
    await mkdir(filePath);

    await assert.rejects(store.save(updated), /persist/);
    assert.deepEqual(store.get(original.intentId), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
