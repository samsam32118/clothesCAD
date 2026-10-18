/**
 * Beginner glossary. Keys are the display terms (lower case); `forms` are the
 * other spellings detected in step text (plurals and verb forms are handled
 * automatically for single words).
 */
interface GlossaryEntry {
  term: string;
  definition: string;
  forms?: string[];
}

const ENTRIES: GlossaryEntry[] = [
  { term: 'right side', definition: 'The "good" face of the fabric that will show on the outside of the garment.', forms: ['right sides'] },
  { term: 'wrong side', definition: 'The back face of the fabric that will be on the inside of the garment.', forms: ['wrong sides'] },
  { term: 'selvedge', definition: 'The tightly woven, non-fraying edge running along both long sides of the fabric as it comes off the roll.', forms: ['selvage', 'selvedges'] },
  { term: 'grainline', definition: 'The straight arrow printed on each pattern piece. Place it exactly parallel to the selvedge so the garment hangs straight and does not twist.', forms: ['grain line', 'grain'] },
  { term: 'bias', definition: 'The diagonal direction across the fabric (45 degrees to the selvedge). Fabric stretches and drapes the most along the bias.' },
  { term: 'nap', definition: 'A surface texture or sheen that looks different depending on which way you view it. Napped fabrics need every piece cut pointing the same way ("with-nap layout").', forms: ['with-nap'] },
  { term: 'fold line', definition: 'A pattern edge marked "place on fold": lay it exactly on the folded edge of the fabric so you cut one symmetrical piece twice as wide.', forms: ['on the fold', 'cut on the fold'] },
  { term: 'mirror pair', definition: 'Two pieces that are exact mirror images (a left and a right). Cut them from folded fabric, or flip the paper pattern over for the second one.', forms: ['mirrored pair'] },
  { term: 'seam allowance', definition: 'The strip of fabric between the cutting edge and the stitching line. Your pattern already includes it.', forms: ['seam allowances'] },
  { term: 'hem allowance', definition: 'The extra fabric below the finished hem line that is folded up to the inside to make the hem.' },
  { term: 'notch', definition: 'Small triangle or line on the pattern edge used to match pieces together. Mark it with a 3 mm snip into the seam allowance.' },
  { term: 'dart', definition: 'A stitched, tapered fold that shapes flat fabric around curves such as the bust, waist or hip.' },
  { term: 'apex', definition: 'The bust point: the fullest point of the bust. Bust darts point towards it but stop about 2 cm short.' },
  { term: 'tailor\'s tack', definition: 'A loose loop of hand-sewn thread through both fabric layers used to mark a point (like a dart tip) on fabrics where chalk or pens would show or not stick.', forms: ['tailor tack', 'tailor tacks', 'tailor\'s tacks'] },
  { term: 'staystitch', definition: 'A line of regular stitching just inside the seam allowance of a single layer, sewn right after cutting, to stop curved edges (necklines, waists) from stretching out.', forms: ['staystitching', 'staystitched'] },
  { term: 'baste', definition: 'Sew temporarily with long, loose stitches (machine 5 mm or by hand) so you can try on or check before sewing for real. Basting is easy to unpick.', forms: ['basting', 'basted', 'basting stitch'] },
  { term: 'backstitch', definition: 'Sew 3-4 stitches backwards and then forwards again at the start and end of a seam to lock the stitches so they do not unravel.', forms: ['backstitching'] },
  { term: 'stitch length', definition: 'How long each machine stitch is, set on your machine dial in millimetres. 2.5 mm is normal; 4-5 mm is used for basting and gathering.' },
  { term: 'press', definition: 'Ironing by lifting and lowering the iron rather than sliding it, so seams set without stretching the fabric.', forms: ['pressing', 'pressed'] },
  { term: 'press cloth', definition: 'A piece of fabric (cotton or silk organza) laid between the iron and your garment to prevent shine, scorching and water marks.' },
  { term: 'tailor\'s ham', definition: 'A firm, ham-shaped cushion used to press curved areas like darts and sleeve caps so they keep their rounded shape. A rolled-up towel works in a pinch.', forms: ['ham'] },
  { term: 'clapper', definition: 'A smooth block of hardwood pressed onto a seam straight after steaming; it traps the heat and gives sharp, flat seams on wool and linen.' },
  { term: 'seam finish', definition: 'Any method that stops the raw edges of seam allowances from fraying (zigzag, overlocking, French seams, pinking, binding).', forms: ['seam finishes'] },
  { term: 'zigzag', definition: 'A side-to-side machine stitch. Used along raw edges to stop fraying, and in narrow form to sew stretchy knits.' },
  { term: 'overlock', definition: 'A stitch made by an overlocker (serger) machine that trims and wraps the raw edge in one go. A zigzag on a regular machine does the same job.', forms: ['overlocker', 'overlocking', 'serger'] },
  { term: 'French seam', definition: 'A seam sewn twice, first wrong sides together and then right sides together, so the raw edges are completely enclosed. Ideal for sheer and fine fabrics.', forms: ['French seams'] },
  { term: 'Hong Kong finish', definition: 'Binding each raw seam edge with a strip of lightweight bias fabric for a beautiful, couture-style inside.', forms: ['Hong Kong'] },
  { term: 'pinking', definition: 'Cutting raw edges with zigzag-bladed pinking shears to slow fraying on tightly woven fabrics.', forms: ['pinked'] },
  { term: 'trim', definition: 'Cut away part of the seam allowance to reduce bulk, usually to about half its width.', forms: ['trimming'] },
  { term: 'grade', definition: 'Trim the layers of a seam allowance to different widths (the layer closest to the outside left widest) so no ridge shows on the outside.', forms: ['grading'] },
  { term: 'clip', definition: 'Make small snips into the seam allowance of an inward (concave) curve, stopping 2 mm before the stitches, so it can spread and lie flat.', forms: ['clipping'] },
  { term: 'facing', definition: 'A shaped piece of fabric sewn to an edge such as a neckline or armhole and turned to the inside to give a neat finish.', forms: ['facings'] },
  { term: 'interfacing', definition: 'A stiffening layer applied to the wrong side of facings, waistbands and zip areas to give support. Fusible interfacing has glue on one side and is ironed on.' },
  { term: 'fusible', definition: 'Has heat-activated glue on one side (the slightly rough or shiny side); it bonds to fabric when pressed with an iron.' },
  { term: 'understitch', definition: 'A line of stitching through the facing and the seam allowances (not the garment) close to the seam; it keeps the facing rolled to the inside, invisible from outside.', forms: ['understitching', 'understitched'] },
  { term: 'edgestitch', definition: 'Topstitching sewn very close (1-2 mm) to an edge or seam.', forms: ['edgestitching'] },
  { term: 'topstitch', definition: 'Stitching sewn on the right side of the garment, visible, to hold layers flat or as decoration.', forms: ['topstitching', 'topstitched'] },
  { term: 'ease', definition: 'Extra room built into the garment beyond your body measurement so you can move, breathe and sit. Also: fitting a slightly longer edge smoothly to a shorter one without tucks.', forms: ['eased', 'easing'] },
  { term: 'ease stitching', definition: 'Long machine stitches (4 mm) sewn within the seam allowance and gently pulled to shrink an edge slightly, as on a sleeve cap.' },
  { term: 'gathering', definition: 'Pulling long stitches to bunch a longer edge into soft folds so it matches a shorter edge.', forms: ['gathers', 'gathered', 'gather'] },
  { term: 'invisible zip', definition: 'A zip with coils hidden on the inside, so from outside it looks like a plain seam. Sewn before the rest of the seam is closed.', forms: ['invisible zipper'] },
  { term: 'invisible zip foot', definition: 'A machine foot with grooves that hold the zip coil open so you can stitch very close to it.' },
  { term: 'zipper foot', definition: 'A narrow machine foot that lets the needle sew close to a zip, piping or bulky edge.' },
  { term: 'lapped zip', definition: 'A zip covered by a fold of fabric (the lap) on one side, sewn with visible topstitching. Classic on trousers and tailored skirts.', forms: ['lapped zipper'] },
  { term: 'slip stitch', definition: 'A nearly invisible hand stitch that slides inside a fold and picks up only a thread or two of the garment, used for hems and linings.', forms: ['slip stitches', 'slip-stitch'] },
  { term: 'catch stitch', definition: 'A loose, criss-cross hand stitch used for hems on heavier or stretchy fabrics; it holds firmly but stays flexible.', forms: ['catch stitches', 'catch-stitch'] },
  { term: 'blind hem', definition: 'A hem stitched so only tiny, almost invisible stitches show on the outside.', forms: ['blind-hem'] },
  { term: 'double-fold hem', definition: 'A hem folded up twice so the raw edge is enclosed, then stitched by machine.' },
  { term: 'rolled hem', definition: 'A very narrow hem (2-3 mm) rolled twice; the classic finish for silk and fine fabrics.' },
  { term: 'waistband', definition: 'The band of fabric sewn around the top of a skirt or trousers that sits at your waist.' },
  { term: 'casing', definition: 'A fabric tunnel that holds elastic or a drawstring.' },
  { term: 'centre front', definition: 'The vertical line down the middle of the front of the body or garment.', forms: ['center front'] },
  { term: 'centre back', definition: 'The vertical line down the middle of the back of the body or garment.', forms: ['center back'] },
  { term: 'sleeve cap', definition: 'The curved top of a sleeve that is sewn into the armhole. It is slightly longer than the armhole to give room for the shoulder.' },
  { term: 'armhole', definition: 'The opening of the bodice where the sleeve is sewn, or the finished edge on a sleeveless garment.' },
  { term: 'lining', definition: 'A separate inner layer of light, smooth fabric that hides the seams, helps the garment slide on and hang better.' },
  { term: 'underlining', definition: 'A layer (often silk organza) cut like the main fabric and handled as one with it, adding body and support.' },
  { term: 'test square', definition: 'The 5 cm square printed on the first pattern page. Measure it to confirm the pattern printed at exactly 100 % size.' },
  { term: 'tiled pages', definition: 'The pattern printed across several normal sheets of paper, which you tape together along their overlaps to get the full-size pattern.', forms: ['tiled page'] },
  { term: 'pre-wash', definition: 'Washing (or steaming) fabric the way you will wash the finished garment, before cutting, so it shrinks now and not later.', forms: ['pre-washed', 'pre-washing'] },
  { term: 'bobbin', definition: 'The small spool under the needle plate that supplies the lower thread of every machine stitch.' },
  { term: 'raw edge', definition: 'A cut fabric edge that has not been finished and can fray.', forms: ['raw edges'] },
  { term: 'seam ripper', definition: 'A small tool with a sharp hook for cutting and removing stitches.' },
  { term: 'tension', definition: 'How tightly your machine pulls the upper and lower threads. Balanced tension gives stitches that look the same on both sides.' },
  { term: 'stretch stitch', definition: 'A machine stitch (often like a lightning bolt) that stretches with knit fabric so seams do not pop.' },
  { term: 'ballpoint needle', definition: 'A machine needle with a rounded tip that slides between knit loops instead of piercing and laddering them.', forms: ['stretch needle'] },
  { term: 'microtex needle', definition: 'A very sharp, slim machine needle for fine and tightly woven fabrics like silk and microfibres.', forms: ['microtex'] },
  { term: 'muslin', definition: 'A quick practice version of the garment in cheap cotton (also called a toile) to check fit before cutting precious fabric.', forms: ['toile'] },
  { term: 'hook and eye', definition: 'A small metal hook and loop sewn above a zip to hold the top edges neatly together.', forms: ['hook & eye'] },
  { term: 'bodkin', definition: 'A blunt, large-eyed needle (or a safety pin) used to thread elastic through a casing.' },
  { term: 'pattern weights', definition: 'Small heavy objects that hold the paper pattern flat on the fabric instead of pins; tins of food work well.' },
];

