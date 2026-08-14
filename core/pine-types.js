/* pine-types.js
   A pass that attaches "static types" to the Pine AST. Runs exactly once, right after pineParse() has
   finished parsing.

   ── Why this is needed ──
   This engine keeps Pine values as plain JS values as-is, so looking at the runtime value alone can't
   tell int and float apart (both are a JS number) or color and string apart (both are a JS string). Yet
   Pine formally supports method overloading (declaring the same name across several types) that is
   resolved along exactly these type lines. The real Pine compiler also picks an overload by its
   compile-time type rather than the runtime value, so this pass does the same: it tags each node with a
   type ahead of time and lets the interpreter use that to make its pick.

   ── Cost ──
   Only a one-time cost of walking the AST once (small enough to be absorbed by parsing cost). The result
   is cached on the node's _st field, so it adds nothing to the "re-run the whole script every bar"
   execution path. If anything, a method call with multiple overloads gets a bit faster, since it now
   uses the result cached at the call site directly instead of linearly scanning the candidate list on
   every bar like before.

   ── Type notation ──
   A type is just a string: 'int' / 'float' / 'bool' / 'string' / 'color'; drawing objects are
   'line'/'box'/'label'/'table'; containers are 'array<float>' / 'map<string,int>' / 'matrix'; a
   user-defined type is its own name. null means "unknown", and when unknown, the interpreter falls back
   to the runtime value as before, so it's a safe default. The helpers that split up the notation
   (pineTypeBaseWord/pineTypeArgWords) live in pine-engine.js.

   Pine AST에 "정적 타입"을 붙이는 패스. pineParse()가 파싱을 끝낸 직후 딱 한 번 돈다.

   ── 왜 필요한가 ──
   이 엔진은 Pine 값을 그대로 JS 값으로 들고 있어서, 런타임 값만 봐서는 int와 float가 둘 다
   JS number이고 color와 string이 둘 다 JS string이라 구분이 안 된다. 그런데 Pine은 이 타입들로
   갈리는 method 오버로딩(같은 이름을 여러 타입에 걸쳐 선언하는 것)을 정식으로 지원한다.
   실제 Pine 컴파일러도 오버로드를 런타임 값이 아니라 컴파일타임 타입으로 고르므로, 여기서도
   같은 방식으로 각 노드에 타입을 미리 매겨두고 인터프리터가 그걸 보고 고르게 한다.

   ── 비용 ──
   AST를 한 번 훑는 일회성 비용만 든다(파싱 비용에 묻히는 수준). 결과는 노드의 _st 필드에
   캐시되므로 "매 봉마다 스크립트 전체를 다시 실행"하는 실행 경로에는 아무것도 안 더한다.
   오히려 오버로드가 여러 개인 method 호출은 예전처럼 매 봉 후보 목록을 선형 탐색하지 않고
   콜사이트에 캐시된 결과를 바로 쓰게 되어 조금 빨라진다.

   ── 타입 표기 ──
   타입은 그냥 문자열이다: 'int' / 'float' / 'bool' / 'string' / 'color', 그리기 객체는
   'line'/'box'/'label'/'table', 컨테이너는 'array<float>' / 'map<string,int>' / 'matrix',
   사용자 정의 타입은 그 이름. null은 "모름"이고, 모르면 인터프리터가 예전처럼 런타임 값으로
   폴백하므로 안전한 기본값이다. 표기를 쪼개는 헬퍼(pineTypeBaseWord/pineTypeArgWords)는
   pine-engine.js에 있다. */

const PINE_NUMERIC_TYPES = new Set(['int', 'float']);
// Merges two types into one when a single value can come from two branches (the two arms of a ternary,
// multiple := reassignments of the same variable, etc). This follows Pine's actual promotion rule exactly:
// mixing int and float yields float, and na (= unknown) simply takes on whichever type the other side has
// (the way `x = cond ? na : 3` still makes x an int — in Pine too, na gets its type from context).
// If two different non-numeric types are mixed, that code wouldn't actually compile in real Pine anyway, so
// rather than force a guess we just leave it as "unknown".
// 한 값에 두 갈래 타입이 흘러들어올 때(삼항의 두 분기, 같은 변수에 대한 여러 번의 := 등) 하나로 합친다.
// 실제 Pine의 승격 규칙 그대로: int와 float가 섞이면 float, na(=모름)는 상대 타입을 그대로 따라간다
// (`x = cond ? na : 3` 에서 x가 int인 것처럼 — Pine에서도 na는 문맥에서 타입을 얻는다).
// 서로 다른 비수치 타입이 섞이면 애초에 진짜 Pine에서 컴파일이 안 되는 코드라, 우기지 않고 "모름"으로 둔다.
function pineTypeMerge(a, b){
  if(a === b) return a;
  if(a == null) return b;
  if(b == null) return a;
  if(PINE_NUMERIC_TYPES.has(a) && PINE_NUMERIC_TYPES.has(b)) return 'float';
  return null;
}
function pineArrayElemType(t){ return pineTypeArgWords(t)[0] || null; }
function pineArrayOf(t){ return t ? 'array<' + t + '>' : 'array'; }

