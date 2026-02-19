# cURL: Test POST /mcp (analyze_token_unlock)

## One-liner (no auth)

```bash
curl -s -X POST "http://localhost:3000/mcp" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"analyze_token_unlock\",\"arguments\":{\"token_symbol\":\"ARB\"}}}"
```

**Note:** `/mcp` is protected by Context Protocol middleware. `tools/call` requires `Authorization: Bearer <JWT>`. Without it you get **401 Unauthorized**. Discovery (`initialize`, `tools/list`) does not require auth.

## With auth (Bearer JWT)

```bash
curl -s -X POST "http://localhost:3000/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_CONTEXT_JWT" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"analyze_token_unlock\",\"arguments\":{\"token_symbol\":\"ARB\"}}}"
```

## Body (pretty)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "analyze_token_unlock",
    "arguments": {
      "token_symbol": "ARB"
    }
  }
}
```

## Response shape (success)

JSON-RPC result contains `content` and `structuredContent`. `structuredContent` must match:

| Field | Type |
|-------|------|
| `token_symbol` | string |
| `next_unlock_date` | string (ISO) |
| `unlock_amount` | number |
| `unlock_percent_supply` | number |
| `unlock_vs_volume_ratio` | number |
| `cohort_type` | string |
| `historical_avg_7d_return` | number |
| `impact_score` | string |
| `risk_summary` | string |
| `fetchedAt` | string (ISO) |

Example success fragment:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "..." }],
    "structuredContent": {
      "token_symbol": "ARB",
      "next_unlock_date": "2025-03-16T00:00:00.000Z",
      "unlock_amount": 0,
      "unlock_percent_supply": 0,
      "unlock_vs_volume_ratio": 0,
      "cohort_type": "",
      "historical_avg_7d_return": 0,
      "impact_score": "error",
      "risk_summary": "No unlock analysis found for token: ARB.",
      "fetchedAt": "2026-02-19T21:00:00.000Z"
    }
  }
}
```

To assert the schema (e.g. with `jq`):

```bash
curl -s -X POST "http://localhost:3000/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MCP_JWT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"analyze_token_unlock","arguments":{"token_symbol":"ARB"}}}' \
  | jq '.result.structuredContent | keys'
# Expected: ["cohort_type","fetchedAt","historical_avg_7d_return","impact_score","next_unlock_date","risk_summary","token_symbol","unlock_amount","unlock_percent_supply","unlock_vs_volume_ratio"]
```
