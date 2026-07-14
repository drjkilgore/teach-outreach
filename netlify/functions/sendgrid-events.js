// netlify/functions/sendgrid-events.js
// Receives delivery events from SendGrid's Event Webhook and reflects them
// in the app: updates candidate status (delivered / bounced) and records
// every event (delivered, open, click, bounce, dropped, spamreport) so the
// dashboard and each candidate's History tab show real delivery data.
//
// Secure it with a shared secret in the URL:
//   https://YOUR-SITE/.netlify/functions/sendgrid-events?key=YOUR_SECRET
// and set SENDGRID_WEBHOOK_SECRET in Netlify env vars.
//
// We set custom_args {campaign_id, candidate_id} on every send, and SendGrid
// echoes them back on each event, so we can match events to candidates.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SENDGRID_WEBHOOK_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET       = process.env.SENDGRID_WEBHOOK_SECRET;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = (b) => ({ statusCode: 200, body: b || 'ok' });

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok && r.status !== 404) {
    const t = await r.text().catch(() => '');
    throw new Error(`Supabase ${r.status}: ${t.slice(0, 150)}`);
  }
  return r;
}

// map a SendGrid event name to our internal event_type + optional status change
function classify(ev) {
  switch (ev) {
    case 'delivered':    return { type: 'delivered', setStatus: 'delivered', from: ['sent'] };
    case 'bounce':
    case 'blocked':
    case 'dropped':      return { type: 'bounce',     setStatus: 'bounced',   from: ['sent', 'delivered'] };
    case 'open':         return { type: 'open' };
    case 'click':        return { type: 'click' };
    case 'spamreport':   return { type: 'spamreport' };
    case 'unsubscribe':
    case 'group_unsubscribe': return { type: 'unsubscribe' };
    default:             return null; // processed, deferred, etc. — ignore
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
    if (!SUPABASE_URL || !SERVICE_KEY) return { statusCode: 500, body: 'not configured' };

    const key = (event.queryStringParameters || {}).key;
    if (!SECRET || key !== SECRET) return { statusCode: 401, body: 'unauthorized' };

    let events;
    try { events = JSON.parse(event.body || '[]'); } catch { return { statusCode: 400, body: 'bad json' }; }
    if (!Array.isArray(events)) events = [events];

    let processed = 0;
    for (const e of events) {
      const info = classify(e.event);
      if (!info) continue;
      const candidateId = e.candidate_id;
      const campaignId = e.campaign_id;
      if (!candidateId || !campaignId || !UUID_RE.test(candidateId)) continue; // skip test/unknown

      // record the event
      try {
        await sb('email_events', { method: 'POST', body: JSON.stringify({
          candidate_id: candidateId, campaign_id: campaignId, event_type: info.type,
          provider_id: e.sg_message_id || null,
          detail: { email: e.email, reason: e.reason || undefined,
            ts: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : undefined },
        }) });
      } catch (_) {}

      // update status only when appropriate, and never downgrade a completed/responded candidate
      if (info.setStatus) {
        const fromFilter = `status=in.(${info.from.join(',')})`;
        try {
          await sb(`candidates?id=eq.${candidateId}&${fromFilter}`, {
            method: 'PATCH',
            body: JSON.stringify({
              status: info.setStatus,
              last_action: `${info.setStatus} ${new Date().toISOString()}`,
              // stop reminders to a bounced address
              ...(info.setStatus === 'bounced' ? { next_followup_at: null } : {}),
            }),
          });
        } catch (_) {}
      }
      processed++;
    }
    return ok(`processed ${processed}/${events.length}`);
  } catch (err) {
    // return 200 so SendGrid doesn't hammer retries on a transient issue,
    // but note the error in the body for debugging.
    return { statusCode: 200, body: `error: ${err.message}` };
  }
};
