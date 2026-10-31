import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  decodeTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { usdcToBaseUnits } from "./usdc.js";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);
const MAX_COMPUTE_UNIT_PRICE = 100_000n;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const MAX_TOKEN_ACCOUNT_CREATIONS = 32;

function assertAssociatedTokenInstruction(instruction, walletAddress, mint) {
  if (instruction.data.length !== 1 || instruction.data[0] !== 1) {
    throw new Error("Unsupported associated-token instruction.");
  }
  const [payer, address, owner, instructionMint] = instruction.keys;
  if (
    !payer ||
    !address ||
    !owner ||
    !instructionMint ||
    !payer.pubkey.equals(walletAddress) ||
    !instructionMint.pubkey.equals(mint)
  ) {
    throw new Error("The checkout creates an unexpected token account.");
  }
  const expected = createAssociatedTokenAccountIdempotentInstruction(
    payer.pubkey,
    address.pubkey,
    owner.pubkey,
    mint,
  );
  if (
    instruction.keys.length !== expected.keys.length ||
    !instruction.data.equals(expected.data) ||
    !instruction.programId.equals(expected.programId) ||
    instruction.keys.some(
      (key, index) =>
        !key.pubkey.equals(expected.keys[index].pubkey) ||
        key.isSigner !== expected.keys[index].isSigner ||
        key.isWritable !== expected.keys[index].isWritable,
    )
  ) {
    throw new Error("The checkout creates an invalid token account.");
  }
  return address.pubkey;
}

export function assertSafeCheckoutTransaction(
  transaction,
  { walletAddress, totalUsdc },
) {
  const associatedTokenInstructions = transaction.instructions.filter(
    (instruction) => instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  const firstMintMeta = associatedTokenInstructions[0]?.keys[3];
  if (!firstMintMeta) {
    throw new Error(
      "The checkout transaction does not identify its payment mint.",
    );
  }
  const usdcMint = firstMintMeta.pubkey;
  const source = getAssociatedTokenAddressSync(usdcMint, walletAddress);
  const destinations = new Set();
  const transferDestinations = new Set();
  let totalTransferred = 0n;
  let computeUnitLimitCount = 0;
  let computeUnitPriceCount = 0;
  let computeUnitLimit = 0;

  for (const instruction of transaction.instructions) {
    if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const destination = assertAssociatedTokenInstruction(
        instruction,
        walletAddress,
        usdcMint,
      );
      destinations.add(destination.toBase58());
      if (destinations.size > MAX_TOKEN_ACCOUNT_CREATIONS) {
        throw new Error("The checkout creates too many token accounts.");
      }
      continue;
    }

    if (instruction.programId.equals(TOKEN_PROGRAM_ID)) {
      const decoded = decodeTransferInstruction(instruction);
      if (
        !decoded.keys.source.pubkey.equals(source) ||
        !decoded.keys.owner.pubkey.equals(walletAddress) ||
        decoded.keys.multiSigners.some((key) => key.isSigner || key.isWritable) ||
        decoded.data.amount <= 0n
      ) {
        throw new Error("The checkout transfers from an unexpected account.");
      }
      totalTransferred += decoded.data.amount;
      transferDestinations.add(decoded.keys.destination.pubkey.toBase58());
      continue;
    }

    if (instruction.programId.equals(ComputeBudgetProgram.programId)) {
      if (instruction.data.length === 5 && instruction.data[0] === 2) {
        computeUnitLimitCount += 1;
        computeUnitLimit = instruction.data.readUInt32LE(1);
        if (
          computeUnitLimitCount > 1 ||
          computeUnitLimit < 1 ||
          computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT
        ) {
          throw new Error("The checkout has an unsafe compute-unit limit.");
        }
        continue;
      }
      if (instruction.data.length === 9 && instruction.data[0] === 3) {
        computeUnitPriceCount += 1;
        if (
          computeUnitPriceCount > 1 ||
          instruction.data.readBigUInt64LE(1) > MAX_COMPUTE_UNIT_PRICE
        ) {
          throw new Error("The checkout has an unsafe priority fee.");
        }
        continue;
      }
      throw new Error("Unsupported compute-budget instruction.");
    }

    if (instruction.programId.equals(MEMO_PROGRAM_ID)) {
      const memo = instruction.data.toString("utf8");
      if (
        instruction.keys.length !== 0 ||
        !memo.startsWith("ivana:v2:") ||
        memo.length > 200
      ) {
        throw new Error("The checkout has an invalid payment memo.");
      }
      continue;
    }

    throw new Error(
      "The checkout contains an unsupported transaction instruction.",
    );
  }

  const expectedTotal = usdcToBaseUnits(totalUsdc);
  if (
    computeUnitLimitCount !== 1 ||
    computeUnitPriceCount !== 1 ||
    totalTransferred !== expectedTotal
  ) {
    throw new Error("The checkout does not match the approved USDC amount.");
  }

  if (
    destinations.size === 0 ||
    destinations.size !== transferDestinations.size ||
    [...transferDestinations].some(
      (destination) => !destinations.has(destination),
    )
  ) {
    throw new Error("The checkout transfers to an unexpected token account.");
  }
  return usdcMint;
}
