'use client';
import { useState, useEffect } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  Clock, CloudOff, CheckCircle2, MapPin, Palmtree, CalendarDays, Users, Check, X, Moon, Bell,
  GitBranch, Link2, TrendingUp, ShieldCheck, Send, Lock, AlertCircle, ArrowRight,
} from 'lucide-react';
import { useT, useAppStore } from '@/store/appStore';
import { useBrandName } from '@/lib/brand';
import dynamic from 'next/dynamic';

// WebGL grid-scan brand background — client-only (pulls three/postprocessing), so it
// never runs on the server and only loads on the desktop split where the panel shows.
const GridScan = dynamic(() => import('@/components/GridScan/GridScan').then(m => m.GridScan), { ssr: false });

export const EASE = [0.22, 1, 0.36, 1] as const;

const HEADLINES: Record<string, string[]> = {
  en: [
    'Workforce attendance, beautifully simple.',
    'Leave management, made effortless.',
    'Team approvals, on the go.',
    'Fully editable org hierarchy.',
    'Connect with your favorite apps.',
    'Task logging & time tracking.',
    'Secure, one-tap social SSO.',
    'Comprehensive admin oversight.',
  ],
  si: [
    'සේවක පැමිණීම, සරලව හා ලස්සනට.',
    'නිවාඩු කළමනාකරණය, වඩාත් පහසුවෙන්.',
    'කණ්ඩායම් අනුමැතීන්, ඕනෑම තැනකදී.',
    'පූර්ණ ලෙස සංස්කරණය කළ හැකි සේවා ධූරාවලිය.',
    'වෙනත් යෙදුම් සමඟ පහසුවෙන් සම්බන්ධ වන්න.',
    'කාර්යයන් සටහන් කිරීම සහ කාලය නිරීක්ෂණය.',
    'එක්-ස්පර්ශයකින් සුරක්ෂිත සමාජ මාධ්‍ය පිවිසුම.',
    'සම්පූර්ණ පරිපාලක පාලනය සහ අධීක්ෂණය.',
  ],
  ta: [
    'பணியாளர் வருகை, அழகாக எளிமையாக.',
    'விடுப்பு மேலாண்மை, மிகவும் எளிமையானது.',
    'குழு ஒப்புதல்கள், எங்கும்.',
    'முழுமையாக திருத்தக்கூடிய படிநிலை அமைப்பு.',
    'உங்களுக்கு பிடித்த பயன்பாடுகளுடன் இணைக்கவும்.',
    'பணிப்பதிவு & நேரத்தைக் கண்காணித்தல்.',
    'பாதுகாப்பான, ஒரு-தொடு சமூக SSO லாகின்.',
    'விரிவான நிர்வாகி மேற்பார்வை மற்றும் கட்டுப்பாடு.',
  ],
};

