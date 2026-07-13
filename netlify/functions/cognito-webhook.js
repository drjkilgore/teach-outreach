// netlify/functions/cognito-webhook.js
// Receives a submission notification from Cognito Forms and marks the
// matching candidate complete — matching on Student ID only.
//
// It deliberately reads ONLY: student id, a submission timestamp, and an
// entry number. It never reads, logs, or stores the Social Security number,
// even if Cognito includes it in the payload.
//
// Secure the endpoint with a shared secret: configure Cognito to append
// ?key=YOUR_SECRET to the webhook URL, and set COGNITO_WEBHOOK_SECRET.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COGNITO_WEBHOOK_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET       = process.env.COGNITO_WEBHOOK_SECRET;

const json = (c, o) => ({ statusCode: c, body: JSON.stringify(o) });

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

// pull a student-id-ish value out of an arbitrary Cognito payload,
// checking a short allow-list of field names. Everything else is ignored.
function extractStudentId(p) {
  const keys = ['StudentId', 'StudentID', 'Student_ID', 'studentId', 'student_id'];
  for (const k of keys) if (p && p[k] != null && String(p[k]).trim()) return String(p[k]).trim();
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const key = (event.queryStringParameters || {}).key;
  if (!SECRET || key !== SECRET) return json(401, { error: 'Unauthorized' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Bad JSON' }); }

  const studentId = extractStudentId(payload);
  if (!studentId) return json(200, { ok: true, note: 'No student id present; ignored' });

  // minimum confirmation data only
  const entry = payload.Id || payload.Entry?.Number || null;
  const when  = payload.Entry?.DateSubmitted || new Date().toISOString();

  const matches = await sb(
    `candidates?student_id=eq.${encodeURIComponent(studentId)}&select=id,campaign_id,status`);
  if (!matches || !matches.length) return json(200, { ok: true, note: 'No candidate match' });

  for (const c of matches) {
    await sb(`candidates?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({
      status: 'completed', completed_at: when, completed_by: 'cognito-webhook',
      next_followup_at: null, last_action: 'Form submitted (Cognito)',
    }) });
    await sb('email_events', { method: 'POST', body: JSON.stringify({
      candidate_id: c.id, campaign_id: c.campaign_id, event_type: 'responded',
      detail: { source: 'cognito', entry } }) });
    await sb('audit_log', { method: 'POST', body: JSON.stringify({
      actor_email: 'cognito-webhook', action: 'status', target: c.id,
      meta: { to: 'completed', entry } }) });
  }
  return json(200, { ok: true, matched: matches.length });
};
