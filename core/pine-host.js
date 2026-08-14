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
};

function pineSetLocale(lang){ PineHost.lang = (lang === 'en') ? 'en' : 'ko'; }
function pineSetSymbol(opts){
  if(!opts) return;
  if('coin' in opts) PineHost.coin = opts.coin ? String(opts.coin) : '';
  if('isSpot' in opts) PineHost.isSpot = !!opts.isSpot;
}
