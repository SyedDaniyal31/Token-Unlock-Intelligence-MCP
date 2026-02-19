import "dotenv/config";
import { start, shutdown } from "./server.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

function validateEnv(): void {
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production");
  }
}

validateEnv();
start(PORT);

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
