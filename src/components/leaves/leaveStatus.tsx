'use client';
import { CalendarDays, CheckCircle, Clock, XCircle, type LucideIcon } from 'lucide-react';
import type { BadgeProps } from '@/components/ui/badge';

// The leaves page and the employee-history dialog both paint leave status, and they have to
// agree — a leave that reads "Approved" in green on one screen must not read differently on
// the other. Both helpers used to live inside the page; they sit here so every leave surface
// imports the same two.

// Map a leave status string to a semantic Badge variant.
export function statusBadgeVariant(status: string): BadgeProps['variant'] {
  switch (status?.toLowerCase()) {
    case 'accept':
    case 'accepted':
    case 'approved': return 'success';
    case 'reject':
    case 'rejected': return 'destructive';
    case 'pending':  return 'warning';
    default:         return 'muted';
  }
}

// Status → icon + tints for the leave card (chip, text colour, left accent).
export function statusVisual(status: string): { Icon: LucideIcon; chip: string; text: string; accent: string } {
  switch (status?.toLowerCase()) {
    case 'accept':
    case 'accepted':
    case 'approved': return { Icon: CheckCircle, chip: 'bg-success/10',     text: 'text-success',          accent: 'border-l-success' };
    case 'reject':
    case 'rejected': return { Icon: XCircle,     chip: 'bg-destructive/10', text: 'text-destructive',      accent: 'border-l-destructive' };
    case 'pending':  return { Icon: Clock,       chip: 'bg-warning/10',     text: 'text-warning',          accent: 'border-l-warning' };
    default:         return { Icon: CalendarDays, chip: 'bg-muted',          text: 'text-muted-foreground',  accent: 'border-l-border' };
  }
}

// The three buckets a leave can land in, collapsed from the several spellings the backend uses.
export type LeaveStatusBucket = 'approved' | 'pending' | 'rejected' | 'other';

export function statusBucket(status: string): LeaveStatusBucket {
  switch (status?.toLowerCase()) {
    case 'accept':
    case 'accepted':
    case 'approved': return 'approved';
    case 'reject':
    case 'rejected': return 'rejected';
    case 'pending':  return 'pending';
    default:         return 'other';
  }
}