const TAGLINES: Record<string, string[]> = {
  en: [
    'Check in, request leave, and approve your team — on any device, even when the signal drops.',
    'Apply for leave, check remaining balances, and track approvals on any device.',
    'Review and approve team attendance corrections, check-ins, and leaves in seconds.',
    'Manage reporting structures, define supervisor trees, and edit role permissions dynamically.',
    'Sync attendance records, trigger webhooks, and connect with external HR and payroll software.',
    'Track hours logged on specific projects, manage daily tasks, and submit client timesheets.',
    'Sign in securely with one tap using your work Google, Microsoft, or Azure AD accounts.',
    'Monitor live check-in geofences, view absent lists, and download audit-ready compliance reports.',
  ],
  si: [
    'ඕනෑම උපාංගයකින් පිරික්සන්න, නිවාඩු ඉල්ලන්න, සහ ඔබගේ කණ්ඩායම අනුමත කරන්න — සංඥාව නැති වුවද.',
    'ඕනෑම උපාංගයකින් නිවාඩු සඳහා අයදුම් කරන්න, ශේෂයන් පරීක්ෂා කරන්න සහ අනුමැතිය නිරීක්ෂණය කරන්න.',
    'කණ්ඩායම් සාමාජිකයින්ගේ පැමිණීම් නිවැරදි කිරීම්, පිරික්සීම් සහ නිවාඩු තත්පර කිහිපයකින් සමාලෝචනය කර අනුමත කරන්න.',
    'සේවා වාර්තාකරණ ව්‍යුහයන්, අධීක්ෂක ගස් සහ භූමිකාවන්හි අවසරයන් සක්‍රීයව කළමනාකරණය කරන්න.',
    'පැමිණීම් වාර්තා සමමුහුර්ත කරන්න, වෙබ්හුක් ක්‍රියාත්මක කරන්න සහ බාහිර වැටුප් ලේඛන මෘදුකාංග සමඟ සම්බන්ධ වන්න.',
    'විශේෂිත ව්‍යාපෘති සඳහා වැය කළ කාලය සටහන් කරන්න, දෛනික කාර්යයන් කළමනාකරණය කර කාලසටහන් ඉදිරිපත් කරන්න.',
    'ඔබගේ Google හෝ Microsoft ව්‍යාපාරික ගිණුම් භාවිතයෙන් එක් තට්ටුවකින් සුරක්ෂිතව පිවිසෙන්න.',
    'සක්‍රිය සේවකයින්ගේ පිහිටීම් සිතියම්, නොපැමිණි ලැයිස්තු සහ විගණන වාර්තා සජීවීව නිරීක්ෂණය කරන්න.',
  ],
  ta: [
    'எந்த சாதனத்திலும் செக்-இன் செய்யவும், விடுப்பு கோரவும், உங்கள் குழுவிற்கு ஒப்புதல் அளிக்கவும் - சிக்னல் குறைந்தாலும்.',
    'எந்த சாதனத்திலும் விடுப்புக்கு விண்ணப்பம் செய்க, நிலுவைகளை சரிபார்க்கவும் மற்றும் ஒப்புதல்களைக் கண்காணிக்கவும்.',
    'குழு வருகை திருத்தங்கள், செக்-இன்கள் மற்றும் விடுப்புகளை நொடிகளில் மதிப்பாய்வு செய்து அங்கீகரிக்கவும்.',
    'அறிக்கையிடல் கட்டமைப்புகள், மேற்பார்வையாளர் மரங்களை நிர்வகிக்கவும் மற்றும் பாத்திர அனுமதிகளைத் திருத்தவும்.',
    'வருகைப் பதிவுகளை ஒத்திசைக்கவும், வெப்ஹுக்குகளைத் தூண்டவும் மற்றும் வெளிப்புற ஊதிய மென்பொருளுடன் இணைக்கவும்.',
    'குறிப்பிட்ட திட்டங்களில் உள்நுழைந்த நேரத்தைக் கண்காணிக்கவும், தினசரி பணிகளை நிர்வகிக்கவும்.',
    'உங்கள் Google அல்லது Microsoft கணக்குகளைப் பயன்படுத்தி ஒரு தொடுதலில் பாதுகாப்பாக உள்நுழையவும்.',
    'நேரடி வருகை வரைபடங்கள், வராதோர் பட்டியல்கள் மற்றும் தணிக்கை அறிக்கைகளைச் சரிபார்க்கவும்.',
  ],
};

