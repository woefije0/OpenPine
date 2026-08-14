/* pine-interpreter.js
   The part that actually executes the AST produced by pine-engine.js. It takes a bar array
   and, for every bar, re-executes the whole script from the start (this is Pine's real execution
   model), collecting the series registered via plot()/hline() and returning them.
   pine-engine.js가 만든 AST를 실제로 실행하는 부분. 봉(bar) 배열을 받아서 매 bar마다
   스크립트 전체를 처음부터 다시 실행하고(Pine의 실제 실행 모델), plot()/hline() 으로
   등록된 시리즈를 모아서 돌려준다. */

class PineRuntimeError extends Error {
  constructor(msg, line){ super(msg); this.line = line; this.pineRuntime = true; }
}
class PineBreakSignal {}
class PineContinueSignal {}

class PineArray {
  constructor(items, kind){ this.items = items || []; this.kind = kind || 'float'; }
}
class PineLine {
  constructor(o){ Object.assign(this, { x1: null, y1: null, x2: null, y2: null, color: '#787b86', width: 1, style: 'solid', extend: 'none', deleted: false }, o); }
}
class PineBox {
  constructor(o){ Object.assign(this, { x1: null, y1: null, x2: null, y2: null, bgcolor: 'rgba(120,123,134,0.2)', bordercolor: '#787b86', text: '', textcolor: '#ffffff', extend: 'none', deleted: false }, o); }
}
class PineLabel {
  constructor(o){ Object.assign(this, { x: null, y: null, text: '', color: 'rgba(30,34,42,0.9)', textcolor: '#ffffff', style: 'label_down', size: 'normal', deleted: false }, o); }
}
// linefill.new(line1, line2, color) — the fill area between two lines. It does not hold its own
// coordinates, only references the two line objects (same as real Pine), so if a line moves the
// fill follows it.
// linefill.new(line1, line2, color) — 두 line 사이를 채우는 면. 좌표를 자기가 들고 있지 않고
// 두 line 객체를 참조만 하므로(실제 Pine과 동일), 선이 움직이면 채움도 같이 따라간다.
class PineLinefill {
  constructor(o){ Object.assign(this, { line1: null, line2: null, color: 'rgba(120,123,134,0.2)', deleted: false }, o); }
}
// table.new/table.cell — only holds data for position + a columns*rows cell grid; the actual HTML
// rendering is done on the pine-import.js side, which reads this object and draws it as an overlay
// div (it's treated differently from line/box/label since it's a table, not a canvas shape). cells
// is a Map keyed by "col,row" strings.
// table.new/table.cell — position + columns*rows 크기의 셀 격자만 데이터로 들고 있고, 실제 HTML
// 렌더링은 pine-import.js 쪽에서 이 객체를 읽어 오버레이 div로 그린다(캔버스 도형이 아니라 표라서
// line/box/label과는 다르게 취급). cells는 "col,row" 문자열을 키로 쓰는 Map.
class PineTable {
  constructor(o){ Object.assign(this, { position: 'top_right', columns: 1, rows: 1, bgcolor: null, bordercolor: null, framecolor: null, cells: new Map(), deleted: false }, o); }
}
// An instance of a user-defined type (a struct-like thing declared with type Name ...). Pine's UDTs
// are reference types (e.g. mutating a value pulled out with arr.get(i) also mutates the original
// inside the array), so this is represented as one real JS object with fields held in a Map — that
// way the existing "reference object" handling logic (the places that check isPineRefObject), such
// as var-slot storage and function persistent state, can be reused as-is.
// 사용자 정의 타입(type Name ... 으로 선언한 struct 비슷한 것)의 인스턴스. Pine의 UDT는 참조
// 타입이라서(예: arr.get(i)로 꺼낸 값을 고쳐도 배열 안의 원본이 같이 바뀜) 진짜 JS 객체 하나로
// 표현하고, 필드는 Map에 담아둔다 — 이렇게 해두면 var 슬롯/함수 지속 상태 저장 같은 기존
// "참조 객체" 처리 로직(isPineRefObject 체크하는 곳들)을 그대로 재사용할 수 있다.
class PineStruct {
  constructor(typeName, fields){ this.typeName = typeName; this.fields = fields; }
}
// map.* — just wraps a single real JS Map. Keys are only ever numbers/booleans/strings, so JS
// Map's SameValueZero comparison lines up exactly with Pine's value-equality comparison.
// map.* — 실제 JS Map 하나를 감싸기만 한다. 키는 숫자/불리언/문자열만 오므로 JS Map의
// SameValueZero 비교가 Pine의 값 동등 비교와 그대로 맞는다.
class PineMap {
  constructor(){ this.map = new Map(); }
}
// matrix.* — stored as an array of row arrays (rows[r][c]). rows/columns are not kept separately;
// they're computed every time from data.length / data[0].length — that way add_row/reshape and
// friends can resize freely without needing a separate counter to stay in sync.
// matrix.* — 행(row) 배열의 배열로 저장한다(rows[r][c]). rows/columns는 따로 안 들고 있고
// 매번 data.length / data[0].length로 구한다 — add_row/reshape 등이 크기를 바꾸는데 그때마다
// 별도 카운터를 맞춰줄 필요가 없어진다.
class PineMatrix {
  constructor(rows){ this.data = rows || []; }
  get rowCount(){ return this.data.length; }
  get colCount(){ return this.data.length ? this.data[0].length : 0; }
}
function isPineRefObject(v){ return v instanceof PineArray || v instanceof PineLine || v instanceof PineBox || v instanceof PineLabel || v instanceof PineLinefill || v instanceof PineTable || v instanceof PineStruct || v instanceof PineMap || v instanceof PineMatrix; }
// Clones the shallow structure of callState (the per-callsite state Map used by ta.* etc.) one
// level deep. Every field of a state object is a number/boolean/string or an array of such values
// (the ta.* implementations never store reference objects like line/box in it), so it's enough to
// slice() just the array fields — used by runIncrementalLastBar(), which on every tick of the
// "in-progress last bar" reverts to the previous snapshot and then re-executes only that one bar.
// callState(ta.* 등 콜사이트별 상태 Map)의 얕은 구조를 깊이 1단계로 복제한다. 상태 객체의 필드는
// 전부 숫자/불리언/문자열/그런 값들의 배열이라서(ta.* 구현부가 line/box 같은 참조 객체를 담는 일이
// 없다), 배열 필드만 slice()하면 충분하다 — runIncrementalLastBar()가 "진행 중인 마지막 봉" 틱마다
// 이전 스냅샷으로 되돌린 뒤 그 봉 하나만 다시 실행하는 데 쓴다.
function clonePineCallState(map){
  const out = new Map();
  for(const [k, v] of map){
    const copy = {};
    for(const key in v){ const val = v[key]; copy[key] = Array.isArray(val) ? val.slice() : val; }
    out.set(k, copy);
  }
  return out;
}
// A variable declared with var inside a function stores its state in a real global slot, keyed
// per "who called this function" (callPath); the function's scope frame only holds this marker,
// which indirectly references the real value. (Same approach as built-in functions like ta.ema
// having per-callsite state.)
// 함수 내부에서 var로 선언한 변수는 "누가 이 함수를 호출했는지"(callPath)별로 진짜 전역 슬롯에
// 상태를 저장해두고, 그 함수의 스코프 프레임에는 이 마커만 넣어서 실제 값을 우회 참조하게 한다.
// (ta.ema 같은 내장 함수가 콜사이트별로 상태를 갖는 것과 같은 방식)
class PineFnPersistentRef { constructor(key){ this.key = key; } }
// Most if/while/switch blocks never create a single local variable. If we allocated a fresh Map
// for every such frame (bar count x block count), it would be pure garbage, so a shared read-only
// empty Map is used by default, and it's only swapped for a real Map when something actually needs
// to be stored (topFrameVars). Never write to this one directly.
// if/while/switch 블록은 대부분 지역 변수를 하나도 만들지 않는다. 그런 프레임까지 매번 Map을
// 새로 만들면(봉 수 × 블록 수만큼) 순수한 쓰레기가 되므로, 읽기 전용 공용 빈 Map을 깔아두고
// 실제로 뭔가 저장할 때(topFrameVars)만 진짜 Map으로 바꿔 끼운다. 절대 여기에 쓰면 안 된다.
const PINE_EMPTY_VARS = new Map();
// The maximum number of iterations allowed for a single execution of a loop. A safety net so that
// a mistakenly (or maliciously) pasted `while true` / `for i = 0 to 1e9` doesn't freeze the whole
// browser tab.
// 반복문 하나가 한 번 실행될 때 허용하는 최대 반복 횟수. 실수(또는 악의)로 붙여넣은
// `while true` / `for i = 0 to 1e9` 한 줄에 브라우저 탭이 통째로 얼어붙지 않게 하는 안전장치.
const PINE_MAX_LOOP_ITERATIONS = 200000;

