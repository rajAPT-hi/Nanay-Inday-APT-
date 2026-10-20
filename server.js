require("dotenv").config();

const express = require("express");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const port = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");
const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
const adminClient = configured && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/config", (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    cloudReady: configured,
    smsReady: Boolean(process.env.SMS_GATEWAY_URL && process.env.SMS_GATEWAY_TOKEN),
  });
});

async function requireAdmin(req, res, next) {
  if (!adminClient) return res.status(503).json({ error: "Cloud services are not configured." });
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sign in is required." });

  const { data: { user }, error: userError } = await adminClient.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: "Your session is invalid or expired." });

  const { data: profile, error: profileError } = await adminClient
    .from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profileError) return res.status(500).json({ error: "Could not verify your account role." });
  if (profile?.role !== "admin") return res.status(403).json({ error: "Administrator access is required." });

  req.adminUser = user;
  next();
}

app.post("/api/admin/invite", requireAdmin, async (req, res) => {
  const { email, name, phone } = req.body || {};
  if (typeof email !== "string" || !email.trim() || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "A renter name and email address are required." });
  }

  const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email.trim(), {
    data: { full_name: name.trim(), phone: typeof phone === "string" ? phone.trim() : "" },
  });
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ userId: data.user.id });
});

app.post("/api/sms/payment-reminder", requireAdmin, async (req, res) => {
  const { phone, renterName, amount, dueDate } = req.body || {};
  if (!process.env.SMS_GATEWAY_URL || !process.env.SMS_GATEWAY_TOKEN) {
    return res.status(503).json({ error: "SIM SMS gateway is not configured." });
  }
  if (typeof phone !== "string" || !phone.trim() || typeof renterName !== "string" ||
      typeof amount !== "number" || !Number.isFinite(amount) || typeof dueDate !== "string") {
    return res.status(400).json({ error: "Valid renter phone and payment details are required." });
  }

  const message = `Hello ${renterName}, this is a payment reminder from Nanay Inday's Rentals. PHP ${amount.toFixed(2)} is due ${dueDate}. Please contact us if you have already paid.`;
  try {
    const gatewayResponse = await fetch(process.env.SMS_GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SMS_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({ to: phone.trim(), message }),
      signal: AbortSignal.timeout(10000),
    });
    if (!gatewayResponse.ok) {
      return res.status(502).json({ error: `SMS gateway returned HTTP ${gatewayResponse.status}.` });
    }
    res.json({ sent: true });
  } catch (error) {
    console.error("SMS gateway request failed:", error.message);
    res.status(502).json({ error: "Could not reach the SIM SMS gateway." });
  }
});

app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => console.log(`Nanay Inday's Rentals listening on ${port}`));
