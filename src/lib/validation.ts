// Shared field-format validation for account registration and admin user creation. Kept in
// one place so the public /register page, the admin Users form, and the server-side
// /api/register route all enforce the exact same rules (NIC / email / contact number).

// ─── Sri Lankan NIC ─────────────────────────────────────────────────────────────
// Two valid shapes:
//   • old  — 9 digits followed by a V or X (birth-year encoded), e.g. "913456789V"
//   • new  — 12 digits, e.g. "199134500789"
// Case-insensitive on the trailing letter. Anything else ("mm", partial numbers,
// alphanumeric noise) is rejected.
export const NIC_RE = /^(?:\d{9}[VXvx]|\d{12})$/;

export function isValidNIC(value: string): boolean {
  return NIC_RE.test(value.trim());
}

// Constrains a NIC as it's typed so the field can only ever hold a well-formed prefix:
// digits only, capped at 12, plus a single trailing V/X but ONLY on a 9-digit base (the
// old format). "200058354856m" → "200058354856"; "91234567 8v" → "912345678V";
// "1234x5678" → "12345678" (a mis-placed letter is dropped, not kept).
export function sanitizeNICInput(value: string): string {
  const s = value.toUpperCase().replace(/[^0-9VX]/g, '');
  const digits = s.replace(/[^0-9]/g, '').slice(0, 12);
  const letter = /[VX]/.test(s) ? (s.match(/[VX]/) as RegExpMatchArray)[0] : '';
  return digits.length === 9 && letter ? `${digits}${letter}` : digits;
}

// ─── Email (practical RFC 5322) ─────────────────────────────────────────────────
// Requires a dotted domain ending in a real alphabetic top-level domain (>= 2 letters),
// so "user@gmail" (no TLD) and "user@domain.1" are rejected while "user@domain.com" and
// "first.last@sub.example.co.uk" pass.
export const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmail(value: string): boolean {
  const v = value.trim();
  // EMAIL_RE guarantees at least one dot in the domain; this second check also forces the
  // final label (the TLD) to be alphabetic and at least two characters.
  return EMAIL_RE.test(v) && /\.[A-Za-z]{2,}$/.test(v);
}

// ─── Local contact number ──────────────────────────────────────────────────────
// Exactly 10 digits with a leading 0 (e.g. "0771234567"). Digits only — no spaces,
// dashes, country code or letters.
export const LOCAL_PHONE_RE = /^0\d{9}$/;

export function isValidLocalPhone(value: string): boolean {
  return LOCAL_PHONE_RE.test(value.trim());
}

// Strips everything but digits and caps at 10 — for onChange input sanitising so a contact
// field can never hold letters ("0706050470mmm" → "0706050470") or run past 10 characters.
export function sanitizePhoneInput(value: string): string {
  return value.replace(/\D/g, '').slice(0, 10);
}
