export interface Env {
  DB: D1Database;
  LICENSE_TOKEN_SECRET: string;
  LICENSE_ADMIN_TOKEN?: string;
}

type Plan = "monthly" | "quarterly" | "lifetime";

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

    return json({ ok: false, error: "not_found" }, 404);
  }
};

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
    return json({ ok: false, error: "bad_request", message: "plan must be monthly, quarterly, or lifetime." }, 400);
  }

  const issuedAt = body.startsAt && !Number.isNaN(Date.parse(body.startsAt))
    ? new Date(body.startsAt)
    : new Date();
  const expiresAt = normalizeExpiry(plan, issuedAt, body.expiresAt);
  const licenseKey = normalizeLicenseKey(body.licenseKey) || generateLicenseKey();
  const orderId = sanitize(body.orderId, 128);
  const customerEmail = sanitize(body.customerEmail, 256).toLowerCase();

  if (orderId) {
    const existing = await env.DB.prepare(`
      SELECT license_key, plan, status, issued_at, expires_at
      FROM licenses
      WHERE order_id = ?
    `).bind(orderId).first<IssuedLicenseRow>();
    if (existing) {
      return json({ ok: true, license: existing, idempotent: true });
    }
  }

  try {
    const row = await env.DB.prepare(`
      INSERT INTO licenses (license_key, plan, status, issued_at, expires_at, order_id, customer_email)
      VALUES (?, ?, 'active', ?, ?, ?, ?)
      RETURNING license_key, plan, status, issued_at, expires_at
    `).bind(
      licenseKey,
      plan,
      issuedAt.toISOString(),
      expiresAt,
      orderId || null,
      customerEmail || null
    ).first<IssuedLicenseRow>();

    return json({ ok: true, license: row });
  } catch {
    return json({ ok: false, error: "license_key_conflict", message: "License key already exists." }, 409);
  }
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
  if (value === "monthly" || value === "quarterly" || value === "lifetime") {
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
  expires.setUTCMonth(expires.getUTCMonth() + (plan === "quarterly" ? 3 : 1));
  return expires.toISOString();
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
