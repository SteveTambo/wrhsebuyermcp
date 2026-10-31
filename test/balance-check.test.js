import test from "node:test";
import assert from "node:assert/strict";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { createBalanceChecker } from "../src/balance-check.js";

function mintAccount(decimals = 6) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: Keypair.generate().publicKey,
      supply: 0n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: Keypair.generate().publicKey,
    },
    data,
  );
  return {
    data,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
}

function fixture({
  solBalance = 5_000_000,
  tokenUnits = "5000000",
  decimals = 6,
} = {}) {
  const mint = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const connection = {
    async getBalance() {
      return solBalance;
    },
    async getParsedTokenAccountsByOwner() {
      return {
        value: [
          {
            account: {
              data: {
                parsed: {
                  info: {
                    tokenAmount: {
                      amount: tokenUnits,
                      decimals,
                    },
                  },
                },
              },
            },
          },
        ],
      };
    },
    async getAccountInfo() {
      return mintAccount(decimals);
    },
  };
  return {
    checkFunds: createBalanceChecker(connection),
    mint: mint.toBase58(),
    owner,
  };
}

test("accepts a valid six-decimal payment mint and sufficient balances", async () => {
  const { checkFunds, owner, mint } = fixture();
  await assert.doesNotReject(
    checkFunds({ walletAddress: owner.toBase58(), total: 4, mint }),
  );
});

test("rounds fractional base-unit quotes up when checking the wallet balance", async () => {
  const { checkFunds, owner, mint } = fixture({ tokenUnits: "1000000" });
  await assert.rejects(
    checkFunds({
      walletAddress: owner.toBase58(),
      total: 1.000000000001,
      mint,
    }),
    /not have enough devnet USDC/,
  );
});

test("rejects insufficient SOL, token funds, malformed balances, and invalid mints", async () => {
  const lowSol = fixture({ solBalance: 4_999_999 });
  await assert.rejects(
    lowSol.checkFunds({
      walletAddress: lowSol.owner.toBase58(),
      total: 4,
      mint: lowSol.mint,
    }),
    /at least 0.005 devnet SOL/,
  );

  const lowUsdc = fixture({ tokenUnits: "3999999" });
  await assert.rejects(
    lowUsdc.checkFunds({
      walletAddress: lowUsdc.owner.toBase58(),
      total: 4,
      mint: lowUsdc.mint,
    }),
    /not have enough devnet USDC/,
  );

  const invalidBalance = fixture({ tokenUnits: "NaN" });
  await assert.rejects(
    invalidBalance.checkFunds({
      walletAddress: invalidBalance.owner.toBase58(),
      total: 4,
      mint: invalidBalance.mint,
    }),
    /valid six-decimal token balance/,
  );

  const wrongDecimals = fixture({ decimals: 9 });
  await assert.rejects(
    wrongDecimals.checkFunds({
      walletAddress: wrongDecimals.owner.toBase58(),
      total: 4,
      mint: wrongDecimals.mint,
    }),
    /six-decimal SPL token mint/,
  );
});

test("fails closed when the devnet balance check is unavailable", async () => {
  const mint = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const checkFunds = createBalanceChecker({
    async getBalance() {
      throw new Error("RPC unavailable");
    },
    async getParsedTokenAccountsByOwner() {
      return { value: [] };
    },
    async getAccountInfo() {
      return mintAccount();
    },
  });
  await assert.rejects(
    checkFunds({
      walletAddress: owner.toBase58(),
      total: 1,
      mint: mint.toBase58(),
    }),
    /no transaction was signed/,
  );
});
