/* pine-builtins.js
   Implements the ta.* / math.* / array.* / input.* / color.* / str.* built-in functions, plus
   top-level functions like plot()/hline(). Also wires up lexer->parser->interpreter into the
   single runPineScript() entry point.
   ta.* / math.* / array.* / input.* / color.* / str.* 내장 함수 구현 + plot()/hline() 등 최상위 함수.
   그리고 lexer->parser->interpreter를 한 번에 묶어 실행하는 runPineScript() 진입점. */

function getArg(posArgs, namedArgs, idx, name, def){
  if(namedArgs && namedArgs.hasOwnProperty(name)) return namedArgs[name];
  if(posArgs && idx < posArgs.length) return posArgs[idx];
  return def === undefined ? null : def;
}
function getState(it, node){
  const key = it.pathKey ? it.pathKey(node) : node.id;
  let s = it.callState.get(key);
  if(!s){ s = {}; it.callState.set(key, s); }
  return s;
}
function numOrNull(v){ return v == null ? null : pineNum(v); }
// Skips na values while finding the array's min/max (returns null if all na or the array is empty).
// na를 건너뛰고 배열의 최소/최대를 구한다(전부 na거나 비었으면 null).
function pineArrayExtreme(items, wantMin){
  let best = null;
  for(let i = 0; i < items.length; i++){
    const v = items[i];
    if(v == null) continue;
    if(best === null || (wantMin ? v < best : v > best)) best = v;
  }
  return best;
}

// ============================================================
// English: array.* method implementations (reused for both the static array.push(arr,x) form
// and the arr.push(x) method-call syntax).
// array.* 메서드 구현부 (array.push(arr,x) 정적 형태 + arr.push(x) 메서드 문법 양쪽에서 재사용)
// ============================================================
const ARRAY_METHOD_BUILTINS = {
  push: (it, arr, p) => { arr.items.push(p[0] === undefined ? null : p[0]); return null; },
  pop: (it, arr, p, n, node) => { if(!arr.items.length) throw new PineRuntimeError(pineMsg('빈 배열에서 pop() 할 수 없습니다', 'Cannot pop() from an empty array'), node ? node.line : 0); return arr.items.pop(); },
  shift: (it, arr, p, n, node) => { if(!arr.items.length) throw new PineRuntimeError(pineMsg('빈 배열에서 shift() 할 수 없습니다', 'Cannot shift() from an empty array'), node ? node.line : 0); return arr.items.shift(); },
  unshift: (it, arr, p) => { arr.items.unshift(p[0] === undefined ? null : p[0]); return null; },
  insert: (it, arr, p) => { arr.items.splice(Math.round(pineNum(p[0])), 0, p[1] === undefined ? null : p[1]); return null; },
  remove: (it, arr, p, n, node) => {
    const idx = Math.round(pineNum(p[0]));
    if(idx < 0 || idx >= arr.items.length) throw new PineRuntimeError(pineMsg('배열 인덱스 범위를 벗어났습니다: ' + idx, 'Array index out of range: ' + idx), node ? node.line : 0);
    return arr.items.splice(idx, 1)[0];
  },
  get: (it, arr, p, n, node) => it.arrayGet(arr, p.length ? p[0] : n.index, node ? node.line : 0),
  set: (it, arr, p, n, node) => {
    const idx = Math.round(pineNum(p[0]));
    if(idx < 0 || idx >= arr.items.length) throw new PineRuntimeError(pineMsg('배열 인덱스 범위를 벗어났습니다: ' + idx, 'Array index out of range: ' + idx), node ? node.line : 0);
    arr.items[idx] = p[1] === undefined ? null : p[1];
    return null;
  },
  size: (it, arr) => arr.items.length,
  clear: (it, arr) => { arr.items.length = 0; return null; },
  includes: (it, arr, p) => arr.items.includes(p[0]),
  indexof: (it, arr, p) => arr.items.indexOf(p[0]),
  lastindexof: (it, arr, p) => arr.items.lastIndexOf(p[0]),
  // Binary search, valid only for ascending-sorted arrays. Returns the exact index on a match;
  // otherwise leftmost clamps to the nearest index on the smaller side, rightmost clamps to the
  // nearest index on the smaller-or-equal side (never goes below 0).
  // 오름차순 정렬된 배열 전용 이진 탐색. 정확히 일치하면 그 인덱스, 아니면 leftmost는 값보다
  // 작은 쪽에서, rightmost는 값보다 작거나 같은 쪽에서 가장 가까운 인덱스로 보정한다(0 미만으로는 안 내려감).
  binary_search: (it, arr, p) => {
    const val = pineNum(p[0]);
    let lo = 0, hi = arr.items.length - 1;
    while(lo <= hi){
      const mid = (lo + hi) >> 1;
      if(arr.items[mid] === val) return mid;
      if(arr.items[mid] < val) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  },
  binary_search_leftmost: (it, arr, p) => {
    const val = pineNum(p[0]);
    let lo = 0, hi = arr.items.length;
    while(lo < hi){ const mid = (lo + hi) >> 1; if(arr.items[mid] < val) lo = mid + 1; else hi = mid; }
    if(lo < arr.items.length && arr.items[lo] === val) return lo;
    return lo > 0 ? lo - 1 : 0;
  },
  binary_search_rightmost: (it, arr, p) => {
    const val = pineNum(p[0]);
    let lo = 0, hi = arr.items.length;
    while(lo < hi){ const mid = (lo + hi) >> 1; if(arr.items[mid] <= val) lo = mid + 1; else hi = mid; }
    return lo > 0 ? lo - 1 : 0;
  },
  // Real Pine's array.slice(id, index_from, index_to) treats index_to as exclusive
  // (index_from through index_to-1) — same exclusive-end rule as JS's Array.slice.
  // 실제 Pine의 array.slice(id, index_from, index_to)는 index_to를 "포함하지 않는다"
  // (index_from부터 index_to-1까지) — JS의 Array.slice와 동일한 exclusive-end 규칙.
  slice: (it, arr, p) => new PineArray(arr.items.slice(Math.round(pineNum(p[0])), Math.round(pineNum(p[1]))), arr.kind),
  copy: (it, arr) => new PineArray(arr.items.slice(), arr.kind),
  concat: (it, arr, p) => { const other = p[0]; arr.items = arr.items.concat(other instanceof PineArray ? other.items : []); return arr; },
  join: (it, arr, p) => arr.items.map(pineFmt).join(p.length ? p[0] : ','),
  reverse: (it, arr) => { arr.items.reverse(); return null; },
  sort: (it, arr, p) => { const order = p[0] || 'ascending'; arr.items.sort((a, b) => order === 'descending' ? b - a : a - b); return null; },
  // Math.min(...v) hits the max-arguments limit once the array grows large (tens of thousands of
  // items) and crashes the script with a RangeError. It would also allocate a filtered copy —
  // just do a single pass instead.
  // Math.min(...v)는 배열이 커지면(수만 개) 인자 개수 한계에 걸려 RangeError로 스크립트가 죽는다.
  // 게다가 필터 사본까지 새로 만들었다 — 그냥 한 번 훑는다.
  min: (it, arr) => pineArrayExtreme(arr.items, true),
  max: (it, arr) => pineArrayExtreme(arr.items, false),
  sum: (it, arr) => arr.items.reduce((a, b) => a + (b || 0), 0),
  avg: (it, arr) => arr.items.length ? arr.items.reduce((a, b) => a + (b || 0), 0) / arr.items.length : null,
  first: (it, arr) => arr.items.length ? arr.items[0] : null,
  last: (it, arr) => arr.items.length ? arr.items[arr.items.length - 1] : null,
  fill: (it, arr, p) => {
    const v = p[0] === undefined ? null : p[0];
    const from = p.length > 1 ? Math.round(pineNum(p[1])) : 0;
    const to = p.length > 2 ? Math.round(pineNum(p[2])) : arr.items.length;
    for(let k = from; k < to; k++) arr.items[k] = v;
    return null;
  },
  variance: (it, arr) => { const v = arr.items.filter(x => x != null); if(!v.length) return null; const m = v.reduce((a, b) => a + b, 0) / v.length; return v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length; },
  stdev: (it, arr) => { const vv = ARRAY_METHOD_BUILTINS.variance(it, arr); return vv == null ? null : Math.sqrt(vv); },
  median: (it, arr) => { const v = arr.items.filter(x => x != null).slice().sort((a, b) => a - b); if(!v.length) return null; const mid = Math.floor(v.length / 2); return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid]; },
  mode: (it, arr) => {
    const v = arr.items.filter(x => x != null); if(!v.length) return null;
    const counts = new Map(); v.forEach(x => counts.set(x, (counts.get(x) || 0) + 1));
    let best = null, bc = -1;
    for(const [val, c] of counts){ if(c > bc || (c === bc && val < best)){ best = val; bc = c; } }
    return best;
  },
  range: (it, arr) => { const mx = pineArrayExtreme(arr.items, false); return mx == null ? null : mx - pineArrayExtreme(arr.items, true); },
  every: (it, arr) => arr.items.every(x => pineTruthy(x)),
  some: (it, arr) => arr.items.some(x => pineTruthy(x)),
  percentrank: (it, arr, p) => {
    const idx = Math.round(pineNum(p[0])); const v = arr.items[idx]; if(v == null || !arr.items.length) return null;
    let count = 0; arr.items.forEach(x => { if(x != null && x <= v) count++; });
    return count / arr.items.length * 100;
  },
  covariance: (it, arr, p) => {
    const other = p[0]; if(!(other instanceof PineArray)) return null;
    const a = arr.items, b = other.items; const len = Math.min(a.length, b.length); if(!len) return null;
    const ma = a.slice(0, len).reduce((x, y) => x + y, 0) / len, mb = b.slice(0, len).reduce((x, y) => x + y, 0) / len;
    let cov = 0; for(let k = 0; k < len; k++) cov += (a[k] - ma) * (b[k] - mb);
    return cov / len;
  },
  standardize: (it, arr) => {
    const v = arr.items.filter(x => x != null); if(!v.length) return new PineArray([], arr.kind);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
    return new PineArray(arr.items.map(x => x == null ? null : (sd === 0 ? 0 : (x - m) / sd)), arr.kind);
  },
};

function wrapArrayFn(method){
  return (it, p, n, node) => {
    const arr = p[0];
    if(!(arr instanceof PineArray)) throw new PineRuntimeError(pineMsg('array.' + method + '()의 첫 인자는 배열이어야 합니다', 'array.' + method + "()'s first argument must be an array"), node ? node.line : 0);
    return ARRAY_METHOD_BUILTINS[method](it, arr, p.slice(1), n, node);
  };
}
function arrayNewFn(kind){
  return (it, p) => {
    const size = p.length ? Math.round(pineNum(p[0])) : 0;
    const initial = p.length > 1 ? p[1] : (kind === 'bool' ? false : (kind === 'string' ? '' : null));
    return new PineArray(new Array(Math.max(0, size)).fill(initial), kind);
  };
}

// ============================================================
// English: map.* — supports both the static call form (map.get(id,k)) and the method-call form
// (id.get(k)), the same way array.* does.
// map.* — array.*와 같은 방식으로 정적 호출(map.get(id,k))/메서드 호출(id.get(k)) 양쪽을 지원한다.
// ============================================================
const MAP_METHODS = {
  put: (it, m, p) => { const k = p[0]; const v = p[1] === undefined ? null : p[1]; const old = m.map.has(k) ? m.map.get(k) : null; m.map.set(k, v); return old; },
  put_all: (it, m, p) => { const other = p[0]; if(other instanceof PineMap) for(const [k, v] of other.map) m.map.set(k, v); return null; },
  get: (it, m, p) => m.map.has(p[0]) ? m.map.get(p[0]) : null,
  contains: (it, m, p) => m.map.has(p[0]),
  // Real Pine also treats remove() on a missing key as a no-op (not an error).
  // 실제 Pine도 없는 키를 remove()하면 그냥 아무 일도 안 일어난다(에러 아님).
  remove: (it, m, p) => { const k = p[0]; if(!m.map.has(k)) return null; const v = m.map.get(k); m.map.delete(k); return v; },
  clear: (it, m) => { m.map.clear(); return null; },
  copy: (it, m) => { const c = new PineMap(); for(const [k, v] of m.map) c.map.set(k, v); return c; },
  keys: (it, m) => new PineArray([...m.map.keys()], 'float'),
  values: (it, m) => new PineArray([...m.map.values()], 'float'),
  size: (it, m) => m.map.size,
};

// ============================================================
// English: matrix.* — structural operations (get/set/row/col/fill/reshape/...) and statistics
// (avg/min/max/median/mode/sum, reusing array.*'s median/mode implementations directly) follow
// the same pattern as array.*/table.*. Only the linear-algebra pieces — det/inv/rank/pinv/
// eigenvalues/eigenvectors — are implemented separately below as helpers.
// matrix.* — 구조 조작(get/set/row/col/fill/reshape/...)과 통계(avg/min/max/median/mode/sum,
// array.*의 median/mode 구현을 그대로 재사용)까지는 array.*/table.*와 같은 패턴이다. det/inv/rank/
// pinv/eigenvalues/eigenvectors 같은 선형대수 쪽만 아래에 별도 헬퍼로 구현한다.
// ============================================================
function pineMatAllValues(m){ const out = []; for(const row of m.data) for(const v of row) if(v != null) out.push(v); return out; }
function matToNumRows(m){ return m.data.map(row => row.map(v => pineNum(v))); }
function pineIdentityRow(n, r){ const row = new Array(n).fill(0); row[r] = 1; return row; }
function pineIdentityMatrixRows(n){ const rows = []; for(let r = 0; r < n; r++) rows.push(pineIdentityRow(n, r)); return rows; }

