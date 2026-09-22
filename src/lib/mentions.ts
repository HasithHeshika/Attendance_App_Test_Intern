import type { RosterMember } from '@/services/taskService';

// Extracts @mentions from free text and resolves them against the roster. Requires
// the literal '@' (unlike taskQuickAdd's forgiving no-@ name matching in quick-add
// sentences) so a mention is always an intentional tag, not an accidental
// name-shaped word appearing in a comment.
export function parseMentions(text: string, roster: RosterMember[]): RosterMember[] {
  const tokens = new Set(
    Array.from(text.matchAll(/@([A-Za-z]+)/g), m => m[1].toLowerCase()),
  );
  if (!tokens.size) return [];
  const found = new Map<string, RosterMember>();
  for (const member of roster) {
    const parts = member.employee_name.split(/\s+/).filter(Boolean);
    if (parts.some(p => tokens.has(p.toLowerCase()))) found.set(member.epf_number, member);
  }
  return Array.from(found.values());
}

export interface MentionSegment { text: string; isMention: boolean }

// Splits comment text into plain/mention runs for rendering — only tokens matching
// one of the comment's already-resolved `mentioned` people are flagged, so a random
// "@word" that didn't resolve to anyone doesn't get highlighted.
export function splitMentionSegments(
  text: string, mentioned: { employee_name: string }[],
): MentionSegment[] {
  if (!mentioned.length) return [{ text, isMention: false }];
  const nameParts = new Set(
    mentioned.flatMap(m => m.employee_name.split(/\s+/).filter(Boolean).map(p => p.toLowerCase())),
  );
  const re = /@([A-Za-z]+)/g;
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (!nameParts.has(match[1].toLowerCase())) continue;
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index), isMention: false });
    segments.push({ text: match[0], isMention: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), isMention: false });
  return segments.length ? segments : [{ text, isMention: false }];
}
