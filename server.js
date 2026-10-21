require("dotenv").config();

const express = require("express");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");

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

async function requireAuthenticatedUser(req, res, next) {
  if (!adminClient) return res.status(503).json({ error: "Cloud services are not configured." });
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sign in is required." });

  const { data: { user }, error } = await adminClient.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Your session is invalid or expired." });
  req.authenticatedUser = user;
  next();
}

app.get("/api/account-status", requireAuthenticatedUser, async (req, res) => {
  const { data: renter, error } = await adminClient.from("renters")
    .select("status, termination_reason")
    .eq("user_id", req.authenticatedUser.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: "Could not check your rental account status." });
  res.json({
    status: renter?.status || "unlinked",
    terminationReason: renter?.termination_reason || "",
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

function manilaDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function nextRentDueDate(today, dueDay) {
  const [year, month, day] = today.split("-").map(Number);
  const getDate = (targetYear, targetMonth) => {
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(dueDay, lastDay)).padStart(2, "0")}`;
  };
  const dueThisMonth = getDate(year, month - 1);
  if (dueThisMonth >= today) return dueThisMonth;
  const nextMonth = new Date(Date.UTC(year, month, 1));
  return getDate(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth());
}

function daysBetween(from, to) {
  const dateValue = (value) => {
    const [year, month, day] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((dateValue(to) - dateValue(from)) / 86400000);
}

function createMailTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASSWORD || !SMTP_FROM) return null;
  return {
    from: SMTP_FROM,
    transport: nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    }),
  };
}

let reminderCheckRunning = false;
async function sendUpcomingRentReminders() {
  if (!adminClient || reminderCheckRunning) return;
  const mail = createMailTransport();
  if (!mail) return;
  reminderCheckRunning = true;
  try {
    const today = manilaDateString();
    const [year, month, dayOfMonth] = today.split("-").map(Number);
    const reminderHorizon = new Date(Date.UTC(year, month - 1, dayOfMonth + 7)).toISOString().slice(0, 10);
    const [{ data: renters, error: rentersError }, { data: admins, error: adminsError }, { data: paidPayments, error: paymentsError }, { data: legacyReminders, error: legacyError }] = await Promise.all([
      adminClient.from("renters").select("id, user_id, email, full_name, unit_name, location, rent_amount, rent_due_day").eq("status", "active"),
      adminClient.from("profiles").select("id").eq("role", "admin"),
      adminClient.from("payments").select("renter_id, due_date").eq("status", "paid").gte("due_date", today).lte("due_date", reminderHorizon),
      adminClient.from("rent_reminder_emails").select("renter_id, due_date, reminder_days").eq("status", "sent").gte("due_date", today).lte("due_date", reminderHorizon),
    ]);
    if (rentersError) throw rentersError;
    if (adminsError) throw adminsError;
    if (paymentsError) throw paymentsError;
    if (legacyError) throw legacyError;

    const adminUsers = await Promise.all((admins || []).map(async ({ id }) => {
      const { data, error } = await adminClient.auth.admin.getUserById(id);
      if (error) throw error;
      return data.user;
    }));
    const adminRecipients = [...new Map(adminUsers
      .filter((user) => user?.email)
      .map((user) => [user.email.toLowerCase(), { email: user.email, type: "admin" }])).values()];
    const adminEmails = new Set(adminRecipients.map((recipient) => recipient.email.toLowerCase()));

    const paidDueDates = new Set((paidPayments || []).map(({ renter_id, due_date }) => `${renter_id}:${due_date}`));
    const legacyAdminReminders = new Set((legacyReminders || [])
      .map(({ renter_id, due_date, reminder_days }) => `${renter_id}:${due_date}:${reminder_days}`));
    for (const renter of renters || []) {
      const dueDate = nextRentDueDate(today, Number(renter.rent_due_day) || 5);
      const reminderDays = daysBetween(today, dueDate);
      if (![0, 7].includes(reminderDays) || paidDueDates.has(`${renter.id}:${dueDate}`)) continue;

      const dateLabel = new Date(`${dueDate}T00:00:00Z`).toLocaleDateString("en-PH", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const timing = reminderDays === 0 ? "is due today" : "is due in 7 days";
      const recipients = [
        ...adminRecipients,
        ...(typeof renter.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(renter.email.trim()) &&
          !adminEmails.has(renter.email.trim().toLowerCase())
          ? [{ email: renter.email, type: "renter" }]
          : []),
      ];
      for (const recipient of recipients) {
        if (recipient.type === "admin" && legacyAdminReminders.has(`${renter.id}:${dueDate}:${reminderDays}`)) continue;
        const deliveryKey = {
          renter_id: renter.id,
          due_date: dueDate,
          reminder_days: reminderDays,
          recipient_email: recipient.email.toLowerCase(),
        };
        const { error: claimError } = await adminClient.from("rent_reminder_email_deliveries")
          .insert({
            ...deliveryKey,
            recipient_type: recipient.type,
            status: "sending",
          });
        if (claimError?.code === "23505") {
          const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          const { data: retry, error: retryError } = await adminClient.from("rent_reminder_email_deliveries")
            .update({ status: "sending", error_message: null, recipient_type: recipient.type, updated_at: new Date().toISOString() })
            .match(deliveryKey)
            .or(`status.eq.failed,and(status.eq.sending,updated_at.lt.${staleBefore})`)
            .select("renter_id")
            .maybeSingle();
          if (retryError) {
            console.error(`Could not retry rent reminder for ${recipient.type}:`, retryError.message);
            continue;
          }
          if (!retry) continue;
        } else if (claimError) {
          console.error(`Could not claim rent reminder for ${recipient.type}:`, claimError.message);
          continue;
        }

        try {
          const isRenter = recipient.type === "renter";
          await mail.transport.sendMail({
            from: mail.from,
            to: recipient.email,
            subject: isRenter
              ? `Rent reminder: your payment ${timing} · ${dateLabel}`
              : `Rent ${timing}: ${renter.full_name} · ${dateLabel}`,
            text: isRenter
              ? [
                  `Hello ${renter.full_name},`,
                  `This is a rent reminder from Nanay Inday's Rentals. Your rent for ${renter.unit_name}${renter.location ? ` at ${renter.location}` : ""} is ${timing}.`,
                  `Amount: PHP ${Number(renter.rent_amount).toFixed(2)}`,
                  `Due date: ${dateLabel}`,
                  "If you have already paid, please contact the administrator.",
                ].join("\n")
              : [
                  `Rent reminder for ${renter.full_name}.`,
                  `Unit: ${renter.unit_name}${renter.location ? ` · ${renter.location}` : ""}`,
                  `Monthly rent: PHP ${Number(renter.rent_amount).toFixed(2)}`,
                  `Due date: ${dateLabel}`,
                  `This reminder was sent ${reminderDays === 0 ? "on the due date" : "7 days before the due date"}.`,
                ].join("\n"),
          });
        } catch (error) {
          console.error(`Could not send ${recipient.type} rent reminder for renter ${renter.id}:`, error.message);
          const { error: logError } = await adminClient.from("rent_reminder_email_deliveries")
            .update({ status: "failed", error_message: String(error.message).slice(0, 1000), updated_at: new Date().toISOString() })
            .match(deliveryKey);
          if (logError) console.error("Could not record failed rent reminder:", logError.message);
          continue;
        }
        const { error: sentError } = await adminClient.from("rent_reminder_email_deliveries")
          .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null, updated_at: new Date().toISOString() })
          .match(deliveryKey);
        if (sentError) {
          console.error(`Email sent but status could not be saved for ${recipient.type} reminder to renter ${renter.id}:`, sentError.message);
          continue;
        }
        console.info(`Sent ${reminderDays}-day rent reminder to ${recipient.type} for renter ${renter.id}.`);
      }
    }
  } catch (error) {
    console.error("Rent reminder check failed:", error.message);
  } finally {
    reminderCheckRunning = false;
  }
}

