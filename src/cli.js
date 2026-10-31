#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFile } from "node:fs/promises";
import { registerBuyerMcp } from "./copilot-config.js";

const command = process.argv[2];

if (command === "setup") {
  for (const name of [
    "WRHSE_BUYER_AGENT_KEY",
    "WRHSE_BUYER_SOLANA_SECRET_KEY",
  ]) {
    if (!process.env[name]?.trim()) {
      throw new Error(
        `${name} is not available in this terminal. Restart the terminal after setting it, then rerun setup.`,
      );
    }
  }

  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const existingConfig = await registerBuyerMcp({
    version: packageJson.version,
  });
  let result = existingConfig;

  if (!existingConfig.configured && existingConfig.reason === "already-configured") {
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await prompt.question(
        "A wrhse-buyer MCP server is already configured. Replace it? (y/N) ",
      );
      if (/^(y|yes)$/i.test(answer.trim())) {
        result = await registerBuyerMcp({
          version: packageJson.version,
          replaceExisting: true,
        });
      }
    } finally {
      prompt.close();
    }
  }

  if (!result.configured) {
    console.log("Kept the existing wrhse-buyer MCP configuration.");
  } else {
    console.log(`Configured wrhse-buyer in ${result.configPath}`);
    if (result.backupPath) console.log(`Previous config backed up to ${result.backupPath}`);
    console.log("Restart Copilot CLI to load the updated MCP server configuration.");
  }
} else if (command === "start") {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (
      args.length === 1 &&
      args[0] ===
        "bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)"
    ) {
      return;
    }
    originalWarn.apply(console, args);
  };
  await import("./main.js");
} else {
  console.log("Usage: wrhse-buyer-mcp <setup|start>");
  process.exitCode = 2;
}
