export interface Env {
  DB: D1Database;
  LICENSE_TOKEN_SECRET: string;
  LICENSE_ADMIN_TOKEN?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_MONTHLY?: string;
  PADDLE_PRICE_YEARLY?: string;
  PADDLE_PRICE_LIFETIME?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
}

type Plan = "monthly" | "yearly" | "lifetime";

interface ActivationRequest {
  licenseKey?: string;
  device?: {
    fingerprint?: string;
    platform?: string;
    machineName?: string;
    appVersion?: string;
  };
}

interface LicenseRow {
  id: number;
  plan: Plan;
  status: string;
  expires_at: string | null;
}

interface ActivationRow {
  id: number;
  license_id: number;
  device_fingerprint: string;
}

interface IssueLicenseRequest {
  plan?: string;
  licenseKey?: string;
  orderId?: string;
  customerEmail?: string;
  startsAt?: string;
  expiresAt?: string | null;
}

interface IssuedLicenseRow {
  license_key: string;
  plan: Plan;
  status: string;
  issued_at: string;
  expires_at: string | null;
}

interface IssueLicenseInput {
  plan: Plan;
  licenseKey?: string;
  orderId?: string;
  customerEmail?: string;
  startsAt?: string;
  expiresAt?: string | null;
}

interface PaddleEvent {
  id?: string;
  event_id?: string;
  event_type?: string;
  data?: Record<string, unknown>;
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "amazemend-license" });
    }

    if (request.method === "POST" && url.pathname === "/v1/licenses/activate") {
      return activate(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/licenses") {
      return issueLicense(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/webhooks/paddle") {
      return paddleWebhook(request, env);
    }

    return json({ ok: false, error: "not_found" }, 404);
  }
};

async function paddleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.PADDLE_WEBHOOK_SECRET) {
    return json({ ok: false, error: "paddle_webhook_not_configured" }, 501);
  }

  const rawBody = await request.text();
  const signature = request.headers.get("paddle-signature") || "";
  if (!await verifyPaddleSignature(signature, rawBody, env.PADDLE_WEBHOOK_SECRET)) {
    return json({ ok: false, error: "invalid_signature" }, 401);
  }

  let event: PaddleEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "bad_request", message: "Invalid JSON body." }, 400);
  }

  const eventId = event.id || event.event_id;
  const eventType = event.event_type || "";
  if (!eventId) {
    return json({ ok: false, error: "bad_request", message: "Missing event id." }, 400);
  }

  if (eventType !== "transaction.completed") {
    return json({ ok: true, ignored: true, eventType });
  }

  const processed = await env.DB.prepare(
    "SELECT event_id FROM webhook_events WHERE event_id = ?"
  ).bind(eventId).first<{ event_id: string }>();
  if (processed) {
    return json({ ok: true, duplicate: true });
  }

  const data = event.data || {};
  const plan = extractPaddlePlan(data, env);
  const orderId = extractString(data, ["id"]) || eventId;
  const customerEmail = extractPaddleEmail(data);
  if (!plan) {
    return json({ ok: false, error: "unknown_plan", message: "Unable to map Paddle price to a license plan." }, 400);
  }
  if (!customerEmail) {
    return json({ ok: false, error: "missing_customer_email", message: "Paddle event did not include customer email." }, 400);
  }

  const license = await createLicense(env, {
    plan,
    orderId,
    customerEmail
  });

  await sendLicenseEmail(env, customerEmail, license);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO webhook_events (event_id, provider, event_type)
    VALUES (?, 'paddle', ?)
  `).bind(eventId, eventType).run();

  return json({
    ok: true,
    license: {
      license_key: license.license_key,
      plan: license.plan,
      expires_at: license.expires_at
    }
  });
}

async function issueLicense(request: Request, env: Env): Promise<Response> {
  if (!env.LICENSE_ADMIN_TOKEN) {
    return json({ ok: false, error: "admin_not_configured" }, 501);
  }

  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${env.LICENSE_ADMIN_TOKEN}`) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: IssueLicenseRequest;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request", message: "Invalid JSON body." }, 400);
  }

  const plan = normalizePlan(body.plan);
  if (!plan) {
    return json({ ok: false, error: "bad_request", message: "plan must be monthly, yearly, or lifetime." }, 400);
  }

  try {
    const row = await createLicense(env, {
      plan,
      licenseKey: body.licenseKey,
      orderId: body.orderId,
      customerEmail: body.customerEmail,
      startsAt: body.startsAt,
      expiresAt: body.expiresAt
    });

    return json({ ok: true, license: row });
  } catch {
    return json({ ok: false, error: "license_key_conflict", message: "License key already exists." }, 409);
  }
}

