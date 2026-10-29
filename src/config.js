import { homedir } from "node:os";
import { join } from "node:path";

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1w5FQD3Rvt21";
const DEFAULT_API_URL = "https://api.wrhse.top/api";
const DEFAULT_PAYMENTS_URL = "https://ivanaservertenant.onrender.com/api";

function requiredUrl(value, name, { allowHttpLocalhost = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  const localHost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    url.hostname,
  );
  if (url.search || url.hash) {
    throw new Error(`${name} must not include a query or fragment.`);
  }
  if (
    url.username ||
    url.password ||
    !["https:", ...(allowHttpLocalhost ? ["http:"] : [])].includes(
      url.protocol,
    ) ||
    (url.protocol === "http:" && !localHost)
  ) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed for localhost).`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function parseConfig(env = process.env) {
  const maxUsdc = Number(env.WRHSE_BUYER_MAX_USDC ?? "150");
  if (!Number.isFinite(maxUsdc) || maxUsdc <= 0 || maxUsdc > 150) {
    throw new Error(
      "WRHSE_BUYER_MAX_USDC must be greater than 0 and at most 150.",
    );
  }

  if (!env.WRHSE_BUYER_SOLANA_SECRET_KEY?.trim()) {
    throw new Error("WRHSE_BUYER_SOLANA_SECRET_KEY is required.");
  }
  const agentKey = env.WRHSE_BUYER_AGENT_KEY?.trim();
  if (
    !agentKey ||
    !/^wrhse_agent_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i.test(agentKey)
  ) {
    throw new Error("WRHSE_BUYER_AGENT_KEY must be a WRHSE agent key.");
  }
  const stateRoot =
    env.LOCALAPPDATA ||
    env.XDG_STATE_HOME ||
    join(
      homedir(),
      ...(process.platform === "win32"
        ? ["AppData", "Local"]
        : [".local", "state"]),
    );

  return Object.freeze({
    agentKey,
    apiBaseUrl: requiredUrl(
      env.WRHSE_BUYER_API_URL || DEFAULT_API_URL,
      "WRHSE_BUYER_API_URL",
      { allowHttpLocalhost: true },
    ),
    paymentsBaseUrl: requiredUrl(
      env.WRHSE_BUYER_PAYMENTS_URL || DEFAULT_PAYMENTS_URL,
      "WRHSE_BUYER_PAYMENTS_URL",
      { allowHttpLocalhost: true },
    ),
    maxUsdc,
    statePath: join(
      stateRoot,
      "WRHSE",
      "buyer-agent",
      "pending-checkouts.json",
    ),
    devnetGenesisHash: DEVNET_GENESIS_HASH,
  });
}

export function checkoutRpcUrl(paymentsBaseUrl, intentId) {
  if (!intentId)
    throw new Error("An intent ID is required for IVANA RPC access.");
  return `${paymentsBaseUrl.replace(/\/+$/, "")}/webthree/checkout-rpc/${encodeURIComponent(intentId)}`;
}

export function assertDevnetGenesis(
  actualHash,
  expectedHash = DEVNET_GENESIS_HASH,
) {
  if (actualHash !== expectedHash) {
    throw new Error("Configured Solana RPC is not connected to devnet.");
  }
}