// ============================================================
// Type table for built-in names
// 내장 이름의 타입표
// ============================================================
// Built-in series/constants used as bare values without parentheses (paired with pine-interpreter.js's
// BUILTIN_SERIES/BUILTIN_CONSTS)
// 괄호 없이 값으로 쓰는 내장 시리즈/상수 (pine-interpreter.js의 BUILTIN_SERIES/BUILTIN_CONSTS와 짝)
const PINE_BUILTIN_VAR_TYPES = {
  close: 'float', open: 'float', high: 'float', low: 'float', volume: 'float',
  hl2: 'float', hlc3: 'float', ohlc4: 'float', hlcc4: 'float',
  time: 'int', time_close: 'int', bar_index: 'int', last_bar_index: 'int', last_bar_time: 'int',
  dayofweek: 'int', tr: 'float',
  period: 'string', interval: 'string', tickerid: 'string',
  // Color names that had no namespace back in v1-v3 / v1~v3의 네임스페이스 없던 색 이름들
  lime: 'color', green: 'color', red: 'color', maroon: 'color', blue: 'color', black: 'color',
  gray: 'color', grey: 'color', white: 'color', orange: 'color', purple: 'color', yellow: 'color',
  aqua: 'color', fuchsia: 'color', silver: 'color', navy: 'color', olive: 'color', teal: 'color',
  // Style/type-name constants, all of which have their own name string as their value
  // 스타일/타입 이름 상수들은 전부 자기 이름 문자열이 값이다
  line: 'string', histogram: 'string', cross: 'string', area: 'string', columns: 'string',
  circles: 'string', solid: 'string', dashed: 'string', dotted: 'string', stepline: 'string',
  linebr: 'string', bool: 'string', integer: 'string', float: 'string', resolution: 'string',
  session: 'string', source: 'string', symbol: 'string',
};
// Dotted built-in constants (paired with PINE_BUILTIN_CONST_NS / PINE_DYNAMIC_CONST_NS)
// 점 있는 내장 상수 (PINE_BUILTIN_CONST_NS / PINE_DYNAMIC_CONST_NS와 짝)
const PINE_BUILTIN_CONST_TYPES = {
  'math.pi': 'float', 'math.e': 'float', 'math.phi': 'float', 'math.rphi': 'float',
  'chart.fg_color': 'color', 'chart.bg_color': 'color',
  'timeframe.period': 'string',
  'box.all': 'array<box>', 'line.all': 'array<line>', 'label.all': 'array<label>',
  'strategy.position_size': 'float', 'strategy.position_avg_price': 'float', 'strategy.equity': 'float',
  'strategy.initial_capital': 'float', 'strategy.netprofit': 'float', 'strategy.grossprofit': 'float',
  'strategy.grossloss': 'float', 'strategy.openprofit': 'float', 'strategy.max_drawdown': 'float',
  'strategy.opentrades': 'int', 'strategy.closedtrades': 'int', 'strategy.wintrades': 'int', 'strategy.losstrades': 'int',
  'strategy.long': 'int', 'strategy.short': 'int', 'strategy.direction.long': 'int', 'strategy.direction.short': 'int',
};
['red','green','blue','orange','yellow','purple','white','black','gray','grey','lime','aqua','fuchsia','maroon','navy','olive','silver','teal']
  .forEach(c => { PINE_BUILTIN_CONST_TYPES['color.' + c] = 'color'; });