async function createLicense(env: Env, input: IssueLicenseInput): Promise<IssuedLicenseRow> {
  const issuedAt = input.startsAt && !Number.isNaN(Date.parse(input.startsAt))
    ? new Date(input.startsAt)
    : new Date();
  const expiresAt = normalizeExpiry(input.plan, issuedAt, input.expiresAt);
  const licenseKey = normalizeLicenseKey(input.licenseKey) || generateLicenseKey();
  const orderId = sanitize(input.orderId, 128);
  const customerEmail = sanitize(input.customerEmail, 256).toLowerCase();

  if (orderId) {
    const existing = await env.DB.prepare(`
      SELECT license_key, plan, status, issued_at, expires_at
      FROM licenses
      WHERE order_id = ?
    `).bind(orderId).first<IssuedLicenseRow>();
    if (existing) {
      return existing;
    }
  }

  const row = await env.DB.prepare(`
    INSERT INTO licenses (license_key, plan, status, issued_at, expires_at, order_id, customer_email)
    VALUES (?, ?, 'active', ?, ?, ?, ?)
    RETURNING license_key, plan, status, issued_at, expires_at
  `).bind(
    licenseKey,
    input.plan,
    issuedAt.toISOString(),
    expiresAt,
    orderId || null,
    customerEmail || null
  ).first<IssuedLicenseRow>();

  if (!row) {
    throw new Error("Unable to create license.");
  }
  return row;
}

async function activate(request: Request, env: Env): Promise<Response> {
  let body: ActivationRequest;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request", message: "Invalid JSON body." }, 400);
  }

  const licenseKey = normalizeLicenseKey(body.licenseKey);
  const fingerprint = body.device?.fingerprint?.trim().toLowerCase() ?? "";
  const platform = sanitize(body.device?.platform, 32) || "unknown";
  const machineName = sanitize(body.device?.machineName, 128);
  const appVersion = sanitize(body.device?.appVersion, 64);

  if (!licenseKey || !isValidFingerprint(fingerprint)) {
    return json({ ok: false, error: "bad_request", message: "License key and device fingerprint are required." }, 400);
  }

  const license = await env.DB.prepare(
    "SELECT id, plan, status, expires_at FROM licenses WHERE license_key = ?"
  ).bind(licenseKey).first<LicenseRow>();

  if (!license) {
    await audit(env, null, licenseKey, fingerprint, "invalid_license", request);
    return json({ ok: false, error: "invalid_license", message: "License key was not found." }, 404);
  }

  if (license.status !== "active") {
    await audit(env, license.id, licenseKey, fingerprint, "license_disabled", request);
    return json({ ok: false, error: "license_disabled", message: "License is not active." }, 403);
  }

  if (license.plan !== "lifetime" && license.expires_at && Date.parse(license.expires_at) <= Date.now()) {
    await audit(env, license.id, licenseKey, fingerprint, "license_expired", request);
    return json({ ok: false, error: "license_expired", message: "License has expired." }, 403);
  }

  const activation = await env.DB.prepare(`
    INSERT INTO activations (license_id, device_fingerprint, platform, machine_name, app_version)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(license_id) DO UPDATE SET
      last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      platform = excluded.platform,
      machine_name = excluded.machine_name,
      app_version = excluded.app_version
    WHERE activations.device_fingerprint = excluded.device_fingerprint
    RETURNING id, license_id, device_fingerprint
  `).bind(license.id, fingerprint, platform, machineName, appVersion).first<ActivationRow>();

  if (!activation) {
    await audit(env, license.id, licenseKey, fingerprint, "device_limit_reached", request);
    return json({
      ok: false,
      error: "device_limit_reached",
      message: "This license is already bound to another device."
    }, 409);
  }

  await audit(env, license.id, licenseKey, fingerprint, "activated", request);

  const serverTime = new Date().toISOString();
  const token = await signActivation(env, {
    licenseId: license.id,
    plan: license.plan,
    fingerprint,
    expiresAt: license.expires_at,
    serverTime
  });

  return json({
    ok: true,
    status: "active",
    plan: license.plan,
    expiresAt: license.expires_at,
    bound: true,
    serverTime,
    token
  });
}

function normalizeLicenseKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizePlan(value: unknown): Plan | null {
  if (value === "monthly" || value === "yearly" || value === "lifetime") {
    return value;
  }
  return null;
}

