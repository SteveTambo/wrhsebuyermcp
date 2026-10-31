import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class PendingCheckoutStore {
  #writeQueue = Promise.resolve();

  constructor(filePath) {
    this.filePath = filePath;
    this.entries = new Map();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid recovery state.");
      }
      for (const [intentId, value] of Object.entries(parsed)) {
        if (
          !value ||
          value.intentId !== intentId ||
          typeof value.checkoutToken !== "string" ||
          typeof value.walletAddress !== "string"
        ) {
          throw new Error("Invalid recovery state.");
        }
        this.entries.set(intentId, value);
      }
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw new Error("Could not read the local checkout recovery file.");
    }
  }

  get(intentId) {
    const entry = this.entries.get(intentId);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  list() {
    return [...this.entries.values()].map((entry) => structuredClone(entry));
  }

  async save(entry) {
    const savedEntry = structuredClone(entry);
    await this.#update((entries) =>
      entries.set(savedEntry.intentId, savedEntry),
    );
  }

  async remove(intentId) {
    await this.#update((entries) => entries.delete(intentId));
  }

  async #update(update) {
    const operation = this.#writeQueue.then(async () => {
      const entries = new Map(this.entries);
      update(entries);
      await this.#flush(entries);
      this.entries = entries;
    });
    this.#writeQueue = operation.catch(() => {});
    await operation;
  }

  async #flush(entries) {
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await writeFile(
        tempPath,
        JSON.stringify(Object.fromEntries(entries), null, 2),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await rename(tempPath, this.filePath);
    } catch {
      try {
        await unlink(tempPath);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") {
          throw new Error(
            "Could not safely persist or clean up local checkout recovery state.",
          );
        }
      }
      throw new Error(
        "Could not safely persist local checkout recovery state.",
      );
    }
  }
}
