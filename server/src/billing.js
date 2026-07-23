// server/src/billing.js
// SePay VietQR billing: checkout (create pending order + QR), order-status
// poll, and the SePay webhook that confirms payment and extends the plan.
//
// No SePay API key/account needed for checkout — qr.sepay.vn/img is a public,
// unauthenticated QR-image endpoint driven entirely by URL params (account,
// bank, amount, transfer content). Order matching works by embedding the
// order id as the transfer content (`des`) and reading it back out of the
// webhook's `content`/`code` fields — no SePay "order" concept required.
//
// Webhook payload shape and the `Authorization: Apikey <key>` auth scheme
// are per SePay's official docs (developer.sepay.vn/en/sepay-webhooks).

const PLANS = {
  monthly: { amount: 99000, days: 30, label: 'Semantica Premium — Monthly' },
  annual: { amount: 899000, days: 365, label: 'Semantica Premium — Annual' },
};

// ── Checkout ─────────────────────────────────────────────────────────────

/**
 * POST /v1/billing/checkout
 * Body: { plan: 'monthly' | 'annual' }
 * @param {Request} req
 * @param {{ DB: D1Database, SEPAY_BANK_ACCOUNT: string, SEPAY_BANK_NAME: string }} env
 * @param {string} userId
 */
export async function handleBillingCheckout(req, env, userId) {
  let body;
  try { body = await req.json(); } catch {
    return errResponse('Invalid JSON body', 400);
  }

  const plan = body?.plan;
  const planConfig = PLANS[plan];
  if (!planConfig) return errResponse('Invalid plan — use "monthly" or "annual"', 400);

  if (!env.SEPAY_BANK_ACCOUNT || !env.SEPAY_BANK_NAME) {
    return errResponse('Billing is not configured on this server yet', 503);
  }

  const orderId = _generateOrderId();
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO orders (id, user_id, plan, amount, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).bind(orderId, userId, plan, planConfig.amount, now).run();

  return okResponse({
    orderId,
    plan,
    label: planConfig.label,
    amount: planConfig.amount,
    bankAccount: env.SEPAY_BANK_ACCOUNT,
    bankName: env.SEPAY_BANK_NAME,
    transferContent: orderId,
    qrUrl: _buildQrUrl(env, orderId, planConfig.amount),
  });
}

/**
 * GET /v1/billing/order/:id — client polls this after showing the QR to
 * detect the webhook flipping status to 'paid'.
 */
export async function handleBillingOrderGet(env, userId, orderId) {
  if (!orderId) return errResponse('Missing order id', 400);

  const row = await env.DB.prepare(
    `SELECT id, plan, amount, status, created_at, paid_at
     FROM orders WHERE id = ? AND user_id = ?`
  ).bind(orderId, userId).first();

  if (!row) return errResponse('Order not found', 404);
  return okResponse(row);
}

/** GET /v1/billing/status — reads straight off the auth middleware's context, no extra DB call. */
export function handleBillingStatus(isPro, planExpiresAt) {
  return okResponse({ isPro: !!isPro, planExpiresAt: planExpiresAt || null });
}

function _buildQrUrl(env, orderId, amount) {
  const params = new URLSearchParams({
    acc: env.SEPAY_BANK_ACCOUNT,
    bank: env.SEPAY_BANK_NAME,
    amount: String(amount),
    des: orderId,
    template: 'compact',
  });
  return `https://qr.sepay.vn/img?${params.toString()}`;
}

/** SMTC + 8 uppercase hex chars — short, no spaces/special chars, greppable in a bank transfer memo. */
function _generateOrderId() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `SMTC${hex.slice(0, 8)}`;
}

// ── Webhook ──────────────────────────────────────────────────────────────

