# MCP COMPLIANCE AUDIT REPORT

**Project:** Token-Unlock-Intelligence-MCP  
**Scope:** /mcp route, tool registration, JSON-RPC, schemas, errors, Context Protocol compatibility  
**Audit date:** 2025

---

## 1. Critical Issues (must fix immediately)

### C1. outputSchema does not match actual result shape

**Location:** `src/api/registerMcpRoute.ts` lines 65–73, 213–215.

**Issue:** Declared `outputSchema` describes an object with exactly four properties: `unlock_pressure_ratio`, `volume_impact_ratio`, `supply_inflation_percent`, `risk_score`. The handler **never** returns that shape. It returns:

- **Success:** `{ success: true, data: { unlock_pressure_ratio, volume_impact_ratio, supply_inflation_percent, risk_score } }`
- **Token not supported:** `{ success: false, error: "Token not supported" }`

So the **result** is always wrapped in `success` + `data` or `success` + `error`. Context and validators expect the result to conform to `outputSchema`; this is a **schema/contract violation**.

**Fix:** Either:

- Change `outputSchema` to describe the actual envelope, e.g.  
  `properties: { success: { type: "boolean" }, data: { type: "object", properties: { ... } }, error: { type: "string" } }`,  
  and document that `data` is present when `success === true`, or  
- Keep returning only the four metrics on success (no `success`/`data` wrapper) so the response matches the current `outputSchema`. Use JSON-RPC `error` for failures (including “Token not supported”) instead of a success body with `success: false`.

---

### C2. “Token not supported” returned as success with non‑conforming result

**Location:** `src/api/registerMcpRoute.ts` lines 184–188.

**Issue:** When the token is not in the registry, the code returns:

```json
{ "jsonrpc": "2.0", "id": id, "result": { "success": false, "error": "Token not supported" } }
```

So the RPC is **success** (no `error`), but `result` does not match `outputSchema` (no numeric fields). Clients that validate `result` against `outputSchema` will fail or misbehave.

**Fix:** Treat unsupported token as an error: return a JSON-RPC error object, e.g. `error: { code: -32000, message: "Token not supported" }`, and do not put `success: false` in `result`. Optionally also return a structured `result` for “soft” errors only if you first update `outputSchema` to describe that shape (see C1).

---

## 2. High Risk Issues

### H1. Middleware can bypass handler and cause non‑JSON‑RPC 500

**Location:** `src/app.ts` line 82: `registerMcpRoute(app, deps, [verifyContextAuth])`.

**Issue:** If `verifyContextAuth` (Context middleware) throws before calling `next()`, the request never reaches the MCP handler. Express will pass the error to `errorHandler`, which returns HTTP 500 and a JSON-RPC‑style body for `/mcp`. That is correct for unhandled errors, but the **status code is 500** instead of 200. Some strict clients or proxies expect **always 200** for JSON-RPC with error in body. Also, any other middleware that runs before the handler and throws (e.g. rate limiter) has the same effect.

**Recommendation:** Ensure Context middleware never throws for valid requests; document that 500 is only for middleware/server failures. If the platform requires “always 200 for /mcp”, consider catching errors in a wrapper around the handler and sending 200 + JSON-RPC error.

---

### H2. Invalid JSON body never reaches MCP handler

**Location:** `app.use(express.json({ limit: "1mb" }))` in `src/app.ts` line 49.

**Issue:** If the client sends invalid JSON, `express.json()` calls `next(err)`. The MCP handler is never run; `errorHandler` returns 500 and a generic body. So invalid JSON does **not** get a 200 + JSON-RPC “Parse error” response.

**Recommendation:** Either accept that parse errors yield 500, or add a custom middleware after `express.json()` that catches JSON errors for `path === '/mcp'` and sends `200` with `{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }`.

---

### H3. Database or env failure can surface as generic -32603

**Location:** `getScheduleByToken` uses `query()` in `src/infrastructure/database/postgres.ts`; `getPool()` throws if `DATABASE_URL` is not set.

**Issue:** `getScheduleByToken` is already inside a try/catch in `handleCallTool`; on failure you return -32000 “Token lookup failed”. So **within** the handler you are safe. If, however, something else (e.g. first use of `getPool()` elsewhere) throws before the handler, or if the handler’s catch somehow failed to run, the outer catch would return -32603. The only remaining risk is an uncaught throw (e.g. from dependency code) that isn’t wrapped.

**Recommendation:** Keep the current try/catch; ensure no code path in the handler or in `handleCallTool` can throw without being caught. Optionally add an explicit check for `process.env.DATABASE_URL` (or config) at startup and fail fast with a clear message.

---

## 3. Schema Mismatches

### S1. outputSchema vs actual success result (see C1)

