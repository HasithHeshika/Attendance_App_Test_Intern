// Check all user emails in Firestore and show any issues
const PROJECT_ID = 'avmaster-9af18';

// Sign in as admin
const a = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
  {method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email: SCRIPT_EMAIL, password: SCRIPT_PASSWORD,returnSecureToken:true})});
const {idToken} = await a.json();

// Fetch all users

// Credentials come from the environment, never the source tree. Run with:
//   node --env-file=.env.local scripts/check-users.mjs
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

const res  = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users?pageSize=200`,
  {headers:{Authorization:`Bearer ${idToken}`}});
const data = await res.json();
const docs = data.documents ?? [];

console.log(`Total users in Firestore: ${docs.length}\n`);
console.log('EPF'.padEnd(25) + 'EMAIL'.padEnd(45) + 'NAME');
console.log('─'.repeat(90));

const issues = [];
for (const doc of docs) {
  const f    = doc.fields ?? {};
  const epf  = f.epf_number?.stringValue ?? '?';
  const email = f.email?.stringValue ?? '';
  const name  = f.display_name?.stringValue ?? f.first_name?.stringValue ?? '';
  const uid   = f.uid?.stringValue ?? '';

  // Flag issues
  const hasSpace  = email !== email.trim();
  const hasUpper  = email !== email.toLowerCase();
  const isEmpty   = !email;

  if (hasSpace || isEmpty) {
    issues.push({ epf, email: JSON.stringify(email), name, issue: hasSpace ? 'HAS SPACES' : 'EMPTY EMAIL' });
  }

  console.log(epf.padEnd(25) + email.padEnd(45) + name + (uid ? '' : ' [NO UID]'));
}

if (issues.length) {
  console.log('\n⚠ ISSUES FOUND:');
  issues.forEach(i => console.log(`  ${i.epf} | ${i.email} | ${i.issue}`));
} else {
  console.log('\n✓ All emails look clean');
}
