import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const app = document.querySelector("#app");
const config = await fetch("/api/config").then((response) => response.json());
const supabase = config.cloudReady
  ? createClient(config.supabaseUrl, config.supabaseAnonKey)
  : null;
let passwordSetupRequired = /type=invite/i.test(`${window.location.hash}${window.location.search}`);

let state = {
  role: null,
  user: null,
  passwordSetupRequired: false,
  loginMessage: "",
  tab: "overview",
  renters: [],
  payments: [],
  utility_bills: [],
  settings: {
    water_rate: 45,
    electricity_rate: 0,
    electricity_total_bill: 0,
    electricity_total_usage: 0,
    late_fee_per_day: 50,
    grace_period_days: 3,
  },
};

async function fetchCloudData() {
  const [renters, payments, utilities, settings, profile] = await Promise.all([
    supabase.from("renters").select("*").order("created_at", { ascending: false }),
    supabase.from("payments").select("*").order("due_date", { ascending: false }),
    supabase.from("utility_bills").select("*").order("created_at", { ascending: false }),
    supabase.from("settings").select("*"),
    supabase.from("profiles").select("role, full_name").eq("id", state.user.id).single(),
  ]);
  for (const result of [renters, payments, utilities, settings, profile]) {
    if (result.error) throw result.error;
  }
  if (!["admin", "renter"].includes(profile.data.role)) {
    throw new Error("Your account does not have an assigned app role. Ask an administrator to set it up.");
  }
  state.role = profile.data.role;
  state.user.name = profile.data.full_name || state.user.email;
  state.renters = renters.data;
  state.payments = payments.data;
  state.utility_bills = utilities.data;
  state.settings = {
    ...state.settings,
    ...Object.fromEntries(settings.data.map((row) => [row.key, Number(row.value)])),
  };
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function money(value) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}
function electricityRate(settings = state.settings) {
  const bill = Number(settings.electricity_total_bill);
  const usage = Number(settings.electricity_total_usage);
  return bill > 0 && usage > 0
    ? bill / usage
    : Number(settings.electricity_rate) || 0;
}
function initials(name = "") {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}
function renterById(id) {
  return state.renters.find((renter) => renter.id === id) || {};
}
function lateFee(payment) {
  if (payment.status === "paid") return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDate = new Date(`${payment.due_date}T00:00:00`);
  const overdueDays = Math.floor((today - dueDate) / 86400000) - Number(state.settings.grace_period_days || 0);
  return Math.max(0, overdueDays) * Number(state.settings.late_fee_per_day || 0);
}
function paymentStatus(payment) {
  if (payment.status === "paid") return "paid";
  if (lateFee(payment) > 0) return "overdue";
  return payment.status === "review" ? "review" : "due";
}
function statusBadge(status) {
  const label = { paid: "Paid", due: "Due", overdue: "Overdue", review: "For review", active: "Active", expiring: "Expiring soon" }[status] || status;
  return `<span class="badge ${escapeHtml(status)}">${label}</span>`;
}
function isExpiring(renter) {
  const remaining = (new Date(`${renter.contract_end}T23:59:59`) - Date.now()) / 86400000;
  return remaining >= 0 && remaining <= 30;
}
function contractStatus(renter) {
  return new Date(`${renter.contract_end}T23:59:59`).getTime() < Date.now()
    ? "expired"
    : isExpiring(renter) ? "expiring" : "active";
}
function toast(message, error = false) {
  document.querySelector(".toast")?.remove();
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.textContent = message;
  document.body.append(element);
  setTimeout(() => element.remove(), 3500);
}
function pageTitle() {
  return ({ overview: "Overview", renters: "Renters & leases", payments: "Payments", utilities: "Utility billing" })[state.tab] || "Overview";
}
function navButton(tab, icon, label) {
  return `<button data-tab="${tab}" class="${state.tab === tab ? "active" : ""}"><span class="icon">${icon}</span>${label}</button>`;
}
function appShell(content) {
  const renterMode = state.role === "renter";
  return `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">⌂</div><div><strong>Nanay Inday's</strong><small>HOME & ROOM RENTALS</small></div></div>
      <div class="nav-label">${renterMode ? "MY RENTAL" : "MANAGEMENT"}</div>
      <nav class="nav">
        ${renterMode
          ? navButton("overview", "⌂", "My rental")
          : `${navButton("overview", "⌂", "Overview")}${navButton("renters", "♙", "Renters & leases")}${navButton("payments", "₱", "Payments")}${navButton("utilities", "ϟ", "Utility billing")}`}
      </nav>
      <div class="sidebar-foot"><div class="profile-mini"><div class="avatar">${initials(state.user?.name)}</div><div><strong>${escapeHtml(state.user?.name || "User")}</strong><small>${renterMode ? "Renter account" : "Administrator"}</small></div></div>
        <button class="logout" data-action="logout">↪ &nbsp; Sign out</button></div>
    </aside>
    <main class="main">
      <header class="topbar"><div><div class="eyebrow">Nanay Inday's Rentals &nbsp; / &nbsp; ${pageTitle()}</div><h1>${pageTitle()}</h1></div>
        <div class="top-actions"><span class="mode-pill live">● Cloud connected</span>
          ${!renterMode && state.tab === "renters" ? `<button class="button primary" data-action="add-renter">＋ Add renter</button>` : ""}
          ${!renterMode && state.tab === "payments" ? `<button class="button primary" data-action="add-payment">＋ Create charge</button>` : ""}
          ${!renterMode && state.tab === "utilities" ? `<button class="button primary" data-action="add-utility">＋ Calculate bill</button>` : ""}
        </div>
      </header>${content}
    </main>
  </div>`;
}
function overviewPage() {
  if (state.role === "renter") return renterPage();
  const pendingPayments = state.payments.filter((payment) => payment.status !== "paid");
  const overdueTotal = pendingPayments.reduce((total, payment) => total + Number(payment.amount) + lateFee(payment), 0);
  const expiringRenters = state.renters.filter(isExpiring);
  const recentPayments = [...state.payments].sort((a, b) => new Date(b.paid_at || b.due_date) - new Date(a.paid_at || a.due_date)).slice(0, 4);
  return `<section class="welcome"><div><h2>Welcome back, ${escapeHtml(state.user.name.split(" ")[0])} 👋</h2><p>Here is your property summary for today.</p></div>
      <button class="button" data-action="add-renter">＋ Add new renter</button></section>
    <section class="stats">
      <div class="stat"><div class="stat-head"><span>Active renters</span><span class="stat-icon">♙</span></div><strong>${state.renters.filter((renter) => contractStatus(renter) !== "expired").length}</strong><small>Across your rental property</small></div>
      <div class="stat"><div class="stat-head"><span>Payments received</span><span class="stat-icon">₱</span></div><strong>${money(state.payments.filter((p) => p.status === "paid").reduce((total, p) => total + Number(p.amount), 0))}</strong><small>${state.payments.filter((p) => p.status === "paid").length} payments recorded</small></div>
      <div class="stat"><div class="stat-head"><span>Outstanding balance</span><span class="stat-icon">◷</span></div><strong>${money(overdueTotal)}</strong><small>Includes calculated late fees</small></div>
      <div class="stat"><div class="stat-head"><span>Contracts expiring</span><span class="stat-icon">▣</span></div><strong>${expiringRenters.length}</strong><small>Within the next 30 days</small></div>
    </section>
    <section class="grid-two">
      <div class="card"><div class="card-head"><h3>Recent renters</h3><button class="text-button" data-tab="renters">View all →</button></div>${renderRenterTable(state.renters.slice(0, 5))}</div>
      <div class="card"><div class="card-head"><h3>Contracts to watch</h3><span class="status-pill">Next 30 days</span></div>
        ${expiringRenters.length ? `<div class="activity">${expiringRenters.map((renter) => `<div class="activity-item"><div class="activity-icon">▣</div><div><strong>${escapeHtml(renter.full_name)}</strong><p>${escapeHtml(renter.unit_name)} · ends ${formatDate(renter.contract_end)}</p><time>${daysLeft(renter.contract_end)} days remaining</time></div></div>`).join("")}</div>` : `<div class="empty"><span>✓</span>No contracts expiring soon</div>`}
      </div>
    </section>
    <section class="card" style="margin-top:17px"><div class="card-head"><h3>Recent payment activity</h3><button class="text-button" data-tab="payments">View payments →</button></div>
      ${recentPayments.length ? `<div class="activity">${recentPayments.map((payment) => `<div class="activity-item"><div class="activity-icon">${payment.status === "paid" ? "✓" : "₱"}</div><div style="flex:1"><strong>${escapeHtml(renterById(payment.renter_id).full_name || "Renter")} · ${money(payment.amount)}</strong><p>${escapeHtml(payment.period)} · ${payment.status === "paid" ? `Paid ${formatDate(payment.paid_at)}` : `Due ${formatDate(payment.due_date)}`}</p></div>${statusBadge(paymentStatus(payment))}</div>`).join("")}</div>` : `<div class="empty">No payments recorded yet.</div>`}
    </section>`;
}
function daysLeft(date) {
  return Math.max(0, Math.ceil((new Date(`${date}T23:59:59`) - Date.now()) / 86400000));
}
function formatDate(date) {
  if (!date) return "—";
  return new Date(`${String(date).slice(0, 10)}T00:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
}
function renderRenterTable(renters) {
  if (!renters.length) return `<div class="empty"><span>♙</span>No renters yet. Add your first renter to get started.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>RENTER</th><th>UNIT</th><th>RENT / MONTH</th><th>CONTRACT ENDS</th><th>STATUS</th></tr></thead><tbody>
    ${renters.map((renter) => `<tr><td><div class="person-cell"><div class="avatar">${initials(renter.full_name)}</div><div><strong>${escapeHtml(renter.full_name)}</strong><small>${escapeHtml(renter.email)}</small></div></div></td><td>${escapeHtml(renter.unit_name)}<small style="display:block;color:#89958d;margin-top:3px">${escapeHtml(renter.rental_type)}</small></td><td>${money(renter.rent_amount)}</td><td>${formatDate(renter.contract_end)}</td><td>${statusBadge(contractStatus(renter))}</td></tr>`).join("")}
    </tbody></table></div>`;
}
function rentersPage() {
  return `<div class="section-title"><div><p>Manage renter accounts, rental types, and contract dates.</p></div></div>
    <div class="toolbar"><input class="search" id="renter-search" placeholder="⌕  Search renters or units..." /><select class="filter" id="renter-filter"><option value="all">All rental types</option><option>Room</option><option>House</option><option>Apartment</option></select></div>
    <div class="card" id="renter-table">${renderRenterTable(state.renters)}</div>`;
}
function paymentsPage() {
  const payments = [...state.payments].sort((a, b) => new Date(b.due_date) - new Date(a.due_date));
  return `<div class="section-title"><div><p>Review receipts, track rent, and follow up on unpaid balances.</p></div></div>
    <div class="stats">
      <div class="stat"><div class="stat-head"><span>Collected</span><span class="stat-icon">✓</span></div><strong>${money(payments.filter((p) => p.status === "paid").reduce((t, p) => t + Number(p.amount), 0))}</strong><small>Payments marked paid</small></div>
      <div class="stat"><div class="stat-head"><span>Awaiting payment</span><span class="stat-icon">◷</span></div><strong>${payments.filter((p) => p.status !== "paid").length}</strong><small>Unpaid rental charges</small></div>
      <div class="stat"><div class="stat-head"><span>Late fees accrued</span><span class="stat-icon">₱</span></div><strong>${money(payments.reduce((t, p) => t + lateFee(p), 0))}</strong><small>After ${Number(state.settings.grace_period_days)} grace days</small></div>
      <div class="stat"><div class="stat-head"><span>Receipt reviews</span><span class="stat-icon">▧</span></div><strong>${payments.filter((p) => p.status === "review").length}</strong><small>Awaiting admin approval</small></div>
    </div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>RENTER</th><th>PERIOD</th><th>BASE RENT</th><th>UTILITIES</th><th>LATE FEE</th><th>TOTAL DUE</th><th>STATUS / RECEIPT</th><th>ACTION</th></tr></thead><tbody>
    ${payments.length ? payments.map((payment) => `<tr><td>${escapeHtml(renterById(payment.renter_id).full_name || "Renter")}</td><td>${escapeHtml(payment.period)}</td><td>${money(payment.base_amount)}</td><td>${money(payment.utility_amount)}</td><td>${money(lateFee(payment))}</td><td><strong>${money(Number(payment.amount) + lateFee(payment))}</strong></td><td>${statusBadge(paymentStatus(payment))}${payment.receipt_path ? `<div style="margin-top:5px"><button class="text-button" data-action="receipt" data-id="${payment.id}">View receipt</button></div>` : ""}</td><td>${payment.status !== "paid" ? `<button class="text-button" data-action="mark-paid" data-id="${payment.id}">${payment.status === "review" ? "Approve & mark paid" : "Mark paid"}</button>${renterById(payment.renter_id).phone ? `<button class="text-button" data-action="sms" data-id="${payment.id}">Send SMS</button>` : ""}` : "—"}</td></tr>`).join("") : `<tr><td colspan="8"><div class="empty">No charges yet. Create a charge to track a payment.</div></td></tr>`}
    </tbody></table></div></div>`;
}
function utilitiesPage() {
  const bills = state.utility_bills;
  const totalBill = Number(state.settings.electricity_total_bill);
  const totalUsage = Number(state.settings.electricity_total_usage);
  const rateText = totalBill > 0 && totalUsage > 0
    ? `₱${(totalBill / totalUsage).toFixed(4)} per kWh (${totalBill.toFixed(2)} ÷ ${totalUsage.toFixed(2)})`
    : "Enter the total bill and kWh to calculate the per-kWh rate.";
  return `<div class="section-title"><div><p>Set your local utility rates. Only administrators can calculate and record meter readings.</p></div></div>
    <div class="utility-grid">
      ${rateCard("water_rate", "Water", "PHP per cubic meter", "m³")}
      <div class="utility-card"><h3>Electricity rate</h3><p>Calculate the price per kWh from your provider bill.</p><div class="form-grid">
        <div class="field"><label>Total electricity bill (PHP)</label><input type="number" min="0" step="0.01" data-setting="electricity_total_bill" value="${Number(state.settings.electricity_total_bill)}" /></div>
        <div class="field"><label>Total kWh used on bill</label><input type="number" min="0" step="0.01" data-setting="electricity_total_usage" value="${Number(state.settings.electricity_total_usage)}" /></div>
      </div><div class="utility-summary" id="electricity-rate-preview">Calculated rate: ${rateText}</div></div>
      <div class="utility-card"><h3>Late payment policy</h3><p>Applied automatically to unpaid charges.</p><div class="form-grid">
        <div class="field"><label>Fee per late day (PHP)</label><input type="number" min="0" step="1" data-setting="late_fee_per_day" value="${Number(state.settings.late_fee_per_day)}" /></div>
        <div class="field"><label>Grace period (days)</label><input type="number" min="0" step="1" data-setting="grace_period_days" value="${Number(state.settings.grace_period_days)}" /></div>
      </div><button class="button secondary" style="margin-top:12px" data-action="save-rates">Save policy</button></div>
    </div>
    <div class="card" style="margin-top:17px"><div class="card-head"><h3>Recent meter calculations</h3><button class="button primary" data-action="add-utility">＋ Calculate bill</button></div>
      ${bills.length ? `<div class="table-wrap"><table><thead><tr><th>RENTER / UNIT</th><th>PERIOD</th><th>WATER USAGE</th><th>ELECTRICITY USAGE</th><th>UTILITY CHARGE</th></tr></thead><tbody>${bills.map((bill) => `<tr><td>${escapeHtml(renterById(bill.renter_id).full_name || "Renter")}<small style="display:block;color:#89958d;margin-top:3px">${escapeHtml(renterById(bill.renter_id).unit_name || "")}</small></td><td>${escapeHtml(bill.period)}</td><td>${Number(bill.water_usage)} m³</td><td>${Number(bill.electricity_usage)} kWh</td><td><strong>${money(bill.amount)}</strong></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><span>ϟ</span>No utility bills yet. Enter meter readings to calculate the first bill.</div>`}
    </div>`;
}
function rateCard(key, name, unit, suffix) {
  return `<div class="utility-card"><h3>${name} rate</h3><p>${unit}</p><div class="utility-rate"><div class="field"><label>Rate</label><input type="number" min="0" step="0.01" data-setting="${key}" value="${Number(state.settings[key])}" /></div><span style="font-size:11px;color:#718078">${suffix}</span></div><div class="utility-summary">Meter usage × rate = renter charge</div></div>`;
}
function renterPage() {
  const renter = state.renters.find((row) => row.user_id === state.user.id);
  if (!renter) return `<div class="card"><div class="empty"><span>⌂</span>Your rental details will appear here once the administrator links your renter account.</div></div>`;
  const payments = state.payments.filter((payment) => payment.renter_id === renter.id);
  const outstanding = payments.filter((p) => p.status !== "paid").reduce((t, p) => t + Number(p.amount) + lateFee(p), 0);
  return `<section class="welcome renter-hero"><div><h2>Welcome, ${escapeHtml(renter.full_name.split(" ")[0])} 👋</h2><p>Your home at ${escapeHtml(renter.unit_name)} · ${escapeHtml(renter.rental_type)}</p></div><span class="status-pill">Contract ends ${formatDate(renter.contract_end)}</span></section>
    <section class="renter-bill">
      <div class="bill-line"><span>Monthly rent</span><strong>${money(renter.rent_amount)}</strong></div>
      <div class="bill-line"><span>Outstanding balance</span><strong>${money(outstanding)}</strong></div>
      <div class="bill-line"><span>Contract term</span><strong>${renter.contract_months} months</strong></div>
    </section>
    <div class="card"><div class="card-head"><h3>My payment history</h3><span class="status-pill">Receipts are reviewed by the administrator</span></div>
      ${payments.length ? `<div class="table-wrap"><table><thead><tr><th>PERIOD</th><th>DUE DATE</th><th>RENT + UTILITIES</th><th>LATE FEE</th><th>STATUS</th><th>RECEIPT</th></tr></thead><tbody>${payments.map((p) => `<tr><td>${escapeHtml(p.period)}</td><td>${formatDate(p.due_date)}</td><td>${money(p.amount)}</td><td>${money(lateFee(p))}</td><td>${statusBadge(paymentStatus(p))}</td><td>${p.status === "paid" ? "✓" : p.receipt_path ? "Uploaded" : `<button class="text-button" data-action="upload-receipt" data-id="${p.id}">Upload receipt</button>`}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">No rental charges have been added yet.</div>`}
    </div>`;
}

function render() {
  if (state.passwordSetupRequired) {
    app.innerHTML = `<div class="login-page"><section class="login-brand"><div class="brand"><div class="brand-mark" style="background:#fff;color:#286b50">⌂</div><div><strong>Nanay Inday's</strong><small style="color:#dbe9df">HOME & ROOM RENTALS</small></div></div><div><h1>Set up your renter account.</h1><p>Create a password to securely access your rental details, payment history, and receipt uploads.</p></div><small style="color:#dbe9df;z-index:1">A welcoming home starts with thoughtful management.</small></section>
      <section class="login-box"><h2>Create your password</h2><p>Choose a password with at least 8 characters.</p><form id="password-form"><div class="field"><label>New password</label><input name="password" type="password" autocomplete="new-password" minlength="8" required /></div><div class="field"><label>Confirm password</label><input name="confirm_password" type="password" autocomplete="new-password" minlength="8" required /></div><div id="password-error"></div><button class="button primary" type="submit">Save password</button></form></section></div>`;
    return;
  }
  if (!state.user) {
    app.innerHTML = `<div class="login-page"><section class="login-brand"><div class="brand"><div class="brand-mark" style="background:#fff;color:#286b50">⌂</div><div><strong>Nanay Inday's</strong><small style="color:#dbe9df">HOME & ROOM RENTALS</small></div></div><div><h1>A little more peace of mind, right at home.</h1><p>Manage your renters, monthly payments, and home utilities in one simple place.</p></div><small style="color:#dbe9df;z-index:1">A welcoming home starts with thoughtful management.</small></section>
      <section class="login-box"><h2>Welcome home</h2><p>Sign in to your rental account.</p><form id="login-form"><div class="field"><label>Email address</label><input name="email" type="email" autocomplete="username" placeholder="you@example.com" required /></div><div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required /></div><button class="button primary" type="submit" ${supabase ? "" : "disabled"}>Sign in</button><div id="login-error" class="${state.loginMessage || !supabase ? "notice" : ""}">${escapeHtml(state.loginMessage || (!supabase ? "Cloud sign-in is not configured. Check the Render Supabase environment variables." : ""))}</div><button class="text-button" style="margin-top:13px" type="button" data-action="reset-password">Forgot your password?</button></form>
      <p style="margin-top:20px;font-size:12px;line-height:1.6">Sign in with an account provided by your property administrator.</p></section></div>`;
    return;
  }
  const content = state.tab === "overview" ? overviewPage()
    : state.tab === "renters" ? rentersPage()
      : state.tab === "payments" ? paymentsPage() : utilitiesPage();
  app.innerHTML = appShell(content);
}

function modal(title, body, actions) {
  document.querySelector(".modal-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<section class="modal"><div class="modal-top"><h2>${title}</h2><button class="close" data-action="close-modal" aria-label="Close">×</button></div>${body}<div class="modal-actions">${actions}</div></section>`;
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}
function addRenterModal() {
  const start = new Date().toISOString().slice(0, 10);
  modal("Add a new renter", `<form id="renter-form"><div class="form-grid">
    <div class="field"><label>Full name</label><input name="full_name" required /></div><div class="field"><label>Email for renter login</label><input name="email" type="email" required /></div>
    <div class="field"><label>Phone number</label><input name="phone" type="tel" placeholder="+63..." /></div><div class="field"><label>Unit name / number</label><input name="unit_name" placeholder="Room 01" required /></div>
    <div class="field"><label>Rental type</label><select name="rental_type"><option>Room</option><option>House</option><option>Apartment</option></select></div>
    <div class="field"><label>Contract term</label><select name="contract_months"><option value="6">6 months</option><option value="12">1 year (12 months)</option></select></div>
    <div class="field"><label>Contract start</label><input name="contract_start" type="date" value="${start}" required /></div>
    <div class="field"><label>Monthly rent (PHP)</label><input name="rent_amount" type="number" min="0" step="0.01" required /></div>
    <div class="field full notice">An invitation email will be sent so the renter can set a password and access their personal renter view.</div></div></form>`,
  `<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-renter">Add renter</button>`);
}
function addPaymentModal() {
  const today = new Date();
  const defaultDue = new Date(today.getFullYear(), today.getMonth(), 5).toISOString().slice(0, 10);
  modal("Create a rental charge", `<form id="payment-form"><div class="form-grid">
    <div class="field full"><label>Renter</label><select name="renter_id" required>${state.renters.map((r) => `<option value="${r.id}">${escapeHtml(r.full_name)} · ${escapeHtml(r.unit_name)}</option>`).join("")}</select></div>
    <div class="field"><label>Charge period</label><input name="period" value="${today.toLocaleDateString("en-PH", { month: "long", year: "numeric" })}" required /></div>
    <div class="field"><label>Due date</label><input name="due_date" type="date" value="${defaultDue}" required /></div>
    <div class="field"><label>Base rent (PHP)</label><input name="base_amount" type="number" min="0" step=".01" required /></div>
    <div class="field"><label>Utilities (PHP)</label><input name="utility_amount" type="number" min="0" step=".01" value="0" required /></div>
    </div></form>`, `<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-payment">Create charge</button>`);
  const form = document.querySelector("#payment-form");
  form.elements.renter_id.addEventListener("change", () => { form.elements.base_amount.value = renterById(form.elements.renter_id.value).rent_amount || 0; });
  form.elements.base_amount.value = renterById(form.elements.renter_id.value).rent_amount || 0;
}
function addUtilityModal() {
  if (!state.renters.length) return toast("Add a renter before calculating a utility bill.", true);
  if (!(Number(state.settings.electricity_total_bill) > 0) || !(Number(state.settings.electricity_total_usage) > 0)) {
    return toast("Enter the total electricity bill and total kWh in Utility billing first.", true);
  }
  const month = new Date().toLocaleDateString("en-PH", { month: "long", year: "numeric" });
  modal("Calculate a utility bill", `<form id="utility-form"><div class="form-grid">
    <div class="field full"><label>Renter / unit</label><select name="renter_id">${state.renters.map((r) => `<option value="${r.id}">${escapeHtml(r.full_name)} · ${escapeHtml(r.unit_name)}</option>`).join("")}</select></div>
    <div class="field full"><label>Billing period</label><input name="period" value="${month}" required /></div>
    <div class="field"><label>Previous water meter (m³)</label><input name="water_previous" type="number" min="0" step=".01" value="0" required /></div>
    <div class="field"><label>Current water meter (m³)</label><input name="water_current" type="number" min="0" step=".01" value="0" required /></div>
    <div class="field"><label>Previous electricity meter (kWh)</label><input name="electricity_previous" type="number" min="0" step=".01" value="0" required /></div>
    <div class="field"><label>Current electricity meter (kWh)</label><input name="electricity_current" type="number" min="0" step=".01" value="0" required /></div>
    <div class="field full notice" id="utility-preview">Enter meter readings to see the calculation using the current rates.</div></div></form>`,
  `<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-utility">Save utility charge</button>`);
  document.querySelector("#utility-form").addEventListener("input", updateUtilityPreview);
  updateUtilityPreview();
}
function updateUtilityPreview() {
  const form = document.querySelector("#utility-form");
  if (!form) return;
  const values = Object.fromEntries(new FormData(form));
  const water = Number(values.water_current) - Number(values.water_previous);
  const power = Number(values.electricity_current) - Number(values.electricity_previous);
  const unitRate = electricityRate();
  const waterCharge = water * Number(state.settings.water_rate);
  const electricityCharge = power * unitRate;
  const total = Math.round((waterCharge + electricityCharge) * 100) / 100;
  const preview = document.querySelector("#utility-preview");
  preview.textContent = water < 0 || power < 0
    ? "Current readings must be greater than or equal to previous readings."
    : `Water: ${water.toFixed(2)} m³ × ${money(state.settings.water_rate)}. Electricity: (${Number(state.settings.electricity_total_bill).toFixed(2)} ÷ ${Number(state.settings.electricity_total_usage).toFixed(2)} kWh) = ₱${unitRate.toFixed(4)}/kWh; (${Number(values.electricity_current).toFixed(2)} − ${Number(values.electricity_previous).toFixed(2)}) × ₱${unitRate.toFixed(4)} = ${money(electricityCharge)}. Total utility charge: ${money(total)}.`;
}

async function saveRenter() {
  const form = document.querySelector("#renter-form");
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const [startYear, startMonth, startDay] = data.contract_start.split("-").map(Number);
  const targetMonth = startMonth - 1 + Number(data.contract_months);
  const lastDay = new Date(Date.UTC(startYear, targetMonth + 1, 0)).getUTCDate();
  const endDate = new Date(Date.UTC(startYear, targetMonth, Math.min(startDay, lastDay)));
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  const renter = {
    full_name: data.full_name.trim(), email: data.email.trim(), phone: data.phone.trim(),
    unit_name: data.unit_name.trim(), rental_type: data.rental_type, contract_months: Number(data.contract_months),
    contract_start: data.contract_start, contract_end: endDate.toISOString().slice(0, 10), rent_amount: Number(data.rent_amount),
  };
  try {
    {
      const { data: invited, error: inviteError } = await fetch("/api/admin/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${(await supabase.auth.getSession()).data.session.access_token}` },
        body: JSON.stringify({ email: renter.email, name: renter.full_name, phone: renter.phone }),
      }).then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || "Could not invite renter.");
        return { data: json, error: null };
      });
      if (inviteError) throw inviteError;
      renter.user_id = invited.userId;
      const { data: inserted, error } = await supabase.from("renters").insert(renter).select().single();
      if (error) throw error;
      state.renters.unshift(inserted);
    }
    document.querySelector(".modal-backdrop")?.remove();
    render();
    toast("Renter added. They can sign in after accepting their email invitation.");
  } catch (error) {
    toast(error.message || "Could not add renter.", true);
  }
}
async function savePayment() {
  const form = document.querySelector("#payment-form");
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const payment = {
    renter_id: data.renter_id, period: data.period.trim(), due_date: data.due_date,
    base_amount: Number(data.base_amount), utility_amount: Number(data.utility_amount),
    amount: Number(data.base_amount) + Number(data.utility_amount), status: "pending",
  };
  try {
    {
      const { data: inserted, error } = await supabase.from("payments").insert(payment).select().single();
      if (error) throw error;
      state.payments.unshift(inserted);
    }
    document.querySelector(".modal-backdrop")?.remove();
    render();
    toast("Rental charge created.");
  } catch (error) { toast(error.message || "Could not create charge.", true); }
}
async function saveUtility() {
  const form = document.querySelector("#utility-form");
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const waterUsage = Number(data.water_current) - Number(data.water_previous);
  const electricityUsage = Number(data.electricity_current) - Number(data.electricity_previous);
  if (waterUsage < 0 || electricityUsage < 0) return toast("Current readings cannot be lower than previous readings.", true);
  if (!(Number(state.settings.electricity_total_bill) > 0) || !(Number(state.settings.electricity_total_usage) > 0)) {
    return toast("Enter the total electricity bill and total kWh in Utility billing first.", true);
  }
  const electricityUnitRate = electricityRate();
  const waterCharge = waterUsage * Number(state.settings.water_rate);
  const electricityCharge = electricityUsage * electricityUnitRate;
  const amount = Math.round((waterCharge + electricityCharge) * 100) / 100;
  const bill = {
    renter_id: data.renter_id, period: data.period.trim(), water_previous: Number(data.water_previous),
    water_current: Number(data.water_current), water_usage: waterUsage,
    electricity_previous: Number(data.electricity_previous), electricity_current: Number(data.electricity_current),
    electricity_usage: electricityUsage, water_rate: Number(state.settings.water_rate),
    electricity_total_bill: Number(state.settings.electricity_total_bill),
    electricity_total_usage: Number(state.settings.electricity_total_usage),
    electricity_rate: electricityUnitRate, electricity_charge: Math.round(electricityCharge * 100) / 100,
    water_charge: Math.round(waterCharge * 100) / 100, amount,
  };
  try {
    {
      const { data: payment, error: paymentError } = await supabase.from("payments").insert({
        renter_id: bill.renter_id, period: `${bill.period} · Utilities`, due_date: new Date().toISOString().slice(0, 10),
        base_amount: 0, utility_amount: amount, amount, status: "pending",
      }).select().single();
      if (paymentError) throw paymentError;
      bill.payment_id = payment.id;
      const { data: inserted, error } = await supabase.from("utility_bills").insert(bill).select().single();
      if (error) throw error;
      state.utility_bills.unshift(inserted);
      state.payments.unshift(payment);
    }
    document.querySelector(".modal-backdrop")?.remove();
    render();
    toast(`Utility bill calculated: ${money(amount)}.`);
  } catch (error) { toast(error.message || "Could not save utility bill.", true); }
}
async function saveRates() {
  const inputs = [...document.querySelectorAll("[data-setting]")];
  const values = Object.fromEntries(inputs.map((input) => [input.dataset.setting, Number(input.value)]));
  if (inputs.some((input) => !Number.isFinite(Number(input.value)) || Number(input.value) < 0)) return toast("Rates and fees must be zero or greater.", true);
  if (!(values.electricity_total_bill > 0) || !(values.electricity_total_usage > 0)) {
    return toast("Enter a total electricity bill and total kWh greater than zero.", true);
  }
  values.electricity_rate = values.electricity_total_bill / values.electricity_total_usage;
  try {
    const { error } = await supabase.from("settings").upsert(Object.entries(values).map(([key, value]) => ({ key, value })), { onConflict: "key" });
    if (error) throw error;
    state.settings = { ...state.settings, ...values };
    render();
    toast("Utility rates and late fee policy saved.");
  } catch (error) { toast(error.message || "Could not save settings.", true); }
}
async function markPaid(id) {
  try {
    const { error } = await supabase.from("payments").update({ status: "paid", paid_at: new Date().toISOString().slice(0, 10) }).eq("id", id);
    if (error) throw error;
    const payment = state.payments.find((item) => item.id === id);
    payment.status = "paid";
    payment.paid_at = new Date().toISOString().slice(0, 10);
    render();
    toast("Payment marked as paid.");
  } catch (error) { toast(error.message || "Could not update payment.", true); }
}
async function uploadReceipt(id, file) {
  if (!file) return;
  try {
    const payment = state.payments.find((item) => item.id === id);
    const path = `${state.user.id}/${id}/${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
    const { error: uploadError } = await supabase.storage.from("receipts").upload(path, file, { upsert: false, contentType: file.type });
    if (uploadError) throw uploadError;
    const { error } = await supabase.from("payments").update({ receipt_path: path, status: "review" }).eq("id", id);
    if (error) throw error;
    payment.receipt_path = path;
    payment.status = "review";
    render();
    toast("Receipt uploaded and sent for review.");
  } catch (error) { toast(error.message || "Could not upload receipt.", true); }
}
async function showReceipt(id) {
  const payment = state.payments.find((item) => item.id === id);
  const { data, error } = await supabase.storage.from("receipts").createSignedUrl(payment.receipt_path, 60);
  if (error) return toast(error.message, true);
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}
async function sendSms(id) {
  const payment = state.payments.find((item) => item.id === id);
  const renter = renterById(payment.renter_id);
  try {
    const response = await fetch("/api/sms/payment-reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${(await supabase.auth.getSession()).data.session.access_token}` },
      body: JSON.stringify({ phone: renter.phone, renterName: renter.full_name, amount: Number(payment.amount) + lateFee(payment), dueDate: payment.due_date }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "SMS could not be sent.");
    toast("SMS payment reminder sent.");
  } catch (error) { toast(error.message || "Could not send SMS.", true); }
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action], [data-tab]");
  if (!target) return;
  if (target.dataset.tab) {
    state.tab = target.dataset.tab;
    render();
    return;
  }
  const { action, id } = target.dataset;
  if (action === "logout") {
    if (supabase) {
      const { error } = await supabase.auth.signOut();
      if (error) return toast(error.message, true);
    }
    state.user = null;
    state.role = null;
    state.loginMessage = "";
    render();
    return;
  }
  if (action === "reset-password") {
    const email = document.querySelector("#login-form input[name=email]")?.value.trim();
    if (!email) return toast("Enter your email address first.", true);
    if (!supabase) return toast("Password reset needs the cloud authentication setup.", true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    if (error) return toast(error.message, true);
    return toast("If an account exists for that address, password reset instructions have been sent.");
  }
  if (action === "add-renter") return addRenterModal();
  if (action === "add-payment") return state.renters.length ? addPaymentModal() : toast("Add a renter before creating a charge.", true);
  if (action === "add-utility") return addUtilityModal();
  if (action === "close-modal") return document.querySelector(".modal-backdrop")?.remove();
  if (action === "save-renter") return saveRenter();
  if (action === "save-payment") return savePayment();
  if (action === "save-utility") return saveUtility();
  if (action === "save-rates") return saveRates();
  if (action === "mark-paid") return markPaid(id);
  if (action === "receipt") return showReceipt(id);
  if (action === "sms") return sendSms(id);
  if (action === "upload-receipt") {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*,.pdf";
    input.onchange = () => uploadReceipt(id, input.files?.[0]);
    input.click();
  }
});
document.addEventListener("submit", async (event) => {
  if (event.target.id === "password-form") {
    event.preventDefault();
    const formData = new FormData(event.target);
    const password = formData.get("password");
    const confirmPassword = formData.get("confirm_password");
    const errorBox = document.querySelector("#password-error");
    if (password.length < 8 || password !== confirmPassword) {
      errorBox.className = "notice";
      errorBox.textContent = password.length < 8 ? "Use at least 8 characters." : "The passwords do not match.";
      return;
    }
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      state.passwordSetupRequired = false;
      window.history.replaceState(null, "", window.location.pathname);
      await fetchCloudData();
      render();
      toast("Password saved. Welcome to your renter account.");
    } catch (error) {
      errorBox.className = "notice";
      errorBox.textContent = error.message || "Could not save your password.";
    }
    return;
  }
  if (event.target.id !== "login-form") return;
  event.preventDefault();
  const formData = new FormData(event.target);
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true; button.textContent = "Signing in...";
  try {
    if (!supabase) throw new Error("Cloud sign-in is not configured. Check the Render Supabase environment variables.");
    const { data, error } = await supabase.auth.signInWithPassword({ email: formData.get("email"), password: formData.get("password") });
    if (error) throw error;
    state.user = data.user;
    await fetchCloudData();
    state.tab = "overview";
    state.loginMessage = "";
    render();
  } catch (error) {
    if (supabase) await supabase.auth.signOut();
    state.user = null;
    state.role = null;
    state.loginMessage = error.message || "Could not sign in.";
    const target = document.querySelector("#login-error");
    target.className = "notice";
    target.textContent = state.loginMessage;
  } finally {
    if (button.isConnected) { button.disabled = false; button.textContent = "Sign in"; }
  }
});
document.addEventListener("input", (event) => {
  if (event.target.matches("[data-setting='electricity_total_bill'], [data-setting='electricity_total_usage']")) {
    const bill = Number(document.querySelector("[data-setting='electricity_total_bill']")?.value);
    const usage = Number(document.querySelector("[data-setting='electricity_total_usage']")?.value);
    const preview = document.querySelector("#electricity-rate-preview");
    if (preview) {
      preview.textContent = bill > 0 && usage > 0
        ? `Calculated rate: ₱${(bill / usage).toFixed(4)} per kWh (${bill.toFixed(2)} ÷ ${usage.toFixed(2)})`
        : "Enter a total bill and kWh greater than zero to calculate the rate.";
    }
  }
  if (!event.target.matches("#renter-search, #renter-filter")) return;
  const query = document.querySelector("#renter-search")?.value.toLowerCase() || "";
  const type = document.querySelector("#renter-filter")?.value || "all";
  const matches = state.renters.filter((renter) =>
    (type === "all" || renter.rental_type === type) &&
    `${renter.full_name} ${renter.email} ${renter.unit_name}`.toLowerCase().includes(query));
  const table = document.querySelector("#renter-table");
  if (table) table.innerHTML = renderRenterTable(matches);
});
window.addEventListener("error", (event) => console.error("Application error:", event.error || event.message));

if (supabase) {
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY" && session) {
      state.user = session.user;
      state.passwordSetupRequired = true;
      render();
    }
  });
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) state.loginMessage = `Could not check your sign-in session: ${error.message}`;
  if (session) {
    state.user = session.user;
    state.passwordSetupRequired = passwordSetupRequired;
    try { if (!state.passwordSetupRequired) await fetchCloudData(); }
    catch (loadError) {
      await supabase.auth.signOut();
      state.user = null;
      state.role = null;
      state.loginMessage = loadError.message || "Could not load your account.";
    }
  }
}
render();