function pineNum(v){ return v == null ? NaN : Number(v); }
// In real Pine, if the result of an arithmetic operation isn't a valid real number (0/0, x/0, etc.)
// it becomes na — JS would just return NaN/Infinity as-is, so this normalizes it to na (=null) here
// to prevent NaN from getting stored in the internal state of stateful functions like ta.ema
// afterward, which would permanently corrupt that state.
// 실제 Pine에서 사칙연산 결과가 유효한 실수가 아니면(0/0, x/0 등) na가 된다 — JS는 그 자리에서
// NaN/Infinity를 그대로 돌려주므로, 여기서 na(=null)로 정규화해서 이후 ta.ema 등 상태 유지
// 함수의 내부 상태에 NaN이 저장되어 영구적으로 오염되는 걸 막는다.
function pineArithOrNa(v){ return Number.isFinite(v) ? v : null; }
function pineTruthy(v){
  if(v === true) return true;
  if(v === false || v === null || v === undefined) return false;
  if(typeof v === 'number') return v !== 0 && !isNaN(v);
  if(typeof v === 'string') return v.length > 0;
  return !!v;
}
function pineEquals(a, b){
  if(a === null && b === null) return true;
  if(a === null || b === null) return false;
  return a === b;
}
function pineFmt(v){
  if(v === null || v === undefined) return 'na';
  if(typeof v === 'number') return (Math.round(v * 100000) / 100000).toString();
  return String(v);
}
// The format string for str.tostring(value, format) / str.format("{0,number,#.##}", ...).
// Pine uses a subset of Java's DecimalFormat: '#' is a digit position printed if present and
// omitted otherwise, '0' is a digit position padded with 0 even if absent, ',' is the thousands
// separator, and '%' multiplies by 100 and appends %.
// (This argument used to be ignored entirely, so str.tostring(x, "#.##") would come out with the
// full 5 decimal places unchanged.)
// str.tostring(value, format) / str.format("{0,number,#.##}", ...)의 서식 문자열.
// Pine은 Java DecimalFormat의 부분집합을 쓴다: '#'는 있으면 찍고 없으면 생략하는 자리, '0'은
// 없어도 0으로 채우는 자리, ','는 천 단위 구분, '%'는 100을 곱하고 % 붙이기.
// (예전엔 이 인자를 통째로 무시해서 str.tostring(x, "#.##")이 소수점 5자리까지 그대로 나왔다.)
function pineFormatNumber(v, fmt){
  if(v === null || v === undefined) return 'na';
  if(fmt == null || fmt === '') return pineFmt(v);
  const f = String(fmt);
  if(typeof v !== 'number'){ const asNum = pineNum(v); if(asNum === null || isNaN(asNum)) return pineFmt(v); v = asNum; }
  if(!isFinite(v)) return 'na';
  // format.mintick / format.percent / format.volume — these come in as constants rather than
  // format strings (thanks to PINE_SOFT_CONST_NAMESPACES, the constant's own name string is passed
  // in as the value).
  // format.mintick / format.percent / format.volume — 서식 문자열이 아니라 상수로 넘어오는 형태
  // (PINE_SOFT_CONST_NAMESPACES 덕분에 자기 이름 문자열이 값으로 들어온다).
  if(f === 'format.percent') return pineFormatNumber(v, '#.##') + '%';
  if(f === 'format.volume'){
    const a = Math.abs(v);
    if(a >= 1e12) return pineFormatNumber(v / 1e12, '#.###') + 'T';
    if(a >= 1e9) return pineFormatNumber(v / 1e9, '#.###') + 'B';
    if(a >= 1e6) return pineFormatNumber(v / 1e6, '#.###') + 'M';
    if(a >= 1e3) return pineFormatNumber(v / 1e3, '#.###') + 'K';
    return pineFormatNumber(v, '#.###');
  }
  const pat = f.match(/[#0][#0,]*(?:\.[#0]+)?/);
  if(!pat) return pineFmt(v); // unrecognized value like format.mintick — fall back to default formatting like before / format.mintick 등 알 수 없는 값 — 예전처럼 기본 서식
  const body = pat[0];
  const dot = body.indexOf('.');
  const fracPat = dot < 0 ? '' : body.slice(dot + 1);
  const intPat = (dot < 0 ? body : body.slice(0, dot)).replace(/,/g, '');
  const maxFrac = fracPat.length;
  const minFrac = (fracPat.match(/0/g) || []).length;
  const minInt = Math.max(1, (intPat.match(/0/g) || []).length);
  const percent = f.indexOf('%') !== -1;
  const x = percent ? v * 100 : v;
  const neg = x < 0;
  let s = Math.abs(x).toFixed(maxFrac);
  let [ip, fp = ''] = s.split('.');
  while(fp.length > minFrac && fp.endsWith('0')) fp = fp.slice(0, -1); // trailing zeros in '#' positions are stripped / '#' 자리의 남는 0은 떼어낸다
  while(ip.length < minInt) ip = '0' + ip;
  if(body.indexOf(',') !== -1) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const num = (neg ? '-' : '') + ip + (fp ? '.' + fp : '');
  // Literal characters attached before/after the pattern ("$#.##", "#.##%", etc.) are preserved as-is.
  // 패턴 앞뒤에 붙은 리터럴("$#.##", "#.##%" 등)은 그대로 살린다.
  return f.slice(0, pat.index) + num + f.slice(pat.index + body.length);
}

// ============================================================
// Built-in series / constants
// ============================================================
// ============================================================
// 내장 시리즈 / 상수
// ============================================================
const BUILTIN_SERIES = {
  close: it => it.closeArr, open: it => it.openArr, high: it => it.highArr, low: it => it.lowArr,
  volume: it => it.volArr, hl2: it => it.hl2Arr, hlc3: it => it.hlc3Arr, ohlc4: it => it.ohlc4Arr,
  hlcc4: it => it.hlcc4Arr, time: it => it.timeArr, time_close: it => it.timeCloseArr,
};
const BUILTIN_CONSTS = {
  bar_index: it => it.curBar,
  last_bar_index: it => it.n - 1,
  last_bar_time: it => it.timeArr[it.n - 1],
  na: () => null,
  // dayofweek (bare name, no parentheses) — the weekday of the current bar. The function forms
  // dayofweek(time)/dayofweek(time, tz) already exist in TOP_LEVEL_BUILTINS in pine-builtins.js;
  // this is the argument-less variable version of it.
  // dayofweek(괄호 없는 맨 이름 형태) — 현재 봉의 요일. dayofweek(time)/dayofweek(time, tz) 함수
  // 형태는 pine-builtins.js의 TOP_LEVEL_BUILTINS에 이미 있고, 이건 그 인자 없는 변수 버전.
  dayofweek: it => pineLocalTimeParts(it.timeArr[it.curBar], null).weekday,
  // Old (v1-v3) Pine had no namespaces, so tr/colors/types/etc. were all used as bare names like this
  // 예전(v1~v3) Pine은 네임스페이스가 없어서 tr/색상/타입 등이 전부 이렇게 맨 이름으로 쓰였다
  tr: it => TA_NS['ta.tr'](it),
  // period/interval/tickerid are also v1-v3 bare-name globals (corresponding to today's
  // timeframe.period, timeframe.period, and syminfo.tickerid respectively). An empty string is
  // the value pineTfSeconds/buildSecuritySeries treat as "the current chart timeframe", so it can
  // just be passed through as-is to evalRequestSecurity.
  // For tickerid, evalRequestSecurity only evaluates the symbol argument and discards it, so the
  // actual value here is never used.
  // period/interval/tickerid도 v1~v3의 맨 이름 전역변수(각각 지금의 timeframe.period,
  // timeframe.period, syminfo.tickerid). 빈 문자열은 pineTfSeconds/buildSecuritySeries가
  // "현재 차트 타임프레임"으로 취급하는 값이라 evalRequestSecurity에 그대로 넘기면 된다.
  // tickerid는 evalRequestSecurity가 심볼 인자를 평가만 하고 버리므로 값 자체는 안 쓰인다.
  period: () => '', interval: () => '', tickerid: () => '',
  lime: () => '#00e676', green: () => '#089981', red: () => '#f23645', maroon: () => '#880e4f',
  blue: () => '#2962ff', black: () => '#000000', gray: () => '#787b86', grey: () => '#787b86',
  white: () => '#ffffff', orange: () => '#ff9800', purple: () => '#9c27b0', yellow: () => '#ffeb3b',
  aqua: () => '#00bcd4', fuchsia: () => '#e040fb', silver: () => '#c0c0c0', navy: () => '#01579b',
  olive: () => '#827717', teal: () => '#00897b',
  line: () => 'plot.style_line', histogram: () => 'plot.style_histogram', cross: () => 'plot.style_cross',
  area: () => 'plot.style_area', columns: () => 'plot.style_columns', circles: () => 'plot.style_circles',
  // Bare names for hline()'s v1-v3-style linestyle= argument (the current engine's hline()
  // doesn't actually use the linestyle value itself, but a value is still filled in so the
  // reference doesn't die with an "undefined name" error).
  // hline()의 v1~v3식 linestyle= 인자용 맨 이름(현재 엔진의 hline()은 linestyle 값 자체를 쓰진
  // 않지만, 참조 자체가 "정의되지 않은 이름" 에러로 죽지 않도록 값은 채워둔다).
  solid: () => 'line.style_solid', dashed: () => 'line.style_dashed', dotted: () => 'line.style_dotted',
  stepline: () => 'plot.style_stepline', linebr: () => 'plot.style_linebr',
  bool: () => 'bool', integer: () => 'integer', float: () => 'float', resolution: () => 'resolution', session: () => 'session',
  source: () => 'source', symbol: () => 'symbol',
};
const PINE_BUILTIN_CONST_NS = {
  'color.red': '#f23645', 'color.green': '#089981', 'color.blue': '#2962ff', 'color.orange': '#ff9800',
  'color.yellow': '#ffeb3b', 'color.purple': '#9c27b0', 'color.white': '#ffffff', 'color.black': '#000000',
  'color.gray': '#787b86', 'color.grey': '#787b86', 'color.lime': '#00e676', 'color.aqua': '#00bcd4',
  'color.fuchsia': '#e040fb', 'color.maroon': '#880e4f', 'color.navy': '#01579b', 'color.olive': '#827717',
  'color.silver': '#c0c0c0', 'color.teal': '#00897b', 'color.new': null, // color.new is a function, so it's not included here / color.new는 함수라 여기 안 씀
  'math.pi': Math.PI, 'math.e': Math.E, 'math.phi': 1.618033988749895, 'math.rphi': 0.6180339887498949,
  // Position constants used with table.new(position, ...) — pine-import.js reads this string
  // as-is to decide which corner/edge of the chart to attach the overlay div to.
  // table.new(position, ...)에 쓰는 위치 상수 — pine-import.js가 이 문자열 그대로 보고 오버레이
  // div를 차트의 어느 모서리/변에 붙일지 정한다.
  'position.top_left': 'top_left', 'position.top_center': 'top_center', 'position.top_right': 'top_right',
  'position.middle_left': 'middle_left', 'position.middle_center': 'middle_center', 'position.middle_right': 'middle_right',
  'position.bottom_left': 'bottom_left', 'position.bottom_center': 'bottom_center', 'position.bottom_right': 'bottom_right',
  // chart.fg_color/bg_color — this app is always dark-themed, so a fixed value matching that is given.
  // chart.fg_color/bg_color — 이 앱은 항상 다크 테마라 그에 맞는 고정값을 준다.
  'chart.fg_color': '#d1d4dc', 'chart.bg_color': '#131722',
  // dayofweek.* — follows the same convention as the weekday value returned by pineLocalTimeParts()
  // (Sunday=1 ... Saturday=7).
  // dayofweek.* — pineLocalTimeParts()가 돌려주는 weekday 값(일=1~토=7)과 같은 규칙.
  'dayofweek.sunday': 1, 'dayofweek.monday': 2, 'dayofweek.tuesday': 3, 'dayofweek.wednesday': 4,
  'dayofweek.thursday': 5, 'dayofweek.friday': 6, 'dayofweek.saturday': 7,
  // strategy.* direction/quantity-method/commission-method/OCA constants — chosen so the values
  // themselves match pine-strategy.js's internal enum strings/signs exactly, so the strategy()
  // builtin can use them directly without a separate mapping step.
  // strategy.* 방향/수량방식/수수료방식/OCA 상수 — 값 자체가 pine-strategy.js 내부 enum
  // 문자열/부호와 그대로 일치하도록 골라서, strategy() 빌트인 쪽에서 별도 매핑 없이 바로 쓴다.
  'strategy.long': 1, 'strategy.short': -1, 'strategy.direction.long': 1, 'strategy.direction.short': -1,
  'strategy.fixed': 'fixed', 'strategy.cash': 'cash', 'strategy.percent_of_equity': 'percent_of_equity',
  'strategy.commission.percent': 'percent', 'strategy.commission.cash_per_contract': 'cash_per_contract', 'strategy.commission.cash_per_order': 'cash_per_order',
  'strategy.oca.none': 'none', 'strategy.oca.cancel': 'cancel', 'strategy.oca.reduce': 'reduce',
};
const PINE_SOFT_CONST_NAMESPACES = new Set(['plot','shape','size','location','scale','hline','line','label','barmerge','currency','session','format','xloc','yloc','text','strategy','order','display','extend','adjustment','settle','syminfo','timeframe','ticker','earnings','dividends','splits','alert',
  // input.integer/input.float/input.bool/... — bare constants for the type= argument of Pine
  // v4-style input(). (Separate from the v5-style namespaced functions "called" with parentheses
  // like input.int(...)/input.float(...) — those look up PINE_BUILTIN_NS directly through the Call
  // path, so adding these to this table doesn't conflict with them.)
  // input.integer/input.float/input.bool/... — Pine v4식 input()의 type= 인자용 맨 상수.
  // (input.int(...)/input.float(...) 처럼 괄호를 붙여 "호출"하는 v5식 네임스페이스 함수와는 별개 —
  // 그건 Call 경로에서 PINE_BUILTIN_NS를 직접 찾으므로 이 표에 넣어도 서로 안 부딪힌다.)
  'input']);
const PINE_DYNAMIC_CONST_NS = {
  'barstate.islast': it => it.curBar === it.n - 1,
  'barstate.isfirst': it => it.curBar === 0,
  'barstate.ishistory': it => it.curBar !== it.n - 1,
  'barstate.isrealtime': () => false,
  'barstate.isnew': () => true,
  'barstate.isconfirmed': () => true, // this app only calculates on confirmed bar closes, so it's always treated as true / 이 앱은 확정된 봉 종가 기준으로만 계산하므로 항상 true로 취급
  // This app never deals with an unconfirmed realtime bar (isrealtime is always false) and always
  // calculates on confirmed historical data only, so "the last confirmed historical bar" ends up
  // being the same as islast.
  // 이 앱은 실시간 미확정봉을 다루지 않고(isrealtime 항상 false) 항상 확정된 과거 데이터만
  // 계산하므로, "마지막으로 확정된 과거 봉"은 결국 islast와 같다.
  'barstate.islastconfirmedhistory': it => it.curBar === it.n - 1,
  'timeframe.isdwm': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 86400; },
  'timeframe.isdaily': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 86400 && d < 604800; },
  'timeframe.isweekly': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 604800 && d < 2592000; },
  'timeframe.ismonthly': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 2592000; },
  'timeframe.isintraday': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d > 0 && d < 86400; },
  'timeframe.isminutes': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 60 && d < 86400; },
  'timeframe.isseconds': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d > 0 && d < 60; },
  'timeframe.period': () => '', // treated as an empty string ("current chart timeframe") for the same reason as period / period와 같은 이유로 빈 문자열("현재 차트 타임프레임")로 취급
  // box.all/line.all/label.all — returns, as an array, all the shapes created so far that haven't
  // been deleted. Used for patterns like "for bx in box.all \n bx.delete()" (a common idiom of
  // wiping out everything drawn manually on each bar and redrawing). Rather than wrapping
  // it.lines/it.boxes/it.labels directly, a new filtered array is handed out each time, so it's
  // safe even if the original array shrinks via .delete() mid-iteration.
  // box.all/line.all/label.all — 지금까지 만든(삭제 안 된) 도형들을 배열로 돌려준다.
  // "for bx in box.all \n bx.delete()" 같은 패턴(매 bar마다 직접 그린 것들을 싹 지우고 다시
  // 그리는 흔한 관용구)에 쓰인다. it.lines/it.boxes/it.labels를 그대로 감싸는 게 아니라
  // 새 배열로 필터링해서 주므로, 순회 중에 .delete()로 원본 배열이 줄어들어도 안전하다.
  'box.all': it => new PineArray(it.boxes.filter(b => !b.deleted), 'box'),
  'line.all': it => new PineArray(it.lines.filter(l => !l.deleted), 'line'),
  'label.all': it => new PineArray(it.labels.filter(lb => !lb.deleted), 'label'),
  'linefill.all': it => new PineArray(it.linefills.filter(lf => !lf.deleted), 'linefill'),
  // strategy.* read-only series — since these are the values at the time this bar's script is
  // executing, they reflect "the result filled through the previous bar, before this bar's new
  // orders are processed" (because processStrategyBar runs at the very end of bar processing).
  // If strategyState doesn't exist yet (before strategy() is called, or for an indicator script),
  // everything is treated as 0/na.
  // strategy.* 읽기전용 시리즈 — 이번 bar 스크립트 실행 시점의 값이므로, "이번 bar 새 주문 처리
  // 전, 직전 bar까지 체결된 결과" 기준이다(processStrategyBar가 bar 처리 맨 끝에 도니까).
  // strategyState가 아직 없으면(strategy() 호출 전, 또는 indicator 스크립트) 전부 0/na로 취급.
  'strategy.position_size': it => it.strategyState ? pineStrategyPositionSize(it.strategyState) : 0,
  'strategy.position_avg_price': it => it.strategyState ? pineStrategyPositionAvgPrice(it.strategyState) : 0,
  'strategy.equity': it => it.strategyState ? it.strategyState.equity : 0,
  'strategy.initial_capital': it => it.strategyState ? it.strategyState.initialCapital : 0,
  'strategy.netprofit': it => it.strategyState ? it.strategyState.closedTrades.reduce((s, t) => s + t.pnl, 0) : 0,
  'strategy.grossprofit': it => it.strategyState ? it.strategyState.grossProfit : 0,
  'strategy.grossloss': it => it.strategyState ? it.strategyState.grossLoss : 0,
  'strategy.openprofit': it => it.strategyState ? it.strategyState.openProfit : 0,
  'strategy.opentrades': it => it.strategyState ? it.strategyState.entries.length : 0,
  'strategy.closedtrades': it => it.strategyState ? it.strategyState.closedTrades.length : 0,
  'strategy.wintrades': it => it.strategyState ? it.strategyState.winTrades : 0,
  'strategy.losstrades': it => it.strategyState ? it.strategyState.lossTrades : 0,
  'strategy.max_drawdown': it => it.strategyState ? it.strategyState.maxDrawdown : 0,
  // syminfo.* — this used to entirely be a "decorative constant" (PINE_SOFT_CONST_NAMESPACES), so
  // the constant's own name string became its value. That's invisible when only used for display,
  // but silently turns everything into na the moment it's mixed into a calculation (e.g.
  // math.max(high - low, syminfo.mintick) — the string can't convert to a number so the result is
  // na, and anything divided by that, like buy/sell volume, also becomes entirely na). For values
  // this app actually knows, the real value is given.
  // syminfo.* — 예전엔 통째로 "장식용 상수"(PINE_SOFT_CONST_NAMESPACES)라 자기 이름 문자열이
  // 그대로 값이 됐다. 표시용으로만 쓰이면 티가 안 나지만 계산에 섞이면 조용히 전부 na가 된다
  // (예: math.max(high - low, syminfo.mintick) — 문자열은 숫자로 못 바꿔서 결과가 na, 그걸로
  // 나눈 매수/매도 볼륨도 전부 na). 이 앱이 실제로 아는 값은 진짜 값을 준다.
  'syminfo.mintick': it => pineSymMintick(it),
  'syminfo.minmove': it => Math.round(pineSymMintick(it) * pineSymPricescale(it)),
  'syminfo.pricescale': it => pineSymPricescale(it),
  'syminfo.pointvalue': () => 1,
  'syminfo.ticker': () => pineSymTicker(),
  'syminfo.tickerid': () => (pineSymTicker() ? 'HYPERLIQUID:' + pineSymTicker() : ''),
  'syminfo.prefix': () => 'HYPERLIQUID',
  'syminfo.description': () => { const c = pineSymCoin(); return c ? c + ' / USD' + (pineSymIsSpot() ? '' : ' Perpetual') : ''; },
  'syminfo.basecurrency': () => pineSymCoin(),
  'syminfo.currency': () => 'USD',
  'syminfo.type': () => 'crypto',
  'syminfo.volumetype': () => 'base',
  'syminfo.timezone': () => 'Etc/UTC',
  'syminfo.session': () => 'regular',
};
// The current symbol used to build syminfo.* values — reads PineHost.coin/isSpot directly (set by
// the host app via pineSetSymbol()).
// syminfo.* 값을 만드는 데 쓰는 현재 심볼 — PineHost.coin/isSpot(호스트 앱이 pineSetSymbol()로 설정)을 그대로 읽는다.
function pineSymCoin(){
  return PineHost.coin || '';
}
function pineSymIsSpot(){
  return !!PineHost.isSpot;
}
function pineSymTicker(){
  const coin = pineSymCoin();
  return coin ? coin + 'USD' + (pineSymIsSpot() ? '' : '.P') : '';
}
// The minimum price step. Derived by applying Hyperliquid's 5-significant-figure rule (the same
// rule as the slippage calculation in pine-strategy.js) to the current bar's close — this app has
// no per-symbol tick metadata.
// 최소 가격 단위. 하이퍼리퀴드의 유효숫자 5자리 규칙(pine-strategy.js의 슬리피지 계산과 같은 규칙)을
// 현재 봉 종가에 적용해서 구한다 — 심볼별 틱 메타데이터가 이 앱엔 없다.
function pineSymMintick(it){
  const px = it.closeArr[it.curBar];
  if(typeof pineStrategyTickSize === 'function') return pineStrategyTickSize(px);
  const p = Math.abs(px);
  if(!(p > 0)) return 1e-8;
  return Math.pow(10, parseInt(p.toExponential().split('e')[1], 10) - 4);
}
function pineSymPricescale(it){
  const tick = pineSymMintick(it);
  return tick > 0 ? Math.max(1, Math.round(1 / tick)) : 1;
}
// ticker.heikinashi(sym) / heikinashi(sym) is not a call to "some other symbol" — it's a marker
// meaning "give me this same symbol but converted to heikin-ashi". So the value itself is left as
// a marker string with this prefix, and request.security() sees the marker and evaluates the
// expression with the OHLC time series substituted for heikin-ashi.
// ticker.heikinashi(sym) / heikinashi(sym)는 "다른 심볼"을 부르는 게 아니라 "이 심볼을 하이킨아시로
// 바꿔서 달라"는 표시다. 그래서 값 자체는 이 접두사가 붙은 마커 문자열로 두고, request.security()가
// 그 표시를 보고 OHLC 시계열을 하이킨아시로 바꿔치기한 상태에서 expression을 평가한다.
const PINE_HA_TICKER_PREFIX = 'ticker.heikinashi:';

