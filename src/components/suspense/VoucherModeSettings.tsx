'use client';
import { useEffect, useState } from 'react';
import { GitMerge, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { getVoucherMode, setVoucherMode, type VoucherMode } from '@/services/suspenseService';
import { Label } from '@/components/ui/label';
import Select from '@/components/Select';

// Controls how addApprovedBillToVoucher (suspenseService.ts) groups newly approved bills: one
// open voucher per employee (default), or a single voucher shared across everyone. Only affects
// bills approved from now on — existing vouchers are never rewritten by a mode change.
export default function VoucherModeSettings() {
  const user = useAuthStore(s => s.user);
  const [mode, setMode]       = useState<VoucherMode>('per_user');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);

  useEffect(() => {
    getVoucherMode().then(setMode).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const change = async (next: VoucherMode) => {
    const prev = mode;
    setMode(next); setSaving(true);
    try {
      await setVoucherMode(next, { epf: user?.epf_number ?? '', name: user?.name ?? '' });
      toast.success('Voucher grouping updated.');
    } catch (e) {
      setMode(prev);
      toast.error(e instanceof Error && e.message ? e.message : 'Failed to update voucher grouping.');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <GitMerge className="h-3.5 w-3.5" /> Voucher grouping
      </Label>
      {loading ? (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : (
        <>
          <Select value={mode} onChange={v => change(v as VoucherMode)} disabled={saving} options={[
            { value: 'per_user', label: 'Per employee — one open voucher per person' },
            { value: 'overall', label: 'Overall — one shared open voucher for everyone' },
          ]} />
          <p className="text-[11px] text-muted-foreground">
            Controls how newly approved expense bills are grouped into vouchers. Changing this only affects bills approved from now on — existing vouchers are untouched.
          </p>
        </>
      )}
    </div>
  );
}
