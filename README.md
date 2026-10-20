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
2. In the project **SQL Editor**, open a new query, paste the complete contents of [`supabase/schema.sql`](./supabase/schema.sql), and run it. This creates the tables, private receipt bucket, and row-level security policies. When updating an existing project, rerun the full schema so the `utility_bills` migration columns are applied.
3. From **Project Settings → API Keys** (or **Data API**, depending on the dashboard version), copy the project URL and publishable/anon key. Copy the **service_role/secret key** separately for the Render server only. Never put this key in `public/`, browser code, GitHub, or chat.
4. Configure Supabase **Authentication → SMTP Settings** with an email provider if you want password-reset emails to work. The admin can create renter accounts by setting an initial password directly; renter passwords are stored only by Supabase Auth, never in the rental tables.
5. In Supabase **Authentication → Users**, add the property administrator with the owner's email. The schema creates a `profiles` row when that auth user is created. In **SQL Editor**, promote only that administrator account (replace the example email):

   ```sql
   update public.profiles
   set role = 'admin'
   where id = (select id from auth.users where email = 'admin@example.com');
   ```

6. You can initially allow the eventual Render hostname in **Authentication → URL Configuration → Redirect URLs**, for example `https://YOUR-SERVICE.onrender.com/**`. After Render creates the real hostname, set the exact production Site URL and redirect URL there. Do not leave broad wildcard URLs enabled in a production project.
7. Administrators add renters from the app with an initial password of at least 12 characters. From **Renters & leases**, an administrator can later change a renter's password. Share initial and changed passwords privately and ask renters to choose a new password after first sign-in.

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

## Deploy to Render

1. Install Node.js 20 or later and Git on the PC if they are not already installed. Create a **private GitHub repository** and upload this project. The included `.gitignore` prevents `.env` and `node_modules` from being uploaded.
2. In Render, choose **New → Blueprint**, connect that GitHub repository, and deploy the included `render.yaml`. Alternatively create a **Web Service**, choose Node, set build command to `npm install`, and start command to `npm start`.
3. In the Render service **Environment** settings, add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Get each from the Supabase project. Add SMS gateway variables only after the SIM gateway has been securely configured. Never add real keys to the repository.
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
- The administrator sets the water rate in PHP/m³ and enters the electricity provider's total bill and total kWh used. The app calculates the electricity price as `total bill ÷ total kWh`.
- The renter's electricity usage is `ending submeter reading − beginning submeter reading`; the electricity charge is that usage multiplied by the calculated price per kWh. The utility charge is rounded to centavos.
- A meter calculation records the provider bill and usage, both submeter readings, the rate used, the water and electricity charges, and creates a matching utility payment charge.
- Payments are created by an administrator for each billing period. Renters can upload an image or PDF receipt; the admin reviews it and marks the charge paid.
- Late fees are calculated as `days past due after grace period × fee per late day` and shown on unpaid balances; they are not silently added to the original charge amount.
- Contracts ending within 30 days appear in the administrator dashboard.

## Before using with real tenants

Configure Supabase Auth email delivery, rotate all credentials, set production redirect URLs, verify the locally applicable rates/late-fee policy, and test invitation, receipt upload, payment review, and the SIM gateway end-to-end. The example fee policy (PHP 50/day after 3 grace days) is editable and is not legal or financial advice.
