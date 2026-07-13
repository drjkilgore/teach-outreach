/* tests.js — runnable logic checks. Usage: node tests.js */
const SSN_RE = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MERGE_RE = /\{\{\s*(\w+)\s*\}\}/g;

function parseDate(v){
  if(v==null||v==='') return null;
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if(m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  if(/^\d{4,6}$/.test(s)){ const d=new Date(Math.round((Number(s)-25569)*86400*1000)); if(!isNaN(d)) return d.toISOString().slice(0,10); }
  return undefined;
}
function renderMerge(tpl,c){
  const map={first_name:c.first_name||'',last_name:c.last_name||'',student_id:c.student_id||''};
  return String(tpl).replace(MERGE_RE,(_,k)=> k in map?map[k]:`{{${k}}}`);
}
const unresolved = t => { const m=String(t).match(MERGE_RE); return m?[...new Set(m)]:[]; };

let pass=0, fail=0;
const eq=(name,got,exp)=>{ const ok=JSON.stringify(got)===JSON.stringify(exp);
  console.log((ok?'PASS':'FAIL'),name); ok?pass++:fail++; if(!ok)console.log('   got',got,'exp',exp); };

// SSN
eq('ssn dashed',        SSN_RE.test('123-45-6789'), true);
eq('ssn plain',         SSN_RE.test('123456789'),   true);
eq('ssn spaced',        SSN_RE.test('123 45 6789'), true);
eq('student id 6-digit', SSN_RE.test('123456'),     false);
eq('phone',             SSN_RE.test('555-0142'),    false);
eq('ssn in sentence',   SSN_RE.test('id 987654321'),true);

// email
eq('email ok',   EMAIL_RE.test('a@b.co'),   true);
eq('email bad',  EMAIL_RE.test('a@b'),      false);
eq('email space',EMAIL_RE.test('a b@c.co'), false);

// dates
eq('date us',    parseDate('05/14/1991'), '1991-05-14');
eq('date iso',   parseDate('1991-05-14'), '1991-05-14');
eq('date short', parseDate('5/4/1991'),   '1991-05-04');
eq('date bad',   parseDate('nope'),       undefined);
eq('date empty', parseDate(''),           null);

// merge
eq('merge fills', renderMerge('Hi {{first_name}} ({{student_id}})',{first_name:'Amanda',student_id:'123456'}),
   'Hi Amanda (123456)');
eq('merge unresolved', unresolved('Hi {{first_name}} {{advisor_name}}'), ['{{first_name}}','{{advisor_name}}']);
eq('merge clean', unresolved(renderMerge('Hi {{first_name}}',{first_name:'A'})), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
