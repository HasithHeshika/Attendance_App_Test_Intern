async function tryLogin(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({email, password, returnSecureToken:true}) }
  );
  const d = await res.json();
  if (d.idToken) return `SUCCESS uid=${d.localId}`;
  return `FAIL: ${d.error?.message}`;
}

// List all Firebase Auth users

// Credentials come from the environment, never the source tree. Run with:
//   node --env-file=.env.local scripts/check-auth.mjs
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

async function listAuthUsers() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/avmaster-9af18/accounts:query?key=${API_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({}) }
  );
  const d = await res.json();
  return d;
}

console.log(`Testing ${SCRIPT_EMAIL}:`);
console.log(await tryLogin(SCRIPT_EMAIL, SCRIPT_PASSWORD));

console.log('\nListing Firebase Auth users...');
const users = await listAuthUsers();
if (users.userInfo) {
  console.log(`Found ${users.userInfo.length} auth user(s):`);
  users.userInfo.forEach(u => console.log(` - ${u.email} (uid: ${u.localId})`));
} else {
  console.log('Response:', JSON.stringify(users).slice(0,300));
}
