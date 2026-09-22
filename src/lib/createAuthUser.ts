import { initializeApp, deleteApp, getApps } from 'firebase/app';
import {
  getAuth, createUserWithEmailAndPassword, sendEmailVerification, signOut,
} from 'firebase/auth';
import { generateInitialPassword } from '@/lib/initialPassword';

const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

// Every account used to be created with a shared constant ('12345678'). It is now a unique
// random password per account — see src/lib/initialPassword.ts for why. Callers that need to
// SHOW the password to the admin must generate it themselves and pass it in; the default
// here exists so a caller that does not care still never falls back to a guessable value.

/**
 * Creates a Firebase Auth account on a SECONDARY app instance so the
 * currently signed-in admin's session is never affected. Also sends a
 * verification email to the new address.
 *
 * Returns the new user's UID.
 */
export async function createAuthUser(email: string, password = generateInitialPassword()): Promise<string> {
  // Unique name so we don't collide with the primary app or a previous call
  const name = `secondary-${Date.now()}`;
  const secondaryApp = initializeApp(firebaseConfig, name);
  try {
    const secondaryAuth = getAuth(secondaryApp);
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    // Send Firebase's built-in verification email to the new address
    try { await sendEmailVerification(cred.user); } catch { /* non-fatal */ }
    const uid = cred.user.uid;
    await signOut(secondaryAuth);
    return uid;
  } finally {
    // Clean up the secondary app
    const app = getApps().find(a => a.name === name);
    if (app) await deleteApp(app);
  }
}
