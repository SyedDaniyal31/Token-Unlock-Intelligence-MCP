/**
 * Central configuration. Validates required env in production.
 */

function getEnv(key: string): string | undefined {
  return process.env[key];
}

function requireInProduction(key: string): string {
  const value = getEnv(key);
  if (process.env.NODE_ENV === "production" && (value === undefined || value === "")) {
    throw new Error(`${key} is required in production`);
  }
  return value ?? "";
}

export const config = {
  get NODE_ENV(): string {
    return getEnv("NODE_ENV") ?? "development";
  },
  get DATABASE_URL(): string {
    return requireInProduction("DATABASE_URL") || (getEnv("DATABASE_URL") ?? "");
  },
  get RPC_URL(): string {
    return requireInProduction("RPC_URL") || (getEnv("RPC_URL") ?? "");
  },
  get MARKET_API_KEY(): string {
    return getEnv("MARKET_API_KEY") ?? "";
  },
  get PORT(): number {
    const p = getEnv("PORT");
    return p ? Number(p) : 3000;
  },
} as const;
