'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import toast from 'react-hot-toast';
import { auth } from '@/lib/firebase';
import { useAuthStore } from '@/store/authStore';
import { Loader2, LogIn, LogOut, Eye, Power, ShieldOff, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { cancelMaintenance } from '@/services/maintenanceService';
import { formatCountdown, MAINTENANCE_KIND_LABEL, type MaintenanceDoc } from '@/lib/maintenance';
import { MAINTENANCE_KIND_ICON, MAINTENANCE_KIND_ACCENT } from './maintenanceIcons';
import MaintenanceMessage from './MaintenanceMessage';
import ThemeToggle from '@/components/ThemeToggle';

interface Props {
  doc: MaintenanceDoc;
  nowMs: number;
  isAdmin: boolean;
  /** Whether anyone is signed in at all. An admin arriving signed out (new device, expired
   *  session) can't be recognised as an admin yet, so they need a way to reach /login — which
   *  MaintenanceGate never blocks. Offered only when signed out: a signed-in non-admin has
   *  nothing to gain from it, and /login would just bounce them back into this overlay. */
  isSignedIn: boolean;
  onEnterAnyway: () => void;
  onViewReadOnly: () => void;
  /** Opens the full control panel (window times, message, mode, end now). MaintenanceGate hides
   *  this overlay while the panel is open — the panel is a Dialog at z-[120] and would otherwise
   *  render behind this z-[500] screen. */
  onOpenControls: () => void;
}

// Full-screen blocking overlay for the 'active' phase. Non-dismissible in block/lockdown mode
// for anyone but an admin — there is deliberately no close button, no Escape handler, no
// click-outside dismissal.
export default function MaintenanceOverlay({ doc, nowMs, isAdmin, isSignedIn, onEnterAnyway, onViewReadOnly, onOpenControls }: Props) {
  const [ending, setEnding] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();
  const logout = useAuthStore(s => s.logout);

  const signOutNow = async () => {
    setSigningOut(true);
    try { await signOut(auth); } catch { /* already gone */ }
    logout();
    router.push('/login');
  };

  const Icon = MAINTENANCE_KIND_ICON[doc.kind];
  const accent = MAINTENANCE_KIND_ACCENT[doc.kind];
  const remaining = doc.endAtMs - nowMs;
  const expectedBack = new Date(doc.endAtMs).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  const endNow = async () => {
    setEnding(true);
    try {
      await cancelMaintenance();
      toast.success('Maintenance ended.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to end maintenance.');
    } finally {
      setEnding(false);
    }
  };

  return (
    <div
      // Scrollable rather than only centred: a long admin message on a short phone would
      // otherwise be clipped with no way to reach it — on a screen that deliberately cannot be
      // dismissed. Centring still applies while the content fits, via min-h-full on the column.
      className="print:hidden fixed inset-0 z-[500] overflow-y-auto bg-background/98 backdrop-blur-xl px-5 py-12 text-center sm:px-6"
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
    >
      {/* The theme toggle lives in the app header, which this overlay covers — without one here a
          user is stuck in whichever theme they were in for the whole maintenance window. */}
      {/* Stronger border/background than the toggle's default: its `bg-card` sits almost
          invisibly on this blurred full-bleed backdrop. */}
      <div className="absolute right-4 top-4">
        <ThemeToggle className="border-border/80 bg-card/90 text-foreground shadow-sm backdrop-blur" />
      </div>

      <div className="mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center gap-5">
        <div className={cn('flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl', accent.bg, accent.text)}>
          <Icon className="h-8 w-8" />
        </div>

        <div className="w-full space-y-1.5">
          <h1 className="text-xl font-bold text-foreground">{MAINTENANCE_KIND_LABEL[doc.kind]}</h1>
          <MaintenanceMessage message={doc.message} className="text-sm text-muted-foreground [overflow-wrap:anywhere]" />
        </div>

        <div className="rounded-xl border border-border bg-card/80 px-6 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Back in</div>
          <div className="text-3xl font-bold tabular-nums text-foreground">{formatCountdown(remaining)}</div>
          <div className="mt-1 text-xs text-muted-foreground">Expected back {expectedBack}</div>
        </div>

        {isAdmin ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={onOpenControls} variant="default" className="gap-2">
              <SlidersHorizontal className="h-4 w-4" /> Edit window
            </Button>
            <Button onClick={onEnterAnyway} variant="outline" className="gap-2">
              <LogIn className="h-4 w-4" /> Enter anyway
            </Button>
            <Button onClick={endNow} disabled={ending} variant="destructive" className="gap-2">
              {ending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
              End maintenance now
            </Button>
          </div>
        ) : doc.mode === 'readonly' ? (
          <Button onClick={onViewReadOnly} variant="outline" className="gap-2">
            <Eye className="h-4 w-4" /> View data read-only
          </Button>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <ShieldOff className="h-3.5 w-3.5 shrink-0" />
              This screen cannot be dismissed until maintenance ends.
            </div>
            {/* Signed-out only. A signed-in non-admin is already known NOT to be an admin, so the
                control is noise to them and needlessly advertises the admin route. Anonymous
                visitors still get it, because an admin whose session has expired is
                indistinguishable from any other signed-out visitor and would otherwise have no
                way back in — /login is the one path MaintenanceGate never blocks. */}
            {isSignedIn ? (
              // The header (and its sign-out) is behind this overlay, so a signed-in person has
              // no other way off this account — which matters on a shared device, and is how an
              // admin gets back to a sign-in screen without knowing the /login URL.
              <Button onClick={signOutNow} disabled={signingOut} variant="ghost" size="sm" className="gap-2 text-muted-foreground">
                {signingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                Sign out
              </Button>
            ) : (
              <Button asChild variant="ghost" size="sm" className="gap-2 text-muted-foreground">
                <Link href="/login">
                  <LogIn className="h-4 w-4" /> Admin sign-in
                </Link>
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
