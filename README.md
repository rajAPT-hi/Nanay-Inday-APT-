# Nanay Inday's Rentals

A PC-friendly rental management web app for house, room, and apartment rentals. It includes administrator and renter views, Supabase email/password authentication and database/storage, Render hosting configuration, payment and receipt tracking, contract expiry alerts, late fees, configurable local utility rates, and an optional SIM SMS gateway.

## Try it locally

Install Node.js 20 or later, then run:

```powershell
npm install
npm start
```

Open `http://localhost:3000` and sign in with an account created in Supabase Authentication. The app uses live Supabase authentication and does not provide demo accounts.

## Configure Supabase

1. Create a Supabase organization/project and save the database password somewhere private.
2. In the project **SQL Editor**, open a new query, paste the complete contents of [`supabase/schema.sql`](./supabase/schema.sql), and run it. This creates or updates the tables, private receipt, payment-proof, and renter-document buckets, lease audit functions, reminder log, and row-level security policies. When updating an existing project, rerun the full schema so all migration columns, functions, and policies are applied.
3. From **Project Settings → API Keys** (or **Data API**, depending on the dashboard version), copy the project URL and publishable/anon key. Copy the **service_role/secret key** separately for the Render server only. Never put this key in `public/`, browser code, GitHub, or chat.
4. Configure Supabase **Authentication → SMTP Settings** with an email provider if you want password-reset emails to work. Administrators can create a renter login when adding a renter or set it up later; renter passwords are stored only by Supabase Auth, never in the rental tables.
5. In Supabase **Authentication → Users**, add the property administrator with the owner's email. The schema creates a `profiles` row when that auth user is created. In **SQL Editor**, promote only that administrator account (replace the example email):

   ```sql
   update public.profiles
   set role = 'admin'
   where id = (select id from auth.users where email = 'admin@example.com');
   ```

6. You can initially allow the eventual Render hostname in **Authentication → URL Configuration → Redirect URLs**, for example `https://YOUR-SERVICE.onrender.com/**`. After Render creates the real hostname, set the exact production Site URL and redirect URL there. Do not leave broad wildcard URLs enabled in a production project.
7. Administrators can add renters with or without login credentials. Login passwords must be at least 12 characters. From **Renters & leases**, an administrator can later change a renter's password. Share initial and changed passwords privately and ask renters to choose a new password after first sign-in.

### Add another administrator

1. In Supabase **Authentication → Users**, add or invite the second administrator using their own email address. They should accept the invitation and set their password.
2. In the SQL Editor, replace the example email and run:

   ```sql
   update public.profiles
   set role = 'admin'
   where id = (
     select id
     from auth.users
     where lower(email) = lower('second-admin@example.com')
   )
   returning id, full_name, role;
   ```

3. Confirm the result shows the expected user and `admin`. If no row is returned, verify the email under **Authentication → Users** and check that the auth profile was created. The new administrator can then sign in through the app using their Supabase password.

The schema enables row-level security. Renters can only read their own rental, charges, and utility bills, and can submit a receipt for an unpaid charge. Administrators manage renter records, rates, bills, and payment status. Receipt files are kept in a private Storage bucket and are shown with short-lived signed links.

### Payment confirmation and rent reminder emails

Monthly rent charges are automatically scheduled for each active renter from the current contract month through the contract end, using the renter's rent due day (clamped to the month's last day when necessary). Charges are created as unpaid rent entries; this does not collect or process payments. Applying the latest `supabase/schema.sql` schedules charges for existing active contracts from the current month forward. Future unpaid generated charges are refreshed when an administrator changes the lease dates, rent, or due day, and removed when a lease is terminated; paid charges and charges already under receipt review are retained.

