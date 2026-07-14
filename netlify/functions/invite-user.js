// netlify/functions/invite-user.js
// Super-admin-only: creates a login for a new staff member and sets their role,
// so admins never have to touch the Supabase dashboard to add someone.
//
// The Supabase service-role key stays server-side. The browser sends the
// caller's access token; this function confirms the caller is a Super
// Administrator before creating anything.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Body: { email, full_name, role, password?, accessToken }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ROLES = ['super_admin', 'program_admin', 'reviewer', 'read_only'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (code, obj) => ({
  statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
});

async function sbRest(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
}

function genPassword() {
  // readable temporary password: 3 groups + digits, e.g. "Teach-4821-Kf9Q"
  const a = Math.random().toString(36).slice(2, 6);
  const b = Math.floor(1000 + Math.random() * 8999);
  const c = Math.random().toString(36).slice(2, 4).toUpperCase();
  return `Teach-${b}-${a}${c}`;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'Server not configured' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
    const { email, full_name = '', role = 'read_only', accessToken } = body;
    if (!accessToken) return json(401, { error: 'Missing session' });
    if (!email || !EMAIL_RE.test(email)) return json(400, { error: 'Valid email required' });
    if (!ROLES.includes(role)) return json(400, { error: 'Invalid role' });

    // caller must be an active super_admin
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` } });
    if (!userRes.ok) return json(401, { error: 'Invalid or expired session' });
    const caller = await userRes.json();
    const me = (await sbRest(`profiles?id=eq.${caller.id}&select=role,is_active`))[0];
    if (!me || !me.is_active || me.role !== 'super_admin')
      return json(403, { error: 'Only a Super Administrator can add users' });

    const password = body.password && body.password.length >= 8 ? body.password : genPassword();

    // create the auth user (confirmed so they can sign in immediately)
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name } }),
    });
    const created = await createRes.json();
    if (!createRes.ok) {
      const msg = created.msg || created.error_description || created.error || 'Could not create user';
      return json(400, { error: /already/i.test(JSON.stringify(created)) ? 'A user with that email already exists' : msg });
    }

    // set role + name on the profile (trigger already created the row at read_only)
    try {
      await sbRest(`profiles?id=eq.${created.id}`, { method: 'PATCH',
        body: JSON.stringify({ role, full_name, email, is_active: true }) });
    } catch (_) {
      // fallback: upsert if the row wasn't there yet
      await sbRest('profiles', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ id: created.id, role, full_name, email, is_active: true }) });
    }

    // audit under the acting super admin
    try {
      await sbRest('audit_log', { method: 'POST', body: JSON.stringify({
        actor_id: caller.id, action: 'edit', target: created.id,
        meta: { invited: email, role } }) });
    } catch (_) {}

    return json(200, { ok: true, email, role, password, userId: created.id });
  } catch (e) {
    return json(500, { error: e.message || 'Unexpected error' });
  }
};
