/**
 * Structure for instruction step bodies. The instruction generator writes a
 * step body as lines: plain lines are paragraphs, "- " lines are bullet
 * items and "1. " lines are numbered sub-steps. Both the Make tab and the
 * PDF booklet render from these blocks so lists never collapse into run-on
 * text.
 */
export type BodyBlock =
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[]; start: number };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;

export function parseStepBody(body: string): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const last = blocks[blocks.length - 1];
    const b = BULLET.exec(line);
    if (b) {
      if (last?.kind === 'ul') last.items.push(b[1]!);
      else blocks.push({ kind: 'ul', items: [b[1]!] });
      continue;
    }
    const n = NUMBERED.exec(line);
    if (n) {
      if (last?.kind === 'ol') last.items.push(n[2]!);
      else blocks.push({ kind: 'ol', items: [n[2]!], start: Number(n[1]) });
      continue;
    }
    blocks.push({ kind: 'p', text: line });
  }
  return blocks;
}
