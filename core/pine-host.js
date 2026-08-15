/* pine-host.js
   The minimal configuration the host (the application embedding this engine)
   passes in. This replaces the spot that used to read the original app's
   global `state` object -- the engine works fine without these too, just
   falling back to an empty string / false (e.g. syminfo.*-related functions
   are treated as having an empty symbol).
   호스트(이 엔진을 임베드하는 애플리케이션)가 넘겨주는 최소한의 설정.
   원래 앱 전역 `state` 객체를 읽던 자리를 대체한다 — 이 값들이 없어도 엔진은
   그냥 빈 문자열/false로 동작한다(예: syminfo.* 관련 함수는 빈 심볼 취급). */
const PineHost = {
  lang: 'ko',   // Which language pineMsg() picks error messages in / pineMsg()가 어떤 언어의 에러 메시지를 고를지
  coin: '',     // Symbol name used by syminfo.ticker/description/basecurrency etc (e.g. 'BTC') / syminfo.ticker/description/basecurrency 등에 쓰이는 심볼 이름 (예: 'BTC')
  isSpot: false, // Used by syminfo.* to choose futures(.P)/spot notation / syminfo.* 가 선물(.P)/현물 표기를 고를 때 씀
  exchangePrefix: '', // syminfo.prefix, and the "EXCHANGE:" part of syminfo.tickerid / syminfo.prefix와 syminfo.tickerid의 "거래소:" 접두사 부분
  // Overrides the mintick heuristic for a specific symbol. (symbol: string) => number | null | undefined --
  // symbol is whatever ticker string identifies it (this chart's own syminfo.ticker/tickerid for the
  // current symbol, or the exact string a script passed as request.security()'s symbol argument for
  // any other symbol). Return a positive number to use as the tick size, or null/undefined to fall
  // back to the built-in 5-significant-figure approximation.
  // 특정 심볼의 mintick 근사값을 대체한다. (symbol: string) => number | null | undefined --
  // symbol은 그 심볼을 가리키는 티커 문자열(현재 심볼이면 이 차트 자신의 syminfo.ticker/tickerid,
  // 그 외 심볼이면 스크립트가 request.security()의 symbol 인자로 넘긴 그 문자열 그대로)이다.
  // 양수를 돌려주면 그걸 틱 사이즈로 쓰고, null/undefined면 내장된 유효숫자 5자리 근사로 폴백한다.
  mintickResolver: null,
};

function pineSetLocale(lang){ PineHost.lang = (lang === 'en') ? 'en' : 'ko'; }
function pineSetSymbol(opts){
  if(!opts) return;
  if('coin' in opts) PineHost.coin = opts.coin ? String(opts.coin) : '';
  if('isSpot' in opts) PineHost.isSpot = !!opts.isSpot;
  if('exchangePrefix' in opts) PineHost.exchangePrefix = opts.exchangePrefix ? String(opts.exchangePrefix) : '';
}
function pineSetMintickResolver(fn){ PineHost.mintickResolver = (typeof fn === 'function') ? fn : null; }
