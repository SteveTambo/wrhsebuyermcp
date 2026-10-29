import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assertSafeCheckoutTransaction } from "../src/transaction-guard.js";

function paymentTransaction({
  wallet,
  mint,
  recipient = Keypair.generate(),
  amount = 4_000_000n,
}) {
  const source = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const destination = getAssociatedTokenAddressSync(mint, recipient.publicKey);
  return new Transaction({
    feePayer: wallet.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
  }).add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      destination,
      recipient.publicKey,
      mint,
    ),
    createTransferInstruction(source, destination, wallet.publicKey, amount),
  );
}

test("accepts only a burner-funded USDC transfer matching the quote", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const transaction = paymentTransaction({ wallet, mint });
  assert.equal(
    assertSafeCheckoutTransaction(transaction, {
      walletAddress: wallet.publicKey,
      totalUsdc: 4,
    }).toBase58(),
    mint.toBase58(),
  );
});

test("rejects wrong totals, non-USDC instructions, and unsafe compute fees", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const wrongAmount = paymentTransaction({ wallet, mint, amount: 3_999_999n });
  assert.throws(
    () =>
      assertSafeCheckoutTransaction(wrongAmount, {
        walletAddress: wallet.publicKey,
        totalUsdc: 4,
      }),
    /approved USDC amount/,
  );

  const solTransfer = paymentTransaction({ wallet, mint }).add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  assert.throws(
    () =>
      assertSafeCheckoutTransaction(solTransfer, {
        walletAddress: wallet.publicKey,
        totalUsdc: 4,
      }),
    /unsupported transaction instruction/,
  );

  const unsafeFee = paymentTransaction({ wallet, mint });
  unsafeFee.instructions[0] = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 100_001,
  });
  assert.throws(
    () =>
      assertSafeCheckoutTransaction(unsafeFee, {
        walletAddress: wallet.publicKey,
        totalUsdc: 4,
      }),
    /unsafe priority fee/,
  );
});

test("rejects token transfers from a nonstandard source account", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const transaction = paymentTransaction({ wallet, mint });
  const transfer = transaction.instructions.find((instruction) =>
    instruction.programId.equals(TOKEN_PROGRAM_ID),
  );
  transfer.keys[0].pubkey = Keypair.generate().publicKey;

  assert.throws(
    () =>
      assertSafeCheckoutTransaction(transaction, {
        walletAddress: wallet.publicKey,
        totalUsdc: 4,
      }),
    /unexpected account/,
  );
  assert.ok(
    transaction.instructions.some((instruction) =>
      instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID),
    ),
  );
});

test("rejects token-account creation without a matching payment", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const transaction = paymentTransaction({ wallet, mint });
  const extraOwner = Keypair.generate().publicKey;
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      getAssociatedTokenAddressSync(mint, extraOwner),
      extraOwner,
      mint,
    ),
  );

  assert.throws(
    () =>
      assertSafeCheckoutTransaction(transaction, {
        walletAddress: wallet.publicKey,
        totalUsdc: 4,
      }),
    /unexpected token account/,
  );
});

test("requires IVANA's payment transaction to identify its mint", () => {
  const wallet = Keypair.generate();
  const transaction = new Transaction({
    feePayer: wallet.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
  }).add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  );
  assert.throws(
    () =>
      assertSafeCheckoutTransaction(transaction, {
        walletAddress: wallet.publicKey,
        totalUsdc: 4,
      }),
    /does not identify its payment mint/,
  );
});
