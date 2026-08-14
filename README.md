# OpenPine

Pure JS interpreter for a practical subset of Pine Script. Node.js + browser, zero dependencies.

A pure JavaScript interpreter for a practical subset of TradingView Pine
Script. It parses Pine source into an AST, runs static type inference over
it, and executes it against an array of OHLCV bars, producing
plot/line/box/label/table output and, for `strategy()` scripts, a full
backtest simulation. It has no
dependency on any specific charting library, UI framework, or data source —
you feed it bars and (optionally) a small amount of host configuration, and
it hands back plain data structures.

It ships as two independent builds that share one copy of the core logic: a
CommonJS build for Node.js, and a `<script>`-tag build for the browser.

## Layout

```
core/                 Core logic (lexer, parser, static type inference,
                       interpreter, builtins, strategy backtester). Both
                       the Node and browser builds use these files as-is.
  pine-host.js            Minimal host-injected config: error message
                           language and the current symbol.
  pine-engine.js           Lexer + parser.
  pine-types.js            Static type inference.
  pine-interpreter.js      The interpreter itself.
  pine-strategy.js         strategy() backtest simulation.
  pine-builtins.js         Built-in functions + the top-level entry point
                           (runPineScript).
node/                  Node.js build (CommonJS).
browser/               Browser build (<script> tags, window.OpenPine).
```

`core/*.js` files have no import/export statements — they assume they'll be
loaded in order as `<script>` tags, sharing one global scope. `node/index.js`
uses Node's built-in `vm` module to reproduce that shared global scope and
re-exports the pieces you need as a CommonJS module. `browser/openpine.browser.js`
is a thin final `<script>` tag that collects everything already sitting in
the global scope into one `window.OpenPine` object. The `core/*.js` files
themselves are byte-for-byte identical between the two builds — there is
exactly one copy of the actual language logic, so it can never drift between
the Node and browser builds.

## Node.js usage

```js
const OpenPine = require('./node'); // or require('./node/index.js')

const source = `//@version=6
indicator("SMA demo", overlay=true)
len = input.int(14, "Length")
plot(ta.sma(close, len), "SMA")
`;

const bars = [
  { time: 1700000000, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
  // ... time is a unix timestamp in seconds, oldest bar first
];

const result = OpenPine.run(source, bars, { inputOverrides: {} });
const smaPlot = [...result.plots.values()][0];
console.log(smaPlot.values); // array of SMA values, one per bar
```

Run `node/example.js` to see it working immediately:

```bash
node node/example.js
```

## Browser usage

```html
<script src="core/pine-host.js"></script>
<script src="core/pine-engine.js"></script>
<script src="core/pine-types.js"></script>
<script src="core/pine-interpreter.js"></script>
<script src="core/pine-strategy.js"></script>
<script src="core/pine-builtins.js"></script>
<script src="browser/openpine.browser.js"></script>
<script>
  const result = OpenPine.run(source, bars, { inputOverrides: {} });
</script>
```

Open `browser/example.html` through a static server to see it working
(opening it directly as a `file://` URL may be blocked by the browser's
local script loading restrictions — a small static server is recommended):

```bash
npx http-server .
```

## API

**`OpenPine.parse(source)`** → AST. Lexing, parsing, and static type
inference all happen in this one call. Syntax errors are thrown as
`PineLexError` / `PineParseError`, both of which carry a `.line` field.

**`OpenPine.run(source, bars, options)`** → execution result. Fully
synchronous — no network or I/O ever happens inside the engine itself.

- `options.inputOverrides` — overrides for `input.*()` default values, as
  `{ [callId]: value }` (e.g. values the user changed in a settings panel).
- `options.strategyPropsOverride` — overrides for a `strategy()` script's
  properties (commission, slippage, etc).
