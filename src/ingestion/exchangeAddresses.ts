/**
 * Known exchange deposit/hot wallet addresses for sellable supply detection.
 * Extensible: load from DB or config in production.
 */

const KNOWN_EXCHANGE_ADDRESSES = new Set<string>([
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000003",
]);

export function isKnownExchangeAddress(address: string): boolean {
  const normalized = address.toLowerCase().trim();
  return KNOWN_EXCHANGE_ADDRESSES.has(normalized);
}

export function getExchangeLabel(_address: string): string | null {
  return null;
}

export function addExchangeAddress(address: string): void {
  KNOWN_EXCHANGE_ADDRESSES.add(address.toLowerCase().trim());
}