const CHIP_TITLES: Record<string, string[][]> = {
  en: [
    ['One-tap attendance', 'Auto location', 'Overnight shifts'],
    ['Leave balance', 'Instant requests', 'Works offline'],
    ['Approvals on the go', 'Manager override', 'Instant alerts'],
    ['Editable tree', 'Supervisor routing', 'Dynamic roles'],
    ['Webhook triggers', 'API credentials', 'External sync'],
    ['Project tracking', 'Timesheets', 'Client billing'],
    ['SSO credentials', 'Google & MS', 'Safe access'],
    ['Check-in map', 'Absent tracking', 'Audit logs'],
  ],
  si: [
    ['එක්-ස්පර්ශ පැමිණීම', 'ස්වයංක්‍රීය ස්ථානය', 'රාත්‍රී සේවා මාරු'],
    ['නිවාඩු ශේෂයන්', 'ක්ෂණික ඉල්ලීම්', 'නොබැඳිව ක්‍රියා කරයි'],
    ['ගමනේදීම අනුමැති', 'පරිපාලක පාලනය', 'ක්ෂණික දැනුම්දීම්'],
    ['සංස්කරණ ගස', 'වාර්තාකරණ ව්‍යුහය', 'ගතික භූමිකාවන්'],
    ['වෙබ්හුක් ක්‍රියාකාරකම්', 'API අක්තපත්‍ර', 'බාහිර සමමුහුර්තකරණය'],
    ['ව්‍යාපෘති නිරීක්ෂණය', 'කාලසටහන්', 'ගනුදෙනුකරුවන් බිල්පත්'],
    ['SSO පිවිසුම', 'Google සහ MS', 'සුරක්ෂිත ප්‍රවේශය'],
    ['පැමිණීම් සිතියම', 'නොපැමිණි ලැයිස්තු', 'විගණන වාර්තා'],
  ],
  ta: [
    ['ஒரு-தொடு வருகை', 'தானியங்கி இருப்பிடம்', 'இரவு ஷிப்டுகள்'],
    ['விடுப்பு நிலுவை', 'உடனடி கோரிக்கைகள்', 'ஆஃப்லைனில் வேலை செய்யும்'],
    ['ஒப்புதல்கள் பயணத்தில்', 'மேலாளர் மேலெழுத்து', 'உடனடி விழிப்பூட்டல்கள்'],
    ['திருத்தக்கூடிய மரம்', 'மேற்பார்வை மரங்கள்', 'பணிப் பொறுப்புகள்'],
    ['வெப்ஹுக் தூண்டிகள்', 'API சான்றுகள்', 'வெளிப்புற ஒத்திசைவு'],
    ['திட்டக் கண்காணிப்பு', 'நேர அட்டவணைகள்', 'வாடிக்கையாளர் பில்லிங்'],
    ['SSO சான்றுகள்', 'Google & MS', 'பாதுகாப்பான அணுகல்'],
    ['செக்-இன் வரைபடம்', 'வராதோர் கண்காணிப்பு', 'தணிக்கை பதிவுகள்'],
  ],
};

const ALL_HIGHLIGHTS = [
  [
    { icon: Clock,        titleKey: 0 },
    { icon: MapPin,       titleKey: 1 },
    { icon: Moon,         titleKey: 2 },
  ],
  [
    { icon: Palmtree,     titleKey: 0 },
    { icon: CalendarDays, titleKey: 1 },
    { icon: CloudOff,     titleKey: 2 },
  ],
  [
    { icon: CheckCircle2, titleKey: 0 },
    { icon: ShieldCheck,  titleKey: 1 },
    { icon: Bell,         titleKey: 2 },
  ],
  [
    { icon: Users,        titleKey: 0 },
    { icon: Users,        titleKey: 1 },
    { icon: ShieldCheck,  titleKey: 2 },
  ],
  [
    { icon: Send,         titleKey: 0 },
    { icon: Lock,         titleKey: 1 },
    { icon: CloudOff,     titleKey: 2 },
  ],
  [
    { icon: Clock,        titleKey: 0 },
    { icon: CalendarDays, titleKey: 1 },
    { icon: Send,         titleKey: 2 },
  ],
  [
    { icon: Lock,         titleKey: 0 },
    { icon: CheckCircle2, titleKey: 1 },
    { icon: ShieldCheck,  titleKey: 2 },
  ],
  [
    { icon: MapPin,       titleKey: 0 },
    { icon: AlertCircle,  titleKey: 1 },
    { icon: ShieldCheck,  titleKey: 2 },
  ],
];

