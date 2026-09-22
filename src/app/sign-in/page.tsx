import { permanentRedirect } from 'next/navigation';

// `/sign-in` is not a real screen — the sign-in page is `/login`. This alias exists because
// something in the wild keeps asking for `/sign-in` (an old bookmark, an external link, or a
// browser extension probing common auth paths), and every one of those requests was answering
// 404 in the server log.
//
// Server-side permanent redirect rather than a client-side one: there is nothing to render, so
// the browser should never paint a page here, and a 308 lets clients and crawlers learn the
// real location instead of asking again. Keep in step with NEVER_BLOCK_PATHS in
// src/components/maintenance/MaintenanceGate.tsx, which exempts `/login` so an admin can always
// sign in during a maintenance window — this alias inherits that by redirecting into it.
export default function SignInAliasPage(): never {
  permanentRedirect('/login');
}
