import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { createLocalWallet, loadBurnerWallet } from "../src/wallet.js";

test("loads base58 and Solana CLI burner keypairs without exposing invalid input", () => {
  const expected = Keypair.generate();
  const base58Wallet = loadBurnerWallet(bs58.encode(expected.secretKey));
  const jsonWallet = loadBurnerWallet(JSON.stringify([...expected.secretKey]));
  assert.equal(
    base58Wallet.publicKey.toBase58(),
    expected.publicKey.toBase58(),
  );
  const signedWithLoadedKey = new Transaction({
    feePayer: base58Wallet.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
  }).add(
    SystemProgram.transfer({
      fromPubkey: base58Wallet.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  signedWithLoadedKey.partialSign(base58Wallet);
  assert.ok(signedWithLoadedKey.signature);
  assert.equal(jsonWallet.publicKey.toBase58(), expected.publicKey.toBase58());
  assert.throws(
    () => loadBurnerWallet("sensitive-invalid-value"),
    (error) => !error.message.includes("sensitive-invalid-value"),
  );
});

test("signer signs only a transaction whose fee payer is the burner wallet", async () => {
  const burner = Keypair.generate();
  const recipient = Keypair.generate();
  let persisted = false;
  const wallet = createLocalWallet(burner, {
    afterSign: async () => {
      persisted = true;
    },
  });
  const transaction = new Transaction({
    feePayer: burner.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
  }).add(
    SystemProgram.transfer({
      fromPubkey: burner.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 1,
    }),
  );
  const signed = await wallet.signTransaction(transaction);
  assert.ok(signed.signature);
  assert.equal(persisted, true);

  const wrongPayer = new Transaction({
    feePayer: recipient.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
  });
  await assert.rejects(wallet.signTransaction(wrongPayer), /does not match/);
});
