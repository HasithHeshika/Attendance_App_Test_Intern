'use client';
import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import {
  User, Mail, Phone, MapPin, CreditCard, Building2,
  Save, Loader2, Camera, ShieldAlert, Calendar, Briefcase,
  Lock, Eye, EyeOff, Shield, Contact,
  Copy, Check, Fingerprint, ExternalLink, Wallet, ChevronRight,
} from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { _profileApi as profileApi, _authApi as authApi } from '@/services/apiCompat';
import { auth } from '@/lib/firebase';
import { getCachedAvatar, liveOAuthPhotoForEmail, userScopedAvatar } from '@/lib/avatarCache';
import { getCompanies } from '@/services/companyService';
import { brandCoverForCompany } from '@/lib/brandColor';
import { EmailAuthProvider, reauthenticateWithCredential, verifyBeforeUpdateEmail } from 'firebase/auth';
import toast from 'react-hot-toast';
import { PageHeader } from '@/components/ui/page-header';
import MyDeductions from '@/components/suspense/MyDeductions';
import MyLunchCount from '@/components/lunch/MyLunchCount';
import MyPayrollRequests from '@/components/payroll/MyPayrollRequests';
import PasskeysCard from '@/components/profile/PasskeysCard';
import { tenant } from '@/lib/firebase';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { PageTransition, Reveal } from '@/components/ui/motion';
import { useLanyardStore } from '@/store/lanyardStore';
import { FormSkeleton, PageHeaderSkeleton, SkeletonCard, Skeleton } from '@/components/ui/Skeleton';
import InlineError from '@/components/InlineError';
import { isValidEmail } from '@/lib/validation';

// Fields returned by GET /web-get-profile-details
interface ProfileData {
  name:                   string;
  email:                  string;
  epf_number:             string;
  personal_phonenumber?:  string | null;
  office_phonenumber?:    string | null;
  emergency_phonenumber?: string | null;
  address?:               string | null;
  nic?:                   string | null;
  date_of_birth?:         string | null;
}

const COUNTRY_CODES = [
  { code: '+94', label: 'LK (+94)' },
  { code: '+1',  label: 'US (+1)' },
  { code: '+44', label: 'UK (+44)' },
  { code: '+91', label: 'IN (+91)' },
  { code: '+61', label: 'AU (+61)' },
  { code: '+971', label: 'AE (+971)' },
];

// Expected national-number length (digits after the country code, leading 0 dropped) per
// dialling code. Used to cap what can be typed AND to validate on save.
const NSN_LEN: Record<string, number> = {
  '+94': 9, '+1': 10, '+44': 10, '+91': 10, '+61': 9, '+971': 9,
};
// Codes not in the table (shouldn't happen — the picker is fixed) fall back to this range.
const NSN_FALLBACK_MIN = 7;
const NSN_FALLBACK_MAX = 12;

// Split a stored "+94 771234567" value into its dialling code and a digits-only national
// number (leading zeros stripped).
function splitPhone(value: string): { code: string; local: string } {
  const code = COUNTRY_CODES.find(c => value.startsWith(c.code))?.code ?? '+94';
  const raw = value.startsWith(code) ? value.slice(code.length) : value;
  const local = raw.replace(/\D/g, '').replace(/^0+/, '');
  return { code, local };
}

// '' when the field is empty or the national number has the right length for its code;
// otherwise a specific message. Keeps foreign codes usable (fallback range) while holding
// Sri Lankan (+94) numbers to exactly 9 digits.
function phoneFieldError(value: string): string {
  if (!value.trim()) return '';
  const { code, local } = splitPhone(value);
  const want = NSN_LEN[code];
  if (want != null) {
    return local.length === want
      ? ''
      : `Enter a valid ${code} number — ${want} digits after ${code}.`;
  }
  return local.length >= NSN_FALLBACK_MIN && local.length <= NSN_FALLBACK_MAX
    ? ''
    : 'Enter a valid phone number.';
}