app.post("/api/admin/renters", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const requiredText = ["name", "unitName", "rentalType", "contractStart"];
  const emailInput = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (requiredText.some((key) => typeof body[key] !== "string" || !body[key].trim()) ||
      !["Room", "House", "Apartment"].includes(body.rentalType) ||
      !["Vasquez", "Villa", "Cabalawan", "Kaskag", "Cebu"].includes(body.location) ||
      ![6, 12].includes(Number(body.contractMonths)) ||
      !Number.isInteger(body.rentDueDay) || body.rentDueDay < 1 || body.rentDueDay > 31 ||
      typeof body.rentAmount !== "number" || !Number.isFinite(body.rentAmount) || body.rentAmount < 0 ||
      (body.email !== undefined && body.email !== null && typeof body.email !== "string") ||
      (emailInput && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) ||
      (password && (!emailInput || password.length < 12)) ||
      (body.password !== undefined && typeof body.password !== "string") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.contractStart) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.contractEnd)) {
    return res.status(400).json({ error: "Provide valid renter details. To create a login now, provide a valid email and a password of at least 12 characters." });
  }

  let createdUser = null;
  if (password) {
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email: emailInput,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: body.name.trim(),
        phone: typeof body.phone === "string" ? body.phone.trim() : "",
      },
    });
    if (createError) {
      const duplicateEmail = /already|registered|exists/i.test(createError.message);
      return res.status(400).json({
        error: duplicateEmail
          ? `The email ${emailInput} already belongs to a Supabase account. Use a unique renter email, or add the renter first and check their existing login.`
          : `Supabase could not create the renter login: ${createError.message}`,
      });
    }
    createdUser = created.user;
  }

  const { data: renter, error: renterError } = await adminClient.from("renters").insert({
    user_id: createdUser?.id || null,
    full_name: body.name.trim(),
    email: emailInput || null,
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
    if (createdUser) {
      const { error: rollbackError } = await adminClient.auth.admin.deleteUser(createdUser.id);
      if (rollbackError) console.error("Could not remove auth user after renter creation failed:", rollbackError.message);
    }
    return res.status(400).json({ error: renterError.message });
  }
  res.status(201).json({ renter });
});

