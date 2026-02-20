import "dotenv/config";
import { config } from "./core/config.js";
import { start, shutdown } from "./app.js";

if (config.NODE_ENV === "production" && !config.DATABASE_URL) {
  throw new Error("DATABASE_URL is required in production");
}

start(config.PORT);

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
