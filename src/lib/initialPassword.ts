/**
 * Generate the one-time password a new (or reset) account is created with.
 *
 * Replaces the fixed '12345678' every account used to be given. With 300+ employees, a
 * shared constant that most people never change is a single guess away from any account —
 * and /api/resolve-login turns an employee number into a sign-in identifier, so the guesser
 * does not even need to know an email address. Firebase enforces a 6-character minimum and
 * nothing else, so the strength has to come from here.
 *
 * Isomorphic on purpose: the Users page creates accounts from the browser through the client
 * SDK, while bulk import and password reset run in Node routes. `globalThis.crypto` is the
 * Web Crypto API in both, and it is a CSPRNG — Math.random() is not, and a predictable
 * initial password is barely better than a shared one.
 *
 * The alphabet omits characters that get misread when a password is dictated over the phone
 * or copied off a printed sheet: O/0, I/l/1, and the symbol set entirely. That costs a
 * little entropy per character and buys back far more by not being retyped wrongly — at 14
 * characters this is still ~72 bits, which is not guessable.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const LENGTH = 14;

export function generateInitialPassword(length = LENGTH): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  // Rejection-free modulo is fine here: 256 % 56 skews the first 24 letters by under 0.5%
  // of a bit across 14 characters, which is far below anything an attacker can use.
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