function CustomPhoneInput({
  value,
  onChange,
  icon: Icon,
  placeholder,
  iconColorClass = "text-muted-foreground",
  invalid = false,
}: {
  value: string;
  onChange: (val: string) => void;
  icon: any;
  placeholder: string;
  iconColorClass?: string;
  invalid?: boolean;
}) {
  const matchedCode = COUNTRY_CODES.find(c => value.startsWith(c.code))?.code || '+94';
  const maxDigits = NSN_LEN[matchedCode] ?? NSN_FALLBACK_MAX;
  let numberPart = value.startsWith(matchedCode) ? value.slice(matchedCode.length).trim() : value;
  // Strip leading 0
  if (numberPart.startsWith('0')) {
    numberPart = numberPart.replace(/^0+/, '');
  }

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Digits only, no leading zeros, hard-capped at the code's expected length so an
    // over-long string (e.g. 70605046780090) simply can't be entered.
    const digits = e.target.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, maxDigits);
    onChange(`${matchedCode} ${digits}`.trim());
  };

  const handleCodeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextMax = NSN_LEN[e.target.value] ?? NSN_FALLBACK_MAX;
    const digits = numberPart.replace(/\D/g, '').replace(/^0+/, '').slice(0, nextMax);
    onChange(`${e.target.value} ${digits}`.trim());
  };

  return (
    <div className={`h-9 flex relative rounded-md border bg-card focus-within:ring-2 transition-colors ${
      invalid ? 'border-destructive focus-within:ring-destructive' : 'border-input focus-within:ring-ring'
    }`}>
      <Icon className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${iconColorClass}`} />
      <select
        value={matchedCode}
        onChange={handleCodeChange}
        className="bg-transparent pl-9 pr-1 text-foreground text-sm focus:outline-none border-r border-border appearance-none cursor-pointer"
        style={{ WebkitAppearance: 'none', MozAppearance: 'none' }}
      >
        {COUNTRY_CODES.map(c => (
          <option key={c.code} value={c.code} className="bg-popover text-popover-foreground">{c.code}</option>
        ))}
      </select>
      <input type="tel"
        inputMode="numeric"
        maxLength={maxDigits}
        value={numberPart}
        onChange={handleNumberChange}
        aria-invalid={invalid || undefined}
        className="flex-1 bg-transparent px-3 text-foreground text-sm focus:outline-none placeholder:text-muted-foreground min-w-0"
        placeholder={placeholder} />
    </div>
  );
}

export default function ProfilePage() {
  const { user, updateUser } = useAuthStore();
  const caps = useUserCapabilities();
  const noAttendance = !caps.has_attendance;  // only System Admin has no attendance
  const lanyardEnabled = caps.is_employee;    // non-employees (admins) get no ID lanyard
  const t = useT();
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);
  const [profile,   setProfile]   = useState<ProfileData | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [newImage,  setNewImage]  = useState<File | null>(null);
  const [preview,   setPreview]   = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [companyLogo, setCompanyLogo] = useState<string | null>(null);
  const [coverBg, setCoverBg] = useState<string | null>(null);
  const [coverTone, setCoverTone] = useState<'light' | 'dark'>('light');

  // Change password state
  const [passwords,  setPasswords]  = useState({ current: '', new: '', confirm: '' });
  const [showPw,     setShowPw]     = useState({ current: false, new: false, confirm: false });
  const [savingPw,   setSavingPw]   = useState(false);

  // Change email state
  const [emailEditing, setEmailEditing] = useState(false);
  const [newEmail,     setNewEmail]     = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [changingEmail, setChangingEmail] = useState(false);
  const [copiedEpf,     setCopiedEpf]     = useState(false);

  // Copy the (read-only) EPF number to the clipboard — used to link the Solar app.
  const copyEpf = async () => {
    const epf = user?.epf_number ?? '';
    if (!epf) return;
    try {
      await navigator.clipboard.writeText(epf);
      setCopiedEpf(true);
      toast.success('EPF number copied');
      setTimeout(() => setCopiedEpf(false), 2000);
    } catch {
      toast.error('Could not copy — please copy it manually');
    }
  };

  // Editable form fields (everything except email and epf_number)
  const [form, setForm] = useState({
    name:                   '',
    personal_phonenumber:   '',
    office_phonenumber:     '',
    emergency_phonenumber:  '',
    address:                '',
  });

  // Re-run once the persisted auth user has hydrated and an epf is available.
  // (Mounting with an empty epf made getProfile throw "User not found", which
  //  surfaced as a spurious "Failed to load profile".)
  useEffect(() => {
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.epf_number]);

  // Adopt the live Google/Microsoft profile photo as the avatar when we don't
  // have one stored yet — so the sidebar/header pick it up too (not just here).
  useEffect(() => {
    // Only adopt the live OAuth photo when the Firebase session is THIS user (same email) —
    // never a previous/other person's browser-global photo.
    const ownPhoto = liveOAuthPhotoForEmail(user?.email);
    if (!user?.avatar && ownPhoto) {
      updateUser({ avatar: ownPhoto });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.avatar]);

  // Resolve the user's company logo (public URL set in the companies admin) to
  // brand the cover. Match by id first, then fall back to name (id may be absent
  // on a persisted session until the next auth refresh).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const companies = await getCompanies();
        const match = companies.find(
          c => (user?.company_id && c.id === user.company_id) || (user?.company && c.name === user.company)
        );
        if (cancelled) return;
        setCompanyLogo(match?.logo_url || null);
        const cover = await brandCoverForCompany({ logoUrl: match?.logo_url, seed: match?.id || user?.company, accentColor: match?.accent_color });
        if (!cancelled) { setCoverBg(cover.gradient); setCoverTone(cover.tone); }
      } catch {
        if (!cancelled) { setCompanyLogo(null); setCoverBg(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [user?.company_id, user?.company]);

  const loadProfile = async () => {
    // Don't fetch with an empty epf — it throws. Wait for auth to hydrate; keep
    // the page usable with the name we already have from the auth store.
    if (!user?.epf_number) {
      setForm(f => ({ ...f, name: user?.name ?? f.name }));
      setLoading(!user);
      return;
    }
    setLoading(true);
    try {
      // Fetch profile details — requires epf_number as query param
      const res = await profileApi.getProfile(user.epf_number);
      const d: ProfileData = res.data?.data?.profile_data ?? res.data?.data ?? res.data;

      setProfile(d);
      setForm({
        name:                  d?.name                   ?? user?.name ?? '',
        personal_phonenumber:  d?.personal_phonenumber   ?? '',
        office_phonenumber:    d?.office_phonenumber     ?? '',
        emergency_phonenumber: d?.emergency_phonenumber  ?? '',
        address:               d?.address                ?? '',
      });

      // Try to load profile picture for display on this page only.
      // Do not store base64 image data in the persisted auth store.
      try {
        const picRes = await profileApi.getProfilePicture(user?.epf_number ?? '');
        if (picRes.data && picRes.data.size > 0) {
          // Convert blob → base64 data URL for local component state only.
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result as string;
            setAvatarUrl(dataUrl);
          };
          reader.readAsDataURL(picRes.data);
        }
      } catch {
        // No picture stored — fall back to initial letter
      }
    } catch (e) {
      console.error('[profile] failed to load profile:', e);
      // Keep the page usable with what the auth store already gave us.
      setForm(f => ({ ...f, name: user?.name ?? f.name }));
      toast.error(t.failedLoadProfile);
    }
    setLoading(false);
  };

  const handleImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate type
    if (!file.type.startsWith('image/')) {
      toast.error(t.selectImageFile);
      return;
    }
    // Validate size — max 2MB
    if (file.size > 2 * 1024 * 1024) {
      toast.error(t.imageUnder2MB);
      return;
    }

    setNewImage(file);
    // Revoke old preview URL to avoid memory leaks
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));
    // Reset input so same file can be re-selected if needed
    e.target.value = '';
  };

  // Live field validation for the editable profile form. Phone rules are length-per-code
  // (see phoneFieldError); name is required. Feeds both the inline messages and the
  // disabled state of the Save button.
  const nameError = !form.name.trim() ? t.nameRequired : '';
  const personalPhoneError  = phoneFieldError(form.personal_phonenumber);
  const officePhoneError    = phoneFieldError(form.office_phonenumber);
  const emergencyPhoneError = phoneFieldError(form.emergency_phonenumber);
  const profileFormInvalid =
    !!nameError || !!personalPhoneError || !!officePhoneError || !!emergencyPhoneError;

  const handleSave = async () => {
    if (nameError) { toast.error(t.nameRequired); return; }
    if (personalPhoneError)  { toast.error(t.invalidPersonalPhone); return; }
    if (officePhoneError)    { toast.error(t.invalidOfficePhone); return; }
    if (emergencyPhoneError) { toast.error(t.invalidEmergencyPhone); return; }

    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('epf_number', user?.epf_number ?? '');
      fd.append('name',       form.name);
      // email is read-only — send current value to satisfy backend validation
      fd.append('email',      profile?.email ?? user?.email ?? '');
      fd.append('personal_phonenumber',   form.personal_phonenumber);
      fd.append('office_phonenumber',     form.office_phonenumber);
      fd.append('emergency_phonenumber',  form.emergency_phonenumber);
      fd.append('address',               form.address);
      // Append image with explicit filename — some backends require it
      if (newImage) {
        fd.append('profile_image', newImage, newImage.name);
      }

      const res = await profileApi.saveProfile(fd);
      const updated = res.data?.data?.user ?? res.data?.data ?? res.data;

      // Update auth store with new name
      if (updated?.name) updateUser({ name: updated.name });

      // After save, convert the new preview to base64 and store globally
      if (preview && newImage) {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          setAvatarUrl(dataUrl);
          updateUser({ avatar: dataUrl });   // updates navbar/sidebar immediately
          setPreview(null);
        };
        reader.readAsDataURL(newImage);
      } else {
        setPreview(null);
      }
      setNewImage(null);
      toast.success(t.profileUpdated);
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? t.failedUpdateProfile
      );
    }
    setSaving(false);
  };

  const handleChangePassword = async () => {
    if (!passwords.current || !passwords.new || !passwords.confirm) {
      toast.error(t.fillAllFields); return;
    }
    if (passwords.new !== passwords.confirm) { toast.error(t.passwordsNoMatch); return; }
    if (passwords.new.length < 8) { toast.error(t.passwordMin8); return; }
    setSavingPw(true);
    try {
      await authApi.changePassword({
        epf_number:   user?.epf_number ?? '',
        old_password: passwords.current,
        new_password: passwords.new,
      });
      toast.success(t.passwordChanged);
      setPasswords({ current: '', new: '', confirm: '' });
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? t.failedChangePassword
      );
    }
    setSavingPw(false);
  };

  // RFC-5322-ish + real TLD (shared validator). Empty → no error yet; a typed value must
  // be a complete address (ye@gmail / user@domain.c are rejected).
  const newEmailError = newEmail.trim() && !isValidEmail(newEmail) ? t.enterValidEmail : '';

  const handleChangeEmail = async () => {
    const target = newEmail.trim();
    if (!isValidEmail(target)) { toast.error(t.enterValidEmail); return; }
    if (!emailPassword) { toast.error(t.enterCurrentPwConfirm); return; }
    const fbUser = auth.currentUser;
    if (!fbUser?.email) { toast.error(t.notSignedIn); return; }
    const oldEmail = fbUser.email;
    if (target === oldEmail) { toast(t.emailUnchanged, { icon: 'ℹ️' }); return; }

    setChangingEmail(true);
    try {
      // Re-authenticate (required by Firebase for sensitive ops)
      const cred = EmailAuthProvider.credential(oldEmail, emailPassword);
      await reauthenticateWithCredential(fbUser, cred);

      // Send a verification link to the NEW email; Auth email changes only after they click it
      await verifyBeforeUpdateEmail(fbUser, target);
      toast.success(t.verificationEmailSentTo.replace('{email}', target));

      // Notify all HR/Admin that this user requested an email change
      try {
        const idToken = await fbUser.getIdToken();
        await fetch('/api/admin/notify-email-change', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, oldEmail, newEmail: target }),
        });
      } catch { /* non-critical */ }

      setEmailEditing(false);
      setNewEmail('');
      setEmailPassword('');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? '';
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') toast.error(t.incorrectPassword);
      else if (code === 'auth/email-already-in-use') toast.error(t.emailInUse);
      else if (code === 'auth/requires-recent-login') toast.error(t.signInAgainRetry);
      else toast.error(t.failedChangeEmail);
    }
    setChangingEmail(false);
  };

  // Priority: local preview (just picked) → local blob → store avatar → same-identity OAuth
  // photo → email-keyed cache. Guard the OAuth photo so a different Firebase session can't leak.
  const displayAvatar = userScopedAvatar(
    preview ?? avatarUrl ?? user?.avatar ?? liveOAuthPhotoForEmail(user?.email) ?? getCachedAvatar(user?.email),
    user?.epf_number,
  ) ?? null;
  const isTrainee = (user?.employee_type || '').toLowerCase() === 'trainee';

  if (loading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <PageHeaderSkeleton />
        {/* Profile header skeleton (avatar + identity) */}
        <SkeletonCard className="flex items-center gap-5">
          <Skeleton className="h-20 w-20 rounded-2xl flex-shrink-0" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-3 w-32" />
          </div>
        </SkeletonCard>
        <FormSkeleton fields={3} />
        <FormSkeleton fields={4} />
        <FormSkeleton fields={3} />
      </div>
    );
  }

  return (
    <PageTransition className="space-y-6 max-w-3xl">
      <PageHeader title={t.profileTitle} description={t.profileDesc} icon={User} />

      {/* ── Profile header: gradient cover + overlapping avatar — tap to drop the ID lanyard ── */}
      <Reveal>
        <Card
          role={lanyardEnabled ? 'button' : undefined}
          tabIndex={lanyardEnabled ? 0 : undefined}
          onClick={() => { if (lanyardEnabled) useLanyardStore.getState().openManual(); }}
          onKeyDown={(e) => { if (lanyardEnabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); useLanyardStore.getState().openManual(); } }}
          className={`overflow-hidden p-0${lanyardEnabled ? ' group/idcard cursor-pointer transition-all hover:ring-2 hover:ring-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring' : ''}`}>
          {/* Cover — brand gradient derived from the company (logo colour, else seeded) */}
          <div className="relative h-28 bg-gradient-to-tr from-primary via-primary to-brand sm:h-32"
            style={coverBg ? { backgroundImage: coverBg } : undefined}>
            {/* Crafted surface: soft corner highlight + faint grid so it reads as a surface, not a slab */}
            <div aria-hidden className="absolute inset-0"
              style={{ background: 'radial-gradient(36rem 20rem at 82% -30%, rgba(255,255,255,0.30), transparent 60%)' }} />
            <div aria-hidden className="absolute inset-0 opacity-[0.10]"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(255,255,255,0.7) 1px, transparent 1px),' +
                  'linear-gradient(90deg, rgba(255,255,255,0.7) 1px, transparent 1px)',
                backgroundSize: '28px 28px',
              }} />
            {/* Company logo — transparent PNGs sit straight on the gradient; opaque
                ones simply show as-is. Public URL, set in the companies admin. */}
            {companyLogo && (
              <div className="absolute right-5 top-5 inline-flex items-center rounded-2xl bg-white px-4 py-2.5 shadow-lg ring-1 ring-black/10">
                <img
                  src={companyLogo}
                  alt={user?.company ?? ''}
                  className="h-10 max-w-[200px] object-contain sm:h-12"
                />
              </div>
            )}
            {/* Role — floated on the cover (text tone auto-contrasts with the brand colour) */}
            {user?.role && (
              <div className="absolute left-4 top-4">
                <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 shadow-sm backdrop-blur-sm ${
                  coverTone === 'dark'
                    ? 'bg-slate-900/85 text-white ring-white/20'
                    : 'bg-white/90 text-slate-900 ring-black/10'
                }`}>
                  <Shield className="h-3.5 w-3.5" /> {user.role}
                </span>
              </div>
            )}
          </div>

          <div className="px-5 pb-5">
            <div className="-mt-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              {/* Left: avatar + identity */}
              <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end">
                {/* Avatar (overlaps the cover) */}
                <div className="relative flex-shrink-0">
                  <Avatar className="h-28 w-28 rounded-3xl border-4 border-card shadow-soft ring-1 ring-border">
                    {displayAvatar && (
                      <AvatarImage
                        src={displayAvatar}
                        alt={user?.name}
                        className="rounded-3xl object-cover"
                        // If the fetched stored picture is broken, drop it so we fall back
                        // to the Google/Microsoft photo (which the sidebar already shows).
                        onLoadingStatusChange={(s) => { if (s === 'error' && avatarUrl) setAvatarUrl(null); }}
                      />
                    )}
                    <AvatarFallback className="rounded-3xl bg-gradient-to-br from-primary to-brand text-primary-foreground text-3xl font-bold">
                      {user?.name?.charAt(0).toUpperCase() ?? '?'}
                    </AvatarFallback>
                  </Avatar>
                  {/* Camera button. Both the button's click and the programmatic click it
                      fires on the hidden <input> below sit inside the ID-lanyard <Card>, whose
                      onClick/onKeyDown open the ID modal — so stop propagation on every path
                      (button click + keydown, and the input's own bubbled click) or picking a
                      photo also pops the lanyard behind the file dialog. */}
                  <button
                    onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}
                    onKeyDown={(e) => e.stopPropagation()}
                    aria-label={t.changeProfilePicture}
                    title={t.changeProfilePicture}
                    className="absolute -bottom-1.5 -right-1.5 flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Camera className="h-4 w-4" />
                  </button>
                  <input ref={fileRef} type="file" accept="image/*" className="hidden"
                    onClick={(e) => e.stopPropagation()} onChange={handleImagePick} />
                </div>

                {/* Identity */}
                <div className="min-w-0 flex-1 sm:pb-1.5">
                  <h2 className="truncate text-2xl font-bold tracking-tight text-foreground">{user?.name}</h2>
                  {user?.designation && (
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Briefcase className="h-3.5 w-3.5 flex-shrink-0 text-primary/70" />
                      <span className="truncate">{user.designation}</span>
                    </p>
                  )}
                </div>
              </div>

              {/* Right: meta chips — fill the empty space beside the name on desktop,
                  stack below on mobile. */}
              <div className="flex flex-wrap items-center gap-2 sm:max-w-[48%] sm:justify-end sm:pb-1.5">
                {user?.company && (
                  <Badge variant="muted" className="gap-1.5">
                    <Building2 className="h-3.5 w-3.5 text-primary/70" /> {user.company}
                  </Badge>
                )}
                {user?.department && (
                  <Badge variant="muted" className="gap-1.5">
                    <Contact className="h-3.5 w-3.5 text-primary/70" /> {user.department}
                  </Badge>
                )}
                {user?.epf_number && !noAttendance && (
                  <Badge variant="muted" className="gap-1.5 font-mono tabular-nums">
                    <Fingerprint className="h-3.5 w-3.5 text-primary/70" /> EPF {user.epf_number}
                  </Badge>
                )}
                {user?.employee_type && (
                  <Badge variant="muted" className="gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${isTrainee ? 'bg-brand' : 'bg-primary'}`} />
                    {user.employee_type}
                  </Badge>
                )}
              </div>
            </div>

            {newImage && (
              <div className="mt-4 flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/10 px-2.5 py-1.5 text-[11px] leading-snug text-primary">
                <Camera className="h-3 w-3 flex-shrink-0" />
                {t.newPicSelected}
              </div>
            )}
          </div>
        </Card>
      </Reveal>

      {/* ── Account & identity (read-only + email change) ── */}
      <Reveal delay={0.05}>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center flex-shrink-0">
                <Contact className="w-4 h-4 text-brand" />
              </div>
              <div>
                <CardTitle className="text-sm">{t.accountIdentity}</CardTitle>
                <CardDescription className="text-xs">{t.accountIdentityDesc}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Email — changeable with verification */}
            <div>
              <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-1.5 block">
                {t.emailLabel}
              </Label>
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-md bg-muted border border-border">
                <Mail className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-foreground truncate">{user?.email ?? profile?.email ?? auth.currentUser?.email}</span>
                {!emailEditing && (
                  <button onClick={() => { setEmailEditing(true); setNewEmail(''); setEmailPassword(''); }}
                    className="ml-auto text-[11px] font-semibold text-primary hover:text-primary/80 flex-shrink-0">
                    {t.changeWord}
                  </button>
                )}
              </div>

              {emailEditing && (
                <div className="mt-3 p-3 rounded-md bg-primary/5 border border-primary/20 space-y-3">
                  <div>
                    <Label className="text-[11px] text-muted-foreground font-medium mb-1 block">{t.newEmailAddress}</Label>
                    <Input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                      autoComplete="off" placeholder={t.newEmailPlaceholder}
                      aria-invalid={!!newEmailError} />
                    <InlineError>{newEmailError}</InlineError>
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground font-medium mb-1 block">{t.confirmWithPassword}</Label>
                    <Input type="password" value={emailPassword} onChange={e => setEmailPassword(e.target.value)}
                      autoComplete="current-password" placeholder="••••••••" />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1"
                      onClick={() => { setEmailEditing(false); setNewEmail(''); setEmailPassword(''); }}>
                      {t.cancel}
                    </Button>
                    <Button size="sm" className="flex-1" onClick={handleChangeEmail}
                      disabled={changingEmail || !newEmail.trim() || !!newEmailError || !emailPassword}>
                      {changingEmail ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
                      {t.sendVerification}
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                    <ShieldAlert className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    {t.verificationLinkNote}
                  </p>
                </div>
              )}
            </div>

            {/* EPF number — read-only, copyable (used to link your Solar / Altavision account) */}
            <div>
              <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-1.5 block">
                EPF Number
              </Label>
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-md bg-muted border border-border">
                <Fingerprint className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm font-mono font-medium text-foreground truncate">{user?.epf_number || '—'}</span>
                <button
                  type="button"
                  onClick={copyEpf}
                  disabled={!user?.epf_number}
                  aria-label="Copy EPF number"
                  className="ml-auto flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-50"
                >
                  {copiedEpf
                    ? <><Check className="w-3 h-3 text-success" /> Copied</>
                    : <><Copy className="w-3 h-3" /> Copy</>}
                </button>
              </div>
              <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <ExternalLink className="w-3 h-3 flex-shrink-0 mt-0.5" />
                <span>
                  Can’t be changed. Copy it and paste it at{' '}
                  <a href="http://solar.altavision.lk/profile" target="_blank" rel="noopener noreferrer"
                    className="font-medium text-primary hover:text-primary/80">solar.altavision.lk/profile</a>{' '}
                  to link your Solar account.
                </span>
              </p>
            </div>

            {(profile?.nic || profile?.date_of_birth) && (
              <>
                <Separator />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* NIC — read-only */}
                  {profile?.nic && (
                    <div>
                      <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-1.5 block">
                        {t.nicLabel}
                      </Label>
                      <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-md bg-muted border border-border">
                        <CreditCard className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        <span className="text-sm text-muted-foreground">{profile.nic}</span>
                      </div>
                    </div>
                  )}

                  {/* Date of birth — read-only */}
                  {profile?.date_of_birth && (
                    <div>
                      <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-1.5 block">
                        {t.dateOfBirth}
                      </Label>
                      <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-md bg-muted border border-border">
                        <Calendar className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        <span className="text-sm text-muted-foreground">
                          {new Date(profile.date_of_birth).toLocaleDateString('en-GB', {
                            day: '2-digit', month: 'long', year: 'numeric'
                          })}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </Reveal>

      {/* ── Editable fields ── */}
      <Reveal delay={0.1}>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-success/10 flex items-center justify-center flex-shrink-0">
                <User className="w-4 h-4 text-success" />
              </div>
              <div>
                <CardTitle className="text-sm">{t.personalInformation}</CardTitle>
                <CardDescription className="text-xs">{t.updateContactDetails}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

              {/* Name */}
              <div className="sm:col-span-2">
                <Label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                  {t.fullName} <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground z-10" />
                  <Input type="text" value={form.name}
                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                    className="pl-10"
                    aria-invalid={!!nameError}
                    placeholder={t.fullNamePlaceholder} />
                </div>
                <InlineError>{nameError}</InlineError>
              </div>

              {/* Personal phone */}
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block font-medium">{t.personalPhone}</Label>
                <CustomPhoneInput
                  value={form.personal_phonenumber}
                  onChange={val => setForm(p => ({ ...p, personal_phonenumber: val }))}
                  icon={Phone}
                  placeholder={t.phonePlaceholder}
                  invalid={!!personalPhoneError}
                />
                <InlineError>{personalPhoneError}</InlineError>
              </div>

              {/* Office phone */}
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block font-medium">{t.officePhone}</Label>
                <CustomPhoneInput
                  value={form.office_phonenumber}
                  onChange={val => setForm(p => ({ ...p, office_phonenumber: val }))}
                  icon={Briefcase}
                  placeholder={t.phonePlaceholder}
                  invalid={!!officePhoneError}
                />
                <InlineError>{officePhoneError}</InlineError>
              </div>

              {/* Emergency phone */}
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block font-medium">{t.emergencyContact}</Label>
                <CustomPhoneInput
                  value={form.emergency_phonenumber}
                  onChange={val => setForm(p => ({ ...p, emergency_phonenumber: val }))}
                  icon={Phone}
                  iconColorClass="text-destructive/60"
                  placeholder={t.phonePlaceholder}
                  invalid={!!emergencyPhoneError}
                />
                <InlineError>{emergencyPhoneError}</InlineError>
              </div>

              {/* Address */}
              <div className="sm:col-span-2">
                <Label className="text-xs text-muted-foreground mb-1.5 block font-medium">{t.addressLabel}</Label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-3 w-4 h-4 text-muted-foreground z-10" />
                  <Textarea value={form.address} rows={2}
                    onChange={e => setForm(p => ({ ...p, address: e.target.value }))}
                    className="pl-10 resize-none min-h-0"
                    placeholder={t.homeAddressPlaceholder} />
                </div>
              </div>

            </div>

            <div className="flex justify-end pt-1">
              <Button onClick={handleSave} disabled={saving || profileFormInvalid}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {t.save}
              </Button>
            </div>
          </CardContent>
        </Card>
      </Reveal>

      {/* ── Change Password ── */}
      <Reveal delay={0.15}>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Lock className="w-4 h-4 text-primary" />
              </div>
              <div>
                <CardTitle className="text-sm">{t.password}</CardTitle>
                <CardDescription className="text-xs">{t.passwordDesc}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {(['current', 'new', 'confirm'] as const).map(key => (
                <div key={key}>
                  <Label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                    {key === 'current' ? t.currentPw : key === 'new' ? t.newPw : t.confirmPw}
                  </Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground z-10" />
                    <Input
                      type={showPw[key] ? 'text' : 'password'}
                      value={passwords[key]}
                      onChange={e => setPasswords(p => ({ ...p, [key]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') handleChangePassword(); }}
                      className="pl-10 pr-11"
                      placeholder="••••••••"
                    />
                    <button type="button"
                      onClick={() => setShowPw(p => ({ ...p, [key]: !p[key] }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground z-10">
                      {showPw[key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              ))}

              <div className="flex justify-end pt-1">
                <Button onClick={handleChangePassword} disabled={savingPw}>
                  {savingPw ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
                  {savingPw ? t.saving : t.updatePw}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </Reveal>

      {/* ── Passkeys ── directly under Change Password: both answer "how do I get in?", and
      a person hunting for one will look where the other is. Gated on the tenant flag, so an
      organisation that has not enabled passkeys never sees a card offering them. */}
      {tenant.features.passkeys && (
        <Reveal delay={0.17}>
          <PasskeysCard />
        </Reveal>
      )}

      {/* ── Payslips ── the way in, now that /my-payslips has no sidebar row (see
          useSidebarNav.ts). Gate is byte-for-byte the one that row carried, so the same
          people reach it. A link rather than an inline list: the payslip page needs its own
          stat row, preview dialog and PDF export, and fetching payroll on every profile
          open would cost every employee a request they usually don't want. */}
      {tenant.features.payroll && caps.can_view_own_payslip && (
        <Reveal delay={0.2}>
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-warning/10 flex items-center justify-center flex-shrink-0">
                  <Wallet className="w-4 h-4 text-warning" />
                </div>
                <div>
                  <CardTitle className="text-sm">{t.navMyPayslips}</CardTitle>
                  <CardDescription className="text-xs">
                    Finalized payslip snapshots — preview one or download it as a PDF.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" className="w-full sm:w-auto">
                <Link href="/my-payslips">
                  <Wallet className="w-4 h-4" />
                  Open my payslips
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </Reveal>
      )}

      {/* ── Salary advance & loan requests ── the employee asks here; whoever manages pay
          profiles decides on /salary-advances or /payroll-loans. Needs at least one of the
          two money modules on, otherwise there is nothing to ask for. */}
      {tenant.features.payroll && caps.is_employee && (tenant.features.salaryAdvances || tenant.features.payrollLoans) && user && (
        <Reveal delay={0.22}>
          <MyPayrollRequests epf={user.epf_number ?? ''} user={{ epf_number: user.epf_number ?? '', name: user.name, company_id: user.company_id, company: user.company }} />
        </Reveal>
      )}

      {/* Suspense split-deductions charged to me this month (approved) — Alta Vision only */}
      {tenant.features.suspense && (
        <Reveal delay={0.25}>
          <MyDeductions epf={user?.epf_number ?? ''} />
        </Reveal>
      )}

      {/* My meal count for the current month, broken out by meal — Alta Vision only */}
      {tenant.features.suspense && (
        <Reveal delay={0.3}>
          <MyLunchCount epf={user?.epf_number ?? ''} />
        </Reveal>
      )}
    </PageTransition>
  );
}
