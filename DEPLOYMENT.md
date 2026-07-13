# Deployment — #TEACH Compliance Outreach

Browser-only workflow: GitHub web UI → Netlify continuous deploy, Supabase backend,
SendGrid via a Netlify function. No CLI, no build step.

## Files in this repo
```
index.html                         the app shell (loads app.js)
app.js                             all application logic
netlify.toml                       functions dir + hourly follow-up cron + security headers
schema.sql                         run once in Supabase
candidate-import-template.csv      hand to staff for uploads
netlify/functions/send-email.js    authenticated SendGrid send proxy
netlify/functions/cognito-webhook.js  completion webhook (Student ID match, no SSN)
netlify/functions/run-followups.js scheduled reminder runner
```

## 1. Supabase (one time)
1. Open your #TEACH Supabase project → **SQL Editor → New query**.
2. Paste all of `schema.sql`, run it. It creates tables, roles, RLS, the audit log, and the SSN guards.
3. **Authentication → Providers**: keep Email enabled. Turn **off** public sign-ups if you want
   invite-only accounts (**Authentication → Sign In / Providers → "Allow new users to sign up"**).
4. Create your own user: **Authentication → Users → Add user** (email + password).
5. Elevate yourself: **SQL Editor**, run
   `update profiles set role='super_admin' where email='you@teach.org';`
6. Copy **Project URL** and **anon public key** from **Project Settings → API**.

## 2. Configure the app
In `app.js`, edit the `CONFIG` block at the top:
```js
SUPABASE_URL:      'https://vohqgmnurnkgbwpvrakp.supabase.co',  // your project URL
SUPABASE_ANON_KEY: '...anon public key...',
```
The anon key is safe in the browser — RLS enforces every rule. Never put the service-role key here.

## 3. GitHub
Create a repo and add every file above through the GitHub web UI (Add file → Upload files),
keeping the `netlify/functions/` path intact.

## 4. Netlify
1. **Add new site → Import from Git**, pick the repo. Build command: none. Publish directory: `.`
2. **Site settings → Environment variables**, add:
   - `SUPABASE_URL` — same project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase **service_role** key (Project Settings → API). Server-only.
   - `SENDGRID_API_KEY` — a SendGrid key with **Mail Send** permission
   - `COGNITO_WEBHOOK_SECRET` — any long random string
3. Deploy. The scheduled follow-up function registers automatically from `netlify.toml`.

## 5. SendGrid sender authentication (deliverability)
In SendGrid: **Settings → Sender Authentication → Authenticate Your Domain**. Add the CNAME
records it gives you to your DNS. This sets up **SPF and DKIM**; add a **DMARC** TXT record too
(`v=DMARC1; p=none; rua=mailto:dmarc@yourdomain`). Use a **From** address on the authenticated
domain in each campaign.

## 6. Cognito completion webhook (OPTIONAL — skip if you only have the form link)
You do not need this. Completion works by exporting submissions from Cognito and importing them on the
**Completion** page (matched by Student ID or name + DOB). Set this up only if you later get access to
Cognito's "post JSON to a URL" feature and want hands-off completion. If you skip it, leave
`COGNITO_WEBHOOK_SECRET` unset and ignore `cognito-webhook.js`.

If you do use it: in Cognito Forms → your form → **Submission → Post a JSON payload to a URL**, set:
```
https://YOUR-SITE.netlify.app/.netlify/functions/cognito-webhook?key=YOUR_COGNITO_WEBHOOK_SECRET
```
The function reads only the Student ID and a timestamp and marks the candidate complete. It never
reads or stores the SSN.

## Divergences from the original spec (and why)
- **Single-file HTML SPA + Supabase + Netlify functions**, not a Next.js/TypeScript monorepo — this
  matches your deploy pattern (web-UI commit, no build) and keeps the whole thing shippable today.
- **SendGrid**, not Resend — consistent with your other #TEACH apps and existing sender setup.
- **Follow-up worker** is a Netlify scheduled function (hourly cron) rather than a standalone job queue.
- **Sentry / PostHog** are optional add-ons, not wired in, to keep the client dependency-free; add a
  script tag later if you want them.
- **Automated tests**: the pure logic (SSN detection, validation, date parsing, merge) is covered by
  `TESTING.md`'s node checks; there's no framework harness because there's no build step.