const NAMESPACE_ROOTS = new Set(['ta','math','array','input','color','str','request','strategy','matrix','map','table','syminfo','timeframe','ticker','chart','line','label','box','linefill','polyline','runtime','log']);
// In real Pine, these names are not functions but "built-in series variables" — used as values
// without parentheses (e.g. `atr = ta.rma(ta.tr, len)`, `plot(ta.obv)`). The implementation is the
// same as the same-named function in TA_NS, so it's called with no arguments and that value is
// returned. Without this, the script would die entirely with "undefined name: ta.tr" (ta.tr is
// extremely common in real-world scripts).
// Only ta.vwap's function form returns a [vwap, upper, lower] tuple, so the variable form uses
// only the first value.
// 실제 Pine에서 이 이름들은 함수가 아니라 "내장 시리즈 변수"다 — 괄호 없이 값으로 쓴다
// (예: `atr = ta.rma(ta.tr, len)`, `plot(ta.obv)`). 구현은 TA_NS의 같은 이름 함수와 동일하므로
// 인자 없이 호출해서 그 값을 돌려준다. 이게 없으면 "정의되지 않은 이름: ta.tr"으로 스크립트가
// 통째로 죽는다(ta.tr은 실전 스크립트에서 매우 흔하다).
// ta.vwap만 함수 형태가 [vwap, 상단, 하단] 튜플을 돌려주므로 변수 형태에서는 첫 값만 쓴다.
const PINE_TA_VALUE_VARS = new Set(['ta.tr', 'ta.vwap', 'ta.obv', 'ta.accdist', 'ta.iii', 'ta.nvi', 'ta.pvi', 'ta.pvt', 'ta.wad', 'ta.wvad']);
const PINE_NO_POS_ARGS = [];
const PINE_NO_NAMED_ARGS = {};

// ============================================================
// PineInterpreter
// ============================================================
class PineInterpreter {
  constructor(ast){
    this.ast = ast;
  }

  // Fills all 11 built-in time series in a single pass (used to call bars.map() 11 times, scanning
  // the bar array 11 times and creating 11 closures — same result, just 1/11th the iteration now).
  // 내장 시계열 11벌을 한 번의 순회로 채운다(예전엔 bars.map()을 11번 돌려서 봉 배열을
  // 11번 훑고 클로저도 11개 만들었다 — 결과는 같고 순회만 1/11로 줄었다).
  precomputeSeries(bars){
    const n = bars.length;
    const close = new Array(n), open = new Array(n), high = new Array(n), low = new Array(n);
    const vol = new Array(n), hl2 = new Array(n), hlc3 = new Array(n), ohlc4 = new Array(n);
    const hlcc4 = new Array(n), time = new Array(n), timeClose = new Array(n);
    // time_close: the time each bar closes. Equal to the next bar's start time; the last bar is
    // estimated using the bar interval.
    // time_close: 각 봉이 닫히는 시각. 다음 봉의 시작 시각과 같고, 마지막 봉은 봉 간격으로 추정한다.
    const barStep = n >= 2 ? (bars[n - 1].time - bars[n - 2].time) : 60;
    for(let i = 0; i < n; i++){
      const b = bars[i];
      const o = b.open, h = b.high, l = b.low, c = b.close;
      open[i] = o; high[i] = h; low[i] = l; close[i] = c;
      vol[i] = b.volume == null ? 0 : b.volume;
      hl2[i] = (h + l) / 2;
      hlc3[i] = (h + l + c) / 3;
      ohlc4[i] = (o + h + l + c) / 4;
      hlcc4[i] = (h + l + c + c) / 4;
      time[i] = b.time;
      timeClose[i] = i + 1 < n ? bars[i + 1].time : b.time + barStep;
    }
    this.closeArr = close; this.openArr = open; this.highArr = high; this.lowArr = low;
    this.volArr = vol; this.hl2Arr = hl2; this.hlc3Arr = hlc3; this.ohlc4Arr = ohlc4;
    this.hlcc4Arr = hlcc4; this.timeArr = time; this.timeCloseArr = timeClose;
  }

  run(bars, inputOverrides){
    this.n = bars.length;
    this.bars = bars;
    this.env = { globals: new Map() };
    this.scopeStack = [];
    this.callState = new Map();
    this.plots = new Map();
    this.hlines = new Map();
    this.fills = new Map();
    this.shapes = new Map();
    this.barcolors = new Map(); // barcolor() — per-callsite array of bar colors / barcolor() — 콜사이트별 봉 색 배열
    this.bgcolors = new Map(); // bgcolor() — per-callsite array of background colors (same shape as barcolors) / bgcolor() — 콜사이트별 배경 색 배열 (barcolors와 같은 모양)
    this.lines = []; this.boxes = []; this.labels = []; this.tables = []; this.linefills = [];
    this.maxLines = 50; this.maxBoxes = 50; this.maxLabels = 50; this.maxLinefills = 50;
    this.meta = { title: 'Custom', overlay: false, shorttitle: '' };
    this.inputMeta = [];
    this.inputOverrides = inputOverrides || {};
    this.userFuncs = new Map(); // name -> FuncDecl. A single name is enough for regular functions since Pine itself forbids duplicate names. / 이름 -> FuncDecl. 일반 함수는 Pine 자체가 이름 중복을 막으므로 이름 하나면 충분.
    // method is different — Pine officially supports declaring multiple methods with "the same
    // name but different types" as a form of overloading (e.g. method toString(TypeA a)=>.. /
    // method toString(TypeB b)=>..). So for method, one name holds multiple candidates, and at the
    // actual call site the runtime type of the receiver is inspected to pick the right one
    // (resolveMethodOverload).
    // method는 다르다 — Pine은 "같은 이름, 다른 타입"의 method를 여러 개 선언하는 걸 오버로딩처럼
    // 정식으로 지원한다(예: method toString(TypeA a)=>.. / method toString(TypeB b)=>..).
    // 그래서 method는 이름 하나에 후보 여러 개를 담아두고, 실제 호출 시점에 리시버의 런타임 타입을
    // 보고 그중 맞는 걸 고른다(resolveMethodOverload).
    this.userMethods = new Map(); // name -> FuncDecl[] / 이름 -> FuncDecl[]
    this.typeDecls = new Map(); // user-defined type (type Name) declarations — used for field default values and TypeName.new() construction / 사용자 정의 타입(type Name) 선언 — 필드 기본값, TypeName.new() 생성에 씀
    // A string formed by joining the stack of user function call sites with dots — lets internal
    // stateful functions like ta.* distinguish state "by who called it". Used to hold an array of
    // call ids and run join('.') every time a state key was needed, which allocated a new string
    // per bar count x call count. Now it's updated only on function entry/exit and reused (it's
    // never even created for global code, since it's an empty string there).
    // 사용자 함수 호출 지점들의 스택을 점으로 이어붙인 문자열 — ta.* 같은 내부 상태 함수가
    // "누가 호출했는지"별로 상태를 구분하게 해준다. 예전엔 호출 id 배열을 들고 있다가 상태 키가
    // 필요할 때마다 join('.')을 돌렸는데, 그러면 봉 수 × 호출 수만큼 문자열이 새로 만들어진다.
    // 함수 진입/이탈 때만 갱신해두고 재사용한다(전역 코드에서는 빈 문자열이라 아예 안 만든다).
    this.callPathStr = '';
    this.fnDepth = 0; // user function nesting depth — used to be counted via scopeStack.filter(...) on every call / 사용자 함수 중첩 깊이 — 예전엔 매 호출마다 scopeStack.filter(...)로 셌다
    this.dynNodeIdSeq = 0; // a running number assigned at runtime to nodes the parser didn't give an id (for built-in variables like ta.tr) / 파서가 id를 안 붙인 노드에 실행 중 붙여주는 번호(ta.tr 같은 내장 변수용)
    this.varScalarSlots = []; // a list collecting only the var scalar slots that need to carry over their previous value across bars / 봉이 넘어갈 때 이전 값을 이어받아야 하는 var 스칼라 슬롯만 모아둔 목록
    this.branchKeyByVarName = new Map(); // per-variable record of "which conditional branch it was last assigned in" (used to distinguish color swatches) / 변수별로 "마지막에 어느 조건 분기에서 할당됐는지" 기록 (색상 스와치 구분용)
    this.precomputeSeries(bars);
    for(const st of this.ast.body){
      if(st.type === 'FuncDecl'){
        this.userFuncs.set(st.name, st);
        if(st.isMethod){
          if(!this.userMethods.has(st.name)) this.userMethods.set(st.name, []);
          this.userMethods.get(st.name).push(st);
        }
      } else if(st.type === 'TypeDecl') this.typeDecls.set(st.name, st);
    }
    if(!this.n) return { meta: this.meta, plots: [], hlines: [], fills: [], inputs: this.inputMeta, lines: [], boxes: [], labels: [], linefills: [], shapes: [], tables: [], barcolors: [], bgcolors: [] };

    for(let i = 0; i < this.n; i++){
      this.curBar = i;
      if(i > 0){
        // Only var scalars carry their previous bar's value forward. Used to scan the entire
        // global slot set on every bar and re-check three conditions each time; now that
        // selection only needs to happen once, at slot creation time.
        // var 스칼라만 이전 봉 값을 이어받는다. 예전엔 전역 슬롯 전체를 매 봉 훑으면서
        // 세 가지 조건을 다시 확인했는데, 해당 슬롯은 만들어질 때 딱 한 번 골라내면 된다.
        const slots = this.varScalarSlots;
        for(let k = 0; k < slots.length; k++){ const h = slots[k].history; h[i] = h[i - 1]; }
      }
      // Snapshot the state right before executing the still-unconfirmed (in-progress) last bar —
      // fully re-executing this script on every realtime tick is expensive, so
      // runIncrementalLastBar() reverts to this snapshot and only recomputes the single last bar
      // to update values (see candles.js).
      // 아직 확정 안 된(진행 중인) 마지막 봉을 실행하기 직전 상태를 찍어둔다 — 실시간 틱마다
      // 이 스크립트를 통째로 재실행하는 건 무거워서, runIncrementalLastBar()가 이 스냅샷으로
      // 되돌린 뒤 마지막 봉 하나만 다시 계산하는 식으로 값을 갱신한다(candles.js 참고).
      if(i === this.n - 1) this.lastBarSnapshot = clonePineCallState(this.callState);
      // For a strategy() script, "before" executing this bar's script, first check the pending
      // orders/brackets accumulated through the previous bar for fills against this bar's OHLC and
      // mark-to-market them. This matches the order real Pine's broker emulator uses — it processes
      // fills the instant a new bar's price data comes in, before the script logic runs — so that
      // values like strategy.position_size reflect "the result just filled on this bar" and the
      // script can read that within the same bar. Most importantly, the very common idiom of
      // "cancel the pending order if the signal condition doesn't hold" (if signal:
      // strategy.entry(...) / else: strategy.cancel(...)) then only cancels an order that "hasn't
      // been filled yet and only becomes valid starting next bar", instead of cancelling an order
      // that was just filled on this very bar. (Processing this "after" script execution caused a
      // bug where a script using the idiom above never got a single chance for its order to fill —
      // it was cancelled again immediately on the very next bar every time, so no trade ever
      // happened.)
      // strategy() 스크립트라면, 이번 bar의 스크립트를 실행하기 "전에" 먼저 이전 bar까지 쌓인 대기
      // 주문/브라켓을 이번 bar의 OHLC로 체결 검사하고 마크투마켓한다. 실제 Pine의 브로커 에뮬레이터가
      // 새 bar의 가격 데이터가 들어오면 그 즉시(스크립트 로직이 돌기 전에) 체결부터 처리하는 것과
      // 같은 순서 — 그래야 strategy.position_size 같은 값이 "이번 bar에 막 체결된 결과"를 스크립트가
      // 같은 bar 안에서 바로 읽을 수 있고, 무엇보다 "신호 조건이 아니면 대기 주문을 취소"하는 매우
      // 흔한 관용구(if 신호: strategy.entry(...) / else: strategy.cancel(...))가 방금 이번 bar에
      // 막 체결된 주문을 취소해버리는 게 아니라 "아직 안 채워진, 다음 bar부터 유효한" 주문만
      // 취소하게 된다. (스크립트 실행 "뒤"에 처리하면 위 관용구를 쓰는 스크립트는 주문이 체결될
      // 기회를 한 번도 못 얻고 매번 바로 다음 bar에 취소당해 거래가 전혀 안 일어나는 버그가 있었다.)
      if(this.strategyState) processStrategyBar(this.strategyState, bars[i], i);
      for(const st of this.ast.body){
        if(st.type === 'FuncDecl' || st.type === 'TypeDecl') continue;
        try{ this.execStatement(st); }
        catch(e){
          if(e instanceof PineBreakSignal || e instanceof PineContinueSignal){
            throw new PineRuntimeError(pineMsg('break/continue는 반복문 안에서만 사용할 수 있습니다', 'break/continue can only be used inside a loop'), st.line);
          }
          throw e;
        }
      }
    }
    this.refreshIncrementalEligibility();
    return this.buildOutput();
  }

  buildOutput(){
    const out = {
      meta: this.meta, plots: [...this.plots.values()], hlines: [...this.hlines.values()], fills: [...this.fills.values()], inputs: this.inputMeta,
      lines: this.lines.filter(l => !l.deleted), boxes: this.boxes.filter(b => !b.deleted), labels: this.labels.filter(lb => !lb.deleted),
      // A fill area only makes sense while both lines it references are alive (in real Pine, too, it disappears when a line is deleted)
      // 채움면은 참조하는 두 선이 살아있을 때만 의미가 있다(선이 지워지면 실제 Pine에서도 같이 사라진다)
      linefills: this.linefills.filter(lf => !lf.deleted && lf.line1 && lf.line2 && !lf.line1.deleted && !lf.line2.deleted),
      shapes: [...this.shapes.values()], tables: this.tables.filter(t => !t.deleted),
      barcolors: [...this.barcolors.values()],
      bgcolors: [...this.bgcolors.values()],
    };
    if(this.strategyState) out.strategy = pineStrategyComputeStats(this.strategyState);
    return out;
  }

  // Determines whether this script is safe to lightly recompute via runIncrementalLastBar() on
  // every "in-progress last bar" tick. strategy()/line/box/label/table/array or struct var are
  // excluded, because re-executing just the last bar over and over would accumulate side effects
  // like "creating a drawing object multiple times"; for those, the full run happens (as before)
  // only when the bar closes and is confirmed — better to have values update a little late than to
  // show something wrong.
  // 이 스크립트가 "진행 중인 마지막 봉" 틱마다 runIncrementalLastBar()로 가볍게 재계산해도 안전한지
  // 판단한다. strategy()/line/box/label/table/배열·구조체 var는 마지막 봉 하나만 되돌려 다시 실행할 때
  // "그리기 객체 하나를 여러 번 새로 만듦" 같은 부작용이 누적되므로 제외하고, 봉 종가 확정 때만
  // (기존처럼) 전체를 다시 돈다 — 값이 조금 늦게 갱신될 뿐 틀리게 보이는 것보다는 낫다.
  refreshIncrementalEligibility(){
    let hasRefGlobal = false;
    for(const slot of this.env.globals.values()){ if(slot.kind === 'object'){ hasRefGlobal = true; break; } }
    this.incrementalEligible = !this.strategyState && !hasRefGlobal &&
      !this.lines.length && !this.boxes.length && !this.labels.length && !this.tables.length;
  }