['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
  .forEach(d => { PINE_BUILTIN_CONST_TYPES['dayofweek.' + d] = 'int'; });
['islast','isfirst','ishistory','isrealtime','isnew','isconfirmed','islastconfirmedhistory']
  .forEach(b => { PINE_BUILTIN_CONST_TYPES['barstate.' + b] = 'bool'; });
['isdwm','isdaily','isweekly','ismonthly','isintraday','isminutes','isseconds']
  .forEach(b => { PINE_BUILTIN_CONST_TYPES['timeframe.' + b] = 'bool'; });
// ta.* series variables used as bare values without parentheses, like ta.tr
// ta.tr 처럼 괄호 없이 값으로 쓰는 ta.* 시리즈 변수
['ta.tr','ta.vwap','ta.obv','ta.accdist','ta.iii','ta.nvi','ta.pvi','ta.pvt','ta.wad','ta.wvad']
  .forEach(k => { PINE_BUILTIN_CONST_TYPES[k] = 'float'; });

// ============================================================
// Return-type table for built-in functions
// 내장 함수 리턴 타입표
// ============================================================
// A value is either a type string, or, when it depends on the argument types, a (ctx) => type function.
// ctx = { recv: receiver type (method-style calls only), args: array of argument types, node, inf }
// 값은 타입 문자열이거나, 인자 타입에 따라 달라지는 경우 (ctx) => 타입 함수다.
// ctx = { recv: 리시버 타입(메서드형 호출만), args: 인자 타입 배열, node, inf }
const PINE_BUILTIN_RET = {};
// Most ta.* functions return float — only the exceptions are overridden below.
// 대부분의 ta.*는 float를 돌려준다 — 예외만 아래에서 덮어쓴다.
['sma','ema','rma','wma','vwma','variance','stdev','highest','lowest','tr','atr','rsi','change','mom',
 'roc','cum','correlation','linreg','dev','alma','swma','hma','median','mode','range','percentrank',
 'percentile_linear_interpolation','percentile_nearest_rank','wpr','cci','cmo','cog','mfi','bbw','kcw',
 'tsi','sar','obv','wad','wvad','pvi','nvi','pvt','iii','accdist','pivothigh','pivotlow','valuewhen','stoch','vwap']
  .forEach(k => { PINE_BUILTIN_RET['ta.' + k] = 'float'; });
['crossover','crossunder','cross','falling','rising'].forEach(k => { PINE_BUILTIN_RET['ta.' + k] = 'bool'; });
['barssince','highestbars','lowestbars'].forEach(k => { PINE_BUILTIN_RET['ta.' + k] = 'int'; });
// Functions that return a tuple are left out of the table (there's no single type to write down since
// there isn't a single value) — they're treated as unknown, so variables bound from
// [a, b] = ta.macd(...) fall back to the runtime value.
// 튜플을 돌려주는 것들은 표에서 빼둔다(값이 하나가 아니라 타입 하나로 못 적는다) — 모름 처리되어
// [a, b] = ta.macd(...) 로 받은 변수들은 런타임 폴백을 쓴다.
['macd','bb','kc','dmi','supertrend'].forEach(k => { PINE_BUILTIN_RET['ta.' + k] = null; });

['pow','sqrt','log','log10','exp','avg','sum','random','todegrees','toradians','sin','cos','tan',
 'asin','acos','atan','round_to_mintick','sign'].forEach(k => { PINE_BUILTIN_RET['math.' + k] = 'float'; });
Object.assign(PINE_BUILTIN_RET, {
  // In real Pine, math.abs/max/min return int when every argument is int.
  // math.abs/max/min은 실제 Pine에서 인자가 전부 int면 int를 돌려준다.
  'math.abs': c => pineNumericPassthrough(c.args),
  'math.max': c => pineNumericPassthrough(c.args),
  'math.min': c => pineNumericPassthrough(c.args),
  'math.floor': 'int', 'math.ceil': 'int',
  // math.round(x) is int, math.round(x, precision) is float — matches real Pine's two overloads exactly.
  // math.round(x)는 int, math.round(x, precision)은 float — 실제 Pine의 두 오버로드 그대로.
  'math.round': c => (c.args.length >= 2 ? 'float' : 'int'),

  'color.new': 'color', 'color.rgb': 'color', 'color.from_gradient': 'color',
  'color.r': 'float', 'color.g': 'float', 'color.b': 'float', 'color.t': 'float',

  'str.tostring': 'string', 'str.upper': 'string', 'str.lower': 'string', 'str.format': 'string',
  'str.replace': 'string', 'str.replace_all': 'string', 'str.trim': 'string', 'str.repeat': 'string',
  'str.substring': 'string', 'str.format_time': 'string',
  'str.length': 'int', 'str.pos': 'int',
  'str.contains': 'bool', 'str.startswith': 'bool', 'str.endswith': 'bool',
  'str.tonumber': 'float', 'str.split': 'array<string>',

  'timeframe.change': 'bool', 'timeframe.in_seconds': 'int',

  'table.new': 'table', 'line.new': 'line', 'box.new': 'box', 'label.new': 'label',
  'map.new': c => pineGenericNewType('map', c.node),
  'matrix.new': 'matrix',
  'array.new': c => pineGenericNewType('array', c.node),
  'array.from': c => pineArrayOf(c.args.reduce((a, b) => pineTypeMerge(a, b), null)),

  // Top-level built-in functions
  // 최상위 내장 함수들
  time: 'int', timestamp: 'int', dayofweek: 'int',
  na: 'bool', fixnan: c => c.args[0] || 'float',
  nz: c => pineNumericPassthrough(c.args),
  iff: c => pineTypeMerge(c.args[1], c.args[2]),
  heikinashi: 'string',
  int: 'int', float: 'float', bool: 'bool', string: 'string', color: 'color',
  // v4-style input(defval, ...) — the returned value's type simply follows the default value's type.
  // v4식 input(defval, ...) — 돌려주는 값의 타입은 기본값의 타입을 그대로 따라간다.
  input: c => c.args[0] || null,
});
['float','int','bool','string','color','line','label','box','table'].forEach(k => {
  PINE_BUILTIN_RET['array.new_' + k] = pineArrayOf(k);
});
['int','float','bool','string','color'].forEach(k => { PINE_BUILTIN_RET['input.' + k] = k; });
['source','price'].forEach(k => { PINE_BUILTIN_RET['input.' + k] = 'float'; });
['timeframe','session','symbol','text_area'].forEach(k => { PINE_BUILTIN_RET['input.' + k] = 'string'; });

// Container/drawing-object methods that take a receiver (first argument). Both the static call form
// (array.get(id, i)) and the method call form (id.get(i)) use this same table — the interpreter's
// dispatch is set up exactly the same way.
// 리시버(첫 인자)를 받는 컨테이너/그리기 객체 메서드들. 정적 호출(array.get(id, i))과 메서드
// 호출(id.get(i)) 양쪽 다 같은 표를 쓴다 — 인터프리터의 디스패치도 정확히 그렇게 되어 있다.
const PINE_METHOD_RET = {
  array: {
    size: 'int', indexof: 'int', lastindexof: 'int',
    binary_search: 'int', binary_search_leftmost: 'int', binary_search_rightmost: 'int',
    includes: 'bool', every: 'bool', some: 'bool', join: 'string',
    sum: 'float', avg: 'float', variance: 'float', stdev: 'float', median: 'float',
    range: 'float', percentrank: 'float', covariance: 'float',
    // Methods that pull out an element just use the array's element type as-is (array<int>.get() -> int)
    // 원소를 꺼내는 것들은 배열의 원소 타입 그대로다 (array<int>.get() -> int)
    get: c => pineArrayElemType(c.recv), pop: c => pineArrayElemType(c.recv),
    shift: c => pineArrayElemType(c.recv), remove: c => pineArrayElemType(c.recv),
    first: c => pineArrayElemType(c.recv), last: c => pineArrayElemType(c.recv),
    min: c => pineArrayElemType(c.recv), max: c => pineArrayElemType(c.recv), mode: c => pineArrayElemType(c.recv),
    slice: c => c.recv, copy: c => c.recv, concat: c => c.recv, standardize: c => c.recv,
  },
  map: {
    size: 'int', contains: 'bool', copy: c => c.recv,
    get: c => pineTypeArgWords(c.recv)[1] || null,
    put: c => pineTypeArgWords(c.recv)[1] || null,
    remove: c => pineTypeArgWords(c.recv)[1] || null,
    keys: c => pineArrayOf(pineTypeArgWords(c.recv)[0]),
    values: c => pineArrayOf(pineTypeArgWords(c.recv)[1]),
  },
  matrix: {
    rows: 'int', columns: 'int', elements_count: 'int', rank: 'int',
    get: 'float', det: 'float', trace: 'float', avg: 'float', min: 'float', max: 'float',
    sum: 'float', median: 'float', mode: 'float',
    is_square: 'bool', is_zero: 'bool', is_identity: 'bool', is_binary: 'bool', is_symmetric: 'bool',
    is_antisymmetric: 'bool', is_diagonal: 'bool', is_triangular: 'bool', is_stable: 'bool',
    copy: 'matrix', inv: 'matrix', pinv: 'matrix', transpose: 'matrix', mult: 'matrix', pow: 'matrix',
    kron: 'matrix', reshape: 'matrix', concat: 'matrix', submatrix: 'matrix', eigenvectors: 'matrix',
    row: 'array<float>', col: 'array<float>', to_array: 'array<float>', eigenvalues: 'array<float>',
  },
  line: { copy: 'line', get_x1: 'int', get_y1: 'float', get_x2: 'int', get_y2: 'float', get_price: 'float' },
  box: { copy: 'box', get_top: 'float', get_bottom: 'float', get_left: 'int', get_right: 'int' },
  label: { copy: 'label', get_x: 'int', get_y: 'float', get_text: 'string' },
  table: {},
};
// For these namespaces, the first argument of a static call is the receiver. The "constructors" below are
// the exception, though — they get caught earlier by PINE_BUILTIN_RET.
// 이 네임스페이스의 정적 호출은 첫 인자가 리시버다. 단, 아래 "생성자"들은 예외라 PINE_BUILTIN_RET에서 먼저 걸린다.
const PINE_RECEIVER_NAMESPACES = new Set(['array', 'map', 'matrix', 'line', 'box', 'label', 'table']);

// Back in v3/v4 there were no namespaces, so people wrote sma()/abs()/tostring() as bare names — this
// creates type aliases with the same rule pine-builtins.js uses to create its aliases (only when the bare
// name doesn't already exist).
// v3/v4 시절엔 네임스페이스가 없어서 sma()/abs()/tostring() 처럼 맨 이름으로 썼다 —
// pine-builtins.js가 만드는 별칭과 똑같은 규칙으로(이미 같은 이름이 없을 때만) 타입도 별칭을 만든다.
['ta.', 'math.', 'str.'].forEach(prefix => {
  Object.keys(PINE_BUILTIN_RET).forEach(k => {
    if(k.indexOf(prefix) !== 0) return;
    const bare = k.slice(prefix.length);
    if(!PINE_BUILTIN_RET.hasOwnProperty(bare)) PINE_BUILTIN_RET[bare] = PINE_BUILTIN_RET[k];
  });
});

// Functions like math.abs/max/min/nz: "int if every argument is int, float if even one is float".
// math.abs/max/min/nz 처럼 "인자가 전부 int면 int, 하나라도 float면 float"인 함수들.
function pineNumericPassthrough(args){
  let t = null;
  for(const a of args){
    if(a == null) return 'float'; // If an unknown argument is mixed in, default to the wider type / 모르는 인자가 섞이면 더 넓은 쪽으로 둔다
    t = pineTypeMerge(t, a);
  }
  return t || 'float';
}
// Turns the generic type argument of array.new<int>() / map.new<string, float>() into an actual type.
// The parser leaves it as typeArgs on the callee (Member) node. With no argument, defaults to float,
// matching real Pine's actual default.
// array.new<int>() / map.new<string, float>() 의 제네릭 타입 인자를 실제 타입으로 만든다.
// 파서가 callee(Member) 노드에 typeArgs로 남겨둔다. 인자가 없으면 실제 Pine 기본값과 같게 float.
function pineGenericNewType(base, node){
  const ta = node && node.callee && node.callee.typeArgs;
  if(!ta || !ta.length) return base === 'map' ? 'map' : 'array<float>';
  return base + '<' + ta.join(',') + '>';
}

// ============================================================
// Inference pass
// 추론 패스
// ============================================================
// When a single function is called with several different types (used generic-style), its body gets
// re-walked per call site; if that produces different types for the same node, that node is marked as
// "can't be determined statically" so the interpreter falls back to the runtime value as before. This is
// more honest and safer than just forcing whichever type was walked last.
// 한 함수를 여러 타입으로 호출하면(제네릭처럼 쓰는 경우) 본문을 콜사이트마다 다시 훑는데,
// 같은 노드에 서로 다른 타입이 들어오면 그 노드는 "정적으로는 못 정한다"고 표시해서 인터프리터가
// 예전처럼 런타임 값으로 폴백하게 한다. 마지막에 훑은 타입을 우기는 것보다 정직하고 안전하다.
const PINE_INFER_MAX_DEPTH = 24;

class PineTypeInferrer {
  constructor(ast, userTypeNames){
    this.ast = ast;
    this.userTypeNames = userTypeNames || new Set();
    this.funcs = new Map();
    this.methods = new Map();
    this.typeDecls = new Map();
    this.globals = new Map();
    this.scopes = [];
    this.fnCache = new Map();
    this.depth = 0;
  }

  run(){
    for(const st of this.ast.body){
      if(st.type === 'FuncDecl'){
        this.funcs.set(st.name, st);
        if(st.isMethod){
          if(!this.methods.has(st.name)) this.methods.set(st.name, []);
          this.methods.get(st.name).push(st);
        }
      } else if(st.type === 'TypeDecl'){
        this.typeDecls.set(st.name, st);
      }
    }
    for(const st of this.ast.body){
      if(st.type === 'FuncDecl' || st.type === 'TypeDecl') continue;
      this.inferStmt(st);
    }
  }

  setType(node, t){
    if(node._stAmbig) return t;
    if(node._stInit && node._st !== t){ node._st = null; node._stAmbig = true; return t; }
    node._st = t; node._stInit = true;
    return t;
  }

  // ---------- Scope ----------
  // ---------- 스코프 ----------
  // Mirrors the interpreter's scoping rules exactly: if/for/while/switch blocks also push a frame, so a
  // variable created with '=' inside one isn't visible outside the block.
  // 인터프리터의 스코프 규칙을 그대로 흉내낸다: if/for/while/switch 블록도 프레임을 하나 밀기
  // 때문에, 그 안에서 '='로 만든 변수는 블록 밖에서는 안 보인다.
  pushScope(vars){ this.scopes.push(vars || new Map()); }
  popScope(){ this.scopes.pop(); }
  lookup(name){
    for(let i = this.scopes.length - 1; i >= 0; i--){
      if(this.scopes[i].has(name)) return this.scopes[i].get(name);
    }
    if(this.globals.has(name)) return this.globals.get(name);
    return undefined;
  }
  declare(name, t){
    if(this.scopes.length) this.scopes[this.scopes.length - 1].set(name, t);
    else this.globals.set(name, t);
  }
  // ':=' reassignment — finds where the variable was originally declared and widens its type (if it was
  // int and a float comes in, it becomes float).
  // ':=' 재할당 — 원래 선언된 자리를 찾아 타입을 넓힌다(int였는데 float가 들어오면 float).
  reassign(name, t){
    for(let i = this.scopes.length - 1; i >= 0; i--){
      if(this.scopes[i].has(name)){ this.scopes[i].set(name, pineTypeMerge(this.scopes[i].get(name), t)); return; }
    }
    if(this.globals.has(name)) this.globals.set(name, pineTypeMerge(this.globals.get(name), t));
    else this.declare(name, t);
  }

  // ---------- Statements ----------
  // The return value is "the type this statement would have if used as an expression" (in Pine, if/switch
  // can also be used as expressions).
  // ---------- 문장 ----------
  // 반환값은 "이 문장이 식으로 쓰였을 때의 타입"이다 (Pine에서 if/switch는 식으로도 쓰인다).
  inferStmt(node){
    if(!node) return null;
    switch(node.type){
      case 'VarDecl': {
        const initT = this.inferExpr(node.init);
        // If the declaration has an explicit type, that wins — the x in `float x = 0` is float, not int.
        // 선언에 타입이 적혀 있으면 그게 우선이다 — `float x = 0`의 x는 int가 아니라 float다.
        const t = node.declType || initT;
        this.declare(node.name, t);
        return t;
      }
      case 'Reassign': {
        const t = this.inferExpr(node.value);
        this.reassign(node.name, t);
        return t;
      }
      case 'TupleDecl':
      case 'TupleReassign': {
        // An expression that returns a tuple value doesn't yet get a per-element type — leave everything
        // as unknown and fall back to the runtime value.
        // 튜플 값을 돌려주는 식은 아직 원소별 타입을 안 만든다 — 전부 모름으로 두고 런타임 폴백.
        this.inferExpr(node.value);
        node.names.forEach(n => { if(node.type === 'TupleDecl') this.declare(n, null); else this.reassign(n, null); });
        return null;
      }
      case 'FieldReassign': {
        this.inferExpr(node.target);
        this.inferExpr(node.value);
        return null;
      }
      case 'If': {
        this.inferExpr(node.cond);
        this.pushScope();
        const a = this.inferBlock(node.then);
        this.popScope();
        let b = null;
        if(node.elseBody){ this.pushScope(); b = this.inferBlock(node.elseBody); this.popScope(); }
        return this.setType(node, node.elseBody ? pineTypeMerge(a, b) : a);
      }
      case 'For': {
        this.inferExpr(node.from); this.inferExpr(node.to);
        if(node.step) this.inferExpr(node.step);
        this.pushScope(new Map([[node.varName, 'int']]));
        const t = this.inferBlock(node.body);
        this.popScope();
        return t;
      }
      case 'ForIn': {
        const iterT = this.inferExpr(node.iterable);
        const vars = new Map([[node.varName, pineArrayElemType(iterT)]]);
        if(node.idxName) vars.set(node.idxName, 'int');
        this.pushScope(vars);
        const t = this.inferBlock(node.body);
        this.popScope();
        return t;
      }
      case 'While': {
        this.inferExpr(node.cond);
        this.pushScope();
        const t = this.inferBlock(node.body);
        this.popScope();
        return t;
      }
      case 'Switch': {
        if(node.subject) this.inferExpr(node.subject);
        let t = null;
        this.pushScope();
        for(const c of node.cases){ this.inferExpr(c.val); t = pineTypeMerge(t, this.inferBlock(c.body)); }
        if(node.def) t = pineTypeMerge(t, this.inferBlock(node.def));
        this.popScope();
        return this.setType(node, t);
      }
      case 'Seq': { let t = null; for(const st of node.stmts) t = this.inferStmt(st); return t; }
      case 'ExprStmt': return this.inferExpr(node.expr);
      default: return null;
    }
  }
  inferBlock(stmts){
    let t = null;
    if(!stmts) return null;
    for(const st of stmts) t = this.inferStmt(st);
    return t;
  }

  // ---------- Expressions ----------
  // ---------- 식 ----------
  inferExpr(node){
    if(!node) return null;
    return this.setType(node, this.computeExprType(node));
  }
  computeExprType(node){
    switch(node.type){
      case 'Number': return node.isInt ? 'int' : 'float';
      case 'String': return node.isColor ? 'color' : 'string';
      case 'Bool': return 'bool';
      case 'Na': return null; // na gets its type from context — the merge rule automatically takes on the other side's type / na는 문맥에서 타입을 얻는다 — 병합 규칙이 알아서 상대 타입을 따라간다
      case 'Ident': return this.inferIdent(node);
      case 'Binary': return this.inferBinary(node);
      case 'Unary': {
        const t = this.inferExpr(node.arg);
        return node.op === 'not' ? 'bool' : t;
      }
      case 'Ternary': {
        this.inferExpr(node.cond);
        return pineTypeMerge(this.inferExpr(node.then), this.inferExpr(node.else));
      }
      case 'Call': return this.inferCall(node);
      case 'Member': return this.inferMember(node);
      case 'Index': return this.inferIndex(node);
      case 'If': return this.inferStmt(node);
      case 'Switch': return this.inferStmt(node);
      case 'ExprList':
      case 'ArrayLiteral': {
        for(const it of node.items) this.inferExpr(it);
        return null; // A tuple/literal list is not a single value / 튜플/리터럴 목록은 값 하나가 아니다
      }
      default: return null;
    }
  }
  inferIdent(node){
    const local = this.lookup(node.name);
    if(local !== undefined) return local;
    if(PINE_BUILTIN_VAR_TYPES.hasOwnProperty(node.name)) return PINE_BUILTIN_VAR_TYPES[node.name];
    return null;
  }
  inferBinary(node){
    const l = this.inferExpr(node.left);
    const r = this.inferExpr(node.right);
    switch(node.op){
      case 'and': case 'or':
      case '==': case '!=': case '<': case '>': case '<=': case '>=':
        return 'bool';
      case '+':
        // If either side is a string, it's concatenation (the interpreter behaves the same way)
        // 문자열이 한쪽이라도 있으면 이어붙이기다(인터프리터도 그렇게 동작한다)
        if(l === 'string' || r === 'string') return 'string';
        return pineNumericPassthrough([l, r]);
      case '-': case '*': case '%':
        return pineNumericPassthrough([l, r]);
      case '/':
        // This engine's '/' always does real-number division even between two ints (see evalBinary). The
        // static type is set to float to match that actual behavior — if type and value disagreed, it
        // would pick even more wrong overloads.
        // 이 엔진의 '/'는 int끼리라도 항상 실수 나눗셈을 한다(evalBinary 참고). 정적 타입도 그
        // 실제 동작에 맞춰 float로 둔다 — 타입과 값이 어긋나면 오버로드를 더 엉뚱하게 고른다.
        return 'float';
      default: return null;
    }
  }
  inferMember(node){
    const path = pineStaticPath(node);
    if(path){
      if(PINE_BUILTIN_CONST_TYPES.hasOwnProperty(path)) return PINE_BUILTIN_CONST_TYPES[path];
      // Decorative constant namespaces (like plot.style_line) whose value is their own name string
      // instead of an actual value
      // 값 대신 자기 이름 문자열이 나오는 장식용 상수 네임스페이스 (plot.style_line 등)
      const root = path.slice(0, path.indexOf('.'));
      if(typeof PINE_SOFT_CONST_NAMESPACES !== 'undefined' && PINE_SOFT_CONST_NAMESPACES.has(root)
         && this.lookup(root) === undefined) return 'string';
    }
    // Field access on a user-defined type instance — uses the declared type written on the field as-is.
    // 사용자 정의 타입 인스턴스의 필드 접근 — 필드에 적힌 선언 타입을 그대로 쓴다.
    const objT = this.inferExpr(node.obj);
    const decl = objT ? this.typeDecls.get(pineTypeBaseWord(objT)) : null;
    if(decl){
      const f = decl.fields.find(f => f.name === node.prop);
      if(f) return f.declType || null;
    }
    return null;
  }
  inferIndex(node){
    const objT = this.inferExpr(node.obj);
    this.inferExpr(node.index);
    // If it's an array, this pulls out an element; otherwise it's a historical-value reference on a
    // series, so the type stays the same.
    // 배열이면 원소를 꺼내는 것이고, 아니면 시리즈의 과거값 참조라 타입이 그대로다.
    if(pineTypeBaseWord(objT) === 'array') return pineArrayElemType(objT);
    return objT;
  }

  inferCall(node){
    const argTypes = [];
    const namedTypes = {};
    for(const a of node.args){
      const t = this.inferExpr(a.value);
      if(a.named) namedTypes[a.name] = t; else argTypes.push(t);
    }
    // Bare-name call: f(x, ...) — a user method can also be called in this form.
    // 맨 이름 호출: f(x, ...) — 사용자 method도 이 형태로 부를 수 있다.
    if(node.callee.type === 'Ident'){
      const name = node.callee.name;
      if(this.methods.has(name)){
        const fn = this.pickOverload(name, argTypes[0]);
        if(fn) return this.specialize(fn, argTypes, node);
      }
      if(this.funcs.has(name)) return this.specialize(this.funcs.get(name), argTypes, node);
      return this.builtinRet(name, null, argTypes, node);
    }
    if(node.callee.type !== 'Member') return null;

    const path = pineStaticPath(node.callee);
    const method = node.callee.prop;
    // TypeName.new(...) — user-defined type constructor
    // TypeName.new(...) — 사용자 정의 타입 생성자
    if(method === 'new' && node.callee.obj.type === 'Ident' && this.typeDecls.has(node.callee.obj.name)){
      return node.callee.obj.name;
    }
    if(path){
      // Constructor-style calls like array.new<int>() must be filtered out before the receiver rule applies.
      // array.new<int>() 처럼 생성자 계열은 리시버 규칙을 타기 전에 먼저 걸러야 한다.
      if(PINE_BUILTIN_RET.hasOwnProperty(path)) return this.builtinRet(path, null, argTypes, node);
      const root = path.slice(0, path.indexOf('.'));
      // For a static call like array.get(id, i), the first argument is the receiver — the same rule as
      // the interpreter's wrapArrayFn.
      // array.get(id, i) 같은 정적 호출은 첫 인자가 리시버다 — 인터프리터의 wrapArrayFn과 같은 규칙.
      if(PINE_RECEIVER_NAMESPACES.has(root) && this.lookup(root) === undefined){
        return this.methodRet(root, method, argTypes[0], argTypes.slice(1), node);
      }
    }
    // A real method call: expr.method(...)
    // 진짜 메서드 호출: expr.method(...)
    const recvT = this.inferExpr(node.callee.obj);
    const base = pineTypeBaseWord(recvT);
    if(base && PINE_METHOD_RET[base] && PINE_METHOD_RET[base].hasOwnProperty(method)){
      return this.methodRet(base, method, recvT, argTypes, node);
    }
    if(this.methods.has(method)){
      const fn = this.pickOverload(method, recvT);
      if(fn) return this.specialize(fn, [recvT].concat(argTypes), node);
    }
    if(this.funcs.has(method)) return this.specialize(this.funcs.get(method), [recvT].concat(argTypes), node);
    return null;
  }
  methodRet(base, method, recvT, args, node){
    const table = PINE_METHOD_RET[base];
    if(!table || !table.hasOwnProperty(method)) return null;
    const e = table[method];
    return typeof e === 'function' ? e({ recv: recvT, args, node, inf: this }) : e;
  }
  builtinRet(name, recvT, args, node){
    if(!PINE_BUILTIN_RET.hasOwnProperty(name)) return null;
    const e = PINE_BUILTIN_RET[name];
    return typeof e === 'function' ? e({ recv: recvT, args, node, inf: this }) : e;
  }

  // Among method candidates that share a name, picks the one whose first parameter type matches — this is
  // the core purpose of this pass. If nothing matches exactly by static type, returns null and the
  // interpreter falls back to the runtime value.
  // 이름이 같은 method 후보들 중 첫 매개변수 타입이 맞는 걸 고른다 — 이게 이 패스의 핵심 목적이다.
  // 정적 타입으로 정확히 맞는 게 없으면 null을 돌려주고, 인터프리터가 런타임 값으로 폴백한다.
  pickOverload(name, firstArgType){
    const cands = this.methods.get(name);
    if(!cands || !cands.length) return null;
    if(cands.length === 1) return cands[0];
    if(!firstArgType) return null;
    const base = pineTypeBaseWord(firstArgType);
    return cands.find(c => c.methodOfType === base) || null;
  }

  // Walks the user function's body once, using this call site's argument types, to work out its return
  // type. (If the same function is called with different types, each signature is walked separately —
  // the same effect as the per-call-site specialization real Pine compilers do. The result is memoized,
  // and recursion is broken by an in-progress marker.)
  // 사용자 함수 본문을 이 콜사이트의 인자 타입으로 한 번 훑어서 리턴 타입을 구한다.
  // (같은 함수를 여러 타입으로 부르면 시그니처별로 따로 훑는다 — 실제 Pine 컴파일러가 하는
  //  콜사이트별 특수화와 같은 효과. 결과는 메모이즈되고, 재귀는 진행 중 표시로 끊는다.)
  specialize(fn, argTypes, node){
    const sig = fn.name + '#' + fn.line + '|' + argTypes.map(t => t || '?').join(',');
    if(this.fnCache.has(sig)) return this.fnCache.get(sig);
    if(this.depth >= PINE_INFER_MAX_DEPTH) return null;
    this.fnCache.set(sig, null); // If recursion enters here again, it gets cut off as "unknown" / 재귀로 다시 들어오면 여기서 "모름"으로 끊긴다
    const vars = new Map();
    fn.params.forEach((p, i) => {
      let t = p.declType || (i < argTypes.length ? argTypes[i] : null);
      // If there's no type notation and no argument was passed either, infer it from the default-value
      // expression (f(len = 14) => ...)
      // 타입 표기가 없고 인자도 안 넘어왔으면 기본값 식에서 추론한다 (f(len = 14) => ...)
      if(t == null && i >= argTypes.length && p.default) t = this.inferExpr(p.default);
      vars.set(p.name, t);
    });
    const savedScopes = this.scopes;
    this.scopes = [vars]; // Outer local scope isn't visible inside a function body (globals stay visible via this.globals) / 함수 본문에서는 바깥 지역 스코프가 안 보인다(전역은 this.globals로 계속 보인다)
    this.depth++;
    let ret = null;
    try{ ret = this.inferBlock(fn.body); }
    finally{ this.depth--; this.scopes = savedScopes; }
    this.fnCache.set(sig, ret);
    return ret;
  }
}

// Builds a static dotted path like 'request.security' (same rule as the interpreter's staticMemberPath).
// This doesn't cache it on the node — the interpreter keeps its own separate cache (_path).
// 'request.security' 같은 정적 점 경로를 만든다(인터프리터의 staticMemberPath와 같은 규칙).
// 여기서는 노드에 캐시하지 않는다 — 인터프리터가 자기 캐시(_path)를 따로 쓰기 때문.
function pineStaticPath(node){
  if(node.type === 'Ident') return node.name;
  if(node.type === 'Member'){
    const base = pineStaticPath(node.obj);
    return base ? base + '.' + node.prop : null;
  }
  return null;
}

function pineInferTypes(ast, userTypeNames){
  try{
    new PineTypeInferrer(ast, userTypeNames).run();
  }catch(e){
    // Type inference is, at the end of the day, just supplementary information for "picking better".
    // If anything goes wrong here it must not block script execution itself, so this quietly gives up
    // and falls back to the runtime-value behavior as before.
    // 타입 추론은 어디까지나 "더 잘 고르기 위한" 부가 정보다. 여기서 뭐가 잘못돼도 스크립트
    // 실행 자체를 막으면 안 되므로, 조용히 포기하고 예전처럼 런타임 폴백으로 돌아간다.
    if(typeof console !== 'undefined' && console.warn) console.warn('pine type inference skipped:', e);
  }
}
