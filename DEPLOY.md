# Railway deployment

- **Build:** `npm run build` → runs `tsc` (output in `dist/`). Requires `typescript` at build time (devDependency).
- **Start:** `npm start` → runs `node dist/server.js`. Uses only production dependencies; no devDependencies at runtime.
- **Env:** Set `PORT` (Railway sets this) and `DATABASE_URL` in the Railway dashboard.
