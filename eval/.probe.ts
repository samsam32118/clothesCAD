import { buildCases } from './cases';
import { design } from '../src/core/design';
const [garment, idx = '0', mode = 'pieces'] = process.argv.slice(2);
const cases = buildCases({ garments: [garment as never] });
const c = cases[Number(idx)];
console.log(c.id);
const pkg = design(structuredClone(c.request));
if (mode === 'pieces') {
  for (const p of pkg.pieces) {
    const ys = p.seamLine.map((q) => q.y);
    console.log(p.id, p.role, p.layer, 'cut', p.cutCount, p.cutOnFold ? 'fold' : '', 'y', Math.min(...ys).toFixed(1), Math.max(...ys).toFixed(1),
      'edges', p.edges.map((e) => `${e.id}:${e.kind}:${e.lengthCm.toFixed(1)}`).join(' '),
      'notches', p.notches.map((n) => `${n.label ?? ''}@${n.edgeId}(${n.at.x.toFixed(1)},${n.at.y.toFixed(1)})`).join(' '),
      'darts', p.darts.map((d) => `${d.id}:${d.intakeCm.toFixed(1)}`).join(' '));
  }
  console.log('fit', JSON.stringify(pkg.fit.finished), JSON.stringify(pkg.fit.ease), pkg.fit.options.closure, 'hemH', pkg.fit.hemHeightFromFloorCm);
  console.log('L', JSON.stringify(pkg.body.landmarks));
  console.log('sil top', pkg.silhouette.topHeightCm, 'hem', pkg.silhouette.hemHeightCm);
} else if (mode === 'json') console.log(JSON.stringify(pkg, null, 1));
else if (mode === 'all') {
  for (const cc of cases) { const p = design(structuredClone(cc.request)); console.log(cc.id, JSON.stringify(p.fit.ease), JSON.stringify(p.fit.finished), p.fit.options.closure); }
}
