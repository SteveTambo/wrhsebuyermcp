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
import { parse } from "smol-toml";

const SERVER_NAME = "wrhse-buyer";
const ENV_VARS = ["WRHSE_BUYER_AGENT_KEY", "WRHSE_BUYER_SOLANA_SECRET_KEY"];

export function getCodexConfigPath(env = process.env) {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

function buyerConfig(version) {
  return {
    command: "npx",
    args: ["--yes", `wrhse-buyer-mcp@${version}`, "start"],
    env_vars: ENV_VARS,
    startup_timeout_sec: 30,
    tool_timeout_sec: 180,
    tools: { purchase_checkout: { approval_mode: "prompt" } },
  };
}

function isCurrent(config, version) {
  const expected = buyerConfig(version);
  const actual = config?.mcp_servers?.[SERVER_NAME];
  return (
    actual?.command === expected.command &&
    JSON.stringify(actual?.args) === JSON.stringify(expected.args) &&
    JSON.stringify(actual?.env_vars) === JSON.stringify(expected.env_vars) &&
    actual?.tools?.purchase_checkout?.approval_mode === "prompt"
  );
}

function blockFor(version) {
  return [
    `[mcp_servers."${SERVER_NAME}"]`,
    'command = "npx"',
    `args = ["--yes", "wrhse-buyer-mcp@${version}", "start"]`,
    `env_vars = [${ENV_VARS.map((name) => `"${name}"`).join(", ")}]`,
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 180",
    "",
    `[mcp_servers."${SERVER_NAME}".tools.purchase_checkout]`,
    'approval_mode = "prompt"',
    "",
  ].join("\n");
}

const rootHeader =
  /^\s*\[mcp_servers\.(?:"wrhse-buyer"|wrhse-buyer)\]\s*(?:#.*)?$/;
const childHeader = /^\s*\[+mcp_servers\.(?:"wrhse-buyer"|wrhse-buyer)\./;
const anyTableHeader = /^\s*\[\[?.+\]\]?\s*(?:#.*)?$/;

function updateConfigText(source, { replacing, version }) {
  const lines = source ? source.split(/\r?\n/) : [];
  const rootIndex = lines.findIndex((line) => rootHeader.test(line));

  if (replacing && rootIndex < 0) {
    throw new Error(
      'The existing wrhse-buyer entry is not a standalone TOML table. Edit or remove it manually before running "setup --client codex".',
    );
  }

  if (!replacing && lines.some((line) => /^\s*mcp_servers\s*=/.test(line))) {
    throw new Error(
      "Codex has an inline mcp_servers table that cannot be extended safely. Add the buyer server manually using the README instructions.",
    );
  }

  if (replacing) {
    let end = rootIndex + 1;
    while (end < lines.length) {
      if (anyTableHeader.test(lines[end]) && !childHeader.test(lines[end]))
        break;
      end += 1;
    }
    lines.splice(
      rootIndex,
      end - rootIndex,
      ...blockFor(version).trimEnd().split("\n"),
    );
    return `${lines.join("\n").replace(/\n*$/, "\n")}`;
  }

  const body = blockFor(version);
  return `${source.trimEnd()}${source.trim() ? "\n\n" : ""}${body}`;
}

export async function registerBuyerCodexMcp({
  configPath = getCodexConfigPath(),
  version,
  replaceExisting = false,
}) {
  if (!version) throw new Error("An MCP package version is required.");

  let source = "";
  let parsed = {};
  try {
    source = await readFile(configPath, "utf8");
    parsed = parse(source);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read the Codex config at ${configPath}.`, {
        cause: error,
      });
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`The Codex config must be a TOML table: ${configPath}`);
  }

  const existing = parsed.mcp_servers?.[SERVER_NAME];
  if (existing && isCurrent(parsed, version)) {
    return { configured: false, configPath, reason: "already-current" };
  }
  if (existing && !replaceExisting) {
    return { configured: false, configPath, reason: "already-configured" };
  }

  const next = updateConfigText(source, {
    replacing: Boolean(existing),
    version,
  });
  try {
    parse(next);
  } catch (error) {
    throw new Error(
      `Could not safely update the Codex config at ${configPath}.`,
      {
        cause: error,
      },
    );
  }

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
      throw new Error(`Could not back up the Codex config at ${configPath}.`, {
        cause: error,
      });
    }
  }

  try {
    await writeFile(temporaryPath, next, {
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
          `Could not write or clean up the temporary Codex config at ${temporaryPath}.`,
          { cause: cleanupError },
        );
      }
    }
    throw new Error(`Could not write the Codex config at ${configPath}.`, {
      cause: error,
    });
  }

  return {
    configured: true,
    configPath,
    backupPath: existingConfig ? backupPath : undefined,
  };
}
