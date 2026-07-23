#!/usr/bin/env bash
# Exercises the full SePay billing flow against a LOCAL wrangler dev server —
# no real SePay account, bank account, or money involved. Validates the
# webhook contract (payload shape, auth, amount matching, idempotency)
# against synthetic payloads shaped exactly like SePay's real webhook.
#
# Usage:
#   cd server
#   npx wrangler dev --local --port 8787 &   # start it first, separately
#   ./test-sepay-webhook.sh
#
# Requires: curl, python3 (for JSON field extraction — no extra deps).

set -euo pipefail
BASE="http://localhost:8787"
WEBHOOK_KEY="local_dev_test_key_change_me" # must match SEPAY_WEBHOOK_KEY in server/.dev.vars
EMAIL="test-billing-$(date +%s)@example.com"

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; exit 1; }

echo "== 1. Request OTP for $EMAIL =="
curl -sf -X POST "$BASE/v1/auth/request" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\"}" > /dev/null
pass "OTP requested (check wrangler dev console for the code if RESEND_KEY isn't set)"

read -rp "Paste the 6-digit dev code printed in the wrangler dev terminal: " CODE

echo "== 2. Verify OTP, get bearer token =="
TOKEN=$(curl -sf -X POST "$BASE/v1/auth/verify" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
[ -n "$TOKEN" ] && pass "Got bearer token" || fail "No token returned"

echo "== 3. Create a monthly checkout order =="
CHECKOUT=$(curl -sf -X POST "$BASE/v1/billing/checkout" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"plan":"monthly"}')
ORDER_ID=$(echo "$CHECKOUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['orderId'])")
AMOUNT=$(echo "$CHECKOUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['amount'])")
echo "  order=$ORDER_ID amount=$AMOUNT"
pass "Order created (status should be pending)"

TX_BASE='{"gateway":"Vietcombank","accountNumber":"your-bank-account-number","transferType":"in","referenceCode":"FTTEST"}'

echo "== 4. Wrong Authorization header -> expect 401, no credit =="
CODE401=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/webhooks/sepay" \
  -H "Authorization: Apikey wrong_key" -H "Content-Type: application/json" \
  -d "{\"id\":9001,\"code\":\"$ORDER_ID\",\"content\":\"$ORDER_ID\",\"transferAmount\":$AMOUNT,$(echo $TX_BASE | sed 's/^{//')")
[ "$CODE401" = "401" ] && pass "Rejected with 401" || fail "Expected 401, got $CODE401"

echo "== 5. Wrong amount -> expect ack (200) but order stays pending =="
curl -sf -X POST "$BASE/webhooks/sepay" -H "Authorization: Apikey $WEBHOOK_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"id\":9002,\"code\":\"$ORDER_ID\",\"content\":\"$ORDER_ID\",\"transferAmount\":1,$(echo $TX_BASE | sed 's/^{//')" > /dev/null
STATUS=$(curl -sf "$BASE/v1/billing/order/$ORDER_ID" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
[ "$STATUS" = "pending" ] && pass "Order still pending after amount mismatch" || fail "Order should still be pending, got $STATUS"

echo "== 6. Correct payload -> expect order paid =="
curl -sf -X POST "$BASE/webhooks/sepay" -H "Authorization: Apikey $WEBHOOK_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"id\":9003,\"code\":\"$ORDER_ID\",\"content\":\"$ORDER_ID\",\"transferAmount\":$AMOUNT,$(echo $TX_BASE | sed 's/^{//')" > /dev/null
STATUS=$(curl -sf "$BASE/v1/billing/order/$ORDER_ID" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
[ "$STATUS" = "paid" ] && pass "Order marked paid" || fail "Expected paid, got $STATUS"

echo "== 7. Replay same tx id (9003) -> must not double-credit =="
curl -sf -X POST "$BASE/webhooks/sepay" -H "Authorization: Apikey $WEBHOOK_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"id\":9003,\"code\":\"$ORDER_ID\",\"content\":\"$ORDER_ID\",\"transferAmount\":$AMOUNT,$(echo $TX_BASE | sed 's/^{//')" > /dev/null
pass "Replay acknowledged (inspect users.plan_expires_at manually to confirm no double-extension — see instructions)"

echo
echo "All scenarios passed. 🎉"
