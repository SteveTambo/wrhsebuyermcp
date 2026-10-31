import { TOKEN_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { BuyerApiError } from "./api.js";
import { usdcToBaseUnits } from "./usdc.js";

export function createBalanceChecker(connection) {
  return async ({ walletAddress, total, mint: paymentMint }) => {
    let solBalance;
    let tokenAccounts;
    let mintAccount;
    let mint;
    try {
      const owner = new PublicKey(walletAddress);
      mint = new PublicKey(paymentMint);
      [solBalance, tokenAccounts, mintAccount] = await Promise.all([
        connection.getBalance(owner, "confirmed"),
        connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed"),
        connection.getAccountInfo(mint, "confirmed"),
      ]);
    } catch {
      throw new BuyerApiError(
        "Could not check burner-wallet balances; no transaction was signed.",
        503,
        "BALANCE_CHECK_UNAVAILABLE",
      );
    }

    let decimals;
    try {
      if (!mintAccount) throw new Error("Missing token mint account.");
      decimals = unpackMint(mint, mintAccount, TOKEN_PROGRAM_ID).decimals;
    } catch {
      throw new BuyerApiError(
        "IVANA's checkout payment mint is not a valid six-decimal SPL token mint.",
        502,
        "INVALID_USDC_MINT",
      );
    }
    if (decimals !== 6) {
      throw new BuyerApiError(
        "IVANA's checkout payment mint is not a six-decimal SPL token mint.",
        502,
        "INVALID_USDC_MINT",
      );
    }
    if (solBalance < 5_000_000) {
      throw new BuyerApiError(
        "The burner wallet needs at least 0.005 devnet SOL for transaction fees.",
        400,
        "INSUFFICIENT_SOL",
      );
    }

    let tokenUnits = 0n;
    for (const account of tokenAccounts.value) {
      const amount = account.account.data.parsed?.info?.tokenAmount;
      if (amount?.decimals !== 6 || !/^\d+$/.test(amount.amount)) {
        throw new BuyerApiError(
          "IVANA's payment mint did not return a valid six-decimal token balance.",
          502,
          "INVALID_USDC_BALANCE",
        );
      }
      tokenUnits += BigInt(amount.amount);
    }
    const requiredUnits = usdcToBaseUnits(total);
    if (tokenUnits < requiredUnits) {
      throw new BuyerApiError(
        "The burner wallet does not have enough devnet USDC for this quote.",
        400,
        "INSUFFICIENT_USDC",
      );
    }
  };
}
