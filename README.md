# Nanay Inday's Rentals

A PC-friendly rental management web app for house, room, and apartment rentals. It includes administrator and renter views, Supabase email/password authentication and database/storage, Render hosting configuration, payment and receipt tracking, contract expiry alerts, late fees, configurable local utility rates, and an optional SIM SMS gateway.

## Try it locally

Install Node.js 20 or later, then run:

```powershell
npm install
npm start
```

Open `http://localhost:3000`. Use **Admin demo** or **Renter demo** to explore the interface. Demo changes stay in this browser's local storage; demo accounts are not real authentication and should not be used for real renter data.

## Configure Supabase

1. Create a Supabase organization/project and save the database password somewhere private.
2. In the project **SQL Editor**, open a new query, paste the complete contents of [`supabase/schema.sql`](./supabase/schema.sql), and run it. This creates the tables, private receipt bucket, and row-level security policies. When updating an existing project, rerun the full schema so the `utility_bills` migration columns are applied.
3. From **Project Settings → API Keys** (or **Data API**, depending on the dashboard version), copy the project URL and publishable/anon key. Copy the **service_role/secret key** separately for the Render server only. Never put this key in `public/`, browser code, GitHub, or chat.
4. Before inviting real renters, configure Supabase **Authentication → SMTP Settings** with an email provider, then check the email template and delivery settings. Invitations and password-reset links require working email delivery.
5. In Supabase **Authentication → Users**, add the property administrator with the owner's email. The schema creates a `profiles` row when that auth user is created. In **SQL Editor**, promote only that administrator account (replace the example email):

   ```sql
   update public.profiles
   set role = 'admin'
   where id = (select id from auth.users where email = 'admin@example.com');
   ```

6. You can initially allow the eventual Render hostname in **Authentication → URL Configuration → Redirect URLs**, for example `https://YOUR-SERVICE.onrender.com/**`. After Render creates the real hostname, set the exact production Site URL and redirect URL there. Do not leave broad wildcard URLs enabled in a production project.
7. Use renter email addresses that the renters can access. Administrators add the renter from the app; Supabase emails an invitation so the renter can set a password.

The schema enables row-level security. Renters can only read their own rental, charges, and utility bills, and can submit a receipt for an unpaid charge. Administrators manage renter records, rates, bills, and payment status. Receipt files are kept in a private Storage bucket and are shown with short-lived signed links.

## Deploy to Render

1. Install Node.js 20 or later and Git on the PC if they are not already installed. Create a **private GitHub repository** and upload this project. The included `.gitignore` prevents `.env` and `node_modules` from being uploaded.
2. In Render, choose **New → Blueprint**, connect that GitHub repository, and deploy the included `render.yaml`. Alternatively create a **Web Service**, choose Node, set build command to `npm install`, and start command to `npm start`.
3. In the Render service **Environment** settings, add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Get each from the Supabase project. Add SMS gateway variables only after the SIM gateway has been securely configured. Never add real keys to the repository.
4. Wait for the Render deployment to succeed, then open `https://YOUR-SERVICE.onrender.com/api/health`. It should return `{"status":"ok"}`. Open the site, sign in with the admin account, and test with demo/non-sensitive records first.
5. Copy the actual `https://YOUR-SERVICE.onrender.com` URL into Supabase **Authentication → URL Configuration** as the Site URL and an allowed redirect URL, save, and test an invitation and password reset.
6. To update the app after changes, push the updated project to the connected GitHub branch; Render redeploys it.

The browser is given only the Supabase anon/publishable key. The service-role key is used only by the Render server to verify administrator actions and send renter invitations.

## SIM SMS reminders

The app sends a fixed-format payment reminder to the SIM gateway endpoint configured as `SMS_GATEWAY_URL`, with `SMS_GATEWAY_TOKEN` sent as a bearer token. The gateway should accept a JSON `POST` body of `{ "to": "+63...", "message": "..." }` and return a success HTTP status only when the SMS has been accepted. Configure a SIM-equipped GSM modem/gateway separately.

Render cannot reach a SIM or gateway that is only connected to a private home/local network. The gateway needs a secure, internet-reachable endpoint or a separately configured VPN/tunnel relay. Restrict access to the gateway, use HTTPS, rotate its token, and do not expose the token in the web page. In the admin Payments view, **Send SMS** sends the reminder for that outstanding charge. The server endpoint verifies the signed Supabase session and administrator role before contacting the configured gateway.

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
