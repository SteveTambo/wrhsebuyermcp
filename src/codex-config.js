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
const APPROVAL_CATEGORIES = [
  "sandbox_approval",
  "rules",
  "mcp_elicitations",
  "request_permissions",
  "skill_approval",
];

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
    actual?.tools?.purchase_checkout?.approval_mode === "prompt" &&
    config?.approval_policy?.granular?.mcp_elicitations === true
  );
}

function buyerApprovalPolicy(config) {
  const current = config.approval_policy;
  if (current === "never") {
    return {
      granular: Object.fromEntries(
        APPROVAL_CATEGORIES.map((category) => [
          category,
          category === "mcp_elicitations",
        ]),
      ),
    };
  }
  if (current === "on-request") {
    return {
      granular: Object.fromEntries(
        APPROVAL_CATEGORIES.map((category) => [category, true]),
      ),
    };
  }
  if (current === undefined) {
    // Make the buyer's approval form available while leaving every other
    // category to Codex's existing default behavior.
    return { granular: { mcp_elicitations: true } };
  }
  if (
    !current ||
    typeof current !== "object" ||
    Array.isArray(current) ||
    !current.granular ||
    typeof current.granular !== "object" ||
    Array.isArray(current.granular)
  ) {
    throw new Error(
      "The Codex approval_policy has an unsupported format. Set approval_policy.granular.mcp_elicitations = true before running setup again.",
    );
  }

  const granular = { ...current.granular, mcp_elicitations: true };
  if (Object.keys(granular).some((key) => !APPROVAL_CATEGORIES.includes(key))) {
    throw new Error(
      "The Codex approval_policy contains an unsupported granular category. Update it manually and run setup again.",
    );
  }
  return { ...current, granular };
}

function renderApprovalPolicy(config) {
  const policy = buyerApprovalPolicy(config);
  const values = APPROVAL_CATEGORIES.filter((category) =>
    Object.hasOwn(policy.granular, category),
  ).map((category) => `${category} = ${policy.granular[category]}`);
  return `approval_policy = { granular = { ${values.join(", ")} } }`;
}

function tomlValueHasOpenTable(lines) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const line of lines) {
    for (const character of line) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && quoted) {
        escaped = true;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        continue;
      }
      if (!quoted && character === "#") break;
      if (!quoted && character === "{") depth += 1;
      if (!quoted && character === "}") depth -= 1;
    }
  }
  return depth > 0;
}

function setBuyerApprovalPolicy(source, config) {
  const lines = source ? source.split(/\r?\n/) : [];
  let start = -1;
  let end = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break;
    if (/^\s*approval_policy\s*=/.test(lines[index])) {
      start = index;
      end = index;
      while (tomlValueHasOpenTable(lines.slice(start, end + 1))) end += 1;
      if (end >= lines.length) {
        throw new Error("The Codex approval_policy value is incomplete.");
      }
      break;
    }
  }

  const setting = renderApprovalPolicy(config);
  if (start >= 0) {
    lines.splice(start, end - start + 1, setting);
  } else {
    const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
    lines.splice(firstTable < 0 ? lines.length : firstTable, 0, setting, "");
  }
  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
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

  const withBuyerServer = updateConfigText(source, {
    replacing: Boolean(existing),
    version,
  });
  const next = setBuyerApprovalPolicy(withBuyerServer, parsed);
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