/**
 * POST /webhooks/sepay — called by SePay, not by an app user. Auth is a
 * static `Authorization: Apikey <SEPAY_WEBHOOK_KEY>` header (configured to
 * match in the SePay dashboard's webhook Security step), NOT the app's
 * per-user Bearer token — this route sits outside the /v1/* auth middleware.
 *
 * Must respond within 30s with HTTP 200/201 and body {"success": true} or
 * SePay will retry — see developer.sepay.vn/en/sepay-webhooks/tich-hop-webhook.
 * @param {Request} req
 * @param {{ DB: D1Database, SEPAY_WEBHOOK_KEY: string }} env
 */
export async function handleSepayWebhook(req, env) {
  if (!env.SEPAY_WEBHOOK_KEY) {
    console.error('SePay webhook: SEPAY_WEBHOOK_KEY not configured — rejecting all webhook calls');
    return errWebhook(401);
  }

  const authHeader = req.headers.get('Authorization') || '';
  if (!_safeEqual(authHeader, `Apikey ${env.SEPAY_WEBHOOK_KEY}`)) {
    console.error('SePay webhook: invalid or missing Authorization header');
    return errWebhook(401);
  }

  let tx;
  try { tx = await req.json(); } catch {
    return errWebhook(400);
  }

  // Only credit incoming transfers — outgoing ('out') never applies here.
  if (tx.transferType !== 'in') return okWebhook();

  const txId = tx.id != null ? String(tx.id) : null;
  if (!txId) {
    console.error('SePay webhook: payload missing `id` — cannot dedupe, dropping');
    return okWebhook();
  }

  // Idempotency first: SePay retries on any non-200, so a duplicate `id`
  // must be a no-op, not a second plan extension.
  const already = await env.DB.prepare(
    'SELECT id FROM orders WHERE sepay_tx_id = ?'
  ).bind(txId).first();
  if (already) return okWebhook();

  const orderId = _extractOrderId(tx);
  if (!orderId) {
    console.error(`SePay webhook: no order id found in content="${tx.content}" code="${tx.code}" (tx ${txId})`);
    return okWebhook(); // acknowledge — nothing to retry, this transfer just isn't ours to match
  }

  const order = await env.DB.prepare(
    `SELECT * FROM orders WHERE id = ? AND status = 'pending'`
  ).bind(orderId).first();
  if (!order) {
    console.error(`SePay webhook: order ${orderId} not found or already paid (tx ${txId})`);
    return okWebhook();
  }

  if (Number(tx.transferAmount) !== Number(order.amount)) {
    console.error(
      `SePay webhook: amount mismatch for ${orderId} — expected ${order.amount}, got ${tx.transferAmount} (tx ${txId}). Not crediting; needs manual review.`
    );
    return okWebhook();
  }

  const planConfig = PLANS[order.plan];
  const now = Math.floor(Date.now() / 1000);

  // Extend from the later of (current expiry, now) — a renewal before expiry
  // stacks on top of remaining time instead of discarding it.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET status = 'paid', paid_at = ?, sepay_tx_id = ? WHERE id = ?`
    ).bind(now, txId, orderId),
    env.DB.prepare(
      `UPDATE users SET plan_expires_at = MAX(COALESCE(plan_expires_at, 0), ?) + ? WHERE id = ?`
    ).bind(now, planConfig.days * 86400, order.user_id),
  ]);

  console.log(`SePay webhook: order ${orderId} paid (tx ${txId}), user ${order.user_id} plan extended ${planConfig.days}d`);
  return okWebhook();
}

/** SePay auto-extracts a `code` from the memo when it matches a configured
 * prefix pattern, but the field "can be null" per their docs — so match
 * against the raw `content` too, which is always present. */
function _extractOrderId(tx) {
  const haystack = [tx.code, tx.content, tx.description].filter(Boolean).join(' ');
  const match = haystack.match(/SMTC[0-9A-F]{8}/i);
  return match ? match[0].toUpperCase() : null;
}

function _safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function okWebhook() {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errWebhook(status) {
  return new Response(JSON.stringify({ success: false }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function okResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function errResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