function normalizeExpiry(plan: Plan, issuedAt: Date, explicitExpiry: string | null | undefined): string | null {
  if (plan === "lifetime") {
    return null;
  }
  if (explicitExpiry && !Number.isNaN(Date.parse(explicitExpiry))) {
    return new Date(explicitExpiry).toISOString();
  }
  const expires = new Date(issuedAt.getTime());
  expires.setUTCMonth(expires.getUTCMonth() + (plan === "yearly" ? 12 : 1));
  return expires.toISOString();
}

function extractPaddlePlan(data: Record<string, unknown>, env: Env): Plan | null {
  const customData = readObject(data.custom_data) || readObject(data.customData);
  const customPlan = normalizePlan(customData?.plan);
  if (customPlan) {
    return customPlan;
  }

  const priceIds = collectPaddlePriceIds(data);
  if (env.PADDLE_PRICE_MONTHLY && priceIds.includes(env.PADDLE_PRICE_MONTHLY)) {
    return "monthly";
  }
  if (env.PADDLE_PRICE_YEARLY && priceIds.includes(env.PADDLE_PRICE_YEARLY)) {
    return "yearly";
  }
  if (env.PADDLE_PRICE_LIFETIME && priceIds.includes(env.PADDLE_PRICE_LIFETIME)) {
    return "lifetime";
  }
  return null;
}

function collectPaddlePriceIds(data: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const addFromItem = (item: unknown) => {
    const object = readObject(item);
    if (!object) {
      return;
    }
    const price = readObject(object.price);
    const priceId = extractString(object, ["price_id", "priceId"]) || extractString(price || {}, ["id"]);
    if (priceId) {
      ids.add(priceId);
    }
  };

  const items = readArray(data.items) || readArray(data.line_items) || readArray(data.details && readObject(data.details)?.line_items);
  if (items) {
    for (const item of items) {
      addFromItem(item);
    }
  }

  return [...ids];
}

function extractPaddleEmail(data: Record<string, unknown>): string {
  const customer = readObject(data.customer);
  const billingDetails = readObject(data.billing_details);
  const checkout = readObject(data.checkout);
  return (
    extractString(data, ["customer_email", "email"]) ||
    extractString(customer || {}, ["email"]) ||
    extractString(billingDetails || {}, ["email"]) ||
    extractString(checkout || {}, ["email"])
  ).toLowerCase();
}

function extractString(object: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

async function verifyPaddleSignature(signatureHeader: string, rawBody: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(signatureHeader.split(";").map((part) => {
    const [key, value] = part.split("=");
    return [key?.trim(), value?.trim()];
  }));
  const timestamp = parts.ts;
  const signature = parts.h1;
  if (!timestamp || !signature) {
    return false;
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}:${rawBody}`);
  return timingSafeEqual(expected, signature);
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; ++i) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function sendLicenseEmail(env: Env, to: string, license: IssuedLicenseRow): Promise<void> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    throw new Error("Email is not configured. Set RESEND_API_KEY and MAIL_FROM.");
  }

  const planLabel = license.plan === "monthly"
    ? "1-Month License"
    : license.plan === "yearly"
      ? "1-Year License"
      : "Lifetime License";
  const expires = license.expires_at ? `Expires: ${license.expires_at}` : "Expires: never";
  const text = [
    "Thank you for purchasing AmazeMend.",
    "",
    `Plan: ${planLabel}`,
    `License Key: ${license.license_key}`,
    expires,
    "",
    "Download:",
    "https://amazemend.com/download.html",
    "",
    "Activation:",
    "Open AmazeMend, click Save/Export, then enter your license key.",
    "",
    "AmazeMend Support"
  ].join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to,
      subject: "Your AmazeMend License Key",
      text
    })
  });

  if (!response.ok) {
    throw new Error(`Email send failed: ${response.status}`);
  }
}

function generateLicenseKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const text = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `AMZ-${text.slice(0, 6)}-${text.slice(6, 12)}-${text.slice(12, 18)}-${text.slice(18, 24)}`;
}

function sanitize(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isValidFingerprint(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

async function audit(
  env: Env,
  licenseId: number | null,
  licenseKey: string,
  fingerprint: string,
  eventType: string,
  request: Request
): Promise<void> {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
  const userAgent = request.headers.get("user-agent") || "";
  await env.DB.prepare(`
    INSERT INTO activation_events
      (license_id, license_key_hash, device_fingerprint, event_type, ip_hash, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    licenseId,
    await sha256(licenseKey),
    fingerprint || null,
    eventType,
    ip ? await sha256(ip) : null,
    userAgent.slice(0, 256)
  ).run();
}

async function signActivation(env: Env, payload: Record<string, unknown>): Promise<string> {
  const body = base64Url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.LICENSE_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64Url(sig)}`;
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}
