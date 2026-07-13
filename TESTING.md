# Testing Plan — #TEACH Compliance Outreach

## Automated logic checks (no build step)
The security-critical pure logic is verifiable with Node. Run:

```bash
node tests.js
```

`tests.js` (included) checks SSN detection, email validation, date parsing (US, ISO, Excel serial),
and merge rendering / unresolved-field detection. All must pass before deploying.

## Manual acceptance checklist

### Auth & roles
- [ ] Read-only user cannot see Upload / Review / edit buttons and cannot send.
- [ ] Reviewer can add a note but cannot send or export.
- [ ] Program admin can upload, edit, send, and export.
- [ ] Only super admin sees Users; role changes take effect on next load.
- [ ] Signing out returns to the login screen; a deactivated user is denied by RLS.

### SSN protection (must all block)
- [ ] Upload a sheet with `123-45-6789` in any cell → import blocked, warning shown, nothing stored.
- [ ] Upload a sheet with a column named "SSN" → blocked.
- [ ] Try to save a template containing an SSN-shaped value → blocked in the editor.
- [ ] Add a candidate note containing `123456789` → rejected.
- [ ] Confirm there is no field anywhere to type an SSN.

### Upload & validation
- [ ] Missing First/Last/Email/DOB/Student ID rows are flagged and excluded from valid count.
- [ ] Invalid email is flagged; a row with no email of any kind is flagged.
- [ ] Duplicate Student IDs and duplicate name+DOB are flagged.
- [ ] `05/14/1991`, `1991-05-14`, and an Excel date all import correctly.
- [ ] Blank rows are skipped, not imported.
- [ ] Re-importing the same file does not create duplicate candidates (upsert on Student ID).

### Email generation & preview
- [ ] Preview shows the candidate's real name, DOB, Student ID, deadline, and form link.
- [ ] "Copy information" copies the four form fields (admin view).
- [ ] A candidate with an unresolved merge field shows a blocking warning and is skipped on send.

### Review & send
- [ ] Send button is disabled until the confirmation box is checked.
- [ ] A missing sender email / subject / form URL blocks sending with a clear message.
- [ ] Test send delivers to the entered address and does not change any candidate status.
- [ ] Send-to-one updates that candidate to "sent" and writes an email_events row.
- [ ] Full send skips completed and excluded candidates.

### Follow-ups & completion
- [ ] After an initial send, next_followup_at is set per the schedule.
- [ ] Marking a candidate complete clears reminders and stops further messages.
- [ ] The Cognito webhook (POST with a matching Student ID) marks the candidate complete.
- [ ] Importing a completion CSV matches by Student ID and updates status.
- [ ] Pausing a campaign stops the scheduled runner from sending.

### Audit & export
- [ ] Upload, edit, approve/send, export, and status changes all appear in the audit log.
- [ ] Audit rows cannot be edited or deleted.
- [ ] Export contains no SSN and is recorded in the audit log.

### Accessibility / responsive
- [ ] Keyboard focus is visible on inputs and buttons (2px sky outline).
- [ ] Contrast is legible (navy/crimson on white).
- [ ] Layout collapses cleanly on tablet width.

## Deliverability smoke test
- [ ] Domain shows authenticated in SendGrid; SPF/DKIM/DMARC present.
- [ ] A test email lands in inbox (not spam) from the branded sender.
