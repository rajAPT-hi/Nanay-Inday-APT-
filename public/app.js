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
  lease_changes: [],
  settings: {
    water_rate: 45,
    electricity_rate: 0,
    electricity_total_bill: 0,
    electricity_total_usage: 0,
    late_fee_per_day: 50,
    grace_period_days: 3,
  },
};
const paymentFilters = { search: "", month: "all", status: "all", method: "all", location: "all", rentalType: "all" };

async function fetchCloudData() {
  const { data: profile, error: profileError } = await supabase
    .from("profiles").select("role, full_name, account_enabled").eq("id", state.user.id).single();
  if (profileError) throw profileError;
  if (!profile.account_enabled) {
    throw new Error("Your rental access has been disabled. Contact the property administrator.");
  }
  if (!["admin", "renter"].includes(profile.role)) {
    throw new Error("Your account does not have an assigned app role. Ask an administrator to set it up.");
  }

  const results = await Promise.all([
    supabase.from("renters").select("*").order("created_at", { ascending: false }),
    supabase.from("payments").select(profile.role === "admin"
      ? "*"
      : "id, renter_id, period, due_date, base_amount, utility_amount, amount, status, receipt_path, paid_at, payment_method, received_by, late_fee_amount, paid_amount, created_at")
      .order("due_date", { ascending: false }),
    supabase.from("utility_bills").select("*").order("created_at", { ascending: false }),
    supabase.from("settings").select("*"),
    profile.role === "admin"
      ? supabase.from("lease_changes").select("*").order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of results) {
    if (result.error) throw result.error;
  }
  const [renters, payments, utilities, settings, leaseChanges] = results;
  state.role = profile.role;
  state.user.name = profile.full_name || state.user.email;
  state.renters = renters.data;
  state.payments = payments.data;
  state.utility_bills = utilities.data;
  state.lease_changes = leaseChanges.data;
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
    ? Math.round((bill / usage) * 100000000) / 100000000
    : Number(settings.electricity_rate) || 0;
}
function initials(name = "") {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}
function renterById(id) {
  return state.renters.find((renter) => renter.id === id) || {};
}
function activeRenters() {
  return state.renters.filter((renter) => renter.status !== "terminated");
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
  const label = { paid: "Paid", due: "Due", overdue: "Overdue", review: "For review", active: "Active", expiring: "Expiring soon", terminated: "Terminated", expired: "Expired" }[status] || status;
  return `<span class="badge ${escapeHtml(status)}">${label}</span>`;
}
function isExpiring(renter) {
  if (renter.status === "terminated") return false;
  const remaining = (new Date(`${renter.contract_end}T23:59:59`) - Date.now()) / 86400000;
  return remaining >= 0 && remaining <= 30;
}
function contractStatus(renter) {
  if (renter.status === "terminated") return "terminated";
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
async function adminRequest(url, method, body) {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new Error("Your session expired. Sign in again.");
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let result;
  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(`The server returned an unexpected response (HTTP ${response.status}). Check the Render service logs and confirm the app is deployed.`);
  }
  if (!response.ok) throw new Error(result.error || `The administrator request failed (HTTP ${response.status}).`);
  return result;
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
          ${!renterMode && state.tab === "payments" && activeRenters().length ? `<button class="button primary" data-action="add-payment">＋ Create charge</button>` : ""}
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
  const expiringRenters = state.renters.filter((renter) => renter.status !== "terminated" && isExpiring(renter));
  const recentPayments = [...state.payments].sort((a, b) => new Date(b.paid_at || b.due_date) - new Date(a.paid_at || a.due_date)).slice(0, 4);
  return `<section class="welcome"><div><h2>Welcome back, ${escapeHtml(state.user.name.split(" ")[0])} 👋</h2><p>Here is your property summary for today.</p></div>
      <button class="button" data-action="add-renter">＋ Add new renter</button></section>
    <section class="stats">
      <div class="stat"><div class="stat-head"><span>Active renters</span><span class="stat-icon">♙</span></div><strong>${state.renters.filter((renter) => renter.status !== "terminated" && contractStatus(renter) !== "expired").length}</strong><small>Across your rental property</small></div>
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
function manilaDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function dayLabel(day) {
  const value = Number(day);
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[value % 10] || "th");
  return `${value}${suffix}`;
}
function nextRentDueDate(day, from = new Date()) {
  const dueDay = Number(day);
  const dateForMonth = (year, month) => new Date(year, month, Math.min(dueDay, new Date(year, month + 1, 0).getDate()));
  const currentMonthDue = dateForMonth(from.getFullYear(), from.getMonth());
  const dueDate = currentMonthDue >= new Date(from.getFullYear(), from.getMonth(), from.getDate())
    ? currentMonthDue
    : dateForMonth(from.getFullYear(), from.getMonth() + 1);
  const year = dueDate.getFullYear();
  const month = String(dueDate.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(dueDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${dayOfMonth}`;
}
function calculateContractEnd(start, months) {
  const [year, month, day] = start.split("-").map(Number);
  const targetMonth = month - 1 + Number(months);
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  const endDate = new Date(Date.UTC(year, targetMonth, Math.min(day, lastDay)));
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  return endDate.toISOString().slice(0, 10);
}
function renderRenterTable(renters) {
  if (!renters.length) return `<div class="empty"><span>♙</span>No renters yet. Add your first renter to get started.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>RENTER</th><th>UNIT / LOCATION</th><th>RENT / MONTH</th><th>RENT DUE</th><th>CONTRACT ENDS</th><th>STATUS</th><th>LEASE / DOCUMENTS</th></tr></thead><tbody>
    ${renters.map((renter) => `<tr>
      <td>
        <div class="person-cell"><div class="avatar">${initials(renter.full_name)}</div><div>
          <strong>${escapeHtml(renter.full_name)}</strong><small>${escapeHtml(renter.email)}</small>
          <button class="text-button payment-history-button" data-action="renter-payment-history" data-id="${escapeHtml(renter.id)}">View payment history</button>
        </div></div>
      </td>
      <td>${escapeHtml(renter.unit_name)}<small style="display:block;color:#89958d;margin-top:3px">${escapeHtml(renter.rental_type)} · ${escapeHtml(renter.location || "Location not set")}</small></td>
      <td>${money(renter.rent_amount)}</td>
      <td>${dayLabel(renter.rent_due_day)} of each month</td>
      <td>${formatDate(renter.contract_end)}</td>
      <td>${statusBadge(contractStatus(renter))}</td>
      <td>${renter.status !== "terminated" ? `<button class="text-button" data-action="edit-lease" data-id="${escapeHtml(renter.id)}">Edit lease</button><button class="text-button" style="color:var(--red)" data-action="terminate-lease" data-id="${escapeHtml(renter.id)}">Terminate</button>` : ""}<button class="text-button" data-action="renter-documents" data-id="${escapeHtml(renter.id)}">Documents</button><button class="text-button" data-action="lease-history" data-id="${escapeHtml(renter.id)}">Lease history</button>${renter.user_id ? `<button class="text-button" data-action="change-renter-password" data-id="${escapeHtml(renter.id)}">Password</button>` : renter.status !== "terminated" ? `<button class="text-button" data-action="create-renter-account" data-id="${escapeHtml(renter.id)}">Create login</button>` : ""}</td>
    </tr>`).join("")}
    </tbody></table></div>`;
}
function rentersPage() {
  return `<div class="section-title"><div><p>Manage lease terms, record the reason for changes, terminate leases, and securely store renter documents.</p></div></div>
    <div class="toolbar"><input class="search" id="renter-search" placeholder="⌕  Search renters, units, or locations..." /><select class="filter" id="renter-filter"><option value="all">All rental types</option><option>Room</option><option>House</option><option>Apartment</option></select><select class="filter" id="renter-location-filter"><option value="all">All locations</option>${["Vasquez", "Villa", "Cabalawan", "Kaskag"].map((location) => `<option>${location}</option>`).join("")}</select></div>
    <div class="card" id="renter-table">${renderRenterTable(state.renters)}</div>`;
}
function paymentsPage() {
  const payments = [...state.payments].sort((a, b) => new Date(b.due_date) - new Date(a.due_date));
  const monthOptions = [...new Set(payments.map((payment) => payment.due_date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  const locations = [...new Set(state.renters.map((renter) => renter.location).filter(Boolean))].sort();
  return `<div class="section-title"><div><p>Review receipts, track rent, and follow up on unpaid balances.</p></div></div>
    <div class="toolbar payment-toolbar">
      <input class="search" id="payment-search" type="search" value="${escapeHtml(paymentFilters.search)}" placeholder="⌕  Search renter, unit, or period..." aria-label="Search payments" />
      <select class="filter" id="payment-month-filter" aria-label="Filter by billing month"><option value="all" ${paymentFilters.month === "all" ? "selected" : ""}>All billing months</option>${monthOptions.map((month) => {
        const [year, monthNumber] = month.split("-").map(Number);
        const label = new Date(year, monthNumber - 1, 1).toLocaleDateString("en-PH", { month: "long", year: "numeric" });
        return `<option value="${month}" ${paymentFilters.month === month ? "selected" : ""}>${escapeHtml(label)}</option>`;
      }).join("")}</select>
      <select class="filter" id="payment-status-filter" aria-label="Filter by payment status"><option value="all" ${paymentFilters.status === "all" ? "selected" : ""}>All statuses</option><option value="pending" ${paymentFilters.status === "pending" ? "selected" : ""}>Pending</option><option value="review" ${paymentFilters.status === "review" ? "selected" : ""}>Awaiting review</option><option value="paid" ${paymentFilters.status === "paid" ? "selected" : ""}>Paid</option></select>
      <select class="filter" id="payment-method-filter" aria-label="Filter by payment method"><option value="all" ${paymentFilters.method === "all" ? "selected" : ""}>All methods</option><option value="cash" ${paymentFilters.method === "cash" ? "selected" : ""}>Cash</option><option value="online" ${paymentFilters.method === "online" ? "selected" : ""}>Online</option><option value="unknown" ${paymentFilters.method === "unknown" ? "selected" : ""}>Not recorded</option></select>
      <select class="filter" id="payment-location-filter" aria-label="Filter by location"><option value="all" ${paymentFilters.location === "all" ? "selected" : ""}>All locations</option>${locations.map((location) => `<option value="${escapeHtml(location)}" ${paymentFilters.location === location ? "selected" : ""}>${escapeHtml(location)}</option>`).join("")}</select>
      <select class="filter" id="payment-type-filter" aria-label="Filter by rental type"><option value="all" ${paymentFilters.rentalType === "all" ? "selected" : ""}>All rental types</option>${["Room", "House", "Apartment"].map((type) => `<option value="${type}" ${paymentFilters.rentalType === type ? "selected" : ""}>${type}</option>`).join("")}</select>
      <button class="button secondary" data-action="clear-payment-filters">Clear filters</button>
    </div>
    <p class="muted-note payment-result-count" id="payment-result-count" aria-live="polite"></p>
    <div class="stats" id="payment-stats"></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>RENTER</th><th>PERIOD</th><th>BASE RENT</th><th>UTILITIES</th><th>LATE FEE</th><th>TOTAL DUE</th><th>STATUS / RECEIPT</th><th>ACTION</th></tr></thead><tbody id="payment-table-body"></tbody></table></div></div>`;
}
function paymentStatsMarkup(payments) {
  return `<div class="stat"><div class="stat-head"><span>Collected</span><span class="stat-icon">✓</span></div><strong>${money(payments.filter((p) => p.status === "paid").reduce((t, p) => t + (Number(p.paid_amount) || Number(p.amount)), 0))}</strong><small>Payments marked paid</small></div>
    <div class="stat"><div class="stat-head"><span>Awaiting payment</span><span class="stat-icon">◷</span></div><strong>${payments.filter((p) => p.status !== "paid").length}</strong><small>Unpaid rental charges</small></div>
    <div class="stat"><div class="stat-head"><span>Late fees accrued</span><span class="stat-icon">₱</span></div><strong>${money(payments.reduce((t, p) => t + lateFee(p), 0))}</strong><small>After ${Number(state.settings.grace_period_days)} grace days</small></div>
    <div class="stat"><div class="stat-head"><span>Receipt reviews</span><span class="stat-icon">▧</span></div><strong>${payments.filter((p) => p.status === "review").length}</strong><small>Awaiting admin approval</small></div>`;
}
function paymentRowsMarkup(payments) {
  return payments.length ? payments.map((payment) => `<tr><td>${escapeHtml(renterById(payment.renter_id).full_name || "Renter")}</td><td>${escapeHtml(payment.period)}</td><td>${money(payment.base_amount)}</td><td>${money(payment.utility_amount)}</td><td>${money(payment.status === "paid" ? payment.late_fee_amount : lateFee(payment))}</td><td><strong>${money(payment.status === "paid" ? payment.paid_amount || payment.amount : Number(payment.amount) + lateFee(payment))}</strong></td><td>${statusBadge(paymentStatus(payment))}${payment.receipt_path ? proofFileActions(payment, "renter") : ""}${payment.online_receipt_path ? proofFileActions(payment, "online") : ""}${payment.status === "paid" ? `<button class="text-button" style="display:block;margin-top:5px" data-action="print-payment-receipt" data-id="${escapeHtml(payment.id)}">View / print receipt</button><small style="display:block;margin-top:5px;color:#718078">${payment.payment_method === "online" ? "Online" : payment.payment_method === "cash" ? "Cash" : "Method not recorded"}${payment.received_by ? ` · Received by ${escapeHtml(payment.received_by)}` : ""}</small>` : ""}</td><td>${payment.status !== "paid" ? `<button class="text-button" data-action="mark-paid" data-id="${escapeHtml(payment.id)}">${payment.status === "review" ? "Approve & mark paid" : "Mark paid"}</button>${renterById(payment.renter_id).phone ? `<button class="text-button" data-action="sms" data-id="${escapeHtml(payment.id)}">Send SMS</button>` : ""}` : "—"}</td></tr>`).join("") : `<tr><td colspan="8"><div class="empty">No payments match these filters.</div></td></tr>`;
}
function updatePaymentsFromFilters() {
  paymentFilters.search = document.querySelector("#payment-search")?.value.trim() || "";
  paymentFilters.month = document.querySelector("#payment-month-filter")?.value || "all";
  paymentFilters.status = document.querySelector("#payment-status-filter")?.value || "all";
  paymentFilters.method = document.querySelector("#payment-method-filter")?.value || "all";
  paymentFilters.location = document.querySelector("#payment-location-filter")?.value || "all";
  paymentFilters.rentalType = document.querySelector("#payment-type-filter")?.value || "all";
  const query = paymentFilters.search.toLowerCase();
  const { month, status, method, location, rentalType } = paymentFilters;
  const matches = state.payments.filter((payment) => {
    const renter = renterById(payment.renter_id);
    const paymentText = `${renter.full_name || ""} ${renter.unit_name || ""} ${payment.period || ""} ${payment.due_date || ""}`.toLowerCase();
    return (month === "all" || payment.due_date?.slice(0, 7) === month) &&
      (status === "all" || payment.status === status) &&
      (method === "all" || (method === "unknown" ? !payment.payment_method : payment.payment_method === method)) &&
      (location === "all" || renter.location === location) &&
      (rentalType === "all" || renter.rental_type === rentalType) &&
      paymentText.includes(query);
  }).sort((a, b) => new Date(b.due_date) - new Date(a.due_date));
  const tbody = document.querySelector("#payment-table-body");
  if (tbody) tbody.innerHTML = paymentRowsMarkup(matches);
  const stats = document.querySelector("#payment-stats");
  if (stats) stats.innerHTML = paymentStatsMarkup(matches);
  const resultCount = document.querySelector("#payment-result-count");
  if (resultCount) resultCount.textContent = `Showing ${matches.length} of ${state.payments.length} payments`;
}
function proofFileActions(payment, kind) {
  const online = kind === "online";
  const label = online ? "online payment proof" : "uploaded payment proof";
  return `<div style="margin-top:5px"><button class="text-button" data-action="${online ? "online-proof" : "receipt"}" data-id="${escapeHtml(payment.id)}">View ${label}</button><button class="text-button" style="color:#a23b30" data-action="delete-payment-proof" data-kind="${kind}" data-id="${escapeHtml(payment.id)}">Delete proof</button></div>`;
}
function renterPaymentHistoryModal(renterId) {
  const renter = renterById(renterId);
  if (!renter.id) return toast("Renter record was not found.", true);
  const payments = state.payments
    .filter((payment) => payment.renter_id === renterId)
    .sort((a, b) => new Date(b.due_date) - new Date(a.due_date));
  const rows = payments.length
    ? `<div class="table-wrap"><table><thead><tr><th>PERIOD</th><th>DUE DATE</th><th>CHARGE</th><th>LATE FEE</th><th>TOTAL</th><th>STATUS</th><th>RECEIPT</th></tr></thead><tbody>${payments.map((payment) => `<tr>
      <td>${escapeHtml(payment.period)}</td>
      <td>${formatDate(payment.due_date)}</td>
      <td>${money(payment.amount)}</td>
      <td>${money(payment.status === "paid" ? payment.late_fee_amount : lateFee(payment))}</td>
      <td><strong>${money(payment.status === "paid" ? payment.paid_amount || payment.amount : Number(payment.amount) + lateFee(payment))}</strong></td>
      <td>${statusBadge(paymentStatus(payment))}</td>
      <td>${payment.receipt_path ? proofFileActions(payment, "renter") : ""}${payment.online_receipt_path ? proofFileActions(payment, "online") : ""}${payment.status === "paid" ? `<button class="text-button" data-action="print-payment-receipt" data-id="${escapeHtml(payment.id)}">View / print generated receipt</button>` : !payment.receipt_path ? "Available after payment is confirmed" : ""}</td>
    </tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">No charges or payments have been recorded for this renter yet.</div>`;
  modal(`Payment history · ${escapeHtml(renter.full_name)}`, `<p class="muted-note">Complete payment history for ${escapeHtml(renter.unit_name)} · ${escapeHtml(renter.location || "Location not set")}</p>${rows}`,
    `<button class="button secondary" data-action="close-modal">Close</button>`);
}
function utilitiesPage() {
  const bills = state.utility_bills;
  const totalBill = Number(state.settings.electricity_total_bill);
  const totalUsage = Number(state.settings.electricity_total_usage);
  const rateText = totalBill > 0 && totalUsage > 0
    ? `₱${electricityRate().toFixed(8)} per kWh (${totalBill.toFixed(2)} ÷ ${totalUsage.toFixed(2)})`
    : "Enter the total bill and kWh to calculate the per-kWh rate.";
  return `<div class="section-title"><div><p>Enter the water bill amount directly and calculate electricity charges from current meter readings.</p></div></div>
    <div class="utility-grid">
      <div class="utility-card"><h3>Electricity rate</h3><p>Enter the current provider bill and total kWh. Clicking Calculate bill saves these values and keeps a billing snapshot.</p><div class="form-grid">
        <div class="field"><label>Total electricity bill (PHP)</label><input type="number" min="0" step="0.01" data-setting="electricity_total_bill" value="${Number(state.settings.electricity_total_bill)}" /></div>
        <div class="field"><label>Total kWh used on bill</label><input type="number" min="0" step="0.01" data-setting="electricity_total_usage" value="${Number(state.settings.electricity_total_usage)}" /></div>
      </div><div class="utility-summary" id="electricity-rate-preview">Calculated rate: ${rateText}</div></div>
      <div class="utility-card"><h3>Late payment policy</h3><p>Applied automatically to unpaid charges.</p><div class="form-grid">
        <div class="field"><label>Fee per late day (PHP)</label><input type="number" min="0" step="1" data-setting="late_fee_per_day" value="${Number(state.settings.late_fee_per_day)}" /></div>
        <div class="field"><label>Grace period (days)</label><input type="number" min="0" step="1" data-setting="grace_period_days" value="${Number(state.settings.grace_period_days)}" /></div>
      </div><button class="button secondary" style="margin-top:12px" data-action="save-rates">Save policy</button></div>
    </div>
    <div class="card" style="margin-top:17px"><div class="card-head"><h3>Recent utility bills</h3><button class="button primary" data-action="add-utility">＋ Calculate bill</button></div>
      ${bills.length ? `<div class="table-wrap"><table><thead><tr><th>RENTER / UNIT</th><th>PERIOD</th><th>WATER CHARGE</th><th>ELECTRIC METER</th><th>USAGE</th><th>PROVIDER BILL ÷ kWh = RATE</th><th>ELECTRIC CHARGE</th><th>TOTAL</th></tr></thead><tbody>${bills.map((bill) => `<tr><td>${escapeHtml(renterById(bill.renter_id).full_name || "Renter")}<small style="display:block;color:#89958d;margin-top:3px">${escapeHtml(renterById(bill.renter_id).unit_name || "")}</small></td><td>${escapeHtml(bill.period)}</td><td>${money(bill.water_charge)}</td><td>${Number(bill.electricity_previous)} → ${Number(bill.electricity_current)} kWh</td><td>${Number(bill.electricity_usage)} kWh</td><td>${money(bill.electricity_total_bill)} ÷ ${Number(bill.electricity_total_usage)} = ₱${Number(bill.electricity_rate).toFixed(8)}</td><td>${money(bill.electricity_charge)}</td><td><strong>${money(bill.amount)}</strong></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><span>ϟ</span>No utility bills yet. Enter the provider bill and kWh, save the rates, then calculate a bill.</div>`}
    </div>`;
}
function updateElectricityRatePreview() {
  const preview = document.querySelector("#electricity-rate-preview");
  const bill = Number(document.querySelector('[data-setting="electricity_total_bill"]')?.value);
  const usage = Number(document.querySelector('[data-setting="electricity_total_usage"]')?.value);
  if (!preview) return;
  preview.textContent = bill > 0 && usage > 0
    ? `Calculated rate: ₱${(Math.round((bill / usage) * 100000000) / 100000000).toFixed(8)} per kWh (${bill.toFixed(2)} ÷ ${usage.toFixed(2)})`
    : "Enter the current provider bill and a total kWh greater than zero.";
}
function rateCard(key, name, unit, suffix) {
  return `<div class="utility-card"><h3>${name} rate</h3><p>${unit}</p><div class="utility-rate"><div class="field"><label>Rate</label><input type="number" min="0" step="0.01" data-setting="${key}" value="${Number(state.settings[key])}" /></div><span style="font-size:11px;color:#718078">${suffix}</span></div><div class="utility-summary">Meter usage × rate = renter charge</div></div>`;
}
function renterPage() {
  const renter = state.renters.find((row) => row.user_id === state.user.id);
  if (!renter) return `<div class="card"><div class="empty"><span>⌂</span>Your rental details will appear here once the administrator links your renter account.</div></div>`;
  const payments = state.payments.filter((payment) => payment.renter_id === renter.id);
  const outstanding = payments.filter((p) => p.status !== "paid").reduce((t, p) => t + Number(p.amount) + lateFee(p), 0);
  const proofUploadPayments = payments.filter((payment) => payment.status !== "paid" && !payment.receipt_path);
  return `<section class="welcome renter-hero"><div><h2>Welcome, ${escapeHtml(renter.full_name.split(" ")[0])} 👋</h2><p>Your home at ${escapeHtml(renter.unit_name)} · ${escapeHtml(renter.rental_type)} · ${escapeHtml(renter.location || "Location not set")}</p></div><span class="status-pill">Contract ends ${formatDate(renter.contract_end)}</span></section>
    <section class="renter-bill">
      <div class="bill-line"><span>Monthly rent</span><strong>${money(renter.rent_amount)}</strong></div>
      <div class="bill-line"><span>Rent due each month</span><strong>${dayLabel(renter.rent_due_day)}</strong></div>
      <div class="bill-line"><span>Outstanding balance</span><strong>${money(outstanding)}</strong></div>
      <div class="bill-line"><span>Contract term</span><strong>${renter.contract_months} months</strong></div>
    </section>
    <div class="card" style="margin-bottom:17px"><div class="card-head"><div><h3>Upload online payment proof</h3><p class="muted-note">For an online transfer, upload its receipt or screenshot so the administrator can review it.</p></div></div>
      ${proofUploadPayments.length ? proofUploadPayments.map((payment) => `<div class="bill-line"><span>${escapeHtml(payment.period)} · Due ${formatDate(payment.due_date)} · ${money(Number(payment.amount) + lateFee(payment))}</span><button class="button secondary" data-action="upload-receipt" data-id="${escapeHtml(payment.id)}">Choose proof file</button></div>`).join("") : `<p class="muted-note">There are no unpaid charges waiting for proof right now.</p>`}
      <small class="muted-note">Accepted files: JPG, PNG, WebP, or PDF. Maximum size: 10 MB.</small>
    </div>
    <div class="card"><div class="card-head"><h3>My payment history</h3><button class="button secondary" data-action="refresh-payment-history">Refresh</button></div><p class="muted-note">Charges appear here after the administrator creates them. If you paid online, upload your transfer receipt or screenshot (JPG, PNG, WebP, or PDF, up to 10 MB) for review. Your printable receipt appears after the administrator confirms payment.</p>
      ${payments.length ? `<div class="table-wrap"><table><thead><tr><th>PERIOD</th><th>DUE DATE</th><th>RENT + UTILITIES</th><th>LATE FEE</th><th>STATUS</th><th>RECEIPT</th></tr></thead><tbody>${payments.map((p) => `<tr><td>${escapeHtml(p.period)}</td><td>${formatDate(p.due_date)}</td><td>${money(p.amount)}</td><td>${money(p.status === "paid" ? p.late_fee_amount : lateFee(p))}</td><td>${statusBadge(paymentStatus(p))}</td><td>${p.status === "paid" ? `<button class="text-button" data-action="print-payment-receipt" data-id="${escapeHtml(p.id)}">View / print receipt</button>` : p.receipt_path ? "Proof uploaded · awaiting review" : `<button class="text-button" data-action="upload-receipt" data-id="${escapeHtml(p.id)}">Upload digital payment proof</button>`}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">No rental charges have been added yet.</div>`}
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
  if (state.tab === "utilities") updateElectricityRatePreview();
  if (state.tab === "payments") updatePaymentsFromFilters();
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
    <div class="field"><label>Rental location</label><select name="location" required><option value="">Select location</option>${["Vasquez", "Villa", "Cabalawan", "Kaskag"].map((location) => `<option>${location}</option>`).join("")}</select></div>
    <div class="field"><label>Rental type</label><select name="rental_type"><option>Room</option><option>House</option><option>Apartment</option></select></div>
    <div class="field"><label>Contract term</label><select name="contract_months"><option value="6">6 months</option><option value="12">1 year (12 months)</option></select></div>
    <div class="field"><label>Contract start</label><input name="contract_start" type="date" value="${start}" required /></div>
    <div class="field"><label>Monthly rent (PHP)</label><input name="rent_amount" type="number" min="0" step="0.01" required /></div>
    <div class="field"><label>Rent due day (each month)</label><input name="rent_due_day" type="number" min="1" max="31" step="1" value="5" required /></div>
    <div class="field"><label>Renter login password</label><input name="password" type="password" autocomplete="new-password" minlength="12" required /></div>
    <div class="field full notice">Set a temporary password with at least 12 characters. Share it with the renter privately, and ask them to change it after signing in. The password is sent directly to Supabase Auth and is never saved in the rental record.</div></div></form>`,
  `<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-renter">Add renter</button>`);
}
function changeRenterPasswordModal(renterId) {
  const renter = renterById(renterId);
  if (!renter.user_id) return toast("This renter does not have a linked login account.", true);
  modal(`Change password · ${escapeHtml(renter.full_name)}`, `<form id="renter-password-form" data-renter-id="${escapeHtml(renterId)}"><div class="form-grid">
    <div class="field full"><label>New password</label><input name="password" type="password" autocomplete="new-password" minlength="12" required /></div>
    <div class="field full"><label>Confirm new password</label><input name="confirm_password" type="password" autocomplete="new-password" minlength="12" required /></div>
    <div class="field full notice">The new password replaces the renter's current password immediately. Share it privately; never send it in a group message.</div>
  </div></form>`, `<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-renter-password">Update password</button>`);
}
function createRenterAccountModal(renterId) {
  const renter = renterById(renterId);
  if (!renter.id || renter.user_id) return toast("This renter already has a linked login account.", true);
  modal(`Create renter login · ${escapeHtml(renter.full_name)}`, `<form id="create-renter-account-form" data-renter-id="${escapeHtml(renterId)}">
    <div class="notice">This creates a Supabase login for the renter and links it to this rental record. The email address on file is <strong>${escapeHtml(renter.email)}</strong>. Share the password privately.</div>
    <div class="form-grid" style="margin-top:16px">
      <div class="field full"><label>Temporary password (at least 12 characters)</label><input name="password" type="password" autocomplete="new-password" minlength="12" required /></div>
      <div class="field full"><label>Confirm temporary password</label><input name="confirm_password" type="password" autocomplete="new-password" minlength="12" required /></div>
    </div></form>`,
  `<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-renter-account">Create login</button>`);
}
async function createRenterAccount(renterId) {
  const form = document.querySelector("#create-renter-account-form");
  if (!form?.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  if (values.password !== values.confirm_password) return toast("The passwords do not match.", true);
  const button = document.querySelector('[data-action="save-renter-account"]');
  if (button?.disabled) return;
  if (button) {
    button.disabled = true;
    button.textContent = "Creating login...";
  }
  try {
    const result = await adminRequest(`/api/admin/renters/${encodeURIComponent(renterId)}/account`, "POST", {
      password: values.password,
    });
    const renter = renterById(renterId);
    renter.user_id = result.userId;
    renter.email = result.email;
    document.querySelector(".modal-backdrop")?.remove();
    render();
    toast("Renter login created. Share the email and password privately.");
  } catch (error) {
    toast(error.message || "Could not create the renter login.", true);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = "Create login";
    }
  }
}
function editLeaseModal(renterId) {
  const renter = renterById(renterId);
  if (renter.status === "terminated") return toast("Terminated leases cannot be edited.", true);
  modal(`Edit lease · ${escapeHtml(renter.full_name)}`, `<form id="lease-form" data-renter-id="${escapeHtml(renterId)}"><div class="form-grid">
    <div class="field"><label>Unit name / number</label><input name="unit_name" value="${escapeHtml(renter.unit_name)}" required /></div>
    <div class="field"><label>Rental location</label><select name="location" required>${renter.location ? "" : '<option value="" disabled selected>Select location</option>'}${["Vasquez", "Villa", "Cabalawan", "Kaskag"].map((location) => `<option ${renter.location === location ? "selected" : ""}>${location}</option>`).join("")}</select></div>
    <div class="field"><label>Rental type</label><select name="rental_type" required>${["Room", "House", "Apartment"].map((type) => `<option ${renter.rental_type === type ? "selected" : ""}>${type}</option>`).join("")}</select></div>
    <div class="field"><label>Contract term</label><select name="contract_months" required><option value="6" ${Number(renter.contract_months) === 6 ? "selected" : ""}>6 months</option><option value="12" ${Number(renter.contract_months) === 12 ? "selected" : ""}>1 year (12 months)</option></select></div>
    <div class="field"><label>Monthly rent (PHP)</label><input name="rent_amount" type="number" min="0" step=".01" value="${Number(renter.rent_amount)}" required /></div>
    <div class="field"><label>Rent due day (each month)</label><input name="rent_due_day" type="number" min="1" max="31" step="1" value="${Number(renter.rent_due_day || 5)}" required /></div>
    <div class="field"><label>Contract start</label><input name="contract_start" type="date" value="${escapeHtml(renter.contract_start)}" required /></div>
    <div class="field"><label>Contract end (calculated)</label><input name="contract_end" type="date" value="${escapeHtml(renter.contract_end)}" readonly required /></div>
    <div class="field full"><label>Required reason for this change</label><textarea name="reason" minlength="3" maxlength="1000" placeholder="Example: Monthly rent increased by agreement" required></textarea></div>
    </div></form>`, `<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-lease">Save lease changes</button>`);
  const form = document.querySelector("#lease-form");
  const updateEndDate = () => { form.elements.contract_end.value = calculateContractEnd(form.elements.contract_start.value, form.elements.contract_months.value); };
  form.elements.contract_start.addEventListener("change", updateEndDate);
  form.elements.contract_months.addEventListener("change", updateEndDate);
}
function terminateLeaseModal(renterId) {
  const renter = renterById(renterId);
  if (renter.status === "terminated") return toast("This lease is already terminated.", true);
  modal(`Terminate lease · ${escapeHtml(renter.full_name)}`, `<form id="terminate-form" data-renter-id="${escapeHtml(renterId)}">
    <div class="notice danger-notice">This immediately disables this renter's app access. Their renter record, payment history, and documents will be retained for administrators.</div>
    <div class="field" style="margin-top:16px"><label>Required termination reason</label><textarea name="reason" minlength="3" maxlength="1000" placeholder="Example: Lease ended or non-payment" required></textarea></div>
    </form>`, `<button class="button secondary" data-action="close-modal">Cancel</button><button class="button danger" data-action="confirm-termination">Terminate lease</button>`);
}
function renterDocumentsModal(renterId) {
  const renter = renterById(renterId);
  const documentRow = (kind, label, path) => `<div class="document-row"><div><strong>${label}</strong><small>${path ? "Uploaded" : "No image uploaded"}</small></div><div>${path ? `<button class="text-button" data-action="view-renter-document" data-id="${escapeHtml(renterId)}" data-kind="${kind}">View</button>` : ""}<label class="button secondary upload-label">${path ? "Replace" : "Upload"}<input type="file" accept="image/jpeg,image/png,image/webp" data-renter-document="${kind}" data-id="${escapeHtml(renterId)}" /></label></div></div>`;
  modal(`Renter documents · ${escapeHtml(renter.full_name)}`, `<div class="document-list">
    ${documentRow("id", "Renter ID image", renter.id_image_path)}
    ${documentRow("contract", "Physical contract image", renter.contract_image_path)}
    <p class="muted-note">Images only: JPG, PNG, or WebP. Maximum file size is 10 MB. Documents are private and visible to administrators only.</p>
    </div>`, `<button class="button secondary" data-action="close-modal">Close</button>`);
}
function leaseHistoryModal(renterId) {
  const renter = renterById(renterId);
  const entries = state.lease_changes.filter((entry) => entry.renter_id === renterId);
  const details = (value) => `<pre class="history-details">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  modal(`Lease history · ${escapeHtml(renter.full_name)}`, entries.length
    ? `<div class="history-list">${entries.map((entry) => `<article class="history-entry"><div class="history-entry-head"><strong>${entry.action === "lease_terminated" ? "Lease terminated" : "Lease updated"}</strong><time>${formatDate(entry.created_at)}</time></div><p><strong>Reason:</strong> ${escapeHtml(entry.reason)}</p><details><summary>Before and after</summary><div class="history-snapshots"><div><strong>Before</strong>${details(entry.previous_details)}</div><div><strong>After</strong>${details(entry.new_details)}</div></div></details></article>`).join("")}</div>`
    : `<div class="empty">No lease changes have been recorded for this renter.</div>`,
  `<button class="button secondary" data-action="close-modal">Close</button>`);
}
async function saveLease() {
  const form = document.querySelector("#lease-form");
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  try {
    const { error } = await supabase.rpc("admin_update_lease", {
      p_renter_id: form.dataset.renterId,
      p_unit_name: values.unit_name,
      p_location: values.location,
      p_rental_type: values.rental_type,
      p_contract_months: Number(values.contract_months),
      p_contract_start: values.contract_start,
      p_contract_end: values.contract_end,
      p_rent_amount: Number(values.rent_amount),
      p_rent_due_day: Number(values.rent_due_day),
      p_reason: values.reason.trim(),
    });
    if (error) throw error;
    await fetchCloudData();
    document.querySelector(".modal-backdrop")?.remove();
    render();
    toast("Lease details updated and change recorded.");
  } catch (error) { toast(error.message || "Could not update lease details.", true); }
}
async function terminateLease() {
  const form = document.querySelector("#terminate-form");
  if (!form.reportValidity()) return;
  const reason = new FormData(form).get("reason").trim();
  try {
    const { error } = await supabase.rpc("admin_terminate_lease", {
      p_renter_id: form.dataset.renterId,
      p_reason: reason,
    });
    if (error) throw error;
    await fetchCloudData();
    document.querySelector(".modal-backdrop")?.remove();
    render();
    toast("Lease terminated. Renter access is disabled and records are retained.");
  } catch (error) { toast(error.message || "Could not terminate lease.", true); }
}
async function uploadRenterDocument(renterId, kind, file) {
  if (!file) return;
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.type)) return toast("Choose a JPG, PNG, or WebP image.", true);
  if (file.size > 10 * 1024 * 1024) return toast("The image must be 10 MB or smaller.", true);
  const renter = renterById(renterId);
  const column = kind === "id" ? "id_image_path" : "contract_image_path";
  const safeName = file.name.replace(/[^\w.-]/g, "_");
  const path = `${renterId}/${kind}/${Date.now()}-${safeName}`;
  try {
    const { error: uploadError } = await supabase.storage.from("renter-documents").upload(path, file, { upsert: false, contentType: file.type });
    if (uploadError) throw uploadError;
    const { error: updateError } = await supabase.from("renters").update({ [column]: path }).eq("id", renterId);
    if (updateError) {
      const { error: cleanupError } = await supabase.storage.from("renter-documents").remove([path]);
      if (cleanupError) throw new Error(`${updateError.message} The uploaded file could not be cleaned up: ${cleanupError.message}`);
      throw updateError;
    }
    const oldPath = renter[column];
    renter[column] = path;
    if (oldPath && oldPath !== path) {
      const { error: cleanupError } = await supabase.storage.from("renter-documents").remove([oldPath]);
      if (cleanupError) toast(`Image saved, but the previous file could not be removed: ${cleanupError.message}`, true);
    }
    renterDocumentsModal(renterId);
    toast("Renter document uploaded securely.");
  } catch (error) { toast(error.message || "Could not upload renter document.", true); }
}
async function viewRenterDocument(renterId, kind) {
  const renter = renterById(renterId);
  const path = kind === "id" ? renter.id_image_path : renter.contract_image_path;
  if (!path) return toast("No image has been uploaded yet.", true);
  const { data, error } = await supabase.storage.from("renter-documents").createSignedUrl(path, 60);
  if (error) return toast(error.message, true);
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}
function addPaymentModal() {
  const today = new Date();
  const renters = activeRenters();
  const defaultDue = nextRentDueDate(renters[0]?.rent_due_day || 5, today);
  modal("Create a rental charge", `<form id="payment-form"><div class="form-grid">
    <div class="field full"><label>Renter</label><select name="renter_id" required>${renters.map((r) => `<option value="${r.id}">${escapeHtml(r.full_name)} · ${escapeHtml(r.unit_name)}</option>`).join("")}</select></div>
    <div class="field"><label>Charge period</label><input name="period" value="${today.toLocaleDateString("en-PH", { month: "long", year: "numeric" })}" required /></div>
    <div class="field"><label>Due date</label><input name="due_date" type="date" value="${defaultDue}" required /></div>
    <div class="field"><label>Base rent (PHP)</label><input name="base_amount" type="number" min="0" step=".01" required /></div>
    <div class="field"><label>Utilities (PHP)</label><input name="utility_amount" type="number" min="0" step=".01" value="0" required /></div>
    </div></form>`, `<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-payment">Create charge</button>`);
  const form = document.querySelector("#payment-form");
  form.elements.renter_id.addEventListener("change", () => {
    const renter = renterById(form.elements.renter_id.value);
    form.elements.base_amount.value = renter.rent_amount || 0;
    form.elements.due_date.value = nextRentDueDate(renter.rent_due_day || 5, today);
  });
  form.elements.base_amount.value = renterById(form.elements.renter_id.value).rent_amount || 0;
}
function addUtilityModal() {
  if (!activeRenters().length) return toast("Add an active renter before calculating a utility bill.", true);
  if (!(Number(state.settings.electricity_total_bill) > 0) || !(Number(state.settings.electricity_total_usage) > 0)) {
    return toast("Enter the total electricity bill and total kWh in Utility billing first.", true);
  }
  const month = new Date().toLocaleDateString("en-PH", { month: "long", year: "numeric" });
  const firstRenter = activeRenters()[0];
  const previousBill = state.utility_bills.find((bill) => bill.renter_id === firstRenter.id);
  modal("Calculate a utility bill", `<form id="utility-form"><div class="form-grid">
    <div class="field full"><label>Renter / unit</label><select name="renter_id">${activeRenters().map((r) => `<option value="${r.id}">${escapeHtml(r.full_name)} · ${escapeHtml(r.unit_name)}</option>`).join("")}</select></div>
    <div class="field full"><label>Billing period</label><input name="period" value="${month}" required /></div>
    <div class="field full"><label>Water charge (PHP)</label><input name="water_charge" type="number" min="0" step=".01" placeholder="Enter water bill amount" required /></div>
    <div class="field"><label>Previous electricity meter (kWh)</label><input name="electricity_previous" type="number" min="0" step=".01" value="${Number(previousBill?.electricity_current || 0)}" required /></div>
    <div class="field"><label>Current electricity meter (kWh)</label><input name="electricity_current" type="number" min="0" step=".01" placeholder="Enter current reading" required /></div>
    <div class="field full notice">Enter the water bill amount directly. Previous electricity reading is prefilled from this renter's latest saved utility bill; enter the current reading to calculate electricity usage.</div>
    <div class="field full notice" id="utility-preview">Enter meter readings to see the calculation using the current rates.</div></div></form>`,
  `<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-utility">Save utility charge</button>`);
  const form = document.querySelector("#utility-form");
  form.addEventListener("input", updateUtilityPreview);
  form.elements.renter_id.addEventListener("change", () => {
    const latestBill = state.utility_bills.find((bill) => bill.renter_id === form.elements.renter_id.value);
    form.elements.electricity_previous.value = Number(latestBill?.electricity_current || 0);
    form.elements.electricity_current.value = "";
    form.elements.water_charge.value = "";
    updateUtilityPreview();
  });
  updateUtilityPreview();
}
async function startUtilityFlow() {
  const billInput = document.querySelector('[data-setting="electricity_total_bill"]');
  const usageInput = document.querySelector('[data-setting="electricity_total_usage"]');
  if (billInput && usageInput) {
    const bill = Number(billInput.value);
    const usage = Number(usageInput.value);
    if (!(bill > 0)) {
      toast("Enter the current provider bill amount before calculating a utility charge.", true);
      billInput.focus();
      return;
    }
    if (!(usage > 0)) {
      toast("Enter the total kWh shown on the current provider bill before calculating a utility charge.", true);
      usageInput.focus();
      return;
    }
    const saved = await saveRates({ renderPage: false, successToast: false });
    if (!saved) return;
  }
  addUtilityModal();
}
function updateUtilityPreview() {
  const form = document.querySelector("#utility-form");
  if (!form) return;
  const values = Object.fromEntries(new FormData(form));
  if (values.electricity_current === "" || values.water_charge === "") {
    document.querySelector("#utility-preview").textContent = "Enter the water bill amount and current electricity reading to calculate the utility charge.";
    return;
  }
  const waterCharge = Number(values.water_charge);
  const currentElectricityReading = Number(values.electricity_current);
  const previousElectricityReading = Number(values.electricity_previous);
  const higherElectricityReading = Math.max(currentElectricityReading, previousElectricityReading);
  const lowerElectricityReading = Math.min(currentElectricityReading, previousElectricityReading);
  const power = higherElectricityReading - lowerElectricityReading;
  const unitRate = electricityRate();
  const electricityCharge = power * unitRate;
  const total = Math.round((waterCharge + electricityCharge) * 100) / 100;
  const preview = document.querySelector("#utility-preview");
  preview.textContent = `Water charge (entered): ${money(waterCharge)}. Electricity rate: ${money(state.settings.electricity_total_bill)} ÷ ${Number(state.settings.electricity_total_usage).toFixed(2)} kWh = ₱${unitRate.toFixed(8)}/kWh. Electricity usage: higher reading ${higherElectricityReading.toFixed(2)} − lower reading ${lowerElectricityReading.toFixed(2)} = ${power.toFixed(2)} kWh; electricity charge: ${power.toFixed(2)} × ₱${unitRate.toFixed(8)} = ${money(electricityCharge)}. Total utility charge: ${money(total)}.`;
}

async function saveRenter() {
  const form = document.querySelector("#renter-form");
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const submitButton = document.querySelector('[data-action="save-renter"]');
  if (submitButton?.disabled) return;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Creating renter account...";
  }
  const renter = {
    full_name: data.full_name.trim(), email: data.email.trim(), phone: data.phone.trim(),
    unit_name: data.unit_name.trim(), location: data.location, rent_due_day: Number(data.rent_due_day),
    rental_type: data.rental_type, contract_months: Number(data.contract_months),
    contract_start: data.contract_start, contract_end: calculateContractEnd(data.contract_start, data.contract_months), rent_amount: Number(data.rent_amount),
  };
  try {
    {
      const { data: invited, error: inviteError } = await fetch("/api/admin/renters", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${(await supabase.auth.getSession()).data.session.access_token}` },
        body: JSON.stringify({
          email: renter.email,
          name: renter.full_name,
          phone: renter.phone,
          unitName: renter.unit_name,
          location: renter.location,
          rentDueDay: renter.rent_due_day,
          rentalType: renter.rental_type,
          contractMonths: renter.contract_months,
          contractStart: renter.contract_start,
          contractEnd: renter.contract_end,
          rentAmount: renter.rent_amount,
          password: data.password,
        }),
      }).then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || "Could not invite renter.");
        return { data: json, error: null };
      });
      if (inviteError) throw inviteError;
      state.renters.unshift(invited.renter);
    }
    document.querySelector(".modal-backdrop")?.remove();
    render();
    toast("Renter account created with the password you set.");
  } catch (error) {
    toast(error.message || "Could not add renter.", true);
  } finally {
    if (submitButton?.isConnected) {
      submitButton.disabled = false;
      submitButton.textContent = "Add renter";
    }
  }
}
async function changeRenterPassword(renterId) {
  const form = document.querySelector("#renter-password-form");
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  if (values.password !== values.confirm_password) {
    return toast("The new passwords do not match.", true);
  }
  try {
    await adminRequest(`/api/admin/renters/${encodeURIComponent(renterId)}/password`, "PUT", {
      password: values.password,
    });
    document.querySelector(".modal-backdrop")?.remove();
    toast("Renter password changed. Share it with them privately.");
  } catch (error) {
    toast(error.message || "Could not change renter password.", true);
  }
}

async function savePayment() {
  const form = document.querySelector("#payment-form");
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const saveButton = document.querySelector('[data-action="save-payment"]');
  if (saveButton?.disabled) return;
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Creating charge...";
  }
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
    toast("Charge created and added to the renter's payment history. The receipt is available after payment is confirmed.");
  } catch (error) {
    toast(error.message || "Could not create charge.", true);
  } finally {
    if (saveButton?.isConnected) {
      saveButton.disabled = false;
      saveButton.textContent = "Create charge";
    }
  }
}
async function refreshPaymentHistory() {
  const button = document.querySelector('[data-action="refresh-payment-history"]');
  if (button?.disabled) return;
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing...";
  }
  try {
    await fetchCloudData();
    render();
    toast("Payment history refreshed.");
  } catch (error) {
    toast(error.message || "Could not refresh payment history.", true);
  } finally {
    const refreshedButton = document.querySelector('[data-action="refresh-payment-history"]');
    if (refreshedButton?.isConnected) {
      refreshedButton.disabled = false;
      refreshedButton.textContent = "Refresh";
    }
  }
}
async function saveUtility() {
  const form = document.querySelector("#utility-form");
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  if (!(Number(state.settings.electricity_total_bill) > 0) || !(Number(state.settings.electricity_total_usage) > 0)) {
    return toast("Enter the current provider bill and total kWh in Utility billing first.", true);
  }
  const saveButton = document.querySelector('[data-action="save-utility"]');
  if (saveButton?.disabled) return;
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
  }
  try {
    const { error } = await supabase.rpc("admin_create_utility_bill", {
      p_renter_id: data.renter_id,
      p_period: data.period.trim(),
      p_due_date: new Date().toISOString().slice(0, 10),
      p_water_charge: Number(data.water_charge),
      p_electricity_previous: Number(data.electricity_previous),
      p_electricity_current: Number(data.electricity_current),
    });
    if (error) throw error;
    document.querySelector(".modal-backdrop")?.remove();
    try {
      await fetchCloudData();
    } catch (refreshError) {
      render();
      return toast(`Utility bill was saved, but the app could not refresh: ${refreshError.message}. Reload the page to view it.`, true);
    }
    render();
    toast("Utility bill calculated and saved to payment history.");
  } catch (error) {
    toast(error.message || "Could not save utility bill.", true);
  } finally {
    if (saveButton?.isConnected) {
      saveButton.disabled = false;
      saveButton.textContent = "Save utility charge";
    }
  }
}
async function saveRates({ renderPage = true, successToast = true } = {}) {
  const inputs = [...document.querySelectorAll("[data-setting]")];
  const values = Object.fromEntries(inputs.map((input) => [input.dataset.setting, Number(input.value)]));
  if (inputs.some((input) => !Number.isFinite(Number(input.value)) || Number(input.value) < 0)) {
    toast("Rates and fees must be zero or greater.", true);
    return false;
  }
  if (!(values.electricity_total_bill > 0) || !(values.electricity_total_usage > 0)) {
    toast("Enter a total electricity bill and total kWh greater than zero.", true);
    return false;
  }
  values.electricity_rate = Math.round((values.electricity_total_bill / values.electricity_total_usage) * 100000000) / 100000000;
  try {
    const { error } = await supabase.from("settings").upsert(Object.entries(values).map(([key, value]) => ({ key, value })), { onConflict: "key" });
    if (error) throw error;
    state.settings = { ...state.settings, ...values };
    if (renderPage) render();
    if (successToast) toast("Utility rates and late fee policy saved.");
    return true;
  } catch (error) {
    toast(error.message || "Could not save settings.", true);
    return false;
  }
}
function confirmPaymentModal(id) {
  const payment = state.payments.find((item) => item.id === id);
  if (!payment || payment.status === "paid") return toast("This payment is already confirmed.", true);
  modal("Confirm payment", `<form id="confirm-payment-form" data-payment-id="${escapeHtml(id)}">
    <div class="notice">Confirming this payment creates a receipt for the renter. The late fee shown here will be included in the amount received.</div>
    <div class="form-grid" style="margin-top:16px">
      <div class="field"><label>Payment method</label><select id="confirm-payment-method" name="payment_method" required><option value="cash">Cash</option><option value="online">Online</option></select></div>
      <div class="field"><label>Received by</label><input name="received_by" maxlength="120" value="${escapeHtml(state.user.name || state.user.email || "")}" required /></div>
      <div class="field full" id="online-proof-field" style="display:none"><label>Online payment receipt image / PDF</label><input id="online-proof-file" name="online_receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" /><small class="muted-note">Required for online payments. Images or PDF, maximum 10 MB.</small></div>
      <div class="field full"><strong>Rental charge: ${money(payment.amount)}</strong><small class="muted-note">Late fee collected: ${money(lateFee(payment))} · Total received: ${money(Number(payment.amount) + lateFee(payment))}</small></div>
    </div></form>`,
  `<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" data-action="confirm-payment">Confirm payment</button>`);
  const method = document.querySelector("#confirm-payment-method");
  const proofField = document.querySelector("#online-proof-field");
  const proofInput = document.querySelector("#online-proof-file");
  method.addEventListener("change", () => {
    const online = method.value === "online";
    proofField.style.display = online ? "" : "none";
    proofInput.required = online;
    if (!online) proofInput.value = "";
  });
}
async function markPaid() {
  const form = document.querySelector("#confirm-payment-form");
  if (!form?.reportValidity()) return;
  const payment = state.payments.find((item) => item.id === form.dataset.paymentId);
  const values = Object.fromEntries(new FormData(form));
  const file = form.elements.online_receipt.files?.[0];
  if (!["cash", "online"].includes(values.payment_method) || !values.received_by.trim()) {
    return toast("Select a payment method and enter who received the payment.", true);
  }
  if (values.payment_method === "online" && !file) return toast("Upload the online payment receipt before confirming.", true);
  if (file && !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) {
    return toast("Choose a JPG, PNG, WebP, or PDF payment receipt.", true);
  }
  if (file && file.size > 10 * 1024 * 1024) return toast("The payment receipt must be 10 MB or smaller.", true);

  let proofPath = null;
  try {
    if (!payment || payment.status === "paid") throw new Error("This payment is already confirmed or no longer available.");
    if (values.payment_method === "online") {
      const safeName = file.name.replace(/[^\w.-]/g, "_");
      proofPath = `${payment.id}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await supabase.storage.from("payment-proofs")
        .upload(proofPath, file, { upsert: false, contentType: file.type });
      if (uploadError) throw uploadError;
    }
    const lateFeeCollected = lateFee(payment);
    const paidAt = manilaDateString();
    const { data: updated, error } = await supabase.from("payments").update({
      status: "paid",
      paid_at: paidAt,
      payment_method: values.payment_method,
      received_by: values.received_by.trim(),
      online_receipt_path: proofPath,
      late_fee_amount: lateFeeCollected,
      paid_amount: Number(payment.amount) + lateFeeCollected,
    }).eq("id", payment.id).eq("status", payment.status).select("id").maybeSingle();
    if (error) throw error;
    if (!updated) throw new Error("Another administrator already changed this payment. Refresh the page before trying again.");
    Object.assign(payment, {
      status: "paid",
      paid_at: paidAt,
      payment_method: values.payment_method,
      received_by: values.received_by.trim(),
      online_receipt_path: proofPath,
      late_fee_amount: lateFeeCollected,
      paid_amount: Number(payment.amount) + lateFeeCollected,
    });
    document.querySelector(".modal-backdrop")?.remove();
    render();
    toast("Payment confirmed. The renter can now view and print their receipt.");
  } catch (error) {
    if (proofPath) {
      const { error: cleanupError } = await supabase.storage.from("payment-proofs").remove([proofPath]);
      if (cleanupError) console.error("Could not remove online proof after failed payment confirmation:", cleanupError.message);
    }
    toast(error.message || "Could not confirm payment.", true);
  }
}
async function uploadReceipt(id, file) {
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) {
    return toast("Choose a JPG, PNG, WebP, or PDF payment proof.", true);
  }
  if (file.size > 10 * 1024 * 1024) return toast("The payment proof must be 10 MB or smaller.", true);
  let path = null;
  let uploaded = false;
  try {
    const payment = state.payments.find((item) => item.id === id);
    if (!payment || payment.status === "paid" || payment.receipt_path) {
      throw new Error("This payment can no longer accept a proof upload. Refresh your payment history.");
    }
    path = `${state.user.id}/${id}/${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
    const { error: uploadError } = await supabase.storage.from("receipts").upload(path, file, { upsert: false, contentType: file.type });
    if (uploadError) throw uploadError;
    uploaded = true;
    const { data: updated, error } = await supabase.from("payments").update({ receipt_path: path, status: "review" })
      .eq("id", id).eq("status", payment.status).is("receipt_path", null).select("id").maybeSingle();
    if (error) throw error;
    if (!updated) throw new Error("This payment changed while the proof was uploading. Refresh your payment history and try again if it is still unpaid.");
    payment.receipt_path = path;
    payment.status = "review";
    render();
    toast("Receipt uploaded and sent for review.");
  } catch (error) {
    let cleanupMessage = "";
    if (uploaded) {
      const { error: cleanupError } = await supabase.storage.from("receipts").remove([path]);
      if (cleanupError) {
        console.error("Could not remove renter proof after a failed upload:", cleanupError.message);
        cleanupMessage = " The uploaded file may remain in storage; contact the administrator if it appears in your history.";
      }
    }
    toast(`${error.message || "Could not upload receipt."}${cleanupMessage}`, true);
  }
}
async function deletePaymentProof(id, kind) {
  if (state.role !== "admin") return toast("Only an administrator can delete payment proof.", true);
  const payment = state.payments.find((item) => item.id === id);
  const online = kind === "online";
  const field = online ? "online_receipt_path" : "receipt_path";
  const bucket = online ? "payment-proofs" : "receipts";
  const path = payment?.[field];
  if (!payment || !path) return toast("This uploaded proof is no longer available. Refresh the payment history.", true);
  const label = online ? "online payment proof" : "renter-uploaded payment proof";
  if (!window.confirm(`Delete this ${label}? The payment history and generated receipt will remain unchanged.`)) return;

  const wasUnderReview = !online && payment.status === "review";
  const restoredStatus = wasUnderReview ? "pending" : payment.status;
  try {
    const { data: updated, error } = await supabase.from("payments")
      .update({ [field]: null, ...(wasUnderReview ? { status: "pending" } : {}) })
      .eq("id", id).eq(field, path).select("id").maybeSingle();
    if (error) throw error;
    if (!updated) throw new Error("This proof changed before it could be deleted. Refresh the payment history and try again.");

    const { error: storageError } = await supabase.storage.from(bucket).remove([path]);
    if (storageError) {
      const { data: restored, error: restoreError } = await supabase.from("payments")
        .update({ [field]: path, ...(wasUnderReview ? { status: "review" } : {}) })
        .eq("id", id).is(field, null).eq("status", restoredStatus).select("id").maybeSingle();
      if (restoreError || !restored) {
        throw new Error(`Storage could not delete the file (${storageError.message}), and the payment record could not be restored. Contact the administrator before retrying.`);
      }
      throw storageError;
    }

    payment[field] = null;
    if (wasUnderReview) payment.status = "pending";
    if (document.querySelector(".modal-backdrop") && state.tab === "renters") {
      renterPaymentHistoryModal(payment.renter_id);
    } else {
      render();
    }
    toast("Uploaded proof deleted. Payment history was retained.");
  } catch (error) {
    toast(error.message || "Could not delete the uploaded proof.", true);
  }
}
async function showReceipt(id) {
  const payment = state.payments.find((item) => item.id === id);
  const { data, error } = await supabase.storage.from("receipts").createSignedUrl(payment.receipt_path, 60);
  if (error) return toast(error.message, true);
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}
async function showOnlineProof(id) {
  const payment = state.payments.find((item) => item.id === id);
  if (!payment?.online_receipt_path) return toast("No online payment proof is available.", true);
  const { data, error } = await supabase.storage.from("payment-proofs").createSignedUrl(payment.online_receipt_path, 60);
  if (error) return toast(error.message, true);
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}
function printPaymentReceipt(id) {
  const payment = state.payments.find((item) => item.id === id);
  if (!payment || payment.status !== "paid") return toast("A receipt is available after the administrator confirms payment.", true);
  const renter = renterById(payment.renter_id);
  const receiptWindow = window.open("", "_blank");
  if (!receiptWindow) return toast("Allow pop-ups to open and print your receipt.", true);
  const fee = Number(payment.late_fee_amount) || 0;
  const total = Number(payment.paid_amount) || Number(payment.amount);
  receiptWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Rental payment receipt</title><style>
    body{font-family:Arial,sans-serif;color:#26372e;margin:36px auto;max-width:680px;padding:24px}
    h1{color:#286b50;margin-bottom:4px}.muted{color:#68776e}.total{font-size:20px;font-weight:bold}
    table{border-collapse:collapse;width:100%;margin:22px 0}td{padding:10px 4px;border-bottom:1px solid #dce5df}
    td:last-child{text-align:right}footer{margin-top:36px;font-size:12px;color:#68776e}
    @media print{body{margin:0 auto;padding:0}}
    </style></head><body><h1>Nanay Inday's Rentals</h1><p class="muted">Payment receipt</p>
    <table><tbody>
      <tr><td>Receipt / payment ID</td><td>${escapeHtml(payment.id)}</td></tr>
      <tr><td>Received from</td><td>${escapeHtml(renter.full_name || "Renter")}</td></tr>
      <tr><td>Rental unit</td><td>${escapeHtml(renter.unit_name || "—")}</td></tr>
      <tr><td>Billing period</td><td>${escapeHtml(payment.period)}</td></tr>
      <tr><td>Payment date</td><td>${escapeHtml(formatDate(payment.paid_at))}</td></tr>
      <tr><td>Rent and utilities</td><td>${money(payment.amount)}</td></tr>
      <tr><td>Late fee</td><td>${money(fee)}</td></tr>
      <tr class="total"><td>Total received</td><td>${money(total)}</td></tr>
      <tr><td>Payment method</td><td>${escapeHtml(payment.payment_method ? payment.payment_method[0].toUpperCase() + payment.payment_method.slice(1) : "Not recorded")}</td></tr>
      <tr><td>Received by</td><td>${escapeHtml(payment.received_by || "—")}</td></tr>
    </tbody></table><footer>Keep this receipt for your records. Generated by Nanay Inday's Rentals.</footer>
    <script>window.addEventListener("load",()=>window.print())</script></body></html>`);
  receiptWindow.document.close();
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
  if (action === "edit-lease") return editLeaseModal(id);
  if (action === "save-lease") return saveLease();
  if (action === "terminate-lease") return terminateLeaseModal(id);
  if (action === "confirm-termination") return terminateLease();
  if (action === "renter-documents") return renterDocumentsModal(id);
  if (action === "view-renter-document") return viewRenterDocument(id, target.dataset.kind);
  if (action === "lease-history") return leaseHistoryModal(id);
  if (action === "renter-payment-history") return renterPaymentHistoryModal(id);
  if (action === "change-renter-password") return changeRenterPasswordModal(id);
  if (action === "create-renter-account") return createRenterAccountModal(id);
  if (action === "save-renter-account") return createRenterAccount(document.querySelector("#create-renter-account-form")?.dataset.renterId);
  if (action === "save-renter-password") return changeRenterPassword(document.querySelector("#renter-password-form")?.dataset.renterId);
  if (action === "add-payment") return activeRenters().length ? addPaymentModal() : toast("Add an active renter before creating a charge.", true);
  if (action === "add-utility") return startUtilityFlow();
  if (action === "close-modal") return document.querySelector(".modal-backdrop")?.remove();
  if (action === "save-renter") return saveRenter();
  if (action === "save-payment") return savePayment();
  if (action === "save-utility") return saveUtility();
  if (action === "save-rates") return saveRates();
  if (action === "mark-paid") return confirmPaymentModal(id);
  if (action === "confirm-payment") return markPaid();
  if (action === "receipt") return showReceipt(id);
  if (action === "online-proof") return showOnlineProof(id);
  if (action === "delete-payment-proof") return deletePaymentProof(id, target.dataset.kind);
  if (action === "print-payment-receipt") return printPaymentReceipt(id);
  if (action === "refresh-payment-history") return refreshPaymentHistory();
  if (action === "clear-payment-filters") {
    Object.assign(paymentFilters, { search: "", month: "all", status: "all", method: "all", location: "all", rentalType: "all" });
    for (const selector of ["#payment-search", "#payment-month-filter", "#payment-status-filter", "#payment-method-filter", "#payment-location-filter", "#payment-type-filter"]) {
      const control = document.querySelector(selector);
      if (control) control.value = selector === "#payment-search" ? "" : "all";
    }
    return updatePaymentsFromFilters();
  }
  if (action === "sms") return sendSms(id);
  if (action === "upload-receipt") {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/jpeg,image/png,image/webp,application/pdf";
    input.onchange = () => uploadReceipt(id, input.files?.[0]);
    input.click();
  }
});
document.addEventListener("change", (event) => {
  const input = event.target.closest("[data-renter-document]");
  if (input) uploadRenterDocument(input.dataset.id, input.dataset.renterDocument, input.files?.[0]);
});
document.addEventListener("input", (event) => {
  if (event.target.matches('[data-setting="electricity_total_bill"], [data-setting="electricity_total_usage"]')) {
    updateElectricityRatePreview();
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
  if (event.target.matches("[data-setting='electricity_total_bill'], [data-setting='electricity_total_usage']")) updateElectricityRatePreview();
  if (event.target.matches("#renter-search")) updateRenterTableFromFilters();
  if (event.target.matches("#payment-search")) updatePaymentsFromFilters();
});
document.addEventListener("change", (event) => {
  if (event.target.matches("#renter-filter, #renter-location-filter")) updateRenterTableFromFilters();
  if (event.target.matches("#payment-month-filter, #payment-status-filter, #payment-method-filter, #payment-location-filter, #payment-type-filter")) updatePaymentsFromFilters();
});
function updateRenterTableFromFilters() {
  const query = document.querySelector("#renter-search")?.value.toLowerCase() || "";
  const type = document.querySelector("#renter-filter")?.value || "all";
  const location = document.querySelector("#renter-location-filter")?.value || "all";
  const matches = state.renters.filter((renter) =>
    (type === "all" || renter.rental_type === type) &&
    (location === "all" || renter.location === location) &&
    `${renter.full_name} ${renter.email} ${renter.unit_name} ${renter.location || ""}`.toLowerCase().includes(query));
  const table = document.querySelector("#renter-table");
  if (table) table.innerHTML = renderRenterTable(matches);
}
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
