/**
 * Builds an indexed BufferGeometry from a rows × cols lattice of points that
 * wraps around (closed in the column direction). Column `cols` duplicates
 * column 0 so UVs are continuous; normals across that seam are averaged so
 * shading stays smooth.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { TubePart } from './bodyModel';

export interface GridOptions {
  /** Reverse the triangle winding (for mirrored frames). */
  flip?: boolean;
  name?: string;
}

/**
 * @param positions rows * (cols + 1) * 3 floats, row-major. Rows run along the
 * tube axis; columns run around it with increasing angle (w toward u).
 */
export function gridGeometry(rows: number, cols: number, positions: Float32Array, opts: GridOptions = {}): BufferGeometry {
  const stride = cols + 1;
  if (positions.length !== rows * stride * 3) {
    throw new Error(`gridGeometry: expected ${rows * stride * 3} floats, got ${positions.length}`);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));

  const uv = new Float32Array(rows * stride * 2);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j <= cols; j++) {
      const k = (i * stride + j) * 2;
      uv[k] = j / cols;
      uv[k + 1] = rows > 1 ? 1 - i / (rows - 1) : 0;
    }
  }
  geo.setAttribute('uv', new BufferAttribute(uv, 2));

  const quadCount = (rows - 1) * cols;
  const vertexCount = rows * stride;
  const index = vertexCount > 65535 ? new Uint32Array(quadCount * 6) : new Uint16Array(quadCount * 6);
  let n = 0;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = a + 1;
      const d = b + 1;
      if (opts.flip) {
        index[n++] = a;
        index[n++] = c;
        index[n++] = b;
        index[n++] = c;
        index[n++] = d;
        index[n++] = b;
      } else {
        index[n++] = a;
        index[n++] = b;
        index[n++] = c;
        index[n++] = c;
        index[n++] = b;
        index[n++] = d;
      }
    }
  }
  geo.setIndex(new BufferAttribute(index, 1));
  geo.computeVertexNormals();

  const normal = geo.getAttribute('normal') as BufferAttribute;
  const nArr = normal.array as Float32Array;
  for (let i = 0; i < rows; i++) {
    // Seam: share one normal between column 0 and its duplicate.
    const k0 = (i * stride) * 3;
    const k1 = (i * stride + cols) * 3;
    const ax = nArr[k0]! + nArr[k1]!;
    const ay = nArr[k0 + 1]! + nArr[k1 + 1]!;
    const az = nArr[k0 + 2]! + nArr[k1 + 2]!;
    const al = Math.hypot(ax, ay, az) || 1;
    nArr[k0] = nArr[k1] = ax / al;
    nArr[k0 + 1] = nArr[k1 + 1] = ay / al;
    nArr[k0 + 2] = nArr[k1 + 2] = az / al;
    // Collapsed rows (dome apexes): one shared normal for the whole row.
    let collapsed = true;
    const px = positions[k0]!;
    const py = positions[k0 + 1]!;
    const pz = positions[k0 + 2]!;
    for (let j = 1; j < cols && collapsed; j++) {
      const k = (i * stride + j) * 3;
      if (Math.abs(positions[k]! - px) + Math.abs(positions[k + 1]! - py) + Math.abs(positions[k + 2]! - pz) > 1e-5) {
        collapsed = false;
      }
    }
    if (collapsed) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let j = 0; j <= cols; j++) {
        const k = (i * stride + j) * 3;
        sx += nArr[k]!;
        sy += nArr[k + 1]!;
        sz += nArr[k + 2]!;
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      for (let j = 0; j <= cols; j++) {
        const k = (i * stride + j) * 3;
        nArr[k] = sx / l;
        nArr[k + 1] = sy / l;
        nArr[k + 2] = sz / l;
      }
    }
  }
  normal.needsUpdate = true;
  if (opts.name) geo.name = opts.name;
  geo.userData = { rows, cols };
  return geo;
}

/** Mesh a body part's surface. */
export function tubePartGeometry(part: TubePart, offset = 0): BufferGeometry {
  const rows = part.rows.length;
  const cols = part.cols;
  const stride = cols + 1;
  const pos = new Float32Array(rows * stride * 3);
  for (let i = 0; i < rows; i++) {
    const s = part.rows[i]!;
    for (let j = 0; j <= cols; j++) {
      const phi = ((j % cols) / cols) * Math.PI * 2;
      const p = part.surfacePoint(s, phi, offset);
      const k = (i * stride + j) * 3;
      pos[k] = p[0];
      pos[k + 1] = p[1];
      pos[k + 2] = p[2];
    }
  }
  return gridGeometry(rows, cols, pos, { flip: part.mirrored, name: part.name });
}