const BY_TERM = new Map(ENTRIES.map((e) => [e.term, e] as const));

/** Terms always included so a novice has the core vocabulary in one place. */
const CORE_TERMS = [
  'right side',
  'wrong side',
  'selvedge',
  'grainline',
  'bias',
  'fold line',
  'seam allowance',
  'hem allowance',
  'notch',
  'staystitch',
  'baste',
  'backstitch',
  'stitch length',
  'press',
  'press cloth',
  'seam finish',
  'zigzag',
  'trim',
  'clip',
  'ease',
  'raw edge',
  'pre-wash',
  'test square',
  'tiled pages',
  'bobbin',
  'seam ripper',
  'tension',
  'muslin',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MATCHERS: Array<{ term: string; re: RegExp }> = ENTRIES.map((e) => {
  const forms = [e.term, ...(e.forms ?? [])].sort((a, b) => b.length - a.length);
  const alt = forms
    .map((f) => {
      const esc = escapeRegExp(f);
      // Allow simple plurals on single words / last words.
      return /[a-z]$/i.test(f) ? `${esc}(?:e?s)?` : esc;
    })
    .join('|');
  return { term: e.term, re: new RegExp(`(?<![\\w-])(?:${alt})(?![\\w-])`, 'i') };
});

/** Glossary terms that appear in a piece of text. */
export function detectTerms(text: string): string[] {
  const found: string[] = [];
  for (const m of MATCHERS) if (m.re.test(text)) found.push(m.term);
  return found;
}

/** Glossary for the given used terms plus the core vocabulary, alphabetically. */
export function buildGlossary(usedTerms: Iterable<string>): Record<string, string> {
  const keys = new Set<string>(CORE_TERMS);
  for (const t of usedTerms) if (BY_TERM.has(t)) keys.add(t);
  const out: Record<string, string> = {};
  for (const k of [...keys].sort((a, b) => a.localeCompare(b))) out[k] = BY_TERM.get(k)!.definition;
  return out;
}

export const GLOSSARY_TERMS: readonly string[] = ENTRIES.map((e) => e.term);
