import {
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function getCopilotConfigPath(env = process.env) {
  const copilotHome = env.COPILOT_HOME || join(homedir(), ".copilot");
  return join(copilotHome, "mcp-config.json");
}

export async function registerBuyerMcp({
  configPath = getCopilotConfigPath(),
  version,
  replaceExisting = false,
}) {
  if (!version) throw new Error("An MCP package version is required.");

  let config = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read the Copilot MCP config at ${configPath}.`, {
        cause: error,
      });
    }
  }

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`The Copilot MCP config must be a JSON object: ${configPath}`);
  }
  if (
    config.mcpServers !== undefined &&
    (!config.mcpServers ||
      typeof config.mcpServers !== "object" ||
      Array.isArray(config.mcpServers))
  ) {
    throw new Error(`The mcpServers setting must be an object: ${configPath}`);
  }

  const servers = config.mcpServers ?? {};
  if (Object.hasOwn(servers, "wrhse-buyer") && !replaceExisting) {
    return { configured: false, configPath, reason: "already-configured" };
  }

  config.mcpServers = {
    ...servers,
    "wrhse-buyer": {
      type: "stdio",
      command: "npx",
      args: ["--yes", `wrhse-buyer-mcp@${version}`, "start"],
    },
  };

  await mkdir(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  const backupPath = `${configPath}.bak-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")}-${process.pid}`;
  let existingConfig = false;
  try {
    await copyFile(configPath, backupPath);
    existingConfig = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not back up the Copilot MCP config at ${configPath}.`, {
        cause: error,
      });
    }
  }

  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, configPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        throw new Error(
          `Could not write or clean up the temporary Copilot MCP config at ${temporaryPath}.`,
          { cause: cleanupError },
        );
      }
    }
    throw new Error(`Could not write the Copilot MCP config at ${configPath}.`, {
      cause: error,
    });
  }

  return {
    configured: true,
    configPath,
    backupPath: existingConfig ? backupPath : undefined,
  };
}