app.get("/api/admin/renter-notes", requireAdmin, async (_req, res) => {
  const { data, error } = await adminClient.from("renter_admin_notes").select("renter_id, note");
  if (error) return res.status(500).json({ error: "Could not load administrator renter notes." });
  res.json({ notes: Object.fromEntries(data.map(({ renter_id, note }) => [renter_id, note])) });
});

app.put("/api/admin/renters/:renterId/notes", requireAdmin, async (req, res) => {
  const { note } = req.body || {};
  if (typeof note !== "string" || note.length > 3000) {
    return res.status(400).json({ error: "Renter notes must be text no longer than 3000 characters." });
  }

  const { data: renter, error: renterError } = await adminClient
    .from("renters").select("id").eq("id", req.params.renterId).maybeSingle();
  if (renterError) return res.status(500).json({ error: "Could not look up the renter record." });
  if (!renter) return res.status(404).json({ error: "Renter record not found." });

  const { error: saveError } = await adminClient.from("renter_admin_notes").upsert({
    renter_id: renter.id,
    note,
    updated_at: new Date().toISOString(),
  }, { onConflict: "renter_id" });
  if (saveError) return res.status(500).json({ error: "Could not save administrator renter notes." });
  res.json({ saved: true });
});

app.post("/api/admin/renters/:renterId/account", requireAdmin, async (req, res) => {
  const { password } = req.body || {};
  const emailInput = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (typeof req.body?.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) {
    return res.status(400).json({ error: "Enter a valid email address for the renter login." });
  }
  if (typeof password !== "string" || password.length < 12) {
    return res.status(400).json({ error: "The renter password must be at least 12 characters." });
  }

  const { data: renter, error: renterError } = await adminClient
    .from("renters").select("id, user_id, email, full_name, phone, status").eq("id", req.params.renterId).maybeSingle();
  if (renterError) return res.status(500).json({ error: "Could not look up the renter record." });
  if (!renter) return res.status(404).json({ error: "Renter record not found." });
  if (renter.status === "terminated") return res.status(409).json({ error: "A terminated renter cannot be given a new login." });
  if (renter.user_id) return res.status(409).json({ error: "This renter already has a linked login account." });
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: emailInput,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: renter.full_name,
      phone: renter.phone || "",
    },
  });
  if (createError) {
    const duplicateEmail = /already|registered|exists/i.test(createError.message);
    return res.status(400).json({
      error: duplicateEmail
        ? `The email ${emailInput} already belongs to a Supabase account. Use a unique renter email, or have an administrator check the existing account.`
        : `Supabase could not create the renter login: ${createError.message}`,
    });
  }

  const { data: linkedRenter, error: linkError } = await adminClient.from("renters")
    .update({ user_id: created.user.id, email: emailInput })
    .eq("id", renter.id)
    .is("user_id", null)
    .select("id")
    .maybeSingle();
  if (linkError || !linkedRenter) {
    const { error: rollbackError } = await adminClient.auth.admin.deleteUser(created.user.id);
    if (rollbackError) console.error("Could not remove renter auth user after account linking failed:", rollbackError.message);
    if (linkError) return res.status(400).json({ error: `The login was created but could not be linked to the renter: ${linkError.message}` });
    return res.status(409).json({ error: "This renter was linked to another account while you were creating the login. Refresh the page and try again." });
  }
  res.status(201).json({ linked: true, userId: created.user.id, email: emailInput });
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

app.use((error, req, res, next) => {
  console.error("Unhandled request error:", error);
  if (res.headersSent) return next(error);
  if (req.path.startsWith("/api/")) {
    return res.status(500).json({ error: "The server could not complete the request. Check the Render service logs for details." });
  }
  next(error);
});

app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => console.log(`Nanay Inday's Rentals listening on ${port}`));

if (adminClient) {
  if (!createMailTransport()) console.info("Rent reminder emails are disabled until all SMTP environment variables are configured.");
  setTimeout(sendUpcomingRentReminders, 10000);
  setInterval(sendUpcomingRentReminders, 15 * 60 * 1000);
}
