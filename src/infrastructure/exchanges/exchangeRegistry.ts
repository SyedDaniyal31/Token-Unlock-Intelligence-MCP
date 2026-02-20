import type { ExchangeRegistry } from "../../core/types.js";

const KNOWN = new Set<string>([
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000003",
]);

export class DefaultExchangeRegistry implements ExchangeRegistry {
  isKnownExchangeAddress(address: string): boolean {
    return KNOWN.has(address.toLowerCase().trim());
  }

  getExchangeLabel(_address: string): string | null {
    return null;
  }
}
