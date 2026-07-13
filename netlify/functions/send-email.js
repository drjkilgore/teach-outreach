// netlify/functions/send-email.js
// Authenticated transactional-email proxy for #TEACH Compliance Outreach.
//
// The SendGrid API key NEVER reaches the browser. The browser sends the
// user's Supabase access token; this function validates it, confirms the
// user has a send-capable role, renders each candidate's merge fields
// server-side, sends via SendGrid, and writes email_events rows.
//
// Env vars (Netlify → Site settings → Environment variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SENDGRID_API_KEY
//
// Request body:
//   { campaignId, mode: 'test'|'one'|'group'|'all', candidateIds?: [], testTo?, accessToken }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;

const SSN_RE = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/;

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`);
  return data;
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = String(d).split('-');
  return `${m}/${day}/${y}`;
}

function render(tpl, c, campaign) {
  const map = {
    first_name: c.first_name || '',
    last_name: c.last_name || '',
    full_name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
    date_of_birth: fmtDate(c.date_of_birth),
    student_id: c.student_id || '',
    response_deadline: fmtDate(campaign.response_deadline),
    secure_form_url: campaign.secure_form_url || '',
    advisor_name: c.advisor_name || '',
    program_name: c.program || campaign.program_state || '',
    sender_name: campaign.sender_name || '',
  };
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(map, k) ? map[k] : `{{${k}}}`);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY || !SENDGRID_KEY)
    return json(500, { error: 'Server not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Bad JSON' }); }

  const { campaignId, mode, candidateIds = [], testTo, accessToken } = body;
  if (!accessToken) return json(401, { error: 'Missing session' });

  // 1) validate the caller's Supabase session
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!userRes.ok) return json(401, { error: 'Invalid session' });
  const user = await userRes.json();

  // 2) confirm role can send
  const profiles = await sb(`profiles?id=eq.${user.id}&select=role,is_active,email`);
  const me = profiles[0];
  if (!me || !me.is_active || !['super_admin', 'program_admin'].includes(me.role))
    return json(403, { error: 'Your role cannot send email' });

  // 3) load campaign
  const camp = (await sb(`campaigns?id=eq.${campaignId}&select=*`))[0];
  if (!camp) return json(404, { error: 'Campaign not found' });
  if (!camp.email_template || !camp.email_subject)
    return json(400, { error: 'Campaign is missing subject or template' });

  // 4) build recipient set
  let recipients = [];
  if (mode === 'test') {
    if (!testTo) return json(400, { error: 'Test recipient required' });
    recipients = [{
      id: 'test', first_name: 'Preview', last_name: 'Test',
      email: testTo, student_id: '000000', date_of_birth: '1990-01-01',
    }];
  } else {
    let q = `candidates?campaign_id=eq.${campaignId}&excluded=eq.false&select=*`;
    if (mode === 'one' || mode === 'group') {
      if (!candidateIds.length) return json(400, { error: 'No candidates selected' });
      q += `&id=in.(${candidateIds.join(',')})`;
    } else if (mode === 'all') {
      q += `&status=in.(pending,queued,sent,delivered,bounced,failed)`;
    } else {
      return json(400, { error: 'Unknown mode' });
    }
    recipients = await sb(q);
  }
  if (!recipients.length) return json(400, { error: 'No eligible recipients' });

  const results = { sent: 0, failed: 0, skipped: 0, errors: [] };
  const rate = Math.max(1, camp.rate_per_minute || 30);
  const gap = Math.ceil(60000 / rate);

  for (const c of recipients) {
    const to = c.email || c.teach_email || c.personal_email;
    if (!to) { results.skipped++; continue; }

    let html = render(camp.email_template, c, camp);
    let subject = render(camp.email_subject, c, camp);

    // never send with unresolved merge fields or an SSN-shaped string
    if (/\{\{\s*\w+\s*\}\}/.test(html) || /\{\{\s*\w+\s*\}\}/.test(subject)) {
      results.failed++; results.errors.push(`${to}: unresolved merge field`); continue;
    }
    if (SSN_RE.test(html)) {
      results.failed++; results.errors.push(`${to}: blocked (SSN-shaped content)`); continue;
    }

    try {
      const sg = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SENDGRID_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: camp.sender_email, name: camp.sender_name },
          reply_to: camp.reply_to_email ? { email: camp.reply_to_email } : undefined,
          subject,
          content: [{ type: 'text/html', value: html }],
          categories: ['compliance', 'transactional', 'teach-outreach'],
          custom_args: { campaign_id: campaignId, candidate_id: c.id },
          tracking_settings: {
            click_tracking: { enable: true },
            open_tracking: { enable: true },
          },
        }),
      });

      if (!sg.ok) {
        const errText = await sg.text();
        results.failed++; results.errors.push(`${to}: ${sg.status}`);
        if (mode !== 'test') {
          await sb('email_events', { method: 'POST', body: JSON.stringify({
            candidate_id: c.id, campaign_id: campaignId, event_type: 'dropped',
            detail: { status: sg.status, error: errText.slice(0, 300) } }) });
        }
        continue;
      }

      const msgId = sg.headers.get('x-message-id') || null;
      results.sent++;

      if (mode !== 'test') {
        await sb('email_events', { method: 'POST', body: JSON.stringify({
          candidate_id: c.id, campaign_id: campaignId, event_type: 'sent',
          stage: (c.followup_stage || 0) + 1, provider_id: msgId }) });
        await sb(`candidates?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({
          status: 'sent',
          last_action: `Emailed ${new Date().toISOString()}`,
          followup_stage: (c.followup_stage || 0) + 1,
        }) });
      }
    } catch (e) {
      results.failed++; results.errors.push(`${to}: ${e.message}`);
    }
    if (recipients.length > 1) await new Promise(r => setTimeout(r, gap));
  }

  // audit the batch under the acting user
  await sb('audit_log', { method: 'POST', body: JSON.stringify({
    actor_id: user.id, actor_email: me.email, action: 'send',
    target: campaignId,
    meta: { mode, sent: results.sent, failed: results.failed, skipped: results.skipped },
  }) });

  return json(200, results);
};