// Reduces [A|I] to [I|A⁻¹] via Gauss-Jordan elimination with partial pivoting. Returns null for a
// singular matrix (a pivot near zero).
// 부분 피벗팅 가우스-조르당 소거법으로 [A|I]를 [I|A⁻¹]까지 줄인다. 특이행렬(피벗이 0에 가까움)이면 null.
function pineMatInverseRows(rows){
  const n = rows.length;
  const a = rows.map((row, r) => row.concat(pineIdentityRow(n, r)));
  for(let col = 0; col < n; col++){
    let piv = col;
    for(let r = col + 1; r < n; r++) if(Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if(Math.abs(a[piv][col]) < 1e-12) return null;
    if(piv !== col){ const t = a[piv]; a[piv] = a[col]; a[col] = t; }
    const pv = a[col][col];
    for(let c = 0; c < 2 * n; c++) a[col][c] /= pv;
    for(let r = 0; r < n; r++){
      if(r === col) continue;
      const f = a[r][col];
      if(f === 0) continue;
      for(let c = 0; c < 2 * n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map(row => row.slice(n));
}
// Reduces to upper-triangular form via Gaussian elimination with partial pivoting, computing the
// determinant as (product of pivots) × (sign from row swaps) along the way.
// 부분 피벗팅 가우스 소거법으로 상삼각형까지 줄이면서 행렬식(피벗 곱 × 행 교환 부호)을 구한다.
function pineMatDetRows(rows){
  const n = rows.length;
  const a = rows.map(row => row.slice());
  let sign = 1, det = 1;
  for(let col = 0; col < n; col++){
    let piv = col;
    for(let r = col + 1; r < n; r++) if(Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if(Math.abs(a[piv][col]) < 1e-12) return 0;
    if(piv !== col){ const t = a[piv]; a[piv] = a[col]; a[col] = t; sign = -sign; }
    det *= a[col][col];
    for(let r = col + 1; r < n; r++){
      const f = a[r][col] / a[col][col];
      if(f === 0) continue;
      for(let c = col; c < n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return det * sign;
}
// Reduces to row-echelon form and counts the nonzero pivots — unlike det/inv, this works on
// non-square (m×n) matrices too. The tolerance scales with the matrix's value magnitude so
// rounding error isn't mistaken for a true zero.
// 행 사다리꼴로 줄이면서 0이 아닌 피벗 개수를 센다 — det/inv와 달리 정방행렬이 아니어도(m×n) 된다.
// 허용 오차는 행렬 값 크기에 비례해서 잡는다(반올림 오차를 진짜 0으로 오인하지 않게).
function pineMatRankRows(rows){
  const m = rows.length; if(!m) return 0;
  const n = rows[0].length;
  const a = rows.map(row => row.slice());
  let maxAbs = 0; for(const row of a) for(const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
  const eps = Math.max(1e-9, maxAbs * 1e-9);
  let rank = 0;
  for(let col = 0; col < n && rank < m; col++){
    let piv = -1, best = eps;
    for(let r = rank; r < m; r++) if(Math.abs(a[r][col]) > best){ best = Math.abs(a[r][col]); piv = r; }
    if(piv < 0) continue;
    const t = a[piv]; a[piv] = a[rank]; a[rank] = t;
    for(let r = rank + 1; r < m; r++){
      const f = a[r][col] / a[rank][col];
      if(f === 0) continue;
      for(let c = col; c < n; c++) a[r][c] -= f * a[rank][c];
    }
    rank++;
  }
  return rank;
}
function pineMatTransposeRows(rows){
  const m = rows.length, n = m ? rows[0].length : 0;
  const out = []; for(let c = 0; c < n; c++){ const row = new Array(m); for(let r = 0; r < m; r++) row[r] = rows[r][c]; out.push(row); }
  return out;
}
function pineMatMultRows(a, b){
  const ar = a.length, ac = a[0].length, bc = b[0].length;
  const out = [];
  for(let r = 0; r < ar; r++){
    const row = new Array(bc).fill(0);
    for(let c = 0; c < bc; c++){ let s = 0; for(let k = 0; k < ac; k++) s += a[r][k] * b[k][c]; row[c] = s; }
    out.push(row);
  }
  return out;
}
// Moore-Penrose pseudo-inverse — only handles the full-rank case, via the closed-form formula
// ((AᵀA)⁻¹Aᵀ when there are fewer columns, Aᵀ(AAᵀ)⁻¹ when there are fewer rows). A true SVD-based
// general solution would also have to handle rank-deficient matrices and is much heavier; real
// indicator scripts almost never produce that kind of input, so this approximation is good enough.
// 무어-펜로즈 유사역행렬 — 완전계수(full rank)인 경우만 정공식(열이 적으면 (AᵀA)⁻¹Aᵀ, 행이 적으면
// Aᵀ(AAᵀ)⁻¹)으로 계산한다. 진짜 SVD 기반 일반해는 계수 부족(rank-deficient) 행렬까지 다뤄야 해서
// 훨씬 무겁고, 실제 지표 스크립트에서 그런 입력이 나올 일은 거의 없어 이 정도로 근사한다.
function pineMatPinvRows(rows){
  const m = rows.length, n = rows[0].length;
  const t = pineMatTransposeRows(rows);
  if(m >= n){
    const inv = pineMatInverseRows(pineMatMultRows(t, rows));
    return inv ? pineMatMultRows(inv, t) : null;
  }
  const inv = pineMatInverseRows(pineMatMultRows(rows, t));
  return inv ? pineMatMultRows(t, inv) : null;
}
// Jacobi eigenvalue algorithm, symmetric matrices only — repeatedly applies rotations until the
// off-diagonal elements converge to 0. Symmetric matrices always have real eigenvalues (and the
// real TradingView docs likewise only document support for this case), so the QR algorithm needed
// to handle complex eigenvalues of general asymmetric matrices is not implemented here.
// 대칭행렬 전용 Jacobi 고유값 알고리즘 — 비대각 원소가 0으로 수렴할 때까지 반복 회전시킨다.
// 대칭행렬은 항상 실수 고유값을 가지므로(실제 TradingView 문서도 이 경우만 지원 대상으로 명시),
// 일반 비대칭 행렬의 복소 고유값까지 다루는 QR 알고리즘은 구현하지 않는다.
function pineJacobiEigen(rows){
  const n = rows.length;
  const a = rows.map(row => row.slice());
  const vecs = pineIdentityMatrixRows(n);
  for(let sweep = 0; sweep < 100; sweep++){
    let off = 0;
    for(let i = 0; i < n; i++) for(let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if(off < 1e-20) break;
    for(let p = 0; p < n; p++){
      for(let q = p + 1; q < n; q++){
        if(Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        const app = a[p][p], aqq = a[q][q], apq = a[p][q];
        a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
        a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
        a[p][q] = 0; a[q][p] = 0;
        for(let k = 0; k < n; k++){
          if(k === p || k === q) continue;
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[p][k] = a[k][p];
          a[k][q] = s * akp + c * akq; a[q][k] = a[k][q];
        }
        for(let k = 0; k < n; k++){
          const vkp = vecs[k][p], vkq = vecs[k][q];
          vecs[k][p] = c * vkp - s * vkq;
          vecs[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const eigenvalues = []; for(let i = 0; i < n; i++) eigenvalues.push(a[i][i]);
  // Sorted ascending (matches the order used in the real Pine docs) — eigenvectors' columns are
  // reordered the same way.
  // 오름차순 정렬(실제 Pine 문서 순서와 맞춤) — 고유벡터도 같은 순서로 열을 다시 배치한다.
  const order = eigenvalues.map((v, i) => i).sort((x, y) => eigenvalues[x] - eigenvalues[y]);
  const values = order.map(i => eigenvalues[i]);
  const vectors = []; for(let r = 0; r < n; r++) vectors.push(order.map(i => vecs[r][i]));
  return { values, vectors };
}
const MATRIX_METHODS = {
  rows: (it, m) => m.rowCount,
  columns: (it, m) => m.colCount,
  elements_count: (it, m) => m.rowCount * m.colCount,
  get: (it, m, p, n, node) => {
    const r = Math.round(pineNum(p[0])), c = Math.round(pineNum(p[1]));
    if(r < 0 || r >= m.rowCount || c < 0 || c >= m.colCount) throw new PineRuntimeError(pineMsg('행렬 인덱스 범위를 벗어났습니다', 'Matrix index out of range'), node ? node.line : 0);
    return m.data[r][c];
  },
  set: (it, m, p, n, node) => {
    const r = Math.round(pineNum(p[0])), c = Math.round(pineNum(p[1]));
    if(r < 0 || r >= m.rowCount || c < 0 || c >= m.colCount) throw new PineRuntimeError(pineMsg('행렬 인덱스 범위를 벗어났습니다', 'Matrix index out of range'), node ? node.line : 0);
    m.data[r][c] = p[2] === undefined ? null : p[2];
    return null;
  },
  copy: (it, m) => new PineMatrix(m.data.map(row => row.slice())),
  row: (it, m, p) => new PineArray((m.data[Math.round(pineNum(p[0]))] || []).slice(), 'float'),
  col: (it, m, p) => { const c = Math.round(pineNum(p[0])); return new PineArray(m.data.map(row => row[c] === undefined ? null : row[c]), 'float'); },
  fill: (it, m, p, n) => {
    const value = getArg(p, n, 0, 'value', null);
    const fromRow = Math.round(pineNum(getArg(p, n, 1, 'from_row', 0)));
    const toRow = Math.round(pineNum(getArg(p, n, 2, 'to_row', m.rowCount)));
    const fromCol = Math.round(pineNum(getArg(p, n, 3, 'from_column', 0)));
    const toCol = Math.round(pineNum(getArg(p, n, 4, 'to_column', m.colCount)));
    for(let r = fromRow; r < toRow && r < m.rowCount; r++) for(let c = fromCol; c < toCol && c < m.colCount; c++) m.data[r][c] = value;
    return null;
  },
  add_row: (it, m, p, n) => {
    const idx = Math.round(pineNum(getArg(p, n, 0, 'row_index', m.rowCount)));
    const arr = getArg(p, n, 1, 'array_id', null);
    const cols = m.colCount || (arr instanceof PineArray ? arr.items.length : 0);
    const newRow = arr instanceof PineArray
      ? arr.items.slice(0, cols).concat(new Array(Math.max(0, cols - arr.items.length)).fill(null))
      : new Array(cols).fill(null);
    m.data.splice(Math.max(0, Math.min(idx, m.rowCount)), 0, newRow);
    return null;
  },
  add_col: (it, m, p, n) => {
    const idx = Math.round(pineNum(getArg(p, n, 0, 'column_index', m.colCount)));
    const arr = getArg(p, n, 1, 'array_id', null);
    if(!m.rowCount){ const rows = arr instanceof PineArray ? arr.items.length : 0; for(let r = 0; r < rows; r++) m.data.push([]); }
    const at = Math.max(0, Math.min(idx, m.colCount));
    for(let r = 0; r < m.rowCount; r++) m.data[r].splice(at, 0, arr instanceof PineArray ? (arr.items[r] === undefined ? null : arr.items[r]) : null);
    return null;
  },
  remove_row: (it, m, p, n) => { const idx = Math.round(pineNum(getArg(p, n, 0, 'row_index', m.rowCount - 1))); if(idx >= 0 && idx < m.rowCount) m.data.splice(idx, 1); return null; },
  remove_col: (it, m, p, n) => { const idx = Math.round(pineNum(getArg(p, n, 0, 'column_index', m.colCount - 1))); if(idx >= 0 && idx < m.colCount) for(const row of m.data) row.splice(idx, 1); return null; },
  reshape: (it, m, p) => {
    const newRows = Math.round(pineNum(p[0])), newCols = Math.round(pineNum(p[1]));
    const flat = []; for(const row of m.data) for(const v of row) flat.push(v);
    const data = [];
    for(let r = 0; r < newRows; r++){ const row = new Array(newCols); for(let c = 0; c < newCols; c++){ const idx = r * newCols + c; row[c] = idx < flat.length ? flat[idx] : null; } data.push(row); }
    m.data = data;
    return null;
  },
  swap_rows: (it, m, p) => { const a = Math.round(pineNum(p[0])), b = Math.round(pineNum(p[1])); const t = m.data[a]; m.data[a] = m.data[b]; m.data[b] = t; return null; },
  swap_columns: (it, m, p) => { const a = Math.round(pineNum(p[0])), b = Math.round(pineNum(p[1])); for(const row of m.data){ const t = row[a]; row[a] = row[b]; row[b] = t; } return null; },
  reverse: (it, m) => { m.data.reverse(); return null; },
  transpose: (it, m) => { m.data = pineMatTransposeRows(m.data); return m; },
  concat: (it, m, p) => { const other = p[0]; if(other instanceof PineMatrix) for(const row of other.data) m.data.push(row.slice()); return m; },
  submatrix: (it, m, p, n) => {
    const fromRow = Math.round(pineNum(getArg(p, n, 0, 'from_row', 0)));
    const toRow = Math.round(pineNum(getArg(p, n, 1, 'to_row', m.rowCount)));
    const fromCol = Math.round(pineNum(getArg(p, n, 2, 'from_column', 0)));
    const toCol = Math.round(pineNum(getArg(p, n, 3, 'to_column', m.colCount)));
    const data = []; for(let r = fromRow; r < toRow && r < m.rowCount; r++) data.push(m.data[r].slice(fromCol, toCol));
    return new PineMatrix(data);
  },
  avg: (it, m) => { const v = pineMatAllValues(m); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; },
  min: (it, m) => pineArrayExtreme(pineMatAllValues(m), true),
  max: (it, m) => pineArrayExtreme(pineMatAllValues(m), false),
  sum: (it, m) => pineMatAllValues(m).reduce((a, b) => a + b, 0),
  median: (it, m) => ARRAY_METHOD_BUILTINS.median(it, new PineArray(pineMatAllValues(m))),
  mode: (it, m) => ARRAY_METHOD_BUILTINS.mode(it, new PineArray(pineMatAllValues(m))),
  mult: (it, m, p, n, node) => {
    const other = p[0];
    if(other instanceof PineMatrix){
      if(m.colCount !== other.rowCount) throw new PineRuntimeError(pineMsg('행렬 곱: 첫 행렬의 열 수와 두 번째 행렬의 행 수가 같아야 합니다', "matrix.mult: the first matrix's column count must equal the second matrix's row count"), node ? node.line : 0);
      return new PineMatrix(pineMatMultRows(matToNumRows(m), matToNumRows(other)));
    }
    const s = pineNum(other);
    return new PineMatrix(m.data.map(row => row.map(v => v == null ? null : pineNum(v) * s)));
  },
  pow: (it, m, p, n, node) => {
    if(m.rowCount !== m.colCount) throw new PineRuntimeError(pineMsg('matrix.pow()는 정방행렬에만 쓸 수 있습니다', 'matrix.pow() requires a square matrix'), node ? node.line : 0);
    const power = Math.round(pineNum(p[0]));
    let rows = pineIdentityMatrixRows(m.rowCount);
    const base = matToNumRows(m);
    for(let i = 0; i < power; i++) rows = pineMatMultRows(rows, base);
    return new PineMatrix(rows);
  },
  kron: (it, m, p) => {
    const other = p[0]; if(!(other instanceof PineMatrix)) return null;
    const out = [];
    for(let r = 0; r < m.rowCount; r++){
      for(let orr = 0; orr < other.rowCount; orr++){
        const row = [];
        for(let c = 0; c < m.colCount; c++) for(let occ = 0; occ < other.colCount; occ++) row.push(pineNum(m.data[r][c]) * pineNum(other.data[orr][occ]));
        out.push(row);
      }
    }
    return new PineMatrix(out);
  },
  to_array: (it, m) => { const items = []; for(const row of m.data) for(const v of row) items.push(v); return new PineArray(items, 'float'); },
  is_square: (it, m) => m.rowCount === m.colCount && m.rowCount > 0,
  is_zero: (it, m) => m.data.every(row => row.every(v => pineNum(v) === 0)),
  is_identity: (it, m) => {
    if(m.rowCount !== m.colCount) return false;
    for(let r = 0; r < m.rowCount; r++) for(let c = 0; c < m.colCount; c++) if(pineNum(m.data[r][c]) !== (r === c ? 1 : 0)) return false;
    return true;
  },
  is_binary: (it, m) => m.data.every(row => row.every(v => { const x = pineNum(v); return x === 0 || x === 1; })),
  is_symmetric: (it, m) => {
    if(m.rowCount !== m.colCount) return false;
    for(let r = 0; r < m.rowCount; r++) for(let c = r + 1; c < m.colCount; c++) if(Math.abs(pineNum(m.data[r][c]) - pineNum(m.data[c][r])) > 1e-9) return false;
    return true;
  },
  is_antisymmetric: (it, m) => {
    if(m.rowCount !== m.colCount) return false;
    for(let r = 0; r < m.rowCount; r++) for(let c = 0; c < m.colCount; c++) if(Math.abs(pineNum(m.data[r][c]) + pineNum(m.data[c][r])) > 1e-9) return false;
    return true;
  },
  is_diagonal: (it, m) => {
    if(m.rowCount !== m.colCount) return false;
    for(let r = 0; r < m.rowCount; r++) for(let c = 0; c < m.colCount; c++) if(r !== c && pineNum(m.data[r][c]) !== 0) return false;
    return true;
  },
  is_triangular: (it, m) => {
    if(m.rowCount !== m.colCount) return false;
    let upper = true, lower = true;
    for(let r = 0; r < m.rowCount; r++) for(let c = 0; c < m.colCount; c++){ if(r > c && pineNum(m.data[r][c]) !== 0) upper = false; if(r < c && pineNum(m.data[r][c]) !== 0) lower = false; }
    return upper || lower;
  },
  trace: (it, m) => { let s = 0; for(let i = 0; i < Math.min(m.rowCount, m.colCount); i++) s += pineNum(m.data[i][i]); return s; },
  det: (it, m, p, n, node) => {
    if(m.rowCount !== m.colCount) throw new PineRuntimeError(pineMsg('행렬식은 정방행렬에서만 계산할 수 있습니다', 'Determinant can only be computed for a square matrix'), node ? node.line : 0);
    return m.rowCount ? pineMatDetRows(matToNumRows(m)) : 1;
  },
  inv: (it, m, p, n, node) => {
    if(m.rowCount !== m.colCount) throw new PineRuntimeError(pineMsg('역행렬은 정방행렬에서만 계산할 수 있습니다', 'Inverse can only be computed for a square matrix'), node ? node.line : 0);
    if(!m.rowCount) return new PineMatrix([]);
    const inv = pineMatInverseRows(matToNumRows(m));
    if(!inv) throw new PineRuntimeError(pineMsg('특이행렬(행렬식이 0)은 역행렬을 구할 수 없습니다', 'Cannot invert a singular matrix (determinant is 0)'), node ? node.line : 0);
    return new PineMatrix(inv);
  },
  pinv: (it, m, p, n, node) => {
    if(!m.rowCount || !m.colCount) return new PineMatrix([]);
    const r = pineMatPinvRows(matToNumRows(m));
    if(!r) throw new PineRuntimeError(pineMsg('이 근사 유사역행렬 구현은 계수 부족(rank-deficient) 행렬을 지원하지 않습니다', "This approximate pseudo-inverse doesn't support rank-deficient matrices"), node ? node.line : 0);
    return new PineMatrix(r);
  },
  rank: (it, m) => m.rowCount ? pineMatRankRows(matToNumRows(m)) : 0,
  eigenvalues: (it, m, p, n, node) => {
    if(m.rowCount !== m.colCount) throw new PineRuntimeError(pineMsg('고유값은 정방행렬에서만 계산할 수 있습니다', 'Eigenvalues can only be computed for a square matrix'), node ? node.line : 0);
    if(!m.rowCount) return new PineArray([], 'float');
    if(!MATRIX_METHODS.is_symmetric(it, m)) throw new PineRuntimeError(pineMsg('이 엔진은 대칭행렬의 고유값만 지원합니다(비대칭 행렬은 복소수 고유값이 나올 수 있음)', 'This engine only supports eigenvalues of symmetric matrices (non-symmetric matrices can have complex eigenvalues)'), node ? node.line : 0);
    return new PineArray(pineJacobiEigen(matToNumRows(m)).values, 'float');
  },
  eigenvectors: (it, m, p, n, node) => {
    if(m.rowCount !== m.colCount) throw new PineRuntimeError(pineMsg('고유벡터는 정방행렬에서만 계산할 수 있습니다', 'Eigenvectors can only be computed for a square matrix'), node ? node.line : 0);
    if(!m.rowCount) return new PineMatrix([]);
    if(!MATRIX_METHODS.is_symmetric(it, m)) throw new PineRuntimeError(pineMsg('이 엔진은 대칭행렬의 고유벡터만 지원합니다', 'This engine only supports eigenvectors of symmetric matrices'), node ? node.line : 0);
    return new PineMatrix(pineJacobiEigen(matToNumRows(m)).vectors);
  },
  is_stable: (it, m) => {
    if(m.rowCount !== m.colCount || !m.rowCount || !MATRIX_METHODS.is_symmetric(it, m)) return false;
    return pineJacobiEigen(matToNumRows(m)).values.every(v => Math.abs(v) < 1);
  },
};

// ============================================================
// English: input.* — the input() family collects metadata during the first execution (bar 0) so
// pine-import.js can auto-render an input form; when the value changes in the UI it's applied as
// an override via inputOverrides.
// input.* — input() 계열은 첫 실행(bar 0)에서 메타데이터를 수집해서 pine-import.js가
// 자동으로 입력 폼을 그릴 수 있게 하고, UI에서 값이 바뀌면 inputOverrides로 덮어쓴다.
// ============================================================
function findDefvalArgNode(node){
  const named = node.args.find(a => a.named && a.name === 'defval');
  if(named) return named.value;
  const pos = node.args.filter(a => !a.named);
  return pos.length ? pos[0].value : null;
}
function inputFn(kind){
  return (it, p, n, node) => {
    const defval = p.length ? p[0] : (n.hasOwnProperty('defval') ? n.defval : null);
    const title = n.title || (p.length > 1 ? p[1] : null) || pineMsg('입력 ' + node.id, 'Input ' + node.id);
    if(it.curBar === 0){
      const defvalNode = findDefvalArgNode(node);
      const isLiteral = !!defvalNode && ['Number', 'String', 'Bool', 'Na'].includes(defvalNode.type);
      let effKind = kind;
      if(kind === 'generic'){
        effKind = typeof defval === 'boolean' ? 'bool' : (typeof defval === 'string' ? 'string' : 'float');
      }
      // If the value is an expression like close/hlc3 (not a literal), it's a "source selector"
      // input — it shouldn't be editable as an arbitrary number, so it's excluded from the form.
      // 값이 close/hlc3 같은 계산식(리터럴이 아님)이면 '소스 선택' 용도라 임의 숫자로 편집하게 두면 안 되므로 폼에서 뺀다
      const skip = !isLiteral && (kind === 'generic' || kind === 'source');
      if(!skip){
        const opts = n.options instanceof PineArray ? n.options.items : (Array.isArray(n.options) ? n.options : null);
        it.inputMeta.push({
          id: node.id, kind: effKind, title,
          defval, minval: n.minval != null ? n.minval : null, maxval: n.maxval != null ? n.maxval : null,
          step: n.step != null ? n.step : null, options: opts,
        });
      }
    }
    if(it.inputOverrides.hasOwnProperty(node.id)) return it.inputOverrides[node.id];
    return defval;
  };
}

// ============================================================
// English: ta.* — functions that need internal state store a buffer/previous-value pair in
// callState, keyed per call site (node.id).
// ta.* — 내부 상태가 필요한 함수들은 콜사이트(node.id)별로 callState에 버퍼/이전값을 저장한다.
// ============================================================
function taRollingBuf(it, node){ const s = getState(it, node); if(!s.buf) s.buf = new Array(it.n); return s; }
// Helper reused when running Wilder's RMA independently over several values (TR/+DM/-DM/ADX, etc).
// Keeps each key's warm-up sum buffer and previous value separately in the call state (s),
// generalizing the same pattern ta.atr uses.
// Wilder RMA를 여러 값(TR/+DM/-DM/ADX 등)에 대해 독립적으로 돌릴 때 재사용하는 헬퍼.
// key별로 워밍업 합계 버퍼와 이전 값을 콜스테이트(s)에 따로 보관한다 (ta.atr과 같은 패턴을 일반화).
function taRmaAdvance(s, key, len, curBar, value){
  const bufKey = key + 'Buf', prevKey = key + 'Prev';
  let buf = s[bufKey];
  if(!buf) buf = s[bufKey] = [];
  buf[curBar] = value;
  // If the value is na, hold the previous value, matching ta.rma's behavior — previously the na
  // was fed straight into the calculation, so null got treated as 0, and that result was then
  // saved back into prev, corrupting every subsequent bar.
  // 값이 na면 ta.rma와 동일하게 직전 값을 유지한다 — 예전엔 그대로 계산에 넣어서 null이 0으로
  // 취급되고, 그 결과가 다시 prev에 저장돼 이후 봉이 전부 오염됐다.
  if(value == null) return s[prevKey] == null ? null : s[prevKey];
  if(s[prevKey] != null){ const val = (s[prevKey] * (len - 1) + value) / len; s[prevKey] = val; return val; }
  if(curBar + 1 < len) return null;
  let sum = 0;
  for(let k = curBar - len + 1; k <= curBar; k++){ if(buf[k] == null) return null; sum += buf[k]; }
  const seed = sum / len; s[prevKey] = seed; return seed;
}
// Helper for running an EMA independently per key, using the same warm-up scheme as ta.ema
// (seeding directly from the first call's value).
// ta.ema과 같은 워밍업(첫 호출값을 그대로 시드로 삼는) 방식의 EMA를 key별로 독립적으로 돌릴 때 쓰는 헬퍼.
function taEmaAdvance(s, key, len, value){
  const prevKey = key + 'Prev';
  if(value == null) return s[prevKey] == null ? null : s[prevKey];
  const alpha = 2 / (len + 1);
  if(s[prevKey] == null){ s[prevKey] = value; return value; }
  const val = alpha * value + (1 - alpha) * s[prevKey]; s[prevKey] = val; return val;
}
// Internal helper for ta.macd / ta.hma. It used to live inside the built-in function body, which
// meant a new closure got created "per bar × per call" (500 bars × multiple calls = pure garbage).
// Behavior is unchanged — only the location was moved out.
// ta.macd / ta.hma의 내부 헬퍼. 예전엔 빌트인 함수 본문 안에 있어서 "봉마다 · 호출마다" 클로저가
// 새로 만들어졌다(500봉 × 여러 호출 = 순수 쓰레기). 동작은 그대로 두고 위치만 밖으로 뺐다.
function taMacdEmaStep(state, len, v){
  const alpha = 2 / (len + 1);
  if(state.v == null){ state.v = v; return v; }
  const val = alpha * v + (1 - alpha) * state.v; state.v = val; return val;
}
function taWmaOf(buf, ln, endIdx){
  const start = endIdx - ln + 1; if(ln < 1 || start < 0) return null;
  let wsum = 0, norm = 0;
  for(let k = start; k <= endIdx; k++){ if(buf[k] == null) return null; const w = k - start + 1; wsum += buf[k] * w; norm += w; }
  return wsum / norm;
}

const TA_NS = {
  'ta.sma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    if(len < 1) return null;
    const start = it.curBar - len + 1; if(start < 0) return null;
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    return sum / len;
  },
  'ta.ema': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = getState(it, node);
    if(src == null) return s.prev == null ? null : s.prev;
    const alpha = 2 / (len + 1);
    if(s.prev == null){ s.prev = src; return src; }
    const val = alpha * src + (1 - alpha) * s.prev; s.prev = val; return val;
  },
  'ta.rma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    if(s.prev != null){ if(src == null) return s.prev; const val = (s.prev * (len - 1) + src) / len; s.prev = val; return val; }
    if(it.curBar + 1 < len) return null;
    let sum = 0;
    for(let k = it.curBar - len + 1; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    const seed = sum / len; s.prev = seed; return seed;
  },
  'ta.wma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    if(len < 1) return null; const start = it.curBar - len + 1; if(start < 0) return null;
    let wsum = 0, norm = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; const w = k - start + 1; wsum += s.buf[k] * w; norm += w; }
    return wsum / norm;
  },
  'ta.vwma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    // Instead of allocating a new {v, vol} object per bar, keep value and volume in separate
    // buffers (saves one object per bar).
    // 봉마다 {v, vol} 객체를 새로 만들지 않고 값/거래량을 각각의 버퍼에 나눠 담는다(봉 수만큼의 객체 절약)
    const s = getState(it, node); if(!s.buf){ s.buf = new Array(it.n); s.volBuf = new Array(it.n); }
    s.buf[it.curBar] = src; s.volBuf[it.curBar] = it.volArr[it.curBar];
    if(len < 1) return null; const start = it.curBar - len + 1; if(start < 0) return null;
    let num = 0, den = 0;
    for(let k = start; k <= it.curBar; k++){ const v = s.buf[k]; if(v == null) return null; num += v * s.volBuf[k]; den += s.volBuf[k]; }
    return den === 0 ? null : num / den;
  },
  'ta.variance': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    const mean = sum / len; let sq = 0;
    for(let k = start; k <= it.curBar; k++){ const d = s.buf[k] - mean; sq += d * d; }
    return sq / len;
  },
  'ta.stdev': (it, p, n, node) => { const v = TA_NS['ta.variance'](it, p, n, node); return v == null ? null : Math.sqrt(v); },
  'ta.highest': (it, p, n, node) => {
    const twoArg = p.length >= 2 || n.hasOwnProperty('source');
    let arr, len;
    if(twoArg){ const src = getArg(p, n, 0, 'source'); len = Math.round(pineNum(getArg(p, n, 1, 'length'))); const s = taRollingBuf(it, node); s.buf[it.curBar] = src; arr = s.buf; }
    else { len = Math.round(pineNum(getArg(p, n, 0, 'length'))); arr = it.highArr; }
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let mx = -Infinity;
    for(let k = start; k <= it.curBar; k++){ if(arr[k] == null) return null; if(arr[k] > mx) mx = arr[k]; }
    return mx;
  },
  'ta.lowest': (it, p, n, node) => {
    const twoArg = p.length >= 2 || n.hasOwnProperty('source');
    let arr, len;
    if(twoArg){ const src = getArg(p, n, 0, 'source'); len = Math.round(pineNum(getArg(p, n, 1, 'length'))); const s = taRollingBuf(it, node); s.buf[it.curBar] = src; arr = s.buf; }
    else { len = Math.round(pineNum(getArg(p, n, 0, 'length'))); arr = it.lowArr; }
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let mn = Infinity;
    for(let k = start; k <= it.curBar; k++){ if(arr[k] == null) return null; if(arr[k] < mn) mn = arr[k]; }
    return mn;
  },
  'ta.tr': (it) => {
    const i = it.curBar; const h = it.highArr[i], l = it.lowArr[i], pc = i > 0 ? it.closeArr[i - 1] : null;
    return pc == null ? (h - l) : Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  },
  'ta.atr': (it, p, n, node) => {
    const len = Math.round(pineNum(getArg(p, n, 0, 'length')));
    const tr = TA_NS['ta.tr'](it);
    const s = getState(it, node); if(!s.buf) s.buf = new Array(it.n); s.buf[it.curBar] = tr;
    if(s.prev != null){ const val = (s.prev * (len - 1) + tr) / len; s.prev = val; return val; }
    if(it.curBar + 1 < len) return null;
    let sum = 0;
    for(let k = it.curBar - len + 1; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    const seed = sum / len; s.prev = seed; return seed;
  },
  'ta.rsi': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = getState(it, node);
    if(s.prevSrc == null){ s.prevSrc = src; return null; }
    const change = src - s.prevSrc; s.prevSrc = src;
    const gain = Math.max(change, 0), loss = Math.max(-change, 0);
    if(!s.gbuf){ s.gbuf = new Array(it.n); s.lbuf = new Array(it.n); }
    s.gbuf[it.curBar] = gain; s.lbuf[it.curBar] = loss;
    let up, down;
    if(s.upPrev != null){ up = (s.upPrev * (len - 1) + gain) / len; down = (s.downPrev * (len - 1) + loss) / len; }
    else {
      if(it.curBar - len + 1 < 0) return null;
      let su = 0, sd = 0;
      for(let k = it.curBar - len + 1; k <= it.curBar; k++){ if(s.gbuf[k] == null) return null; su += s.gbuf[k]; sd += s.lbuf[k]; }
      up = su / len; down = sd / len;
    }
    s.upPrev = up; s.downPrev = down;
    if(down === 0) return up === 0 ? 50 : 100;
    return 100 - 100 / (1 + up / down);
  },
  'ta.macd': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source');
    const fast = Math.round(pineNum(getArg(p, n, 1, 'fastlen', 12)));
    const slow = Math.round(pineNum(getArg(p, n, 2, 'slowlen', 26)));
    const sig = Math.round(pineNum(getArg(p, n, 3, 'siglen', 9)));
    const s = getState(it, node);
    if(!s.fastS){ s.fastS = { v: null }; s.slowS = { v: null }; s.sigS = { v: null }; }
    const fastVal = taMacdEmaStep(s.fastS, fast, src);
    const slowVal = taMacdEmaStep(s.slowS, slow, src);
    const macdVal = fastVal - slowVal;
    const signalVal = taMacdEmaStep(s.sigS, sig, macdVal);
    return [macdVal, signalVal, macdVal - signalVal];
  },
  'ta.change': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length', 1)));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const at = it.curBar - len; if(at < 0 || s.buf[at] == null || src == null) return null; return src - s.buf[at];
  },
  'ta.mom': (it, p, n, node) => TA_NS['ta.change'](it, p, n, node),
  'ta.roc': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const at = it.curBar - len; if(at < 0 || !s.buf[at] || src == null) return null; return (src - s.buf[at]) / s.buf[at] * 100;
  },
  'ta.cum': (it, p, n, node) => { const src = getArg(p, n, 0, 'source'); const s = getState(it, node); s.sum = (s.sum || 0) + (src || 0); return s.sum; },
  'ta.crossover': (it, p, n, node) => {
    const a = getArg(p, n, 0, 'source1'), b = getArg(p, n, 1, 'source2');
    const s = getState(it, node); const pa = s.prevA, pb = s.prevB; s.prevA = a; s.prevB = b;
    if(pa == null || pb == null || a == null || b == null) return false;
    return pa <= pb && a > b;
  },
  'ta.crossunder': (it, p, n, node) => {
    const a = getArg(p, n, 0, 'source1'), b = getArg(p, n, 1, 'source2');
    const s = getState(it, node); const pa = s.prevA, pb = s.prevB; s.prevA = a; s.prevB = b;
    if(pa == null || pb == null || a == null || b == null) return false;
    return pa >= pb && a < b;
  },
  'ta.cross': (it, p, n, node) => {
    const a = getArg(p, n, 0, 'source1'), b = getArg(p, n, 1, 'source2');
    const s = getState(it, node); const pa = s.prevA, pb = s.prevB; s.prevA = a; s.prevB = b;
    if(pa == null || pb == null || a == null || b == null) return false;
    return (pa <= pb && a > b) || (pa >= pb && a < b);
  },
  'ta.barssince': (it, p, n, node) => {
    const cond = pineTruthy(getArg(p, n, 0, 'condition'));
    const s = getState(it, node);
    if(cond){ s.count = 0; return 0; }
    if(s.count == null) return null;
    s.count++; return s.count;
  },
  'ta.valuewhen': (it, p, n, node) => {
    const cond = pineTruthy(getArg(p, n, 0, 'condition')); const src = getArg(p, n, 1, 'source');
    const occ = Math.round(pineNum(getArg(p, n, 2, 'occurrence', 0)));
    // Unshifting each new value to the front would shift the whole array every time as history
    // accumulates (quadratic in bar count for scripts where the condition is frequently true).
    // Pushing to the back and counting from the end gives the same result at O(1) cost.
    // 새 값을 앞에 unshift하면 기록이 쌓일수록 매번 배열 전체가 밀린다(조건이 자주 참인 스크립트에서
    // 봉 수의 제곱에 비례). 뒤에 push하고 끝에서부터 세면 결과는 같고 비용은 O(1)이다.
    const s = getState(it, node); if(!s.hits) s.hits = [];
    if(cond) s.hits.push(src);
    const at = s.hits.length - 1 - occ;
    return at >= 0 ? s.hits[at] : null;
  },
  'ta.correlation': (it, p, n, node) => {
    const a = getArg(p, n, 0, 'source1'), b = getArg(p, n, 1, 'source2'); const len = Math.round(pineNum(getArg(p, n, 2, 'length')));
    const s = getState(it, node); if(!s.abuf){ s.abuf = new Array(it.n); s.bbuf = new Array(it.n); }
    s.abuf[it.curBar] = a; s.bbuf[it.curBar] = b;
    const start = it.curBar - len + 1; if(len < 2 || start < 0) return null;
    let sa = 0, sb = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.abuf[k] == null || s.bbuf[k] == null) return null; sa += s.abuf[k]; sb += s.bbuf[k]; }
    const ma = sa / len, mb = sb / len; let cov = 0, va = 0, vb = 0;
    for(let k = start; k <= it.curBar; k++){ const da = s.abuf[k] - ma, db = s.bbuf[k] - mb; cov += da * db; va += da * da; vb += db * db; }
    if(va === 0 || vb === 0) return null; return cov / Math.sqrt(va * vb);
  },
  'ta.vwap': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source', it.hlc3Arr[it.curBar]);
    const anchor = pineTruthy(getArg(p, n, 1, 'anchor', false));
    const mult = getArg(p, n, 2, 'stdev_mult', 1);
    const vol = it.volArr[it.curBar] || 0;
    const s = getState(it, node);
    if(s.sumPV == null || anchor){ s.sumPV = 0; s.sumV = 0; s.sumPV2 = 0; }
    s.sumPV += src * vol; s.sumV += vol; s.sumPV2 += src * src * vol;
    if(s.sumV === 0) return [null, null, null];
    const vwap = s.sumPV / s.sumV;
    const variance = Math.max(0, s.sumPV2 / s.sumV - vwap * vwap);
    const stdev = Math.sqrt(variance);
    return [vwap, vwap + mult * stdev, vwap - mult * stdev];
  },
  'ta.pivothigh': (it, p, n, node) => {
    let src, left, right;
    if(p.length >= 3 || n.hasOwnProperty('source')){
      const srcVal = getArg(p, n, 0, 'source'); left = Math.round(pineNum(getArg(p, n, 1, 'leftbars'))); right = Math.round(pineNum(getArg(p, n, 2, 'rightbars')));
      const s = taRollingBuf(it, node); s.buf[it.curBar] = srcVal; src = s.buf;
    } else {
      left = Math.round(pineNum(getArg(p, n, 0, 'leftbars'))); right = Math.round(pineNum(getArg(p, n, 1, 'rightbars'))); src = it.highArr;
    }
    const center = it.curBar - right;
    if(center < left) return null;
    const centerVal = src[center];
    if(centerVal == null) return null;
    for(let k = center - left; k <= center + right; k++){
      if(k === center) continue;
      if(k < 0 || src[k] == null) return null;
      if(src[k] > centerVal) return null;
    }
    return centerVal;
  },
  'ta.pivotlow': (it, p, n, node) => {
    let src, left, right;
    if(p.length >= 3 || n.hasOwnProperty('source')){
      const srcVal = getArg(p, n, 0, 'source'); left = Math.round(pineNum(getArg(p, n, 1, 'leftbars'))); right = Math.round(pineNum(getArg(p, n, 2, 'rightbars')));
      const s = taRollingBuf(it, node); s.buf[it.curBar] = srcVal; src = s.buf;
    } else {
      left = Math.round(pineNum(getArg(p, n, 0, 'leftbars'))); right = Math.round(pineNum(getArg(p, n, 1, 'rightbars'))); src = it.lowArr;
    }
    const center = it.curBar - right;
    if(center < left) return null;
    const centerVal = src[center];
    if(centerVal == null) return null;
    for(let k = center - left; k <= center + right; k++){
      if(k === center) continue;
      if(k < 0 || src[k] == null) return null;
      if(src[k] < centerVal) return null;
    }
    return centerVal;
  },
  'ta.linreg': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const offset = Math.round(pineNum(getArg(p, n, 2, 'offset', 0)));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1;
    if(len < 2 || start < 0) return null;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for(let k = 0; k < len; k++){
      const y = s.buf[start + k];
      if(y == null) return null;
      sumX += k; sumY += y; sumXY += k * y; sumX2 += k * k;
    }
    const denom = len * sumX2 - sumX * sumX;
    if(denom === 0) return null;
    const slope = (len * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / len;
    return intercept + slope * (len - 1 + offset);
  },
  'ta.dev': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    const mean = sum / len; let sad = 0;
    for(let k = start; k <= it.curBar; k++) sad += Math.abs(s.buf[k] - mean);
    return sad / len;
  },
  'ta.alma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const offset = pineNum(getArg(p, n, 2, 'offset', 0.85)); const sigma = pineNum(getArg(p, n, 3, 'sigma', 6));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    const m = offset * (len - 1); const sg = len / sigma;
    let num = 0, den = 0;
    for(let k = 0; k < len; k++){
      const v = s.buf[start + k]; if(v == null) return null;
      const w = Math.exp(-((k - m) * (k - m)) / (2 * sg * sg));
      num += w * v; den += w;
    }
    return den === 0 ? null : num / den;
  },
  'ta.swma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source');
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - 3; if(start < 0) return null;
    const w = [1, 2, 2, 1]; let sum = 0;
    for(let k = 0; k < 4; k++){ const v = s.buf[start + k]; if(v == null) return null; sum += v * w[k]; }
    return sum / 6;
  },
  'ta.hma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const halfLen = Math.max(1, Math.round(len / 2)), sqrtLen = Math.max(1, Math.round(Math.sqrt(len)));
    const s = getState(it, node);
    if(!s.buf) s.buf = new Array(it.n); s.buf[it.curBar] = src;
    const wmaHalf = taWmaOf(s.buf, halfLen, it.curBar), wmaFull = taWmaOf(s.buf, len, it.curBar);
    if(wmaHalf == null || wmaFull == null) return null;
    if(!s.rawBuf) s.rawBuf = new Array(it.n);
    s.rawBuf[it.curBar] = 2 * wmaHalf - wmaFull;
    return taWmaOf(s.rawBuf, sqrtLen, it.curBar);
  },
  'ta.median': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    const vals = [];
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; vals.push(s.buf[k]); }
    vals.sort((a, b) => a - b);
    const mid = Math.floor(len / 2);
    return len % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
  },
  'ta.mode': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    const counts = new Map();
    for(let k = start; k <= it.curBar; k++){ const v = s.buf[k]; if(v == null) return null; counts.set(v, (counts.get(v) || 0) + 1); }
    let best = null, bestCount = -1;
    for(const [v, c] of counts){ if(c > bestCount || (c === bestCount && v < best)){ best = v; bestCount = c; } }
    return best;
  },
  'ta.range': (it, p, n, node) => {
    const hi = TA_NS['ta.highest'](it, p, n, node); const lo = TA_NS['ta.lowest'](it, p, n, node);
    return (hi == null || lo == null) ? null : hi - lo;
  },
  'ta.percentrank': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    if(len < 1 || it.curBar < len || src == null) return null;
    let count = 0, valid = 0;
    for(let k = it.curBar - len; k < it.curBar; k++){ const v = s.buf[k]; if(v == null) continue; valid++; if(v <= src) count++; }
    return valid === 0 ? null : (count / valid) * 100;
  },
  'ta.percentile_linear_interpolation': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const pct = pineNum(getArg(p, n, 2, 'percentage'));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    const vals = [];
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; vals.push(s.buf[k]); }
    vals.sort((a, b) => a - b);
    let idx = (pct / 100) * len - 0.5;
    if(idx < 0) idx = 0; if(idx > len - 1) idx = len - 1;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if(lo === hi) return vals[lo];
    return vals[lo] + (idx - lo) * (vals[hi] - vals[lo]);
  },
  'ta.percentile_nearest_rank': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const pct = pineNum(getArg(p, n, 2, 'percentage'));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    const vals = [];
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; vals.push(s.buf[k]); }
    vals.sort((a, b) => a - b);
    let idx = Math.ceil((pct / 100) * len) - 1;
    if(idx < 0) idx = 0; if(idx >= len) idx = len - 1;
    return vals[idx];
  },
  'ta.falling': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    for(let k = 0; k < len; k++){
      const cur = s.buf[it.curBar - k]; const nxt = (it.curBar - k - 1 < 0) ? null : s.buf[it.curBar - k - 1];
      if(cur == null || nxt == null || cur >= nxt) return false;
    }
    return true;
  },
  'ta.rising': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    for(let k = 0; k < len; k++){
      const cur = s.buf[it.curBar - k]; const nxt = (it.curBar - k - 1 < 0) ? null : s.buf[it.curBar - k - 1];
      if(cur == null || nxt == null || cur <= nxt) return false;
    }
    return true;
  },
  'ta.highestbars': (it, p, n, node) => {
    const twoArg = p.length >= 2 || n.hasOwnProperty('source');
    let arr, len;
    if(twoArg){ const src = getArg(p, n, 0, 'source'); len = Math.round(pineNum(getArg(p, n, 1, 'length'))); const s = taRollingBuf(it, node); s.buf[it.curBar] = src; arr = s.buf; }
    else { len = Math.round(pineNum(getArg(p, n, 0, 'length'))); arr = it.highArr; }
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let mx = -Infinity, off = null;
    for(let k = start; k <= it.curBar; k++){ if(arr[k] == null) return null; if(arr[k] >= mx){ mx = arr[k]; off = k - it.curBar; } }
    return off;
  },
  'ta.lowestbars': (it, p, n, node) => {
    const twoArg = p.length >= 2 || n.hasOwnProperty('source');
    let arr, len;
    if(twoArg){ const src = getArg(p, n, 0, 'source'); len = Math.round(pineNum(getArg(p, n, 1, 'length'))); const s = taRollingBuf(it, node); s.buf[it.curBar] = src; arr = s.buf; }
    else { len = Math.round(pineNum(getArg(p, n, 0, 'length'))); arr = it.lowArr; }
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let mn = Infinity, off = null;
    for(let k = start; k <= it.curBar; k++){ if(arr[k] == null) return null; if(arr[k] <= mn){ mn = arr[k]; off = k - it.curBar; } }
    return off;
  },
  'ta.stoch': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const hi = getArg(p, n, 1, 'high'); const lo = getArg(p, n, 2, 'low');
    const len = Math.round(pineNum(getArg(p, n, 3, 'length')));
    const s = getState(it, node);
    if(!s.hbuf){ s.hbuf = new Array(it.n); s.lbuf = new Array(it.n); }
    s.hbuf[it.curBar] = hi; s.lbuf[it.curBar] = lo;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let mx = -Infinity, mn = Infinity;
    for(let k = start; k <= it.curBar; k++){ if(s.hbuf[k] == null || s.lbuf[k] == null) return null; if(s.hbuf[k] > mx) mx = s.hbuf[k]; if(s.lbuf[k] < mn) mn = s.lbuf[k]; }
    const range = mx - mn; if(range === 0) return null;
    return 100 * (src - mn) / range;
  },
  'ta.wpr': (it, p, n, node) => {
    const len = Math.round(pineNum(getArg(p, n, 0, 'length')));
    const i = it.curBar; const start = i - len + 1; if(len < 1 || start < 0) return null;
    let mx = -Infinity, mn = Infinity;
    for(let k = start; k <= i; k++){ if(it.highArr[k] > mx) mx = it.highArr[k]; if(it.lowArr[k] < mn) mn = it.lowArr[k]; }
    const range = mx - mn; if(range === 0) return 0;
    return ((mx - it.closeArr[i]) / range) * -100;
  },
  'ta.cci': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    const sma = sum / len; let mad = 0;
    for(let k = start; k <= it.curBar; k++) mad += Math.abs(s.buf[k] - sma);
    mad /= len;
    if(mad === 0) return 0;
    return (src - sma) / (0.015 * mad);
  },
  'ta.cmo': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = getState(it, node);
    if(!s.gbuf){ s.gbuf = new Array(it.n); s.lbuf = new Array(it.n); }
    if(s.prevSrc == null){ s.prevSrc = src; return null; }
    const mom = src - s.prevSrc; s.prevSrc = src;
    s.gbuf[it.curBar] = mom >= 0 ? mom : 0; s.lbuf[it.curBar] = mom >= 0 ? 0 : -mom;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let gs = 0, ls = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.gbuf[k] == null) return null; gs += s.gbuf[k]; ls += s.lbuf[k]; }
    const denom = gs + ls;
    return denom === 0 ? 0 : 100 * (gs - ls) / denom;
  },
  'ta.cog': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    if(sum === 0) return null;
    let num = 0;
    for(let i = 0; i < len; i++) num += s.buf[it.curBar - i] * (i + 1);
    return -num / sum;
  },
  'ta.mfi': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = getState(it, node);
    if(!s.upBuf){ s.upBuf = new Array(it.n); s.dnBuf = new Array(it.n); }
    const vol = it.volArr[it.curBar];
    if(s.prevSrc == null){ s.prevSrc = src; s.upBuf[it.curBar] = 0; s.dnBuf[it.curBar] = 0; return null; }
    const change = src - s.prevSrc; s.prevSrc = src;
    s.upBuf[it.curBar] = change <= 0 ? 0 : vol * src; s.dnBuf[it.curBar] = change >= 0 ? 0 : vol * src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let up = 0, dn = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.upBuf[k] == null) return null; up += s.upBuf[k]; dn += s.dnBuf[k]; }
    return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  },
  'ta.bb': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const mult = pineNum(getArg(p, n, 2, 'mult', 2));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return [null, null, null];
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return [null, null, null]; sum += s.buf[k]; }
    const basis = sum / len; let sq = 0;
    for(let k = start; k <= it.curBar; k++){ const d = s.buf[k] - basis; sq += d * d; }
    const dev = Math.sqrt(sq / len);
    return [basis, basis + mult * dev, basis - mult * dev];
  },
  'ta.bbw': (it, p, n, node) => {
    const r = TA_NS['ta.bb'](it, p, n, node);
    if(r[0] == null || r[0] === 0) return null;
    return (r[1] - r[2]) / r[0];
  },
  'ta.kc': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const mult = pineNum(getArg(p, n, 2, 'mult', 2));
    const useTR = n.hasOwnProperty('useTrueRange') ? pineTruthy(n.useTrueRange) : (p.length > 3 ? pineTruthy(p[3]) : true);
    const s = getState(it, node); const i = it.curBar;
    const span = useTR ? TA_NS['ta.tr'](it) : (it.highArr[i] - it.lowArr[i]);
    const basis = taEmaAdvance(s, 'basis', len, src);
    const rangeEma = taEmaAdvance(s, 'range', len, span);
    if(basis == null || rangeEma == null) return [null, null, null];
    return [basis, basis + rangeEma * mult, basis - rangeEma * mult];
  },
  'ta.kcw': (it, p, n, node) => {
    const r = TA_NS['ta.kc'](it, p, n, node);
    if(r[0] == null || r[0] === 0) return null;
    return (r[1] - r[2]) / r[0];
  },
  'ta.dmi': (it, p, n, node) => {
    const diLen = Math.round(pineNum(getArg(p, n, 0, 'diLength')));
    const adxLen = Math.round(pineNum(getArg(p, n, 1, 'adxSmoothing')));
    const s = getState(it, node); const i = it.curBar;
    if(i === 0) return [null, null, null];
    const high = it.highArr[i], low = it.lowArr[i], pHigh = it.highArr[i - 1], pLow = it.lowArr[i - 1], pClose = it.closeArr[i - 1];
    const tr = Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose));
    const up = high - pHigh, down = pLow - low;
    const plusDM = (up > down && up > 0) ? up : 0;
    const minusDM = (down > up && down > 0) ? down : 0;
    const smTR = taRmaAdvance(s, 'tr', diLen, i, tr);
    const smPlus = taRmaAdvance(s, 'plus', diLen, i, plusDM);
    const smMinus = taRmaAdvance(s, 'minus', diLen, i, minusDM);
    if(smTR == null) return [null, null, null];
    const plusDI = smTR === 0 ? 0 : 100 * smPlus / smTR;
    const minusDI = smTR === 0 ? 0 : 100 * smMinus / smTR;
    const sumDI = plusDI + minusDI;
    const dx = sumDI === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / sumDI;
    const adx = taRmaAdvance(s, 'adx', adxLen, i, dx);
    return [plusDI, minusDI, adx];
  },
  'ta.tsi': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source');
    const shortLen = Math.round(pineNum(getArg(p, n, 1, 'short_length')));
    const longLen = Math.round(pineNum(getArg(p, n, 2, 'long_length')));
    const s = getState(it, node);
    if(s.prevSrc == null){ s.prevSrc = src; return null; }
    const pc = src - s.prevSrc; s.prevSrc = src;
    const absPc = Math.abs(pc);
    const e1pc = taEmaAdvance(s, 'e1pc', longLen, pc), e1abs = taEmaAdvance(s, 'e1abs', longLen, absPc);
    if(e1pc == null || e1abs == null) return null;
    const e2pc = taEmaAdvance(s, 'e2pc', shortLen, e1pc), e2abs = taEmaAdvance(s, 'e2abs', shortLen, e1abs);
    if(e2pc == null || e2abs == null) return null;
    return e2abs === 0 ? 0 : e2pc / e2abs;
  },
  'ta.sar': (it, p, n, node) => {
    const start = pineNum(getArg(p, n, 0, 'start'));
    const inc = pineNum(getArg(p, n, 1, 'increment'));
    const maxAf = pineNum(getArg(p, n, 2, 'maximum'));
    const s = getState(it, node); const i = it.curBar;
    const high = it.highArr[i], low = it.lowArr[i], close = it.closeArr[i];
    if(s.callIdx == null) s.callIdx = -1;
    s.callIdx++;
    if(s.callIdx === 0) return null;
    const prevHigh = it.highArr[i - 1], prevLow = it.lowArr[i - 1], prevClose = it.closeArr[i - 1];
    const prevHigh2 = i >= 2 ? it.highArr[i - 2] : null, prevLow2 = i >= 2 ? it.lowArr[i - 2] : null;
    let isFirstTrendBar = false;
    if(s.callIdx === 1){
      if(close > prevClose){ s.isBelow = true; s.ep = high; s.result = prevLow; }
      else { s.isBelow = false; s.ep = low; s.result = prevHigh; }
      s.af = start; isFirstTrendBar = true;
    } else {
      s.result = s.result + s.af * (s.ep - s.result);
      if(s.isBelow){
        if(s.result > low){ isFirstTrendBar = true; s.isBelow = false; s.result = Math.max(high, s.ep); s.ep = low; s.af = start; }
      } else {
        if(s.result < high){ isFirstTrendBar = true; s.isBelow = true; s.result = Math.min(low, s.ep); s.ep = high; s.af = start; }
      }
      if(!isFirstTrendBar){
        if(s.isBelow){ if(high > s.ep){ s.ep = high; s.af = Math.min(s.af + inc, maxAf); } }
        else { if(low < s.ep){ s.ep = low; s.af = Math.min(s.af + inc, maxAf); } }
      }
    }
    if(s.isBelow){
      s.result = Math.min(s.result, prevLow);
      if(prevLow2 != null) s.result = Math.min(s.result, prevLow2);
    } else {
      s.result = Math.max(s.result, prevHigh);
      if(prevHigh2 != null) s.result = Math.max(s.result, prevHigh2);
    }
    return s.result;
  },
  'ta.supertrend': (it, p, n, node) => {
    const factor = pineNum(getArg(p, n, 0, 'factor'));
    const atrPeriod = Math.round(pineNum(getArg(p, n, 1, 'atrPeriod')));
    const s = getState(it, node); const i = it.curBar;
    const high = it.highArr[i], low = it.lowArr[i], close = it.closeArr[i];
    const hl2 = (high + low) / 2;
    const prevClose = i > 0 ? it.closeArr[i - 1] : null;
    const tr = prevClose == null ? (high - low) : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const atr = taRmaAdvance(s, 'atr', atrPeriod, i, tr);
    if(atr == null) return [null, null];
    let upperBand = hl2 + factor * atr, lowerBand = hl2 - factor * atr;
    if(s.prevLowerBand != null && !(lowerBand > s.prevLowerBand || prevClose < s.prevLowerBand)) lowerBand = s.prevLowerBand;
    if(s.prevUpperBand != null && !(upperBand < s.prevUpperBand || prevClose > s.prevUpperBand)) upperBand = s.prevUpperBand;
    let direction;
    if(s.prevSuperTrend == null) direction = 1;
    else if(s.prevSuperTrend === s.prevUpperBand) direction = close > upperBand ? -1 : 1;
    else direction = close < lowerBand ? 1 : -1;
    const superTrend = direction === -1 ? lowerBand : upperBand;
    s.prevLowerBand = lowerBand; s.prevUpperBand = upperBand; s.prevSuperTrend = superTrend;
    return [superTrend, direction];
  },
  'ta.obv': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 0;
    if(i > 0){ const c0 = it.closeArr[i], c1 = it.closeArr[i - 1]; if(c0 > c1) s.val += it.volArr[i]; else if(c0 < c1) s.val -= it.volArr[i]; }
    return s.val;
  },
  'ta.wad': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 0;
    const close = it.closeArr[i], high = it.highArr[i], low = it.lowArr[i];
    if(i > 0){
      const prevClose = it.closeArr[i - 1];
      const trueHigh = Math.max(high, prevClose), trueLow = Math.min(low, prevClose);
      const mom = close - prevClose;
      if(mom > 0) s.val += close - trueLow; else if(mom < 0) s.val += close - trueHigh;
    }
    return s.val;
  },
  'ta.wvad': (it) => {
    const i = it.curBar; const range = it.highArr[i] - it.lowArr[i];
    return range === 0 ? 0 : ((it.closeArr[i] - it.openArr[i]) / range) * it.volArr[i];
  },
  'ta.pvi': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 1.0;
    if(i > 0){
      const c0 = it.closeArr[i], c1 = it.closeArr[i - 1], v0 = it.volArr[i], v1 = it.volArr[i - 1];
      if(c0 !== 0 && c1 !== 0 && v0 > v1) s.val += ((c0 - c1) / c1) * s.val;
    }
    return s.val;
  },
  'ta.nvi': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 1.0;
    if(i > 0){
      const c0 = it.closeArr[i], c1 = it.closeArr[i - 1], v0 = it.volArr[i], v1 = it.volArr[i - 1];
      if(c0 !== 0 && c1 !== 0 && v0 < v1) s.val += ((c0 - c1) / c1) * s.val;
    }
    return s.val;
  },
  'ta.pvt': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 0;
    if(i > 0){ const c0 = it.closeArr[i], c1 = it.closeArr[i - 1]; if(c1 !== 0) s.val += ((c0 - c1) / c1) * it.volArr[i]; }
    return s.val;
  },
  'ta.iii': (it) => {
    const i = it.curBar; const range = it.highArr[i] - it.lowArr[i]; const denom = range * it.volArr[i];
    return denom === 0 ? 0 : (2 * it.closeArr[i] - it.highArr[i] - it.lowArr[i]) / denom;
  },
  'ta.accdist': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 0;
    const range = it.highArr[i] - it.lowArr[i];
    if(range !== 0) s.val += ((it.closeArr[i] - it.lowArr[i]) - (it.highArr[i] - it.closeArr[i])) / range * it.volArr[i];
    return s.val;
  },
};

