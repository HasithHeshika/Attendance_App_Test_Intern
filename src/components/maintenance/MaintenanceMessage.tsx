import { cn } from '@/lib/utils';

type Block = { type: 'p'; text: string } | { type: 'ul'; items: string[] };

// The maintenance message is plain admin-typed text (from the control popup's textarea), not
// markdown — but admins do type paragraph breaks and "- " bullet lists into it, and a plain
// <p> collapses all of that into one run-on line (HTML whitespace collapsing). This respects
// the line breaks the admin actually typed and turns "- " / "* " prefixed lines into a real
// bullet list, without pulling in a markdown parser for what's still just plain text.
function toBlocks(message: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of message.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const last = blocks[blocks.length - 1];
      if (last?.type === 'ul') last.items.push(bullet[1]);
      else blocks.push({ type: 'ul', items: [bullet[1]] });
    } else {
      blocks.push({ type: 'p', text: line });
    }
  }
  return blocks;
}

interface Props {
  message: string;
  className?: string;
}

export default function MaintenanceMessage({ message, className }: Props) {
  const blocks = toBlocks(message);
  return (
    <div className={cn('space-y-2', className)}>
      {blocks.map((b, i) => (
        b.type === 'ul' ? (
          // The overlay centres its text, which left the markers pinned to the left edge of a
          // full-width <ul> while the item text floated in the middle. Centring the list as a
          // BLOCK and left-aligning inside it keeps every marker beside its own item.
          <div key={i} className="flex justify-center">
            <ul className="list-disc space-y-1 pl-5 text-left">
              {b.items.map((item, j) => <li key={j}>{item}</li>)}
            </ul>
          </div>
        ) : (
          <p key={i}>{b.text}</p>
        )
      ))}
    </div>
  );
}
