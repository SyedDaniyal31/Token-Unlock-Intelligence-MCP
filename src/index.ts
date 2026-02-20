import "dotenv/config";
import { config } from "./core/config.js";
import { start, shutdown } from "./app.js";

const hasDb = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim().length > 0;
if (config.NODE_ENV === "production" && !hasDb) {
  throw new Error(
    "DATABASE_URL is required in production. On Railway: Project → Variables → add DATABASE_URL, or link a PostgreSQL database."
  );
}

start(config.PORT);

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
