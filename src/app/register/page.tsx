'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  UserPlus,
  Eye,
  EyeOff,
  CheckCircle2,
  ArrowLeft,
  ShieldCheck,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { tenant } from '@/lib/firebase';
import { primaryDomain } from '@/lib/tenants';
import { useT } from '@/store/appStore';
import { AuthBrandPanel, EASE } from '@/components/AuthBrandPanel';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import ThemeToggle from '@/components/ThemeToggle';
import Select from '@/components/Select';
import {
  isValidEmail,
  isValidNIC,
  isValidLocalPhone,
  sanitizeNICInput,
  sanitizePhoneInput,
} from '@/lib/validation';

// Public self-registration — ONLY meant for the carecode.org tenant ("southernlanka" in
// src/lib/tenants.ts). `tenant` is already resolved from the hostname (or the
// NEXT_PUBLIC_FIRESTORE_DB_ID fallback for localhost/preview) by src/lib/firebase.ts, so
// gating on it here keeps this page dead on every other domain (e.g. altavision.lk)
// without a separate host check.
const ALLOWED_TENANT_ID = 'southernlanka';

const GENDER_OPTIONS = [
  { value: 'Male', label: 'Male' },
  { value: 'Female', label: 'Female' },
];

const emptyForm = {
  full_name: '',
  name_with_initials: '',
  nic: '',
  gender: '',
  email: '',
  phone_personal: '',
  guardian_contact: '',
  address: '',
  password: '',
  confirm: '',
};

