#!/usr/bin/env bash
# Test POST /mcp with analyze_token_unlock (JSON-RPC tools/call).
# Requires valid Context Protocol JWT for tools/call; otherwise expect 401.
# Usage: ./scripts/test-analyze-curl.sh [BASE_URL]
# Example: ./scripts/test-analyze-curl.sh http://localhost:3000

set -e
BASE_URL="${1:-http://localhost:3000}"

# MCP JSON-RPC request: method tools/call, params.name and params.arguments
BODY='{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "analyze_token_unlock",
    "arguments": {
      "token_symbol": "ARB"
    }
  }
}'

echo "POST $BASE_URL/mcp"
echo "Body: $BODY"
echo ""

# If you have a Context Protocol JWT, set it:
# export MCP_JWT="your_bearer_token"
if [ -n "${MCP_JWT}" ]; then
  curl -s -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $MCP_JWT" \
    -d "$BODY" | jq .
else
  echo "No MCP_JWT set; request may return 401 for tools/call."
  curl -s -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -d "$BODY" | jq .
fi

# Expected result shape (when 200 and not error):
# .result.content[].text or .result.structuredContent with:
#   token_symbol, next_unlock_date, unlock_amount, unlock_percent_supply,
#   unlock_vs_volume_ratio, cohort_type, historical_avg_7d_return,
#   impact_score, risk_summary, fetchedAt
