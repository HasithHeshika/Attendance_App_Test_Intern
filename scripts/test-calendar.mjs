// Test what Firestore returns for a user's attendance and leave dates
const PROJECT_ID = 'avmaster-9af18';
const FS_BASE    = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Sign in
const a = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
  {method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email: SCRIPT_EMAIL, password: SCRIPT_PASSWORD,returnSecureToken:true})});
const {idToken} = await a.json();

const EPF = process.argv[2] || 'EMPAV/00009'; // test with a known user
console.log('Testing EPF:', EPF);

// 1. Check raw attendance docs for this user in June 2026

// Credentials come from the environment, never the source tree. Run with:
//   node --env-file=.env.local scripts/test-calendar.mjs
// and set FIREBASE_SCRIPT_EMAIL / FIREBASE_SCRIPT_PASSWORD alongside the existing
// NEXT_PUBLIC_FIREBASE_* values. A committed admin password is a committed admin password
// even in a throwaway script — this repo had 'admin@gmail.com' / 'admin123' in six of them.
const API_KEY  = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const SCRIPT_EMAIL    = process.env.FIREBASE_SCRIPT_EMAIL;
const SCRIPT_PASSWORD = process.env.FIREBASE_SCRIPT_PASSWORD;
if (!API_KEY || !SCRIPT_EMAIL || !SCRIPT_PASSWORD) {
  console.error('Missing NEXT_PUBLIC_FIREBASE_API_KEY / FIREBASE_SCRIPT_EMAIL / FIREBASE_SCRIPT_PASSWORD.');
  process.exit(1);
}

const attQ = await fetch(`${FS_BASE}:runQuery`, {
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
  body: JSON.stringify({structuredQuery:{
    from:[{collectionId:'attendances'}],
    where:{compositeFilter:{op:'AND',filters:[
      {fieldFilter:{field:{fieldPath:'epf_number'},op:'EQUAL',value:{stringValue:EPF}}},
      {fieldFilter:{field:{fieldPath:'date'},op:'GREATER_THAN_OR_EQUAL',value:{stringValue:'2026-06-01'}}},
      {fieldFilter:{field:{fieldPath:'date'},op:'LESS_THAN_OR_EQUAL',value:{stringValue:'2026-06-30'}}},
    ]}},
    limit:10
  }})
});
const attRows = await attQ.json();
console.log('\n── Attendance docs (June 2026) ──────────────────');
for (const row of attRows) {
  if (!row.document) { console.log('  (no more results)'); break; }
  const f = row.document.fields;
  console.log(`  date: ${f.date?.stringValue}  check_in: ${f.check_in ? 'SET' : 'NULL'}  epf: ${f.epf_number?.stringValue}`);
}

// 2. Check leave docs
const leaveQ = await fetch(`${FS_BASE}:runQuery`, {
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
  body: JSON.stringify({structuredQuery:{
    from:[{collectionId:'leaves'}],
    where:{compositeFilter:{op:'AND',filters:[
      {fieldFilter:{field:{fieldPath:'epf_number'},op:'EQUAL',value:{stringValue:EPF}}},
      {fieldFilter:{field:{fieldPath:'from_date'},op:'GREATER_THAN_OR_EQUAL',value:{stringValue:'2026-06-01'}}},
    ]}},
    limit:5
  }})
});
const leaveRows = await leaveQ.json();
console.log('\n── Leave docs ───────────────────────────────────');
for (const row of leaveRows) {
  if (!row.document) { console.log('  (none)'); break; }
  const f = row.document.fields;
  console.log(`  from: ${f.from_date?.stringValue}  to: ${f.to_date?.stringValue}  status: ${f.status?.stringValue}`);
}

// 3. Check what fields are on the attendance doc
if (attRows[0]?.document) {
  console.log('\n── First attendance doc fields ──────────────────');
  const f = attRows[0].document.fields;
  for (const [k,v] of Object.entries(f)) {
    const val = v.stringValue ?? v.timestampValue ?? v.booleanValue ?? v.integerValue ?? '(other)';
    console.log(`  ${k}: ${val}`);
  }
}
