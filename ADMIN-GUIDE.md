# Administrator Guide — #TEACH Compliance Outreach

A practical walkthrough for staff running a campaign. Nothing here asks for or handles a Social
Security number — candidates provide that only through the secure form.

## Signing in
Go to your Netlify site URL and sign in with the email/password a Super Administrator created for you.
Your role is shown next to your name in the top bar:
- **Super Administrator** — everything, plus user management.
- **Program Administrator** — create campaigns, upload, send, track, export.
- **Reviewer** — view records and add notes; cannot send or export.
- **Read-Only** — view dashboards and status only.

## 1. Create a campaign
**Campaigns → New campaign.** It opens pre-filled for the North Carolina demographic update, including
the default email and the secure Cognito form URL. Set:
- the **response deadline**,
- a **sender email** that is verified in SendGrid (deliverability depends on this),
- the **follow-up schedule** (hours between reminders, e.g. `48, 72, 24`).

Edit the email in the template box; click a merge-field chip to insert it. Save.

## 2. Upload candidates
Open the campaign, then **Upload candidates**. Use `candidate-import-template.csv` as the starting
point. Required columns: First Name, Last Name, Email Address, Date of Birth, Student ID.

After you pick a file you get a **validation report**: rows read, valid records, issues (missing
fields, bad emails, duplicates, unreadable dates, blank rows). Fix the spreadsheet and re-upload if
needed, then **Import**. Re-importing won't duplicate anyone (matched on Student ID).

> If the file contains anything that looks like an SSN, the import is blocked entirely. Remove it and
> re-upload. SSNs belong only in the secure form.

## 3. Review candidates
**Candidates** lists everyone with DOB and Student ID masked. Click **View** to open a record:
- **Record** tab — full details (admins only), notes, and actions.
- **Email preview** tab — exactly what this person will receive.
- **History** tab — every send/delivery/bounce for them.

From a record you can **edit**, **exclude/include**, **mark complete**, add a note, or **send now**.
Use **Copy information** to grab the four form fields if you're helping someone on a call.

## 4. Review & send
**Review & send** shows counts, delivery details, and a real sample email.
1. Send a **test** to yourself first.
2. Read the sample. Confirm the deadline and form link are right.
3. Check the confirmation box — *"I have reviewed the recipient list…"*.
4. Click **Send**. The button stays disabled until the box is checked and the campaign is complete.

Completed and excluded candidates are always skipped. Anyone with an unresolved merge field is skipped
and flagged.

To send to just some people, go to **Candidates**, open a record, and **Send email now**.

## 5. Follow-ups
**Follow-ups** shows the reminder schedule and who's queued next. Reminders send automatically each
hour and escalate in urgency while staying respectful. Marking someone complete stops their reminders.
**Pause all reminders** halts the campaign; **Resume** restarts it.

## 6. Completion (with only the form link)
You do **not** need any Cognito integration. There are two ways to record who has responded:

**Import the submissions export (main method).**
1. In Cognito Forms, open **Resident Demographic Update → Entries**.
2. Click **Export** and download the Excel (or CSV) file.
3. In this app, go to **Completion → Import submissions from Cognito Forms** and upload that file.
4. Map the columns: choose the **Student ID** column (and optionally **First name / Last name / Date of
   birth** as a fallback if the form doesn't capture Student ID). Click **Preview matches**.
5. Review the matched list, then **Mark complete**. Matched candidates are marked done and their
   reminders stop.

The importer reads only the columns you map. Any Social Security number in the export is ignored and
never stored. Do the same export/import again whenever you want to refresh completions.

**Mark by hand.** Open any candidate record and click **Mark complete** — useful for one-offs or phone
confirmations.

The **Completion** page lists everyone done and how they got there.

## 7. Dashboard, audit, export
- **Dashboard** rolls up candidates, sent, completed, outstanding, bounced, and completion rate across
  campaigns.
- **Audit log** (admins) is the immutable record of who did what and when.
- **Export CSV** (admins) produces a report with name, Student ID, email, status, and completion — no
  SSNs — and logs the export.

## Good habits
- Always send a test and read the sample before a full send.
- Keep sender authentication current in SendGrid so mail lands in inboxes.
- Deactivate accounts (Users page) when staff leave.
- Delete a finished campaign's candidates when your retention window passes; deletions are audited.
