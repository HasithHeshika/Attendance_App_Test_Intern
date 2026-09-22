/**
 * Lowercases all email fields in Firestore users collection
 * so getUserByEmail() always matches regardless of how the user types it.
 */

// Credentials come from the environment, never the source tree. Run with:
//   node --env-file=.env.local scripts/fix-emails.mjs
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

const PROJECT_ID = 'avmaster-9af18';
const FS_BASE    = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const a = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
  {method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email: SCRIPT_EMAIL, password: SCRIPT_PASSWORD,returnSecureToken:true})});
const {idToken} = await a.json();

const res  = await fetch(`${FS_BASE}/users?pageSize=200`, {headers:{Authorization:`Bearer ${idToken}`}});
const data = await res.json();
const docs = data.documents ?? [];

let fixed = 0;
for (const doc of docs) {
  const f     = doc.fields ?? {};
  const email = f.email?.stringValue ?? '';
  const lower = email.toLowerCase().trim();
  if (email === lower) continue; // already lowercase

  const epf = f.epf_number?.stringValue ?? doc.name.split('/').pop();
  console.log(`Fixing: ${epf} | ${email} → ${lower}`);

  await fetch(`${FS_BASE}/users/${encodeURIComponent(epf)}?updateMask.fieldPaths=email`,
    {method:'PATCH',headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
     body:JSON.stringify({fields:{email:{stringValue:lower}}})});
  fixed++;
  await new Promise(r=>setTimeout(r,100));
}
console.log(`\n✓ Fixed ${fixed} emails. ${docs.length - fixed} were already lowercase.`);
