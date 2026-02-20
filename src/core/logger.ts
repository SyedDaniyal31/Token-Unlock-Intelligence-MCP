import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

const logger = isProduction
  ? pino({ level: process.env.LOG_LEVEL ?? "info" })
  : pino({
      level: process.env.LOG_LEVEL ?? "info",
      transport: {
        target: "pino-pretty",
        options: { colorize: true },
      },
    });

export default logger;
