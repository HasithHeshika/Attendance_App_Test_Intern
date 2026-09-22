async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// No credential defaults: an unspecified argument falls back to the environment, never to
// a literal in the file.
const email    = process.argv[2] || SCRIPT_EMAIL;
const password = process.argv[3] || SCRIPT_PASSWORD;

console.log(`\nTesting: ${email} / ${password}`);
console.log('─'.repeat(50));

// 1. Try sign in
console.log('\n1. signInWithPassword:');
const signIn = await post(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
  { email, password, returnSecureToken: true }
);
if (signIn.idToken) {
  console.log('   ✓ SUCCESS — uid:', signIn.localId);
} else {
  console.log('   ✗ FAIL —', signIn.error?.message);
}

// 2. Try create

// Credentials come from the environment, never the source tree. Run with:
//   node --env-file=.env.local scripts/test-auth.mjs
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

console.log('\n2. signUp (create):');
const create = await post(
  `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
  { email, password, returnSecureToken: false }
);
if (create.localId) {
  console.log('   ✓ Created new account — uid:', create.localId);
} else {
  console.log('   ✗ FAIL —', create.error?.message);
}

// 3. Check if account exists
console.log('\n3. lookup by email:');
const lookup = await post(
  `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${API_KEY}`,
  { identifier: email, continueUri: 'http://localhost' }
);
console.log('   signinMethods:', lookup.signinMethods ?? 'none (no account)');
console.log('   registered:', lookup.registered ?? false);