  // When a single realtime tick changes the OHLCV of the still-unconfirmed last bar, instead of
  // re-running the entire script from scratch, this reverts to the callState snapshot that run()
  // took right before first executing that bar, and re-executes only that bar's statements. If the
  // bar count has changed (i.e. a new bar has been confirmed), this returns null, and the caller
  // (candles.js/pine-import.js) must do a full re-run via refreshAllPineScripts() in that case.
  // 실시간 틱 하나가 아직 확정 안 된 마지막 봉의 OHLCV를 바꿨을 때, 스크립트 전체를 처음부터 다시
  // 도는 대신 run()이 그 봉을 처음 실행하기 직전에 찍어둔 callState 스냅샷으로 되돌리고 그 봉의
  // 문장들만 다시 실행한다. bar 개수가 바뀌었으면(=새 봉이 확정된 경우) null을 돌려주고, 호출부
  // (candles.js/pine-import.js)는 그 경우 refreshAllPineScripts()로 전체 재실행해야 한다.
  runIncrementalLastBar(bars){
    if(!this.n || !bars || bars.length !== this.n || !this.incrementalEligible) return null;
    const i = this.n - 1;
    this.bars = bars;
    const b = bars[i];
    this.openArr[i] = b.open; this.highArr[i] = b.high; this.lowArr[i] = b.low; this.closeArr[i] = b.close;
    this.volArr[i] = b.volume == null ? 0 : b.volume;
    this.hl2Arr[i] = (b.high + b.low) / 2; this.hlc3Arr[i] = (b.high + b.low + b.close) / 3;
    this.ohlc4Arr[i] = (b.open + b.high + b.low + b.close) / 4; this.hlcc4Arr[i] = (b.high + b.low + b.close + b.close) / 4;
    this.callState = clonePineCallState(this.lastBarSnapshot);
    this.curBar = i;
    if(i > 0){ const slots = this.varScalarSlots; for(let k = 0; k < slots.length; k++){ const h = slots[k].history; h[i] = h[i - 1]; } }
    if(this.strategyState) processStrategyBar(this.strategyState, b, i);
    for(const st of this.ast.body){
      if(st.type === 'FuncDecl' || st.type === 'TypeDecl') continue;
      try{ this.execStatement(st); }
      catch(e){
        if(e instanceof PineBreakSignal || e instanceof PineContinueSignal){
          throw new PineRuntimeError(pineMsg('break/continue는 반복문 안에서만 사용할 수 있습니다', 'break/continue can only be used inside a loop'), st.line);
        }
        throw e;
      }
    }
    this.refreshIncrementalEligibility();
    if(!this.incrementalEligible) return null; // if a drawing object/strategy first appeared on this bar, fall back to full re-execution from the next new bar onward / 이 봉에서 처음으로 그리기 객체/strategy가 생겼으면 다음 새 봉부터는 전체 재실행으로 돌아간다
    return this.buildOutput();
  }

  // ---------- statement execution / 문장 실행 ----------
  execStatement(node){
    switch(node.type){
      case 'VarDecl': return this.execVarDecl(node);
      case 'Reassign': return this.execReassign(node);
      case 'TupleDecl': return this.execTupleDecl(node);
      case 'TupleReassign': return this.execTupleReassign(node);
      case 'FieldReassign': return this.execFieldReassign(node);
      case 'FuncDecl': return null;
      case 'TypeDecl': return null;
      case 'If': return this.execIf(node);
      case 'For': return this.execFor(node);
      case 'ForIn': return this.execForIn(node);
      case 'While': return this.execWhile(node);
      case 'Switch': return this.execSwitch(node);
      case 'Break': throw new PineBreakSignal();
      case 'Continue': throw new PineContinueSignal();
      case 'ExprStmt': return this.evalExpr(node.expr);
      case 'Seq': { let v = null; for(const st of node.stmts) v = this.execStatement(st); return v; }
      default: throw new PineRuntimeError(pineMsg('지원하지 않는 문장입니다: ' + node.type, 'Unsupported statement: ' + node.type), node.line);
    }
  }
  execBlock(stmts){
    let v = null;
    for(const st of stmts) v = this.execStatement(st);
    return v;
  }
  // Returns the current scope frame's vars Map "in a writable state" (swaps the shared empty Map for a real Map if that's what it currently is).
  // 지금 스코프 프레임의 vars Map을 "쓸 수 있는 상태로" 돌려준다(공용 빈 Map이면 진짜 Map으로 교체).
  topFrameVars(){
    const f = this.scopeStack[this.scopeStack.length - 1];
    if(f.vars === PINE_EMPTY_VARS) f.vars = new Map();
    return f.vars;
  }
  // Creates a var slot — for a reference object, just the single value; for a scalar, a per-bar history array.
  // var 슬롯 생성 — 참조 객체면 값 하나만, 스칼라면 봉별 히스토리 배열을 들고 있는다.
  makeVarSlot(v){
    if(isPineRefObject(v)) return { isVar: true, everInited: true, kind: 'object', value: v };
    const slot = { isVar: true, everInited: true, kind: 'scalar', history: new Array(this.n) };
    slot.history[this.curBar] = v;
    this.varScalarSlots.push(slot);
    return slot;
  }
  execVarDecl(node){
    if(node.isVar){
      // A var inside a function keeps its state in a separate global slot per "who called it" (callPath).
      // 함수 안의 var는 "누가 불렀는지"(callPath)별로 전역 슬롯에 상태를 따로 둔다.
      const key = this.fnDepth > 0 ? ('fn$' + this.callPathStr + '$' + node.name) : node.name;
      let slot = this.env.globals.get(key);
      if(!slot || !slot.everInited){
        const v = this.evalColorExpr(node.init);
        this.branchKeyByVarName.set(node.name, this.lastColorKey);
        slot = this.makeVarSlot(v);
        this.env.globals.set(key, slot);
      }
      if(this.fnDepth > 0) this.topFrameVars().set(node.name, new PineFnPersistentRef(key));
      return slot.kind === 'object' ? slot.value : slot.history[this.curBar];
    }
    const v = this.evalColorExpr(node.init);
    this.branchKeyByVarName.set(node.name, this.lastColorKey);
    this.assignPlain(node.name, v);
    return v;
  }
  assignPlain(name, v){
    if(this.scopeStack.length > 0){ this.topFrameVars().set(name, v); return; }
    if(isPineRefObject(v)){ this.env.globals.set(name, { isVar: false, everInited: true, kind: 'object', value: v }); return; }
    let slot = this.env.globals.get(name);
    if(!slot || slot.kind !== 'scalar'){ slot = { isVar: false, everInited: true, kind: 'scalar', history: new Array(this.n) }; this.env.globals.set(name, slot); }
    slot.history[this.curBar] = v;
  }
  execReassign(node){
    const v = this.evalColorExpr(node.value);
    this.branchKeyByVarName.set(node.name, this.lastColorKey);
    for(let i = this.scopeStack.length - 1; i >= 0; i--){
      if(this.scopeStack[i].vars.has(node.name)){
        const cur = this.scopeStack[i].vars.get(node.name);
        if(cur instanceof PineFnPersistentRef){
          const slot = this.env.globals.get(cur.key);
          if(slot.kind === 'object') slot.value = v; else slot.history[this.curBar] = v;
          return v;
        }
        this.scopeStack[i].vars.set(node.name, v); return v;
      }
    }
    const slot = this.env.globals.get(node.name);
    if(!slot) throw new PineRuntimeError(pineMsg("정의되지 않은 변수에 ':=' 사용: " + node.name, "Used ':=' on an undefined variable: " + node.name), node.line);
    if(slot.kind === 'object'){ slot.value = v; return v; }
    slot.history[this.curBar] = v; return v;
  }
  execTupleDecl(node){
    const raw = this.evalExpr(node.value);
    const vals = Array.isArray(raw) ? raw : [raw];
    node.names.forEach((name, k) => this.assignPlain(name, vals[k] === undefined ? null : vals[k]));
    return null;
  }
  execTupleReassign(node){
    const raw = this.evalExpr(node.value);
    const vals = Array.isArray(raw) ? raw : [raw];
    node.names.forEach((name, k) => {
      const v = vals[k] === undefined ? null : vals[k];
      for(let i = this.scopeStack.length - 1; i >= 0; i--){
        if(this.scopeStack[i].vars.has(name)){ this.scopeStack[i].vars.set(name, v); return; }
      }
      const slot = this.env.globals.get(name);
      if(!slot) throw new PineRuntimeError(pineMsg("정의되지 않은 변수에 ':=' 사용: " + name, "Used ':=' on an undefined variable: " + name), node.line);
      if(slot.kind === 'object') slot.value = v; else slot.history[this.curBar] = v;
    });
    return null;
  }
  // obj.field := value — a user-defined type (struct) instance is a reference, so directly
  // mutating a field is also visible through any other variable/array element pointing at the
  // same instance.
  // obj.field := value — 사용자 정의 타입(struct) 인스턴스는 참조라서, 필드를 직접 고치면
  // 그 인스턴스를 가리키는 다른 변수/배열 원소에서도 똑같이 바뀐 값이 보인다.
  execFieldReassign(node){
    const objVal = this.evalExpr(node.target.obj);
    if(!(objVal instanceof PineStruct)) throw new PineRuntimeError(pineMsg('필드 재할당 대상이 사용자 정의 타입 인스턴스가 아닙니다: .' + node.target.prop, 'Field reassignment target is not a user-defined type instance: .' + node.target.prop), node.line);
    if(!objVal.fields.has(node.target.prop)) throw new PineRuntimeError(pineMsg(objVal.typeName + ' 타입에 ' + node.target.prop + ' 필드가 없습니다', objVal.typeName + ' has no field ' + node.target.prop), node.line);
    const v = this.evalExpr(node.value);
    objVal.fields.set(node.target.prop, v);
    return v;
  }
  execIf(node){
    this.scopeStack.push({ isFunctionCall: false, vars: PINE_EMPTY_VARS });
    try{
      if(pineTruthy(this.evalExpr(node.cond))) return this.execBlock(node.then);
      if(node.elseBody) return this.execBlock(node.elseBody);
      return null;
    } finally { this.scopeStack.pop(); }
  }
  // A loop's scope frame is not recreated on every iteration; one frame is reused via clear() —
  // the semantics are the same (each iteration still gets its own local variables), it just
  // eliminates the object/Map allocation that would otherwise happen once per iteration.
  // The frame object itself is one per execFor call, so this doesn't conflict with recursive calls.
  // 반복문의 스코프 프레임은 반복마다 새로 만들지 않고 하나를 clear()해서 재사용한다 —
  // 의미는 같고(각 반복은 여전히 자기만의 지역 변수를 가진다) 반복 횟수만큼의 객체/Map 생성이 사라진다.
  // 프레임 객체 자체는 execFor 호출 1회당 하나라서 재귀 호출과도 안 부딪힌다.
  execFor(node){
    const from = pineNum(this.evalExpr(node.from));
    const to = pineNum(this.evalExpr(node.to));
    const step = node.step ? pineNum(this.evalExpr(node.step)) : (to >= from ? 1 : -1);
    let result = null;
    if(step === 0) throw new PineRuntimeError(pineMsg('for 문의 by 값은 0이 될 수 없습니다', "The 'by' step in a for statement cannot be 0"), node.line);
    const frame = { isFunctionCall: false, vars: new Map() };
    let guard = 0;
    for(let v = from; (step > 0 ? v <= to : v >= to); v += step){
      // Safety net for the same reason as while — prevents a single `for i = 0 to 1e9` line from freezing the whole tab.
      // while과 같은 이유의 안전장치 — `for i = 0 to 1e9` 한 줄로 탭이 통째로 얼어붙는 걸 막는다.
      if(++guard > PINE_MAX_LOOP_ITERATIONS) throw new PineRuntimeError(pineMsg('for 루프가 너무 오래 반복됩니다(무한루프로 판단해 중단)', 'for loop ran too long (stopped — likely an infinite loop)'), node.line);
      frame.vars.clear(); frame.vars.set(node.varName, v);
      this.scopeStack.push(frame);
      try{ result = this.execBlock(node.body); }
      catch(e){
        if(e instanceof PineContinueSignal) continue;
        if(e instanceof PineBreakSignal) break;
        throw e;
      } finally { this.scopeStack.pop(); }
    }
    return result;
  }
  execForIn(node){
    const iterable = this.evalExpr(node.iterable);
    const arr = iterable instanceof PineArray ? iterable.items : (Array.isArray(iterable) ? iterable : []);
    let result = null;
    const frame = { isFunctionCall: false, vars: new Map() };
    for(let idx = 0; idx < arr.length; idx++){
      frame.vars.clear();
      frame.vars.set(node.varName, arr[idx]);
      if(node.idxName) frame.vars.set(node.idxName, idx);
      this.scopeStack.push(frame);
      try{ result = this.execBlock(node.body); }
      catch(e){
        if(e instanceof PineContinueSignal) continue;
        if(e instanceof PineBreakSignal) break;
        throw e;
      } finally { this.scopeStack.pop(); }
    }
    return result;
  }
  execWhile(node){
    let result = null, guard = 0;
    const frame = { isFunctionCall: false, vars: new Map() };
    while(pineTruthy(this.evalExpr(node.cond))){
      if(++guard > PINE_MAX_LOOP_ITERATIONS) throw new PineRuntimeError(pineMsg('while 루프가 너무 오래 반복됩니다(무한루프로 판단해 중단)', 'while loop ran too long (stopped — likely an infinite loop)'), node.line);
      frame.vars.clear();
      this.scopeStack.push(frame);
      try{ result = this.execBlock(node.body); }
      catch(e){
        if(e instanceof PineContinueSignal) continue;
        if(e instanceof PineBreakSignal) break;
        throw e;
      } finally { this.scopeStack.pop(); }
    }
    return result;
  }
  execSwitch(node){
    const subj = node.subject ? this.evalExpr(node.subject) : null;
    let body = null;
    for(const c of node.cases){
      const val = this.evalExpr(c.val);
      if(node.subject ? pineEquals(subj, val) : pineTruthy(val)){ body = c.body; break; }
    }
    if(!body) body = node.def;
    if(!body) return null;
    this.scopeStack.push({ isFunctionCall: false, vars: PINE_EMPTY_VARS });
    try{ return this.execBlock(body); } finally { this.scopeStack.pop(); }
  }