- `options.lowerTfCache` — a `Map<timeframe string, bars[]>` that
  `request.security_lower_tf()` calls, and `request.security()` calls whose
  timeframe is *not* an exact multiple of the chart's own resolution, read
  from. Fill it with whatever atomic resolution you actually have data for
  (e.g. just `"1S"` for 1-second bars) — you do not need to key it by the
  exact timeframe the script asks for. If the interpreter doesn't find an
  exact key match, it looks for any entry in the cache whose timeframe
  evenly divides the requested one and synthesizes the requested resolution
  from it on the fly (`PineInterpreter.resolveLowerTfBars` — if there are
  multiple valid divisor candidates, it picks the coarsest one to minimize
  aggregation work). This means you never have to scan the script in
  advance to know exactly which timeframes it will ask for. If you don't
  provide this option, or the cache has nothing relevant,
  `request.security_lower_tf()` returns `na` and a mismatched
  `request.security()` returns `na` as well. A `request.security()` call
  whose timeframe *is* an exact multiple of the chart's resolution (e.g.
  asking for `"5"` on a 1-minute chart) is synthesized correctly straight
  from the main bars with no cache needed at all.

Return value:

```
{ meta, plots, hlines, fills, shapes, lines, boxes, labels, tables,
  barcolors, bgcolors, inputs, __interp }
```

(the Map-typed fields map call-site key → array of values). A `strategy()`
script's result additionally includes its trade history / equity curve,
etc. Runtime errors are thrown as a plain object shaped like
`{ pineError: true, line, message }` (not an `Error` subclass).

**`OpenPine.aggregateCandles(bars, ms)`** — a general-purpose OHLCV
aggregator that buckets bars into a fixed millisecond interval. This is the
same function `resolveLowerTfBars` uses internally, so you normally won't
need to call it yourself — but it's available if you want to pre-aggregate
`lowerTfCache` entries on your own.

**`OpenPine.tfSeconds(tf)`** — converts a Pine timeframe string (`"5"`,
`"1D"`, `"3D"`, etc) to seconds.

**`OpenPine.setLocale('ko' | 'en')`** — language for error messages.
Defaults to `'ko'`.

**`OpenPine.setSymbol({ coin, isSpot })`** — the current symbol that
`syminfo.*` built-ins refer to. If you never call this, the symbol is
treated as empty (calculations still run fine — `syminfo.ticker` etc just
come back as an empty string).

Lower-level exports — `PineInterpreter`, `PineParser`, `PineTypeInferrer`,
`PineArray`, `tokenize`, and a few others — are also exported, for cases
where you want more control, e.g. reusing an interpreter instance to only
recompute the most recent, unconfirmed bar instead of re-running the whole
script each tick.

## Example: filling `lowerTfCache`

Fill it with whatever atomic resolution you happen to have (1-second bars
in this example), and every timeframe `request.security_lower_tf()` /
non-multiple `request.security()` calls ask for gets synthesized
automatically as long as the divisor relationship holds:

```js
const raw1s = await myApi.fetchCandles(coin, '1s', fromSec, toSec); // your own data source
const lowerTfCache = new Map([['1S', raw1s]]);

const result = OpenPine.run(source, bars, { lowerTfCache });
// request.security_lower_tf(tickerid, "5S", close) -> synthesized from 1S, 5 bars at a time
// request.security(tickerid, "15", close) (when the chart isn't a divisor of 15 minutes)
//   -> synthesized from 1S, 900 bars at a time
// Neither one needs a "5S" or "15" key placed directly into lowerTfCache.
```

## Design notes

- `OpenPine.run()` never does any fetching or I/O on its own. Anything that
  needs external data (lower-timeframe/security bars) is read purely from
  `options.lowerTfCache` — fetching that data is entirely the host's
  responsibility, which also means OpenPine has no opinion about where bar
  data comes from.
- Host configuration (error message language, current symbol) is explicit
  and pull-based — set it with `OpenPine.setLocale()` / `OpenPine.setSymbol()`
  before running a script. There is no ambient/global state the engine
  reads implicitly; if you never call these, the engine just uses sensible
  empty defaults.
