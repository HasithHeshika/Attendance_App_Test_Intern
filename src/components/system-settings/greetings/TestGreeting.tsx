'use client';
import { useEffect, useMemo, useState } from 'react';
import { BellRing, Loader2, Send, UserCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { useT } from '@/store/appStore';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import Select from '@/components/Select';
import SearchableSelect, { type SearchOption } from '@/components/SearchableSelect';
import ConfirmModal from '@/components/ConfirmModal';
import { BlockHeader } from '@/components/system-settings/greetings/parts';
import { formatLongDate } from '@/components/system-settings/greetings/holidayOptions';
import { sendTestGreeting } from '@/services/greetingsSettingsService';
import {
  resolveSpecialDayDate, type HolidayCalendar, type OccasionKind, type SpecialDay,
} from '@/lib/greetings';
import type { AppUser } from '@/lib/types';

// "Send a test" is not a setting and it is not a preview: /api/admin/greetings/test calls
// deliverGreeting for real, so the person named here gets a notification and a push on their
// phone within seconds. The block says that in as many words, defaults to the admin doing the
// testing, and confirms — one mis-pick used to put a birthday card on a stranger's lock screen.

export interface TestGreetingProps {
  users: AppUser[];
  specialDays: SpecialDay[];
  calendar: HolidayCalendar | null;
  year: string;
  /** The signed-in admin's EPF, when they have one — the safe default recipient. */
  myEpf: string;
}

export default function TestGreeting({ users, specialDays, calendar, year, myEpf }: TestGreetingProps) {
  const t = useT();
  const [epf, setEpf] = useState(myEpf);
  const [kind, setKind] = useState<OccasionKind>('birthday');
  const [dayId, setDayId] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // The recipient defaults to whoever is signed in, but only once the auth store has an EPF —
  // it hydrates after the first render.
  useEffect(() => { setEpf(prev => prev || myEpf); }, [myEpf]);

  // Real state, not a rendering trick. The old select displayed `special_days[0]` while the
  // state stayed empty, so adding or reordering a day changed the "selected" day underneath
  // the admin without a single interaction.
  useEffect(() => {
    setDayId(prev => (prev && specialDays.some(d => d.id === prev) ? prev : (specialDays[0]?.id ?? '')));
  }, [specialDays]);

  // A result is a claim about one send. Change any part of what would be sent and the claim is
  // no longer about anything on screen.
  useEffect(() => { setResult(null); }, [epf, kind, dayId]);

  const userOptions = useMemo<SearchOption[]>(() => users.filter(u => u.epf_number).map(u => ({
    value: String(u.epf_number),
    label: u.display_name || String(u.epf_number),
    sublabel: [String(u.epf_number), u.role].filter(Boolean).join(' · ') || undefined,
    keywords: `${u.epf_number} ${u.email ?? ''} ${u.role ?? ''}`,
  })), [users]);

  const recipient = users.find(u => String(u.epf_number) === epf);
  const recipientName = recipient?.display_name || epf;
  const noDays = kind === 'special' && specialDays.length === 0;

  const run = async () => {
    setConfirming(false);
    setSending(true);
    setResult(null);
    try {
      const r = await sendTestGreeting(epf, kind, kind === 'special' ? dayId : undefined);
      setResult(t.greetingsTestSent.replace('{name}', r.name).replace('{n}', String(r.senders.length)));
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t.greetingsSaveFailed);
    } finally { setSending(false); }
  };

  return (
    <div className="space-y-3">
      <BlockHeader icon={Send} title={t.greetingsSendTest} description={t.greetingsTestHint} />

      <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-[11px] text-muted-foreground">{t.greetingsTestWho}</Label>
              {myEpf && epf !== myEpf && (
                <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => setEpf(myEpf)}>
                  <UserCheck className="h-3.5 w-3.5" /> {t.greetingsTestToMe}
                </Button>
              )}
            </div>
            <SearchableSelect value={epf} onChange={setEpf} options={userOptions}
              placeholder={t.greetingsTestWho} ariaLabel={t.greetingsTestWho} />
          </div>

          <div className="space-y-1">
            {/* Select is a shim over Combobox and takes no accessible-name prop, so the visible
                label is the only one this control gets. */}
            <Label className="text-[11px] text-muted-foreground">{t.greetingsTestOccasion}</Label>
            <Select value={kind} onChange={v => setKind(v as OccasionKind)} options={[
              { value: 'birthday', label: t.greetingsBirthdays },
              { value: 'anniversary', label: t.greetingsAnniversaries },
              { value: 'special', label: t.greetingsSpecialDays },
            ]} />
          </div>
        </div>

        {/* Above the button, never under it: choosing "Special days" used to make a new field
            appear below the action it changes. */}
        {kind === 'special' && (
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t.greetingsTestDay}</Label>
            {noDays ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-foreground">
                {t.greetingsTestNoDays}
              </p>
            ) : (
              <Select value={dayId} onChange={setDayId} options={specialDays.map(d => ({
                value: d.id,
                label: d.title || d.id,
                // A calendar-linked day has no `date` of its own — showing the raw field
                // printed "undefined" beside its title. Resolve it the way the card does.
                sublabel: (() => {
                  const on = resolveSpecialDayDate(d, year, calendar);
                  return on ? formatLongDate(on) : undefined;
                })(),
              }))} />
            )}
          </div>
        )}

        <Button type="button" className="h-10 w-full sm:w-auto"
          disabled={!epf || sending || noDays}
          onClick={() => setConfirming(true)}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {t.greetingsSendTest}
        </Button>

        {/* Not text-success: --success is the same azure as --primary and --brand, so a green
            you cannot see is not a state. An icon and the sentence itself carry it. */}
        {result && (
          <p className="flex items-start gap-1.5 text-xs font-medium text-foreground">
            <BellRing aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>{result}</span>
          </p>
        )}
      </div>

      <ConfirmModal
        open={confirming}
        onOpenChange={setConfirming}
        variant="warning"
        busy={sending}
        title={t.greetingsTestConfirmTitle.replace('{name}', recipientName)}
        description={t.greetingsTestConfirmBody}
        confirmText={t.greetingsSendTest}
        onConfirm={run}
      />
    </div>
  );
}
