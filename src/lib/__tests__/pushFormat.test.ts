import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPushText } from '../pushFormat';

test('formatPushText: replaces missing or generic title and body with contextual content', () => {
  // Missing or generic "PearlCluster" title with "from PearlCluster" body (the exact iOS screenshot bug)
  const r1 = formatPushText('PearlCluster', 'from PearlCluster', 'approval_request');
  assert.equal(r1.title, '⚡ Approvals Pending');
  assert.equal(r1.body, 'You have pending attendance records awaiting your review.');

  const r2 = formatPushText('', '', 'leave_request');
  assert.equal(r2.title, '📋 New Leave Application');
  assert.equal(r2.body, 'A team member has submitted a new leave application.');

  const r3 = formatPushText('Notification', 'New notification', 'greeting');
  assert.equal(r3.title, '🎉 Special Greeting');
  assert.equal(r3.body, 'You have a special greeting waiting for you! Tap to open.');
});

test('formatPushText: strips redundant app name prefix from title and body', () => {
  const r1 = formatPushText('PearlCluster: New Task Assigned', 'PearlCluster - You were assigned task #42', 'task_assigned');
  assert.equal(r1.title, 'New Task Assigned');
  assert.equal(r1.body, 'You were assigned task #42');

  const r2 = formatPushText('Workforce Pro - Approval Request', 'Workforce Pro: 3 records need review', 'approval_request');
  assert.equal(r2.title, 'Approval Request');
  assert.equal(r2.body, '3 records need review');
});

test('formatPushText: removes title repetition from start of body to save mobile display space', () => {
  const r = formatPushText('Leave Request', 'Leave Request: John Doe submitted 2 days of annual leave', 'leave_request');
  assert.equal(r.title, 'Leave Request');
  assert.equal(r.body, 'John Doe submitted 2 days of annual leave');
});

test('formatPushText: truncates long title cleanly at word boundary under 42 chars', () => {
  const longTitle = 'Important Announcement Regarding Upcoming Public Holiday Schedule Changes';
  const r = formatPushText(longTitle, 'Short body', 'announcement');
  assert.ok(r.title.length <= 42, `Title length ${r.title.length} should be <= 42`);
  assert.ok(r.title.endsWith('…'));
  // Should not end with punctuation before the ellipsis
  assert.ok(!r.title.endsWith(',…'));
  assert.ok(!r.title.endsWith(' …'));
});

test('formatPushText: truncates long body cleanly at word boundary under 170 chars for iOS/Android', () => {
  const longBody = 'Attention all employees: The management team has approved the updated roster schedule for the Colombo branch starting next Monday. Please review your shifts in the attendance portal immediately.';
  const r = formatPushText('Roster Update', longBody, 'schedule_updated');
  assert.ok(r.body.length <= 170, `Body length ${r.body.length} should be <= 170`);
  assert.ok(r.body.endsWith('…'));
  assert.ok(!r.body.endsWith(',…'));
  assert.ok(!r.body.endsWith(' …'));
});

test('formatPushText: security email change and maintenance formatting', () => {
  const rEmail = formatPushText('', '', 'email_change');
  assert.equal(rEmail.title, '🔒 Security: Email Changed');
  assert.equal(rEmail.body, 'An account email address was recently updated.');

  const rMaint = formatPushText('', '', 'maintenance');
  assert.equal(rMaint.title, '🛠️ System Maintenance');
  assert.equal(rMaint.body, 'Scheduled system maintenance is currently underway.');
});
