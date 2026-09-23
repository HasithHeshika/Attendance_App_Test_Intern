/**
 * Where an SSO handoff is allowed to land.
 *
 * AN UNVALIDATED `next` IS AN OPEN REDIRECT, and an open redirect on a sign-in route is the
 * classic way to harvest a session: bounce the person to a lookalike host at the exact moment
 * they expect to be signed in somewhere. So this answers one question — is this a same-origin
 * RELATIVE path? — and falls back for everything else rather than trying to repair it.
 *
 * ONE COPY, TWO ENDS. Both ends of the LogPup handoff run this: the minter
 * (src/app/api/logpup-sso/route.ts), which builds the link, and the receiver
 * (src/app/sso/logpup/page.tsx), which acts on the value. Each had its own private copy and
 * both were missing the third rejection below. A validator that only runs on one end validates
 * nothing — a link can be hand-assembled, and the receiver is the end that performs the
 * redirect. LogPup's src/lib/safe-next.ts is the same function on the other side of the bridge;
 * the two must agree, so a change here is a change there.
 *
 * THREE REJECTIONS, and the last two are the ones that matter:
 *
 *  - No leading '/' — 'https://evil.example' is not a path at all.
 *  - A second '/' — '//evil.example' is a PROTOCOL-RELATIVE URL. It looks like a path and every
 *    browser treats it as absolute.
 *  - A leading backslash — '/\evil.example'. Browsers normalise '\' to '/' in URLs, so this
 *    becomes the protocol-relative case above AFTER a check that only looked for '//' has
 *    already passed it. This one is why the rule is "one slash then an ordinary character"
 *    rather than "not '//'".
 *
 * `fallback` differs by caller on purpose: the minter has no session context and sends people to
 * '/', while the receiver has just signed somebody in and sends them to '/dashboard'.
 */
export function safeNext(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value === '') return fallback;
  if (!value.startsWith('/')) return fallback;
  // Index 1 rather than a startsWith pair, so a bare '/' (length 1, undefined here) passes and
  // both absolute-looking forms are refused together.
  if (value[1] === '/' || value[1] === '\\') return fallback;
  return value;
}
