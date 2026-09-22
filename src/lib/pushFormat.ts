/**
 * Notification text formatting for mobile devices (iOS and Android).
 *
 * Space constraints:
 * - iOS Notification Centre banner:
 *   - App name header: fixed system row ("PearlCluster", timestamp).
 *   - Bold title: 1 line, approx 35–42 chars before truncation.
 *   - Body: 2–3 lines, approx 120–140 chars in standard font.
 * - Android Notification shade:
 *   - Header: Small icon, App name.
 *   - Bold title: 1 line, approx 35–42 chars.
 *   - Collapsed body: 1–2 lines, approx 50–70 chars.
 *   - Expanded body: up to 250 chars.
 *
 * Rules implemented:
 * 1. Eliminate redundant app names (e.g. "PearlCluster: " or "PearlCluster - ").
 * 2. Replace generic or missing titles ("PearlCluster", "Notification") with contextual emoji titles.
 * 3. Replace generic fallbacks ("from PearlCluster") with rich, informative copy.
 * 4. Remove title repetitions from the body so space isn't wasted.
 * 5. Word-boundary truncation ending cleanly with ellipsis ("…") without trailing punctuation.
 */

export interface FormattedPushText {
  title: string;
  body: string;
}

export function formatPushText(
  rawTitle: string,
  rawBody: string,
  type?: string,
  brand: string = 'PearlCluster'
): FormattedPushText {
  let title = (rawTitle || '').trim();
  let body = (rawBody || '').trim();

  // 1. Strip redundant app brand prefixes if already present in title or body
  title = title.replace(/^(pearlcluster|workforce\s*pro)\s*[:\-–—|]\s*/i, '').trim();
  body = body.replace(/^(pearlcluster|workforce\s*pro)\s*[:\-–—|]\s*/i, '').trim();

  // 2. If title is missing or generic, generate a clear, contextual title with an emoji icon
  const isGenericTitle = !title || /^(pearlcluster|notification|notifications|workforce\s*pro|alert)$/i.test(title);
  if (isGenericTitle) {
    switch (type) {
      case 'greeting': title = '🎉 Special Greeting'; break;
      case 'approval_request': title = '⚡ Approvals Pending'; break;
      case 'leave_request': title = '📋 New Leave Application'; break;
      case 'leave_approved': title = '✅ Leave Approved'; break;
      case 'leave_rejected': title = '❌ Leave Rejected'; break;
      case 'leave_update': title = '📋 Leave Status Updated'; break;
      case 'attendance_edit': title = '✏️ Attendance Edit Request'; break;
      case 'edit_approved': title = '✅ Attendance Edit Approved'; break;
      case 'edit_rejected': title = '❌ Attendance Edit Rejected'; break;
      case 'task_assigned': title = '📌 New Task Assigned'; break;
      case 'task_mention': title = '💬 Mentioned in Task'; break;
      case 'task_status': title = '🔄 Task Status Updated'; break;
      case 'announcement': title = '📢 Company Announcement'; break;
      case 'reminder': title = '⏰ Attendance Reminder'; break;
      case 'schedule_updated': title = '📅 Schedule Updated'; break;
      case 'email_change': title = '🔒 Security: Email Changed'; break;
      case 'maintenance': title = '🛠️ System Maintenance'; break;
      default: title = `🔔 ${brand} Update`; break;
    }
  }

  // 3. If body is missing or the generic WebKit fallback "from PearlCluster", provide a meaningful body
  const isGenericBody = !body || /^from\s+(pearlcluster|workforce\s*pro)$/i.test(body) || /^(notification|new notification)$/i.test(body);
  if (isGenericBody) {
    switch (type) {
      case 'greeting': body = 'You have a special greeting waiting for you! Tap to open.'; break;
      case 'approval_request': body = 'You have pending attendance records awaiting your review.'; break;
      case 'leave_request': body = 'A team member has submitted a new leave application.'; break;
      case 'leave_approved': body = 'Your leave application has been approved.'; break;
      case 'leave_rejected': body = 'Your leave application was not approved. Tap for details.'; break;
      case 'leave_update': body = 'There is an update on your leave application status.'; break;
      case 'attendance_edit': body = 'An attendance correction request is waiting for your review.'; break;
      case 'edit_approved': body = 'Your attendance edit request has been approved.'; break;
      case 'edit_rejected': body = 'Your attendance edit request was not approved.'; break;
      case 'announcement': body = 'A new announcement has been posted. Tap to read.'; break;
      case 'reminder': body = 'Please review and confirm your attendance record.'; break;
      case 'schedule_updated': body = 'Your working roster or shift schedule has been updated.'; break;
      case 'email_change': body = 'An account email address was recently updated.'; break;
      case 'maintenance': body = 'Scheduled system maintenance is currently underway.'; break;
      default: body = `Tap to open ${brand} and view your latest update.`; break;
    }
  }

  // 4. Remove title duplication at start of body (e.g. "Leave Request: John Doe applied..." -> "John Doe applied...")
  const titleWithoutEmoji = title.replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '').trim();
  if (titleWithoutEmoji.length > 3) {
    const escaped = titleWithoutEmoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dupRegex = new RegExp(`^${escaped}\\s*[:\\-–—|]\\s*`, 'i');
    body = body.replace(dupRegex, '').trim();
  }

  // 5. Format title for available space (approx 38–42 chars max on iOS/Android single-line bold title)
  if (title.length > 42) {
    const cut = title.slice(0, 40);
    const lastSpace = cut.lastIndexOf(' ');
    title = (lastSpace > 24 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s\-–]+$/, '').trim() + '…';
  }

  // 6. Format body for available space (approx 140–170 chars max on iOS/Android shade/banner)
  if (body.length > 170) {
    const cut = body.slice(0, 168);
    const lastSpace = cut.lastIndexOf(' ');
    body = (lastSpace > 120 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s\-–]+$/, '').trim() + '…';
  }

  return { title, body };
}
