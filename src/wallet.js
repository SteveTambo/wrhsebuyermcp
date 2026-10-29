import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

export function loadBurnerWallet(encodedSecret) {
  let secretBytes;
  let keyMaterial;
  try {
    const trimmed = encodedSecret.trim();
    if (trimmed.startsWith("[")) {
      const values = JSON.parse(trimmed);
      if (
        !Array.isArray(values) ||
        values.length !== 64 ||
        values.some(
          (value) => !Number.isInteger(value) || value < 0 || value > 255,
        )
      ) {
        throw new Error("invalid key");
      }
      secretBytes = Uint8Array.from(values);
    } else {
      secretBytes = bs58.decode(trimmed);
    }

    if (secretBytes.length !== 64) throw new Error("invalid key");
    keyMaterial = Uint8Array.from(secretBytes);
    return Keypair.fromSecretKey(keyMaterial);
  } catch {
    throw new Error(
      "WRHSE_BUYER_SOLANA_SECRET_KEY must be a base58 64-byte secret key or a Solana CLI JSON keypair array.",
    );
  } finally {
    secretBytes?.fill(0);
  }
}

export function createLocalWallet(
  keypair,
  { validateTransaction, afterSign } = {},
) {
  return {
    publicKey: keypair.publicKey,
    async signTransaction(transaction) {
      if (
        !transaction?.feePayer ||
        !transaction.feePayer.equals(keypair.publicKey) ||
        typeof transaction.partialSign !== "function"
      ) {
        throw new Error(
          "The checkout transaction does not match the burner wallet.",
        );
      }
      await validateTransaction?.(transaction);
      transaction.partialSign(keypair);
      if (!transaction.signature) {
        throw new Error("The signed checkout transaction has no signature.");
      }
      await afterSign?.(transaction);
      return transaction;
    },
  };
}