// Parses a session string in "HHMM-HHMM" or "HHMM-HHMM:1234567" form (the ":1234567" part is a
// day-of-week filter, 1=Sunday..7=Saturday).
// "HHMM-HHMM" 또는 "HHMM-HHMM:1234567"(요일 필터, 1=일요일..7=토요일) 세션 문자열 파싱.
function pineParseSessionStr(s){
  if(!s || typeof s !== 'string') return null;
  const parts = s.split(':');
  const m = /^\s*(\d{2})(\d{2})\s*-\s*(\d{2})(\d{2})\s*$/.exec(parts[0]);
  if(!m) return null;
  const startMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const endMin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  const days = (parts[1] || '1234567').split('').map(d => parseInt(d, 10)).filter(d => d >= 1 && d <= 7);
  return { startMin, endMin, days };
}
// Converts a given UTC unix time (seconds) to local time in a specific timezone. 'GMT+N'/'GMT-N'
// forms (fixed offsets, the options in this script's timezone dropdown) are computed directly;
// real IANA timezones like 'America/New_York' are delegated to Intl.DateTimeFormat (which lets
// ICU handle DST transitions and the like).
// 주어진 UTC 유닉스초(seconds)를 특정 타임존의 현지 시각으로 변환. 'GMT+N'/'GMT-N' 형태(고정
// 오프셋, 이 스크립트의 타임존 드롭다운에 있는 옵션들)는 직접 계산하고, 'America/New_York' 같은
// 진짜 IANA 타임존은 Intl.DateTimeFormat에 맡긴다(DST 전환 등은 ICU가 알아서 처리).
function pineLocalTimeParts(unixSeconds, tz){
  const d = new Date(unixSeconds * 1000);
  const mGmt = tz ? /^GMT([+-]\d+)$/.exec(tz) : null;
  if(mGmt){
    const d2 = new Date((unixSeconds + parseInt(mGmt[1], 10) * 3600) * 1000);
    return { hour: d2.getUTCHours(), minute: d2.getUTCMinutes(), weekday: d2.getUTCDay() + 1 };
  }
  if(!tz) return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() + 1 };
  try{
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short' });
    const parts = fmt.formatToParts(d);
    const get = t => (parts.find(p => p.type === t) || {}).value;
    const weekdayMap = { Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7 };
    return { hour: parseInt(get('hour'), 10) % 24, minute: parseInt(get('minute'), 10), weekday: weekdayMap[get('weekday')] || (d.getUTCDay() + 1) };
  }catch(e){
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() + 1 };
  }
}
// Applies the timezone the same way pineLocalTimeParts does, but also extracts year/month/day/
// second, which str.format_time() needs.
// pineLocalTimeParts와 같은 방식으로 타임존을 반영하되, str.format_time()에 필요한 연/월/일/초까지 뽑아온다.
function pineLocalDateParts(unixSeconds, tz){
  const d = new Date(unixSeconds * 1000);
  const mGmt = tz ? /^GMT([+-]\d+)$/.exec(tz) : null;
  if(mGmt){
    const d2 = new Date((unixSeconds + parseInt(mGmt[1], 10) * 3600) * 1000);
    return { year: d2.getUTCFullYear(), month: d2.getUTCMonth() + 1, day: d2.getUTCDate(), hour: d2.getUTCHours(), minute: d2.getUTCMinutes(), second: d2.getUTCSeconds(), weekday: d2.getUTCDay() + 1 };
  }
  if(!tz) return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), weekday: d.getUTCDay() + 1 };
  try{
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    const parts = fmt.formatToParts(d);
    const get = t => (parts.find(p => p.type === t) || {}).value;
    const weekdayMap = { Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7 };
    return {
      year: parseInt(get('year'), 10), month: parseInt(get('month'), 10), day: parseInt(get('day'), 10),
      hour: parseInt(get('hour'), 10) % 24, minute: parseInt(get('minute'), 10), second: parseInt(get('second'), 10),
      weekday: weekdayMap[get('weekday')] || (d.getUTCDay() + 1),
    };
  }catch(e){
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), weekday: d.getUTCDay() + 1 };
  }
}
// str.format_time()'s format string: supports only a subset of Java SimpleDateFormat-style tokens
// (yyyy/yy, MM/M, dd/d, HH/H, mm/m, ss/s) — that covers essentially everything killzone-style
// scripts actually use in practice. Text wrapped in single quotes is emitted verbatim as literal
// text (e.g. "'T'").
// str.format_time()의 서식 문자열: Java SimpleDateFormat과 같은 토큰 일부(yyyy/yy, MM/M, dd/d, HH/H,
// mm/m, ss/s)만 지원한다 — 킬존류 스크립트들이 실제로 쓰는 건 대부분 이 정도뿐이다. 작은따옴표로
// 감싼 부분은 리터럴 텍스트로 그대로 출력한다("'T'"처럼).
function pineFormatTime(unixSeconds, fmt, tz){
  if(unixSeconds == null) return null;
  const p = pineLocalDateParts(unixSeconds, tz);
  const pad = (n, len) => String(n).padStart(len || 2, '0');
  const f = (fmt == null || fmt === '') ? "yyyy-MM-dd'T'HH:mm:ss" : String(fmt);
  const tokens = [
    ['yyyy', () => pad(p.year, 4)], ['yy', () => pad(p.year % 100)],
    ['MM', () => pad(p.month)], ['M', () => String(p.month)],
    ['dd', () => pad(p.day)], ['d', () => String(p.day)],
    ['HH', () => pad(p.hour)], ['H', () => String(p.hour)],
    ['mm', () => pad(p.minute)], ['m', () => String(p.minute)],
    ['ss', () => pad(p.second)], ['s', () => String(p.second)],
  ];
  let out = '';
  for(let i = 0; i < f.length; i++){
    if(f[i] === "'"){
      let j = i + 1;
      while(j < f.length && f[j] !== "'") j++;
      out += f.slice(i + 1, j);
      i = j;
      continue;
    }
    const rest = f.slice(i);
    let matched = false;
    for(const [tok, fn] of tokens){
      if(rest.startsWith(tok)){ out += fn(); i += tok.length - 1; matched = true; break; }
    }
    if(!matched) out += f[i];
  }
  return out;
}
function pineTfSeconds(tf){
  const s = String(tf || '').toUpperCase().trim();
  const m = s.match(/^(\d*)([SDWM]?)$/);
  if(!m) return 86400;
  const mult = m[1] ? parseInt(m[1], 10) : 1;
  const unit = m[2];
  if(unit === 'S') return mult;
  if(unit === 'D') return mult * 86400;
  if(unit === 'W') return mult * 604800;
  if(unit === 'M') return mult * 2592000; // rough approximation (30 days) / 대략적인 근사치(30일)
  return mult * 60; // a bare number with no suffix is treated as minutes / 접미사 없는 숫자만이면 분 단위
}
function pineTfBucket(timeSec, tf){
  const s = String(tf || '').toUpperCase().trim();
  const m = s.match(/^(\d*)([SDWM]?)$/);
  const mult = (m && m[1]) ? parseInt(m[1], 10) : 1;
  const unit = m ? m[2] : '';
  if(unit === 'M'){
    const d = new Date(timeSec * 1000);
    const idx = d.getUTCFullYear() * 12 + d.getUTCMonth();
    return Math.floor(idx / mult);
  }
  if(unit === 'W'){
    const dayIdx = Math.floor(timeSec / 86400);
    const weekIdx = Math.floor((dayIdx + 4) / 7); // approximation adjusted to Monday boundaries, anchored on 1970-01-01 (a Thursday) / 1970-01-01(목요일) 기준 월요일 경계로 보정한 근사치
    return Math.floor(weekIdx / mult);
  }
  const secs = pineTfSeconds(tf);
  return Math.floor(timeSec / secs);
}
const TIMEFRAME_NS = {
  'timeframe.change': (it, p, n, node) => {
    const tf = getArg(p, n, 0, 'timeframe', '');
    const s = getState(it, node);
    const cur = pineTfBucket(it.timeArr[it.curBar], tf);
    const changed = s.prevBucket != null && cur !== s.prevBucket;
    s.prevBucket = cur;
    return it.curBar === 0 ? false : changed;
  },
  'timeframe.in_seconds': (it, p, n) => pineTfSeconds(getArg(p, n, 0, 'timeframe', '')),
};