Before confirming a payment, an administrator must select cash or online and enter who received it. Online payments also require an image or PDF proof (up to 10 MB), stored in a separate private administrator-only bucket. Renters can upload a transfer receipt or screenshot (JPG, PNG, WebP, or PDF, up to 10 MB) for an unpaid charge; administrators can review it before confirmation. The admin Payments view and the Overview's Upcoming payments panel share calendar-based due-date range filters. The Payments view also filters by status, payment method, location, rental type, or renter/unit/period search; its summary totals reflect matching payments. Admins can open a renter's **Payment history** from **Renters & leases** to review charges and view/print generated receipts. Admins can delete either uploaded proof file; this removes only the uploaded file and keeps payment history and generated receipts intact. A newly created charge appears in the renter's history as unpaid; its printable payment receipt is generated only after admin confirmation. Renters can use **Refresh** to load charges added while they were already signed in.

To email both administrator accounts a rent reminder 7 days before the due date and again on the due date, configure these SMTP variables in Render's service **Environment** settings:

- `SMTP_HOST`: SMTP server hostname from your email provider.
- `SMTP_PORT`: SMTP port, usually `465` for implicit TLS or `587` for STARTTLS.
- `SMTP_USER` and `SMTP_PASSWORD`: SMTP account credentials or provider-generated app password.
- `SMTP_FROM`: sender address permitted by your SMTP provider.

The app uses `Asia/Manila` for due-date checks and emails both administrator accounts and the renter at the email address on their rental record. Reminder attempts are tracked separately for each recipient in Supabase to prevent duplicate messages; failed sends are logged and retried during that due-date window. The checker runs every 15 minutes while the Render web process is running. Render's free web services can spin down when idle, so use an always-on service or a dedicated scheduled job if reminders must be delivered reliably even when nobody visits the app. Keep SMTP credentials only in Render environment settings, not in Git or browser code. Email sending stays disabled until all five SMTP values are configured.

When adding a renter from **Renters & leases**, email and password are optional. Leave them blank to save the rental record without login access; that renter cannot sign in until an administrator sets up a login. To enable access later, select **Create login** in the renter row and provide their email and a temporary password of at least 12 characters. You can also provide both fields when first adding the renter to create the login at the same time. The email must not already be used by another Supabase Auth account. If the app reports a duplicate email, check **Supabase → Authentication → Users** before changing or reusing that address. Passwords are set directly in Supabase Auth and are never stored in the rental database. Invalid sign-in attempts show a popup explaining that the account may not be set up yet and advising the renter to contact support or the property administrator.

When creating a renter, administrators select a rental location (Vasquez, Villa, Cabalawan, Kaskag, or Cebu) and set the recurring rent due day (1–31). New rental charges default to the renter's next due date; months shorter than the selected due day use that month's last calendar day. Use **Admin notes** in a renter's row to save private notes that are visible only to administrators. Apply the latest `supabase/schema.sql` before using Cebu or admin notes on an existing project.

From **Renters & leases**, administrators can edit an active renter's unit, location, rental type, term, dates, rent due day, and monthly rent. Every edit requires a reason and creates a before/after audit entry visible under **History**. Lease termination also requires a reason, disables the linked renter account in the app, and preserves the renter, payment history, and documents for administrator review. If a terminated renter signs in, the app displays a notice with the recorded reason and asks them to contact the administrator; they remain blocked from rental data. Active renters can request a lease renewal from their dashboard. Administrators review requests on **Overview** or **Renters & leases**, approve or decline with a message, and then update the lease dates and terms through **Edit lease** when a renewal is approved. Renters see request status and the administrator's message in their dashboard, and either side can refresh to check for updates. Apply the latest `supabase/schema.sql` to create the renewal request table and access policies.

Administrators can upload or replace renter ID and signed physical contract images under **Documents**. Supported formats are JPG, PNG, and WebP, up to 10 MB per image. These files are stored in a private, admin-only Supabase Storage bucket; the app opens an administrator-only, short-lived signed link when a document is viewed. Apply the latest `supabase/schema.sql` before using these features.

## Deploy to Render