- **Declared:** Result object with four number properties.
- **Actual:** Result object with `success: true` and `data: { ... four numbers ... }`.
- **Action:** Align schema with implementation or implementation with schema (see C1/C2).

### S2. outputSchema has no `required` array

**Location:** `src/api/registerMcpRoute.ts` lines 65–73.

**Issue:** The four output fields are not listed in `required`. Validators and clients may not know that all four are always present on success.

**Fix:** Add `required: ["unlock_pressure_ratio", "volume_impact_ratio", "supply_inflation_percent", "risk_score"]` to `outputSchema` (and adjust if you change to an envelope shape per C1).

### S3. Parameter naming consistency

**Location:** `src/api/registerMcpRoute.ts` lines 54–62 (inputSchema), 167–171 (extraction).

**Finding:**  
- **inputSchema** correctly uses `token_symbol` (required).  
- **Extraction** accepts `token_symbol`, `tokenSymbol`, and `token`.  
- **Consistency:** No mismatch; all three names are supported and `token_symbol` is the canonical one. No change required, but document that `token_symbol` is preferred.

---

## 4. Error Handling Problems

### E1. -32603 still used for unexpected errors

**Location:** `src/api/registerMcpRoute.ts` lines 294–298.

**Issue:** Outer catch returns `jsonrpcError(null, -32603, "Unexpected server error: ${message}.")`. The message includes the actual error text, which may expose internal details in production.

**Recommendation:** In production, use a generic message, e.g. `"Unexpected server error. Please try again."`, and log the real `message` (and stack) server-side only. Keep -32603 for truly unexpected server errors only.

### E2. errorHandler returns HTTP 500 for /mcp

**Location:** `src/middleware/errorHandler.ts` lines 41–48.

**Issue:** For `/mcp` with a JSON-RPC-shaped body, the handler sends **500** with a JSON-RPC error body. Many MCP/Context guidelines prefer **200** for all JSON-RPC responses (errors in body). So 500 is only appropriate when the error occurs before the JSON-RPC handler runs (e.g. middleware throw).

**Recommendation:** Document that 500 is intentional for unhandled/middleware errors. If the marketplace requires “always 200 for /mcp”, move to a pattern where the MCP route never passes errors to this handler (e.g. wrapper that catches and sends 200 + error).

### E3. All throws in MCP path are wrapped

**Finding:**  
- **registerMcpRoute:** Entire handler in try/catch; `handleCallTool` has its own try/catch for registry + `getIntelligenceReport`.  
- **getScheduleByToken:** Uses `query()` which can throw; that is caught in `handleCallTool` and converted to -32000.  
- **getIntelligenceReport:** Uses `generateUnlockIntelligence`; no throw found in that file; market/RPC layers are wrapped or return fallbacks.  
- **postgres:** `query()` and `getPool()` throw; only reached via `getScheduleByToken`, which is inside try/catch.

No unwrapped throw was found in the MCP handler path. Remaining risk is third-party or middleware code throwing.

---

## 5. Context Compatibility Risks

### X1. Deterministic output

**Finding:** On success, `reportToMcpOutput` uses `Number(...) || 0` and `?? 0`, so the four fields are always numbers. No undefined in the numeric result. **Token not supported** returns a different shape (see C2). Fixing C1/C2 will improve determinism from the client’s perspective.

### X2. No null traps in success path

**Finding:** `report.unlock_vs_volume_ratio`, `report.unlock_percent_supply`, `report.score_numeric` are typed as numbers in `IntelligenceReport`. Normalization in `reportToMcpOutput` guards against NaN/undefined. Success payload does not expose null for these fields.

### X3. Silent failures

**Finding:** No silent failures in the MCP handler. Registry failure and tool execution failure both return explicit errors (-32000 or -32602). “Token not supported” is currently a success with a message (see C2); changing it to an error would make behavior clearer.

### X4. Lean response body

**Finding:** Success adds a `success`/`data` wrapper. Small fixed cost; no large text blocks. Acceptable if schema is updated (C1).

### X5. Schema clarity

**Finding:** inputSchema is clear (token_symbol, string, required). outputSchema is misleading because it does not describe the real envelope (C1, S1, S2).

---

## 6. Route Audit Summary (Section 1)