// ============================================================
// English: drawing objects (line.new / box.new / label.new) — unlike plot(), these say "draw a
// shape between this time~time, this price~price," which the charting library doesn't support
// natively. This file only computes the coordinates (x1,y1,x2,y2, etc.) and attaches them to the
// result; actually drawing on the canvas is done by pine-import.js.
// 그리기 객체 (line.new / box.new / label.new) — plot()과 달리 "특정 시간~시간, 가격~가격
// 사이에 도형을 그려라" 방식이라 차트 라이브러리가 기본 지원을 안 한다. 좌표(x1,y1,x2,y2 등)만
// 여기서 계산해서 결과에 담아 돌려주고, 실제 캔버스에 그리는 건 pine-import.js가 한다.
// ============================================================
function pineResolveTime(it, raw){
  if(raw == null) return it.timeArr[it.curBar];
  if(typeof raw === 'object') return pineResolveTime(it, raw.time != null ? raw.time : raw.index);
  if(raw > 1e8) return raw; // use as-is if it already looks like a real unix timestamp (seconds) / 이미 실제 유닉스 타임스탬프(초)로 보이면 그대로 사용
  const idx = Math.round(raw);
  const step = it.n >= 2 ? (it.timeArr[it.n - 1] - it.timeArr[it.n - 2]) : 60;
  if(idx >= 0 && idx < it.n) return it.timeArr[idx];
  if(idx < 0) return it.timeArr[0] + idx * step;
  return it.timeArr[it.n - 1] + (idx - (it.n - 1)) * step;
}
function pineCapPush(arr, obj, cap){ arr.push(obj); while(arr.length > cap) arr.shift(); }
function pineLineStyleFromConst(v){
  if(typeof v !== 'string') return 'solid';
  if(v.includes('dashed')) return 'dashed';
  if(v.includes('dotted')) return 'dotted';
  return 'solid';
}
function pineExtendFromConst(v){
  if(typeof v !== 'string') return 'none';
  if(v.includes('both')) return 'both';
  if(v.includes('right')) return 'right';
  if(v.includes('left')) return 'left';
  return 'none';
}
// Previously this only distinguished up/down (everything else fell through to label_down), so a
// label created with style_label_left/right/center was drawn centered above the point, exactly
// like "up" — meaning a label meant to sit beside the point (label_left) instead appeared
// overlapping directly above it (a different position than real TradingView). Checking for
// left/right/center first (so corner variants like "upper_left"/"lower_right" at least get their
// left/right placement respected) and falling back to the previous behavior for everything else
// (up/down/icon-only styles) fixes this.
// 예전엔 up/down만 구분해서(그 외엔 전부 label_down 취급) style_label_left/right/center로
// 만든 라벨도 up과 똑같이 점 위쪽에 가운데 정렬로 그려졌다 — 그래서 label_left로 점의 왼쪽에
// 나란히 놓이길 기대한 라벨이 오히려 점 바로 위에 겹쳐 보였다(실제 TradingView와 다른 위치).
// left/right/center를 먼저 검사해서(그래야 "upper_left"/"lower_right" 같은 코너 변형도 좌우
// 배치만이라도 반영됨) 그 외(up/down/아이콘 전용 스타일)는 기존과 동일하게 처리한다.
function pineLabelStyleFromConst(v){
  if(typeof v !== 'string') return 'label_down';
  if(v.includes('left')) return 'label_left';
  if(v.includes('right')) return 'label_right';
  if(v.includes('center')) return 'label_center';
  if(v.includes('up')) return 'label_up';
  return 'label_down';
}
function pinePointOf(p, idx){ return p[idx] && typeof p[idx] === 'object' ? p[idx] : null; }

