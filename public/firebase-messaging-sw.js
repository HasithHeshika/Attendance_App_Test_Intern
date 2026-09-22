// Native Web Push Service Worker
// Synchronous registration, zero external network blocking, optimized for iOS & Android.

// Safe brand fallback
const BRAND = 'PearlCluster';

/**
 * Clean and format notification text to fit mobile space constraints on iOS and Android.
 * iOS Notification Centre banner: ~35-42 char bold title line, ~120-140 char body.
 * Android shade: ~35-42 char bold title, ~50-70 char collapsed body (up to 250 in expanded).
 */
function formatNotificationText(data, n) {
  let title = (data.title || n.title || '').trim();
  let body = (data.body || n.body || '').trim();
  const type = data.realType || data.type || '';
  const brand = data.brand || BRAND;

  // Strip redundant app brand prefixes if already present in title or body
  title = title.replace(/^(pearlcluster|workforce\s*pro)\s*[:\-–—|]\s*/i, '').trim();
  body = body.replace(/^(pearlcluster|workforce\s*pro)\s*[:\-–—|]\s*/i, '').trim();

  // If title is missing or generic, generate a clear, contextual title with an emoji icon
  const isGenericTitle = !title || /^(pearlcluster|notification|notifications|workforce\s*pro|alert)$/i.test(title);
  if (isGenericTitle) {
    switch (type) {
      case 'greeting':
        title = '🎉 Special Greeting';
        break;
      case 'approval_request':
        title = '⚡ Approvals Pending';
        break;
      case 'leave_request':
        title = '📋 New Leave Application';
        break;
      case 'leave_approved':
        title = '✅ Leave Approved';
        break;
      case 'leave_rejected':
        title = '❌ Leave Rejected';
        break;
      case 'leave_update':
        title = '📋 Leave Status Updated';
        break;
      case 'attendance_edit':
        title = '✏️ Attendance Edit Request';
        break;
      case 'edit_approved':
        title = '✅ Attendance Edit Approved';
        break;
      case 'edit_rejected':
        title = '❌ Attendance Edit Rejected';
        break;
      case 'task_assigned':
        title = '📌 New Task Assigned';
        break;
      case 'task_mention':
        title = '💬 Mentioned in Task';
        break;
      case 'task_status':
        title = '🔄 Task Status Updated';
        break;
      case 'announcement':
        title = '📢 Company Announcement';
        break;
      case 'reminder':
        title = '⏰ Attendance Reminder';
        break;
      case 'schedule_updated':
        title = '📅 Schedule Updated';
        break;
      case 'email_change':
        title = '🔒 Security: Email Changed';
        break;
      case 'maintenance':
        title = '🛠️ System Maintenance';
        break;
      default:
        title = `🔔 ${brand} Update`;
        break;
    }
  }

  // If body is missing or the generic WebKit fallback "from PearlCluster", provide a meaningful body
  const isGenericBody = !body || /^from\s+(pearlcluster|workforce\s*pro)$/i.test(body) || /^(notification|new notification)$/i.test(body);
  if (isGenericBody) {
    switch (type) {
      case 'greeting':
        body = 'You have a special greeting waiting for you! Tap to open.';
        break;
      case 'approval_request':
        body = 'You have pending attendance records awaiting your review.';
        break;
      case 'leave_request':
        body = 'A team member has submitted a new leave application.';
        break;
      case 'leave_approved':
        body = 'Your leave application has been approved.';
        break;
      case 'leave_rejected':
        body = 'Your leave application was not approved. Tap for details.';
        break;
      case 'leave_update':
        body = 'There is an update on your leave application status.';
        break;
      case 'attendance_edit':
        body = 'An attendance correction request is waiting for your review.';
        break;
      case 'edit_approved':
        body = 'Your attendance edit request has been approved.';
        break;
      case 'edit_rejected':
        body = 'Your attendance edit request was not approved.';
        break;
      case 'announcement':
        body = 'A new announcement has been posted. Tap to read.';
        break;
      case 'reminder':
        body = 'Please review and confirm your attendance record.';
        break;
      case 'schedule_updated':
        body = 'Your working roster or shift schedule has been updated.';
        break;
      case 'email_change':
        body = 'An account email address was recently updated.';
        break;
      case 'maintenance':
        body = 'Scheduled system maintenance is currently underway.';
        break;
      default:
        body = `Tap to open ${brand} and view your latest update.`;
        break;
    }
  }

  // Remove title duplication at start of body (e.g., "Leave Request: John Doe applied..." -> "John Doe applied...")
  const titleWithoutEmoji = title.replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '').trim();
  if (titleWithoutEmoji.length > 3) {
    const escaped = titleWithoutEmoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dupRegex = new RegExp(`^${escaped}\\s*[:\\-–—|]\\s*`, 'i');
    body = body.replace(dupRegex, '').trim();
  }

  // Format title for available space (approx 38-42 chars max on iOS/Android single-line bold title)
  if (title.length > 42) {
    const cut = title.slice(0, 40);
    const lastSpace = cut.lastIndexOf(' ');
    title = (lastSpace > 24 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s\-–]+$/, '').trim() + '…';
  }

  // Format body for available space (approx 140-170 chars max on iOS/Android shade/banner)
  if (body.length > 170) {
    const cut = body.slice(0, 168);
    const lastSpace = cut.lastIndexOf(' ');
    body = (lastSpace > 120 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s\-–]+$/, '').trim() + '…';
  }

  return { title, body };
}

