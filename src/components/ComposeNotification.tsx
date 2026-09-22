'use client';
// "New notification" composer (bell → send).
//
// Who a person may write to is decided by the server, not here: /api/notify/compose answers with
// the audiences this caller may use and the only people they may pick, and the POST re-checks
// both. That split matters because `can_send_notifications` used to conflate two very different
// powers — messaging the whole company, and messaging your own team — and because the write used
// to happen in the browser, where nothing enforced either one.
//
// So this component renders what came back and never decides anything itself. An executive with
// reports gets My team and Selected people; a broadcaster also gets Everyone.

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search, Check, Send, Clock, Users, UsersRound, ListChecks } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  getComposeAudience, sendCustomNotification,
  type ComposeAudience, type ComposeAudienceInfo,
} from '@/services/notificationService';
import { scheduleNotification } from '@/services/scheduledNotificationService';
import { useT } from '@/store/appStore';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/Skeleton';

function AudienceIcon({ a, className = 'h-3.5 w-3.5' }: { a: ComposeAudience; className?: string }) {
  if (a === 'all') return <Users className={className} aria-hidden />;
  if (a === 'my_team') return <UsersRound className={className} aria-hidden />;
  return <ListChecks className={className} aria-hidden />;
}

export default function ComposeNotification({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [info, setInfo] = useState<ComposeAudienceInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [mode, setMode] = useState<ComposeAudience>('selected');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [sendAt, setSendAt] = useState('');   // datetime-local string
  const [sending, setSending] = useState(false);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // One request per opening. It carries the audiences AND the recipient list, so there is no
  // separate client-side read of the users collection any more — that read returned everyone
  // regardless of who was looking.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    getComposeAudience()
      .then(d => {
        if (cancelled) return;
        setInfo(d);
        // Default to the narrowest audience offered. Landing on Everyone by default is how a
        // note meant for three people goes to three hundred.
        setMode(d.allowed.includes('selected') ? 'selected' : (d.allowed[0] ?? 'selected'));
      })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load recipients'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  // Reset when the dialog closes.
  useEffect(() => {
    if (!open) { setTitle(''); setBody(''); setSelected(new Set()); setQ(''); setWhen('now'); setSendAt(''); }
  }, [open]);

  // Earliest selectable time for the scheduler (now), as a datetime-local string.
  const minLocal = useMemo(() => {
    const p = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }, [open]);

  const people = info?.people ?? [];
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = s ? people.filter(u => u.name.toLowerCase().includes(s) || u.epf.toLowerCase().includes(s)) : people;
    return base.slice(0, 50);
  }, [people, q]);

  const toggle = (epf: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(epf)) next.delete(epf); else next.add(epf);
    return next;
  });

  const label = (a: ComposeAudience): string =>
    a === 'all' ? t.gmAudienceEveryone : a === 'my_team' ? t.gmAudienceTeam : t.notifSelectedPeople;

  const reach = (a: ComposeAudience): number =>
    a === 'all' ? (info?.reach.all ?? 0) : a === 'my_team' ? (info?.reach.my_team ?? 0) : selected.size;

  const handleSend = async () => {
    if (!title.trim() || !body.trim()) { toast.error('Add a title and a message'); return; }
    if (mode === 'selected' && selected.size === 0) { toast.error('Pick at least one person'); return; }
    // Everyone is the one action here that reaches people the sender has no relationship with,
    // so it is confirmed with the count in front of them.
    if (mode === 'all'
      && !window.confirm(`${t.gmReach.replace('{n}', String(reach('all')))}\n\n${title.trim()}`)) return;

    const common = {
      audience: mode,
      ...(mode === 'selected' ? { toEpfs: [...selected] } : {}),
      title: title.trim(),
      body: body.trim(),
    };

    if (when === 'later') {
      const at = new Date(sendAt);
      if (!sendAt || Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
        toast.error('Pick a future date and time'); return;
      }
      setSending(true);
      const res = await scheduleNotification({ ...common, sendAt: at });
      setSending(false);
      if (res.ok) { toast.success(`Scheduled for ${at.toLocaleString()}`); onClose(); }
      else toast.error(res.error ?? 'Failed to schedule notification');
      return;
    }

    setSending(true);
    const res = await sendCustomNotification(common);
    setSending(false);
    if (res.ok) { toast.success('Notification sent'); onClose(); }
    // The server's own words: "3 of those people are not yours to write to" tells the sender
    // something a generic failure cannot.
    else toast.error(res.error ?? 'Failed to send notification');
  };

  const allowed = info?.allowed ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New notification</DialogTitle>
          <DialogDescription>
            Send a notification to the people you can reach — now, or scheduled for later.
          </DialogDescription>
        </DialogHeader>

        {loading && !info ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : loadError ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : allowed.length === 0 ? (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
            {t.gmNoPermission}
          </p>
        ) : (
          <div className="space-y-3">
            {/* Recipients — only the audiences the server said this person may use. */}
            <div className="flex gap-2">
              {allowed.map(m => (
                <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                    mode === m ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent'
                  }`}>
                  <span className="flex items-center justify-center gap-1.5">
                    <AudienceIcon a={m} className="h-3 w-3" />
                    {label(m)}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {t.gmReach.replace('{n}', String(reach(mode)))}
            </p>

            {mode === 'selected' && (
              <div className="rounded-lg border border-border">
                <div className="h-9 flex items-center gap-2 border-b border-border px-2.5">
                  <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder={t.gmSearchPeople}
                    className="w-full bg-transparent text-sm outline-none" />
                  {selected.size > 0 && <span className="flex-shrink-0 text-[10px] font-semibold text-primary">{selected.size}</span>}
                </div>
                <div className="max-h-40 overflow-y-auto scrollbar-thin">
                  {filtered.length === 0 ? (
                    <div className="py-4 text-center text-[11px] text-muted-foreground">{t.gmNoMatches}</div>
                  ) : filtered.map(u => {
                    const on = selected.has(u.epf);
                    return (
                      <button key={u.epf} type="button" onClick={() => toggle(u.epf)}
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent">
                        <span className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${on ? 'border-primary bg-primary' : 'border-border'}`}>
                          {on && <Check className="h-3 w-3 text-primary-foreground" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{u.name}</span>
                        <span className="flex-shrink-0 text-[10px] text-muted-foreground">{u.epf}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" maxLength={200} />
            <Textarea value={body} onChange={e => setBody(e.target.value)} placeholder="Message" rows={4} maxLength={500} className="resize-none" />

            {/* When: send now or schedule for later */}
            <div className="flex gap-2">
              {(['now', 'later'] as const).map(w => (
                <button key={w} type="button" onClick={() => setWhen(w)} aria-pressed={when === w}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${when === w ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent'}`}>
                  {w === 'now' ? 'Send now' : 'Schedule'}
                </button>
              ))}
            </div>
            {when === 'later' && (
              <Input type="datetime-local" value={sendAt} min={minLocal} onChange={e => setSendAt(e.target.value)} />
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={sending}>{t.cancel}</Button>
          <Button onClick={handleSend} disabled={sending || allowed.length === 0}>
            {sending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : when === 'later' ? <Clock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {when === 'later' ? 'Schedule' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