const DRAWING_NS = {
  'chart.point.new': (it, p, n) => ({ time: getArg(p, n, 0, 'time', null), index: getArg(p, n, 1, 'index', null), price: getArg(p, n, 2, 'price', null) }),
  // linefill.new(line1, line2, color) — fills the area between two lines. If either is na, this
  // creates nothing, matching real Pine (returning na is safe here since linefill.delete(na) is
  // silently ignored).
  // linefill.new(line1, line2, color) — 두 선 사이를 채운다. 둘 중 하나라도 na면 실제 Pine처럼
  // 아무것도 만들지 않는다(na를 돌려줘도 linefill.delete(na)는 조용히 무시되므로 안전).
  'linefill.new': (it, p, n) => {
    const l1 = getArg(p, n, 0, 'line1', null), l2 = getArg(p, n, 1, 'line2', null);
    if(!(l1 instanceof PineLine) || !(l2 instanceof PineLine)) return null;
    const obj = new PineLinefill({ line1: l1, line2: l2, color: getArg(p, n, 2, 'color', 'rgba(120,123,134,0.2)') });
    pineCapPush(it.linefills, obj, it.maxLinefills);
    return obj;
  },
  // table.new(position, columns, rows, bgcolor, border_color, border_width, frame_color, frame_width, force_overlay)
  // Actual rendering (an HTML overlay div) is done by pine-import.js's renderPineTables(), which
  // reads this object (including its cells).
  // 실제 렌더링(HTML 오버레이 div)은 pine-import.js의 renderPineTables()가 이 객체(cells 포함)를 읽어서 한다.
  'table.new': (it, p, n, node) => {
    const obj = new PineTable({
      position: getArg(p, n, 0, 'position', 'top_right'),
      columns: getArg(p, n, 1, 'columns', 1),
      rows: getArg(p, n, 2, 'rows', 1),
      bgcolor: getArg(p, n, 3, 'bgcolor', null),
      bordercolor: getArg(p, n, 4, 'border_color', null),
      framecolor: getArg(p, n, 6, 'frame_color', null),
    });
    // Unlike line/box/label, a table isn't something that "accumulates" — it's fixed UI pinned to
    // a screen corner. It's common for scripts to call table.new() again on every bar without
    // `var` (500 bars = 500 tables); keeping all of them would draw the same table overlapping
    // itself in the same spot. Instead, the object from the same call site replaces the previous
    // one, so "number of table.new calls in the code" ends up equal to "number of tables shown."
    // line/box/label과 달리 표는 "쌓이는 것"이 아니라 화면 모서리에 붙는 고정 UI다. var 없이
    // table.new()를 매 bar 다시 부르는 스크립트가 흔한데(500봉이면 500개), 그걸 전부 들고 있으면
    // 똑같은 표가 같은 자리에 겹쳐 그려진다. 같은 호출 지점(call site)의 것은 최신 것으로 교체해서
    // "코드에 적힌 table.new 개수 = 표 개수"가 되게 한다.
    obj._key = it.pathKey(node);
    const idx = it.tables.findIndex(t => t._key === obj._key);
    if(idx > -1) it.tables[idx] = obj; else it.tables.push(obj);
    return obj;
  },
  // Real Pine's line.new positional argument order: x1,y1,x2,y2,xloc,extend,color,style,width.
  // xloc (position 4) doesn't need to be used given how coordinates are handled here (large
  // values are auto-detected as timestamps, small ones as bar_index), but positions 5-8
  // (extend/color/style/width) are commonly passed positionally without named args (common in
  // LuxAlgo-style scripts), so they still need to be read for styles to come out correctly.
  // 실제 Pine의 line.new 위치 인자 순서: x1,y1,x2,y2,xloc,extend,color,style,width.
  // xloc(4번)은 우리 좌표 처리 방식상 안 써도 되지만(값이 크면 타임스탬프, 작으면 bar_index로
  // 자동 판별), 그 뒤(5~8번)에 오는 extend/color/style/width를 named 없이 그냥 위치로만 주는
  // 스크립트가 흔해서(LuxAlgo류) 이것도 읽어야 스타일이 올바르게 반영된다.
  'line.new': (it, p, n, node) => {
    let x1, y1, x2, y2;
    const pt0 = pinePointOf(p, 0) || (n.first_point !== undefined ? n.first_point : null);
    const pt1 = pinePointOf(p, 1) || (n.second_point !== undefined ? n.second_point : null);
    if(pt0){ x1 = pineResolveTime(it, pt0); y1 = pt0.price; x2 = pineResolveTime(it, pt1); y2 = pt1 ? pt1.price : y1; }
    else {
      x1 = pineResolveTime(it, getArg(p, n, 0, 'x1'));
      y1 = getArg(p, n, 1, 'y1');
      x2 = pineResolveTime(it, getArg(p, n, 2, 'x2'));
      y2 = getArg(p, n, 3, 'y2');
    }
    const extendArg = n.extend !== undefined ? n.extend : (p.length > 5 ? p[5] : undefined);
    const colorArg = n.color !== undefined ? n.color : (p.length > 6 ? p[6] : undefined);
    const styleArg = n.style !== undefined ? n.style : (p.length > 7 ? p[7] : undefined);
    const widthArg = n.width != null ? n.width : (p.length > 8 ? p[8] : undefined);
    const obj = new PineLine({
      x1, y1, x2, y2,
      color: colorArg !== undefined ? colorArg : '#787b86',
      width: widthArg != null ? widthArg : 1,
      style: pineLineStyleFromConst(styleArg),
      extend: pineExtendFromConst(extendArg),
    });
    pineCapPush(it.lines, obj, it.maxLines);
    return obj;
  },
  // Real Pine's box.new positional argument order: left,top,right,bottom,border_color,
  // border_width, border_style,extend,bgcolor,text,text_size,text_color,... — for the same reason
  // as line.new, this also supports border_color/extend/bgcolor/text/text_color being passed
  // positionally without named args.
  // 실제 Pine의 box.new 위치 인자 순서: left,top,right,bottom,border_color,border_width,
  // border_style,extend,bgcolor,text,text_size,text_color,... — line.new과 같은 이유로
  // border_color/extend/bgcolor/text/text_color를 named 없이 위치로만 주는 경우도 지원한다.
  'box.new': (it, p, n, node) => {
    let x1, y1, x2, y2, posBase;
    const pt0 = pinePointOf(p, 0) || (n.top_left !== undefined ? n.top_left : null);
    const pt1 = pinePointOf(p, 1) || (n.bottom_right !== undefined ? n.bottom_right : null);
    // The two-point form (top_left, bottom_right) uses only 2 positional slots for coordinates,
    // while the older 4-coordinate form (left,top,right,bottom) uses 4 — so the positional index
    // of arguments after border_color shifts accordingly (4 vs 2), and posBase is set differently
    // depending on which form was used.
    // point 두 개짜리 형태(top_left, bottom_right)는 좌표에 자리 2개만 쓰고, 좌표 4개짜리
    // 옛 형태(left,top,right,bottom)는 4개를 쓴다 — border_color 이후 인자들의 위치 인덱스가
    // 그만큼(4 vs 2) 밀리므로, 어느 형태인지에 따라 기준 위치(posBase)를 다르게 잡는다.
    if(pt0){ x1 = pineResolveTime(it, pt0); y1 = pt0.price; x2 = pineResolveTime(it, pt1); y2 = pt1 ? pt1.price : y1; posBase = 2; }
    else {
      x1 = pineResolveTime(it, getArg(p, n, 0, 'left'));
      y1 = getArg(p, n, 1, 'top');
      x2 = pineResolveTime(it, getArg(p, n, 2, 'right'));
      y2 = getArg(p, n, 3, 'bottom');
      posBase = 4;
    }
    const borderColorArg = n.border_color !== undefined ? n.border_color : (p.length > posBase ? p[posBase] : undefined);
    const extendArg = n.extend !== undefined ? n.extend : (p.length > posBase + 3 ? p[posBase + 3] : undefined);
    const bgcolorArg = n.bgcolor !== undefined ? n.bgcolor : (p.length > posBase + 4 ? p[posBase + 4] : undefined);
    const textArg = n.text !== undefined ? n.text : (p.length > posBase + 5 ? p[posBase + 5] : undefined);
    const textColorArg = n.text_color !== undefined ? n.text_color : (p.length > posBase + 7 ? p[posBase + 7] : undefined);
    const obj = new PineBox({
      x1, y1, x2, y2,
      bgcolor: bgcolorArg !== undefined ? bgcolorArg : 'rgba(120,123,134,0.2)',
      bordercolor: borderColorArg !== undefined ? borderColorArg : '#787b86',
      text: textArg !== undefined ? textArg : '',
      textcolor: textColorArg !== undefined ? textColorArg : '#ffffff',
      extend: pineExtendFromConst(extendArg),
    });
    pineCapPush(it.boxes, obj, it.maxBoxes);
    return obj;
  },
  'label.new': (it, p, n, node) => {
    let x, y, textPos;
    const pt0 = pinePointOf(p, 0) || (n.point !== undefined ? n.point : null);
    // When the coordinate is a single chart.point object, as in label.new(point, text, xloc, ...),
    // text is at position 1; when coordinates are given separately, as in
    // label.new(x, y, text, ...), text is at position 2 — the position to look for text at
    // depends on whether the point form was used.
    // label.new(point, text, xloc, ...) 처럼 좌표를 chart.point 객체 하나로 줄 때는 text가
    // 1번 자리, label.new(x, y, text, ...) 처럼 좌표를 따로 둘 줄 때는 text가 2번 자리다 —
    // 점 형태를 썼는지에 따라 text를 찾을 위치가 다르다.
    if(pt0){ x = pineResolveTime(it, pt0); y = pt0.price; textPos = 1; }
    else { x = pineResolveTime(it, getArg(p, n, 0, 'x')); y = getArg(p, n, 1, 'y'); textPos = 2; }
    const text = n.text !== undefined ? n.text : (typeof p[textPos] === 'string' ? p[textPos] : '');
    const obj = new PineLabel({
      x, y, text,
      color: n.color !== undefined ? n.color : 'rgba(30,34,42,0.9)',
      textcolor: n.textcolor !== undefined ? n.textcolor : '#ffffff',
      style: pineLabelStyleFromConst(n.style),
      size: n.size !== undefined ? n.size : 'normal',
      tooltip: n.tooltip !== undefined ? n.tooltip : '',
    });
    pineCapPush(it.labels, obj, it.maxLabels);
    return obj;
  },
};

// English: table.* — reused for both "static call" (table.cell(t, ...)) and "method call"
// (t.cell(...)) forms, the same way line/box/label are. Cell coordinates use a "col,row" string
// key.
// table.* — line/box/label과 같은 방식으로 "정적 호출(table.cell(t, ...))"과 "메서드 호출(t.cell(...))"
// 양쪽에서 재사용된다. 셀 좌표는 "col,row" 문자열 키를 쓴다.
function pineTableCell(tbl, col, row){
  const key = Math.round(pineNum(col)) + ',' + Math.round(pineNum(row));
  let cell = tbl.cells.get(key);
  if(!cell){
    // The cell_set_* family is meant to modify a cell that already exists in real Pine, but some
    // scripts call it before ever calling table.cell(), so a blank cell is created if one doesn't
    // exist yet (better than silently doing nothing).
    // cell_set_* 계열은 실제 Pine에서 이미 존재하는 셀을 고치는 함수지만, table.cell()로 만들기
    // 전에 부르는 스크립트도 있어서 없으면 빈 셀을 만들어 둔다(조용히 무시되는 것보다 낫다).
    cell = { text: '', textColor: '#d1d4dc', textSize: 'size.normal', bgcolor: null, tooltip: '', halign: 'center', valign: 'middle' };
    tbl.cells.set(key, cell);
  }
  return cell;
}
const TABLE_METHODS = {
  // table.cell(table_id, column, row, text, width, height, text_color, text_halign, text_valign, text_size, bgcolor, tooltip, text_font_family)
  cell: (it, tbl, p, n) => {
    const cell = pineTableCell(tbl, getArg(p, n, 0, 'column', 0), getArg(p, n, 1, 'row', 0));
    cell.text = getArg(p, n, 2, 'text', '');
    cell.halign = getArg(p, n, 6, 'text_halign', 'center');
    cell.valign = getArg(p, n, 7, 'text_valign', 'middle');
    cell.textColor = getArg(p, n, 5, 'text_color', '#d1d4dc');
    cell.textSize = getArg(p, n, 8, 'text_size', 'size.normal');
    cell.bgcolor = getArg(p, n, 9, 'bgcolor', null);
    cell.tooltip = getArg(p, n, 10, 'tooltip', '');
    return null;
  },
  cell_set_text: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).text = getArg(p, n, 2, 'text', ''); return null; },
  cell_set_text_color: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).textColor = getArg(p, n, 2, 'text_color', '#d1d4dc'); return null; },
  cell_set_bgcolor: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).bgcolor = getArg(p, n, 2, 'bgcolor', null); return null; },
  cell_set_text_size: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).textSize = getArg(p, n, 2, 'text_size', 'size.normal'); return null; },
  cell_set_text_halign: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).halign = getArg(p, n, 2, 'text_halign', 'center'); return null; },
  cell_set_text_valign: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).valign = getArg(p, n, 2, 'text_valign', 'middle'); return null; },
  cell_set_tooltip: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).tooltip = getArg(p, n, 2, 'tooltip', ''); return null; },
  set_bgcolor: (it, tbl, p, n) => { tbl.bgcolor = getArg(p, n, 0, 'bgcolor', null); return null; },
  set_frame_color: (it, tbl, p, n) => { tbl.framecolor = getArg(p, n, 0, 'frame_color', null); return null; },
  set_border_color: (it, tbl, p, n) => { tbl.bordercolor = getArg(p, n, 0, 'border_color', null); return null; },
  set_position: (it, tbl, p, n) => { tbl.position = getArg(p, n, 0, 'position', 'top_right'); return null; },
  // The real Pine parameter names are start_column/start_row/end_column/end_row. Older code here
  // used column/row/column_end/row_end, so calling with named arguments
  // (table.clear(t, start_column=0, ...)) fell through to the defaults every time.
  // 실제 Pine 이름은 start_column/start_row/end_column/end_row다. 예전 코드가 column/row/column_end/
  // row_end로 적어둬서 named 인자로 부르면(table.clear(t, start_column=0, ...)) 전부 기본값으로 떨어졌다.
  clear: (it, tbl, p, n) => {
    const fromCol = Math.round(pineNum(getArg(p, n, 0, 'start_column', 0)));
    const fromRow = Math.round(pineNum(getArg(p, n, 1, 'start_row', 0)));
    const toCol = Math.round(pineNum(getArg(p, n, 2, 'end_column', fromCol)));
    const toRow = Math.round(pineNum(getArg(p, n, 3, 'end_row', fromRow)));
    for(let c = fromCol; c <= toCol; c++) for(let r = fromRow; r <= toRow; r++) tbl.cells.delete(c + ',' + r);
    return null;
  },
  delete: (it, tbl) => { tbl.deleted = true; const i = it.tables.indexOf(tbl); if(i > -1) it.tables.splice(i, 1); return null; },
  // Cell merging is out of scope — without a stub here, calling it would kill the whole script
  // with an "unsupported function" error, so it's ignored and treated as a no-op instead.
  // 셀 병합은 지원 범위 밖 — 없으면 "지원하지 않는 함수" 에러로 스크립트 전체가 죽으므로 무시하고 진행한다.
  merge_cells: () => null,
};

