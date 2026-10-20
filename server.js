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

app.post("/api/admin/renters", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const requiredText = ["email", "name", "unitName", "rentalType", "contractStart"];
  if (requiredText.some((key) => typeof body[key] !== "string" || !body[key].trim()) ||
      !["Room", "House", "Apartment"].includes(body.rentalType) ||
      !["Vasquez", "Villa", "Cabalawan", "Kaskag"].includes(body.location) ||
      ![6, 12].includes(Number(body.contractMonths)) ||
      !Number.isInteger(body.rentDueDay) || body.rentDueDay < 1 || body.rentDueDay > 31 ||
      typeof body.rentAmount !== "number" || !Number.isFinite(body.rentAmount) || body.rentAmount < 0 ||
      typeof body.password !== "string" || body.password.length < 12 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.contractStart) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.contractEnd)) {
    return res.status(400).json({ error: "Provide valid renter details and a password of at least 12 characters." });
  }

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: body.email.trim(),
    password: body.password,
    email_confirm: true,
    user_metadata: {
      full_name: body.name.trim(),
      phone: typeof body.phone === "string" ? body.phone.trim() : "",
    },
  });
  if (createError) return res.status(400).json({ error: createError.message });

  const { data: renter, error: renterError } = await adminClient.from("renters").insert({
    user_id: created.user.id,
    full_name: body.name.trim(),
    email: body.email.trim(),
    phone: typeof body.phone === "string" ? body.phone.trim() : "",
    unit_name: body.unitName.trim(),
    location: body.location,
    rental_type: body.rentalType,
    contract_months: Number(body.contractMonths),
    contract_start: body.contractStart,
    contract_end: body.contractEnd,
    rent_amount: body.rentAmount,
    rent_due_day: Number(body.rentDueDay),
  }).select().single();

  if (renterError) {
    const { error: rollbackError } = await adminClient.auth.admin.deleteUser(created.user.id);
    if (rollbackError) console.error("Could not remove auth user after renter creation failed:", rollbackError.message);
    return res.status(400).json({ error: renterError.message });
  }
  res.status(201).json({ renter });
});

app.put("/api/admin/renters/:renterId/password", requireAdmin, async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== "string" || password.length < 12) {
    return res.status(400).json({ error: "The renter password must be at least 12 characters." });
  }

  const { data: renter, error: renterError } = await adminClient
    .from("renters").select("user_id").eq("id", req.params.renterId).maybeSingle();
  if (renterError) return res.status(500).json({ error: "Could not look up the renter account." });
  if (!renter?.user_id) return res.status(404).json({ error: "No login account is linked to this renter." });

  const { data: profile, error: profileError } = await adminClient
    .from("profiles").select("role").eq("id", renter.user_id).maybeSingle();
  if (profileError) return res.status(500).json({ error: "Could not verify the renter account." });
  if (profile?.role !== "renter") return res.status(409).json({ error: "This linked account is not a renter account." });

  const { error: updateError } = await adminClient.auth.admin.updateUserById(renter.user_id, { password });
  if (updateError) return res.status(400).json({ error: updateError.message });
  res.json({ updated: true });
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