1. Install Node.js 20 or later and Git on the PC if they are not already installed. Create a **private GitHub repository** and upload this project. The included `.gitignore` prevents `.env` and `node_modules` from being uploaded.
2. In Render, choose **New → Blueprint**, connect that GitHub repository, and deploy the included `render.yaml`. Alternatively create a **Web Service**, choose Node, set build command to `npm install`, and start command to `npm start`.
3. In the Render service **Environment** settings, add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Get each from the Supabase project. Add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` to enable upcoming-rent notifications. Add SMS gateway variables only after the SIM gateway has been securely configured. Never add real keys to the repository.
4. Wait for the Render deployment to succeed, then open `https://YOUR-SERVICE.onrender.com/api/health`. It should return `{"status":"ok"}`. Open the site and sign in with the admin account.
5. Copy the actual `https://YOUR-SERVICE.onrender.com` URL into Supabase **Authentication → URL Configuration** as the Site URL and an allowed redirect URL, save, and test adding a renter and sending a password reset.
6. To update the app after changes, push the updated project to the connected GitHub branch; Render redeploys it.

The browser is given only the Supabase anon/publishable key. The service-role key is used only by the Render server to verify administrator actions and manage renter authentication accounts.

## SIM SMS reminders

The app sends a fixed-format payment reminder to the SIM gateway endpoint configured as `SMS_GATEWAY_URL`, with `SMS_GATEWAY_TOKEN` sent as a bearer token. The gateway must accept an HTTPS JSON `POST` body of `{ "to": "+63...", "message": "..." }` and return a 2xx response only after the SMS has been accepted. Configure a SIM-equipped GSM modem/gateway separately. Render cannot access a SIM inserted in the administrator's PC directly.

To connect a SIM gateway:

1. Set up gateway software/hardware on the device that contains the SIM. It must expose an authenticated HTTPS API reachable by Render; a private LAN-only address such as `192.168.x.x` will not work from Render.
2. Configure that gateway to accept `{ "to": "+63...", "message": "..." }` requests, using bearer-token authentication, and return a 2xx response only after accepting a message for delivery.
3. In Render's service **Environment** settings, set `SMS_GATEWAY_URL` to the gateway's HTTPS send-message endpoint and `SMS_GATEWAY_TOKEN` to a strong gateway token. Never add the token to browser code or GitHub.
4. Redeploy/restart the Render service. In the admin **Payments** page, use **Send SMS** on a renter's outstanding charge. The server verifies the signed Supabase session and administrator role before forwarding the reminder.

If the SIM device is on a home network, use a secure VPN/tunnel or a gateway service with an authenticated public HTTPS endpoint; do not expose an unauthenticated modem or router port to the internet. Availability, costs, and permitted SMS usage depend on the SIM carrier and gateway provider.

## Rental and billing behavior

- Contracts support 6 or 12 months. The end date is calculated from the selected start date and term.
- The administrator enters the electricity provider's current bill and total kWh. When calculating a utility charge, the app saves the visible utility rates first and calculates the provider rate as `provider bill ÷ provider kWh`.
- The administrator enters the water bill amount directly in PHP; the app does not calculate water from meter readings or a per-unit rate.
- Electricity usage is the higher meter reading minus the lower meter reading, so the smaller reading is always subtracted and the usage cannot be negative. The electricity charge is `usage × provider rate`. Charges are rounded to centavos.
- Each calculation stores the entered water amount, provider bill, provider kWh, calculated electricity rate, electricity meter readings and usage as a permanent utility-bill record. The matching payment and utility record are created together, so a failed save cannot leave only one of them behind.
- Payments are created by an administrator for each billing period. Renters can upload an image or PDF receipt; the administrator reviews it and confirms the payment with the payment method and recipient. Online payment confirmation requires an uploaded proof image or PDF. Confirmed payments generate a renter-facing printable receipt with the amount received, including any late fee collected.
- Late fees are calculated as `days past due after grace period × fee per late day` and shown on unpaid balances; they are not silently added to the original charge amount.
- Contracts ending within 30 days appear in the administrator dashboard.

## Before using with real tenants

Configure Supabase Auth email delivery, rotate all credentials, set production redirect URLs, verify the locally applicable rates/late-fee policy, and test invitation, receipt upload, payment review, and the SIM gateway end-to-end. The example fee policy (PHP 50/day after 3 grace days) is editable and is not legal or financial advice.
