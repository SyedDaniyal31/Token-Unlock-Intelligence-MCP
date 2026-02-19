/**
 * Shared types for token-unlock-intelligence-mcp
 */

export interface Env {
  PORT: string;
  DATABASE_URL: string;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
}
