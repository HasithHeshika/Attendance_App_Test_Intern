import * as chrono from 'chrono-node';
import type { RosterMember } from '@/services/taskService';

const FILLER_WORDS = ['before', 'by', 'on', 'due', 'at', 'for', '-', ',', ':'];

function toYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripWholeWord(text: string, word: string): string {
  return text.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi'), ' ');
}

function trimFillerEdges(text: string): string {
  let words = text.split(/\s+/).filter(Boolean);
  const isFiller = (w: string) => FILLER_WORDS.includes(w.toLowerCase());
  while (words.length && isFiller(words[0])) words = words.slice(1);
  while (words.length && isFiller(words[words.length - 1])) words = words.slice(0, -1);
  return words.join(' ');
}

export interface QuickAddResult {
  assignees: RosterMember[];
  date: string; // YYYY-MM-DD — never null, defaults to referenceDate (today)
  description: string;
}

// Local heuristic parser for the Assign Task "quick add" sentence — no server calls.
// Finds roster names and a date phrase in freeform text (e.g. "shanika irushi do
// attendance developing before next week") and returns the rest as the description.
// Deliberately naive (no fuzzy/typo matching) so results stay explainable — callers
// must show them in an editable form for the user to correct, never auto-submit.
export function parseQuickAdd(
  text: string, roster: RosterMember[], referenceDate: Date,
): QuickAddResult {
  const tokens = new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []));

  const assignees: RosterMember[] = [];
  const matchedWords: string[] = [];
  for (const member of roster) {
    const nameParts = member.employee_name.split(/\s+/).filter(Boolean);
    const hitParts = nameParts.filter(part => tokens.has(part.toLowerCase()));
    if (hitParts.length > 0) {
      assignees.push(member);
      matchedWords.push(...hitParts);
    }
  }

  // Date: first chrono match, forwardDate so a bare weekday resolves to the upcoming
  // occurrence. "before next week" is deliberately read as "a day within next week"
  // (chrono's own resolution of the "next week" portion, no extra "before" handling)
  // per product decision — not the strict English "by the end of this week" reading.
  const chronoResults = chrono.parse(text, referenceDate, { forwardDate: true });
  const dateMatch = chronoResults[0];
  const date = dateMatch ? toYmd(dateMatch.date()) : toYmd(referenceDate);

  let remainder = text;
  if (dateMatch) remainder = remainder.replace(dateMatch.text, ' ');
  for (const word of matchedWords) remainder = stripWholeWord(remainder, word);
  remainder = remainder.replace(/\s+/g, ' ').trim();
  const description = trimFillerEdges(remainder);

  return { assignees, date, description };
}
