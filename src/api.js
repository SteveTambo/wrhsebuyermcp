export class BuyerApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "BuyerApiError";
    this.status = status;
    this.code = code;
  }
}

export function createWrhseApi(baseUrl, { agentKey, fetchImpl = fetch } = {}) {
  const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);

  async function request(
    path,
    { method = "GET", body, authenticated = false } = {},
  ) {
    let response;
    try {
      response = await fetchImpl(new URL(path.replace(/^\/+/, ""), base), {
        method,
        headers: {
          Accept: "application/json",
          ...(authenticated && agentKey
            ? { Authorization: `Bearer ${agentKey}` }
            : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new BuyerApiError(
        "WRHSE could not be reached. Retry the same operation.",
        0,
        "API_UNAVAILABLE",
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new BuyerApiError(
        "WRHSE returned an invalid response.",
        response.status,
        "INVALID_RESPONSE",
      );
    }
    if (!response.ok) {
      const code =
        typeof payload?.error?.code === "string"
          ? payload.error.code
          : "WRHSE_REQUEST_FAILED";
      throw new BuyerApiError(
        `WRHSE rejected the request (${code}).`,
        response.status,
        code,
      );
    }
    return payload;
  }

  return Object.freeze({
    async searchProducts({ query, buyerCountry }) {
      const params = new URLSearchParams({ q: query, limit: "10" });
      if (buyerCountry) params.set("buyerCountry", buyerCountry);
      const result = await request(`products/search?${params}`);
      return Array.isArray(result?.data) ? result.data : [];
    },

    getProduct(productId) {
      return request(`products/${encodeURIComponent(productId)}`);
    },

    createIntent(input) {
      return request("webthree/agent/create-payment-intent", {
        method: "POST",
        body: input,
        authenticated: true,
      });
    },

    recordOrder(input) {
      return request("orders", { method: "POST", body: input });
    },
  });
}
