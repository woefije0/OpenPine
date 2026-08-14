/* browser/openpine.browser.js
   Loading core/*.js as <script> tags in order puts everything (PineHost,
   pineParse, PineInterpreter, runPineScript, ...) straight onto the global
   scope (window) -- that's exactly how they were meant to be used in a
   browser, so the core files themselves don't need to be touched. This file
   is a thin, final <script> tag that gathers those globals into one
   window.OpenPine object.
   core/*.js는 <script> 태그로 순서대로 로드하면 (PineHost, pineParse, PineInterpreter,
   runPineScript, ...) 전부 전역(window)에 그대로 올라온다 — 브라우저에서는 원래 그렇게
   쓰라고 만든 코드라서 core 파일 자체를 건드릴 필요가 없다. 이 파일은 그 전역들을
   window.OpenPine 하나로 정리해서 묶어주는 아주 얇은 마지막 <script> 태그다.

   Usage:
   사용법:
   <script src="core/pine-host.js"></script>
   <script src="core/pine-engine.js"></script>
   <script src="core/pine-types.js"></script>
   <script src="core/pine-interpreter.js"></script>
   <script src="core/pine-strategy.js"></script>
   <script src="core/pine-builtins.js"></script>
   <script src="openpine.browser.js"></script>
   <script>
     const result = OpenPine.run(source, bars, { inputOverrides: {} });
   </script>
*/
(function(global){
  global.OpenPine = {
    parse: pineParse,
    run: runPineScript,
    aggregateCandles: pineAggregateCandles,
    tfSeconds: pineTfSeconds,
    setLocale: pineSetLocale,
    setSymbol: pineSetSymbol,

    PineInterpreter: PineInterpreter,
    PineParser: PineParser,
    PineTypeInferrer: PineTypeInferrer,
    PineLexError: PineLexError,
    PineParseError: PineParseError,
    PineRuntimeError: PineRuntimeError,
    PineArray: PineArray,
    tokenize: pineTokenize,
  };
})(typeof window !== 'undefined' ? window : globalThis);
