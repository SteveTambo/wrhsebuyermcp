import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBuyerMcp } from "../src/copilot-config.js";

test("adds the versioned buyer server and preserves existing Copilot servers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wrhse-copilot-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "mcp-config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: { merchant: { command: "node", args: ["merchant.js"] } },
      otherConfig: true,
    }),
  );

  const result = await registerBuyerMcp({ configPath, version: "0.1.0" });
  const config = JSON.parse(await readFile(configPath, "utf8"));

  assert.equal(result.configured, true);
  assert.deepEqual(config.mcpServers.merchant, {
    command: "node",
    args: ["merchant.js"],
  });
  assert.deepEqual(config.mcpServers["wrhse-buyer"], {
    type: "stdio",
    command: "npx",
    args: ["--yes", "wrhse-buyer-mcp@0.1.0", "start"],
  });
  assert.equal(config.otherConfig, true);
  assert.ok(result.backupPath);
});

test("does not replace an existing buyer server without confirmation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wrhse-copilot-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "mcp-config.json");
  const original = {
    mcpServers: { "wrhse-buyer": { command: "custom" } },
  };
  await writeFile(configPath, JSON.stringify(original));

  const result = await registerBuyerMcp({ configPath, version: "0.1.0" });

  assert.deepEqual(result, {
    configured: false,
    configPath,
    reason: "already-configured",
  });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), original);
});

test("creates a user Copilot config when none exists", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wrhse-copilot-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "nested", "mcp-config.json");

  const result = await registerBuyerMcp({ configPath, version: "0.1.0" });

  assert.equal(result.configured, true);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    mcpServers: {
      "wrhse-buyer": {
        type: "stdio",
        command: "npx",
        args: ["--yes", "wrhse-buyer-mcp@0.1.0", "start"],
      },
    },
  });
});