| Requirement | Status | Notes |
|-------------|--------|--------|
| /mcp is POST | ✅ | Registered via `app.post("/mcp", ...)` in registerMcpRoute. |
| express.json() enabled | ✅ | `app.use(express.json({ limit: "1mb" }))` before routes. |
| Reads jsonrpc, id, method, params | ✅ | `const { jsonrpc, id, method, params } = body`. |
| Supports listTools | ✅ | `methodName === "listTools" || methodName === "tools/list"`. |
| Supports callTool | ✅ | `methodName === "callTool" || methodName === "tools/call"`. |
| Supports initialize | ✅ | Handled; returns serverInfo/capabilities. |
| Never throws uncaught | ✅ | Full handler in try/catch; safeSend checks headersSent. |
| Always JSON-RPC envelope | ✅ | All responses use jsonRpcSuccess or jsonRpcError. |
| Undefined access | ⚠️ | Guard on `deps`; body/params null-checked. Risk in middleware. |
| Thrown fetch errors | ✅ | getIntelligenceReport in try/catch; -32000 returned. |
| Missing env | ⚠️ | DATABASE_URL can cause getPool() to throw; caught if via getScheduleByToken. |
| Invalid JSON parsing | ✅ | parseArguments for string args uses try/catch; returns {}. |

---

## 7. Tool Registration Audit Summary (Section 2)

| Item | Value / Status |
|------|----------------|
| Exact tool name | `"analyze_token_unlock"` ✅ |
| inputSchema | `type: "object", properties: { token_symbol: { type: "string" } }, required: ["token_symbol"]` ✅ |
| outputSchema | Four numbers; **no** `required`; **does not** match actual result shape (see C1, S1, S2). |
| Argument usage | Reads `token_symbol`, `tokenSymbol`, `token`; consistent with schema. ✅ |
| Parameter naming | token_symbol (schema) and token/symbol (internal) aligned. ✅ |

---

## 8. Output Validation Summary (Section 3)

| Check | Status |
|-------|--------|
| outputSchema matches returned JSON | ❌ Result is `{ success, data }` or `{ success, error }`; schema describes flat 4 fields. |
| Fields can return undefined | ✅ Numeric fields normalized to numbers; no undefined in success data. |
| Numeric fields always numbers | ✅ Yes. |
| No large text in result | ✅ Only short strings and numbers. |

---

## 9. Recommended Fixes (code snippets)

### Fix C1/C2 and S2: Align result with schema and treat “Token not supported” as error

Option A – Keep envelope and fix schema:

```ts
// In MCP_TOOLS outputSchema, describe actual shape:
outputSchema: {
  type: "object" as const,
  properties: {
    success: { type: "boolean" as const },
    data: {
      type: "object" as const,
      properties: {
        unlock_pressure_ratio: { type: "number" as const },
        volume_impact_ratio: { type: "number" as const },
        supply_inflation_percent: { type: "number" as const },
        risk_score: { type: "number" as const },
      },
      required: ["unlock_pressure_ratio", "volume_impact_ratio", "supply_inflation_percent", "risk_score"],
    },
    error: { type: "string" as const },
  },
},
```

Then for “Token not supported” either keep current success body (and document) or switch to error (Option B).

Option B – Use JSON-RPC error for “Token not supported” (recommended):

```ts
// Replace lines 184-188 in registerMcpRoute.ts:
if (!schedule) {
  console.log("[MCP] Token not supported:", symbol);
  logger.info({ token_symbol: symbol }, "MCP token not in registry");
  return jsonRpcError(id, -32000, "Token not supported");
}
```

Then success result can be either the envelope `{ success: true, data: output }` or, for strict schema match, just `result: output` (four fields only). If you use only `result: output` on success, keep the current outputSchema and add `required`:

```ts
outputSchema: {
  type: "object" as const,
  properties: { ... },
  required: ["unlock_pressure_ratio", "volume_impact_ratio", "supply_inflation_percent", "risk_score"],
},
```

### Fix E1: Safer -32603 message in production

```ts
// In the outer catch (registerMcpRoute.ts ~296):
const safeMessage = process.env.NODE_ENV === "production"
  ? "Unexpected server error. Please try again."
  : `Unexpected server error: ${message}.`;
safeSend(res, jsonRpcError(null, -32603, safeMessage));
```

---

## 10. Final Compliance Score

| Category | Score | Notes |
|----------|-------|--------|
| Route (POST, body, methods, envelope) | 95% | Minor: invalid JSON → 500, middleware throw → 500. |
| Tool registration (name, inputSchema) | 100% | inputSchema and name correct. |
| outputSchema vs result | 40% | Result shape and “Token not supported” violate schema. |
| Error handling (wrap, JSON-RPC, -32603) | 85% | Well wrapped; -32603 message and 500 for /mcp. |
| Context compatibility | 75% | Deterministic numbers; schema/result mismatch and soft-fail shape. |

**Overall: 79%**

To reach high compliance (e.g. 95%+):

1. Make **result** match **outputSchema** (or update outputSchema to the real envelope) and add `required` for output fields.  
2. Return a JSON-RPC **error** for “Token not supported” (code -32000).  
3. Optionally: 200 for JSON parse errors on /mcp; generic -32603 message in production; document 500 usage for middleware/unhandled errors.

---

*End of MCP Compliance Audit Report*
