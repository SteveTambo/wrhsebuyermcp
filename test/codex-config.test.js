import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { registerBuyerCodexMcp } from "../src/codex-config.js";

async function withConfig(run) {
  const directory = await mkdtemp(join(tmpdir(), "wrhse-buyer-codex-"));
  try {
    await run(join(directory, "config.toml"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("registers Codex buyer MCP without writing secret values or losing config", async () => {
  await withConfig(async (configPath) => {
    await writeFile(
      configPath,
      '# existing comment\n[mcp_servers.other]\ncommand = "node"\nargs = ["server.js"]\n',
    );
    const result = await registerBuyerCodexMcp({
      configPath,
      version: "0.1.13",
    });
    const text = await readFile(configPath, "utf8");
    const config = parse(text);

    assert.equal(result.configured, true);
    assert.match(text, /existing comment/);
    assert.deepEqual(config.mcp_servers.other.args, ["server.js"]);
    assert.deepEqual(config.mcp_servers["wrhse-buyer"].env_vars, [
      "WRHSE_BUYER_AGENT_KEY",
      "WRHSE_BUYER_SOLANA_SECRET_KEY",
    ]);
    assert.equal(
      config.mcp_servers["wrhse-buyer"].tools.purchase_checkout.approval_mode,
      "prompt",
    );
    assert.equal(text.includes("secret-value"), false);

    const repeat = await registerBuyerCodexMcp({
      configPath,
      version: "0.1.13",
    });
    assert.deepEqual(repeat, {
      configured: false,
      configPath,
      reason: "already-current",
    });
  });
});

test("keeps an existing buyer server unless replacement is requested", async () => {
  await withConfig(async (configPath) => {
    await writeFile(
      configPath,
      '[mcp_servers."wrhse-buyer"]\ncommand = "custom"\nargs = []\n',
    );
    const result = await registerBuyerCodexMcp({
      configPath,
      version: "0.1.13",
    });
    assert.equal(result.reason, "already-configured");
    assert.equal(
      parse(await readFile(configPath, "utf8")).mcp_servers["wrhse-buyer"]
        .command,
      "custom",
    );
  });
});

test("does not modify unsupported inline Codex MCP configuration", async () => {
  await withConfig(async (configPath) => {
    const existing = 'mcp_servers = { other = { command = "node" } }\n';
    await writeFile(configPath, existing);
    await assert.rejects(
      registerBuyerCodexMcp({ configPath, version: "0.1.13" }),
      /inline mcp_servers table/,
    );
    assert.equal(await readFile(configPath, "utf8"), existing);
  });
});