// In-memory deduplication cache: prevents double-rendering when duplicate push packets
// arrive (e.g., multiple device tokens, network retries, or concurrent handlers).
const _recentPushIds = new Map();

function isDuplicatePush(tag) {
  if (!tag) return false;
  const now = Date.now();
  for (const [k, ts] of _recentPushIds.entries()) {
    if (now - ts > 30000) _recentPushIds.delete(k);
  }
  if (_recentPushIds.has(tag)) {
    return true;
  }
  _recentPushIds.set(tag, now);
  return false;
}

function render(data, n) {
  const { title, body } = formatNotificationText(data, n);
  const greeting = data.type === 'greeting';
  const tag = data.tag || data.docId || undefined;

  return self.registration.showNotification(title, {
    body,
    icon:               n.icon  || data.icon  || '/app.png',
    badge:                                    '/app.png',
    image:              n.image || data.image || undefined,
    // Group identical notifications so they collapse cleanly
    tag:                tag,
    data:               data,
    actions:            getActions(data.type),
    vibrate:            greeting ? [120] : [200, 100, 200],
    requireInteraction: data.type === 'approval_request',
    renotify:           data.type === 'approval_request',
  });
}

// Native Push Event Listener — registered synchronously at top-level on cold wake
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      try {
        payload = { data: { body: event.data.text() } };
      } catch (e2) {
        payload = {};
      }
    }
  }
  const n = payload.notification;
  const d = payload.data || {};

  // If payload already has a notification object handled automatically by the browser,
  // do NOT call showNotification manually to avoid a duplicate banner.
  if (n && (n.title || n.body)) {
    return;
  }

  // Deduplicate by tag, docId, or title/body fingerprint within a 30s window
  const notifKey = d.tag || d.docId || (d.title ? `${d.title}::${d.body}` : null);
  if (notifKey && isDuplicatePush(notifKey)) {
    return;
  }

  event.waitUntil(render(d, n || {}));
});

function getActions(type) {
  switch (type) {
    case 'approval_request':
      return [{ action: 'view', title: '👀 Review' }, { action: 'dismiss', title: '✕ Dismiss' }];
    case 'leave_update':
    case 'leave_request':
      return [{ action: 'view', title: '📋 View Leave' }];
    case 'attendance_edit':
      return [{ action: 'view', title: '✏️ View Request' }];
    case 'greeting':
      return [{ action: 'view', title: '🎉 Open Card' }];
    case 'task_assigned':
      return [{ action: 'view', title: '📌 View Task' }];
    default:
      return [{ action: 'view', title: '👀 View' }];
  }
}

// Handle notification click — open/focus the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const data = event.notification.data ?? {};
  const url  = getTargetUrl(data.type, data);

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = all.filter((c) => c.url.startsWith(self.location.origin));
    const target = mine.find((c) => c.focused) || mine.find((c) => c.visibilityState === 'visible') || mine[0];

    if (!target) {
      if (clients.openWindow) await clients.openWindow(url);
      return;
    }

    try {
      const navigated = target.navigate ? await target.navigate(url) : null;
      await (navigated || target).focus();
      if (!data.link) {
        target.postMessage({ type: 'OPEN_NOTIFICATIONS' });
      }
      return;
    } catch (e) {
      // Uncontrolled client — fall through to focus + message.
    }

    try { await target.focus(); } catch (e) { /* focus can be refused */ }
    target.postMessage({ type: 'NAVIGATE', url });
    if (!data.link) {
      target.postMessage({ type: 'OPEN_NOTIFICATIONS' });
    }
  })());
});

function getTargetUrl(type, data) {
  const base = self.location.origin;
  if (data && typeof data.link === 'string' && data.link.startsWith('/')) return base + data.link;
  switch (type) {
    case 'approval_request': return `${base}/approvals`;
    case 'leave_update':     return `${base}/leaves`;
    case 'attendance_edit':  return `${base}/approvals`;
    case 'edit_approved':
    case 'edit_rejected':    return `${base}/attendance`;
    case 'email_change':     return `${base}/users`;
    default:                 return `${base}/dashboard?openNotifications=1`;
  }
}
