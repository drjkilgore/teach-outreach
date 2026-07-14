/* =====================================================================
   #TEACH Compliance Outreach — application logic
   Single-file SPA. Talks to Supabase (auth + data) and to the Netlify
   send-email function. No SSN is ever entered, displayed, or stored here.
   ===================================================================== */

/* ---------- 1. CONFIG — paste your values, commit, deploy ----------- */
const CONFIG = {
  SUPABASE_URL:      'https://zajoueiegadxcnmfgufg.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpham91ZWllZ2FkeGNubWZndWZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5ODcxMTcsImV4cCI6MjA5OTU2MzExN30.0x0Sqxfk9bT3VbZxXnqmFy0p0AiiEEkR1YizF0Fur_A',
  SEND_FN:           '/.netlify/functions/send-email',
};

/* ---------- 2. constants -------------------------------------------- */
const SSN_RE = /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MERGE_RE = /\{\{\s*(\w+)\s*\}\}/g;
const MERGE_FIELDS = ['first_name','last_name','full_name','date_of_birth','student_id',
  'response_deadline','secure_form_url','advisor_name','program_name','sender_name'];

const ROLE_LABEL = {super_admin:'Super Administrator',program_admin:'Program Administrator',
  reviewer:'Reviewer',read_only:'Read-Only User'};
const CAN_SEND  = r => ['super_admin','program_admin'].includes(r);
const CAN_EDIT  = r => ['super_admin','program_admin'].includes(r);
const CAN_EXPORT= r => ['super_admin','program_admin'].includes(r);
const IS_SUPER  = r => r === 'super_admin';

const DEFAULT_TEMPLATE = `<p>Hi {{first_name}},</p>
<p>We are contacting you regarding a time-sensitive reporting requirement for candidates enrolled in the #TEACH North Carolina Educator Preparation Program.</p>
<p>The North Carolina Department of Public Instruction requires #TEACH to submit candidate demographic information as part of its annual program review. A Social Security number is required by NCDPI to accurately identify and match candidates within the state's reporting systems. This reporting requirement is mandatory and is not optional for candidates enrolled in the North Carolina program.</p>
<p>Our records indicate that we do not currently have the required information on file for you. Please complete the secure demographic update form by <b>{{response_deadline}}</b>:</p>
<p><a href="{{secure_form_url}}" style="display:inline-block;background:#002E5D;color:#fff;padding:11px 20px;border-radius:8px;font-weight:600;text-decoration:none">Complete the secure form</a></p>
<div style="background:#f6f9fd;border:1px solid #e2e8f2;border-radius:10px;padding:14px 16px;margin:16px 0">
  <p style="margin:0 0 8px;font-weight:700;color:#002E5D">Information to enter on the form</p>
  <p style="margin:2px 0"><b>First Name:</b> {{first_name}}</p>
  <p style="margin:2px 0"><b>Last Name:</b> {{last_name}}</p>
  <p style="margin:2px 0"><b>Date of Birth:</b> {{date_of_birth}}</p>
  <p style="margin:2px 0"><b>Student ID:</b> {{student_id}}</p>
</div>
<p>We understand that providing a Social Security number is sensitive. The form is hosted through Cognito Forms and uses an encrypted HTTPS/TLS connection while information is transmitted. Access to submitted information is limited to authorized #TEACH personnel who require it for legitimate program administration and state reporting.</p>
<p>Your information will be used only for required program administration and reporting to the North Carolina Department of Public Instruction. It will not be used for marketing purposes.</p>
<p><b>For your protection, please do not send your Social Security number by email or include it in a reply to this message.</b> It should be submitted only through the secure form above.</p>
<p>Thank you for addressing this request promptly. If you have questions or experience difficulty accessing the form, please reply to this email for assistance.</p>
<p>Best regards,</p>
<p><b>Dr. Jessie E. Kilgore, Jr.</b><br>#TEACH<br>Training Educators And Creating Hope</p>`;

const DEFAULT_SUBJECT = 'Action Required: North Carolina Program Reporting Information Needed';

/* ---------- 3. state ------------------------------------------------- */
let sb = null;
const S = {
  session:null, profile:null, view:'dashboard',
  campaigns:[], campaign:null, candidates:[], events:[], audit:[],
  filter:{status:'',advisor:'',cohort:'',q:''}, wizardStep:1, pendingImport:null,
};

/* ---------- 4. helpers ---------------------------------------------- */
const $ = id => document.getElementById(id);
window.$ = $;
const app = () => $('app');
const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => Number(n||0).toLocaleString();

function toast(msg, kind='') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(), 4200);
}

