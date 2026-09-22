import type { AppNotifType } from '@/services/notificationService';

// Every notification type that may be pushed to a device, as a runtime list.
//
// WHY THIS FILE EXISTS: /api/notify used to carry its own hardcoded allowlist, and it had
// drifted badly — 16 of the 29 types in AppNotifType were missing, so OT requests, suspense
// decisions, assigned tasks, schedule changes, reminders, registration alerts and greetings
// were written to the bell and then silently never reached anyone's phone. The route returned
// `{ success: true, sent: 0 }`, so nothing looked broken.
//
// The list is NOT a security boundary. /api/notify derives every push field from the stored
// document, requires the caller to be the document's `actor_epf`, and requires
// `can_send_notifications` for any broadcast. Those are the checks that matter. This list only
// exists so a push cannot be sent for a value nobody has declared.
//
// The type-level guard below makes the drift impossible to repeat: adding a member to
// AppNotifType without adding it here is a compile error.
//
// `import type` above is erased at build time, so importing the union from the (client-SDK)
// notification service does not pull firebase into a server route.
export const PUSHABLE_NOTIF_TYPES = [
  // Leave
  'leave_request', 'leave_assigned', 'leave_approved', 'leave_rejected',
  'leave_delete_request', 'leave_delete_approved', 'leave_delete_rejected',
  // Attendance edits and approvals
  'attendance_edit', 'edit_approved', 'edit_rejected', 'approval_request',
  // Suspense (expense float)
  'suspense_request', 'suspense_approved', 'suspense_rejected',
  // Overtime
  'ot_request', 'ot_approved', 'ot_rejected',
  // Assigned tasks
  'task_assigned', 'task_mention', 'task_status', 'task_flagged',
  // LogPup project tasks (Alta Vision) — assignment arrives over the signed webhook at
  // /api/logpup/events. Pushable is the whole point: the bell alone would be no better than
  // the 60-second poll the tasks page already runs.
  'logpup_task_assigned',
  // Scheduling
  'schedule_updated',
  // Automatic greetings (birthday / anniversary / special day)
  'greeting',
  // Account and system
  'announcement', 'email_change', 'registration_pending', 'reminder', 'security_alert',
  'general',
] as const satisfies readonly AppNotifType[];

export const PUSHABLE_NOTIF_TYPE_SET: ReadonlySet<string> = new Set(PUSHABLE_NOTIF_TYPES);

// Compile-time completeness guard. If a new member is added to AppNotifType and not to the
// list above, `Missing` stops being `never` and this line fails to build — which is the whole
// point: a type that exists but cannot be pushed is a bug, not a default.
type Missing = Exclude<AppNotifType, typeof PUSHABLE_NOTIF_TYPES[number]>;
const _everyTypeIsPushable: Missing extends never ? true : ['unpushable notification types:', Missing] = true;
void _everyTypeIsPushable;