- `resolveLowerTfBars()` synthesizes any requested timeframe from any finer
  timeframe present in `lowerTfCache`, as long as it's an exact divisor.
  This means the atomic resolution you choose to supply is entirely up to
  you — a second, a minute, anything — sub-minute timeframes (`"1S"`,
  `"5S"`, etc) are supported the same way coarser ones are, with no
  special-casing.

## Real-world usage example

You can see this engine embedded in a real charting application at
[github.com/woefije0/hl-chart](https://github.com/woefije0/hl-chart), and
try it live at [woefije0.github.io/hl-chart](https://woefije0.github.io/hl-chart/).

---

## OpenPine (한국어)

TradingView Pine Script의 실용적 서브셋을 실행하는 순수 JavaScript
인터프리터. Pine 소스를 파싱해 AST로 만들고, 그
위에서 정적 타입 추론을 한 번 돌린 뒤, OHLCV 봉 배열에 대해 실행해서
plot/line/box/label/table 출력을 만들어내고, `strategy()` 스크립트라면 전체
백테스트 시뮬레이션까지 수행한다. 특정 차트 라이브러리나 UI 프레임워크,
데이터소스에 대한 의존이 전혀 없다 — 봉 데이터와(필요하면) 아주 약간의 호스트
설정만 넘겨주면, 순수한 데이터 구조를 돌려준다.

핵심 로직 한 벌을 공유하는 독립된 두 가지 빌드로 제공된다: Node.js용
CommonJS 빌드와, 브라우저용 `<script>` 태그 빌드.

### 구조

```
core/                 핵심 로직 (렉서, 파서, 정적 타입추론, 인터프리터, 내장함수,
                       전략 백테스터). 브라우저/Node 빌드 둘 다 이 파일들을 그대로
                       쓴다.
  pine-host.js             호스트가 주입하는 최소 설정: 에러 메시지 언어와 현재
                            심볼.
  pine-engine.js            렉서 + 파서.
  pine-types.js             정적 타입 추론.
  pine-interpreter.js       인터프리터 본체.
  pine-strategy.js          strategy() 백테스트 시뮬레이션.
  pine-builtins.js          내장 함수 + 최상위 진입점(runPineScript).
node/                  Node.js 전용 빌드 (CommonJS).
browser/               브라우저 전용 빌드 (<script> 태그, window.OpenPine).
```

`core/*.js` 파일들은 import/export가 전혀 없다 — `<script>` 태그로 순서대로
로드해서 전역 스코프를 공유하는 걸 전제로 짜여 있다. `node/index.js`는 Node의
내장 `vm` 모듈로 이 공유 전역 스코프를 그대로 재현해서 필요한 것만 CommonJS
모듈로 다시 내보내고, `browser/openpine.browser.js`는 이미 전역에 올라와 있는
것들을 `window.OpenPine` 하나로 정리하는 얇은 마지막 `<script>` 태그다.
`core/*.js` 자체는 두 빌드가 바이트 단위로 완전히 동일한 파일을 쓴다 — 실제
언어 로직은 딱 한 벌뿐이라 Node 빌드와 브라우저 빌드 사이에 내용이 갈라져
따로 관리될 일이 없다.

### Node.js 사용법

```js
const OpenPine = require('./node'); // 또는 require('./node/index.js')

const source = `//@version=6
indicator("SMA demo", overlay=true)
len = input.int(14, "Length")
plot(ta.sma(close, len), "SMA")
`;

const bars = [
  { time: 1700000000, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
  // ... time은 초 단위 unix timestamp, 오래된 봉 -> 최신 봉 순
];

const result = OpenPine.run(source, bars, { inputOverrides: {} });
const smaPlot = [...result.plots.values()][0];
console.log(smaPlot.values); // 봉별 SMA 값 배열
```

`node/example.js`를 실행해보면 바로 확인할 수 있다:

```bash
node node/example.js
```

### 브라우저 사용법

```html
<script src="core/pine-host.js"></script>
<script src="core/pine-engine.js"></script>
<script src="core/pine-types.js"></script>
<script src="core/pine-interpreter.js"></script>
<script src="core/pine-strategy.js"></script>
<script src="core/pine-builtins.js"></script>
<script src="browser/openpine.browser.js"></script>
<script>
  const result = OpenPine.run(source, bars, { inputOverrides: {} });
</script>
```

`browser/example.html`을 정적 서버로 열어보면 바로 확인할 수 있다(파일을
`file://`로 직접 열면 브라우저의 로컬 스크립트 로드 제한에 막힐 수 있으니
간단한 정적 서버를 권장한다):

```bash
npx http-server .
```

### API

**`OpenPine.parse(source)`** → AST. 렉싱 + 파싱 + 정적 타입 추론이 이 호출
하나로 전부 끝난다. 문법 오류는 `.line` 필드가 붙은 `PineLexError` /
`PineParseError`로 던져진다.

**`OpenPine.run(source, bars, options)`** → 실행 결과. 완전히 동기적이다 —
엔진 내부에서 네트워크나 I/O가 발생하는 일은 전혀 없다.

- `options.inputOverrides` — `input.*()` 기본값을 덮어쓸
  `{ [callId]: value }` (예: 설정 패널에서 사용자가 바꾼 값).
- `options.strategyPropsOverride` — `strategy()` 스크립트의 속성(수수료,
  슬리피지 등) 오버라이드.
- `options.lowerTfCache` — `request.security_lower_tf()` 호출과, 차트 자체
  해상도의 정확한 배수가 *아닌* timeframe을 요청하는 `request.security()`
  호출이 참조하는 `Map<timeframe 문자열, bars[]>`. 실제로 가진 아무 원자
  해상도로나 채워 넣으면 된다(예: 1초봉이면 그냥 `"1S"` 하나만) — 스크립트가
  요청하는 정확한 timeframe으로 키를 넣을 필요는 없다. 인터프리터가 정확히
  일치하는 키를 못 찾으면, 캐시 안에서 요청 timeframe을 정확히
  나누어떨어지게 하는(즉 그 timeframe의 약수인) 항목을 찾아 즉석에서 그
  해상도로 합성한다(`PineInterpreter.resolveLowerTfBars` — 약수 후보가
  여럿이면 합성량이 가장 적은 가장 굵은 것을 고른다). 그래서 스크립트를 미리
  스캔해서 정확히 어떤 timeframe들을 요청할지 알아낼 필요가 없다. 이 옵션을
  안 주거나 캐시에 관련 데이터가 없으면 `request.security_lower_tf()`는
  `na`를, 배수가 아닌 `request.security()`도 `na`를 돌려준다. 반대로 차트
  해상도의 정확한 배수를 요청하는 `request.security()`(예: 1분봉 차트에서
  `"5"` 요청)는 캐시가 전혀 없어도 메인 봉을 그대로 묶어 정확하게 합성된다.

반환값:

```
{ meta, plots, hlines, fills, shapes, lines, boxes, labels, tables,
  barcolors, bgcolors, inputs, __interp }
```

(Map 타입 필드들은 콜사이트 key → 값 배열). `strategy()` 스크립트면 거래
내역/자산곡선 등도 추가로 포함된다. 런타임 에러는 `Error`의 서브클래스가
아니라 `{ pineError: true, line, message }` 형태의 일반 객체로 던져진다.

**`OpenPine.aggregateCandles(bars, ms)`** — 고정 밀리초 간격으로 봉을 합치는
범용 OHLCV 집계기. `resolveLowerTfBars`가 내부적으로 쓰는 것과 같은 함수라
보통 직접 호출할 필요는 없지만, `lowerTfCache` 항목을 스스로 미리 합쳐서
넣고 싶을 때 쓸 수 있다.

**`OpenPine.tfSeconds(tf)`** — Pine timeframe 문자열(`"5"`, `"1D"`, `"3D"`
등)을 초로 변환한다.

**`OpenPine.setLocale('ko' | 'en')`** — 에러 메시지 언어. 기본값 `'ko'`.

**`OpenPine.setSymbol({ coin, isSpot })`** — `syminfo.*` 내장 변수가 참조할
현재 심볼. 한 번도 안 부르면 빈 심볼로 취급한다(계산 자체는 문제없이
돌아가고, `syminfo.ticker` 등이 그냥 빈 문자열로 나올 뿐이다).

저수준 API: `PineInterpreter`, `PineParser`, `PineTypeInferrer`,
`PineArray`, `tokenize` 등도 내보낸다 — 예를 들어 매 틱마다 스크립트 전체를
다시 실행하는 대신 인터프리터 인스턴스를 재사용해서 아직 확정되지 않은
마지막 봉만 다시 계산하고 싶을 때처럼, 더 세밀한 제어가 필요한 경우에 쓴다.

### 예시: `lowerTfCache` 채우기

가진 아무 원자 해상도로나(여기선 1초봉) 채워두면, `request.security_lower_tf()`와
배수가 아닌 `request.security()`가 요청하는 모든 timeframe이 약수 관계만
맞으면 전부 자동으로 합성된다:

```js
const raw1s = await myApi.fetchCandles(coin, '1s', fromSec, toSec); // 자신의 데이터소스
const lowerTfCache = new Map([['1S', raw1s]]);

const result = OpenPine.run(source, bars, { lowerTfCache });
// request.security_lower_tf(tickerid, "5S", close) -> 1S에서 5개씩 합성
// request.security(tickerid, "15", close) (차트가 15분의 약수가 아닐 때)
//   -> 1S에서 900개씩 합성
// 둘 다 lowerTfCache에 "5S"나 "15" 키를 직접 넣을 필요가 없다.
```

### 설계 메모

- `OpenPine.run()`은 그 자체로는 어떤 fetch나 I/O도 하지 않는다. 외부
  데이터가 필요한 부분(lower-timeframe/security 봉)은 오직
  `options.lowerTfCache`에서만 읽는다 — 그 데이터를 실제로 받아오는 건
  전적으로 호스트 책임이고, 그 덕에 OpenPine은 봉 데이터가 어디서 오는지에
  대해 아무 의견도 갖지 않는다.
- 호스트 설정(에러 메시지 언어, 현재 심볼)은 명시적이고 호출 기반이다 —
  스크립트를 실행하기 전에 `OpenPine.setLocale()` / `OpenPine.setSymbol()`로
  미리 설정한다. 엔진이 암묵적으로 읽는 전역 상태는 없다 — 아예 안 부르면
  그냥 적당한 빈 기본값을 쓴다.
- `resolveLowerTfBars()`는 `lowerTfCache`에 있는 더 잘게 쪼갠 timeframe이
  요청된 timeframe의 정확한 약수이기만 하면 어디서든 데이터를 찾아
  합성한다. 즉 어떤 원자 해상도를 공급할지는 전적으로 호스트 마음이다 —
  1초든 1분이든 뭐든 상관없고, 초 단위 timeframe(`"1S"`, `"5S"` 등)도 더
  굵은 timeframe과 똑같은 방식으로 특별 취급 없이 지원된다.

### 실제 활용 예시

이 엔진이 실제 차트 앱에 붙어 있는 모습은
[github.com/woefije0/hl-chart](https://github.com/woefije0/hl-chart)에서
볼 수 있고, [woefije0.github.io/hl-chart](https://woefije0.github.io/hl-chart/)에서
직접 써볼 수 있다.
