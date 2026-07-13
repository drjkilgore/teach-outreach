# Security & Privacy — #TEACH Compliance Outreach

## The one rule that shapes everything
The application **never collects, displays, transmits, or stores Social Security numbers.** SSNs are
gathered only through the existing secure Cognito form. This app does outreach, personalization,
delivery tracking, and follow-up — nothing more.

### How the no-SSN rule is enforced (defense in depth)
1. **No input path.** There is no SSN field anywhere in the UI or schema.
2. **Upload guard.** Before any import, every cell and column header is scanned. An SSN-shaped value
   (`###-##-####`, `#########`, `### ## ####`) or an "SSN"/"Social Security" header **blocks the whole
   file** with a warning. Nothing is stored.
3. **Notes guard.** The template editor and the reviewer-note path reject SSN-shaped text, and a
   database trigger (`block_ssn_in_notes`) rejects it again at write time.
4. **Send guard.** The send function refuses any message whose rendered body contains an SSN-shaped
   string.
5. **Completion guard.** The Cognito webhook reads only Student ID + timestamp; it ignores everything
   else in the payload, including the SSN.

## Access control
- **Supabase Auth** for authentication; sessions auto-refresh and persist per browser.
- **Four roles** in `profiles.role`: `super_admin`, `program_admin`, `reviewer`, `read_only`.
- **Row Level Security** on every table. Reads require an authenticated user; writes to campaigns and
  candidates require an admin role; the audit log is admin-read only and cannot be updated or deleted.
- New sign-ups default to **read_only** — no self-service privilege escalation. Only a Super Admin can
  change roles.
- The **send function independently re-checks** the caller's session and role server-side before
  sending, so a tampered client cannot send.

## PII handling & data minimization
- Candidate records hold names, emails, DOB, Student ID, and program metadata — no SSN.
- **DOB and Student ID are masked** in all list views (`••/••/••••`, `••••56`). Full values appear only
  to admins on an individual record.
- **Exports** exclude SSNs by construction, require an admin role, and are written to the audit log.
- **Retention:** uploaded spreadsheets are parsed in the browser and never stored as files — only the
  validated rows are inserted. Set a retention policy by periodically deleting completed campaigns'
  candidates (see the admin guide); each deletion is audited.

## Transport & storage
- HTTPS/TLS everywhere (Netlify + Supabase). Encryption at rest is provided by Supabase (AWS).
- Security headers (`X-Frame-Options: DENY`, `nosniff`, `no-referrer`, restrictive `Permissions-Policy`)
  are set in `netlify.toml`.

## Secrets
- Browser holds only the Supabase **anon** key (safe; RLS-gated).
- The Supabase **service-role** key, **SendGrid** key, and **Cognito webhook secret** live only in
  Netlify environment variables and are used only inside functions. They are never sent to the client.

## Auditability
Immutable `audit_log` records who uploaded, edited, approved, sent, exported, changed status, and
logged in — with timestamps and metadata. Update/delete are blocked by database rules.

## Email classification & sender reputation
Messages are sent as **transactional/compliance** email (SendGrid categories `compliance`,
`transactional`), not marketing. Delivery is rate-limited per campaign (default 30/min) to protect
sender reputation. SPF, DKIM, and DMARC are configured at the domain level (see DEPLOYMENT.md).

## Known limitations to review with your team
- SSN detection is pattern-based; it is deliberately conservative (it may block a 9-digit ID that
  isn't an SSN). That trade-off favors safety.
- Open tracking is not proof a candidate read a message; the dashboard treats opens as indicative only.
- The app trusts staff with admin roles to handle full PII responsibly on individual records.
