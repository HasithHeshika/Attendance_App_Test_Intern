'use client';
import { useEffect, useState } from 'react';
import { Wallet, Loader2, Plus, Building2 } from 'lucide-react';
import toast from 'react-hot-toast';
import type { AppUser, SuspenseAccount } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  getUserAccounts, createSuspenseAccount, adjustSuspenseAccount,
  formatSuspenseAmount, type Actor,
} from '@/services/suspenseService';

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

// Per-user suspense management, mounted in the Users detail panel (gated by can_manage_users).
// Opens the employee's OWN-company account (no amount) and lists every per-company account
// they hold — executive/top-management staff auto-gain other-company accounts when their
// first expense/credit for that company is approved. Closing goes through the request flow;
// here a manager can only open the own-company account and make manual balance adjustments.
export default function UserSuspenseCard({ user, actor }: { user: AppUser; actor: Actor }) {
  const [accounts, setAccounts] = useState<SuspenseAccount[]>([]);
  const [loading, setLoading]   = useState(true);
  const [busy, setBusy]         = useState(false);

  const [adjustFor, setAdjustFor] = useState<string | null>(null); // company_id being adjusted
  const [adjust, setAdjust]       = useState('');
  const [adjustNote, setAdjustNote] = useState('');

  const load = async () => {
    setLoading(true);
    try { setAccounts(await getUserAccounts(user.epf_number)); }
    catch { /* leave empty; open UI shows */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user.epf_number]);

  const ownAccount = accounts.find(a => a.company_id === user.company_id);

  const openOwn = async () => {
    if (!actor.epf) { toast.error('Could not identify you as the creator — reload and retry.'); return; }
    setBusy(true);
    try {
      await createSuspenseAccount({
        epf_number: user.epf_number, employee_name: user.display_name,
        company_id: user.company_id, company_name: user.company_name,
      }, actor);
      toast.success('Suspense account opened.');
      await load();
    } catch (e) { toast.error(errMsg(e, 'Failed to open account.')); }
    finally { setBusy(false); }
  };

  const applyAdjust = async (companyId: string) => {
    const delta = parseFloat(adjust);
    if (isNaN(delta) || delta === 0) { toast.error('Enter a non-zero amount (prefix with “-” to debit).'); return; }
    setBusy(true);
    try {
      await adjustSuspenseAccount({ epf: user.epf_number, companyId, delta, note: adjustNote.trim(), actor });
      toast.success('Balance adjusted.');
      setAdjustFor(null); setAdjust(''); setAdjustNote('');
      await load();
    } catch (e) { toast.error(errMsg(e, 'Failed to adjust balance.')); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-1.5">
        <Wallet className="w-3.5 h-3.5" /> Suspense {accounts.length > 1 ? 'accounts' : 'account'}
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-3.5">
        {loading ? (
          <div className="flex items-center justify-center py-4 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /></div>
        ) : accounts.length === 0 ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">No suspense account. Open one for {user.company_name} so this user can submit expenses and request credit.</p>
            <Button size="sm" disabled={busy} onClick={openOwn} className="flex-shrink-0">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Plus className="w-4 h-4" /> Open account</>}
            </Button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {!ownAccount && (
              <Button size="sm" variant="outline" className="w-full" disabled={busy} onClick={openOwn}>
                <Plus className="w-4 h-4" /> Open {user.company_name} account
              </Button>
            )}
            {accounts.map(a => {
              const closed = !!a.is_closed;
              const frozen = !a.is_active && !closed;
              return (
                <div key={a.company_id} className="rounded-lg border border-border/60 bg-card/50 p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-[11px] text-muted-foreground"><Building2 className="w-3 h-3 shrink-0" /> <span className="truncate">{a.company_name}</span></div>
                      <div className={`text-lg font-bold tabular-nums ${a.balance < 0 ? 'text-destructive' : 'text-foreground'}`}>{formatSuspenseAmount(a.balance, a.currency)}</div>
                    </div>
                    <Badge variant={a.is_active ? 'success' : closed ? 'muted' : 'warning'}>{a.is_active ? 'Active' : closed ? 'Closed' : 'Close pending'}</Badge>
                  </div>

                  {frozen && <p className="mt-1.5 text-[11px] text-warning">Close request pending — frozen.</p>}

                  {a.is_active && !closed && (
                    adjustFor === a.company_id ? (
                      <div className="mt-2 space-y-2">
                        <Input type="number" inputMode="decimal" step="0.01" autoFocus value={adjust}
                          onChange={e => setAdjust(e.target.value)} placeholder="e.g. 5000 or -2000" />
                        <Input value={adjustNote} onChange={e => setAdjustNote(e.target.value)} placeholder="Reason for the adjustment" />
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" className="flex-1" disabled={busy} onClick={() => { setAdjustFor(null); setAdjust(''); setAdjustNote(''); }}>Cancel</Button>
                          <Button size="sm" className="flex-1" disabled={busy} onClick={() => applyAdjust(a.company_id)}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Apply'}</Button>
                        </div>
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => { setAdjustFor(a.company_id); setAdjust(''); setAdjustNote(''); }}>
                        <Plus className="w-3.5 h-3.5" /> Adjust credit
                      </Button>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
