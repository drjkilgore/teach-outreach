// netlify/functions/run-followups.js
// Scheduled reminder runner. Netlify invokes it on a cron (see netlify.toml).
// For every candidate whose next_followup_at is due, it sends the next
// reminder stage through SendGrid, advances the stage, and schedules the
// following one from the campaign's followup_schedule.
//
// Candidates that are completed or excluded are never contacted.
// Reuses the same render/guard logic as send-email.js.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SENDGRID_API_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const SSN_RE = /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/;

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return t ? JSON.parse(t) : null;
}
const fmtDate = d => { if (!d) return ''; const [y,m,day]=String(d).split('-'); return `${m}/${day}/${y}`; };
function render(tpl, c, camp) {
  const map = {
    first_name: c.first_name||'', last_name: c.last_name||'',
    full_name: `${c.first_name||''} ${c.last_name||''}`.trim(),
    date_of_birth: fmtDate(c.date_of_birth), student_id: c.student_id||'',
    response_deadline: fmtDate(camp.response_deadline),
    secure_form_url: camp.secure_form_url||'', advisor_name: c.advisor_name||'',
    program_name: c.program||camp.program_state||'', sender_name: camp.sender_name||'',
  };
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_,k)=> map[k] ?? `{{${k}}}`);
}

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_KEY || !SENDGRID_KEY)
    return { statusCode: 500, body: 'not configured' };

  const nowIso = new Date().toISOString();
  // process a capped batch per run so the invocation stays under the time limit;
  // subsequent hourly runs clear any remaining backlog.
  const due = await sb(
    `candidates?excluded=eq.false&status=not.in.(completed,responded)` +
    `&next_followup_at=lte.${nowIso}&select=*&order=next_followup_at&limit=40`);
  if (!due || !due.length) return { statusCode: 200, body: 'nothing due' };

  const campCache = {};
  const campFor = async (id) => {
    if (!campCache[id]) campCache[id] = (await sb(`campaigns?id=eq.${id}&select=*`))[0] || null;
    return campCache[id];
  };
  // pre-load campaigns for this batch
  await Promise.all([...new Set(due.map(c => c.campaign_id))].map(campFor));

  async function processOne(c) {
    const camp = campCache[c.campaign_id];
    if (!camp || ['paused', 'cancelled', 'completed'].includes(camp.status)) return { skip: true };
    const to = c.email || c.teach_email || c.personal_email;
    if (!to) return { skip: true };
    const schedule = Array.isArray(camp.followup_schedule) ? camp.followup_schedule : [];
    const stage = c.followup_stage || 0;
    const html = render(camp.email_template, c, camp);
    const subject = render(camp.email_subject, c, camp);
    if (/\{\{\s*\w+\s*\}\}/.test(html) || SSN_RE.test(html)) return { failed: true };
    try {
      const sg = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: camp.sender_email, name: camp.sender_name },
          reply_to: camp.reply_to_email ? { email: camp.reply_to_email } : undefined,
          subject, content: [{ type: 'text/html', value: html }],
          categories: ['compliance', 'reminder', 'teach-outreach'],
          custom_args: { campaign_id: c.campaign_id, candidate_id: String(c.id) },
        }),
      });
      if (!sg.ok) return { failed: true };
      const next = schedule[stage];
      await sb(`candidates?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({
        status: 'sent', followup_stage: stage + 1, last_action: `Reminder ${stage + 1} ${nowIso}`,
        next_followup_at: next != null ? new Date(Date.now() + Number(next) * 3600000).toISOString() : null,
      }) });
      await sb('email_events', { method: 'POST', body: JSON.stringify({
        candidate_id: c.id, campaign_id: c.campaign_id, event_type: 'sent',
        stage: stage + 1, detail: { source: 'followup' } }) });
      return { sent: true };
    } catch { return { failed: true }; }
  }

  const res = await Promise.all(due.map(processOne));
  const sent = res.filter(r => r.sent).length;
  const failed = res.filter(r => r.failed).length;
  return { statusCode: 200, body: `sent ${sent}, failed ${failed}, batch ${due.length}` };
};
