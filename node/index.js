'use strict';
/* node/index.js
   core/*.js is written on the assumption that it's loaded in order as
   <script> tags from the start, sharing one global scope (there's no
   export/import between the files at all). Node's require() gives each
   file its own isolated module scope, so as-is they can't see each other --
   so instead we run the core files in order inside a single vm context to
   reproduce that same "shared global scope" a browser's <script> tags give,
   then pick out just the names we need and re-export them as CommonJS
   exports. The core files themselves aren't touched at all.
   core/*.js는 처음부터 <script> 태그로 순서대로 로드해 전역 스코프를 공유하는 걸 전제로 짜여 있다
   (파일 사이에 export/import가 전혀 없음). Node의 require()는 파일마다 독립된 모듈 스코프를 주기
   때문에 그대로는 서로를 못 본다 — 그래서 core 파일들을 하나의 vm 컨텍스트에 순서대로 실행해
   브라우저 <script> 태그와 동일한 "공유 전역 스코프"를 재현하고, 그중 필요한 이름만 골라 CommonJS
   exports로 내보낸다. core 파일 자체는 한 글자도 안 건드린다. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE_DIR = path.join(__dirname, '..', 'core');
// Same load order used by the original app's lazy-loader (pine-lazy.js:PINE_ENGINE_FILES) --
// just without pine-import.js (that was the adapter code drawing straight onto that app's chart
// canvas, out of scope for this general-purpose package).
// pine-lazy.js에 있던 로드 순서(js/pine-lazy.js:PINE_ENGINE_FILES)와 동일 — pine-import.js만 뺐다
// (그건 원본 앱 차트 캔버스에 직접 그리는 어댑터 코드라 범용 패키지 범위 밖).
const CORE_FILES = [
  'pine-host.js',
  'pine-engine.js',
  'pine-types.js',
  'pine-interpreter.js',
  'pine-strategy.js',
  'pine-builtins.js',
];

const sandbox = { console };
vm.createContext(sandbox);
for(const file of CORE_FILES){
  const code = fs.readFileSync(path.join(CORE_DIR, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: path.join('core', file) });
}

module.exports = {
  // Script source -> AST (lexing + parsing + static type inference, all in one). Syntax errors
  // are thrown as PineLexError/PineParseError, both carrying a `line` field.
  // 스크립트 소스 -> AST (렉싱+파싱+정적 타입 추론까지 한 번에). 문법 오류는 line 필드가 붙은
  // PineLexError/PineParseError를 던진다.
  parse: sandbox.pineParse,
  // Script source + bar array -> execution result ({ plots, hlines, fills, shapes, lines, boxes,
  // labels, tables, barcolors, bgcolors, inputs, meta, strategy (for strategy() scripts) }).
  // options: { inputOverrides, strategyPropsOverride, lowerTfCache }
  //   - lowerTfCache: the Map<timeframe string, bars[]> that request.security_lower_tf()/a
  //     higher-timeframe request.security() reads from. If omitted, those calls just return na
  //     (the engine is built to fall back gracefully) -- fetch it from whatever data source you
  //     have and fill it in yourself.
  // Errors are thrown as a plain object shaped like { pineError: true, line, message } (not an
  // Error class -- unchanged from the original).
  // 스크립트 소스 + 봉 배열 -> 실행 결과({ plots, hlines, fills, shapes, lines, boxes, labels,
  // tables, barcolors, bgcolors, inputs, meta, strategy(strategy() 스크립트일 때) }).
  // options: { inputOverrides, strategyPropsOverride, lowerTfCache }
  //   - lowerTfCache: request.security_lower_tf()/상위 타임프레임 request.security()가 쓸
  //     Map<timeframe string, bars[]>. 안 주면 해당 호출은 그냥 na를 돌려준다(엔진이 그렇게
  //     우아하게 폴백하도록 되어 있음) — 다른 데이터소스에서 미리 받아와 채워 넣으면 된다.
  // 에러는 { pineError: true, line, message } 형태의 일반 객체를 던진다(에러 클래스 아님 — 원본 그대로).
  run: sandbox.runPineScript,
  // General-purpose OHLCV aggregator that buckets bars into a fixed ms interval. Useful if the
  // host wants to pre-aggregate before passing lowerTfCache to run() -- though it's not strictly
  // required, since the interpreter also finds any entry in lowerTfCache that's an exact divisor
  // of the requested timeframe and aggregates it internally on its own (PineInterpreter.resolveLowerTfBars).
  // 고정 ms 간격으로 봉을 합성하는 범용 OHLCV 집계기. run()에 lowerTfCache를 넘길 때 호스트가
  // 미리 합쳐두고 싶으면 쓸 수 있다 — 정확히 그 timeframe 키로 안 넣어도, 인터프리터가
  // lowerTfCache 안에서 요청 timeframe의 약수인 항목을 찾으면 내부적으로 이 함수를 써서
  // 자동으로 합성하므로(PineInterpreter.resolveLowerTfBars) 꼭 미리 호출할 필요는 없다.
  aggregateCandles: sandbox.pineAggregateCandles,
  // Pine timeframe string ("5", "1D", "3D", etc) -> seconds
  // Pine timeframe 문자열("5", "1D", "3D" 등) -> 초
  tfSeconds: sandbox.pineTfSeconds,
  // Error message language. 'ko' (default) | 'en'.
  // 에러 메시지 언어. 'ko'(기본) | 'en'.
  setLocale: sandbox.pineSetLocale,
  // The current symbol that syminfo.* refers to, e.g. { coin: 'BTC', isSpot: false }. If never
  // called, the symbol is treated as empty.
  // syminfo.*가 참조하는 현재 심볼. { coin: 'BTC', isSpot: false } 처럼. 안 부르면 빈 심볼 취급.
  setSymbol: sandbox.pineSetSymbol,

  // Lower-level classes/functions, for when you need finer control.
  // 더 낮은 수준이 필요할 때 쓰는 클래스/함수들.
  PineInterpreter: sandbox.PineInterpreter,
  PineParser: sandbox.PineParser,
  PineTypeInferrer: sandbox.PineTypeInferrer,
  PineLexError: sandbox.PineLexError,
  PineParseError: sandbox.PineParseError,
  PineRuntimeError: sandbox.PineRuntimeError,
  PineArray: sandbox.PineArray,
  tokenize: sandbox.pineTokenize,
};