// The rotating brand/marketing panel shown on the left of every full-screen auth page
// (login, register, …). Self-contained — manages its own carousel + WebGL background
// state — so any auth page can drop it in for a consistent split-screen layout.
export function AuthBrandPanel() {
  const t = useT();
  const lang = useAppStore(s => s.lang);
  // One build serves every domain, so the wordmark comes from the hostname, not a constant.
  const brand = useBrandName();
  const [slideIndex, setSlideIndex] = useState(0);
  // Theme-aware colours for the WebGL grid-scan background (reads the applied
  // .dark/.light class so it tracks the app theme, incl. system changes).
  const [gridDark, setGridDark] = useState(true);
  useEffect(() => {
    const compute = () => setGridDark(document.documentElement.classList.contains('dark'));
    compute();
    const mo = new MutationObserver(compute);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  const reduceMotion = useReducedMotion();

  // GridScan is a decorative WebGL grid that pulls in ~800KB of three.js +
  // postprocessing. It only appears on the lg brand panel (hidden below lg) and is
  // pointless under reduced-motion. Because <GridScan> is a client dynamic import,
  // simply rendering it — even inside the `hidden` aside — triggers that download on
  // EVERY device, including mobile where the panel is display:none. So gate the mount
  // on a real desktop media query + reduced-motion, and defer to idle so it never
  // blocks first paint. Below lg (Lighthouse's default emulation) the import never
  // even fires, cutting ~800KB of main-thread JS off the critical path.
  const [mountGrid, setMountGrid] = useState(false);
  useEffect(() => {
    if (reduceMotion) { setMountGrid(false); return; }
    const mq = window.matchMedia('(min-width: 1024px)');
    let idleId: number | undefined;
    const ric = window.requestIdleCallback || ((cb: () => void) => window.setTimeout(cb, 200) as unknown as number);
    const cic = window.cancelIdleCallback || window.clearTimeout;
    const apply = () => {
      if (mq.matches) idleId = ric(() => setMountGrid(true)) as unknown as number;
      else setMountGrid(false);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => { mq.removeEventListener('change', apply); if (idleId != null) cic(idleId); };
  }, [reduceMotion]);

  useEffect(() => {
    const id = setInterval(() => {
      setSlideIndex(prev => (prev + 1) % 8);
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const headlines = HEADLINES[lang] ?? HEADLINES.en;
  const taglines = TAGLINES[lang] ?? TAGLINES.en;
  const currentHeadline = headlines[slideIndex];
  const currentTagline = taglines[slideIndex];
  const currentChipTitles = CHIP_TITLES[lang] ?? CHIP_TITLES.en;
  const currentHighlights = ALL_HIGHLIGHTS[slideIndex].map(h => ({
    icon: h.icon,
    title: currentChipTitles[slideIndex][h.titleKey],
  }));

  return (
    <aside className="relative isolate hidden lg:flex flex-col overflow-hidden p-8 xl:p-12 text-primary-foreground">
      <div aria-hidden className="absolute inset-0 -z-20 bg-gradient-to-br from-[#0a75a5] via-[#043247] to-[#021822]" />
      {/* Ambient mesh + grid so the gradient reads as a crafted surface, not a flat fill */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(40rem 30rem at 85% -10%, rgba(255,255,255,0.2), transparent 60%),' +
            'radial-gradient(36rem 30rem at -10% 110%, rgba(12,142,202,0.30), transparent 60%)',
        }}
      />
      {/* Animated WebGL grid-scan effect — mouse-reactive perspective grid with a
          sweeping scan beam. Sits over the gradient, under the content. */}
      <div aria-hidden className="absolute inset-0 -z-10">
        {mountGrid && <GridScan
          className="h-full w-full"
          sensitivity={0.55}
          lineThickness={1}
          linesColor={gridDark ? '#1C5470' : '#2A6E90'}
          scanColor={gridDark ? '#7DD3FC' : '#BAE6FD'}
          scanOpacity={0.6}
          gridScale={0.07}
          lineStyle="solid"
          lineJitter={0.1}
          scanDirection="forward"
          noiseIntensity={0.01}
          scanGlow={0.7}
          scanSoftness={2}
          scanDuration={2}
          scanDelay={2}
          scanOnClick={false}
          enablePost={false}
        />}
      </div>

      {/* Brand mark */}
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-foreground/10 ring-1 ring-primary-foreground/20 backdrop-blur-sm">
          <img src="/icon.png" alt="" className="h-7 w-7 rounded-md object-contain" />
        </div>
        <div>
          <div className="text-lg font-bold tracking-tight" data-brand suppressHydrationWarning>{brand}</div>
          <div className="text-[10px] font-medium uppercase tracking-[0.25em] text-primary-foreground/70">{t.enterpriseSuite}</div>
        </div>
      </div>

      {/* Headline + live product preview — fills the middle, scrolls if a short
          viewport can't fit it (so the brand mark + trust line never overlap). */}
      <div className="flex min-h-0 flex-1 flex-col justify-center max-w-md py-6 scrollbar-none overflow-y-auto">
        <div className="min-h-[140px] flex flex-col justify-end">
          <AnimatePresence mode="wait">
            <motion.div
              key={slideIndex}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.35, ease: EASE }}
            >
              <h2 className="text-3xl 2xl:text-4xl font-semibold leading-tight tracking-tight">
                {currentHeadline}
              </h2>
              <p className="mt-3 text-sm text-primary-foreground/80 leading-relaxed">
                {currentTagline}
              </p>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Floating preview — a glimpse of the real attendance UI (rotating carousel) */}
        <motion.div
          initial={{ opacity: 0, y: 24, rotate: -3 }} animate={{ opacity: 1, y: 0, rotate: -3 }}
          transition={{ duration: 0.6, ease: EASE, delay: 0.2 }}
          className="mt-10 w-72 ml-3 rounded-2xl border border-primary-foreground/20 bg-primary-foreground/10 p-4 shadow-2xl backdrop-blur-md h-[210px] flex flex-col justify-between"
        >
          <AnimatePresence mode="wait">
            {slideIndex === 0 && (
              <motion.div
                key="attendance"
                initial={{ opacity: 0, x: 15 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -15 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex-1 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary-foreground/70">
                    <Clock className="h-3 w-3" /> Today
                  </span>
                  <span className="flex items-center gap-1.5 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[11px] font-semibold">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> Checked in
                  </span>
                </div>
                <div className="mt-3">
                  <div className="font-mono text-3xl font-bold tracking-tight">09:41</div>
                  <div className="mt-0.5 flex items-center gap-1 text-[11px] text-primary-foreground/70">
                    <MapPin className="h-3 w-3" /> On site · in range
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2 rounded-full border border-primary-foreground/20 bg-primary-foreground/10 p-1">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-foreground text-primary shadow">
                    <ArrowRight className="h-4 w-4" />
                  </span>
                  <span className="text-xs font-medium text-primary-foreground/80">Swipe to check out</span>
                </div>
              </motion.div>
            )}

            {slideIndex === 1 && (
              <motion.div
                key="leave"
                initial={{ opacity: 0, x: 15 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -15 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex-1 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary-foreground/70">
                    <Palmtree className="h-3 w-3" /> Request Leave
                  </span>
                  <span className="flex items-center gap-1.5 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[11px] font-semibold">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Pending
                  </span>
                </div>
                <div className="mt-3">
                  <div className="text-lg font-bold tracking-tight leading-tight">Annual Leave</div>
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-primary-foreground/70">
                    <CalendarDays className="h-3 w-3" /> Jul 10 – Jul 14 · 5 Days
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2 rounded-full border border-primary-foreground/20 bg-primary-foreground/10 p-1">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-foreground text-primary shadow">
                    <ArrowRight className="h-4 w-4" />
                  </span>
                  <span className="text-xs font-medium text-primary-foreground/80">Swipe for approval</span>
                </div>
              </motion.div>
            )}

            {slideIndex === 2 && (
              <motion.div
                key="approvals"
                initial={{ opacity: 0, x: 15 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -15 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex-1 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary-foreground/70">
                    <Users className="h-3 w-3" /> Team Approvals
                  </span>
                  <span className="flex items-center gap-1.5 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" /> Action Required
                  </span>
                </div>
                <div className="mt-3">
                  <div className="text-[13px] font-bold tracking-tight leading-tight">Dilan Silva · Correction</div>
                  <div className="mt-1 text-[11px] text-primary-foreground/70 leading-snug">
                    Requested check-in at 08:30 AM
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <div className="flex-1 flex items-center justify-center gap-1 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-[10px] font-bold py-1.5 shadow">
                    <Check className="w-3 h-3" /> Approve
                  </div>
                  <div className="flex-1 flex items-center justify-center gap-1 rounded-lg bg-destructive hover:bg-destructive/90 text-white text-[10px] font-bold py-1.5 shadow">
                    <X className="w-3 h-3" /> Reject
                  </div>
                </div>
              </motion.div>
            )}

            {slideIndex === 3 && (
              <motion.div
                key="hierarchy"
                initial={{ opacity: 0, x: 15 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -15 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex-1 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary-foreground/70">
                    <GitBranch className="h-3 w-3" /> Org Hierarchy
                  </span>
                  <span className="flex items-center gap-1.5 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Live
                  </span>
                </div>
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary-foreground/15 text-[9px] font-bold">NP</span>
                    <span className="text-[11px] font-semibold">Nimal P. · Director</span>
                  </div>
                  <div className="ml-3 space-y-1.5 border-l border-primary-foreground/20 pl-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary-foreground/15 text-[9px] font-bold">KS</span>
                      <span className="text-[11px] font-medium text-primary-foreground/85">Kasun S. · Manager</span>
                    </div>
                    <div className="ml-3 border-l border-primary-foreground/20 pl-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary-foreground text-primary text-[9px] font-bold">You</span>
                        <span className="text-[11px] font-semibold">You · Technician</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-primary-foreground/60">
                  <Users className="h-3 w-3" /> Drag to restructure · 24 people
                </div>
              </motion.div>
            )}

            {slideIndex === 4 && (
              <motion.div
                key="api"
                initial={{ opacity: 0, x: 15 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -15 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex-1 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary-foreground/70">
                    <Link2 className="h-3 w-3" /> Integrations
                  </span>
                  <span className="flex items-center gap-1.5 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[11px] font-semibold text-sky-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse" /> Live API
                  </span>
                </div>
                <div className="mt-3 space-y-1.5">
                  {[
                    { in: 'S', name: 'Slack', status: 'Connected' },
                    { in: 'P', name: 'Payroll HRIS', status: 'Synced' },
                    { in: 'W', name: 'Webhooks', status: 'Active' },
                  ].map((a) => (
                    <div key={a.name} className="flex items-center gap-2 rounded-lg bg-primary-foreground/10 px-2 py-1.5">
                      <span className="flex h-5 w-5 items-center justify-center rounded-md bg-primary-foreground/20 text-[9px] font-bold">{a.in}</span>
                      <span className="flex-1 text-[11px] font-medium">{a.name}</span>
                      <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-300">
                        <Check className="h-3 w-3" /> {a.status}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-primary-foreground/60">
                  <Send className="h-3 w-3" /> 14 events synced today
                </div>
              </motion.div>
            )}

            {slideIndex === 5 && (
              <motion.div
                key="tasks"
                initial={{ opacity: 0, x: 15 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -15 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex-1 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary-foreground/70">
                    <Clock className="h-3 w-3" /> Timesheet
                  </span>
                  <span className="flex items-center gap-1.5 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Tracking
                  </span>
                </div>
                <div className="mt-3 space-y-1.5">
                  {[
                    { task: 'Site survey · Colombo', h: '3h 20m' },
                    { task: 'Client report', h: '1h 45m' },
                  ].map((r) => (
                    <div key={r.task} className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11px] font-medium text-primary-foreground/85">{r.task}</span>
                      <span className="font-mono text-[11px] font-semibold tabular-nums">{r.h}</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between border-t border-primary-foreground/15 pt-1.5">
                    <span className="text-[11px] font-semibold">Today total</span>
                    <span className="font-mono text-sm font-bold tabular-nums">5h 05m</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-primary-foreground/60">
                  <CalendarDays className="h-3 w-3" /> 3 projects this week
                </div>
              </motion.div>
            )}

            {slideIndex === 6 && (
              <motion.div
                key="sso"
                initial={{ opacity: 0, x: 15 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -15 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex-1 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary-foreground/70">
                    <Lock className="h-3 w-3" /> Social SSO
                  </span>
                  <span className="flex items-center gap-1.5 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Active SSO
                  </span>
                </div>
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2 rounded-lg bg-primary-foreground px-3 py-2 shadow">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0" aria-hidden="true">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
                    </svg>
                    <span className="text-[11px] font-semibold text-slate-700">Continue with Google</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg bg-primary-foreground px-3 py-2 shadow">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0" aria-hidden="true">
                      <path fill="#F25022" d="M1 1h10v10H1z" />
                      <path fill="#7FBA00" d="M13 1h10v10H13z" />
                      <path fill="#00A4EF" d="M1 13h10v10H1z" />
                      <path fill="#FFB900" d="M13 13h10v10H13z" />
                    </svg>
                    <span className="text-[11px] font-semibold text-slate-700">Continue with Microsoft</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-primary-foreground/60">
                  <ShieldCheck className="h-3 w-3" /> Protected by Azure AD
                </div>
              </motion.div>
            )}

            {slideIndex === 7 && (
              <motion.div
                key="admin"
                initial={{ opacity: 0, x: 15 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -15 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex-1 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary-foreground/70">
                    <ShieldCheck className="h-3 w-3" /> Admin View
                  </span>
                  <span className="flex items-center gap-1.5 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Live
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-1.5">
                  {[
                    { n: '128', l: 'Present' },
                    { n: '6',   l: 'Absent' },
                    { n: '4',   l: 'On leave' },
                  ].map((s) => (
                    <div key={s.l} className="rounded-lg bg-primary-foreground/10 px-2 py-1.5 text-center">
                      <div className="font-mono text-base font-bold leading-none tabular-nums">{s.n}</div>
                      <div className="mt-1 text-[9px] uppercase tracking-wide text-primary-foreground/60">{s.l}</div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between text-[10px] text-primary-foreground/70">
                  <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3 text-emerald-300" /> 96% on-time</span>
                  <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> 12 sites live</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Carousel indicator dots */}
          <div className="mt-2.5 flex justify-center gap-1 flex-shrink-0">
            {Array.from({ length: 8 }).map((_, idx) => (
              <div
                key={idx}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  slideIndex === idx ? 'w-4 bg-primary-foreground' : 'w-1.5 bg-primary-foreground/35'
                }`}
              />
            ))}
          </div>
        </motion.div>

        {/* Compact value chips (dynamically rotate with active slide) */}
        <div className="mt-8 min-h-[42px] flex items-center">
          <AnimatePresence mode="wait">
            <motion.div
              key={slideIndex}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.35, ease: EASE }}
              className="flex flex-wrap gap-2"
            >
              {currentHighlights.map((h) => (
                <span
                  key={h.title}
                  className="inline-flex items-center gap-1.5 rounded-full border border-primary-foreground/20 bg-primary-foreground/10 px-3 py-1.5 text-xs font-medium text-primary-foreground opacity-90 shadow-sm"
                >
                  <h.icon className="h-3.5 w-3.5" /> {h.title}
                </span>
              ))}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Trust line */}
      <div className="flex items-center gap-2 text-xs text-primary-foreground/70">
        <ShieldCheck className="h-3.5 w-3.5" /> {t.trustLine}
      </div>
    </aside>
  );
}
