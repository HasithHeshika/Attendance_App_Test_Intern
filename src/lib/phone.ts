// Lets southernlanka (carecode.org) users sign in with their employee number instead of
// email. This only resolves the typed employee number to the matching account's email,
// then the normal email+password sign-in runs exactly as it would for an email login.

export function isEmailLike(value: string): boolean {
  return value.includes('@');
}

// Email is optional at registration/creation for the southernlanka tenant — the assigned
// employee number (employee_number) is enough to sign in (see resolve-login above).
// Firebase Auth still requires SOME email+password pair though, so when the person doesn't
// give a real one we synthesize a placeholder that's guaranteed unique and never delivered
// anywhere — nobody ever sees or types it, employee_number is the only identifier they
// actually use.
const PLACEHOLDER_EMAIL_DOMAIN = 'southernlanka.internal';

export function placeholderEmail(): string {
  const rand = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `no-email.${rand}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

// Detects a synthesized address so the UI can show "no email on file" instead of the
// meaningless placeholder string (e.g. in the Users table/detail view).
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}