export default function RegisterPage() {
  const router = useRouter();
  const t = useT();
  const allowed = tenant.id === ALLOWED_TENANT_ID;

  const [form, setForm] = useState(emptyForm);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof typeof form, string>>
  >({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Not the carecode.org tenant — this page doesn't exist here. Bounce to login.
  useEffect(() => {
    if (!allowed) router.replace('/login');
  }, [allowed, router]);

  const clearFieldError = (k: keyof typeof form) =>
    setFieldErrors((prev) => (prev[k] ? { ...prev, [k]: undefined } : prev));

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((f) => ({ ...f, [k]: e.target.value }));
      clearFieldError(k);
    };

  // NIC / contact fields are format-constrained as they're typed (digits only, length
  // caps, uppercased NIC letter) so they can never hold arbitrary text — see
  // src/lib/validation.ts.
  const setNic = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, nic: sanitizeNICInput(e.target.value) }));
    clearFieldError('nic');
  };
  const setPhone =
    (k: 'phone_personal' | 'guardian_contact') =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((f) => ({ ...f, [k]: sanitizePhoneInput(e.target.value) }));
      clearFieldError(k);
    };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    const fullName = form.full_name.trim();
    const nameWithInitials = form.name_with_initials.trim();
    const nic = form.nic.trim();
    const email = form.email.trim().toLowerCase();
    const phone = form.phone_personal.trim();
    const guardianContact = form.guardian_contact.trim();
    const address = form.address.trim();

    if (
      !fullName ||
      !nameWithInitials ||
      !nic ||
      !form.gender ||
      !phone ||
      !address ||
      !form.password
    ) {
      setError('Please fill in every required field.');
      return;
    }
    // Strict format checks — NIC, email and contact number must match their required
    // shapes before anything is submitted (see src/lib/validation.ts). Errors are shown
    // inline under each field.
    const nextFieldErrors: Partial<Record<keyof typeof form, string>> = {};
    if (!isValidNIC(nic)) {
      nextFieldErrors.nic =
        'Enter a valid NIC — 12 digits, or 9 digits followed by V.';
    }
    // Email is optional — the contact number above is enough to sign in with (see
    // src/lib/phone.ts / /api/resolve-login). Only validate the format when given.
    if (email && !isValidEmail(email)) {
      nextFieldErrors.email =
        'Enter a valid email address, e.g. name@example.com.';
    }
    if (!isValidLocalPhone(phone)) {
      nextFieldErrors.phone_personal =
        'Enter a valid 10-digit contact number, e.g. 0771234567.';
    }
    if (guardianContact && !isValidLocalPhone(guardianContact)) {
      nextFieldErrors.guardian_contact =
        'Enter a valid 10-digit contact number, e.g. 0771234567.';
    }
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      setError('Please correct the highlighted fields.');
      return;
    }
    if (form.password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (form.password !== form.confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      // All the work (uniqueness checks, Auth account, Firestore profile) happens
      // server-side via firebase-admin — see src/app/api/register/route.ts. That avoids
      // needing to sign the browser into the new account just to satisfy Firestore rules,
      // and re-validates the carecode.org-only restriction server-side too.
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName,
          name_with_initials: nameWithInitials,
          nic,
          gender: form.gender,
          email,
          phone_personal: phone,
          guardian_contact: guardianContact,
          address,
          password: form.password,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Registration failed. Please try again.');
        return;
      }
      setDone(true);
    } catch (err: unknown) {
      console.error('[register]', err);
      setError('Registration failed. Please try again.');
      toast.error('Registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Wrong tenant — render nothing while the redirect above kicks in.
  if (!allowed) return null;

  return (
    <div className="h-[100dvh] overflow-hidden grid grid-cols-1 lg:grid-cols-2 bg-background">
      {/* ── Brand panel (desktop only) ── */}
      <AuthBrandPanel />

      {/* ── Form panel ── */}
      <main className="relative overflow-y-auto">
        {/* Subtle ambient glow on mobile/tablet where the brand panel is hidden */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden lg:hidden"
        >
          <div className="absolute -right-32 -top-32 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute -bottom-32 -left-32 h-80 w-80 rounded-full bg-brand/10 blur-3xl" />
        </div>

        {/* min-h-full + items-center centers the form when it fits and scrolls when it
            doesn't — so the submit button is reachable on any screen height. */}
        <div className="flex min-h-full items-center justify-center p-4 py-8 sm:p-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="relative z-10 w-full max-w-md"
          >
            <div className="safe-top-spacer lg:hidden mb-4" />
            {/* Mobile brand mark */}
            <div className="mb-8 flex items-center justify-center gap-3 lg:hidden">
              <img
                src="/icon.png"
                alt=""
                className="h-9 w-9 rounded-lg object-contain"
              />
              <div className="text-center">
                <div className="text-xl font-bold tracking-tight text-foreground">
                  Pearl<span className="text-primary">Cluster</span>
                </div>
                <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  {t.enterpriseSuite}
                </div>
              </div>
            </div>

            <div className="glass-strong rounded-2xl p-7 shadow-soft sm:p-8 relative">
              <div className="absolute right-4 top-4">
                <ThemeToggle className="w-8 h-8" />
              </div>

              <AnimatePresence mode="wait">
                {done ? (
                  <motion.div
                    key="done"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center space-y-4 py-6"
                  >
                    <div className="mx-auto w-14 h-14 rounded-full bg-success/10 flex items-center justify-center">
                      <CheckCircle2 className="w-7 h-7 text-success" />
                    </div>
                    <div className="space-y-1.5">
                      <h1 className="text-lg font-semibold text-foreground">
                        Registration submitted
                      </h1>
                      <p className="text-sm text-muted-foreground">
                        Your account has been created and is pending review. An
                        admin will activate it and assign you an employee
                        number — you&apos;ll be able to log in with your email
                        (if you gave one) or that employee number, and the
                        password you just set, once that happens.
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => router.push('/login')}
                    >
                      <ArrowLeft className="w-4 h-4" /> Back to sign in
                    </Button>
                  </motion.div>
                ) : (
                  <motion.div
                    key="form"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                  >
                    <div className="mb-7 flex items-center gap-3">
                      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-primary/10">
                        <UserPlus className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                          Create your account
                        </h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {tenant.appName} · {primaryDomain(tenant)} — needs admin approval
                          before sign-in.
                        </p>
                      </div>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-5">
                      <div className="space-y-1.5">
                        <Label htmlFor="full_name">Full name</Label>
                        <Input
                          id="full_name"
                          value={form.full_name}
                          onChange={set('full_name')}
                          placeholder="Enter your full name"
                          autoComplete="name"
                          className="h-11"
                          required
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="name_with_initials">
                          Name with initials
                        </Label>
                        <Input
                          id="name_with_initials"
                          value={form.name_with_initials}
                          onChange={set('name_with_initials')}
                          placeholder="Enter your name with initials"
                          className="h-11"
                          required
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label htmlFor="nic">NIC number</Label>
                          <Input
                            id="nic"
                            value={form.nic}
                            onChange={setNic}
                            placeholder="Enter your NIC number"
                            className="h-11"
                            inputMode="text"
                            autoCapitalize="characters"
                            maxLength={12}
                            aria-invalid={!!fieldErrors.nic}
                            required
                          />
                          {fieldErrors.nic && (
                            <p className="text-xs text-destructive">
                              {fieldErrors.nic}
                            </p>
                          )}
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="gender">Gender</Label>
                          <Select
                            value={form.gender}
                            onChange={(v) =>
                              setForm((f) => ({ ...f, gender: v }))
                            }
                            options={GENDER_OPTIONS}
                            placeholder="Select gender"
                          />
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="email">Email (optional)</Label>
                        <Input
                          id="email"
                          type="email"
                          value={form.email}
                          onChange={set('email')}
                          autoComplete="email"
                          placeholder="e.g. name@example.com"
                          className="h-11"
                          aria-invalid={!!fieldErrors.email}
                        />
                        {fieldErrors.email && (
                          <p className="text-xs text-destructive">
                            {fieldErrors.email}
                          </p>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label htmlFor="phone_personal">Contact number</Label>
                          <Input
                            id="phone_personal"
                            type="tel"
                            inputMode="numeric"
                            maxLength={10}
                            value={form.phone_personal}
                            onChange={setPhone('phone_personal')}
                            autoComplete="tel"
                            placeholder="e.g. 0771234567"
                            className="h-11"
                            aria-invalid={!!fieldErrors.phone_personal}
                            required
                          />
                          {fieldErrors.phone_personal && (
                            <p className="text-xs text-destructive">
                              {fieldErrors.phone_personal}
                            </p>
                          )}
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="guardian_contact">
                            Guardian contact (optional)
                          </Label>
                          <Input
                            id="guardian_contact"
                            type="tel"
                            inputMode="numeric"
                            maxLength={10}
                            value={form.guardian_contact}
                            onChange={setPhone('guardian_contact')}
                            autoComplete="tel"
                            placeholder="e.g. 0771234567"
                            className="h-11"
                            aria-invalid={!!fieldErrors.guardian_contact}
                          />
                          {fieldErrors.guardian_contact && (
                            <p className="text-xs text-destructive">
                              {fieldErrors.guardian_contact}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="address">Address</Label>
                        <Textarea
                          id="address"
                          value={form.address}
                          onChange={set('address')}
                          autoComplete="street-address"
                          rows={2}
                          placeholder="Enter your address"
                          required
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="password">Password</Label>
                        <div className="relative">
                          <Input
                            id="password"
                            type={showPw ? 'text' : 'password'}
                            value={form.password}
                            onChange={set('password')}
                            autoComplete="new-password"
                            placeholder="Enter your password"
                            className="h-11 pr-10"
                            required
                          />
                          <button
                            type="button"
                            onClick={() => setShowPw((s) => !s)}
                            aria-label={
                              showPw ? t.hidePassword : t.showPassword
                            }
                            aria-pressed={showPw}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                          >
                            {showPw ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="confirm">Confirm password</Label>
                        <Input
                          id="confirm"
                          type={showPw ? 'text' : 'password'}
                          value={form.confirm}
                          onChange={set('confirm')}
                          autoComplete="new-password"
                          placeholder="Confirm your password"
                          className="h-11"
                          required
                        />
                      </div>

                      <AnimatePresence>
                        {error && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                              {error}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <Button
                        type="submit"
                        disabled={submitting}
                        size="lg"
                        className="w-full"
                      >
                        {submitting ? (
                          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
                        ) : (
                          <>
                            <ShieldCheck className="h-4 w-4" /> Submit for
                            approval
                          </>
                        )}
                      </Button>

                      <button
                        type="button"
                        onClick={() => router.push('/login')}
                        className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
                      >
                        Already have an account? Sign in
                      </button>
                    </form>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Mobile trust line (brand panel hidden) */}
            <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground lg:hidden">
              <ShieldCheck className="h-3.5 w-3.5" /> {t.trustLine}
            </p>
          </motion.div>
        </div>
      </main>
    </div>
  );
}
