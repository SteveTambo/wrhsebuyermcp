export function usdcToBaseUnits(total) {
  return BigInt(Math.ceil(total * 1_000_000 - 1e-8));
}