// English: linefill.* — the filled area between two lines. Coordinates are read live from the
// referenced line objects each time (matching real Pine), so this object only needs to hold onto
// which two lines and which color.
// linefill.* — 두 line 사이를 채우는 면. 좌표는 참조하는 line 객체에서 그때그때 읽으므로
// (실제 Pine과 동일) 여기서는 어떤 두 선인지와 색만 들고 있으면 된다.
const LINEFILL_METHODS = {
  set_color: (it, lf, p) => { lf.color = p[0]; return null; },
  get_line1: (it, lf) => lf.line1,
  get_line2: (it, lf) => lf.line2,
  delete: (it, lf) => { lf.deleted = true; const i = it.linefills.indexOf(lf); if(i > -1) it.linefills.splice(i, 1); return null; },
};
const LINE_METHODS = {
  set_first_point: (it, l, p) => { const pt = p[0]; if(pt){ l.x1 = pineResolveTime(it, pt); l.y1 = pt.price; } return null; },
  set_second_point: (it, l, p) => { const pt = p[0]; if(pt){ l.x2 = pineResolveTime(it, pt); l.y2 = pt.price; } return null; },
  set_xy1: (it, l, p) => { l.x1 = pineResolveTime(it, p[0]); l.y1 = p[1]; return null; },
  set_xy2: (it, l, p) => { l.x2 = pineResolveTime(it, p[0]); l.y2 = p[1]; return null; },
  set_x1: (it, l, p) => { l.x1 = pineResolveTime(it, p[0]); return null; },
  set_y1: (it, l, p) => { l.y1 = p[0]; return null; },
  set_x2: (it, l, p) => { l.x2 = pineResolveTime(it, p[0]); return null; },
  set_y2: (it, l, p) => { l.y2 = p[0]; return null; },
  set_color: (it, l, p) => { l.color = p[0]; return null; },
  set_width: (it, l, p) => { l.width = p[0]; return null; },
  set_style: (it, l, p) => { l.style = pineLineStyleFromConst(p[0]); return null; },
  set_extend: (it, l, p) => { l.extend = pineExtendFromConst(p[0]); return null; },
  get_x1: (it, l) => l.x1, get_y1: (it, l) => l.y1, get_x2: (it, l) => l.x2, get_y2: (it, l) => l.y2,
  delete: (it, l) => { l.deleted = true; const i = it.lines.indexOf(l); if(i > -1) it.lines.splice(i, 1); return null; },
  copy: (it, l) => { const c = new PineLine(Object.assign({}, l)); pineCapPush(it.lines, c, it.maxLines); return c; },
};
const BOX_METHODS = {
  set_top_left_point: (it, b, p) => { const pt = p[0]; if(pt){ b.x1 = pineResolveTime(it, pt); b.y1 = pt.price; } return null; },
  set_bottom_right_point: (it, b, p) => { const pt = p[0]; if(pt){ b.x2 = pineResolveTime(it, pt); b.y2 = pt.price; } return null; },
  set_lefttop: (it, b, p) => { b.x1 = pineResolveTime(it, p[0]); b.y1 = p[1]; return null; },
  set_rightbottom: (it, b, p) => { b.x2 = pineResolveTime(it, p[0]); b.y2 = p[1]; return null; },
  set_left: (it, b, p) => { b.x1 = pineResolveTime(it, p[0]); return null; },
  set_right: (it, b, p) => { b.x2 = pineResolveTime(it, p[0]); return null; },
  set_top: (it, b, p) => { b.y1 = p[0]; return null; },
  set_bottom: (it, b, p) => { b.y2 = p[0]; return null; },
  set_bgcolor: (it, b, p) => { b.bgcolor = p[0]; return null; },
  set_border_color: (it, b, p) => { b.bordercolor = p[0]; return null; },
  set_text: (it, b, p) => { b.text = p[0]; return null; },
  set_text_color: (it, b, p) => { b.textcolor = p[0]; return null; },
  set_extend: (it, b, p) => { b.extend = pineExtendFromConst(p[0]); return null; },
  // The getters were entirely missing — only setters like set_top/set_bottom existed, with no
  // box.get_top()/box.get_bottom()/box.get_left()/box.get_right(). This crashed scripts that
  // iterate a box list reading prices to decide whether to delete/extend them (e.g. this Market
  // Structure Break indicator) with an "Unsupported function: box.get_bottom()" error. Following
  // box.new(left,top,right,bottom)'s order — x1=left, y1=top, x2=right, y2=bottom — these map the
  // same way set_top/set_bottom do.
  // getter들이 통째로 빠져 있었다 — set_top/set_bottom 등 setter만 있고 box.get_top()/
  // box.get_bottom()/box.get_left()/box.get_right()가 없어서, 박스 목록을 순회하며 가격을
  // 읽어 삭제/연장 여부를 판단하는 스크립트(예: 이 Market Structure Break 지표)가
  // "Unsupported function: box.get_bottom()" 에러로 죽었다. box.new(left,top,right,bottom)
  // 순서 그대로 x1=left, y1=top, x2=right, y2=bottom이라 set_top/set_bottom과 동일하게 매핑.
  get_top: (it, b) => b.y1, get_bottom: (it, b) => b.y2, get_left: (it, b) => b.x1, get_right: (it, b) => b.x2,
  delete: (it, b) => { b.deleted = true; const i = it.boxes.indexOf(b); if(i > -1) it.boxes.splice(i, 1); return null; },
};
const LABEL_METHODS = {
  set_xy: (it, l, p) => { l.x = pineResolveTime(it, p[0]); l.y = p[1]; return null; },
  set_x: (it, l, p) => { l.x = pineResolveTime(it, p[0]); return null; },
  set_y: (it, l, p) => { l.y = p[0]; return null; },
  set_point: (it, l, p) => { const pt = p[0]; if(pt){ l.x = pineResolveTime(it, pt); l.y = pt.price; } return null; },
  set_text: (it, l, p) => { l.text = p[0]; return null; },
  set_color: (it, l, p) => { l.color = p[0]; return null; },
  set_textcolor: (it, l, p) => { l.textcolor = p[0]; return null; },
  set_style: (it, l, p) => { l.style = pineLabelStyleFromConst(p[0]); return null; },
  set_size: (it, l, p) => { l.size = p[0]; return null; },
  set_tooltip: (it, l, p) => { l.tooltip = p[0]; return null; },
  get_x: (it, l) => l.x, get_y: (it, l) => l.y,
  delete: (it, l) => { l.deleted = true; const i = it.labels.indexOf(l); if(i > -1) it.labels.splice(i, 1); return null; },
};

// ============================================================
// math.*
// ============================================================
const MATH_NS = {
  'math.abs': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.abs(v); },
  'math.max': (it, p) => p.some(v => v == null) ? null : Math.max(...p),
  'math.min': (it, p) => p.some(v => v == null) ? null : Math.min(...p),
  'math.pow': (it, p, n) => Math.pow(getArg(p, n, 0, 'base'), getArg(p, n, 1, 'exponent')),
  'math.sqrt': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.sqrt(v); },
  'math.log': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.log(v); },
  'math.log10': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.log10(v); },
  'math.exp': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.exp(v); },
  'math.sign': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.sign(v); },
  'math.round': (it, p, n) => {
    const v = getArg(p, n, 0, 'number'); const prec = Math.round(pineNum(getArg(p, n, 1, 'precision', 0)));
    if(v == null) return null; const f = Math.pow(10, prec); return Math.round(v * f) / f;
  },
  // This app doesn't have real exchange syminfo.mintick (tick size) metadata — instead it derives
  // an approximate tick, based on the current bar's close price magnitude, that lands at roughly
  // 5 significant figures, and rounds to that (the goal is display-rounding, so an exact tick
  // size isn't needed).
  // 실제 거래소의 syminfo.mintick(틱 사이즈) 메타데이터가 이 앱엔 없다 — 대신 현재 봉 종가의
  // 자릿수를 기준으로 유효숫자 5자리 정도에 해당하는 근사 틱을 만들어 반올림한다(가격 표시용
  // 반올림이 목적이라 완벽한 틱 사이즈까진 필요 없음).
  'math.round_to_mintick': (it, p, n) => {
    const v = getArg(p, n, 0, 'number');
    if(v == null) return null;
    const ref = Math.abs(it.closeArr[it.curBar]) || Math.abs(v) || 1;
    const tick = Math.pow(10, Math.floor(Math.log10(ref)) - 4);
    return Math.round(v / tick) * tick;
  },
  'math.floor': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.floor(v); },
  'math.ceil': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.ceil(v); },
  // If any argument is na, the whole result is na — because null + number is treated as 0 in JS
  // (0 + null === 0), this used to be a bug where an na input from an unfinished warm-up period
  // got silently mixed into the average as 0 (e.g. donchian(len) =>
  // math.avg(ta.lowest(len), ta.highest(len)) would produce 0 instead of na during warm-up).
  // 인자 중 하나라도 na면 전체가 na — null + number가 JS에서 0으로 취급되는 바람에(0 + null === 0),
  // 워밍업이 덜 끝난 na 입력이 평균에서 그냥 0으로 섞여 들어가던 버그(예: donchian(len) =>
  // math.avg(ta.lowest(len), ta.highest(len))가 워밍업 구간에 na 대신 0을 냄).
  'math.avg': (it, p) => p.some(v => v == null) ? null : (p.length ? p.reduce((a, b) => a + b, 0) / p.length : null),
  'math.sum': (it, p) => p.reduce((a, b) => a + b, 0),
  'math.random': (it, p, n) => { const mn = getArg(p, n, 0, 'min', 0), mx = getArg(p, n, 1, 'max', 1); return mn + Math.random() * (mx - mn); },
  'math.todegrees': (it, p) => p[0] * 180 / Math.PI,
  'math.toradians': (it, p) => p[0] * Math.PI / 180,
  'math.sin': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.sin(v); },
  'math.cos': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.cos(v); },
  'math.tan': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.tan(v); },
  'math.asin': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.asin(v); },
  'math.acos': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.acos(v); },
  'math.atan': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.atan(v); },
};

