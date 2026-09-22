'use client';
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { auth } from '@/lib/firebase';
import { useT } from '@/store/appStore';
import {
  PasskeyError, deletePasskey, enrolPasskey, listPasskeys, passkeysSupported,
  type PasskeySummary,
} from '@/lib/passkey';
import { localDeviceLabel } from '@/lib/deviceFingerprint';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * "Passkeys" on /profile — enrol this device, see what is enrolled, remove one.
 *
 * Sits under Change Password because that is the only security surface on the page, and a
 * person looking for "how I get in" looks there. Rendered only where the tenant has the
 * `passkeys` feature; the caller owns that check.
 *
 * Everything goes through /api/auth/passkey/* with a fresh ID token. The token is fetched per
 * action rather than held, because the routes verify it with `checkRevoked` and a token cached
 * across a long-open profile tab would start failing for reasons nobody could see.
 */

/** A local date a Sri Lankan office reads without ambiguity: 6 Sep 2026. */
function shortDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function PasskeysCard() {
  const t = useT();
  const [supported, setSupported] = useState(false);
  const [items, setItems] = useState<PasskeySummary[] | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // `passkeysSupported()` touches window, so it cannot run during the server render.
  useEffect(() => { setSupported(passkeysSupported()); }, []);

  const message = useCallback((code: string): string => {
    switch (code) {
      case 'Unsupported':        return t.passkeyUnsupported;
      case 'Cancelled':          return t.passkeyCancelled;
      case 'AlreadyRegistered':  return t.passkeyAlreadyRegistered;
      case 'TooManyCredentials': return t.passkeyTooMany;
      case 'ChallengeExpired':   return t.passkeyExpired;
      default:                   return t.passkeyFailed;
    }
  }, [t]);

  const refresh = useCallback(async () => {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) { setItems([]); return; }
    try {
      setItems(await listPasskeys(idToken));
    } catch {
      // An empty list and a failed list look the same on screen, so say which happened —
      // otherwise someone concludes their passkey vanished.
      setItems([]);
      toast.error(t.passkeyFailed);
    }
  }, [t]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function handleEnrol() {
    setEnrolling(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new PasskeyError('Unauthorized');
      const created = await enrolPasskey(idToken, localDeviceLabel());
      setItems(prev => [created, ...(prev ?? [])]);
      toast.success(t.passkeyAdded);
    } catch (e) {
      const code = e instanceof PasskeyError ? e.message : '';
      // Dismissing the platform prompt is a decision, not an error worth a red toast.
      if (code !== 'Cancelled') toast.error(message(code));
    } finally {
      setEnrolling(false);
    }
  }

  async function handleRemove(id: string) {
    if (!confirm(t.passkeyRemoveConfirm)) return;
    setRemoving(id);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new PasskeyError('Unauthorized');
      await deletePasskey(idToken, id);
      setItems(prev => (prev ?? []).filter(p => p.id !== id));
      toast.success(t.passkeyRemoved);
    } catch (e) {
      toast.error(message(e instanceof PasskeyError ? e.message : ''));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <KeyRound className="w-4 h-4 text-primary" />
          </div>
          <div>
            <CardTitle className="text-sm">{t.passkeys}</CardTitle>
            <CardDescription className="text-xs">{t.passkeysDesc}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!supported ? (
          <p className="text-xs text-muted-foreground">{t.passkeyUnsupported}</p>
        ) : (
          <div className="space-y-3">
            {items === null ? (
              // Two skeleton rows at the real row height, so the card does not resize under
              // the reader's eye once the list arrives.
              <div className="space-y-2">
                <div className="h-14 rounded-lg bg-muted animate-pulse" />
                <div className="h-14 rounded-lg bg-muted animate-pulse" />
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center">
                <p className="text-sm font-medium">{t.passkeyNone}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t.passkeyNoneDesc}</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {items.map(p => (
                  <li key={p.id} className="flex items-center gap-3 rounded-lg border p-3">
                    <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{p.label}</span>
                        {/* "Synced" earns its own chip because it answers the question people
                        actually ask — will this still work on my new phone? Text, not a
                        colour: --success and --primary resolve to the same azure here. */}
                        {p.backed_up && (
                          <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t.passkeySynced}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {t.passkeyAddedOnTpl.replace('{date}', shortDate(p.created_at))}
                        {' · '}
                        {p.last_used_at
                          ? t.passkeyLastUsedTpl.replace('{date}', shortDate(p.last_used_at))
                          : t.passkeyNeverUsed}
                      </p>
                    </div>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={t.passkeyRemove}
                      onClick={() => handleRemove(p.id)} disabled={removing === p.id}>
                      {removing === p.id
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Trash2 className="h-4 w-4" />}
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex justify-end pt-1">
              <Button type="button" onClick={handleEnrol} disabled={enrolling}>
                {enrolling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {enrolling ? t.passkeyAdding : t.passkeyAdd}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
