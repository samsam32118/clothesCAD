import { buildCases } from './cases';
import { design } from '../src/core/design';
import { scoreFit, scoreWearability } from './metrics';
const [garment, filter] = process.argv.slice(2);
for (const c of buildCases({ garments: [garment as never] })) {
  if (filter && !c.id.includes(filter)) continue;
  const pkg = design(structuredClone(c.request));
  const f = scoreFit(pkg); const w = scoreWearability(pkg);
  console.log(c.id, f.score, w.score, [...f.details, ...w.details].join(' | '));
}