// date parsing: accept MM/DD/YYYY, YYYY-MM-DD, Excel serial → store YYYY-MM-DD
function parseDate(v){
  if(v==null||v==='') return null;
  if(v instanceof Date && !isNaN(v)) return v.toISOString().slice(0,10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if(m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  if(/^\d{4,6}$/.test(s)){ // Excel serial
    const d = new Date(Math.round((Number(s)-25569)*86400*1000));
    if(!isNaN(d)) return d.toISOString().slice(0,10);
  }
  return undefined; // signals "unparseable"
}
function fmtDate(d){ if(!d) return ''; const p=String(d).split('-'); return p.length===3?`${p[1]}/${p[2]}/${p[0]}`:d; }
function maskDate(d){ return d?'••/••/••••':'—'; }
function maskId(id){ if(!id) return '—'; const s=String(id); return s.length<=2?'••':'••••'+s.slice(-2); }

function renderMerge(tpl, c, camp){
  const map = {
    first_name:c.first_name||'', last_name:c.last_name||'',
    full_name:`${c.first_name||''} ${c.last_name||''}`.trim(),
    date_of_birth:fmtDate(c.date_of_birth), student_id:c.student_id||'',
    response_deadline:fmtDate(camp?.response_deadline), secure_form_url:camp?.secure_form_url||'',
    advisor_name:c.advisor_name||'', program_name:c.program||camp?.program_state||'',
    sender_name:camp?.sender_name||'',
  };
  return String(tpl||'').replace(MERGE_RE,(_,k)=> k in map ? map[k] : `{{${k}}}`);
}
const unresolved = txt => { const m=String(txt||'').match(MERGE_RE); return m?[...new Set(m)]:[]; };

async function audit(action, target, meta){
  try{ await sb.rpc('write_audit',{_action:action,_target:String(target||''),_meta:meta||{}}); }
  catch(e){ console.warn('audit failed',e); }
}

/* ---------- 5. boot + auth ------------------------------------------ */
async function boot(){
  if(CONFIG.SUPABASE_URL.includes('YOUR-PROJECT')){
    app().innerHTML = `<div class="center"><div class="login card">
      <div class="brand-lg">#TEACH <span class="tag">Compliance Outreach</span></div>
      <div class="banner warn" style="margin-top:18px">Set <b>SUPABASE_URL</b> and
      <b>SUPABASE_ANON_KEY</b> in <b>app.js</b> (CONFIG block) before use.</div></div></div>`;
    return;
  }
  sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY,
    {auth:{persistSession:true,autoRefreshToken:true}});
  const {data:{session}} = await sb.auth.getSession();
  S.session = session;
  sb.auth.onAuthStateChange((_e,sess)=>{ S.session=sess; if(!sess){S.profile=null;renderLogin();} });
  if(session){ await loadProfile(); await loadCampaigns(); renderApp(); }
  else renderLogin();
}

async function loadProfile(){
  const {data,error} = await sb.from('profiles').select('*').eq('id',S.session.user.id).single();
  if(error){ toast('Could not load profile','err'); return; }
  S.profile = data;
}

function renderLogin(){
  app().innerHTML = `<div class="center"><div class="login">
    <div class="brand-lg">#TEACH <span class="tag">Compliance Outreach</span></div>
    <p class="sub" style="text-align:center;margin:4px 0 20px">Authorized #TEACH staff only.</p>
    <div class="card">
      <div id="loginErr"></div>
      <div class="field"><label>Email</label><input id="li_email" type="email" autocomplete="username"></div>
      <div class="field"><label>Password</label><input id="li_pw" type="password" autocomplete="current-password"></div>
      <button class="btn" style="width:100%" onclick="doLogin()">Sign in</button>
      <p class="muted" style="font-size:12.5px;margin:14px 0 0;text-align:center">
        New accounts are created by a Super Administrator and start with read-only access.</p>
    </div></div></div>`;
  $('li_pw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
}

async function doLogin(){
  const email=$('li_email').value.trim(), password=$('li_pw').value;
  if(!email||!password) return;
  $('loginErr').innerHTML = `<div class="spin"></div>`;
  const {error} = await sb.auth.signInWithPassword({email,password});
  if(error){ $('loginErr').innerHTML=`<div class="banner err">${esc(error.message)}</div>`; return; }
  const {data:{session}} = await sb.auth.getSession();
  S.session=session; await loadProfile(); await loadCampaigns();
  await audit('login', S.profile?.email||email, {}); renderApp();
}
async function doLogout(){ await sb.auth.signOut(); location.reload(); }

/* ---------- 6. data loaders ----------------------------------------- */
async function loadCampaigns(){
  const {data} = await sb.from('campaigns').select('*').order('created_at',{ascending:false});
  S.campaigns = data||[];
  if(S.campaign){ S.campaign = S.campaigns.find(c=>c.id===S.campaign.id) || null; }
}
async function loadCandidates(campaignId){
  const {data} = await sb.from('candidates').select('*')
    .eq('campaign_id',campaignId).order('last_name');
  S.candidates = data||[]; S.candidatesFor = campaignId;
}
async function loadStats(campaignId){
  const {data} = await sb.from('campaign_stats').select('*').eq('campaign_id',campaignId).maybeSingle();
  return data||{};
}
async function loadAudit(){
  const {data} = await sb.from('audit_log').select('*').order('created_at',{ascending:false}).limit(300);
  S.audit = data||[];
}

/* ---------- 7. app shell + router ----------------------------------- */
function renderApp(){
  const r = S.profile.role;
  const nav = (view,label) => `<a href="#" class="${S.view===view?'active':''}" onclick="go('${view}');return false">${label}</a>`;
  app().innerHTML = `
  <div class="topbar">
    <div class="brand">#TEACH <span class="tag">Compliance Outreach</span></div>
    <div class="who">
      <span>${esc(S.profile.full_name||S.profile.email)}</span>
      <span class="pill sky">${ROLE_LABEL[r]}</span>
      <button class="btn-ghost btn-sm" onclick="doLogout()">Sign out</button>
    </div>
  </div>
  <div class="shell">
    <aside class="side"><nav class="nav">
      <div class="lbl">Overview</div>
      ${nav('dashboard','Dashboard')}
      ${nav('campaigns','Campaigns')}
      ${S.campaign?`<div class="lbl">${esc(S.campaign.name).slice(0,26)}</div>
        ${CAN_EDIT(r)?nav('upload','Upload candidates'):''}
        ${nav('candidates','Candidates')}
        ${CAN_SEND(r)?nav('review','Review &amp; send'):''}
        ${CAN_EDIT(r)?nav('followups','Follow-ups'):''}
        ${nav('completion','Completion')}`:''}
      <div class="lbl">Administration</div>
      ${['super_admin','program_admin'].includes(r)?nav('audit','Audit log'):''}
      ${IS_SUPER(r)?nav('users','Users'):''}
      ${nav('help','Security &amp; help')}
    </nav></aside>
    <main class="main" id="main"></main>
  </div>`;
  routeView();
}

function go(view){ S.view=view; renderApp(); }
window.go = go; window.doLogin=doLogin; window.doLogout=doLogout;

async function routeView(){
  const m = $('main'); if(!m) return renderApp();
  m.innerHTML = `<div class="spin"></div>`;
  try{
    switch(S.view){
      case 'dashboard':  await viewDashboard(); break;
      case 'campaigns':  await viewCampaigns(); break;
      case 'upload':     await viewUpload(); break;
      case 'candidates': await viewCandidates(); break;
      case 'review':     await viewReview(); break;
      case 'followups':  await viewFollowups(); break;
      case 'completion': await viewCompletion(); break;
      case 'audit':      await viewAudit(); break;
      case 'users':      await viewUsers(); break;
      case 'help':       viewHelp(); break;
      default: viewHelp();
    }
  }catch(e){ m.innerHTML=`<div class="banner err">Error: ${esc(e.message)}</div>`; console.error(e); }
}

/* ---------- 8. DASHBOARD -------------------------------------------- */
async function viewDashboard(){
  const m=$('main');
  let totals={total:0,sent:0,delivered:0,opened:0,completed:0,outstanding:0,bounced:0};
  const rows=[];
  for(const c of S.campaigns){
    const st=await loadStats(c.id);
    ['total','sent','delivered','opened','completed','outstanding','bounced'].forEach(k=>totals[k]+=Number(st[k]||0));
    rows.push({c,st});
  }
  const rate = totals.total? Math.round(100*totals.completed/totals.total):0;
  m.innerHTML=`
  <div class="page-head"><div><h1>Dashboard</h1>
    <div class="sub">Outreach across all campaigns.</div></div>
    ${CAN_EDIT(S.profile.role)?`<button class="btn" onclick="openCampaignModal()">New campaign</button>`:''}
  </div>
  <div class="stat-grid" style="margin-bottom:22px">
    <div class="stat"><div class="n">${money(totals.total)}</div><div class="k">Candidates</div></div>
    <div class="stat accent"><div class="n">${money(totals.sent)}</div><div class="k">Emails sent</div></div>
    <div class="stat good"><div class="n">${money(totals.delivered)}</div><div class="k">Delivered</div></div>
    <div class="stat"><div class="n">${money(totals.opened)}</div><div class="k">Opened</div></div>
    <div class="stat good"><div class="n">${money(totals.completed)}</div><div class="k">Completed Cognito form (upload required)</div></div>
    <div class="stat"><div class="n">${money(totals.outstanding)}</div><div class="k">Outstanding</div></div>
    <div class="stat bad"><div class="n">${money(totals.bounced)}</div><div class="k">Bounced</div></div>
    <div class="stat"><div class="n">${rate}%</div><div class="k">Completion rate</div></div>
  </div>
  <div class="card">
    <h2 style="font-size:17px;margin-bottom:14px">Campaigns</h2>
    ${rows.length?`<table><thead><tr><th>Campaign</th><th>Program</th><th>Status</th>
      <th>Candidates</th><th>Completed form</th><th>Deadline</th><th></th></tr></thead><tbody>
      ${rows.map(({c,st})=>`<tr>
        <td><b>${esc(c.name)}</b></td>
        <td>${esc(c.program_state||'—')}</td>
        <td><span class="pill ${statusPill(c.status)}">${esc(campaignLabel(c.status))}</span></td>
        <td class="mono">${money(st.total||0)}</td>
        <td class="mono">${money(st.completed||0)}</td>
        <td>${c.response_deadline?fmtDate(c.response_deadline):'—'}</td>
        <td><button class="btn-ghost btn-sm" onclick="openCampaign('${c.id}')">Open</button></td>
      </tr>`).join('')}
    </tbody></table>`:`<div class="empty"><h3>No campaigns yet</h3>
      <p>Create your first outreach campaign to get started.</p></div>`}
  </div>`;
}
function statusPill(s){return {draft:'',ready:'sky',sending:'sky',active:'ok',paused:'warn',completed:'ok',cancelled:'err'}[s]||'';}
function campaignLabel(s){return {active:'outreach sent',sending:'sending'}[s]||s;}

async function openCampaign(id){
  S.campaign = S.campaigns.find(c=>c.id===id);
  await loadCandidates(id); S.view='candidates'; renderApp();
}
window.openCampaign=openCampaign;

/* ---------- 9. CAMPAIGNS LIST --------------------------------------- */
async function viewCampaigns(){
  const m=$('main'); const canEdit=CAN_EDIT(S.profile.role);
  m.innerHTML=`
  <div class="page-head"><div><h1>Campaigns</h1>
    <div class="sub">Each campaign is one outreach effort to a defined candidate list.</div></div>
    ${canEdit?`<button class="btn" onclick="openCampaignModal()">New campaign</button>`:''}
  </div>
  ${S.campaigns.length?`<div class="grid">${S.campaigns.map(c=>`
    <div class="card row" style="justify-content:space-between">
      <div><h2 style="font-size:17px">${esc(c.name)}</h2>
        <div class="sub">${esc(c.purpose||'')}</div>
        <div class="row" style="margin-top:8px">
          <span class="pill ${statusPill(c.status)}">${esc(campaignLabel(c.status))}</span>
          <span class="pill">${esc(c.program_state||'—')}</span>
          ${c.response_deadline?`<span class="pill warn">Due ${fmtDate(c.response_deadline)}</span>`:''}
        </div></div>
      <div class="row">
        <button class="btn-ghost btn-sm" onclick="openCampaign('${c.id}')">Open</button>
        ${canEdit?`<button class="btn-ghost btn-sm" onclick="openCampaignModal('${c.id}')">Edit</button>`:''}
      </div>
    </div>`).join('')}</div>`:`<div class="card"><div class="empty"><h3>No campaigns yet</h3></div></div>`}`;
}

function openCampaignModal(id){
  const c = id? S.campaigns.find(x=>x.id===id) : {
    name:'North Carolina 2026 Candidate Demographic Update',
    program_state:'North Carolina EPP', purpose:'Collect missing demographic information for state reporting',
    reporting_agency:'North Carolina Department of Public Instruction (NCDPI)',
    secure_form_url:'https://www.cognitoforms.com/TrainingEducators1/ResidentDemographicUpdate',
    sender_name:'Dr. Jessie E. Kilgore, Jr.', sender_email:'', reply_to_email:'',
    email_subject:DEFAULT_SUBJECT, email_template:DEFAULT_TEMPLATE,
    followup_schedule:[48,72,24], rate_per_minute:30, status:'draft',
  };
  const fs = Array.isArray(c.followup_schedule)?c.followup_schedule.join(', '):'48, 72, 24';
  const modal=document.createElement('div'); modal.className='modal-bg'; modal.id='cmodal';
  modal.innerHTML=`<div class="modal wide"><div class="modal-head">
    <h2>${id?'Edit campaign':'New campaign'}</h2>
    <button class="x" onclick="closeModal('cmodal')">×</button></div>
    <div id="cmErr"></div>
    <div class="field"><label>Campaign name</label><input id="cm_name" value="${esc(c.name)}"></div>
    <div class="two">
      <div class="field"><label>State / program</label><input id="cm_prog" value="${esc(c.program_state||'')}"></div>
      <div class="field"><label>Reporting agency</label><input id="cm_agency" value="${esc(c.reporting_agency||'')}"></div>
    </div>
    <div class="field"><label>Purpose</label><input id="cm_purpose" value="${esc(c.purpose||'')}"></div>
    <div class="field"><label>Secure form URL (candidates submit SSN here — never in this app)</label>
      <input id="cm_url" value="${esc(c.secure_form_url||'')}"></div>
    <div class="three">
      <div class="field"><label>Response deadline</label><input id="cm_deadline" type="date" value="${c.response_deadline||''}"></div>
      <div class="field"><label>Send rate (emails/min)</label><input id="cm_rate" type="number" min="1" value="${c.rate_per_minute||30}"></div>
      <div class="field"><label>Follow-up schedule (hours, comma-sep)</label><input id="cm_fs" value="${esc(fs)}"></div>
    </div>
    <div class="three">
      <div class="field"><label>Sender name</label><input id="cm_sname" value="${esc(c.sender_name||'')}"></div>
      <div class="field"><label>Sender email (verified in SendGrid)</label><input id="cm_semail" value="${esc(c.sender_email||'')}"></div>
      <div class="field"><label>Reply-to email</label><input id="cm_reply" value="${esc(c.reply_to_email||'')}"></div>
    </div>
    <div class="field"><label>Email subject</label><input id="cm_subject" value="${esc(c.email_subject||'')}"></div>
    <div class="field"><label>Email template (HTML). Merge fields:</label>
      <div class="chips" style="margin-bottom:6px">${MERGE_FIELDS.map(f=>`<span class="chip" onclick="insertMerge('${f}')">{{${f}}}</span>`).join('')}</div>
      <textarea id="cm_tpl" style="min-height:200px;font-family:ui-monospace,monospace;font-size:12.5px">${esc(c.email_template||'')}</textarea>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:8px">
      <button class="btn-ghost" onclick="closeModal('cmodal')">Cancel</button>
      <button class="btn" onclick="saveCampaign('${id||''}')">Save campaign</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}
window.openCampaignModal=openCampaignModal;
function closeModal(idv){ const el=$(idv); if(el)el.remove(); }
window.closeModal=closeModal;
function insertMerge(f){ const ta=$('cm_tpl'); if(!ta)return;
  const p=ta.selectionStart; ta.value=ta.value.slice(0,p)+`{{${f}}}`+ta.value.slice(ta.selectionEnd); ta.focus(); }
window.insertMerge=insertMerge;

async function saveCampaign(id){
  const g=x=>($(x)?.value||'').trim();
  const fs=g('cm_fs').split(',').map(s=>Number(s.trim())).filter(n=>!isNaN(n));
  const payload={
    name:g('cm_name'), program_state:g('cm_prog'), reporting_agency:g('cm_agency'),
    purpose:g('cm_purpose'), secure_form_url:g('cm_url'),
    response_deadline:g('cm_deadline')||null, rate_per_minute:Number(g('cm_rate'))||30,
    followup_schedule:fs, sender_name:g('cm_sname'), sender_email:g('cm_semail'),
    reply_to_email:g('cm_reply'), email_subject:g('cm_subject'), email_template:$('cm_tpl').value,
  };
  if(!payload.name){ $('cmErr').innerHTML=`<div class="banner err">Campaign name is required.</div>`; return; }
  if(SSN_RE.test(payload.email_template)){ $('cmErr').innerHTML=`<div class="banner err">The template contains an SSN-shaped value. Remove it — SSNs must never appear in outreach.</div>`; return; }
  let res;
  if(id){ res=await sb.from('campaigns').update({...payload,updated_at:new Date().toISOString()}).eq('id',id).select().single(); }
  else{ res=await sb.from('campaigns').insert({...payload,created_by:S.session.user.id}).select().single(); }
  if(res.error){ $('cmErr').innerHTML=`<div class="banner err">${esc(res.error.message)}</div>`; return; }
  await audit(id?'edit':'create', res.data.id, {name:payload.name});
  closeModal('cmodal'); await loadCampaigns(); S.campaign=res.data;
  toast('Campaign saved','ok'); S.view='candidates'; await loadCandidates(res.data.id); renderApp();
}
window.saveCampaign=saveCampaign;

/* ---------- 10. UPLOAD + VALIDATION -------------------------------- */
const HEADER_MAP = {
  'first name':'first_name','firstname':'first_name',
  'last name':'last_name','lastname':'last_name',
  'email address':'email','email':'email',
  'date of birth':'date_of_birth','dob':'date_of_birth','birthdate':'date_of_birth',
  'student id':'student_id','studentid':'student_id','id':'student_id',
  'intern id':'student_id','internid':'student_id','intern number':'student_id',
  'personal email':'personal_email','#teach email':'teach_email','teach email':'teach_email',
  'phone number':'phone','phone':'phone','program':'program','state':'state',
  'state (program)':'state','admissioncertarea':'program','program path':'program',
  'enrollment status':'enrollment_status','candidate status':'enrollment_status','cohort':'cohort',
  'assigned advisor':'advisor_name','advisor':'advisor_name','notes':'notes',
};
const REQUIRED = ['first_name','last_name','email','date_of_birth','student_id'];

function viewUpload(){
  const m=$('main');
  if(!S.campaign){ m.innerHTML=noCampaign(); return; }
  m.innerHTML=`
  <div class="page-head"><div><h1>Upload candidates</h1>
    <div class="sub">${esc(S.campaign.name)} — Excel or CSV. Validated before anything imports.</div></div></div>
  <div class="banner info">Social Security numbers are never stored here. If a value in an <b>imported</b>
    field looks like an SSN, the whole file is blocked. Extra columns your CRM adds (e.g. an Intern ID)
    are ignored, not stored, and don't trip the check. Candidates submit SSNs only through the secure form.</div>
  <div class="card">
    <div class="field"><label>Select file (.xlsx, .xls, or .csv)</label>
      <input id="up_file" type="file" accept=".xlsx,.xls,.csv" onchange="handleFile(event)"></div>
    <p class="muted" style="font-size:13px">Required columns: First Name, Last Name, Email Address,
      Date of Birth, Student ID. Optional: Personal Email, #TEACH Email, Phone, Program, State,
      Enrollment Status, Cohort, Assigned Advisor, Notes.</p>
  </div>
  <div id="up_report" style="margin-top:16px"></div>`;
}

function handleFile(ev){
  const file=ev.target.files[0]; if(!file) return;
  const rep=$('up_report'); rep.innerHTML=`<div class="spin"></div>`;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      let rows;
      if(file.name.toLowerCase().endsWith('.csv')){
        const parsed=Papa.parse(e.target.result.toString(),{header:true,skipEmptyLines:true});
        rows=parsed.data;
      }else{
        const wb=XLSX.read(e.target.result,{type:'array',cellDates:true});
        rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
      }
      validateAndReport(rows, file.name);
    }catch(err){ rep.innerHTML=`<div class="banner err">Could not read file: ${esc(err.message)}</div>`; }
  };
  if(file.name.toLowerCase().endsWith('.csv')) reader.readAsText(file);
  else reader.readAsArrayBuffer(file);
}
window.handleFile=handleFile;

function validateAndReport(rawRows, filename){
  const rep=$('up_report');
  // --- SSN guard ---
  // Value scan runs only on columns the app actually imports (name, email, DOB,
  // Student ID, notes, etc.). Unrecognized CRM columns (e.g. a random 9-digit
  // "Intern ID") are dropped on import and never stored, so they aren't scanned.
  // A column literally named SSN / Social Security still hard-blocks regardless.
  const ssnHits=[];
  const headerHasSsn = rawRows.length && Object.keys(rawRows[0]).some(h=>/ssn|social\s*security/i.test(h));
  rawRows.forEach((r,i)=>Object.entries(r).forEach(([k,v])=>{
    const mapped = HEADER_MAP[String(k).trim().toLowerCase()];
    if(mapped && SSN_RE.test(String(v))) ssnHits.push(`Row ${i+2}, column "${k}"`);
  }));
  if(headerHasSsn || ssnHits.length){
    rep.innerHTML=`<div class="banner err"><b>Import blocked — possible SSN detected.</b><br>
      ${headerHasSsn?'A column header references an SSN. ':''}
      ${ssnHits.length?`SSN-shaped values found in an imported field: ${esc(ssnHits.slice(0,6).join('; '))}${ssnHits.length>6?` and ${ssnHits.length-6} more`:''}. `:''}
      Remove all Social Security numbers from the spreadsheet and re-upload. SSNs must be collected
      only through the secure form.</div>`;
    return;
  }

  // --- normalize rows to internal keys ---
  const mapped=[]; const issues=[];
  const seenId={}, seenPerson={};
  rawRows.forEach((r,idx)=>{
    const line=idx+2;
    // blank row?
    if(Object.values(r).every(v=>String(v).trim()==='')){ issues.push({line,type:'blank',msg:'Blank row skipped'}); return; }
    const c={};
    Object.entries(r).forEach(([h,v])=>{
      const key=HEADER_MAP[String(h).trim().toLowerCase()];
      if(!key) return;
      const val=typeof v==='string'?v.trim():v;
      if(val!==''&&val!=null) c[key]=val;          // a real value always wins
      else if(c[key]===undefined) c[key]=val;      // a blank only fills an empty slot
    });
    // dates
    if(c.date_of_birth!=null && c.date_of_birth!==''){
      const d=parseDate(c.date_of_birth);
      if(d===undefined){ issues.push({line,type:'date',msg:`Unreadable date of birth "${c.date_of_birth}"`}); c._dobBad=true; }
      else c.date_of_birth=d;
    }
    // required
    REQUIRED.forEach(f=>{ if(!c[f]&&!(f==='date_of_birth'&&c._dobBad)) issues.push({line,type:'missing',msg:`Missing ${f.replace('_',' ')}`}); });
    // email format
    if(c.email && !EMAIL_RE.test(c.email)) issues.push({line,type:'email',msg:`Invalid email "${c.email}"`});
    if(!c.email && !c.personal_email && !c.teach_email) issues.push({line,type:'noemail',msg:'No email address of any kind'});
    // dup student id
    if(c.student_id){ if(seenId[c.student_id]) issues.push({line,type:'dupid',msg:`Duplicate Student ID ${c.student_id} (also row ${seenId[c.student_id]})`}); else seenId[c.student_id]=line; }
    // dup person
    const pk=`${(c.first_name||'').toLowerCase()}|${(c.last_name||'').toLowerCase()}|${c.date_of_birth||''}`;
    if(c.first_name&&c.last_name){ if(seenPerson[pk]) issues.push({line,type:'dupperson',msg:`Possible duplicate candidate (also row ${seenPerson[pk]})`}); else seenPerson[pk]=line; }
    c._line=line; mapped.push(c);
  });

  const byType=t=>issues.filter(i=>i.type===t).length;
  const hard = issues.filter(i=>['missing','date','noemail','email'].includes(i.type));
  const validRows = mapped.filter(c=>{
    return REQUIRED.every(f=>c[f]) && !c._dobBad &&
      (!c.email || EMAIL_RE.test(c.email));
  });
  S.pendingImport = {rows:mapped, valid:validRows, filename, issues};

  rep.innerHTML=`
  <div class="card">
    <h2 style="font-size:17px;margin-bottom:12px">Validation report — ${esc(filename)}</h2>
    <div class="stat-grid" style="margin-bottom:16px">
      <div class="stat"><div class="n">${rawRows.length}</div><div class="k">Rows read</div></div>
      <div class="stat good"><div class="n">${validRows.length}</div><div class="k">Valid records</div></div>
      <div class="stat bad"><div class="n">${mapped.length-validRows.length}</div><div class="k">Need attention</div></div>
      <div class="stat"><div class="n">${byType('dupid')+byType('dupperson')}</div><div class="k">Duplicates</div></div>
    </div>
    ${issues.length?`<div class="row" style="margin-bottom:10px">
      ${byType('missing')?`<span class="pill err">${byType('missing')} missing fields</span>`:''}
      ${byType('email')?`<span class="pill err">${byType('email')} invalid emails</span>`:''}
      ${byType('date')?`<span class="pill err">${byType('date')} bad dates</span>`:''}
      ${byType('noemail')?`<span class="pill err">${byType('noemail')} no email</span>`:''}
      ${byType('dupid')?`<span class="pill warn">${byType('dupid')} dup student IDs</span>`:''}
      ${byType('dupperson')?`<span class="pill warn">${byType('dupperson')} dup candidates</span>`:''}
      ${byType('blank')?`<span class="pill">${byType('blank')} blank rows</span>`:''}
    </div>
    <div style="max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:8px">
      <table><thead><tr><th>Row</th><th>Issue</th></tr></thead><tbody>
      ${issues.map(i=>`<tr><td class="mono">${i.line}</td><td>${esc(i.msg)}</td></tr>`).join('')}
      </tbody></table></div>`:`<div class="banner ok">No issues found. All ${validRows.length} rows are ready.</div>`}
    <div class="banner ${hard.length?'warn':'info'}" style="margin-top:14px">
      ${validRows.length} valid record(s) will be imported.
      ${hard.length?`${hard.length} row(s) with hard errors will be skipped — fix and re-upload to include them.`:''}
      Duplicates by Student ID cannot be imported twice into the same campaign.</div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn-ghost" onclick="$('up_report').innerHTML=''">Discard</button>
      <button class="btn" ${validRows.length?'':'disabled'} onclick="commitImport()">Import ${validRows.length} candidate(s)</button>
    </div>
  </div>`;
}

async function commitImport(){
  if(!S.pendingImport||!S.pendingImport.valid.length) return;
  const rep=$('up_report'); rep.innerHTML=`<div class="spin"></div>`;
  const clean=S.pendingImport.valid.map(c=>({
    campaign_id:S.campaign.id, first_name:c.first_name, last_name:c.last_name,
    email:c.email||null, personal_email:c.personal_email||null, teach_email:c.teach_email||null,
    phone:c.phone||null, date_of_birth:c.date_of_birth||null, student_id:c.student_id||null,
    program:c.program||null, state:c.state||null, enrollment_status:c.enrollment_status||null,
    cohort:c.cohort||null, advisor_name:c.advisor_name||null, notes:c.notes||null, status:'pending',
  }));
  // upsert on (campaign_id, student_id) to avoid dupes
  const {error,count}=await sb.from('candidates')
    .upsert(clean,{onConflict:'campaign_id,student_id',ignoreDuplicates:true,count:'exact'});
  if(error){ rep.innerHTML=`<div class="banner err">${esc(error.message)}</div>`; return; }
  await audit('upload', S.campaign.id, {filename:S.pendingImport.filename, imported:clean.length});
  toast(`Imported ${clean.length} candidate(s)`,'ok');
  S.pendingImport=null; await loadCandidates(S.campaign.id); S.view='candidates'; renderApp();
}
window.commitImport=commitImport;

function noCampaign(){ return `<div class="card"><div class="empty"><h3>Open a campaign first</h3>
  <p>Choose a campaign from the Campaigns page, then upload candidates.</p>
  <button class="btn" style="margin-top:10px" onclick="go('campaigns')">Go to Campaigns</button></div></div>`; }

/* ---------- 11. CANDIDATES LIST ------------------------------------ */
async function viewCandidates(){
  const m=$('main'); if(!S.campaign){ m.innerHTML=noCampaign(); return; }
  if(S.candidatesFor!==S.campaign.id) await loadCandidates(S.campaign.id);
  const r=S.profile.role;
  const advisors=[...new Set(S.candidates.map(c=>c.advisor_name).filter(Boolean))];
  const cohorts=[...new Set(S.candidates.map(c=>c.cohort).filter(Boolean))];
  const f=S.filter;
  m.innerHTML=`
  <div class="page-head"><div><h1>Candidates</h1>
    <div class="sub">${esc(S.campaign.name)} — ${S.candidates.length} total.
      Dates of birth and Student IDs are masked in this list.</div></div>
    <div class="row">
      ${CAN_EDIT(r)?`<button class="btn-ghost" onclick="go('upload')">Upload more</button>`:''}
      ${CAN_EXPORT(r)?`<button class="btn-ghost" onclick="exportCandidates()">Export CSV</button>`:''}
      ${CAN_SEND(r)?`<button class="btn" onclick="go('review')">Review &amp; send</button>`:''}
    </div>
  </div>
  <div class="filters">
    <input id="cand_q" placeholder="Search name, email, ID…" value="${esc(f.q)}" oninput="filterCands()">
    <select id="cand_status" onchange="filterCands()">
      <option value="">All statuses</option>
      ${['pending','queued','sent','delivered','bounced','failed','responded','completed','excluded'].map(s=>`<option ${f.status===s?'selected':''}>${s}</option>`).join('')}
    </select>
    ${advisors.length?`<select id="cand_advisor" onchange="filterCands()"><option value="">All advisors</option>
      ${advisors.map(a=>`<option ${f.advisor===a?'selected':''}>${esc(a)}</option>`).join('')}</select>`:''}
    ${cohorts.length?`<select id="cand_cohort" onchange="filterCands()"><option value="">All cohorts</option>
      ${cohorts.map(a=>`<option ${f.cohort===a?'selected':''}>${esc(a)}</option>`).join('')}</select>`:''}
  </div>
  <div class="card" style="padding:0;overflow:hidden"><div id="candTable"></div></div>`;
  renderCandTable();
}
function filteredCands(){
  const f=S.filter;
  return S.candidates.filter(c=>{
    const st=c.excluded?'excluded':c.status;
    if(f.status && st!==f.status) return false;
    if(f.advisor && c.advisor_name!==f.advisor) return false;
    if(f.cohort && c.cohort!==f.cohort) return false;
    if(f.q){ const q=f.q.toLowerCase();
      if(!(`${c.first_name} ${c.last_name}`.toLowerCase().includes(q) ||
           (c.email||'').toLowerCase().includes(q) ||
           (c.student_id||'').includes(f.q))) return false; }
    return true;
  });
}
function renderCandTable(){
  const box=$('candTable'); if(!box) return;
  const list=filteredCands();
  box.innerHTML = list.length?`<table><thead><tr>
      <th>Name</th><th>Email</th><th>DOB</th><th>Student ID</th><th>Cohort</th><th>Status</th><th></th>
    </tr></thead><tbody>
    ${list.map(c=>`<tr>
      <td><b>${esc(c.first_name)} ${esc(c.last_name)}</b></td>
      <td class="muted">${esc(c.email||c.teach_email||c.personal_email||'—')}</td>
      <td class="mono muted">${maskDate(c.date_of_birth)}</td>
      <td class="mono muted">${maskId(c.student_id)}</td>
      <td>${esc(c.cohort||'—')}</td>
      <td><span class="pill ${candPill(c.status)}">${c.excluded?'excluded':c.status}</span></td>
      <td><button class="btn-ghost btn-sm" onclick="openCandidate('${c.id}')">View</button></td>
    </tr>`).join('')}
    </tbody></table>`:`<div class="empty"><h3>No candidates match</h3></div>`;
}
function candPill(s){return {pending:'',queued:'sky',sent:'sky',delivered:'ok',bounced:'err',failed:'err',responded:'ok',completed:'ok',excluded:''}[s]||'';}
function filterCands(){
  S.filter.q=$('cand_q')?.value||'';
  S.filter.status=$('cand_status')?.value||'';
  S.filter.advisor=$('cand_advisor')?.value||'';
  S.filter.cohort=$('cand_cohort')?.value||'';
  renderCandTable();
}
window.filterCands=filterCands;

/* ---------- 12. CANDIDATE DETAIL / PREVIEW ------------------------- */
async function openCandidate(id){
  const c=S.candidates.find(x=>x.id===id); if(!c) return;
  const r=S.profile.role, canEdit=CAN_EDIT(r), canReview=['super_admin','program_admin','reviewer'].includes(r);
  const showFull = ['super_admin','program_admin'].includes(r); // admins see full PII
  const {data:events}=await sb.from('email_events').select('*').eq('candidate_id',id).order('created_at',{ascending:false});
  const previewHtml=renderMerge(S.campaign.email_template,c,S.campaign);
  const unres=unresolved(previewHtml);
  const modal=document.createElement('div'); modal.className='modal-bg'; modal.id='candmodal';
  modal.innerHTML=`<div class="modal wide"><div class="modal-head">
    <h2>${esc(c.first_name)} ${esc(c.last_name)}</h2>
    <button class="x" onclick="closeModal('candmodal')">×</button></div>
    <div class="tabs">
      <button class="active" onclick="candTab('info',this)">Record</button>
      <button onclick="candTab('preview',this)">Email preview</button>
      <button onclick="candTab('history',this)">History</button>
    </div>
    <div id="ct_info">
      <div class="info-panel" style="margin-bottom:14px">
        <b>Information to enter on the form</b><br>
        First Name: ${esc(c.first_name)}<br>Last Name: ${esc(c.last_name)}<br>
        Date of Birth: ${showFull?esc(fmtDate(c.date_of_birth)):maskDate(c.date_of_birth)+' (admins only)'}<br>
        Student ID: ${showFull?esc(c.student_id||''):maskId(c.student_id)+' (admins only)'}
      </div>
      ${showFull?`<button class="btn-ghost btn-sm" onclick="copyInfo('${id}')">Copy information</button>`:''}
      <div class="two" style="margin-top:14px">
        <div><label>Email</label><div class="muted">${esc(c.email||'—')}</div></div>
        <div><label>Status</label><span class="pill ${candPill(c.status)}">${c.excluded?'excluded':c.status}</span></div>
        <div><label>Cohort</label><div class="muted">${esc(c.cohort||'—')}</div></div>
        <div><label>Advisor</label><div class="muted">${esc(c.advisor_name||'—')}</div></div>
        <div><label>Program</label><div class="muted">${esc(c.program||'—')}</div></div>
        <div><label>Last action</label><div class="muted">${esc(c.last_action||'—')}</div></div>
      </div>
      <div class="field" style="margin-top:14px"><label>Notes / contact log</label>
        <div class="info-panel" style="white-space:pre-wrap;min-height:40px">${esc(c.notes||'—')}</div></div>
      ${canReview?`<div class="field"><label>Add a note</label>
        <div class="row"><input id="ct_note" placeholder="Add an internal note…">
          <button class="btn-ghost" onclick="addNote('${id}')">Add</button></div></div>`:''}
      <div class="row" style="justify-content:flex-end;margin-top:10px">
        ${canEdit?`<button class="btn-ghost" onclick="editCandidate('${id}')">Edit record</button>`:''}
        ${canEdit?`<button class="btn-ghost" onclick="toggleExclude('${id}')">${c.excluded?'Include':'Exclude'}</button>`:''}
        ${canEdit&&c.status!=='completed'?`<button class="btn" onclick="markComplete('${id}')">Mark complete</button>`:''}
        ${CAN_SEND(r)&&c.email?`<button class="btn-sky" onclick="sendOne('${id}')">Send email now</button>`:''}
      </div>
    </div>
    <div id="ct_preview" class="hidden">
      ${unres.length?`<div class="banner err">Unresolved merge field(s): ${unres.join(', ')}. This candidate cannot be sent until resolved.</div>`:''}
      <div class="row" style="margin-bottom:10px"><b>Subject:</b> ${esc(renderMerge(S.campaign.email_subject,c,S.campaign))}</div>
      <div class="email-frame">${previewHtml}</div>
    </div>
    <div id="ct_history" class="hidden">
      ${events&&events.length?`<table><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead><tbody>
      ${events.map(e=>`<tr><td class="muted">${new Date(e.created_at).toLocaleString()}</td>
        <td><span class="pill ${e.event_type==='bounce'||e.event_type==='dropped'?'err':'sky'}">${esc(e.event_type)}</span></td>
        <td class="muted">${esc(JSON.stringify(e.detail||{}))}</td></tr>`).join('')}
      </tbody></table>`:`<div class="empty muted">No email activity yet.</div>`}
    </div>
  </div>`;
  document.body.appendChild(modal);
}
window.openCandidate=openCandidate;
function candTab(t,btn){ ['info','preview','history'].forEach(x=>$('ct_'+x).classList.toggle('hidden',x!==t));
  btn.parentElement.querySelectorAll('button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); }
window.candTab=candTab;

function copyInfo(id){ const c=S.candidates.find(x=>x.id===id);
  const txt=`First Name: ${c.first_name}\nLast Name: ${c.last_name}\nDate of Birth: ${fmtDate(c.date_of_birth)}\nStudent ID: ${c.student_id||''}`;
  navigator.clipboard.writeText(txt).then(()=>toast('Copied','ok')); }
window.copyInfo=copyInfo;

async function addNote(id){ const v=$('ct_note').value.trim(); if(!v) return;
  if(SSN_RE.test(v)){ toast('Note blocked — looks like an SSN','err'); return; }
  const {error}=await sb.rpc('reviewer_add_note',{_candidate:id,_note:v});
  if(error){ toast(error.message,'err'); return; }
  toast('Note added','ok'); closeModal('candmodal'); await loadCandidates(S.campaign.id); openCandidate(id); }
window.addNote=addNote;

async function toggleExclude(id){ const c=S.candidates.find(x=>x.id===id);
  const {error}=await sb.from('candidates').update({excluded:!c.excluded,status:!c.excluded?'excluded':'pending'}).eq('id',id);
  if(error){ toast(error.message,'err'); return; }
  await audit('status',id,{excluded:!c.excluded}); closeModal('candmodal');
  await loadCandidates(S.campaign.id); routeView(); }
window.toggleExclude=toggleExclude;

async function markComplete(id){
  const {error}=await sb.from('candidates').update({status:'completed',completed_at:new Date().toISOString(),
    completed_by:S.session.user.id,next_followup_at:null,last_action:'Marked complete (manual)'}).eq('id',id);
  if(error){ toast(error.message,'err'); return; }
  await audit('status',id,{to:'completed',by:'manual'}); toast('Marked complete','ok');
  closeModal('candmodal'); await loadCandidates(S.campaign.id); routeView(); }
window.markComplete=markComplete;

function editCandidate(id){ const c=S.candidates.find(x=>x.id===id);
  closeModal('candmodal');
  const modal=document.createElement('div'); modal.className='modal-bg'; modal.id='edmodal';
  const fld=(l,k,type='text')=>`<div class="field"><label>${l}</label><input id="ed_${k}" type="${type}" value="${esc(c[k]??'')}"></div>`;
  modal.innerHTML=`<div class="modal"><div class="modal-head"><h2>Edit candidate</h2>
    <button class="x" onclick="closeModal('edmodal')">×</button></div><div id="edErr"></div>
    <div class="two">${fld('First name','first_name')}${fld('Last name','last_name')}</div>
    <div class="two">${fld('Email','email')}${fld('Student ID','student_id')}</div>
    <div class="two">${fld('Date of birth','date_of_birth','date')}${fld('Cohort','cohort')}</div>
    <div class="two">${fld('Advisor','advisor_name')}${fld('Program','program')}</div>
    <div class="row" style="justify-content:flex-end"><button class="btn-ghost" onclick="closeModal('edmodal')">Cancel</button>
      <button class="btn" onclick="saveCandidate('${id}')">Save</button></div></div>`;
  document.body.appendChild(modal); }
window.editCandidate=editCandidate;

async function saveCandidate(id){
  const g=k=>$('ed_'+k).value.trim();
  const patch={first_name:g('first_name'),last_name:g('last_name'),email:g('email')||null,
    student_id:g('student_id')||null,date_of_birth:g('date_of_birth')||null,cohort:g('cohort')||null,
    advisor_name:g('advisor_name')||null,program:g('program')||null};
  const {error}=await sb.from('candidates').update(patch).eq('id',id);
  if(error){ $('edErr').innerHTML=`<div class="banner err">${esc(error.message)}</div>`; return; }
  await audit('edit',id,{fields:Object.keys(patch)}); toast('Saved','ok');
  closeModal('edmodal'); await loadCandidates(S.campaign.id); routeView(); }
window.saveCandidate=saveCandidate;

async function exportCandidates(){
  if(!CAN_EXPORT(S.profile.role)) return;
  const rows=S.candidates.map(c=>({
    Name:`${c.first_name} ${c.last_name}`, 'Student ID':c.student_id||'', Email:c.email||'',
    Status:c.status, Excluded:c.excluded?'yes':'no',
    'Completed At':c.completed_at?new Date(c.completed_at).toLocaleDateString():'',
  }));
  const csv=Papa.unparse(rows);
  const blob=new Blob([csv],{type:'text/csv'}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=`${S.campaign.name.replace(/\W+/g,'_')}_export.csv`; a.click();
  await audit('export',S.campaign.id,{rows:rows.length}); toast('Export downloaded (no SSNs, logged)','ok');
}
window.exportCandidates=exportCandidates;

/* ---------- 13. REVIEW & SEND -------------------------------------- */
async function viewReview(){
  const m=$('main'); if(!S.campaign){ m.innerHTML=noCampaign(); return; }
  if(!CAN_SEND(S.profile.role)){ m.innerHTML=`<div class="banner err">Your role cannot send email.</div>`; return; }
  await loadCandidates(S.campaign.id);
  const camp=S.campaign;
  const active=S.candidates.filter(c=>!c.excluded);
  const withEmail=active.filter(c=>c.email||c.teach_email||c.personal_email);
  const noEmail=active.length-withEmail.length;
  const notComplete=withEmail.filter(c=>c.status!=='completed');
  // unresolved-merge check across all
  const badMerge=notComplete.filter(c=>unresolved(renderMerge(camp.email_template,c,camp)).length);
  const sample=notComplete[0];
  const missingConfig=[];
  if(!camp.sender_email) missingConfig.push('sender email');
  if(!camp.secure_form_url) missingConfig.push('secure form URL');
  if(!camp.email_subject) missingConfig.push('subject');
  if(!camp.email_template) missingConfig.push('template');

  m.innerHTML=`
  <div class="page-head"><div><h1>Review &amp; send</h1>
    <div class="sub">${esc(camp.name)}</div></div></div>
  <div class="steps">
    <div class="step done"><span class="num">1</span>Campaign</div>
    <div class="step done"><span class="num">2</span>Candidates</div>
    <div class="step active"><span class="num">3</span>Review</div>
    <div class="step"><span class="num">4</span>Send</div>
  </div>
  <div class="stat-grid" style="margin-bottom:16px">
    <div class="stat"><div class="n">${active.length}</div><div class="k">Included</div></div>
    <div class="stat good"><div class="n">${withEmail.length}</div><div class="k">Have email</div></div>
    <div class="stat"><div class="n">${notComplete.length}</div><div class="k">Ready to send</div></div>
    <div class="stat bad"><div class="n">${noEmail}</div><div class="k">No email</div></div>
  </div>
  ${missingConfig.length?`<div class="banner err">Campaign is missing: ${missingConfig.join(', ')}.
    <button class="btn-sm btn-ghost" onclick="openCampaignModal('${camp.id}')">Fix campaign</button></div>`:''}
  ${badMerge.length?`<div class="banner err">${badMerge.length} candidate(s) have unresolved merge fields and will be skipped. Sending is blocked for them.</div>`:''}
  ${camp.sender_email?'':''}
  <div class="two">
    <div class="card">
      <h2 style="font-size:16px;margin-bottom:8px">Delivery details</h2>
      <div class="info-panel">
        <div><b>From:</b> ${esc(camp.sender_name)} &lt;${esc(camp.sender_email||'—')}&gt;</div>
        <div><b>Reply-to:</b> ${esc(camp.reply_to_email||camp.sender_email||'—')}</div>
        <div><b>Subject:</b> ${esc(camp.email_subject)}</div>
        <div><b>Deadline:</b> ${camp.response_deadline?fmtDate(camp.response_deadline):'—'}</div>
        <div><b>Secure form:</b> ${esc(camp.secure_form_url||'—')}</div>
        <div><b>Rate:</b> ${camp.rate_per_minute}/min · <b>Reminders:</b> ${(camp.followup_schedule||[]).join('h, ')}h</div>
        <div style="margin-top:6px"><span class="pill sky">Transactional / compliance</span></div>
      </div>
    </div>
    <div class="card">
      <h2 style="font-size:16px;margin-bottom:8px">Sample personalized email</h2>
      ${sample?`<div class="row" style="margin-bottom:6px"><b>To:</b> ${esc(sample.email||'—')}</div>
      <div class="email-frame" style="max-height:280px;overflow:auto;font-size:13px">${renderMerge(camp.email_template,sample,camp)}</div>`
      :`<div class="muted">No candidates ready to preview.</div>`}
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <h2 style="font-size:16px;margin-bottom:10px">Test before sending</h2>
    <div class="row">
      <input id="rv_test" placeholder="Send a test to this address…" style="max-width:320px">
      <button class="btn-ghost" onclick="sendTest()">Send test email</button>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <label class="checkbox" style="margin-bottom:14px">
      <input type="checkbox" id="rv_confirm">
      <span>I have reviewed the recipient list, personalization fields, secure form link,
      deadline, and email content.</span></label>
    <div class="row">
      <button class="btn" id="rv_sendall" disabled onclick="sendCampaign()">
        Send to ${notComplete.length-badMerge.length} candidate(s)</button>
      <button class="btn-ghost" onclick="go('candidates')">Send to selected instead</button>
      ${camp.status==='sending'?`<button class="btn-danger" onclick="pauseCampaign()">Pause campaign</button>`:''}
    </div>
    <p class="muted" style="font-size:12.5px;margin-top:10px">Nothing sends until you check the box.
      Completed candidates are always skipped.</p>
  </div>`;

  const cb=$('rv_confirm'), btn=$('rv_sendall');
  if(cb&&btn) cb.addEventListener('change',()=>{ btn.disabled=!cb.checked||!!missingConfig.length||!notComplete.length; });
}

async function callSend(payload){
  const {data:{session}}=await sb.auth.getSession();
  const res=await fetch(CONFIG.SEND_FN,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...payload,accessToken:session.access_token})});
  const out=await res.json();
  if(!res.ok) throw new Error(out.error||'Send failed');
  return out;
}
async function sendTest(){
  const to=$('rv_test').value.trim(); if(!EMAIL_RE.test(to)){ toast('Enter a valid test address','err'); return; }
  toast('Sending test…');
  try{ await callSend({campaignId:S.campaign.id,mode:'test',testTo:to}); toast('Test sent','ok'); }
  catch(e){ toast(e.message,'err'); }
}
window.sendTest=sendTest;

async function sendCampaign(){
  if(!$('rv_confirm').checked) return;
  const btn=$('rv_sendall'); btn.disabled=true;
  await sb.from('campaigns').update({status:'sending'}).eq('id',S.campaign.id);
  let guard=0, stopped=false;
  while(true){
    let out=null, tries=0;
    while(tries<3){
      try{ out=await callSend({campaignId:S.campaign.id,mode:'all',limit:20}); break; }
      catch(e){ tries++; if(tries>=3) break; await new Promise(r=>setTimeout(r,1500)); }
    }
    if(!out){ stopped=true; break; }               // 3 straight failures on one chunk
    btn.textContent=`Sending… ${out.remaining||0} left`;
    if(!out.processed || out.remaining===0) break;  // done
    if(++guard>1000) break;
  }
  // report the TRUE state from the database, not a running counter
  await loadCandidates(S.campaign.id);
  const sent=S.candidates.filter(c=>['sent','delivered','responded','completed'].includes(c.status)).length;
  const failed=S.candidates.filter(c=>c.status==='failed').length;
  const pending=S.candidates.filter(c=>c.status==='pending'&&!c.excluded).length;
  await scheduleReminders();
  // resolve the campaign's status: completed if everyone is done, else 'active'
  // (resting state after outreach). Guarded in case the migration hasn't run.
  try{
    const allDone = S.candidates.length>0 &&
      S.candidates.filter(c=>!c.excluded).every(c=>c.status==='completed');
    if(!stopped && !pending){
      await sb.from('campaigns').update({status: allDone?'completed':'active'}).eq('id',S.campaign.id);
    }
  }catch(_){ /* enum value not present yet — leave status as sending */ }
  await loadCampaigns();
  if(stopped||pending){
    toast(`${sent} sent so far, ${pending} still queued — click Send again to finish.`,'err');
  }else{
    toast(`Done: ${sent} sent${failed?`, ${failed} failed (use the "failed" filter)`:''}`, failed?'':'ok');
  }
  go('candidates');
}
window.sendCampaign=sendCampaign;

async function sendOne(id){
  toast('Sending…');
  try{ const out=await callSend({campaignId:S.campaign.id,mode:'one',candidateIds:[id]});
    toast(out.sent?'Email sent':'Not sent: '+((out.errors&&out.errors[0])||'unknown'), out.sent?'ok':'err');
    closeModal('candmodal'); await loadCandidates(S.campaign.id); routeView();
  }catch(e){ toast(e.message,'err'); }
}
window.sendOne=sendOne;

// set next_followup_at for candidates that have a schedule and were just contacted
async function scheduleReminders(){
  const camp=S.campaign; const sch=camp.followup_schedule||[];
  if(!sch.length) return;
  const {data:sent}=await sb.from('candidates').select('id,followup_stage')
    .eq('campaign_id',camp.id).eq('excluded',false).in('status',['sent','delivered']);
  for(const c of (sent||[])){
    const hrs=sch[0]; if(hrs==null) continue;
    await sb.from('candidates').update({
      next_followup_at:new Date(Date.now()+Number(hrs)*3600000).toISOString()
    }).eq('id',c.id).is('next_followup_at',null);
  }
}

async function pauseCampaign(){
  await sb.from('campaigns').update({status:'paused'}).eq('id',S.campaign.id);
  await audit('status',S.campaign.id,{to:'paused'}); toast('Campaign paused','ok');
  await loadCampaigns(); routeView();
}
window.pauseCampaign=pauseCampaign;

/* ---------- 14. FOLLOW-UPS ----------------------------------------- */
async function viewFollowups(){
  const m=$('main'); if(!S.campaign){ m.innerHTML=noCampaign(); return; }
  const camp=S.campaign; const sch=camp.followup_schedule||[];
  await loadCandidates(camp.id);
  const due=S.candidates.filter(c=>!c.excluded&&c.status!=='completed'&&c.next_followup_at);
  m.innerHTML=`
  <div class="page-head"><div><h1>Follow-ups</h1>
    <div class="sub">${esc(camp.name)} — reminders escalate but stay respectful. Completed candidates are never contacted.</div></div></div>
  <div class="banner info">Reminders run automatically each hour via a scheduled job. The schedule is a list of
    <b>hours between messages</b>. Example <b>48, 72, 24</b> = first reminder 48h after the initial email,
    a second 72h later, a final one 24h after that.</div>
  <div class="card">
    <h2 style="font-size:16px;margin-bottom:10px">Reminder schedule</h2>
    <div class="field"><label>Hours between messages (comma-separated)</label>
      <div class="row"><input id="fu_sch" value="${sch.join(', ')}" style="max-width:320px">
        ${CAN_EDIT(S.profile.role)?`<button class="btn" onclick="saveSchedule()">Save schedule</button>`:''}</div></div>
    <div class="row" style="margin-top:8px">
      <span class="pill">Initial email</span>
      ${sch.map((h,i)=>`<span class="pill ${i===sch.length-1?'warn':'sky'}">+${h}h ${i===sch.length-1?'final':'reminder '+(i+1)}</span>`).join('')}
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <h2 style="font-size:16px">Scheduled reminders (${due.length})</h2>
      <div class="row">
        ${camp.status==='paused'?`<button class="btn" onclick="resumeCampaign()">Resume</button>`
          :`<button class="btn-ghost" onclick="pauseCampaign()">Pause all reminders</button>`}
      </div>
    </div>
    ${due.length?`<table><thead><tr><th>Candidate</th><th>Stage</th><th>Next reminder</th><th>Status</th></tr></thead><tbody>
      ${due.sort((a,b)=>new Date(a.next_followup_at)-new Date(b.next_followup_at)).map(c=>`<tr>
        <td>${esc(c.first_name)} ${esc(c.last_name)}</td>
        <td class="mono">${c.followup_stage||0}/${sch.length}</td>
        <td class="muted">${new Date(c.next_followup_at).toLocaleString()}</td>
        <td><span class="pill ${candPill(c.status)}">${c.status}</span></td></tr>`).join('')}
    </tbody></table>`:`<div class="empty muted">No reminders scheduled. They're created after the initial send.</div>`}
  </div>`;
}
async function saveSchedule(){
  const arr=$('fu_sch').value.split(',').map(s=>Number(s.trim())).filter(n=>!isNaN(n));
  await sb.from('campaigns').update({followup_schedule:arr}).eq('id',S.campaign.id);
  await loadCampaigns(); toast('Schedule saved','ok'); routeView();
}
window.saveSchedule=saveSchedule;
async function resumeCampaign(){ await sb.from('campaigns').update({status:'sending'}).eq('id',S.campaign.id);
  await audit('status',S.campaign.id,{to:'sending'}); await loadCampaigns(); toast('Resumed','ok'); routeView(); }
window.resumeCampaign=resumeCampaign;

/* ---------- 15. COMPLETION ----------------------------------------- */
async function viewCompletion(){
  const m=$('main'); if(!S.campaign){ m.innerHTML=noCampaign(); return; }
  await loadCandidates(S.campaign.id);
  const done=S.candidates.filter(c=>c.status==='completed');
  const canEdit=CAN_EDIT(S.profile.role);
  m.innerHTML=`
  <div class="page-head"><div><h1>Completion</h1>
    <div class="sub">${esc(S.campaign.name)} — ${done.length} of ${S.candidates.length} complete.</div></div></div>
  <div class="banner info">You don't need any Cognito integration. Export your form's submissions from
    Cognito and import the file below — candidates are matched by Student ID (or by name + date of birth)
    and marked complete. The importer reads only the columns you map; Social Security numbers in the file
    are ignored and never stored. You can also mark candidates complete by hand from their record.</div>
  ${canEdit?`<div class="card">
    <h2 style="font-size:16px;margin-bottom:8px">Import submissions from Cognito Forms</h2>
    <ol class="muted" style="font-size:13px;margin:0 0 12px;padding-left:18px;line-height:1.8">
      <li>In Cognito Forms, open <b>Resident Demographic Update</b> → the <b>Entries</b> tab.</li>
      <li>Click <b>Export</b> and download the Excel (or CSV) file.</li>
      <li>Upload it here. On the next screen, tell the app which column is the Student ID (and optionally
        name / DOB for a fallback match), then preview and apply.</li>
    </ol>
    <input id="comp_file" type="file" accept=".xlsx,.xls,.csv" onchange="loadCompletionFile(event)">
    <div id="comp_report" style="margin-top:14px"></div>
  </div>`:''}
  <div class="card" style="margin-top:16px">
    <h2 style="font-size:16px;margin-bottom:10px">Completed candidates</h2>
    ${done.length?`<table><thead><tr><th>Name</th><th>Student ID</th><th>Completed</th><th>By</th></tr></thead><tbody>
      ${done.map(c=>`<tr><td>${esc(c.first_name)} ${esc(c.last_name)}</td>
        <td class="mono muted">${maskId(c.student_id)}</td>
        <td class="muted">${c.completed_at?new Date(c.completed_at).toLocaleString():'—'}</td>
        <td class="muted">${esc(c.completed_by==='cognito-webhook'?'Cognito form':(c.completed_by?'Import / staff':'—'))}</td></tr>`).join('')}
    </tbody></table>`:`<div class="empty muted">No completions recorded yet. Import a submissions export to record them.</div>`}
  </div>`;
}

function loadCompletionFile(ev){
  const file=ev.target.files[0]; if(!file) return;
  const rep=$('comp_report'); rep.innerHTML=`<div class="spin"></div>`;
  const reader=new FileReader(); const isCsv=file.name.toLowerCase().endsWith('.csv');
  reader.onload=e=>{
    try{
      let rows;
      if(isCsv){ rows=Papa.parse(e.target.result.toString(),{header:true,skipEmptyLines:true}).data; }
      else{ const wb=XLSX.read(e.target.result,{type:'array',cellDates:true});
        rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''}); }
      rows=rows.filter(r=>Object.values(r).some(v=>String(v).trim()!==''));
      if(!rows.length){ rep.innerHTML=`<div class="banner err">That file has no rows.</div>`; return; }
      S.pendingCompletion={rows, headers:Object.keys(rows[0]), filename:file.name};
      renderCompletionMap();
    }catch(err){ rep.innerHTML=`<div class="banner err">Could not read file: ${esc(err.message)}</div>`; }
  };
  if(isCsv) reader.readAsText(file); else reader.readAsArrayBuffer(file);
}
window.loadCompletionFile=loadCompletionFile;

function guessCol(headers,re){ return headers.find(h=>re.test(h))||''; }
function renderCompletionMap(){
  const {headers,rows,filename}=S.pendingCompletion;
  const opt=sel=>`<option value="">— none —</option>`+headers.map(h=>`<option ${sel===h?'selected':''}>${esc(h)}</option>`).join('');
  const gId=guessCol(headers,/student\s*(id|number|no)|^id$/i);
  const gF=guessCol(headers,/first/i), gL=guessCol(headers,/last/i), gD=guessCol(headers,/birth|dob/i);
  $('comp_report').innerHTML=`
    <div class="banner ${gId?'ok':'warn'}">Read ${rows.length} row(s) from ${esc(filename)}.
      ${gId?'':'No obvious Student ID column — map it below, or match by name + date of birth.'}</div>
    <p class="muted" style="font-size:13px;margin-bottom:8px">Only the columns you choose here are read.
      Every other column, including any SSN, is ignored.</p>
    <div class="two">
      <div class="field"><label>Student ID column (primary match)</label><select id="cm_id">${opt(gId)}</select></div>
      <div class="field"><label>Date of birth column (fallback)</label><select id="cm_dob">${opt(gD)}</select></div>
      <div class="field"><label>First name column (fallback)</label><select id="cm_first">${opt(gF)}</select></div>
      <div class="field"><label>Last name column (fallback)</label><select id="cm_last">${opt(gL)}</select></div>
    </div>
    <div class="row"><button class="btn" onclick="previewCompletion()">Preview matches</button>
      <button class="btn-ghost" onclick="$('comp_report').innerHTML='';S.pendingCompletion=null">Cancel</button></div>`;
}
window.renderCompletionMap=renderCompletionMap;

const _norm=s=>String(s||'').trim().toLowerCase();
function previewCompletion(){
  const {rows}=S.pendingCompletion;
  const idCol=$('cm_id').value, dCol=$('cm_dob').value, fCol=$('cm_first').value, lCol=$('cm_last').value;
  if(!idCol && !(fCol&&lCol)){ $('comp_report').insertAdjacentHTML('beforeend',
    `<div class="banner err" style="margin-top:10px">Choose a Student ID column, or both first and last name.</div>`); return; }
  // candidate lookup maps
  const byId={}, byNameDob={}, byName={};
  S.candidates.forEach(c=>{
    if(c.student_id) byId[String(c.student_id).trim()]=c;
    const nk=_norm(c.first_name)+'|'+_norm(c.last_name);
    byName[nk]=c; byNameDob[nk+'|'+(c.date_of_birth||'')]=c;
  });
  const matched=new Map(); let viaId=0, viaName=0, unmatched=0;
  rows.forEach(r=>{
    let c=null;
    if(idCol){ const v=String(r[idCol]??'').trim(); if(v&&byId[v]){ c=byId[v]; viaId++; } }
    if(!c && fCol && lCol){
      const nk=_norm(r[fCol])+'|'+_norm(r[lCol]);
      if(dCol){ const d=parseDate(r[dCol]); const key=nk+'|'+(d&&d!==undefined?d:''); if(byNameDob[key]){ c=byNameDob[key]; viaName++; } }
      else if(byName[nk]){ c=byName[nk]; viaName++; }
    }
    if(c) matched.set(c.id,c); else unmatched++;
  });
  S.completionMatches=[...matched.values()];
  const already=S.completionMatches.filter(c=>c.status==='completed').length;
  const willChange=S.completionMatches.length-already;
  $('comp_report').innerHTML=`
    <div class="banner ${S.completionMatches.length?'ok':'warn'}">
      Matched <b>${S.completionMatches.length}</b> candidate(s) — ${viaId} by Student ID, ${viaName} by name/DOB.
      ${unmatched} row(s) had no match. ${already?`${already} already complete.`:''}</div>
    ${S.completionMatches.length?`<div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px;margin-bottom:12px">
      <table><thead><tr><th>Name</th><th>Student ID</th><th>Current status</th></tr></thead><tbody>
      ${S.completionMatches.map(c=>`<tr><td>${esc(c.first_name)} ${esc(c.last_name)}</td>
        <td class="mono muted">${maskId(c.student_id)}</td>
        <td><span class="pill ${candPill(c.status)}">${c.status}</span></td></tr>`).join('')}
      </tbody></table></div>`:''}
    <div class="row"><button class="btn" ${willChange?'':'disabled'} onclick="applyCompletion()">
      Mark ${willChange} candidate(s) complete</button>
      <button class="btn-ghost" onclick="renderCompletionMap()">Back to mapping</button></div>`;
}
window.previewCompletion=previewCompletion;

async function applyCompletion(){
  const targets=(S.completionMatches||[]).filter(c=>c.status!=='completed');
  if(!targets.length) return;
  $('comp_report').innerHTML=`<div class="spin"></div>`;
  const ids=targets.map(c=>c.id);
  const {error}=await sb.from('candidates').update({status:'completed',
    completed_at:new Date().toISOString(),completed_by:S.session.user.id,next_followup_at:null,
    last_action:'Marked complete (submissions import)'}).in('id',ids);
  if(error){ $('comp_report').innerHTML=`<div class="banner err">${esc(error.message)}</div>`; return; }
  await audit('status',S.campaign.id,{completionImport:S.pendingCompletion?.filename,completed:ids.length});
  $('comp_report').innerHTML=`<div class="banner ok">Marked ${ids.length} candidate(s) complete. Their reminders are stopped.</div>`;
  S.pendingCompletion=null; S.completionMatches=null;
  await loadCandidates(S.campaign.id); setTimeout(routeView,1400);
}
window.applyCompletion=applyCompletion;

/* ---------- 16. AUDIT ---------------------------------------------- */
async function viewAudit(){
  const m=$('main'); await loadAudit();
  m.innerHTML=`
  <div class="page-head"><div><h1>Audit log</h1>
    <div class="sub">Immutable record of uploads, edits, sends, exports, and status changes.</div></div></div>
  <div class="card" style="padding:0;overflow:hidden">
    ${S.audit.length?`<table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>
      ${S.audit.map(a=>`<tr><td class="muted">${new Date(a.created_at).toLocaleString()}</td>
        <td>${esc(a.actor_email||'system')}</td>
        <td><span class="pill ${a.action==='send'?'sky':a.action==='export'||a.action==='delete'?'warn':''}">${esc(a.action)}</span></td>
        <td class="mono muted">${esc(String(a.target||'').slice(0,14))}</td>
        <td class="muted" style="font-size:12.5px">${esc(JSON.stringify(a.meta||{}).slice(0,80))}</td></tr>`).join('')}
    </tbody></table>`:`<div class="empty muted">No audit entries yet.</div>`}
  </div>`;
}

/* ---------- 17. USERS (super admin) -------------------------------- */
async function viewUsers(){
  const m=$('main');
  if(!IS_SUPER(S.profile.role)){ m.innerHTML=`<div class="banner err">Super Administrators only.</div>`; return; }
  const {data:users}=await sb.from('profiles').select('*').order('created_at');
  m.innerHTML=`
  <div class="page-head"><div><h1>Users</h1>
    <div class="sub">Add staff and assign roles. New users can sign in as soon as you create them.</div></div>
    <button class="btn" onclick="openInvite()">Invite user</button>
  </div>
  <div class="banner info">Invite creates the login for you — no need to open Supabase. You'll get a
    temporary password to share; the new user can sign in with it right away.</div>
  <div class="card" style="padding:0;overflow:hidden">
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th></tr></thead><tbody>
    ${(users||[]).map(u=>`<tr>
      <td>${esc(u.full_name||'—')}</td><td class="muted">${esc(u.email)}</td>
      <td><select onchange="setRole('${u.id}',this.value)" ${u.id===S.session.user.id?'disabled':''}>
        ${Object.keys(ROLE_LABEL).map(r=>`<option value="${r}" ${u.role===r?'selected':''}>${ROLE_LABEL[r]}</option>`).join('')}
      </select></td>
      <td><button class="btn-sm ${u.is_active?'btn-ghost':'btn'}" onclick="toggleActive('${u.id}',${!u.is_active})">${u.is_active?'Deactivate':'Activate'}</button></td>
    </tr>`).join('')}
    </tbody></table>
  </div>`;
}
async function setRole(id,role){ const {error}=await sb.from('profiles').update({role}).eq('id',id);
  if(error){ toast(error.message,'err'); return; } await audit('edit',id,{role}); toast('Role updated','ok'); }
window.setRole=setRole;
async function toggleActive(id,val){ const {error}=await sb.from('profiles').update({is_active:val}).eq('id',id);
  if(error){ toast(error.message,'err'); return; } await audit('edit',id,{is_active:val}); routeView(); }
window.toggleActive=toggleActive;

function openInvite(){
  const modal=document.createElement('div'); modal.className='modal-bg'; modal.id='invmodal';
  modal.innerHTML=`<div class="modal"><div class="modal-head"><h2>Invite user</h2>
    <button class="x" onclick="closeModal('invmodal')">×</button></div>
    <div id="invBody">
      <div id="invErr"></div>
      <div class="two">
        <div class="field"><label>Full name</label><input id="inv_name" placeholder="Jane Doe"></div>
        <div class="field"><label>Email</label><input id="inv_email" type="email" placeholder="jane@trainingeducators.com"></div>
      </div>
      <div class="field"><label>Role</label>
        <select id="inv_role">
          <option value="program_admin">Program Administrator — create, upload, send, track, export</option>
          <option value="reviewer">Reviewer — view &amp; add notes only</option>
          <option value="read_only">Read-Only — view dashboards only</option>
          <option value="super_admin">Super Administrator — everything, incl. managing users</option>
        </select></div>
      <div class="field"><label>Temporary password (optional — leave blank to auto-generate)</label>
        <input id="inv_pw" placeholder="Auto-generated if blank"></div>
      <div class="row" style="justify-content:flex-end;margin-top:6px">
        <button class="btn-ghost" onclick="closeModal('invmodal')">Cancel</button>
        <button class="btn" onclick="submitInvite()">Create user</button>
      </div>
    </div></div>`;
  document.body.appendChild(modal);
}
window.openInvite=openInvite;

async function submitInvite(){
  const name=$('inv_name').value.trim(), email=$('inv_email').value.trim(),
    role=$('inv_role').value, pw=$('inv_pw').value.trim();
  if(!email){ $('invErr').innerHTML=`<div class="banner err">Email is required.</div>`; return; }
  $('invErr').innerHTML=`<div class="spin"></div>`;
  try{
    const {data:{session}}=await sb.auth.getSession();
    const res=await fetch('/.netlify/functions/invite-user',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email,full_name:name,role,password:pw||undefined,accessToken:session.access_token})});
    const out=await res.json();
    if(!res.ok){ $('invErr').innerHTML=`<div class="banner err">${esc(out.error||'Failed')}</div>`; return; }
    $('invBody').innerHTML=`
      <div class="banner ok">User created. Share these sign-in details securely — this password
        won't be shown again.</div>
      <div class="info-panel">
        <div><b>Email:</b> ${esc(out.email)}</div>
        <div><b>Temporary password:</b> <span class="mono">${esc(out.password)}</span></div>
        <div><b>Role:</b> ${esc(ROLE_LABEL[out.role]||out.role)}</div>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="btn-ghost" onclick="copyInvite('${esc(out.email)}','${esc(out.password)}')">Copy details</button>
        <button class="btn" onclick="closeModal('invmodal');go('users')">Done</button>
      </div>`;
    toast('User created','ok');
  }catch(e){ $('invErr').innerHTML=`<div class="banner err">${esc(e.message)}</div>`; }
}
window.submitInvite=submitInvite;

function copyInvite(email,pw){
  navigator.clipboard.writeText(`Sign in at ${location.origin}\nEmail: ${email}\nTemporary password: ${pw}`)
    .then(()=>toast('Copied','ok'));
}
window.copyInvite=copyInvite;

/* ---------- 18. HELP ----------------------------------------------- */
function viewHelp(){
  $('main').innerHTML=`
  <div class="page-head"><div><h1>Security &amp; help</h1></div></div>
  <div class="card">
    <h2 style="font-size:17px;margin-bottom:10px">How this app protects candidate data</h2>
    <ul style="line-height:1.9;color:var(--ink)">
      <li><b>No SSNs, ever.</b> There is no field to enter one. Uploads containing an SSN-shaped value are
        blocked. Notes are checked at the database level. SSNs are collected only through the secure form.</li>
      <li><b>Role-based access.</b> Super Admin, Program Admin, Reviewer, and Read-Only. Only admins can
        send, edit, or export. Reviewers can add notes. Read-only users cannot change anything.</li>
      <li><b>Masked PII.</b> Dates of birth and Student IDs show masked in lists; full values appear only
        to admins on an individual record.</li>
      <li><b>Server-side sending.</b> The SendGrid key lives only in the Netlify function, which verifies
        your session and role before sending. It never reaches the browser.</li>
      <li><b>Immutable audit log.</b> Uploads, edits, approvals, sends, exports, and status changes are
        recorded and cannot be altered or deleted.</li>
      <li><b>Encryption.</b> HTTPS in transit; Supabase encrypts data at rest.</li>
    </ul>
    <h2 style="font-size:16px;margin:18px 0 8px">The workflow</h2>
    <ol style="line-height:1.9">
      <li>Create a campaign (defaults to the NC demographic-update template).</li>
      <li>Upload a candidate spreadsheet and clear any validation issues.</li>
      <li>Review counts, the sample email, and delivery details; send a test.</li>
      <li>Check the confirmation box and send. Reminders schedule automatically.</li>
      <li>Completions are recorded by importing your Cognito submissions export (matched by Student ID
        or name + DOB), or by marking candidates complete by hand. No Cognito integration is required.</li>
    </ol>
  </div>`;
}

/* ---------- boot ---------------------------------------------------- */
boot();
