import { Wrench, Rocket, Siren, type LucideIcon } from 'lucide-react';
import type { MaintenanceKind } from '@/lib/maintenance';

export const MAINTENANCE_KIND_ICON: Record<MaintenanceKind, LucideIcon> = {
  maintenance: Wrench,
  upgrade: Rocket,
  emergency: Siren,
};

// Per-kind accent (icon tint) shared by the overlay/popups — "emergency" reads urgent (red),
// "upgrade" reads neutral/informational (primary), "maintenance" stays routine (amber).
export const MAINTENANCE_KIND_ACCENT: Record<MaintenanceKind, { text: string; bg: string }> = {
  maintenance: { text: 'text-warning', bg: 'bg-warning/15' },
  upgrade: { text: 'text-primary', bg: 'bg-primary/15' },
  emergency: { text: 'text-destructive', bg: 'bg-destructive/15' },
};