// ============================================================
// color.* / str.*
// ============================================================
function hexToRgb(hex){
  if(typeof hex !== 'string' || hex[0] !== '#') return [120, 123, 134];
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
// For extracting components in color.r()/g()/b()/t() — colors in this engine are always either
// "#rrggbb" or an "rgba(r,g,b,a)" string produced by color.new/color.rgb, so both forms are
// parsed and normalized into [r,g,b,transp(0-100)].
// color.r()/g()/b()/t() 성분 추출용 — 우리 색은 "#rrggbb" 아니면 color.new/color.rgb가 만든
// "rgba(r,g,b,a)" 문자열 둘 중 하나라서, 둘 다 파싱해서 [r,g,b,transp(0~100)]로 통일해준다.
function pineColorComponents(c){
  if(typeof c !== 'string') return [120, 123, 134, 0];
  if(c[0] === '#'){ const [r, g, b] = hexToRgb(c); return [r, g, b, 0]; }
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if(m){
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    return [+m[1], +m[2], +m[3], Math.round((1 - a) * 100)];
  }
  return [120, 123, 134, 0];
}
// The transp= argument of plot()/hline()/plotshape()/plotchar() (0-100, the way transparency was
// set before color.new() in the v3/v4 era) — converted to alpha the same way color.new() does.
// If transp isn't given, the color is left as-is.
// plot()/hline()/plotshape()/plotchar()의 transp= 인자(0~100, v3/v4 시절 color.new() 대신 쓰던
// 방식) — color.new()처럼 알파로 변환한다. transp가 없으면 색을 그대로 둔다.
function pineApplyTransp(color, transp){
  if(transp == null) return color;
  const [r, g, b] = pineColorComponents(color);
  const alpha = Math.max(0, Math.min(1, (100 - transp) / 100));
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}
const COLOR_NS = {
  'color.new': (it, p, n) => {
    const col = getArg(p, n, 0, 'color'); const transp = getArg(p, n, 1, 'transp', 0);
    const alpha = Math.max(0, Math.min(1, (100 - transp) / 100));
    const [r, g, b] = hexToRgb(col);
    return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  },
  'color.rgb': (it, p) => {
    const r = p[0] || 0, g = p[1] || 0, b = p[2] || 0;
    const a = p.length > 3 ? Math.max(0, Math.min(1, (100 - p[3]) / 100)) : 1;
    return `rgba(${r},${g},${b},${a})`;
  },
  'color.from_gradient': (it, p) => {
    const [value, minv, maxv, c1, c2] = p;
    const t = maxv === minv ? 0 : Math.max(0, Math.min(1, (value - minv) / (maxv - minv)));
    if(typeof c1 === 'string' && c1[0] === '#' && typeof c2 === 'string' && c2[0] === '#'){
      const [r1, g1, b1] = hexToRgb(c1), [r2, g2, b2] = hexToRgb(c2);
      return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`;
    }
    return c2;
  },
  'color.r': (it, p) => pineColorComponents(p[0])[0],
  'color.g': (it, p) => pineColorComponents(p[0])[1],
  'color.b': (it, p) => pineColorComponents(p[0])[2],
  'color.t': (it, p) => pineColorComponents(p[0])[3],
};
// Builds a format string ("0.00", etc.) with the decimal-place count matching the minimum price
// increment (syminfo.mintick).
// 최소 가격 단위(syminfo.mintick)에 맞는 소수 자릿수의 서식 문자열("0.00" 등)을 만든다.
function pineMintickFormat(it){
  const tick = pineSymMintick(it);
  const dec = Math.max(0, Math.min(10, -Math.floor(Math.log10(tick))));
  return dec > 0 ? '0.' + '0'.repeat(dec) : '0';
}
const STR_NS = {
  // str.tostring(value) / str.tostring(value, format) — if format is given, output follows that
  // format. Passing an array produces a "[1, 2, 3]"-style string, matching Pine.
  // str.tostring(value) / str.tostring(value, format) — format이 있으면 그 서식대로 찍는다.
  // 배열을 넘기면 Pine처럼 "[1, 2, 3]" 형태의 문자열이 된다.
  'str.tostring': (it, p) => {
    // format.mintick isn't a format string — it means "round and print using this symbol's
    // minimum price increment," which needs symbol info, so it's handled here up front
    // (pineFormatNumber only looks at the value and the format string).
    // format.mintick은 서식 문자열이 아니라 "이 심볼의 최소 가격 단위로 반올림해서 찍기"라서
    // 심볼 정보가 필요하다(pineFormatNumber는 값과 서식만 보므로 여기서 미리 처리).
    const fmt = p.length > 1 && p[1] === 'format.mintick' ? pineMintickFormat(it) : (p.length > 1 ? p[1] : null);
    const one = x => fmt == null ? pineFmt(x) : pineFormatNumber(x, fmt);
    const v = p[0];
    if(v instanceof PineArray) return '[' + v.items.map(one).join(', ') + ']';
    return one(v);
  },
  'str.length': (it, p) => String(p[0] == null ? '' : p[0]).length,
  'str.contains': (it, p) => String(p[0]).includes(String(p[1])),
  'str.tonumber': (it, p) => { const v = parseFloat(p[0]); return isNaN(v) ? null : v; },
  'str.upper': (it, p) => String(p[0]).toUpperCase(),
  'str.lower': (it, p) => String(p[0]).toLowerCase(),
  // Supports {0},{1},... placeholders plus "{0,number,#.##}"-style numeric formatting (date
  // formatting is ignored).
  // {0},{1},... 자리표시자 + "{0,number,#.##}" 형태의 숫자 서식까지 지원(날짜 서식은 무시).
  'str.format': (it, p) => {
    const fmt = String(p[0] == null ? '' : p[0]);
    const args = p.slice(1);
    return fmt.replace(/\{(\d+)(?:,\s*number\s*,\s*([^}]*))?[^}]*\}/g, (m, idx, numFmt) => {
      const v = args[+idx];
      if(v === undefined) return m;
      return numFmt ? pineFormatNumber(v, numFmt.trim()) : pineFmt(v);
    });
  },
  'str.replace': (it, p) => String(p[0]).replace(String(p[1]), String(p[2] == null ? '' : p[2])),
  'str.replace_all': (it, p) => String(p[0]).split(String(p[1])).join(String(p[2] == null ? '' : p[2])),
  'str.split': (it, p) => new PineArray(String(p[0]).split(String(p[1] == null ? '' : p[1])), 'string'),
  'str.trim': (it, p) => String(p[0]).trim(),
  'str.startswith': (it, p) => String(p[0]).startsWith(String(p[1])),
  'str.endswith': (it, p) => String(p[0]).endsWith(String(p[1])),
  'str.repeat': (it, p) => String(p[0]).repeat(Math.max(0, Math.round(pineNum(p[1])))),
  'str.pos': (it, p) => { const idx = String(p[0]).indexOf(String(p[1])); return idx < 0 ? null : idx; },
  'str.substring': (it, p) => {
    const s = String(p[0] == null ? '' : p[0]);
    const from = Math.max(0, Math.round(pineNum(p[1] == null ? 0 : p[1])));
    const to = p[2] == null ? s.length : Math.round(pineNum(p[2]));
    return s.substring(from, to);
  },
  'str.format_time': (it, p) => pineFormatTime(p[0], p[1], p[2]),
};

// ============================================================
// English: top-level functions (used directly, without a namespace)
// ============================================================
// v1-v3 Pine used plain numeric constants for style too, as in style=3 (before today's
// plot.style_* string constants existed). Preserving the old ordering: 0=line, 1=stepline,
// 2=histogram, 3=cross, 4=area, 5=columns, 6=circles. Without this mapping, any non-string value
// falls through to 'line' unconditionally — for example, LazyBear WaveTrend's `style=3` (a cross,
// meant to look dotted) would incorrectly render as a solid line.
// 최상위(네임스페이스 없이 바로 쓰는) 함수들
// ============================================================
// v1~v3 Pine은 style=3 처럼 스타일도 그냥 숫자 상수로 썼다(지금의 plot.style_* 문자열 상수가
// 생기기 전). 예전 순서 그대로: 0=line, 1=stepline, 2=histogram, 3=cross, 4=area, 5=columns,
// 6=circles. 이 매핑이 없으면 문자열이 아닌 값은 전부 무조건 'line'으로 떨어져서, 예를 들어
// LazyBear WaveTrend의 `style=3`(점선처럼 보여야 할 cross)이 실선으로 그려지는 버그가 생긴다.
const PINE_NUMERIC_PLOT_STYLES = { 0: 'line', 1: 'stepline', 2: 'histogram', 3: 'cross', 4: 'area', 5: 'histogram', 6: 'cross' };
function pinePlotStyleFromConst(v){
  if(typeof v === 'number' && Number.isFinite(v)) return PINE_NUMERIC_PLOT_STYLES[Math.round(v)] || 'line';
  if(typeof v !== 'string') return 'line';
  if(v.includes('histogram') || v.includes('columns')) return 'histogram';
  if(v.includes('circles') || v.includes('cross')) return 'cross';
  if(v.includes('area')) return 'area';
  // linebr (breaks the line at na values) and stepline (staircase shape) must not be collapsed
  // into plain 'line' — linebr must not connect across na the way style_line does, and stepline
  // needs its lineType changed.
  // linebr(=na 값에서 진짜로 끊는다)과 stepline(=계단 모양)은 그냥 'line'으로 뭉개면 안 된다 —
  // linebr은 style_line처럼 na를 건너뛰어 이어버리면 안 되고, stepline은 lineType을 바꿔줘야 한다.
  if(v.includes('linebr')) return 'linebr';
  if(v.includes('stepline')) return 'stepline';
  return 'line';
}
function pineShapeStyleFromConst(v){
  if(typeof v !== 'string') return 'circle';
  if(v.includes('triangleup')) return 'triangleup';
  if(v.includes('triangledown')) return 'triangledown';
  if(v.includes('xcross')) return 'xcross';
  if(v.includes('cross')) return 'cross';
  if(v.includes('arrowup')) return 'arrowup';
  if(v.includes('arrowdown')) return 'arrowdown';
  if(v.includes('labelup')) return 'labelup';
  if(v.includes('labeldown')) return 'labeldown';
  if(v.includes('square')) return 'square';
  if(v.includes('diamond')) return 'diamond';
  if(v.includes('flag')) return 'flag';
  return 'circle';
}
function pineLocationFromConst(v){
  if(typeof v !== 'string') return 'abovebar';
  if(v.includes('belowbar')) return 'belowbar';
  if(v.includes('absolute')) return 'absolute';
  if(v.includes('top')) return 'top';
  if(v.includes('bottom')) return 'bottom';
  return 'abovebar';
}
const TOP_LEVEL_BUILTINS = {
  // time(timeframe, session, timezone) — returns this bar's timestamp if it's inside the
  // session/timezone, otherwise na.
  // (The timeframe argument is effectively ignored, since "this app's bar data is already at that
  // timeframe" — treated the same as "" (the current chart timeframe). This is a core function
  // for killzone/session-related scripts in general; without it, those scripts don't run at all.)
  // time(timeframe, session, timezone) — session/timezone 안이면 이 봉의 시각을, 아니면 na를 돌려준다.
  // (timeframe 인자는 "이 앱은 이미 봉 데이터 자체가 그 타임프레임"이라 사실상 무시 — ""(현재 차트
  // 타임프레임)와 동일하게 취급. 킬존/세션 관련 스크립트 전반의 핵심 함수라 여기 없으면 그런
  // 스크립트가 통째로 안 돌아간다.)
  time: (it, p, n) => {
    const sessStr = getArg(p, n, 1, 'session', null);
    const tz = getArg(p, n, 2, 'timezone', null);
    const t = it.timeArr[it.curBar];
    if(!sessStr) return t; // always "inside session" when no session is specified / 세션 지정이 없으면 항상 "세션 안"
    const sess = pineParseSessionStr(sessStr);
    if(!sess) return null;
    const lp = pineLocalTimeParts(t, tz);
    if(sess.days.length < 7 && !sess.days.includes(lp.weekday)) return null;
    const minOfDay = lp.hour * 60 + lp.minute;
    const inSession = sess.startMin <= sess.endMin
      ? (minOfDay >= sess.startMin && minOfDay < sess.endMin)
      : (minOfDay >= sess.startMin || minOfDay < sess.endMin); // session spanning midnight (e.g. "2000-0000") / 자정을 넘어가는 세션(예: "2000-0000")
    return inSession ? t : null;
  },
  dayofweek: (it, p, n) => {
    const t = getArg(p, n, 0, 'time', it.timeArr[it.curBar]);
    const tz = getArg(p, n, 1, 'timezone', null);
    if(t == null) return null;
    return pineLocalTimeParts(t, tz).weekday;
  },
  plot: (it, p, n, node, colorBranchKey) => {
    const value = getArg(p, n, 0, 'series');
    const title = getArg(p, n, 1, 'title', 'Plot' + node.id);
    const color = pineApplyTransp(getArg(p, n, 2, 'color', '#2962ff'), n.transp);
    const linewidth = getArg(p, n, 3, 'linewidth', 1);
    const style = pinePlotStyleFromConst(getArg(p, n, 4, 'style'));
    const offset = Math.round(pineNum(n.offset != null ? n.offset : 0)) || 0;
    const key = it.pathKey(node);
    let rec = it.plots.get(key);
    if(!rec){ rec = { key, title, color, linewidth, offset, style, values: new Array(it.n), colors: new Array(it.n), branchKeys: new Array(it.n) }; it.plots.set(key, rec); }
    rec.title = title; rec.color = color; rec.linewidth = linewidth; rec.offset = offset; rec.style = style;
    rec.values[it.curBar] = (n.display === 'display.none') ? null : value;
    rec.colors[it.curBar] = color;
    rec.branchKeys[it.curBar] = colorBranchKey || color; // for simple color expressions that can't be branch-tracked, use the value itself as the key / 분기 추적이 안 되는 단순 색상 표현식은 값 자체를 키로 사용
    // fill(plot1, plot2, ...) needs to know which two plots to fill between, so this record
    // itself is returned (same code location = same key, so object identity is unchanged even
    // when called again on every bar. It used to always return null, so passing `p1` from
    // `p1 = plot(x)` into fill() always got treated as na).
    // fill(plot1, plot2, ...)이 어느 두 plot 사이를 채울지 알아야 하니, 이 레코드 자체를 반환한다
    // (같은 코드 위치 = 같은 key라서 매 bar 다시 호출돼도 객체 identity는 안 바뀐다. 예전엔 항상
    // null을 반환해서 `p1 = plot(x)` 뒤에 `p1`을 fill()에 넘기면 늘 na 취급됐다).
    return rec;
  },
  hline: (it, p, n, node) => {
    const price = getArg(p, n, 0, 'price');
    const title = getArg(p, n, 1, 'title', 'H' + node.id);
    const color = pineApplyTransp(getArg(p, n, 2, 'color', '#787b86'), n.transp);
    const key = it.pathKey(node);
    let rec = it.hlines.get(key);
    if(!rec){ rec = { key, title, color, price }; it.hlines.set(key, rec); }
    rec.price = price; rec.color = color; rec.title = title;
    return rec; // hline() also returns its own record, for the same reason as plot() — to support fill(h1, h2, ...) / plot()과 동일한 이유로 hline()도 자기 레코드를 반환 — fill(h1, h2, ...) 지원용
  },
  indicator: (it, p, n) => {
    if(it.curBar === 0){
      it.meta.title = getArg(p, n, 0, 'title', it.meta.title);
      it.meta.shorttitle = n.shorttitle || it.meta.title;
      it.meta.overlay = n.overlay === true || n.overlay === 'true';
      if(n.max_lines_count != null) it.maxLines = Math.max(1, Math.min(500, Math.round(n.max_lines_count)));
      if(n.max_boxes_count != null) it.maxBoxes = Math.max(1, Math.min(500, Math.round(n.max_boxes_count)));
      if(n.max_labels_count != null) it.maxLabels = Math.max(1, Math.min(500, Math.round(n.max_labels_count)));
    }
    return null;
  },
  study: (it, p, n) => TOP_LEVEL_BUILTINS.indicator(it, p, n),
  // strategy(...) — follows the same pattern as indicator(): sets meta (title/overlay, default
  // true) only on the first bar, and initializes backtest state (it.strategyState). Actual order
  // execution is handled by the STRATEGY_NS functions like strategy.entry (which only enqueue
  // orders) plus pine-strategy.js's processStrategyBar (called by pine-interpreter.js at the end
  // of each bar).
  // strategy(...) — indicator()와 같은 패턴으로 첫 bar에만 메타(제목/오버레이, 기본값 true)를
  // 설정하고, 백테스트 상태(it.strategyState)를 초기화한다. 실제 주문 체결은 strategy.entry 등의
  // STRATEGY_NS 함수(대기열에 넣기만 함) + pine-strategy.js의 processStrategyBar(bar 끝마다
  // pine-interpreter.js가 호출)가 담당한다.
  strategy: (it, p, n) => {
    if(it.curBar === 0){
      it.meta.title = getArg(p, n, 0, 'title', it.meta.title);
      it.meta.shorttitle = n.shorttitle || it.meta.title;
      const overlayArg = getArg(p, n, 2, 'overlay', true); // unlike indicator(), strategy() defaults to overlay=true / strategy()는 indicator()와 달리 기본값이 overlay=true
      it.meta.overlay = overlayArg === true || overlayArg === 'true';
      if(n.max_lines_count != null) it.maxLines = Math.max(1, Math.min(500, Math.round(n.max_lines_count)));
      if(n.max_boxes_count != null) it.maxBoxes = Math.max(1, Math.min(500, Math.round(n.max_boxes_count)));
      if(n.max_labels_count != null) it.maxLabels = Math.max(1, Math.min(500, Math.round(n.max_labels_count)));
      // Overrides set in the Strategy Tester panel's "Properties" tab take precedence over the
      // strategy(...) arguments in the script code — matching how TradingView's Properties tab
      // changes backtest settings without touching the code.
      // Strategy Tester 패널의 "속성" 탭에서 덮어쓴 값이 있으면 스크립트 코드의 strategy(...) 인자보다
      // 우선한다 — TradingView의 Properties 탭이 코드를 안 건드리고 백테스트 설정만 바꾸는 것과 동일.
      const ov = it.strategyPropsOverride || {};
      it.strategyState = createPineStrategyState({
        initialCapital: ov.initialCapital != null ? ov.initialCapital : (n.initial_capital != null ? pineNum(n.initial_capital) : 1000000),
        qtyType: ov.qtyType || n.default_qty_type || 'fixed',
        qtyValue: ov.qtyValue != null ? ov.qtyValue : (n.default_qty_value != null ? pineNum(n.default_qty_value) : 1),
        commissionType: ov.commissionType || n.commission_type || 'percent',
        commissionValue: ov.commissionValue != null ? ov.commissionValue : (n.commission_value != null ? pineNum(n.commission_value) : 0),
        slippageTicks: ov.slippageTicks != null ? ov.slippageTicks : (n.slippage != null ? pineNum(n.slippage) : 0),
        pyramiding: ov.pyramiding != null ? ov.pyramiding : (n.pyramiding != null ? Math.round(pineNum(n.pyramiding)) : 1),
        processOrdersOnClose: n.process_orders_on_close === true || n.process_orders_on_close === 'true',
        // The test period has no corresponding script argument — it's only set from the
        // Properties tab, matching TradingView.
        // 테스트 기간은 스크립트 인자에 대응 항목이 없다 — Properties 탭에서만 설정(TradingView와 동일).
        testStart: ov.testStart != null ? ov.testStart : null,
        testEnd: ov.testEnd != null ? ov.testEnd : null,
      });
    }
    return null;
  },
  library: () => { throw new PineRuntimeError(pineMsg('library 스크립트(외부 라이브러리)는 지원하지 않습니다', 'library scripts (external libraries) are not supported'), 0); },
  nz: (it, p, n) => { const v = getArg(p, n, 0, 'source'); const rep = getArg(p, n, 1, 'replacement', 0); return v == null ? rep : v; },
  iff: (it, p, n) => pineTruthy(getArg(p, n, 0, 'condition')) ? getArg(p, n, 1, 'then') : getArg(p, n, 2, 'else'),
  na: (it, p, n) => { const v = getArg(p, n, 0, 'value'); return v == null; },
  fixnan: (it, p, n, node) => { const v = getArg(p, n, 0, 'source'); const s = getState(it, node); if(v != null) s.last = v; return s.last == null ? null : s.last; },
  // fill(plot1, plot2, color, title, editable, fillgaps, display) — plot1/plot2 receive the
  // record objects returned by plot()/hline() (the two functions above were changed to return
  // those records for this reason). No actual drawing happens here (this interpreter does pure
  // computation only) — just the two source references plus a per-bar color are collected into
  // it.fills, and pine-import.js draws the rectangles between the two series directly on the
  // canvas at render time (because there's no way to express "fill between two series" using
  // lightweight-charts series, the way a plot line can). color/title may also arrive under the
  // hline1/hline2 names, so both names are checked. Gradient fill (the 4-threshold version) is
  // out of scope — it's silently ignored (only solid-color fill() is supported).
  // fill(plot1, plot2, color, title, editable, fillgaps, display) — plot1/plot2 자리에는 plot()/hline()이
  // 반환한 레코드 객체가 들어온다(위 두 함수를 고쳐서 이제 그 레코드를 돌려준다). 여기서는 실제 그리기는
  // 안 하고(이 인터프리터는 순수 계산만 함) 두 소스 참조 + 봉별 색만 it.fills에 모아두면, pine-import.js가
  // 렌더링 시점에 두 시리즈 사이 사각형들을 캔버스에 직접 그린다(plot 라인처럼 lightweight-charts
  // 시리즈로는 "두 시리즈 사이 채우기"를 표현할 방법이 없어서). color/title은 hline1/hline2 이름으로
  // 넘어올 수도 있어서 두 이름 다 확인한다. gradient fill(4개 threshold 버전)은 지원 범위 밖 — 조용히
  // 무시된다(단색 fill()만 지원).
  fill: (it, p, n, node) => {
    const source1 = getArg(p, n, 0, 'plot1', getArg(p, n, 0, 'hline1'));
    const source2 = getArg(p, n, 1, 'plot2', getArg(p, n, 1, 'hline2'));
    // Real Pine's fill() defaults transp to 90 (other functions like plot() default to 0) —
    // when a script commonly just passes a color, as in `fill(p1, p2, color=gray)`, without
    // separately using transp or color.new(), even real TradingView renders it as a faint 10%
    // opacity shade rather than opaque gray. If transp= is explicitly given, or the color was
    // already passed with alpha baked in via color.new()/color.rgb() (i.e. pineColorComponents
    // reads transp>0 from it), that value is respected as-is; this default is only applied when a
    // fully opaque plain color (hex/name) is given with no such specification at all.
    // 실제 Pine의 fill()은 transp 기본값이 90이다(plot() 등 다른 함수는 기본값 0) — 스크립트가
    // `fill(p1, p2, color=gray)`처럼 흔히 색만 주고 transp/color.new()를 따로 안 쓰면, 실제
    // TradingView에서도 불투명 회색이 아니라 10% 불투명도의 옅은 음영으로 그려진다. transp=를
    // 명시했거나 color.new()/color.rgb()로 이미 알파를 넣어 넘긴 색(=pineColorComponents가
    // transp>0으로 읽어냄)이면 그 값을 그대로 존중하고, 완전 불투명한 맨 색(hex/이름)에 아무
    // 지정도 없을 때만 이 기본값을 적용한다.
    const rawColor = getArg(p, n, 2, 'color', '#787b86');
    let effTransp = n.transp;
    if(effTransp == null && pineColorComponents(rawColor)[3] === 0) effTransp = 90;
    const color = pineApplyTransp(rawColor, effTransp);
    const title = getArg(p, n, 3, 'title', 'Fill' + node.id);
    const key = it.pathKey(node);
    let rec = it.fills.get(key);
    if(!rec){ rec = { key, title, source1, source2, colors: new Array(it.n) }; it.fills.set(key, rec); }
    rec.title = title; rec.source1 = source1; rec.source2 = source2;
    rec.colors[it.curBar] = (typeof color === 'string' && color) ? color : null;
    return null;
  },
  // bgcolor(color, offset, editable, show_last, title, force_overlay)
  // Values are simply collected in the same shape barcolor() uses (a per-call-site array of
  // bars); actual canvas drawing is done by pine-import.js on the same behind-the-candles layer
  // (pineFillOverlay) that fill() uses. A bar where color is na means "don't paint," so it's left
  // as null. Unlike fill(), no transp default is pushed here — real Pine's bgcolor() has no such
  // default (which is why scripts almost always use the idiom of specifying alpha directly, e.g.
  // color.new(color.green, 90)), so the color the script gave is just passed through as-is here
  // too.
  // bgcolor(color, offset, editable, show_last, title, force_overlay)
  // barcolor()와 같은 모양(콜사이트별 봉 배열)으로 값만 모아두고, 실제 캔버스 그리기는
  // pine-import.js가 fill()과 같은 캔들-뒤 레이어(pineFillOverlay)에 한다. color가 na인 봉은
  // "칠하지 않음"이라 null로 남긴다. fill()과 달리 transp 기본값을 밀어주지 않는다 — 실제 Pine의
  // bgcolor()엔 그런 기본값이 없어서(그래서 스크립트들이 거의 항상 color.new(color.green, 90)처럼
  // 직접 알파를 지정하는 관용구를 쓴다), 여기서도 스크립트가 준 색을 그대로 옮기면 된다.
  bgcolor: (it, p, n, node) => {
    const raw = getArg(p, n, 0, 'color');
    const color = (typeof raw === 'string' && raw) ? pineApplyTransp(raw, n.transp) : null;
    const offset = Math.round(pineNum(getArg(p, n, 1, 'offset', 0))) || 0;
    const key = it.pathKey(node);
    let rec = it.bgcolors.get(key);
    if(!rec){ rec = { key, offset, values: new Array(it.n) }; it.bgcolors.set(key, rec); }
    rec.offset = offset;
    rec.values[it.curBar] = color;
    return null;
  },
  // barcolor(color, offset, editable, show_last, title, display)
  // Unlike plot(), this doesn't add a new series — it changes "the color of each bar in the main
  // candle series," so only a per-bar color array is collected here, and pine-import.js applies
  // it directly to the candle data. A bar where color is na means "leave the default color," so
  // it's left as null (not overwritten).
  // barcolor(color, offset, editable, show_last, title, display)
  // plot()처럼 새 시리즈를 얹는 게 아니라 "메인 캔들 시리즈의 각 봉 색"을 바꾸는 함수라서,
  // 여기서는 봉별 색 배열만 모아두고 실제 반영은 pine-import.js가 캔들 데이터에 직접 한다.
  // color가 na인 봉은 "기본 색 그대로 두라"는 뜻이므로 null로 남긴다(덮어쓰지 않음).
  barcolor: (it, p, n, node) => {
    const raw = getArg(p, n, 0, 'color');
    const color = (typeof raw === 'string' && raw) ? pineApplyTransp(raw, n.transp) : null;
    const offset = Math.round(pineNum(getArg(p, n, 1, 'offset', 0))) || 0;
    const key = it.pathKey(node);
    let rec = it.barcolors.get(key);
    if(!rec){ rec = { key, offset, values: new Array(it.n) }; it.barcolors.set(key, rec); }
    rec.offset = offset;
    rec.values[it.curBar] = color;
    return null;
  },
  // plotshape(series, title, style, location, color, offset, text, textcolor, editable, size, show_last, display, format, force_overlay)
  // These arguments can arrive either named (e.g. style=shape.labelup) or positional (e.g.
  // 'Upper Break', shape.labelup, ...); reading style/location/color/text/textcolor/offset by
  // looking only at the named values (n.*) meant scripts that passed them positionally all fell
  // through to the defaults (circle/abovebar/blue, no text), producing symptoms like "text with
  // no shape." This is unified through getArg(p, n, idx, name), the same as plot().
  // plotshape(series, title, style, location, color, offset, text, textcolor, editable, size, show_last, display, format, force_overlay)
  // 이 인자들은 named로도(예: style=shape.labelup) positional로도(예: 'Upper Break', shape.labelup, ...)
  // 올 수 있는데, style/location/color/text/textcolor/offset을 named 값(n.*)만 보고 읽었던 탓에
  // positional로 넘긴 스크립트에서는 전부 기본값(circle/abovebar/파랑, text 없음)으로 떨어져
  // "박스 없이 텍스트만" 같은 증상이 났다 — plot()처럼 getArg(p, n, idx, name)으로 통일한다.
  plotshape: (it, p, n, node) => {
    const value = getArg(p, n, 0, 'series');
    const title = getArg(p, n, 1, 'title', 'Shape' + node.id);
    const style = pineShapeStyleFromConst(getArg(p, n, 2, 'style'));
    const location = pineLocationFromConst(getArg(p, n, 3, 'location'));
    const color = pineApplyTransp(getArg(p, n, 4, 'color', '#2962ff'), n.transp);
    const offset = Math.round(pineNum(getArg(p, n, 5, 'offset', 0))) || 0;
    const text = getArg(p, n, 6, 'text', '');
    const textcolor = getArg(p, n, 7, 'textcolor', '#ffffff');
    const key = it.pathKey(node);
    let rec = it.shapes.get(key);
    if(!rec){ rec = { key, title, style, location, color, textcolor, text, offset, values: new Array(it.n) }; it.shapes.set(key, rec); }
    rec.title = title; rec.style = style; rec.location = location; rec.color = color; rec.textcolor = textcolor; rec.text = text; rec.offset = offset;
    rec.values[it.curBar] = (getArg(p, n, 11, 'display') === 'display.none') ? null : value;
    return null;
  },
  // plotchar(series, title, char, location, color, offset, text, textcolor, editable, size, show_last, display, force_overlay)
  plotchar: (it, p, n, node) => {
    const value = getArg(p, n, 0, 'series');
    const title = getArg(p, n, 1, 'title', 'Char' + node.id);
    const char = getArg(p, n, 2, 'char', '•');
    const location = pineLocationFromConst(getArg(p, n, 3, 'location'));
    const color = pineApplyTransp(getArg(p, n, 4, 'color', '#2962ff'), n.transp);
    const offset = Math.round(pineNum(getArg(p, n, 5, 'offset', 0))) || 0;
    const textcolor = getArg(p, n, 7, 'textcolor', '#ffffff');
    const key = it.pathKey(node);
    let rec = it.shapes.get(key);
    if(!rec){ rec = { key, title, style: 'char', char, location, color, textcolor, text: char, offset, values: new Array(it.n) }; it.shapes.set(key, rec); }
    rec.title = title; rec.char = char; rec.text = char; rec.location = location; rec.color = color; rec.textcolor = textcolor; rec.offset = offset;
    rec.values[it.curBar] = (getArg(p, n, 11, 'display') === 'display.none') ? null : value;
    return null;
  },
  // heikinashi(tickerid) — the bare-name form from v1-v4 (v5 uses ticker.heikinashi). It doesn't
  // actually change the symbol — it's a marker meaning "convert this to Heikin Ashi," so only a
  // marker string is returned, and request.security() does the actual interpretation.
  // heikinashi(tickerid) — v1~v4의 맨 이름 형태(v5는 ticker.heikinashi). 심볼을 실제로 바꾸는 게
  // 아니라 "하이킨아시로 환산해서 달라"는 표시라, 마커 문자열만 돌려주고 해석은 request.security()가 한다.
  heikinashi: (it, p) => PINE_HA_TICKER_PREFIX + (p[0] == null ? '' : p[0]),
  plotcandle: () => null, plotbar: () => null, plotarrow: () => null,
  alertcondition: () => null, alert: () => null,
  input: inputFn('generic'),
  timestamp: (it, p) => { const [y, mo, d, h = 0, mi = 0, se = 0] = p; return Math.floor(Date.UTC(y, (mo || 1) - 1, d || 1, h, mi, se) / 1000); },
  int: (it, p) => (p[0] == null ? null : Math.trunc(pineNum(p[0]))),   // int(na) is na / int(na)는 na
  float: (it, p) => (p[0] == null ? null : pineNum(p[0])),
  bool: (it, p) => pineTruthy(p[0]),
  string: (it, p) => (p[0] == null ? null : pineFmt(p[0])),
  // color(na) — a type cast that doesn't change the value, just marks "this is the color type."
  // Commonly used to put na in a color slot, as in "color = color(na)".
  // color(na) — 값을 안 바꾸고 그냥 "이건 color 타입이다"라고 표시만 하는 타입 캐스트.
  // "color = color(na)" 처럼 na를 color 자리에 넣을 때 흔히 쓰인다.
  color: (it, p) => (p[0] === undefined ? null : p[0]),
};
// Casts for drawing-object types work exactly like color(na) too (value unchanged, type marker
// only). Commonly used to create an empty initial value, as in
// "matrix.new<line>(1, 10, line(na))" or "var l = line(na)" — this form used to kill the whole
// script with "Undefined function: line".
// (line/label/box/table are also namespace names, but the parenthesized call form only ever
// reaches this code path.)
// 그리기 객체 타입의 캐스트도 color(na)와 완전히 같다(값은 그대로, 타입 표시만).
// "matrix.new<line>(1, 10, line(na))"나 "var l = line(na)"처럼 빈 초기값을 만들 때 흔히 쓰인다 —
// 예전엔 이 형태가 "정의되지 않은 함수입니다: line"으로 스크립트를 통째로 죽였다.
// (line/label/box/table은 네임스페이스 이름이기도 하지만, 괄호를 붙인 호출 형태는 여기로만 온다.)
for(const t of ['line', 'label', 'box', 'table', 'linefill', 'polyline', 'array', 'matrix', 'map']){
  TOP_LEVEL_BUILTINS[t] = (it, p) => (p[0] === undefined ? null : p[0]);
}

// ============================================================
// English: strategy.* — order/position functions. Actual fill and P&L calculation is handled by
// pine-strategy.js; here only the arguments are parsed and enqueued (if strategy() itself was
// never called and it.strategyState doesn't exist, everything is simply ignored — matching this
// engine's usual approach of not crashing on this rather than treating it as a syntax error).
// strategy.* — 주문/포지션 함수. 실제 체결·손익 계산은 pine-strategy.js가 담당하고, 여기서는
// 인자만 파싱해서 대기열에 넣는다(strategy() 자체가 안 불려서 it.strategyState가 없으면 전부 무시 —
// 문법 에러로 죽이지 않고 조용히 넘어가는 이 엔진의 기존 방식과 동일).
const STRATEGY_NS = {
  'strategy.entry': (it, p, n) => {
    const st = it.strategyState; if(!st) return null;
    const id = getArg(p, n, 0, 'id', 'entry');
    const direction = getArg(p, n, 1, 'direction', 1);
    if(direction !== 1 && direction !== -1) return null;
    const price = it.closeArr[it.curBar];
    const qtyArg = numOrNull(getArg(p, n, 2, 'qty', null));
    const qty = (qtyArg != null && qtyArg > 0) ? qtyArg : pineStrategyDefaultQty(st, price);
    if(!(qty > 0)) return null;
    pineStrategyQueueEntry(st, {
      id, direction, qty,
      limit: numOrNull(getArg(p, n, 3, 'limit', null)),
      stop: numOrNull(getArg(p, n, 4, 'stop', null)),
      ocaName: getArg(p, n, 5, 'oca_name', null),
      comment: getArg(p, n, 7, 'comment', null),
      marketPrice: price, time: it.timeArr[it.curBar],
    }, it.curBar);
    return null;
  },
  // strategy.order — unlike entry, this normally doesn't close out an opposing position first,
  // but this engine only tracks a net position (a single direction), so it's handled identically
  // to entry (an approximation, documented in PINE_ENGINE.md).
  // strategy.order — entry와 달리 반대 포지션을 먼저 정리하지 않는 게 정석이지만, 이 엔진은
  // 순 포지션(하나의 방향)만 추적하므로 entry와 동일하게 처리한다(근사 — PINE_ENGINE.md에 명시).
  'strategy.order': (it, p, n, node) => STRATEGY_NS['strategy.entry'](it, p, n, node),
  'strategy.close': (it, p, n) => {
    const st = it.strategyState; if(!st) return null;
    const id = getArg(p, n, 0, 'id', null);
    const price = it.closeArr[it.curBar];
    pineStrategyQueueClose(st, {
      id, comment: getArg(p, n, 1, 'comment', null),
      qtyPercent: numOrNull(getArg(p, n, 3, 'qty_percent', 100)) || 100,
      immediately: getArg(p, n, 5, 'immediately', false) === true,
      marketPrice: price, time: it.timeArr[it.curBar],
    }, it.curBar);
    return null;
  },
  'strategy.close_all': (it, p, n) => {
    const st = it.strategyState; if(!st) return null;
    const price = it.closeArr[it.curBar];
    pineStrategyQueueClose(st, {
      id: null, comment: getArg(p, n, 0, 'comment', null), qtyPercent: 100,
      immediately: getArg(p, n, 2, 'immediately', false) === true,
      marketPrice: price, time: it.timeArr[it.curBar],
    }, it.curBar);
    return null;
  },
  // strategy.exit(id, from_entry, qty, qty_percent, profit, limit, loss, stop, trail_price,
  // trail_points, trail_offset, oca_name, comment, ...) — trail_price (an absolute-price trailing
  // trigger) is not supported (only the trail_points/trail_offset combination is supported).
  // strategy.exit(id, from_entry, qty, qty_percent, profit, limit, loss, stop, trail_price,
  // trail_points, trail_offset, oca_name, comment, ...) — trail_price(절대가 트레일링 트리거)는
  // 미지원(trail_points/trail_offset 조합만 지원).
  'strategy.exit': (it, p, n) => {
    const st = it.strategyState; if(!st) return null;
    pineStrategyRegisterExit(st, {
      id: getArg(p, n, 0, 'id', 'exit'),
      fromEntry: getArg(p, n, 1, 'from_entry', null),
      qty: numOrNull(getArg(p, n, 2, 'qty', null)),
      qtyPercent: numOrNull(getArg(p, n, 3, 'qty_percent', null)),
      profit: numOrNull(getArg(p, n, 4, 'profit', null)),
      limit: numOrNull(getArg(p, n, 5, 'limit', null)),
      loss: numOrNull(getArg(p, n, 6, 'loss', null)),
      stop: numOrNull(getArg(p, n, 7, 'stop', null)),
      trailPoints: numOrNull(getArg(p, n, 9, 'trail_points', null)),
      trailOffset: numOrNull(getArg(p, n, 10, 'trail_offset', null)),
      ocaName: getArg(p, n, 11, 'oca_name', null),
      comment: getArg(p, n, 12, 'comment', null),
      time: it.timeArr[it.curBar],
    }, it.curBar);
    return null;
  },
  'strategy.cancel': (it, p, n) => { const st = it.strategyState; if(st) pineStrategyCancel(st, getArg(p, n, 0, 'id', null)); return null; },
  'strategy.cancel_all': (it) => { const st = it.strategyState; if(st) pineStrategyCancelAll(st); return null; },
  // strategy.risk.* — "safety net" rules like intraday loss limit / max position size / max
  // intraday filled orders. Like alertcondition()/alert()/fill()/bgcolor(), these are accepted
  // but not actually enforced — enforcing them for real would require computing "intraday"
  // boundaries, tracking drawdown from the intraday high, and separate state that blocks all new
  // orders from that point on, which is out of scope for the backtest engine right now (since
  // these are safety nets unrelated to the signal/fill logic itself, the choice here is to ignore
  // them rather than let them crash the whole script with an error).
  // strategy.risk.* — 일중 손실 한도/최대 포지션 크기/일중 최대 체결 횟수 같은 "안전장치" 규칙들.
  // alertcondition()/alert()/fill()/bgcolor()처럼 받아들이기만 하고 실제로 적용은 안 한다 —
  // 실제로 강제하려면 "그날(intraday)" 경계 계산, 일중 고점 대비 낙폭 추적, 그 시점부터 신규
  // 주문을 전부 막는 별도 상태 등이 필요해서 지금 백테스트 엔진 범위 밖(신호/체결 로직 자체와는
  // 무관한 안전장치라서, 이것 때문에 스크립트 전체가 에러로 죽는 것보다는 무시하는 쪽을 택함).
  'strategy.risk.max_drawdown': () => null,
  'strategy.risk.max_intraday_loss': () => null,
  'strategy.risk.max_intraday_filled_orders': () => null,
  'strategy.risk.max_position_size': () => null,
  'strategy.risk.allow_entry_in': () => null,
};

const PINE_BUILTIN_NS = Object.assign({}, TA_NS, MATH_NS, COLOR_NS, STR_NS, TIMEFRAME_NS, DRAWING_NS, STRATEGY_NS);
// In the v3/v4 era there were no ta./math. namespaces, so sma()/stdev()/abs()/round() etc. were
// all used bare — an alias is auto-created only when TOP_LEVEL_BUILTINS doesn't already have that
// name.
// v3/v4 시절엔 ta./math. 네임스페이스가 없어서 sma()/stdev()/abs()/round() 등이 전부 맨 이름으로 쓰였다 —
// 이미 TOP_LEVEL_BUILTINS에 같은 이름이 없는 경우에만 자동으로 별칭을 만들어준다.
Object.keys(TA_NS).forEach(k => { const bare = k.slice(3); if(!TOP_LEVEL_BUILTINS[bare]) TOP_LEVEL_BUILTINS[bare] = TA_NS[k]; });
Object.keys(MATH_NS).forEach(k => { const bare = k.slice(5); if(!TOP_LEVEL_BUILTINS[bare]) TOP_LEVEL_BUILTINS[bare] = MATH_NS[k]; });
// Older (v3/v4) Pine had no namespaces, so this was used bare, as in tostring()
// 예전(v3/v4) Pine은 네임스페이스가 없어서 tostring() 처럼 맨 이름으로 썼다
Object.keys(STR_NS).forEach(k => { const bare = k.slice(4); if(!TOP_LEVEL_BUILTINS[bare]) TOP_LEVEL_BUILTINS[bare] = STR_NS[k]; });
// In real Pine, calling a method on an object that's still na, as in line.delete(na), is simply
// ignored.
// (The pattern of declaring `var line x = na` and calling delete on it starting from the first
// bar is very common.)
// 실제 Pine에서 line.delete(na) 처럼 아직 na인 객체에 메서드를 호출해도 그냥 무시된다.
// (var line x = na 로 선언해두고 첫 봉부터 delete를 부르는 패턴이 매우 흔하다)
Object.keys(LINE_METHODS).forEach(m => { PINE_BUILTIN_NS['line.' + m] = (it, p, n, node) => (p[0] == null ? null : LINE_METHODS[m](it, p[0], p.slice(1), n, node)); });
Object.keys(BOX_METHODS).forEach(m => { PINE_BUILTIN_NS['box.' + m] = (it, p, n, node) => (p[0] == null ? null : BOX_METHODS[m](it, p[0], p.slice(1), n, node)); });
Object.keys(LABEL_METHODS).forEach(m => { PINE_BUILTIN_NS['label.' + m] = (it, p, n, node) => (p[0] == null ? null : LABEL_METHODS[m](it, p[0], p.slice(1), n, node)); });
Object.keys(LINEFILL_METHODS).forEach(m => { PINE_BUILTIN_NS['linefill.' + m] = (it, p, n, node) => (p[0] == null ? null : LINEFILL_METHODS[m](it, p[0], p.slice(1), n, node)); });
// table.* follows the same approach. 'new' isn't in TABLE_METHODS, so DRAWING_NS's table.new
// above stays as the live implementation. The first argument may also be given as
// named (table_id=), so n.table_id is checked when p[0] is empty.
// table.*도 같은 방식. 'new'는 TABLE_METHODS에 없으므로 위 DRAWING_NS의 table.new가 그대로 살아있다.
// 첫 인자를 named(table_id=)로 주는 경우도 있어서 p[0]이 비면 n.table_id를 본다.
Object.keys(TABLE_METHODS).forEach(m => {
  PINE_BUILTIN_NS['table.' + m] = (it, p, n, node) => {
    const tbl = p.length ? p[0] : (n.table_id !== undefined ? n.table_id : null);
    if(!(tbl instanceof PineTable)) return null; // silently ignored when na or not a table, matching real Pine / na이거나 표가 아니면 실제 Pine처럼 조용히 무시
    return TABLE_METHODS[m](it, tbl, p.length ? p.slice(1) : [], n, node);
  };
});
PINE_BUILTIN_NS['runtime.error'] = () => null; // for data-quality warnings — has no effect on chart calculation, so it's ignored / 데이터 품질 경고용 — 차트 계산에는 영향 없으므로 무시하고 진행
PINE_BUILTIN_NS['ticker.heikinashi'] = TOP_LEVEL_BUILTINS.heikinashi; // the v5 namespaced form / v5 네임스페이스 형태
// ticker.new/modify and the rest of ticker.* actually change the symbol, which is out of scope —
// the first argument is returned as-is so the original symbol keeps being used (better than
// letting the whole script die with an error).
// ticker.new/modify 등 나머지 ticker.*는 심볼을 실제로 바꾸는 기능이라 지원 범위 밖 — 원래 심볼을
// 그대로 쓰도록 첫 인자를 돌려준다(에러로 스크립트 전체가 죽는 것보다 낫다).
['new', 'modify', 'inherit', 'standard'].forEach(k => { PINE_BUILTIN_NS['ticker.' + k] = (it, p) => (p[0] == null ? '' : p[0]); });
['int', 'float', 'bool', 'string', 'source', 'timeframe', 'session', 'symbol', 'price', 'color'].forEach(k => { PINE_BUILTIN_NS['input.' + k] = inputFn(k); });
PINE_BUILTIN_NS['input.text_area'] = inputFn('string'); // multi-line text input — the value itself is just a string, so treated the same as input.string / 여러 줄 텍스트 입력 — 값 자체는 그냥 문자열이라 input.string과 동일하게 처리
['float', 'int', 'bool', 'string', 'color', 'line', 'label', 'box', 'table'].forEach(k => { PINE_BUILTIN_NS['array.new_' + k] = arrayNewFn(k); PINE_BUILTIN_NS['array.new<' + k + '>'] = arrayNewFn(k); });
PINE_BUILTIN_NS['array.new'] = arrayNewFn('float');
PINE_BUILTIN_NS['array.from'] = (it, p) => new PineArray(p.slice(), 'float');
Object.keys(ARRAY_METHOD_BUILTINS).forEach(m => { PINE_BUILTIN_NS['array.' + m] = wrapArrayFn(m); });
// map.*/matrix.* follow the same approach as table.* — also handling the case where the first
// argument is na or given as named (id=).
// map.*/matrix.*도 table.*와 같은 방식 — 첫 인자가 na거나 named(id=)로 온 경우까지 처리한다.
PINE_BUILTIN_NS['map.new'] = () => new PineMap();
Object.keys(MAP_METHODS).forEach(m => {
  PINE_BUILTIN_NS['map.' + m] = (it, p, n, node) => {
    const mp = p.length ? p[0] : (n.id !== undefined ? n.id : null);
    if(!(mp instanceof PineMap)) return null;
    return MAP_METHODS[m](it, mp, p.length ? p.slice(1) : [], n, node);
  };
});
PINE_BUILTIN_NS['matrix.new'] = (it, p, n) => {
  const rows = Math.max(0, Math.round(pineNum(getArg(p, n, 0, 'rows', 0))));
  const cols = Math.max(0, Math.round(pineNum(getArg(p, n, 1, 'columns', 0))));
  const initial = getArg(p, n, 2, 'initial_value', null);
  const data = []; for(let r = 0; r < rows; r++) data.push(new Array(cols).fill(initial));
  return new PineMatrix(data);
};
Object.keys(MATRIX_METHODS).forEach(m => {
  PINE_BUILTIN_NS['matrix.' + m] = (it, p, n, node) => {
    const mx = p.length ? p[0] : (n.id !== undefined ? n.id : null);
    if(!(mx instanceof PineMatrix)) return null;
    return MATRIX_METHODS[m](it, mx, p.length ? p.slice(1) : [], n, node);
  };
});

// ============================================================
// English: utilities for synthesizing data for request.security_lower_tf() / request.security()
// request.security_lower_tf() / request.security() 데이터 합성용 유틸
// ============================================================
// A general-purpose OHLCV aggregator that merges bars into a higher timeframe at a fixed
// millisecond interval (identical logic to hl-chart's js/candles.js:buildAggCandles — it's pure
// computation, so it was ported over as-is). Intervals needing calendar-based boundaries, like
// W (week)/M (month), can't be handled here (a fixed-ms interval is assumed) — this is the
// existing constraint documented in PINE_ENGINE.md. PineInterpreter.resolveLowerTfBars() uses
// this function internally to synthesize on the fly whenever lowerTfCache doesn't have an exact
// match for the requested timeframe — so the host only needs to put a single atomic resolution
// (e.g. 1-second bars, or really whatever resolution it happens to already have) into
// lowerTfCache; it never needs to pre-scan for which timeframes will be needed and fetch
// accordingly.
// 고정 밀리초 간격으로 봉을 상위 타임프레임으로 합치는 범용 OHLCV 집계기(hl-chart의
// js/candles.js:buildAggCandles와 동일 로직 — 순수 계산이라 그대로 옮겨왔다). W(주)/M(월)처럼
// 달력 기준 경계가 필요한 간격은 여기서 못 다룬다(고정 ms 간격 가정) — PINE_ENGINE.md에
// 문서화된 기존 제약 그대로. PineInterpreter.resolveLowerTfBars()가 lowerTfCache에 정확히
// 일치하는 timeframe이 없을 때 내부적으로 이 함수를 써서 즉석 합성한다 — 호스트는 원자
// 해상도 하나(예: 1초봉, 또는 그냥 자기가 가진 아무 해상도)만 lowerTfCache에 넣어두면 되고,
// 어떤 timeframe이 필요한지 미리 스캔해서 맞춰 fetch할 필요가 없다.
function pineAggregateCandles(candles, ms){
  const bars = [];
  let cur = null;
  for(const c of candles){
    const bucketSec = Math.floor((c.time * 1000) / ms) * (ms / 1000);
    if(!cur || cur.time !== bucketSec){
      if(cur) bars.push(cur);
      cur = { time: bucketSec, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += (c.volume || 0);
    }
  }
  if(cur) bars.push(cur);
  return bars;
}

// ============================================================
// English: entry point
// 진입점
// ============================================================
// options.lowerTfCache is passed in filled with a Map<timeframe string, bars[]>  — it doesn't
// matter which timeframe string is used as the key (whatever atomic resolution the host actually
// has, e.g. "1S"). When PineInterpreter looks up that timeframe from
// request.security_lower_tf()/request.security(), if there's no exact key match, it automatically
// synthesizes it by finding a divisor of the requested timeframe within lowerTfCache (see
// PineInterpreter.resolveLowerTfBars) — so fetching is entirely the host's responsibility, and
// this engine doesn't compute "which timeframe will be needed when" on the host's behalf. If
// lowerTfCache isn't provided at all, or has no relevant data, request.security_lower_tf()
// returns na, and so does request.security() when it isn't a multiple of the chart interval —
// conversely, request.security() at a multiple of the chart interval (e.g. requesting "5" on a
// 1-minute chart) is synthesized correctly just by grouping the main bars, even without
// lowerTfCache (this has always worked this way and is unchanged). runPineScript itself is fully
// synchronous.
// options.lowerTfCache로 Map<timeframe 문자열, bars[]>를 채워 넘긴다 — 어떤 timeframe을
// 키로 쓰든(호스트가 실제로 가진 원자 해상도 그대로, 예: "1S") 상관없다. PineInterpreter가
// request.security_lower_tf()/request.security()에서 그 timeframe을 조회할 때, 정확히
// 일치하는 키가 없으면 lowerTfCache 안에서 요청 timeframe의 약수인 것을 찾아 자동으로
// 합성한다(PineInterpreter.resolveLowerTfBars 참고) — 그래서 fetch 자체는 완전히 호스트
// 책임이고, 이 엔진은 "언제 어떤 timeframe이 필요한지"를 대신 계산해주지 않는다. lowerTfCache를
// 아예 안 주거나 관련 데이터가 없으면 request.security_lower_tf()는 na를, 차트 간격의
// 배수가 아닌 request.security()도 na를 돌려준다 — 반대로 차트 간격의 배수인 request.security()
// (예: 1분봉 차트에서 "5" 요청)는 lowerTfCache 없이도 메인 봉을 그대로 묶어 정확히 합성된다
// (이건 항상 그렇게 동작해왔고 바뀐 게 없다). runPineScript 자체는 완전히 동기다.
function runPineScript(source, bars, options){
  const opts = options || {};
  let ast;
  try{ ast = pineParse(source); }
  catch(e){ throw { pineError: true, line: e.line || null, message: e.message || String(e) }; }
  const interp = new PineInterpreter(ast);
  interp.lowerTfCache = opts.lowerTfCache || new Map();
  interp.strategyPropsOverride = opts.strategyPropsOverride || {}; // strategy property (commission/slippage etc) overrides — read by the strategy() builtin / 전략 속성(수수료/슬리피지 등) 오버라이드 — strategy() 빌트인이 읽는다
  try{
    const result = interp.run(bars, opts.inputOverrides || {});
    // The interpreter instance is attached to the result for callers that want to cheaply
    // recompute just the last bar on every live tick (runIncrementalLastBar). Existing callers
    // that don't know about this field simply ignore it.
    // 실시간 틱마다 마지막 봉만 가볍게 재계산(runIncrementalLastBar)하고 싶은 호출부를 위해
    // 인터프리터 인스턴스를 결과에 얹어 보낸다. 이 필드를 모르는 기존 호출부는 그냥 무시한다.
    result.__interp = interp;
    return result;
  }
  catch(e){
    if(e && e.pineRuntime) throw { pineError: true, line: e.line || null, message: e.message };
    throw { pineError: true, line: null, message: '내부 오류: ' + (e && e.message ? e.message : String(e)) };
  }
}