  // ---------- expression evaluation / 식 평가 ----------
  evalExpr(node){
    switch(node.type){
      case 'Number': return node.value;
      case 'String': return node.value;
      case 'Bool': return node.value;
      case 'Na': return null;
      case 'Ident': return this.evalIdent(node);
      case 'Binary': return this.evalBinary(node);
      case 'Unary': return this.evalUnary(node);
      case 'Ternary': return pineTruthy(this.evalExpr(node.cond)) ? this.evalExpr(node.then) : this.evalExpr(node.else);
      case 'Call': return this.evalCall(node);
      case 'Member': return this.evalMember(node);
      case 'Index': return this.evalIndex(node);
      case 'If': return this.execIf(node);
      case 'Switch': return this.execSwitch(node);
      case 'ExprList': return node.items.map(it => this.evalExpr(it));
      case 'ArrayLiteral': return node.items.map(it => this.evalExpr(it));
      default: throw new PineRuntimeError(pineMsg('지원하지 않는 식입니다: ' + node.type, 'Unsupported expression: ' + node.type), node.line);
    }
  }
  evalIdent(node){
    for(let i = this.scopeStack.length - 1; i >= 0; i--){
      if(this.scopeStack[i].vars.has(node.name)){
        const v = this.scopeStack[i].vars.get(node.name);
        if(v instanceof PineFnPersistentRef){
          const slot = this.env.globals.get(v.key);
          return slot.kind === 'object' ? slot.value : (slot.history[this.curBar] === undefined ? null : slot.history[this.curBar]);
        }
        return v;
      }
    }
    const slot = this.env.globals.get(node.name);
    if(slot){
      if(slot.kind === 'object') return slot.value;
      const v = slot.history[this.curBar];
      return v === undefined ? null : v;
    }
    if(BUILTIN_SERIES[node.name]) return BUILTIN_SERIES[node.name](this)[this.curBar];
    if(BUILTIN_CONSTS.hasOwnProperty(node.name)) return BUILTIN_CONSTS[node.name](this);
    if(this.userFuncs.has(node.name)) throw new PineRuntimeError(pineMsg(node.name + '는 함수입니다. 괄호를 붙여 호출해야 합니다', node.name + ' is a function — call it with parentheses'), node.line);
    throw new PineRuntimeError(pineMsg('정의되지 않은 이름입니다: ' + node.name, 'Undefined name: ' + node.name), node.line);
  }
  evalBinary(node){
    if(node.op === 'and'){ const l = this.evalExpr(node.left); if(!pineTruthy(l)) return false; return pineTruthy(this.evalExpr(node.right)); }
    if(node.op === 'or'){ const l = this.evalExpr(node.left); if(pineTruthy(l)) return true; return pineTruthy(this.evalExpr(node.right)); }
    const l = this.evalExpr(node.left), r = this.evalExpr(node.right);
    switch(node.op){
      case '+':
        if(typeof l === 'string' || typeof r === 'string') return (l == null ? 'na' : l) + '' + (r == null ? 'na' : r);
        if(l == null || r == null) return null;
        return pineArithOrNa(l + r);
      case '-': if(l == null || r == null) return null; return pineArithOrNa(l - r);
      case '*': if(l == null || r == null) return null; return pineArithOrNa(l * r);
      // Division/modulo: real Pine returns na when dividing by 0 (including 0/0) — JS would return
      // NaN/Infinity right there, and if that later gets stored as-is into the internal state
      // (previous value) of a stateful function like ta.ema, every subsequent bar is permanently
      // contaminated with NaN forever (once NaN — not na — is stored, an "na(prev)" check can't
      // catch it). So the result itself is normalized to na right here to cut off the
      // contamination at the source.
      // Example: the WaveTrend indicator's `ci = (ap-esa)/(0.015*d)` becomes 0/0 on the first bar
      // because d=0 there.
      // 나눗셈/나머지: 실제 Pine은 0으로 나누면(0/0 포함) na를 반환한다 — JS는 그 자리에서
      // NaN/Infinity를 반환하는데, 이게 나중에 ta.ema 같은 상태 유지 함수의 내부 상태(이전 값)에
      // 그대로 저장되면 그 이후 모든 봉이 영원히 NaN으로 오염된다(한 번 na가 아니라 NaN이 저장되면
      // "na(prev)" 검사로는 못 잡아냄). 그래서 결과 자체를 여기서 na로 정규화해 오염을 원천 차단한다.
      // 예: WaveTrend 지표의 `ci = (ap-esa)/(0.015*d)`가 첫 봉에서 d=0이라 0/0이 되는 경우.
      case '/': if(l == null || r == null) return null; return pineArithOrNa(l / r);
      case '%': if(l == null || r == null) return null; return pineArithOrNa(l % r);
      case '==': return pineEquals(l, r);
      case '!=': return !pineEquals(l, r);
      case '<': if(l == null || r == null) return false; return l < r;
      case '>': if(l == null || r == null) return false; return l > r;
      case '<=': if(l == null || r == null) return false; return l <= r;
      case '>=': if(l == null || r == null) return false; return l >= r;
      default: throw new PineRuntimeError(pineMsg('알 수 없는 연산자 ' + node.op, 'Unknown operator ' + node.op), node.line);
    }
  }
  evalUnary(node){
    const v = this.evalExpr(node.arg);
    if(node.op === 'not') return !pineTruthy(v);
    if(node.op === '-') return v == null ? null : -v;
    return v;
  }
  arrayGet(arr, idxVal, line){
    const idx = Math.round(pineNum(idxVal));
    if(!(arr instanceof PineArray)) throw new PineRuntimeError(pineMsg('배열이 아닌 값에 인덱싱을 시도했습니다', 'Tried to index a non-array value'), line);
    if(idx < 0 || idx >= arr.items.length) throw new PineRuntimeError(pineMsg('배열 인덱스 범위를 벗어났습니다(size=' + arr.items.length + ', index=' + idx + ')', 'Array index out of range (size=' + arr.items.length + ', index=' + idx + ')'), line);
    return arr.items[idx];
  }
  evalIndex(node){
    if(node.obj.type === 'Ident'){
      const name = node.obj.name;
      for(let i = this.scopeStack.length - 1; i >= 0; i--){
        if(this.scopeStack[i].vars.has(name)){
          const val = this.scopeStack[i].vars.get(name);
          if(val instanceof PineArray) return this.arrayGet(val, this.evalExpr(node.index), node.line);
          if(val instanceof PineFnPersistentRef){
            const slot = this.env.globals.get(val.key);
            if(slot.kind === 'object'){
              if(slot.value instanceof PineArray) return this.arrayGet(slot.value, this.evalExpr(node.index), node.line);
              throw new PineRuntimeError(pineMsg(name + ' 값에는 []를 사용할 수 없습니다', name + ' cannot be used with []'), node.line);
            }
            const k = Math.round(pineNum(this.evalExpr(node.index)));
            const at = this.curBar - k;
            return at < 0 ? null : (slot.history[at] === undefined ? null : slot.history[at]);
          }
          // Historical-value reference for a function parameter/local variable (stored in scope as
          // a plain value, not var). In real Pine, such local variables also maintain a series so
          // [n] works normally on them — using the same approach as the historical-value reference
          // for an anonymous expression (mostly function call results) below, this node's
          // per-bar-evaluated value (and per call path) is recorded and looked back as far as needed.
          // 함수 매개변수/지역 변수(단순 값으로 스코프에 저장됨, var 아님)에 대한 과거값 참조.
          // 실제 Pine에서는 이런 지역 변수도 series를 유지하므로 [n]이 정상 동작한다 — 아래
          // 익명 식(주로 함수 호출 결과)에 대한 과거값 참조와 동일한 방식으로, 이 노드가 매 bar
          // (그리고 콜 경로별로) 평가되는 값을 기록해뒀다가 필요한 만큼 되돌려본다.
          const s = getState(this, node);
          if(!s.hist) s.hist = new Array(this.n);
          s.hist[this.curBar] = val;
          const k = Math.round(pineNum(this.evalExpr(node.index)));
          const at = this.curBar - k;
          return at < 0 ? null : (s.hist[at] === undefined ? null : s.hist[at]);
        }
      }
      const slot = this.env.globals.get(name);
      if(slot){
        if(slot.kind === 'object'){
          if(slot.value instanceof PineArray) return this.arrayGet(slot.value, this.evalExpr(node.index), node.line);
          throw new PineRuntimeError(pineMsg(name + ' 값에는 []를 사용할 수 없습니다', name + ' cannot be used with []'), node.line);
        }
        const k = Math.round(pineNum(this.evalExpr(node.index)));
        const at = this.curBar - k;
        return at < 0 ? null : (slot.history[at] === undefined ? null : slot.history[at]);
      }
      if(BUILTIN_SERIES[name]){
        const k = Math.round(pineNum(this.evalExpr(node.index)));
        const at = this.curBar - k;
        return at < 0 ? null : BUILTIN_SERIES[name](this)[at];
      }
      // bar_index[n] — bar_index isn't an array but a computed value (it.curBar), so it's not in
      // BUILTIN_SERIES, but "the bar_index value n bars ago" is just that point's index itself, so
      // it's computed with plain arithmetic.
      // bar_index[n] — bar_index는 배열이 아니라 계산값(it.curBar)이라서 BUILTIN_SERIES엔
      // 없지만, "n bar 전의 bar_index 값"은 그 시점의 인덱스 자체이므로 그냥 산수로 구한다.
      if(name === 'bar_index'){
        const k = Math.round(pineNum(this.evalExpr(node.index)));
        const at = this.curBar - k;
        return at < 0 ? null : at;
      }
      throw new PineRuntimeError(pineMsg('정의되지 않은 이름입니다: ' + name, 'Undefined name: ' + name), node.line);
    }
    const objVal = this.evalExpr(node.obj);
    if(objVal instanceof PineArray) return this.arrayGet(objVal, this.evalExpr(node.index), node.line);
    // Just like real Pine, historical-value reference is also allowed on an arbitrary expression
    // that isn't a variable or array (usually a function call result, e.g. pivothigh(...)[1]) — the
    // value this node evaluates to once per bar is recorded per callsite and looked back as far as
    // needed (same approach as the per-callsite state storage of other ta.* builtins).
    // 변수/배열이 아닌 임의의 식(주로 함수 호출 결과, 예: pivothigh(...)[1])에도 실제 Pine처럼
    // 과거값 참조를 허용한다 — 이 노드가 매 bar 한 번씩 평가되는 값을 콜사이트별로 기록해뒀다가
    // 필요한 만큼 되돌려본다(다른 ta.* 내장 함수들의 콜사이트별 상태 저장과 같은 방식).
    const s = getState(this, node);
    if(!s.hist) s.hist = new Array(this.n);
    s.hist[this.curBar] = objVal;
    const k = Math.round(pineNum(this.evalExpr(node.index)));
    const at = this.curBar - k;
    return at < 0 ? null : (s.hist[at] === undefined ? null : s.hist[at]);
  }
  // A static dotted path like "request.security" is fixed per node, so it's built only once and
  // cached on the node (rebuilding it on every bar x every call would just be string garbage).
  // Returns null if it isn't a static path.
  // "request.security" 같은 정적 점 경로는 노드마다 고정이라 처음 한 번만 만들어 노드에 캐시한다
  // (매 봉 · 매 호출마다 다시 이어붙이면 그대로 문자열 쓰레기가 된다). 정적 경로가 아니면 null.
  staticMemberPath(node){
    const cached = node._path;
    if(cached !== undefined) return cached;
    let path = null;
    if(node.type === 'Ident') path = node.name;
    else if(node.type === 'Member'){ const base = this.staticMemberPath(node.obj); path = base ? base + '.' + node.prop : null; }
    node._path = path;
    if(path){
      const dot = path.indexOf('.');
      node._pathRoot = dot < 0 ? path : path.slice(0, dot);
    }
    return path;
  }
  evalMember(node){
    const path = this.staticMemberPath(node);
    if(path){
      if(PINE_DYNAMIC_CONST_NS.hasOwnProperty(path)) return PINE_DYNAMIC_CONST_NS[path](this);
      if(PINE_BUILTIN_CONST_NS.hasOwnProperty(path) && PINE_BUILTIN_CONST_NS[path] !== null) return PINE_BUILTIN_CONST_NS[path];
      if(PINE_SOFT_CONST_NAMESPACES.has(node._pathRoot)) return path; // decorative constant — its own name is used as the value since it's never compared internally / 장식용 상수 — 내부적으로 비교 안 하므로 자기 이름을 값으로 사용
      if(PINE_TA_VALUE_VARS.has(path)){
        // Being a stateful function, this needs a per-callsite state key, but the parser doesn't
        // attach an id to Member nodes. To avoid clashing with plot/input id numbers (user settings
        // are stored keyed by that value), a separate prefix is attached once, the first time this
        // is evaluated.
        // 상태 함수라 콜사이트별 상태 키가 필요한데 Member 노드에는 파서가 id를 안 붙인다.
        // plot/input의 id 번호(사용자 설정이 그 값으로 저장돼 있다)를 건드리지 않도록 별도
        // 접두사로 처음 평가될 때 한 번만 붙여준다.
        if(node.id == null) node.id = 'tav' + (++this.dynNodeIdSeq);
        const v = PINE_BUILTIN_NS[path](this, PINE_NO_POS_ARGS, PINE_NO_NAMED_ARGS, node);
        return Array.isArray(v) ? v[0] : v;
      }
    }
    // Field access on a user-defined type (struct) instance: id.top, element.breaker, etc.
    // staticMemberPath just structurally builds a string like "id.top" (it never looks at the
    // runtime value), so it doesn't get caught by the static-name checks above; here, obj is
    // actually evaluated to check whether it's a struct.
    // 사용자 정의 타입(struct) 인스턴스의 필드 접근: id.top, element.breaker 등.
    // staticMemberPath는 "id.top" 같은 문자열을 그냥 구조적으로 만들 뿐이라(런타임 값은 안 봄)
    // 위의 정적 이름 검사에는 안 걸리고, 여기서 실제로 obj를 평가해서 struct인지 확인한다.
    let objVal;
    try{ objVal = this.evalExpr(node.obj); }catch(e){ objVal = undefined; }
    if(objVal instanceof PineStruct){
      if(!objVal.fields.has(node.prop)) throw new PineRuntimeError(pineMsg(objVal.typeName + ' 타입에 ' + node.prop + ' 필드가 없습니다', objVal.typeName + ' has no field ' + node.prop), node.line);
      return objVal.fields.get(node.prop);
    }
    throw new PineRuntimeError(pineMsg('정의되지 않은 이름입니다: ' + (path || '?'), 'Undefined name: ' + (path || '?')), node.line);
  }
  // TypeName.new(...) — creates a new instance of a user-defined type. Fields are matched to
  // positional arguments in declaration order; if there's no argument or it was given by name, the
  // default-value expression written on the field is evaluated on the spot to fill it in.
  // TypeName.new(...) — 사용자 정의 타입의 새 인스턴스를 만든다. 필드는 선언 순서대로 위치 인자를
  // 매칭하고, 인자가 없거나 이름으로 준 경우엔 필드에 적힌 기본값 식을 그 자리에서 평가해 채운다.
  instantiateStruct(typeName, posArgs, namedArgs, line){
    const decl = this.typeDecls.get(typeName);
    const fields = new Map();
    decl.fields.forEach((f, idx) => {
      let v;
      if(namedArgs.hasOwnProperty(f.name)) v = namedArgs[f.name];
      else if(idx < posArgs.length) v = posArgs[idx];
      else v = f.default ? this.evalExpr(f.default) : null;
      fields.set(f.name, v);
    });
    return new PineStruct(typeName, fields);
  }
  // Given a single runtime value, maps it to a Pine type name (the type name itself for a
  // user-defined type, otherwise a built-in type word like int/float/bool/string/...). Used when
  // picking a method overload by receiver type. int/float can't be distinguished at runtime since
  // both are just plain JS numbers, and color/string can't be distinguished either since both are
  // stored as strings — those cases are matched loosely in pineTypeWordMatches.
  // 런타임 값 하나를 보고 Pine의 타입 이름(사용자 정의 타입이면 그 타입 이름, 아니면 int/float/
  // bool/string/... 같은 내장 타입 단어)으로 매핑한다. method 오버로드를 리시버 타입으로
  // 고를 때 씀. int/float는 런타임에 둘 다 그냥 JS number라 구분 못 하고, color/string도
  // 둘 다 문자열로 저장돼 있어 구분 못 한다 — 그런 경우는 pineTypeWordMatches에서 느슨하게 맞춘다.
  pineRuntimeTypeOf(v){
    if(v instanceof PineStruct) return v.typeName;
    if(v instanceof PineArray) return 'array';
    if(v instanceof PineLine) return 'line';
    if(v instanceof PineBox) return 'box';
    if(v instanceof PineLabel) return 'label';
    if(v instanceof PineLinefill) return 'linefill';
    if(v instanceof PineTable) return 'table';
    if(v instanceof PineMap) return 'map';
    if(v instanceof PineMatrix) return 'matrix';
    if(typeof v === 'boolean') return 'bool';
    if(typeof v === 'number') return 'float';
    if(typeof v === 'string') return 'string';
    return null;
  }
  pineTypeWordMatches(typeWord, v){
    if(typeWord == null) return false;
    if(typeWord === this.pineRuntimeTypeOf(v)) return true;
    if((typeWord === 'int' || typeWord === 'float') && typeof v === 'number') return true;
    if(typeWord === 'color' && typeof v === 'string') return true; // color is also a string in our engine / color도 우리 엔진에선 문자열
    return false;
  }
  // A function declared as method can exist as multiple functions across different types even with
  // the same name (an officially supported form of overloading in Pine). When there are multiple
  // candidates, one is picked by matching the receiver's type against each candidate's first
  // parameter type (methodOfType).
  //
  // The order in which this is decided matters. If the receiver has a "static type" (recvNode._st,
  // computed once by pine-types.js right after parsing and attached to the node), that is checked
  // first — for an overload that differs only by int/float or by color/string, the runtime values
  // are both just JS number / JS string respectively, so looking at the value alone can never
  // distinguish them, and the real Pine compiler also picks based on the compile-time type. Only
  // where a static type couldn't be determined (somewhere inference doesn't reach, or inside a
  // generic function body where multiple types flow into one node) does it fall back to the
  // runtime value like before — if nothing matches exactly or loosely, it goes with the first
  // candidate (the judgment being that a best-effort guess beats crashing).
  // method로 선언된 함수는 이름이 같아도 여러 타입에 걸쳐 여러 개 있을 수 있다(Pine이 정식으로
  // 지원하는 오버로딩). 후보가 여러 개면 리시버의 타입과 각 후보의 첫 매개변수 타입(methodOfType)을
  // 맞춰보고 고른다.
  //
  // 고르는 순서가 중요하다. 리시버의 "정적 타입"(recvNode._st, pine-types.js가 파싱 직후 한 번
  // 계산해 노드에 붙여둔 것)이 있으면 그걸 가장 먼저 본다 — int/float나 color/string으로만 갈리는
  // 오버로드는 런타임 값이 둘 다 JS number / JS string이라 값만 봐서는 절대 구분할 수 없고,
  // 실제 Pine 컴파일러도 컴파일타임 타입으로 고르기 때문이다. 정적 타입을 못 정한 자리(추론이
  // 닿지 않는 곳, 또는 한 노드에 여러 타입이 흘러드는 제네릭 함수 본문 안)에서만 예전처럼
  // 런타임 값으로 폴백한다 — 정확히도 느슨하게도 맞는 게 없으면 첫 번째 후보로 간다
  // (죽는 것보다는 최선의 추정이 낫다는 판단).
  resolveMethodOverload(name, receiverVal, recvNode){
    const candidates = this.userMethods.get(name);
    if(!candidates || !candidates.length) return null;
    if(candidates.length === 1) return candidates[0];
    if(recvNode){
      // The per-callsite result is cached on the node — this function is called again on every
      // bar, but an answer determined by a static type doesn't change from bar to bar.
      // 콜사이트별 결과는 노드에 캐시해둔다 — 이 함수는 매 봉 다시 불리는데, 정적 타입으로
      // 정해지는 답은 봉마다 바뀌지 않는다.
      const cached = recvNode._ovl;
      if(cached !== undefined && cached !== null) return cached;
      if(cached === undefined && recvNode._st){
        const byStatic = candidates.find(c => c.methodOfType === pineTypeBaseWord(recvNode._st));
        recvNode._ovl = byStatic || null; // if null, "couldn't be determined statically" — falls through to the runtime fallback below / null이면 "정적으로는 못 정함" — 아래 런타임 폴백으로 간다
        if(byStatic) return byStatic;
      } else if(cached === undefined){
        recvNode._ovl = null;
      }
    }
    const exact = candidates.find(c => c.methodOfType === this.pineRuntimeTypeOf(receiverVal));
    if(exact) return exact;
    const loose = candidates.find(c => this.pineTypeWordMatches(c.methodOfType, receiverVal));
    if(loose) return loose;
    return candidates[0];
  }
  // When evaluating plot()'s color= argument, it's not enough to look at just the value — this
  // also tracks "which branch of a ternary operator/iff() was taken". This lets different
  // conditions that happen to produce the same color (e.g. iff(condA, lime, iff(condB, lime, red)))
  // still be distinguished and recolored separately in the settings panel — real TradingView also
  // splits "color 0/1/2..." based on the branch position in the code, not the value. The return
  // value is the expression's "value", and the branch key computed alongside it is left in
  // this.lastColorKey. This used to return a freshly-created { value, key } object every time, but
  // since this function is called on every variable assignment (color or not), that object became
  // pure garbage at a rate of "bar count x assignment count". The parts of the branch key string
  // that are fixed per node are also cached on the node so they aren't rebuilt every bar.
  // plot()의 color= 인자를 평가할 때, 그냥 값만 보는 게 아니라 "삼항연산자/iff()의 어느 분기를
  // 탔는지"까지 같이 추적한다. 이래야 서로 다른 조건인데 우연히 같은 색을 쓰는 경우에도(예:
  // iff(condA, lime, iff(condB, lime, red))) 설정창에서 따로따로 구분해서 색을 바꿀 수 있다 —
  // 실제 TradingView도 값이 아니라 코드상의 분기 위치를 기준으로 "칼라 0/1/2..."를 나눈다.
  // 반환값은 식의 "값"이고, 함께 계산한 분기 키는 this.lastColorKey에 남긴다. 예전에는 매번
  // { value, key } 객체를 새로 만들어 돌려줬는데, 이 함수는 모든 변수 대입마다(색이든 아니든)
  // 불리기 때문에 그 객체가 "봉 수 × 대입 횟수"만큼 그대로 쓰레기가 됐다. 분기 키 문자열도
  // 노드마다 고정인 부분은 노드에 캐시해서 매 봉 다시 만들지 않는다.
  evalColorExpr(node){
    if(node.type === 'Ternary'){
      const cond = pineTruthy(this.evalExpr(node.cond));
      const value = this.evalColorExpr(cond ? node.then : node.else);
      this.lastColorKey = (cond ? (node._kT || (node._kT = node.id + ':T|')) : (node._kF || (node._kF = node.id + ':F|'))) + this.lastColorKey;
      return value;
    }
    if(node.type === 'Call' && node.callee.type === 'Ident' && node.callee.name === 'iff' && !this.userFuncs.has('iff')){
      const rawArgs = node.args;
      if(rawArgs.length >= 3 && !rawArgs[0].named && !rawArgs[1].named && !rawArgs[2].named){
        const cond = pineTruthy(this.evalExpr(rawArgs[0].value));
        const value = this.evalColorExpr(cond ? rawArgs[1].value : rawArgs[2].value);
        this.lastColorKey = (cond ? (node._kT || (node._kT = node.id + ':T|')) : (node._kF || (node._kF = node.id + ':F|'))) + this.lastColorKey;
        return value;
      }
    }
    if(node.type === 'Ident'){
      const value = this.evalExpr(node);
      const stored = this.branchKeyByVarName.get(node.name);
      this.lastColorKey = stored !== undefined ? stored : (node._kLeaf || (node._kLeaf = 'leaf$' + node.name));
      return value;
    }
    const value = this.evalExpr(node);
    this.lastColorKey = node._kLeaf || (node._kLeaf = 'leaf' + (node.id != null ? node.id : node.line));
    return value;
  }
  evalCall(node){
    if(node.callee.type === 'Ident' && node.callee.name === 'plot' && !this.userFuncs.has('plot')){
      return this.evalPlotCallWithColorTracking(node);
    }
    // request.security()'s expression argument must not be eagerly evaluated here like the other
    // arguments are — it needs to be evaluated separately (possibly multiple times) later, in a
    // higher-timeframe context, so the AST has to be carried through as-is.
    // request.security()의 expression 인자는 다른 인자들처럼 여기서 즉시 평가하면 안 된다 —
    // 상위 타임프레임 컨텍스트로 나중에 따로(여러 번) 평가해야 해서 AST를 그대로 들고 가야 한다.
    if(node.callee.type === 'Member' && node.callee.prop === 'security' && node.callee.obj.type === 'Ident' && node.callee.obj.name === 'request' && !this.userFuncs.has('security')){
      return this.evalRequestSecurity(node);
    }
    // request.security_lower_tf() also must not have its expression eagerly evaluated, for the
    // same reason (evaluated later in the higher context). The lower-tf bar data it needs has
    // already been filled into this.lowerTfCache before execution by runPineScript
    // (pinePrefetchLowerTf), so this only does a synchronous lookup.
    // request.security_lower_tf()도 같은 이유(상위 컨텍스트에서 나중에 평가)로 expression을
    // 즉시 평가하면 안 된다. 필요한 lower-tf 봉 데이터는 runPineScript가 실행 전에 이미
    // this.lowerTfCache에 채워뒀으므로(pinePrefetchLowerTf), 여기서는 동기로 조회만 한다.
    if(node.callee.type === 'Member' && node.callee.prop === 'security_lower_tf' && node.callee.obj.type === 'Ident' && node.callee.obj.name === 'request' && !this.userFuncs.has('security_lower_tf')){
      return this.evalRequestSecurityLowerTf(node);
    }
    // v1-v3 Pine had no request. namespace, so security(tickerid, resolution, expression) was
    // called directly as a bare name — the argument order is the same as request.security, so it's
    // reused as-is.
    // v1~v3 Pine은 request. 네임스페이스가 없어서 security(tickerid, resolution, expression)를
    // 맨 이름으로 그대로 호출했다 — 인자 순서가 request.security와 같으므로 그대로 재사용한다.
    if(node.callee.type === 'Ident' && node.callee.name === 'security' && !this.userFuncs.has('security')){
      return this.evalRequestSecurity(node);
    }
    const posArgs = []; const namedArgs = {};
    for(const a of node.args){
      // A named argument literally called '__proto__' would, if assigned naively, change this
      // object's prototype (a script can name its arguments freely, so this is a value that can
      // actually be passed in). Ignoring one argument is better than every subsequent
      // hasOwnProperty lookup getting silently thrown off.
      // '__proto__'라는 이름의 named 인자는 그냥 대입하면 이 객체의 프로토타입이 바뀌어버린다
      // (스크립트가 인자 이름을 마음대로 정할 수 있으므로 실제로 넣을 수 있는 값). 인자 하나
      // 무시하는 것이 이후 hasOwnProperty 조회가 통째로 어긋나는 것보다 낫다.
      if(a.named){ if(a.name !== '__proto__') namedArgs[a.name] = this.evalExpr(a.value); else this.evalExpr(a.value); }
      else posArgs.push(this.evalExpr(a.value));
    }
    if(node.callee.type === 'Ident'){
      const name = node.callee.name;
      // A method can also be called directly as f(x, ...) without the dot — if it has overloads
      // here too, the right one is picked using the runtime type of the first argument (x).
      // method는 점(.) 없이 f(x, ...) 형태로도 그대로 호출할 수 있다 — 이때도 오버로드가
      // 있으면 첫 인자(x)의 런타임 타입으로 알맞은 걸 고른다.
      if(this.userMethods.has(name)){
        // In a bare-name call, the receiver position is the first positional argument — that
        // expression's node has the static type attached.
        // 맨 이름 호출에서 리시버 자리는 첫 위치 인자다 — 그 식의 노드에 정적 타입이 붙어 있다.
        const firstArg = node.args.find(a => !a.named);
        const fn = this.resolveMethodOverload(name, posArgs.length ? posArgs[0] : undefined, firstArg ? firstArg.value : null);
        if(fn) return this.callUserFunction(fn, posArgs, namedArgs, node.line, node.id);
      }
      if(this.userFuncs.has(name)) return this.callUserFunction(this.userFuncs.get(name), posArgs, namedArgs, node.line, node.id);
      if(TOP_LEVEL_BUILTINS[name]) return TOP_LEVEL_BUILTINS[name](this, posArgs, namedArgs, node);
      throw new PineRuntimeError(pineMsg('정의되지 않은 함수입니다: ' + name, 'Undefined function: ' + name), node.line);
    }
    if(node.callee.type === 'Member'){
      const path = this.staticMemberPath(node.callee);
      if(path && PINE_BUILTIN_NS[path]) return PINE_BUILTIN_NS[path](this, posArgs, namedArgs, node);
      // User-defined type constructor: TypeName.new(...)
      // 사용자 정의 타입 생성자: TypeName.new(...)
      if(node.callee.prop === 'new' && node.callee.obj.type === 'Ident' && this.typeDecls.has(node.callee.obj.name)){
        return this.instantiateStruct(node.callee.obj.name, posArgs, namedArgs, node.line);
      }
      if(path && NAMESPACE_ROOTS.has(path.split('.')[0])){
        throw new PineRuntimeError(pineMsg('지원하지 않는 함수입니다: ' + path + '()', 'Unsupported function: ' + path + '()'), node.line);
      }
      const objVal = this.evalExpr(node.callee.obj);
      const method = node.callee.prop;
      // User-defined method (dot-call) dispatch — among functions declared with the 'method'
      // keyword, this picks the one matching the receiver's actual runtime type (Pine officially
      // supports defining the same name across multiple types). Built-in array/line/box/label
      // methods take priority if they already exist; if not (e.g. a script adds its own method to
      // an array), execution falls through to here.
      // 사용자 정의 method(점 호출) 디스패치 — 'method' 키워드로 선언된 함수 중 리시버의 실제
      // 런타임 타입에 맞는 걸 고른다(Pine은 같은 이름을 여러 타입에 걸쳐 정의하는 걸 정식으로
      // 지원함). 내장 array/line/box/label 메서드가 이미 있으면 그게 먼저지만, 없으면(예: 스크립트가
      // 배열에 자기만의 method를 얹은 경우) 이쪽으로 넘어온다.
      if(objVal instanceof PineArray){
        const fn = ARRAY_METHOD_BUILTINS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      } else if(objVal instanceof PineLine){
        const fn = LINE_METHODS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      } else if(objVal instanceof PineBox){
        const fn = BOX_METHODS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      } else if(objVal instanceof PineLabel){
        const fn = LABEL_METHODS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      } else if(objVal instanceof PineLinefill){
        const fn = LINEFILL_METHODS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      } else if(objVal instanceof PineTable){
        const fn = TABLE_METHODS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      } else if(objVal instanceof PineMap){
        const fn = MAP_METHODS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      } else if(objVal instanceof PineMatrix){
        const fn = MATRIX_METHODS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      }
      const userFn = this.resolveMethodOverload(method, objVal, node.callee.obj);
      if(userFn){ posArgs.unshift(objVal); return this.callUserFunction(userFn, posArgs, namedArgs, node.line, node.id); }
      // Instead of writing out the same sentence 5 times for each receiver type, only the type name is interpolated in (the wording stays the same).
      // 리시버 타입별로 똑같은 문장을 5벌 늘어놓는 대신 타입 이름만 끼워 넣는다(문구는 그대로).
      const typeWord = this.pineRuntimeTypeOf(objVal);
      const known = typeWord === 'array' || typeWord === 'line' || typeWord === 'box' || typeWord === 'label' || typeWord === 'table' || typeWord === 'map' || typeWord === 'matrix';
      throw new PineRuntimeError(
        known
          ? pineMsg((typeWord === 'array' ? '배열' : typeWord) + '에 지원하지 않는 메서드입니다: .' + method + '()', 'Unsupported ' + typeWord + ' method: .' + method + '()')
          : pineMsg('지원하지 않는 메서드 호출입니다: .' + method + '()', 'Unsupported method call: .' + method + '()'),
        node.line);
    }
    throw new PineRuntimeError(pineMsg('호출할 수 없는 식입니다', 'This expression cannot be called'), node.line);
  }
  // request.security(symbol, timeframe, expression, gaps, lookahead, ...) — symbol is always
  // treated as "this current symbol" (loading a different symbol's data is out of scope — this
  // app only ever loads a single symbol at a time to begin with). gaps and the other remaining
  // arguments are evaluated only to discard the result. expression must never be eagerly evaluated
  // — it's precomputed once per callsite, across all bars, in the higher-timeframe context
  // (buildSecuritySeries), and only looked up per bar afterward.
  // request.security(symbol, timeframe, expression, gaps, lookahead, ...) — symbol은 항상
  // "지금 이 심볼"로 취급한다(다른 심볼 데이터를 새로 불러오는 건 지원 범위 밖 — 이 앱은
  // 애초에 한 번에 심볼 하나만 로드함). gaps 등 나머지 인자는 평가만 하고 버린다.
  // expression은 절대 즉시 평가하면 안 된다 — 상위 타임프레임 컨텍스트로 콜사이트당 한 번,
  // 전체 봉에 대해 미리 계산해두고(buildSecuritySeries) 그 결과를 매 bar 조회만 한다.
  evalRequestSecurity(node){
    const rawArgs = node.args;
    let timeframeVal = '', exprNode = null, lookaheadVal = null, symbolVal = null, posIdx = 0;
    for(const a of rawArgs){
      if(a.named){
        if(a.name === 'timeframe') timeframeVal = this.evalExpr(a.value);
        else if(a.name === 'expression') exprNode = a.value;
        else if(a.name === 'lookahead') lookaheadVal = this.evalExpr(a.value);
        else if(a.name === 'symbol' || a.name === 'ticker') symbolVal = this.evalExpr(a.value);
        else this.evalExpr(a.value);
      } else {
        if(posIdx === 0) symbolVal = this.evalExpr(a.value);
        else if(posIdx === 1) timeframeVal = this.evalExpr(a.value);
        else if(posIdx === 2) exprNode = a.value;
        else if(posIdx === 4) lookaheadVal = this.evalExpr(a.value);
        else this.evalExpr(a.value);
        posIdx++;
      }
    }
    if(exprNode == null) throw new PineRuntimeError(pineMsg('request.security()에는 expression 인자가 필요합니다', 'request.security() requires an expression argument'), node.line);
    // If the symbol is wrapped with ticker.heikinashi(), all the evaluation below happens on top
    // of "heikin-ashi bars". (Scripts like the UT Bot family commonly use
    // `security(heikinashi(tickerid), timeframe.period, close)` to use the heikin-ashi close as
    // the source instead of the raw one.)
    // 심볼이 ticker.heikinashi()로 감싸져 있으면, 아래 평가를 전부 "하이킨아시 봉" 위에서 한다.
    // (UT Bot 계열처럼 `security(heikinashi(tickerid), timeframe.period, close)`로 원본 대신
    //  하이킨아시 종가를 소스로 쓰는 스크립트가 흔하다.)
    if(typeof symbolVal === 'string' && symbolVal.startsWith(PINE_HA_TICKER_PREFIX)){
      const st = getState(this, node);
      if(!st.haContext) st.haContext = this.buildHeikinAshiContext();
      const saved = this.captureSeriesContext();
      Object.assign(this, st.haContext);
      try{ return this.evalSecurityWithCurrentSeries(node, exprNode, timeframeVal, lookaheadVal); }
      finally{ Object.assign(this, saved); }
    }
    return this.evalSecurityWithCurrentSeries(node, exprNode, timeframeVal, lookaheadVal);
  }
  // The body that behaves identically regardless of which time series (raw or heikin-ashi) is currently in place.
  // 원본/하이킨아시 어느 시계열이 깔려 있든 동일하게 동작하는 본체.
  evalSecurityWithCurrentSeries(node, exprNode, timeframeVal, lookaheadVal){
    const tf = String(timeframeVal || '');
    // If timeframe is an empty string it means "same resolution as the current chart", so it isn't
    // actually changing the timeframe at all — in that case expression can just be evaluated
    // normally, right now, on this actual bar (curBar). Taking the buildSecuritySeries path below
    // (reconstructed as a K-bar local window) has a problem when referencing a script's own
    // variable that isn't a built-in series like close/open (e.g. a value precomputed in an outer
    // scope like `out = sma(close,len)`) — curBar gets replaced with a fixed constant index inside
    // the local window, so it ends up reading the value of the wrong bar (usually one that hasn't
    // been computed yet, so it's na). In particular, if this call is first triggered on the
    // script's very first executed bar, it ends up referencing values of future bars that haven't
    // executed yet, so the entire range becomes na and nothing gets plotted. When it's the same
    // timeframe, that reconstruction is unnecessary anyway, so it's skipped entirely and evaluated
    // right now instead, which avoids this problem at the source.
    // timeframe이 빈 문자열이면 "현재 차트와 같은 해상도"라는 뜻이라 실제로는 타임프레임을 전혀
    // 바꾸는 게 아니다 — 이 경우 expression을 지금 이 실제 봉(curBar)에서 평소처럼 그냥 바로
    // 평가하면 된다. 아래 buildSecuritySeries(K-바 로컬 윈도우로 재구성) 경로를 타면, close/open
    // 같은 내장 시계열이 아닌 스크립트 자체 변수(예: `out = sma(close,len)`처럼 바깥 스코프에서
    // 미리 계산해둔 값)를 참조할 때 curBar가 로컬 윈도우 안의 고정된 상수 인덱스로 치환돼서
    // 엉뚱한(대개 아직 계산되지 않아 na인) 봉의 값을 읽어버리는 문제가 있다 — 특히 이 호출이
    // 스크립트 실행 첫 봉에서 처음 트리거되면, 아직 실행되지 않은 미래 봉들의 값을 참조하게 되어
    // 전 구간이 na가 되고 아무것도 플롯되지 않는다. 같은 타임프레임일 땐 그 재구성 자체가
    // 불필요하므로 완전히 건너뛰고 지금 바로 평가해서 이 문제를 원천적으로 피한다.
    if(tf === ''){
      const v = this.evalExpr(exprNode);
      return v === undefined ? null : v;
    }
    const lookaheadOn = typeof lookaheadVal === 'string' && lookaheadVal.indexOf('lookahead_on') !== -1;
    const s = getState(this, node);
    if(!s.series) s.series = this.buildSecuritySeries(tf, exprNode, lookaheadOn);
    const v = s.series[this.curBar];
    return v === undefined ? null : v;
  }
  // request.security_lower_tf(symbol, timeframe, expression, ignore_invalid_symbol) — the opposite
  // direction from security() (bars finer than the current chart), so it can't just aggregate
  // existing bars; it needs data that doesn't already exist. That data is fetched asynchronously by
  // runPineScript before script execution and filled into this.lowerTfCache (timeframe string ->
  // aggregated 1-minute bar array), so this only needs to do a synchronous lookup on that cache.
  // Like security(), the symbol argument is always treated as "this current symbol" (evaluated, but the value is discarded).
  // request.security_lower_tf(symbol, timeframe, expression, ignore_invalid_symbol) — security()와
  // 반대 방향(현재 차트보다 잘게 쪼갠 봉)이라 이미 있는 봉을 합치기만 해선 안 되고, 원래
  // 없는 데이터가 필요하다. 그 데이터는 runPineScript가 스크립트 실행 전에 미리 비동기로
  // 받아서 this.lowerTfCache(timeframe 문자열 -> 집계된 1분봉 배열)에 채워두므로, 여기서는
  // 그 캐시를 동기로 조회만 하면 된다. symbol 인자는 security()와 마찬가지로 항상 "지금 이
  // 심볼"로 취급(평가는 하되 값은 버림).
  evalRequestSecurityLowerTf(node){
    const rawArgs = node.args;
    let timeframeVal = '', exprNode = null, posIdx = 0;
    for(const a of rawArgs){
      if(a.named){
        if(a.name === 'timeframe') timeframeVal = this.evalExpr(a.value);
        else if(a.name === 'expression') exprNode = a.value;
        else if(a.name !== 'symbol' && a.name !== 'ticker') this.evalExpr(a.value);
      } else {
        if(posIdx === 0) this.evalExpr(a.value); // symbol — evaluated only to be discarded / symbol — 평가만 하고 버림
        else if(posIdx === 1) timeframeVal = this.evalExpr(a.value);
        else if(posIdx === 2) exprNode = a.value;
        else this.evalExpr(a.value);
        posIdx++;
      }
    }
    if(exprNode == null) throw new PineRuntimeError(pineMsg('request.security_lower_tf()에는 expression 인자가 필요합니다', 'request.security_lower_tf() requires an expression argument'), node.line);
    const tf = String(timeframeVal || '');
    const s = getState(this, node);
    if(!s.arr) s.arr = this.buildLowerTfArraySeries(tf, exprNode);
    const v = s.arr[this.curBar];
    if(v !== undefined && v !== null) return v;
    // If it's a tuple form ([high, low, close, volume]), an empty array per element must be
    // returned or destructuring would break.
    // 튜플 형태([high, low, close, volume])면 원소 개수만큼 빈 배열을 돌려줘야 구조 분해가 깨지지 않는다.
    const width = exprNode.type === 'ArrayLiteral' ? exprNode.items.length : 0;
    return width ? Array.from({ length: width }, () => new PineArray([], 'float')) : new PineArray([], 'float');
  }
  // Gets the bars for timeframe tf from lowerTfCache. If the host put a key in for exactly that tf,
  // it's used as-is; otherwise, among the other timeframes present in the cache, one that divides
  // tf evenly (i.e. is a divisor of tf) is found and synthesized on the spot — for example, if the
  // host only puts "1S" (1-second bars) into lowerTfCache, multiples of it like "5S"/"15S"/"1"
  // (1 minute)/"1D" etc. are all automatically built here. If there are multiple divisor
  // candidates, the coarsest one (= requiring the least synthesis work) is chosen — accuracy is
  // identical no matter which divisor is picked (since it divides evenly, boundaries always line
  // up exactly), and only the amount of work changes. This engine has no idea what atomic
  // resolution the host will supply data at (1 second? 1 minute? something in between?) — so
  // fine-grained timeframes like seconds are supported without any special-casing.
  // lowerTfCache에서 timeframe tf의 봉을 구한다. 호스트가 정확히 그 tf로 키를 넣어뒀으면
  // 그대로 쓰고, 없으면 캐시에 들어있는 다른 timeframe 중 tf를 정확히 나누어떨어지게 하는
  // (=tf의 약수인) 것을 찾아 즉석에서 합성한다 — 예를 들어 호스트가 "1S"(1초봉) 하나만
  // lowerTfCache에 넣어두면 "5S"/"15S"/"1"(1분)/"1D" 등 그 배수는 전부 여기서 자동으로
  // 만들어진다. 약수 후보가 여럿이면 가장 굵은(=합성량이 가장 적은) 것을 고른다 — 정확도는
  // 어느 약수를 골라도 동일하고(정확히 나누어떨어지므로 경계가 항상 맞음) 일만 줄어든다.
  // 호스트가 어떤 원자 해상도로 데이터를 줄지(1초? 1분? 그 사이 아무거나?) 이 엔진은 전혀
  // 모른다 — 그래서 초 단위처럼 세밀한 타임프레임도 별도 특수 취급 없이 그냥 지원된다.
  resolveLowerTfBars(tf){
    if(!this.lowerTfCache) return null;
    const direct = this.lowerTfCache.get(tf);
    if(direct && direct.length) return direct;
    const targetSecs = pineTfSeconds(tf);
    if(!(targetSecs > 0)) return null;
    let best = null, bestSecs = 0;
    for(const [srcTf, srcBars] of this.lowerTfCache){
      if(!srcBars || !srcBars.length) continue;
      const srcSecs = pineTfSeconds(srcTf);
      if(!(srcSecs > 0) || srcSecs > targetSecs || targetSecs % srcSecs !== 0) continue;
      if(srcSecs > bestSecs){ best = srcBars; bestSecs = srcSecs; }
    }
    if(!best) return null;
    return bestSecs === targetSecs ? best : pineAggregateCandles(best, targetSecs * 1000);
  }
  // Splits lowerTfCache[tf] (chronologically ascending aggregated bars) into buckets per this main
  // bar array's ranges ([time[i], time_close[i])), and evaluates expression by walking the entire
  // intrabar history in one pass (not reset at every main-bar boundary — this is needed so
  // stateful functions like ta.* naturally carry across intrabar boundaries, matching real Pine's
  // lower-tf execution model). If there's no data in the cache (timeframe wasn't a literal string,
  // or the prefetch failed/was skipped), an empty array is returned for every bar. If expression is
  // a tuple ([high, low, close, volume]), Pine returns not one array but "as many arrays as there
  // are elements" ([h, l, c, v] = request.security_lower_tf(...) destructuring). So in that case,
  // each bar holds a JS array of PineArrays instead of a single PineArray — execTupleDecl unpacks
  // and assigns that as-is.
  // lowerTfCache[tf](시간 오름차순 집계 봉)를 이 메인 봉 배열의 구간([time[i], time_close[i]))별로
  // 나누고, expression은 인트라바 히스토리 전체를 한 번에 순회하며 평가한다(메인 봉 경계마다
  // 새로 초기화하지 않음 — 이렇게 해야 ta.* 같은 상태 유지 함수가 실제 Pine의 lower-tf 실행
  // 모델처럼 인트라바 경계를 넘어 자연스럽게 이어진다). 캐시에 데이터가 없으면(timeframe이
  // 리터럴 문자열이 아니었거나, 프리페치가 실패/스킵됐거나) 모든 봉에 빈 배열을 돌려준다.
  // expression이 튜플([high, low, close, volume])이면 Pine은 배열 하나가 아니라 "원소 개수만큼의
  // 배열들"을 돌려준다([h, l, c, v] = request.security_lower_tf(...) 구조 분해). 그래서 그럴 땐 봉마다
  // PineArray 하나 대신 PineArray들의 JS 배열을 담는다 — execTupleDecl이 그걸 그대로 풀어 대입한다.
  buildLowerTfArraySeries(tf, exprNode){
    const n = this.n;
    const result = new Array(n);
    // Even if it's not a tuple literal, a user function can still return a tuple, so this is
    // determined again from the actual evaluation result below.
    // litWidth here is only used for the case where there's no data at all to even evaluate.
    // 튜플 리터럴이 아니어도 사용자 함수가 튜플을 돌려줄 수 있어서 실제 평가 결과로 한 번 더 판정한다(아래).
    // 여기 litWidth는 데이터가 아예 없어 평가조차 못 하는 경우에만 쓴다.
    const litWidth = exprNode.type === 'ArrayLiteral' ? exprNode.items.length : 0;
    const emptyResult = () => litWidth ? Array.from({ length: litWidth }, () => new PineArray([], 'float')) : new PineArray([], 'float');
    const cache = this.resolveLowerTfBars(tf);
    if(!cache || !cache.length){
      for(let i = 0; i < n; i++) result[i] = emptyResult();
      return result;
    }
    // Only records, as a range (from, count), which intrabar indices each main bar spans — used to
    // create a separate index array per main bar (n empty arrays) and then move that into a map,
    // which produced three arrays per bar (empty result array + index array + map result).
    // 각 메인 봉이 인트라바 몇 번째부터 몇 번째까지를 담는지만 구간(from, count)으로 기록한다 —
    // 예전엔 메인 봉마다 인덱스 배열을 따로 만들고(빈 배열 n개) 그걸 다시 map으로 옮겨서,
    // 봉당 배열이 세 벌씩(빈 결과 배열 + 인덱스 배열 + map 결과) 만들어졌다.
    const cn = cache.length;
    const mainTime = this.timeArr, mainClose = this.timeCloseArr;
    const from = new Array(n).fill(-1), count = new Array(n).fill(0);
    let bi = 0;
    for(let k = 0; k < cn; k++){
      const t = cache[k].time;
      if(t < mainTime[0]) continue;
      while(bi < n - 1 && t >= mainClose[bi]) bi++;
      if(t >= mainTime[bi]){ if(from[bi] < 0) from[bi] = k; count[bi]++; }
    }
    const save = {
      openArr: this.openArr, highArr: this.highArr, lowArr: this.lowArr, closeArr: this.closeArr,
      volArr: this.volArr, timeArr: this.timeArr, timeCloseArr: this.timeCloseArr,
      hl2Arr: this.hl2Arr, hlc3Arr: this.hlc3Arr, ohlc4Arr: this.ohlc4Arr, hlcc4Arr: this.hlcc4Arr,
      curBar: this.curBar, n: this.n,
    };
    const lo = new Array(cn), lh = new Array(cn), ll = new Array(cn), lc = new Array(cn), lv = new Array(cn), lt = new Array(cn);
    const hl2 = new Array(cn), hlc3 = new Array(cn), ohlc4 = new Array(cn), hlcc4 = new Array(cn);
    for(let k = 0; k < cn; k++){
      const b = cache[k];
      const o = b.open, h = b.high, l = b.low, c = b.close;
      lo[k] = o; lh[k] = h; ll[k] = l; lc[k] = c; lv[k] = b.volume || 0; lt[k] = b.time;
      hl2[k] = (h + l) / 2;
      hlc3[k] = (h + l + c) / 3;
      ohlc4[k] = (o + h + l + c) / 4;
      hlcc4[k] = (h + l + c + c) / 4; // used to reuse ohlc4's value directly here, giving a wrong hlcc4 / 예전엔 ohlc4를 그대로 재사용해서 hlcc4 값이 틀렸다
    }
    this.openArr = lo; this.highArr = lh; this.lowArr = ll; this.closeArr = lc;
    this.volArr = lv; this.timeArr = lt; this.timeCloseArr = lt;
    this.hl2Arr = hl2; this.hlc3Arr = hlc3; this.ohlc4Arr = ohlc4; this.hlcc4Arr = hlcc4;
    this.n = cn;
    const values = new Array(cn);
    try{
      for(let k = 0; k < cn; k++){ this.curBar = k; values[k] = this.evalExpr(exprNode); }
    } finally {
      Object.assign(this, save);
    }
    // If it's a tuple, values[k] is a JS array of elements, so it's split by column into multiple arrays.
    // 튜플이면 values[k]가 원소들의 JS 배열이라 열(column)별로 갈라서 배열을 여러 개 만든다.
    let width = 0;
    for(let k = 0; k < cn; k++){ if(Array.isArray(values[k]) && values[k].length > width) width = values[k].length; }
    if(width){
      for(let i = 0; i < n; i++){
        if(from[i] < 0){ result[i] = Array.from({ length: width }, () => new PineArray([], 'float')); continue; }
        const cols = new Array(width);
        for(let col = 0; col < width; col++) cols[col] = new Array(count[i]);
        for(let j = 0; j < count[i]; j++){
          const row = values[from[i] + j];
          for(let col = 0; col < width; col++) cols[col][j] = (Array.isArray(row) && row[col] !== undefined) ? row[col] : null;
        }
        result[i] = cols.map(items => new PineArray(items, 'float'));
      }
      return result;
    }
    for(let i = 0; i < n; i++) result[i] = new PineArray(from[i] < 0 ? [] : values.slice(from[i], from[i] + count[i]), 'float');
    return result;
  }
  // Groups the main chart bars into higher-timeframe buckets — since all we have is data at the
  // current chart resolution, this can't split into anything finer (a lower-timeframe request) and
  // can only accurately build the same timeframe or coarser. Same pattern as
  // request.security_lower_tf()'s buildLowerTfArraySeries(): the whole synthesized HTF bar set is
  // turned into a contiguous array and the series is swapped out wholesale, and expression is
  // evaluated exactly once per bucket (not once per main bar), advancing curBar normally starting
  // from 0 — used to create a fresh local window of the most recent 20 bars per main bar and
  // re-evaluate with curBar pinned to the last slot of that window, but that caused stateful
  // functions using curBar as an index, like ta.sma/ta.rsi, to keep overwriting only that pinned
  // slot so history never accumulated, and accumulator-style ones (ta.ema, etc.) got distorted by
  // eating the same value repeatedly for every main bar inside the same HTF bar span. This current
  // approach advances state exactly once only when an HTF bar genuinely progresses, just like real
  // Pine, so that problem doesn't happen, and there's also no history-length cap anymore (the old K=20).
  // A pairing used to entirely save/restore where the built-in series (close/open/high/low/hl2/...)
  // point. volArr/timeArr aren't switched for heikin-ashi (volume and time stay as the original), so
  // they're not included here.
  // 메인 차트 봉들을 상위 타임프레임 버킷으로 묶는다 — 우리가 가진 건 현재 차트 해상도의
  // 데이터뿐이라 그보다 더 잘게 쪼개는(하위 타임프레임 요청) 건 못 하고, 같거나 더 굵은
  // 타임프레임만 정확하게 만들 수 있다. request.security_lower_tf()의 buildLowerTfArraySeries()와
  // 같은 패턴: 합성된 HTF 봉 전체를 연속 배열로 만들어 series를 통째로 바꿔치고, expression을
  // 버킷 개수만큼(메인 봉 개수만큼이 아니라) curBar를 0부터 정상적으로 증가시키며 딱 한 번씩만
  // 평가한다 — 예전엔 메인 봉마다 최근 20개짜리 로컬 창을 새로 만들고 curBar를 그 창의 마지막
  // 칸에 고정해서 재평가했는데, ta.sma/ta.rsi 등 curBar를 인덱스로 쓰는 상태 함수들이 그 고정된
  // 칸만 계속 덮어써서 히스토리가 전혀 쌓이지 않고, 누산기형(ta.ema 등)은 같은 HTF 봉 구간 안의
  // 메인 봉마다 같은 값을 중복으로 먹어 왜곡됐다. 지금 이 방식은 실제 Pine처럼 HTF 봉이 진짜로
  // 하나 진행될 때만 상태를 한 번 전진시키므로 그 문제가 없고, 히스토리 길이 제한(예전 K=20)도 없다.
  // 내장 시계열(close/open/high/low/hl2/...)이 어디를 가리키는지 통째로 저장/복원하기 위한 짝.
  // volArr/timeArr은 하이킨아시로 바뀌지 않으므로(거래량과 시각은 원본 그대로) 여기 없다.
  captureSeriesContext(){
    return {
      bars: this.bars, openArr: this.openArr, highArr: this.highArr, lowArr: this.lowArr, closeArr: this.closeArr,
      hl2Arr: this.hl2Arr, hlc3Arr: this.hlc3Arr, ohlc4Arr: this.ohlc4Arr, hlcc4Arr: this.hlcc4Arr,
    };
  }
  // A bundle of series switched over to heikin-ashi bars. Exactly by definition:
  //   haClose = (O+H+L+C)/4, haOpen = previous (haOpen+haClose)/2, haHigh/Low = max/min of the raw and ha values.
  // Since buildSecuritySeries() reads this.bars directly when building higher-timeframe buckets, bars is built here too.
  // 하이킨아시 봉으로 바꿔 낀 시계열 묶음. 정의 그대로:
  //   haClose = (O+H+L+C)/4, haOpen = 직전 (haOpen+haClose)/2, haHigh/Low = 원본과 ha 값들의 최대/최소.
  // buildSecuritySeries()가 상위 타임프레임 버킷을 만들 때 this.bars를 직접 읽으므로 bars도 같이 만든다.
  buildHeikinAshiContext(){
    const n = this.n;
    const open = new Array(n), high = new Array(n), low = new Array(n), close = new Array(n);
    const hl2 = new Array(n), hlc3 = new Array(n), ohlc4 = new Array(n), hlcc4 = new Array(n), haBars = new Array(n);
    let prevOpen = null, prevClose = null;
    for(let i = 0; i < n; i++){
      const o = this.openArr[i], h = this.highArr[i], l = this.lowArr[i], c = this.closeArr[i];
      const haClose = (o + h + l + c) / 4;
      const haOpen = prevOpen == null ? (o + c) / 2 : (prevOpen + prevClose) / 2;
      const haHigh = Math.max(h, haOpen, haClose), haLow = Math.min(l, haOpen, haClose);
      open[i] = haOpen; close[i] = haClose; high[i] = haHigh; low[i] = haLow;
      hl2[i] = (haHigh + haLow) / 2;
      hlc3[i] = (haHigh + haLow + haClose) / 3;
      ohlc4[i] = (haOpen + haHigh + haLow + haClose) / 4;
      hlcc4[i] = (haHigh + haLow + haClose + haClose) / 4;
      haBars[i] = { ...this.bars[i], open: haOpen, high: haHigh, low: haLow, close: haClose };
      prevOpen = haOpen; prevClose = haClose;
    }
    return {
      bars: haBars,
      openArr: open, highArr: high, lowArr: low, closeArr: close,
      hl2Arr: hl2, hlc3Arr: hlc3, ohlc4Arr: ohlc4, hlcc4Arr: hlcc4,
    };
  }
  buildSecuritySeries(tf, exprNode, lookaheadOn){
    const n = this.n, bars = this.bars;
    // If the current chart interval isn't a divisor of tf (e.g. requesting "5" on a 3-minute chart),
    // the fallback path below that simply groups main bars would misassign a bar straddling a
    // boundary entirely to the wrong bucket. In that case, if lowerTfCache already has a series
    // pinePrefetchLowerTf accurately synthesized ahead of time based on 1-minute bars (the same
    // source as request.security_lower_tf()), that's used directly — its field shape is identical
    // (open/high/low/close/volume/time), so it can be assigned straight into closedBuckets with no
    // conversion.
    // 현재 차트 간격이 tf의 약수가 아니면(예: 3분봉 차트에서 "5" 요청) 메인 봉을 그대로 묶는 아래
    // 폴백 경로는 경계에 걸친 봉을 통째로 한쪽 버킷에 잘못 배정한다. pinePrefetchLowerTf가 이 경우
    // 미리 1분봉 기준으로 정확히 합성해둔 시리즈(request.security_lower_tf()와 같은 소스)가
    // lowerTfCache에 있으면 그걸 그대로 쓴다 — 필드 모양이 동일해서(open/high/low/close/volume/time)
    // 변환 없이 closedBuckets로 바로 대입 가능하다.
    const preAgg = tf ? this.resolveLowerTfBars(tf) : null;
    const bucketOfBar = new Array(n);
    let closedBuckets;
    if(preAgg && preAgg.length){
      closedBuckets = preAgg;
      const bucketIdToIdx = new Map();
      for(let k = 0; k < preAgg.length; k++) bucketIdToIdx.set(pineTfBucket(preAgg[k].time, tf), k);
      let lastIdx = -1;
      for(let i = 0; i < n; i++){
        const bId = pineTfBucket(bars[i].time, tf);
        if(bucketIdToIdx.has(bId)) lastIdx = bucketIdToIdx.get(bId);
        bucketOfBar[i] = lastIdx; // if that span has no 1-minute data at all (rare), the previous bucket just carries forward / 그 구간에 1분봉 데이터가 아예 없으면(드묾) 직전 버킷을 그대로 이어간다
      }
    } else {
      closedBuckets = [];
      for(let i = 0; i < n; i++){
        const b = bars[i];
        const bId = tf ? pineTfBucket(b.time, tf) : i;
        let cur = closedBuckets.length ? closedBuckets[closedBuckets.length - 1] : null;
        if(!cur || cur._bucketId !== bId){
          cur = { _bucketId: bId, open: b.open, high: b.high, low: b.low, close: b.close, volume: (b.volume || 0), time: b.time };
          closedBuckets.push(cur);
        } else {
          if(b.high > cur.high) cur.high = b.high;
          if(b.low < cur.low) cur.low = b.low;
          cur.close = b.close;
          cur.volume += (b.volume || 0);
        }
        bucketOfBar[i] = closedBuckets.length - 1;
      }
    }

    const bn = closedBuckets.length;
    const result = new Array(n).fill(null);
    const save = {
      openArr: this.openArr, highArr: this.highArr, lowArr: this.lowArr, closeArr: this.closeArr,
      volArr: this.volArr, timeArr: this.timeArr, timeCloseArr: this.timeCloseArr,
      hl2Arr: this.hl2Arr, hlc3Arr: this.hlc3Arr, ohlc4Arr: this.ohlc4Arr, hlcc4Arr: this.hlcc4Arr,
      curBar: this.curBar, n: this.n,
    };
    const bo = new Array(bn), bh = new Array(bn), bl = new Array(bn), bc = new Array(bn), bv = new Array(bn), bt = new Array(bn);
    const hl2 = new Array(bn), hlc3 = new Array(bn), ohlc4 = new Array(bn), hlcc4 = new Array(bn);
    for(let k = 0; k < bn; k++){
      const s = closedBuckets[k];
      const o = s.open, h = s.high, l = s.low, c = s.close;
      bo[k] = o; bh[k] = h; bl[k] = l; bc[k] = c; bv[k] = s.volume; bt[k] = s.time;
      hl2[k] = (h + l) / 2;
      hlc3[k] = (h + l + c) / 3;
      ohlc4[k] = (o + h + l + c) / 4;
      hlcc4[k] = (h + l + c + c) / 4;
    }
    this.openArr = bo; this.highArr = bh; this.lowArr = bl; this.closeArr = bc; this.volArr = bv;
    this.timeArr = bt; this.timeCloseArr = bt;
    this.hl2Arr = hl2; this.hlc3Arr = hlc3; this.ohlc4Arr = ohlc4; this.hlcc4Arr = hlcc4;
    this.n = bn;
    // expression is evaluated exactly once per bucket (HTF bar), with curBar normally advancing
    // from 0 — since it isn't re-evaluated per main bar, ta.* stateful functions only advance when
    // an HTF bar genuinely progresses.
    // expression은 버킷(HTF 봉) 하나당 딱 한 번, curBar를 0부터 정상적으로 증가시키며 평가한다 —
    // 메인 봉마다 재평가하지 않으므로 ta.* 상태 함수가 실제 HTF 봉이 진행될 때만 전진한다.
    const bucketValues = new Array(bn);
    try{
      for(let k = 0; k < bn; k++){ this.curBar = k; bucketValues[k] = this.evalExpr(exprNode); }
    } finally {
      Object.assign(this, save);
    }
    // lookahead off (default, non-repaint): the last "closed" bucket = current bucket - 1.
    // lookahead on (repaint): the current bucket itself — by the time the loop above runs,
    // closedBuckets has already merged in even the future main bars belonging to that bucket, so
    // this value is that bucket's "final (future-completed)" value. In other words, this matches
    // real Pine's repaint behavior of already showing the final value starting from the very first
    // main bar in that bucket's span.
    // lookahead off(기본, non-repaint): 마지막으로 "닫힌" 버킷 = 현재 버킷 - 1.
    // lookahead on(repaint): 현재 버킷 자체 — closedBuckets는 위 루프에서 이미 그 버킷에 속한
    // 미래 메인 봉들까지 다 합쳐진 뒤이므로, 이 값은 그 버킷의 "최종(미래 완성)" 값이다. 즉 그
    // 버킷 구간의 첫 메인 봉부터 이미 최종값을 보여주는 실제 Pine의 리페인트 동작과 일치한다.
    const offset = lookaheadOn ? 0 : -1;
    for(let i = 0; i < n; i++){
      const idx = bucketOfBar[i] + offset;
      result[i] = idx < 0 ? null : (bucketValues[idx] === undefined ? null : bucketValues[idx]);
    }
    return result;
  }
  // Per-callsite state key. For global code (the common case), the node's id number is used as-is — no string is built.
  // 콜사이트별 상태 키. 전역 코드(대부분)에서는 노드 id 숫자를 그대로 쓴다 — 문자열을 안 만든다.
  pathKey(node){
    return this.callPathStr === '' ? node.id : this.callPathStr + '.' + node.id;
  }
  evalPlotCallWithColorTracking(node){
    const posArgs = []; const namedArgs = {};
    let colorBranchKey = null;
    const hasNamedColor = node.args.some(a => a.named && a.name === 'color');
    let posIdx = 0;
    for(const a of node.args){
      if(a.named){
        if(a.name === 'color'){
          namedArgs.color = this.evalColorExpr(a.value); colorBranchKey = this.lastColorKey;
        } else if(a.name !== '__proto__') namedArgs[a.name] = this.evalExpr(a.value);
      } else {
        if(!hasNamedColor && posIdx === 2){
          posArgs.push(this.evalColorExpr(a.value)); colorBranchKey = this.lastColorKey;
        } else {
          posArgs.push(this.evalExpr(a.value));
        }
        posIdx++;
      }
    }
    return TOP_LEVEL_BUILTINS.plot(this, posArgs, namedArgs, node, colorBranchKey);
  }
  callUserFunction(funcNode, posArgs, namedArgs, line, callId){
    if(this.fnDepth > 60) throw new PineRuntimeError(pineMsg('함수 호출이 너무 깊습니다(재귀는 지원하지 않습니다)', 'Function call nesting too deep (recursion is not supported)'), line);
    const params = funcNode.params;
    const vars = new Map();
    for(let idx = 0; idx < params.length; idx++){
      const p = params[idx];
      let v;
      if(namedArgs.hasOwnProperty(p.name)) v = namedArgs[p.name];
      else if(idx < posArgs.length) v = posArgs[idx];
      else if(p.default) v = this.evalExpr(p.default);
      else v = null;
      vars.set(p.name, v);
    }
    const prevPathStr = this.callPathStr;
    this.scopeStack.push({ isFunctionCall: true, vars });
    this.callPathStr = prevPathStr === '' ? String(callId) : prevPathStr + '.' + callId;
    this.fnDepth++;
    try{ return this.execBlock(funcNode.body); }
    finally{ this.scopeStack.pop(); this.callPathStr = prevPathStr; this.fnDepth--; }
  }
}
