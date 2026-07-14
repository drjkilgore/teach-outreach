// netlify/functions/send-email.js
// Authenticated transactional-email proxy for #TEACH Compliance Outreach.
//
// The SendGrid API key NEVER reaches the browser. The browser sends the
// user's Supabase access token; this function validates it, confirms the
// user has a send-capable role, renders each candidate's merge fields
// server-side, sends via SendGrid, and records the result.
//
// Large campaigns are sent in CHUNKS so no single invocation exceeds
// Netlify's function time limit. For mode 'all' the function sends up to
// `limit` still-pending candidates per call, marks each one sent/failed,
// and returns how many remain. The browser calls repeatedly until remaining
// is 0. Every processed candidate leaves the 'pending' state, so the loop
// always terminates.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SENDGRID_API_KEY
// Body: { campaignId, mode:'test'|'one'|'group'|'all', candidateIds?, testTo?, limit?, accessToken }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;

const SSN_RE = /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/;
const MERGE_LEFT = /\{\{\s*\w+\s*\}\}/;
const DEFAULT_CHUNK = 20;   // candidates processed per invocation for mode 'all'

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${String(text).slice(0, 200)}`);
  return data;
}

function fmtDate(d) { if (!d) return ''; const [y, m, day] = String(d).split('-'); return `${m}/${day}/${y}`; }

function render(tpl, c, camp) {
  const map = {
    first_name: c.first_name || '', last_name: c.last_name || '',
    full_name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
    date_of_birth: fmtDate(c.date_of_birth), student_id: c.student_id || '',
    response_deadline: fmtDate(camp.response_deadline), secure_form_url: camp.secure_form_url || '',
    advisor_name: c.advisor_name || '', program_name: c.program || camp.program_state || '',
    sender_name: camp.sender_name || '',
  };
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(map, k) ? map[k] : `{{${k}}}`);
}

// Send one candidate. Returns {ok, reason}. Writes status + event unless test.
async function sendOne(c, camp, campaignId, isTest) {
  const to = c.email || c.teach_email || c.personal_email;
  const fail = async (reason) => {
    if (!isTest) {
      try {
        await sb('email_events', { method: 'POST', body: JSON.stringify({
          candidate_id: c.id, campaign_id: campaignId, event_type: 'dropped',
          detail: { reason: String(reason).slice(0, 200) } }) });
        await sb(`candidates?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({
          status: 'failed', last_action: `Send failed: ${String(reason).slice(0, 80)}` }) });
      } catch (_) {}
    }
    return { ok: false, reason };
  };

  if (!to) return fail('no email address');
  const html = render(camp.email_template, c, camp);
  const subject = render(camp.email_subject, c, camp);
  if (MERGE_LEFT.test(html) || MERGE_LEFT.test(subject)) return fail('unresolved merge field');
  if (SSN_RE.test(html)) return fail('blocked (SSN-shaped content)');

  let sg;
  try {
    sg = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: camp.sender_email, name: camp.sender_name },
        reply_to: camp.reply_to_email ? { email: camp.reply_to_email } : undefined,
        subject, content: [{ type: 'text/html', value: html }],
        categories: ['compliance', 'transactional', 'teach-outreach'],
        custom_args: { campaign_id: campaignId, candidate_id: String(c.id) },
        tracking_settings: { click_tracking: { enable: true }, open_tracking: { enable: true } },
      }),
    });
  } catch (e) { return fail(`network: ${e.message}`); }

  if (!sg.ok) {
    const t = await sg.text().catch(() => '');
    return fail(`sendgrid ${sg.status}: ${t.slice(0, 120)}`);
  }

  if (!isTest) {
    const msgId = sg.headers.get('x-message-id') || null;
    try {
      await sb('email_events', { method: 'POST', body: JSON.stringify({
        candidate_id: c.id, campaign_id: campaignId, event_type: 'sent',
        stage: (c.followup_stage || 0) + 1, provider_id: msgId }) });
      await sb(`candidates?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({
        status: 'sent', last_action: `Emailed ${new Date().toISOString()}`,
        followup_stage: (c.followup_stage || 0) + 1 }) });
    } catch (_) {}
  }
  return { ok: true };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!SUPABASE_URL || !SERVICE_KEY || !SENDGRID_KEY)
      return json(500, { error: 'Server not configured (missing env vars)' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
    const { campaignId, mode, candidateIds = [], testTo, accessToken } = body;
    const limit = Math.min(Math.max(1, Number(body.limit) || DEFAULT_CHUNK), 40);
    if (!accessToken) return json(401, { error: 'Missing session' });

    // validate session
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` } });
    if (!userRes.ok) return json(401, { error: 'Invalid or expired session — sign in again' });
    const user = await userRes.json();

    // confirm role
    const me = (await sb(`profiles?id=eq.${user.id}&select=role,is_active,email`))[0];
    if (!me || !me.is_active || !['super_admin', 'program_admin'].includes(me.role))
      return json(403, { error: 'Your role cannot send email' });

    // load campaign
    const camp = (await sb(`campaigns?id=eq.${campaignId}&select=*`))[0];
    if (!camp) return json(404, { error: 'Campaign not found' });
    if (!camp.email_template || !camp.email_subject)
      return json(400, { error: 'Campaign is missing subject or template' });
    if (!camp.sender_email) return json(400, { error: 'Campaign has no sender email' });

    const isTest = mode === 'test';

    // build recipient set
    let recipients = [];
    if (isTest) {
      if (!testTo) return json(400, { error: 'Test recipient required' });
      recipients = [{ id: 'test', first_name: 'Preview', last_name: 'Test',
        email: testTo, student_id: '000000', date_of_birth: '1990-01-01' }];
    } else if (mode === 'one' || mode === 'group') {
      if (!candidateIds.length) return json(400, { error: 'No candidates selected' });
      recipients = await sb(`candidates?campaign_id=eq.${campaignId}&excluded=eq.false&id=in.(${candidateIds.join(',')})&select=*`);
    } else if (mode === 'all') {
      // only still-pending candidates, one chunk at a time
      recipients = await sb(`candidates?campaign_id=eq.${campaignId}&excluded=eq.false&status=eq.pending&select=*&order=last_name&limit=${limit}`);
    } else {
      return json(400, { error: 'Unknown mode' });
    }

    if (!recipients.length) {
      return json(200, { sent: 0, failed: 0, processed: 0, remaining: 0, errors: [] });
    }

    // send the chunk concurrently
    const outcomes = await Promise.all(recipients.map(c => sendOne(c, camp, campaignId, isTest)));
    const sent = outcomes.filter(o => o.ok).length;
    const failed = outcomes.length - sent;
    const errors = outcomes.filter(o => !o.ok).map(o => o.reason).slice(0, 10);

    // for 'all', report how many pending remain so the client can loop
    let remaining = 0;
    if (mode === 'all') {
      const rest = await sb(`candidates?campaign_id=eq.${campaignId}&excluded=eq.false&status=eq.pending&select=id`);
      remaining = Array.isArray(rest) ? rest.length : 0;
    }

    if (!isTest) {
      try {
        await sb('audit_log', { method: 'POST', body: JSON.stringify({
          actor_id: user.id, actor_email: me.email, action: 'send', target: campaignId,
          meta: { mode, sent, failed, remaining } }) });
      } catch (_) {}
    }

    return json(200, { sent, failed, processed: recipients.length, remaining, errors });
  } catch (e) {
    return json(500, { error: e.message || 'Unexpected server error' });
  }
};
