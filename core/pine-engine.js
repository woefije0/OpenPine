/* pine-engine.js
   English translation of the header below:
   A practical-subset rendering engine for PineScript (TradingView) "indicator" scripts
   It is structured as: lexer -> parser (AST) ->
   an interpreter that re-runs the script from scratch for every bar.

   The supported range and known limitations (request.security limits, method-overloading limits,
   etc.) keep growing and are no longer manageable as comments here, so they were moved to
   PINE_ENGINE.md at the project root — see that file for the latest details.
   (var inside user-defined functions now also persists state across bars, and drawing objects like
   line.new/box.new/label.new and request.security() are now supported too — this used to say
   "unsupported" here, but that has changed.)

   ── Execution model ──
   Pine's core model is that "the entire script re-runs from the top on every bar." So this engine
   does the same: the interpreter walks the whole AST again, bars.length times. Only variables
   declared with var carry their value over from the previous bar (persist); ordinary '=' variables
   are recomputed fresh every bar.

   PineScript(TradingView) "지표(indicator)" 스크립트의 실용적 서브셋 렌더링 엔진.
   렉서 -> 파서(AST) -> 봉(bar) 단위로 스크립트를 처음부터 다시 실행하는 인터프리터, 순서로 구성된다.

   지원 범위와 알려진 제약(request.security 한계, method 오버로딩 한계 등)은 계속 늘어나서 여기
   주석으로는 관리가 안 돼 프로젝트 루트의 PINE_ENGINE.md로 옮겼다 — 최신 내용은 그쪽 참고.
   (사용자 정의 함수 내부의 var도 bar 간 상태가 유지되고, line.new/box.new/label.new 같은 그리기
   객체나 request.security()도 이제 지원한다 — 예전엔 여기 미지원으로 적혀 있었지만 바뀌었다.)

   ── 실행 모델 ──
   Pine은 "스크립트 전체가 매 bar마다 처음부터 다시 실행된다"는 게 핵심 모델이다. 그래서 여기서도
   똑같이: bars.length번 만큼 인터프리터가 AST 전체를 매번 다시 훑는다. var로 선언한 변수만
   이전 bar의 값을 그대로 들고 오고(persist), 일반 '=' 변수는 매 bar 새로 계산된다. */

// ============================================================
// 1. Lexer — indentation is syntactically significant in this language, so it is built with a
//    structure similar to a Python tokenizer.
// ============================================================
// ============================================================
// 1. 렉서 (Lexer) — 들여쓰기가 문법인 언어라서 Python 토크나이저와 비슷한 구조로 만든다.
// ============================================================
function pineMsg(kr, en){
  return PineHost.lang === 'en' ? en : kr;
}

class PineLexError extends Error {
  constructor(msg, line){ super(msg); this.line = line; this.pineLex = true; }
}

const PINE_KEYWORDS = new Set([
  'var','varip','if','else','for','while','to','by','in','switch',
  'break','continue','and','or','not','true','false','na',
]);
// The three sets below used to be freshly built as array literals at each call site and scanned
// with .includes() — the lexer runs once per "character position" in the source, so a new 11-slot
// array was allocated every single time.
// 아래 세 개는 예전엔 쓰이는 자리마다 배열 리터럴로 새로 만들어 .includes()로 훑었다 —
// 렉서 쪽은 소스의 "문자 위치마다" 한 번씩 도는 자리라 그때마다 11칸짜리 배열이 새로 생겼다.
const PINE_TWO_CHAR_OPS = new Set(['=>',':=','==','!=','<=','>=','+=','-=','*=','/=','%=']);
const PINE_COMPARE_OPS = new Set(['==','!=','<','>','<=','>=']);
const PINE_COMPOUND_ASSIGN_OPS = new Set(['+=','-=','*=','/=','%=']);
const PINE_HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?/;
// Escapes for string literals. Any character not in this table (\" \' \\ etc.) is emitted as-is.
// 문자열 리터럴의 이스케이프. 표에 없는 글자(\" \' \\ 등)는 그 글자 그대로 쓴다.
const PINE_STR_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
// Character classification is done by comparing char codes rather than with a regex
// (/[0-9]/.test(c)) — the whole source is re-lexed not just when the script is edited but on every
// new bar, so per-character cost accumulates directly.
// 문자 분류는 정규식(/[0-9]/.test(c)) 대신 코드 포인트 비교로 한다 — 스크립트를 고칠 때뿐
// 아니라 새 봉이 올 때마다 전체 소스를 다시 렉싱하므로 문자 단위 비용이 그대로 쌓인다.
function pineIsDigit(cc){ return cc >= 48 && cc <= 57; }
function pineIsIdentStart(cc){ return (cc >= 97 && cc <= 122) || (cc >= 65 && cc <= 90) || cc === 95; }
function pineIsIdentPart(cc){ return pineIsIdentStart(cc) || pineIsDigit(cc); }

function pineTokenize(source){
  const tokens = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const indentStack = [0];
  let parenDepth = 0; // Inside parens/brackets a line break is not treated as NEWLINE and is joined instead (line continuation) / 괄호/대괄호 안에서는 줄바꿈을 NEWLINE으로 안 치고 이어붙인다 (라인 연속)
  // If a line ends with one of these operators, the expression is not finished yet — an operand
  // must follow. Example: a multi-line ternary chain (`a ? b : c ?\n  d : e ?\n  f : g`) where the
  // next line does not start with ':' but instead starts a whole new comparison expression is a
  // case the existing "join if the next line starts with ':'" handling alone cannot catch. Because
  // Pine grammar requires an operand after these operators, it is safe to join the next line
  // whenever it is indented deeper than the current statement (no risk of confusing it with the
  // start of a new block).
  // 줄 끝이 이 연산자들 중 하나면 그 줄은 아직 식이 안 끝난 것 — 뒤에 피연산자가 반드시 와야 한다.
  // 예: 여러 줄에 걸친 삼항연산자 체인(`a ? b : c ?\n  d : e ?\n  f : g`)처럼 다음 줄이 ':'로
  // 시작하지 않고 통째로 새 비교식으로 시작하는 경우, 기존의 "다음 줄이 ':'로 시작하면 이어붙인다"
  // 처리만으로는 못 잡는다. 여기 연산자들은 Pine 문법상 뒤에 반드시 피연산자가 와야 하므로, 다음
  // 줄이 현재 문장보다 더 들여써져 있기만 하면 안전하게(블록 시작과 헷갈릴 일 없이) 이어붙일 수 있다.
  const CONTINUATION_TRAILING_OPS = new Set(['?',':',',','+','-','*','/','%','==','!=','<=','>=','<','>','=',':=','+=','-=','*=','/=','%=']);
  const CONTINUATION_TRAILING_KEYWORDS = new Set(['and','or','not']);
  function lastMeaningfulToken(){
    for(let k = tokens.length - 1; k >= 0; k--){
      if(tokens[k].type === 'NEWLINE' || tokens[k].type === 'INDENT' || tokens[k].type === 'DEDENT') continue;
      return tokens[k];
    }
    return null;
  }
  function endsWithContinuationOp(){
    const t = lastMeaningfulToken();
    if(!t) return false;
    if(t.type === 'OP') return CONTINUATION_TRAILING_OPS.has(t.value);
    if(t.type === 'KEYWORD') return CONTINUATION_TRAILING_KEYWORDS.has(t.value);
    return false;
  }
  function leadingIndentOf(line){
    let ind = 0, k = 0;
    while(k < line.length && (line[k] === ' ' || line[k] === '\t')){ ind += (line[k] === '\t' ? 4 : 1); k++; }
    return ind;
  }

  function tokenizeLogicalLine(text, lineNo, isFirstPhysicalOfLogical){
    let i = 0;
    const n = text.length;
    // Indentation is handled only on the "first physical line" of a logical line
    // 들여쓰기 처리는 논리적 줄의 "첫 물리적 줄"에서만
    if(isFirstPhysicalOfLogical){
      let indent = 0;
      while(i < n && (text[i] === ' ' || text[i] === '\t')){ indent += (text[i] === '\t' ? 4 : 1); i++; }
      if(i >= n || text[i] === '/' && text[i+1] === '/') return; // Ignore lines that are blank or comment-only / 빈 줄/주석만 있는 줄은 무시
      if(indent > indentStack[indentStack.length - 1]){
        indentStack.push(indent);
        tokens.push({ type: 'INDENT', value: indent, line: lineNo });
      }
      while(indent < indentStack[indentStack.length - 1]){
        indentStack.pop();
        tokens.push({ type: 'DEDENT', value: indent, line: lineNo });
      }
    }
    while(i < n){
      const c = text[i];
      if(c === ' ' || c === '\t'){ i++; continue; }
      if(c === '/' && text[i+1] === '/'){ break; } // Comment to end of line / 줄 끝까지 주석
      if(c === '"' || c === "'"){
        const quote = c; let j = i + 1; let s = '';
        while(j < n && text[j] !== quote){
          // Escapes: this used to just strip the backslash and insert the following character
          // verbatim, so "\n" became the letter 'n' instead of a newline (multi-line text in
          // label/tooltip/alert messages collapsed onto one line).
          // 이스케이프: 예전엔 백슬래시만 떼고 뒷글자를 그대로 넣어서 "\n"이 줄바꿈이 아니라
          // 글자 'n'이 됐다(label/tooltip/alert 메시지의 여러 줄 텍스트가 한 줄로 붙어버림).
          if(text[j] === '\\' && j + 1 < n){ s += PINE_STR_ESCAPES[text[j+1]] || text[j+1]; j += 2; continue; }
          s += text[j]; j++;
        }
        tokens.push({ type: 'STRING', value: s, line: lineNo });
        i = j + 1; continue;
      }
      if(c === '#'){
        const m = PINE_HEX_COLOR_RE.exec(text.slice(i));
        if(m){
          // The "value" of a color literal is just the "#rrggbb" string (treated the same as
          // color.new etc.) — since the runtime representation is a string, it cannot be
          // distinguished from a string by value alone, so a separate marker is kept on the token
          // so static type inference can read it as color.
          // 색상 리터럴의 "값"은 그냥 "#rrggbb" 문자열이다(color.new 등과 동일하게 다뤄짐) —
          // 런타임 표현이 문자열이라 값만 봐서는 string과 구분이 안 되므로, 정적 타입 추론이
          // color로 읽을 수 있게 토큰에 표시만 따로 남긴다.
          tokens.push({ type: 'STRING', value: m[0], line: lineNo, isColor: true });
          i += m[0].length; continue;
        }
      }
      const cc = text.charCodeAt(i);
      if(pineIsDigit(cc) || (c === '.' && pineIsDigit(text.charCodeAt(i + 1)))){
        let j = i;
        while(j < n && (pineIsDigit(text.charCodeAt(j)) || text[j] === '.')) j++;
        if(text[j] === 'e' || text[j] === 'E'){ j++; if(text[j] === '+' || text[j] === '-') j++; while(j < n && pineIsDigit(text.charCodeAt(j))) j++; }
        // The value is still just a single JS number as before (no int/float distinction at
        // runtime), but whether the literal's "notation" was an integer (no decimal point, no
        // exponent) is the only clue static type inference has for telling int and float apart, so
        // it is kept on the token as well.
        // 값은 예전처럼 그냥 JS number 하나지만(런타임엔 int/float 구분이 없다), 리터럴의 "표기"가
        // 정수였는지(소수점도 지수도 없었는지)는 정적 타입 추론이 int/float를 가르는 유일한 단서라
        // 토큰에 같이 남긴다.
        const raw = text.slice(i, j);
        tokens.push({ type: 'NUMBER', value: parseFloat(raw), line: lineNo, isInt: raw.indexOf('.') < 0 && raw.indexOf('e') < 0 && raw.indexOf('E') < 0 });
        i = j; continue;
      }
      if(pineIsIdentStart(cc)){
        let j = i;
        while(j < n && pineIsIdentPart(text.charCodeAt(j))) j++;
        const s = text.slice(i, j);
        tokens.push({ type: PINE_KEYWORDS.has(s) ? 'KEYWORD' : 'IDENT', value: s, line: lineNo });
        i = j; continue;
      }
      // Multi-character operators
      // 다중 문자 연산자
      const two = text.substr(i, 2);
      if(PINE_TWO_CHAR_OPS.has(two)){
        tokens.push({ type: 'OP', value: two, line: lineNo }); i += 2; continue;
      }
      if('()[]{},.:?'.includes(c)){
        if(c === '(' || c === '[' || c === '{') parenDepth++;
        if(c === ')' || c === ']' || c === '}') parenDepth = Math.max(0, parenDepth - 1);
        tokens.push({ type: 'OP', value: c, line: lineNo }); i++; continue;
      }
      if('=<>+-*/%'.includes(c)){ tokens.push({ type: 'OP', value: c, line: lineNo }); i++; continue; }
      throw new PineLexError(pineMsg(`알 수 없는 문자 '${c}'`, `Unknown character '${c}'`), lineNo);
    }
  }

  for(let li = 0; li < lines.length; li++){
    const raw = lines[li];
    const lineNo = li + 1;
    // If parens are still open at the start of a line, this physical line is a continuation of the
    // previous one — indentation (INDENT/DEDENT) is only judged on the first physical line of a
    // logical line.
    // (This used to keep accumulating the joined source text in a pendingLine buffer and compare
    //  its length against raw.length to decide whether it was the first line; if the two lines
    //  happened to have the same length, an INDENT would pop out in the middle of an expression,
    //  causing an "unexpected token" parse error. Worse, it kept treating even the line after the
    //  closing-paren line as a "continuation line," so that line's DEDENT was dropped entirely —
    //  a bug where the block failed to close after a multi-line call.)
    // 줄 시작 시점에 괄호가 열려 있으면 이 물리적 줄은 앞 줄에서 이어지는 중이다 —
    // 들여쓰기(INDENT/DEDENT)는 논리적 줄의 첫 물리적 줄에서만 판정한다.
    // (예전엔 이어붙인 원문을 pendingLine 버퍼에 계속 쌓아두고 그 길이를 raw.length와 비교해
    //  첫 줄 여부를 정했는데, 두 줄의 길이가 우연히 같으면 식 한가운데서 INDENT가 튀어나와
    //  "예상치 못한 토큰" 파싱 에러가 났다. 게다가 닫는 괄호 줄 다음 줄까지 계속 "이어지는 줄"로
    //  취급해서 그 줄의 DEDENT를 통째로 놓쳤다 — 여러 줄 호출 뒤에 블록이 안 닫히는 버그.)
    tokenizeLogicalLine(raw, lineNo, parenDepth === 0);
    if(parenDepth === 0){
      // A ternary can continue onto the next line even without parens — e.g.:
      //   os := high[len] > upper ? 0
      //     : low[len] < lower ? 1 : os
      // Indentation depth alone cannot distinguish this from the start of a block like if/for, so
      // detection is narrowed to two safe signals: (1) the next line starts with ':', which can
      // never appear at the very start of a statement, or (2) the current line ends with an
      // operator that must be followed by an operand (and only when the next line is indented
      // deeper than this statement — so it isn't confused with the start of a new block).
      // 괄호 없이도 삼항연산자가 다음 줄로 이어지는 경우 — 예:
      //   os := high[len] > upper ? 0
      //     : low[len] < lower ? 1 : os
      // 들여쓰기 깊이만으로는 if/for 같은 블록 시작과 구별이 안 되므로, 두 가지 안전한 신호로만
      // 좁혀서 감지한다: (1) 다음 줄이 문장의 맨 앞에는 절대 올 수 없는 ':'로 시작하거나,
      // (2) 지금 줄이 반드시 피연산자를 필요로 하는 연산자로 끝나는 경우(다음 줄이 이 문장보다
      // 더 들여써져 있을 때만 — 그래야 새 블록의 시작과 안 헷갈린다).
      const stmtIndent = leadingIndentOf(raw);
      let nextIdx = li + 1;
      for(;;){
        if(nextIdx >= lines.length) break;
        const startsWithColon = /^[ \t]*:/.test(lines[nextIdx]);
        const trailingOpContinuation = endsWithContinuationOp() && leadingIndentOf(lines[nextIdx]) > stmtIndent && lines[nextIdx].trim() !== '' && !/^[ \t]*\/\//.test(lines[nextIdx]);
        if(!startsWithColon && !trailingOpContinuation) break;
        li = nextIdx;
        tokenizeLogicalLine(lines[li], li + 1, false);
        nextIdx = li + 1;
      }
      // The line(s) just joined above may have opened new parens, so check again
      // 위에서 이어붙인 줄이 새 괄호를 열었을 수도 있으니 다시 확인한다
      if(parenDepth === 0) tokens.push({ type: 'NEWLINE', value: '\n', line: lineNo });
    }
  }
  while(indentStack.length > 1){ indentStack.pop(); tokens.push({ type: 'DEDENT', value: 0, line: lines.length }); }
  tokens.push({ type: 'EOF', value: null, line: lines.length + 1 });
  return tokens;
}

// ============================================================
// 2. Parser — recursive descent. Builds the AST.
// ============================================================
// ============================================================
// 2. 파서 (Parser) — 재귀 하강. AST를 만든다.
// ============================================================
class PineParseError extends Error {
  constructor(msg, line){ super(msg); this.line = line; this.pineParse = true; }
}

const PINE_TYPE_WORDS = new Set(['int','float','bool','string','color','label','line','box','table','array','matrix','map','series','simple','const']);
// Qualifiers that appear before the actual type, e.g. 'series float x' — they have no effect on
// the value's type itself, so they are simply skipped when reading a type annotation (only the
// real type name that follows is kept).
// 'series float x' 처럼 실제 타입 앞에 붙는 한정자들 — 값의 타입 자체에는 영향이 없어서
// 타입 표기를 읽을 때 그냥 건너뛴다(뒤에 오는 진짜 타입 이름만 남긴다).
const PINE_TYPE_QUALIFIERS = new Set(['series','simple','const']);
// A static type is just a string: 'int', 'float', 'color', its name if it's a user type, or a
// generic notation like 'array<float>' / 'map<string,int>' for containers. The two helpers below
// split that notation back apart (the type is computed once during parsing/inference and cached on
// the node, so the string-parsing cost is not repeated on every bar).
// 정적 타입은 그냥 문자열이다: 'int', 'float', 'color', 사용자 타입이면 그 이름, 컨테이너면
// 'array<float>' / 'map<string,int>' 같은 제네릭 표기. 아래 두 헬퍼가 그 표기를 다시 쪼갠다
// (타입은 파싱/추론 때 한 번만 계산돼 노드에 캐시되므로, 문자열 파싱 비용이 매 봉 반복되지 않는다).
function pineTypeBaseWord(t){
  if(!t) return null;
  const i = t.indexOf('<');
  return i < 0 ? t : t.slice(0, i);
}
// 'map<string,array<float>>' -> ['string', 'array<float>'] (commas nested inside <> are not split)
// 'map<string,array<float>>' -> ['string', 'array<float>'] (중첩 <> 안의 콤마는 안 자른다)
function pineTypeArgWords(t){
  if(!t) return [];
  const i = t.indexOf('<');
  if(i < 0) return [];
  const inner = t.slice(i + 1, t.length - 1);
  const out = []; let depth = 0, cur = '';
  for(let k = 0; k < inner.length; k++){
    const c = inner[k];
    if(c === '<') depth++;
    else if(c === '>') depth--;
    if(c === ',' && depth === 0){ out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if(cur) out.push(cur);
  return out;
}

class PineParser {
  constructor(tokens){
    this.toks = tokens; // (This used to be copied wholesale with filter(t => true) — a copy that filters nothing out, which was wasteful) / (예전엔 filter(t => true)로 통째로 복사했다 — 아무것도 안 거르는 사본이라 낭비)
    this.pos = 0;
    this.nodeIdCounter = 1;
    // Scan for 'type Name' declarations once up front and collect just the names — during the
    // main parse (recursive descent, a single top-to-bottom pass), when a line like
    // "swing top = ..." is encountered, the parser needs to know right there that 'swing' is a
    // user-defined type name in order to recognize it as a type prefix and skip over it.
    // 'type Name' 선언들을 미리 한 번 훑어서 이름만 모아둔다 — 본 파싱(재귀 하강, 위→아래 한 번)
    // 중에 "swing top = ..." 같은 줄을 만났을 때, 'swing'이 사용자 정의 타입 이름이라는 걸
    // 그 자리에서 바로 알아야 타입 접두사로 인식하고 건너뛸 수 있기 때문.
    this.userTypeNames = new Set();
    for(let i = 0; i < this.toks.length - 2; i++){
      if(this.toks[i].type === 'IDENT' && this.toks[i].value === 'type' && this.toks[i + 1].type === 'IDENT' && this.toks[i + 2].type === 'NEWLINE'){
        this.userTypeNames.add(this.toks[i + 1].value);
      }
    }
  }
  isTypeWord(name){ return PINE_TYPE_WORDS.has(name) || this.userTypeNames.has(name); }
  peek(o = 0){ return this.toks[this.pos + o]; }
  at(type, value){
    const t = this.peek();
    if(t.type !== type) return false;
    if(value !== undefined && t.value !== value) return false;
    return true;
  }
  atOp(v){ return this.at('OP', v); }
  atKw(v){ return this.at('KEYWORD', v); }
  next(){ return this.toks[this.pos++]; }
  expectOp(v){
    if(!this.atOp(v)) throw new PineParseError(pineMsg(`'${v}' 가 와야 하는데 '${this.peek().value}' 를 만났습니다`, `Expected '${v}' but found '${this.peek().value}'`), this.peek().line);
    return this.next();
  }
  skipNewlines(){ while(this.at('NEWLINE')) this.next(); }

  parseProgram(){
    const body = [];
    this.skipNewlines();
    while(!this.at('EOF')){
      body.push(this.parseStatement());
      this.skipNewlines();
    }
    return { type: 'Program', body };
  }

  // Block: NEWLINE INDENT statements DEDENT
  // 블록: NEWLINE INDENT 문장들 DEDENT
  parseBlock(){
    this.skipNewlines();
    if(!this.at('INDENT')) throw new PineParseError(pineMsg('들여쓰기된 블록이 와야 합니다', 'An indented block is required here'), this.peek().line);
    this.next();
    const body = [];
    this.skipNewlines();
    while(!this.at('DEDENT') && !this.at('EOF')){
      body.push(this.parseStatement());
      this.skipNewlines();
    }
    if(this.at('DEDENT')) this.next();
    return body;
  }

  // Reads a single type annotation starting at token offset o. This annotation used to just be
  // counted and discarded as "number of tokens to skip"; now the declared type read here is the
  // starting point for static type inference (pine-types.js), because int/float or color/string
  // cannot be told apart from the runtime value alone (both are JS number / JS string). The return
  // value is { next: token offset right after the type annotation, type: 'float' | 'array<lvl>' |
  // ... }, or null if it isn't a type annotation. Generic arguments are reassembled verbatim,
  // including nesting (map<string, array<float>>).
  // 토큰 위치 o에서 타입 표기 하나를 읽는다. 예전엔 이런 표기를 전부 "건너뛸 토큰 개수"로만
  // 세고 버렸는데, int/float나 color/string은 런타임 값(둘 다 JS number / JS string)만 봐서는
  // 구분이 안 되기 때문에 여기서 읽은 선언 타입이 정적 타입 추론(pine-types.js)의 출발점이 된다.
  // 반환값은 { next: 타입 표기 다음 토큰의 오프셋, type: 'float' | 'array<lvl>' | ... }, 타입
  // 표기가 아니면 null. 제네릭 인자는 중첩(map<string, array<float>>)까지 원문 그대로 이어붙인다.
  readTypeAt(o){
    while(this.peek(o).type === 'IDENT' && PINE_TYPE_QUALIFIERS.has(this.peek(o).value)
          && this.peek(o + 1).type === 'IDENT' && this.isTypeWord(this.peek(o + 1).value)) o++;
    if(!(this.peek(o).type === 'IDENT' && this.isTypeWord(this.peek(o).value))) return null;
    let type = this.peek(o).value;
    o++;
    if(this.peek(o).type === 'OP' && this.peek(o).value === '<'){
      let depth = 1, inner = '';
      o++;
      while(depth > 0 && this.peek(o).type !== 'EOF'){
        const t = this.peek(o);
        if(t.type === 'OP' && t.value === '<') depth++;
        else if(t.type === 'OP' && t.value === '>'){ depth--; if(depth === 0){ o++; break; } }
        if(!(t.type === 'IDENT' && PINE_TYPE_QUALIFIERS.has(t.value))) inner += t.value;
        o++;
      }
      type += '<' + inner + '>';
    }
    // Array-suffix notation like 'line[] arr' — means the same thing as array<line>.
    // 'line[] arr' 같은 배열 접미사 표기 — array<line>과 같은 뜻이다.
    if(this.peek(o).type === 'OP' && this.peek(o).value === '[' && this.peek(o + 1).type === 'OP' && this.peek(o + 1).value === ']'){
      type = 'array<' + type + '>';
      o += 2;
    }
    return { next: o, type };
  }
  looksLikeTypeAnnotation(){
    // Detects type prefixes like "int len = ..." / "array<float> a = ..." / "series float x = ..."
    // (covers not just built-in type names but also user-defined type names the script declared
    // with 'type')
    // "int len = ..." / "array<float> a = ..." / "series float x = ..." 같은 타입 접두사 감지
    // (내장 타입 이름뿐 아니라 스크립트가 'type' 으로 선언한 사용자 정의 타입 이름도 포함)
    this.lastTypeAnnotation = null;
    const r = this.readTypeAt(0);
    if(!r) return 0;
    const after = this.peek(r.next + 1);
    // If what follows is "IDENT =" or "IDENT ," it is definitely a type declaration. "IDENT
    // end-of-line" (e.g. `float x`) is also accepted, as a declaration with no initial value —
    // finishVarDecl initializes it to na in that case.
    // 그 다음이 "IDENT =" 또는 "IDENT ," 면 확실히 타입 선언. "IDENT 줄끝"(예: `float x`)도
    // 초기값 없는 선언이라 같이 받는다 — finishVarDecl이 이 경우 na로 초기화한다.
    if(this.peek(r.next).type === 'IDENT' && (after.type === 'NEWLINE' || (after.type === 'OP' && (after.value === '=' || after.value === ',')))){
      this.lastTypeAnnotation = r.type;
      return r.next; // Number of tokens to consume / 소비해야 할 토큰 개수
    }
    return 0;
  }

  looksLikeTupleAssignment(){
    let depth = 0, o = 0;
    do {
      const t = this.peek(o);
      if(t.type === 'EOF') return false;
      if(t.type === 'OP' && t.value === '[') depth++;
      if(t.type === 'OP' && t.value === ']') depth--;
      o++;
    } while(depth > 0);
    const after = this.peek(o);
    return after.type === 'OP' && (after.value === '=' || after.value === ':=');
  }
  parseStatement(){
    const line = this.peek().line;
    if(this.at('IDENT', 'type') && this.peek(1).type === 'IDENT' && this.peek(2).type === 'NEWLINE'){
      return this.parseTypeDecl();
    }
    // 'method' is not a reserved word — it's a soft keyword recognized only from context (the same
    // way 'switch' is). The actual parsing is identical to a regular function declaration; the
    // only difference is a marker saying it can later also be invoked via dot(.) call syntax.
    // 'method'는 예약어가 아니라 문맥으로만 판단하는 소프트 키워드(switch와 같은 방식) —
    // 실제 파싱은 일반 함수 선언과 동일하고, 나중에 점(.) 호출로도 쓸 수 있다는 표시만 다르다.
    if(this.at('IDENT', 'method') && this.peek(1).type === 'IDENT'){
      this.next();
      const mExpr = this.parseExprList();
      if(!this.atOp('=>')) throw new PineParseError(pineMsg("'method' 뒤에는 함수 정의가 와야 합니다", "'method' must be followed by a function definition"), line);
      this.next();
      return this.finishFuncDecl(mExpr, line, true);
    }
    if(this.atKw('var') || this.atKw('varip')){
      const isVar = true; this.next();
      // A type prefix can also follow var (var float x = na)
      // var 뒤에도 타입 접두사가 올 수 있음 (var float x = na)
      const skip = this.looksLikeTypeAnnotation();
      const declType = this.lastTypeAnnotation;
      for(let k = 0; k < skip; k++) this.next();
      return this.finishVarDecl(isVar, line, declType);
    }
    const typeSkip = this.looksLikeTypeAnnotation();
    if(typeSkip){
      const declType = this.lastTypeAnnotation;
      for(let k = 0; k < typeSkip; k++) this.next();
      return this.finishVarDecl(false, line, declType);
    }
    if(this.atOp('[') && this.looksLikeTupleAssignment()) return this.parseTupleStatement(line);
    if(this.atKw('if')) return this.parseIf();
    if(this.atKw('for')) return this.parseForOrForIn();
    if(this.atKw('while')) return this.parseWhile();
    if(this.atKw('switch')) return this.parseSwitch();
    if(this.atKw('break')){ this.next(); return { type: 'Break', line }; }
    if(this.atKw('continue')){ this.next(); return { type: 'Continue', line }; }

    const expr = this.parseExprList();
    if(this.atOp('=>')){
      this.next();
      return this.finishFuncDecl(expr, line);
    }
    if(this.atOp('=')){
      this.next();
      if(expr.type !== 'Ident') throw new PineParseError(pineMsg('할당 대상은 단순 변수명이어야 합니다', 'Assignment target must be a simple variable name'), line);
      const init = this.parseAssignInit();
      const stmt = { type: 'VarDecl', isVar: false, name: expr.name, init, line };
      return this.chainCommaStatements(stmt, line);
    }
    if(this.atOp(':=') || (this.at('OP') && PINE_COMPOUND_ASSIGN_OPS.has(this.peek().value))){
      const opTok = this.next();
      // obj.field := value — a common pattern for directly reassigning a field on a user-defined
      // type (struct) instance
      // obj.field := value — 사용자 정의 타입(struct) 인스턴스의 필드를 직접 재할당하는 흔한 패턴
      if(expr.type === 'Member'){
        let value = this.parseExprList();
        if(opTok.value !== ':='){
          const binOp = opTok.value[0];
          value = { type: 'Binary', op: binOp, left: expr, right: value, line };
        }
        return { type: 'FieldReassign', target: expr, value, line };
      }
      if(expr.type !== 'Ident') throw new PineParseError(pineMsg("재할당 대상은 단순 변수명이거나 필드 접근(obj.field)이어야 합니다", "Reassignment target must be a simple variable name or a field access (obj.field)"), line);
      let value = this.parseExprList();
      if(opTok.value !== ':='){
        const binOp = opTok.value[0];
        value = { type: 'Binary', op: binOp, left: { type: 'Ident', name: expr.name, line }, right: value, line };
      }
      return { type: 'Reassign', name: expr.name, value, line };
    }
    return { type: 'ExprStmt', expr, line };
  }

  // type Name \n INDENT (typeword fieldname [= default])* DEDENT — a user-defined type declaration
  // similar to a struct. Field lines always have the form "type fieldname [= default]" (Pine
  // requires a type annotation on struct fields), so the leading type part (including generic
  // <..> and array [] suffixes) is not used for the value itself and is simply skipped over.
  // type Name \n INDENT (타입어 필드명 [= 기본값])* DEDENT — struct와 비슷한 사용자 정의 타입 선언.
  // 필드 줄은 항상 "타입 필드명 [= 기본값]" 형태라서(Pine은 struct 필드에 타입 표기가 필수),
  // 맨 앞의 타입 부분(제네릭 <..>, 배열 [] 접미사 포함)은 값 자체는 안 쓰고 그냥 건너뛴다.
  parseTypeDecl(){
    const line = this.peek().line;
    this.next(); // 'type' / 'type'
    const nameTok = this.next();
    if(nameTok.type !== 'IDENT') throw new PineParseError(pineMsg('타입 이름이 와야 합니다', 'A type name is required'), line);
    this.skipNewlines();
    if(!this.at('INDENT')) throw new PineParseError(pineMsg('타입 필드 블록이 필요합니다', 'An indented field block is required'), line);
    this.next();
    const fields = [];
    this.skipNewlines();
    while(!this.at('DEDENT') && !this.at('EOF')){
      const fLine = this.peek().line;
      // A field line always starts with a type annotation (it cannot be omitted) — e.g. in
      // "array<float> samples" what immediately follows the type name may be a generic <...>
      // rather than the field name, so instead of checking ahead whether the next token is IDENT,
      // the leading IDENT is unconditionally treated and consumed as the type. That type name is
      // the only clue to the field value's static type (e.g. 'int qty' and 'float qty' have the
      // identical runtime value, a JS number), so it is kept as declType rather than discarded.
      // 필드 줄은 항상 타입 표기로 시작한다(생략 불가) — "array<float> samples"처럼 타입 이름
      // 바로 뒤에 필드명이 아니라 제네릭 <...>가 먼저 올 수도 있어서, 다음 토큰이 IDENT인지
      // 미리 확인하지 않고 무조건 맨 앞 IDENT를 타입으로 보고 소비한다. 그 타입 이름은
      // 필드 값의 정적 타입을 아는 유일한 단서라(예: 'int qty'와 'float qty'는 런타임 값이
      // 똑같이 JS number다) 버리지 않고 declType으로 남긴다.
      let fieldType = null;
      if(this.at('IDENT')){
        // The type name that appears here may be in neither PINE_TYPE_WORDS nor userTypeNames
        // (e.g. a recursive type referencing itself) — so instead of relying on readTypeAt's
        // isTypeWord check, it uses that check when it succeeds and otherwise falls back to
        // treating the leading IDENT alone as the type, as before.
        // 여기 오는 타입 이름은 PINE_TYPE_WORDS에도 userTypeNames에도 없을 수 있다(자기 자신을
        // 참조하는 재귀 타입 등) — 그래서 readTypeAt의 isTypeWord 검사에 기대지 않고, 있으면 쓰고
        // 없으면 예전처럼 맨 앞 IDENT 하나를 타입으로 보고 넘어간다.
        const r = this.readTypeAt(0);
        if(r && this.peek(r.next).type === 'IDENT'){
          fieldType = r.type;
          for(let k = 0; k < r.next; k++) this.next();
        } else {
          fieldType = this.peek().value;
          this.next(); // The field's type name / 필드의 타입 이름
          if(this.atOp('<')){
            let depth = 1; this.next();
            while(depth > 0 && !this.at('EOF')){
              if(this.atOp('<')) depth++;
              if(this.atOp('>')) depth--;
              this.next();
            }
          }
          if(this.atOp('[') && this.peek(1).type === 'OP' && this.peek(1).value === ']'){ this.next(); this.next(); fieldType = 'array<' + fieldType + '>'; }
        }
      }
      const fnameTok = this.next();
      if(fnameTok.type !== 'IDENT') throw new PineParseError(pineMsg('필드 이름이 와야 합니다', 'A field name is required'), fLine);
      let def = null;
      if(this.atOp('=')){ this.next(); def = this.parseExprList(); }
      fields.push({ name: fnameTok.value, declType: fieldType, default: def, line: fLine });
      this.skipNewlines();
    }
    if(this.at('DEDENT')) this.next();
    return { type: 'TypeDecl', name: nameTok.value, fields, line };
  }

  // A comma-separated list of expressions (for tuple returns): a, b, c
  // 콤마로 이어진 식 목록(튜플 반환용): a, b, c
  parseExprList(){
    const first = this.parseTernary();
    if(this.atOp(',')){
      const items = [first];
      while(this.atOp(',')){ this.next(); items.push(this.parseTernary()); }
      return { type: 'ExprList', items, line: first.line };
    }
    return first;
  }

  // Parser dedicated to the right-hand side of an assignment statement (`x = ...`). Nearly
  // identical to parseExprList, but if what follows a comma looks like the start of a new
  // statement (e.g. `IDENT = ...`, `var IDENT = ...`), that comma is left alone instead of being
  // consumed as part of a tuple list — Pine v1–v3 scripts commonly use the idiom of chaining
  // several assignment statements on one line with commas, like `a = expr1, b = expr2`, and since
  // assigning a tuple to a single scalar variable makes no sense in the first place, a comma in
  // this position should always be read as "the next statement starts here." A genuine tuple
  // return (e.g. a bare `a, b` on a function's last line) uses parseExprList directly at that
  // site, so it is unaffected here.
  // 대입문(`x = ...`)의 우변 전용 파서. parseExprList와 거의 같지만, 콤마 뒤가 새 문장의 시작처럼
  // 보이면(예: `IDENT = ...`, `var IDENT = ...`) 그 콤마를 튜플 목록의 일부로 먹어버리지 않고 그대로
  // 남겨둔다 — Pine v1~v3 스크립트에는 `a = expr1, b = expr2`처럼 한 줄에 콤마로 여러 대입문을 잇는
  // 관용구가 흔한데, 스칼라 변수 하나에 튜플을 대입하는 건애초에 말이 안 되므로 이 경우 콤마는 항상
  // "다음 문장 시작"으로 해석하는 게 맞다. 진짜 튜플 반환(예: 함수 마지막 줄의 bare `a, b`)은 그
  // 자리에서 직접 parseExprList를 쓰므로 여기선 영향 없다.
  parseAssignInit(){
    const first = this.parseTernary();
    if(this.atOp(',') && this.commaStartsNewStatement()) return first;
    if(this.atOp(',')){
      const items = [first];
      while(this.atOp(',') && !this.commaStartsNewStatement()){ this.next(); items.push(this.parseTernary()); }
      return items.length > 1 ? { type: 'ExprList', items, line: first.line } : items[0];
    }
    return first;
  }
  // Assumes the current token is ',' at the point this is called. Returns true if what follows the
  // comma has the shape of a new statement (a simple assignment, a var/varip declaration, or a
  // type-prefixed declaration).
  // 호출 시점에 현재 토큰이 ',' 라고 가정한다. 콤마 다음이 새 문장의 시작 모양(단순 대입,
  // var/varip 선언, 타입 접두사 선언)이면 true.
  commaStartsNewStatement(){
    const n1 = this.peek(1), n2 = this.peek(2);
    if(n1.type === 'IDENT' && (n1.value === 'var' || n1.value === 'varip')) return true;
    if(n1.type === 'IDENT' && n2.type === 'OP' && n2.value === '=') return true;
    return false;
  }
  // After parsing a statement, if the current token is a "comma chaining the next statement," keep
  // parsing and merge the statements into one before returning. If it isn't a comma (the usual
  // one-statement-per-line case) or what follows doesn't look like a new statement (e.g. a genuine
  // tuple expression), the original statement is returned unchanged — that case will already have
  // been handled by its own parser (parseExprList, etc.).
  // 문장 파싱 후 현재 토큰이 "새 문장을 잇는 콤마"이면 계속 이어 파싱해서 하나로 묶어 반환한다.
  // 콤마가 아니거나(보통의 한 줄 한 문장) 다음 문장 모양이 아니면(진짜 튜플 표현식 등) 원래
  // 문장을 그대로 반환한다 — 그런 경우는 각자의 파서(parseExprList 등)가 이미 처리했을 것.
  chainCommaStatements(firstStmt, line){
    if(!(this.atOp(',') && this.commaStartsNewStatement())) return firstStmt;
    const stmts = [firstStmt];
    while(this.atOp(',') && this.commaStartsNewStatement()){
      this.next();
      stmts.push(this.parseStatement());
    }
    return { type: 'Seq', stmts, line };
  }

  parseTupleStatement(line){
    this.expectOp('[');
    const names = [];
    while(!this.atOp(']')){
      const t = this.next();
      if(t.type !== 'IDENT') throw new PineParseError(pineMsg('튜플 요소는 변수명이어야 합니다', 'Tuple elements must be variable names'), line);
      names.push(t.value);
      if(this.atOp(',')) this.next();
    }
    this.expectOp(']');
    const isAssign = this.atOp('=');
    const isReassign = this.atOp(':=');
    if(!isAssign && !isReassign) throw new PineParseError(pineMsg("튜플 뒤에는 '=' 또는 ':=' 가 와야 합니다", "Tuple must be followed by '=' or ':='"), line);
    this.next();
    const value = this.parseExprList();
    return { type: isAssign ? 'TupleDecl' : 'TupleReassign', names, value, line };
  }

  finishVarDecl(isVar, line, declType){
    const t = this.next();
    if(t.type !== 'IDENT') throw new PineParseError(pineMsg('변수명이 와야 합니다', 'A variable name is required'), line);
    const name = t.value;
    if(!this.atOp('=')){
      // A declaration with no initial value (e.g. `float x`) - initialize to na
      // 초기값 없는 선언 (예: `float x`) - na로 초기화
      return { type: 'VarDecl', isVar, name, declType: declType || null, init: { type: 'Na', line }, line };
    }
    this.next();
    const init = this.parseAssignInit();
    const stmt = { type: 'VarDecl', isVar, name, declType: declType || null, init, line };
    return this.chainCommaStatements(stmt, line);
  }

  // Converts to a function declaration: callExpr is Call(callee=Ident, args=[Ident or
  // named(Ident=default)]). If isMethod is true, this is a function declared with the 'method'
  // prefix — the type annotation of the first parameter is remembered (as methodOfType) so it can
  // later also be invoked via obj.funcName(...) dot-call syntax.
  // 함수 선언으로 변환: callExpr는 Call(callee=Ident, args=[Ident 또는 named(Ident=default)])
  // isMethod가 true면 'method' 접두사로 선언된 함수 — 첫 매개변수의 타입 표기를 기억해뒀다가
  // (methodOfType) 나중에 obj.funcName(...) 점(dot) 호출로도 실행할 수 있게 한다.
  finishFuncDecl(callExpr, line, isMethod){
    if(callExpr.type !== 'Call' || callExpr.callee.type !== 'Ident'){
      throw new PineParseError(pineMsg("'=>' 앞에는 'funcName(params)' 형태가 와야 합니다", "'=>' must be preceded by 'funcName(params)'"), line);
    }
    const params = [];
    // Pine lets a parameter carry a type, e.g. ma(float source, int length, simple string
    // maType) => . The parser reads 'float' and 'source' as two separate arguments, so a type word
    // followed by another name is treated as a 'type modifier' and skipped rather than as a
    // parameter (this applies to user-defined type names as well as built-in ones).
    // Pine은 매개변수에 타입을 붙일 수 있다: ma(float source, int length, simple string maType) =>
    // 파서는 'float'와 'source'를 각각 별개 인자로 읽으므로, 뒤에 이름이 더 따라오는 타입 단어는
    // 매개변수가 아니라 '타입 수식어'로 보고 건너뛴다(내장 타입 이름뿐 아니라 사용자 정의 타입도).
    const rawArgs = callExpr.args;
    let methodOfType = null;
    // The type annotation written on a parameter used to just be skipped and discarded; now it is
    // kept as declType — static type inference uses it as the parameter's starting type when it
    // walks the function body, and it's also the basis for the first parameter's type
    // (methodOfType) when choosing among method overload candidates.
    // 매개변수에 적힌 타입 표기는 예전엔 그냥 건너뛰고 버렸는데, 지금은 declType으로 남긴다 —
    // 정적 타입 추론이 함수 본문을 훑을 때 매개변수의 출발 타입으로 쓰고, method 오버로드
    // 후보를 고를 때 첫 매개변수 타입(methodOfType)의 근거가 된다.
    const pushParam = (nameArg, declType) => {
      if(nameArg.named){ params.push({ name: nameArg.name, declType: declType || null, default: nameArg.value }); }
      else if(nameArg.value.type === 'Ident'){ params.push({ name: nameArg.value.name, declType: declType || null, default: null }); }
      else throw new PineParseError(pineMsg('함수 매개변수는 변수명이어야 합니다', 'Function parameters must be variable names'), line);
    };
    for(let i = 0; i < rawArgs.length; i++){
      const a = rawArgs[i];
      // For a parameter with a generic type like 'array<lvl> levels', parseArgs has already read
      // the type and attached it as declType (in this case a.value is just the parameter's "name"
      // alone).
      // 'array<lvl> levels'처럼 제네릭이 붙은 매개변수는 parseArgs가 이미 타입까지 읽어서
      // declType으로 붙여 보낸다(이 경우 a.value는 매개변수 "이름" 하나뿐이다).
      if(!a.named && a.declType){
        if(isMethod && params.length === 0 && methodOfType === null) methodOfType = pineTypeBaseWord(a.declType);
        pushParam(a, a.declType);
        continue;
      }
      if(!a.named && a.value.type === 'Ident' && this.isTypeWord(a.value.name) && i + 1 < rawArgs.length){
        // There are also cases where a qualifier and a type appear back to back as two words, like
        // 'simple string maType' (simple/series/const + built-in type) — the qualifier isn't the
        // value's type, so the real type is the last type word.
        // 'simple string maType'처럼 한정자+타입 두 단어가 연달아 붙는 경우(simple/series/const +
        // 내장 타입)도 있다 — 한정자는 값의 타입이 아니므로 실제 타입은 마지막 타입 단어다.
        let declType = PINE_TYPE_QUALIFIERS.has(a.value.name) ? null : a.value.name;
        if(a.value.arraySuffix && declType) declType = 'array<' + declType + '>';
        // The next argument is necessarily the parameter name — it must be consumed right here.
        // Simply leaving it to continue's next iteration would, whenever the parameter name
        // happens to match a type word (e.g. a 'kz kz' parameter taking user type kz), cause that
        // name token to be mistaken for yet another type modifier and skipped, shifting every
        // following parameter over by one slot.
        // 다음 인자는 무조건 매개변수 이름이다 — 곧바로 여기서 소비해야 한다. 그냥 continue로
        // 다음 반복에 맡기면, 매개변수 이름이 타입 단어와 우연히 같을 때(예: 사용자 타입 kz를 받는
        // 'kz kz' 매개변수) 그 이름 토큰이 또 다른 타입 수식어로 오인되어 건너뛰어지고, 뒤따르는
        // 모든 매개변수가 한 칸씩 밀려버린다.
        i++;
        while(!rawArgs[i].named && rawArgs[i].value.type === 'Ident' && this.isTypeWord(rawArgs[i].value.name) && i + 1 < rawArgs.length){
          const w = rawArgs[i].value;
          if(!PINE_TYPE_QUALIFIERS.has(w.name)) declType = w.arraySuffix ? 'array<' + w.name + '>' : w.name;
          i++;
        }
        if(isMethod && params.length === 0 && methodOfType === null) methodOfType = pineTypeBaseWord(declType);
        pushParam(rawArgs[i], declType);
        continue;
      }
      pushParam(a, null);
    }
    let body;
    if(this.at('NEWLINE')){
      body = this.parseBlock();
    } else {
      body = [{ type: 'ExprStmt', expr: this.parseExprList(), line }];
    }
    return { type: 'FuncDecl', name: callExpr.callee.name, params, body, line, isMethod: !!isMethod, methodOfType };
  }

  parseIf(){
    const line = this.peek().line; this.next(); // 'if'
    const cond = this.parseExprList();
    const then = this.at('NEWLINE') ? this.parseBlock() : [{ type: 'ExprStmt', expr: this.parseExprList(), line }];
    let elseBody = null;
    // else / else if must be at the same indentation level, so peek at the very next token right
    // after consuming the block
    // else / else if 는 같은 들여쓰기 레벨에 있어야 하므로, 블록을 소비한 다음 바로 다음 토큰을 본다
    this.skipNewlinesIfNoDedentAhead();
    if(this.atKw('else')){
      this.next();
      if(this.atKw('if')){
        elseBody = [this.parseIf()];
      } else {
        elseBody = this.at('NEWLINE') ? this.parseBlock() : [{ type: 'ExprStmt', expr: this.parseExprList(), line }];
      }
    }
    return { type: 'If', cond, then, elseBody, line };
  }
  // To handle else appearing on the next line, peek slightly ahead past the NEWLINEs right after a block ends
  // else가 다음 줄에 오는 경우를 위해, 블록이 끝난 직후 NEWLINE들을 살짝 미리보기
  skipNewlinesIfNoDedentAhead(){
    let o = 0;
    while(this.peek(o).type === 'NEWLINE') o++;
    if(this.peek(o).type === 'KEYWORD' && this.peek(o).value === 'else'){
      while(this.at('NEWLINE')) this.next();
    }
  }

  parseForOrForIn(){
    const line = this.peek().line; this.next(); // 'for'
    let varName, idxName = null;
    if(this.atOp('[')){
      // for [index, element] in array — this is Pine's actual syntax for iterating index and value
      // together (a counting for-loop never starts with '[', so distinguishing here is safe).
      // Inside the brackets, the index comes first.
      // for [index, element] in array — 실제 Pine의 인덱스+값 동시 순회 문법(카운팅 for는
      // 절대 '['로 시작하지 않으므로 여기서 구분해도 안전하다). 대괄호 안은 인덱스가 먼저다.
      this.next();
      const idxTok = this.next();
      if(idxTok.type !== 'IDENT') throw new PineParseError(pineMsg('for 인덱스 변수명이 필요합니다', 'A for-loop index variable name is required'), line);
      idxName = idxTok.value;
      this.expectOp(',');
      const valTok = this.next();
      if(valTok.type !== 'IDENT') throw new PineParseError(pineMsg('for 변수명이 필요합니다', 'A for-loop variable name is required'), line);
      varName = valTok.value;
      this.expectOp(']');
    } else {
      const nameTok = this.next();
      if(nameTok.type !== 'IDENT') throw new PineParseError(pineMsg('for 변수명이 필요합니다', 'A for-loop variable name is required'), line);
      varName = nameTok.value;
      if(this.atOp(',')){
        this.next();
        const idxTok = this.next();
        if(idxTok.type !== 'IDENT') throw new PineParseError(pineMsg('for 인덱스 변수명이 필요합니다', 'A for-loop index variable name is required'), line);
        idxName = idxTok.value;
      }
    }
    if(this.atKw('in')){
      this.next();
      const iterable = this.parseTernary();
      const body = this.parseBlock();
      return { type: 'ForIn', varName, idxName, iterable, body, line };
    }
    if(idxName != null) throw new PineParseError(pineMsg("'in'이 와야 합니다", "'in' is required here"), line);
    const nameTok = { value: varName };
    this.expectOp('=');
    const from = this.parseTernary();
    if(!this.atKw('to')) throw new PineParseError(pineMsg("for 문에는 'to' 가 필요합니다", "'to' is required in a for statement"), line);
    this.next();
    const to = this.parseTernary();
    let step = null;
    if(this.atKw('by')){ this.next(); step = this.parseTernary(); }
    const body = this.parseBlock();
    return { type: 'For', varName: nameTok.value, from, to, step, body, line };
  }

  parseWhile(){
    const line = this.peek().line; this.next();
    const cond = this.parseExprList();
    const body = this.parseBlock();
    return { type: 'While', cond, body, line };
  }

  parseSwitch(){
    const line = this.peek().line; this.next(); // 'switch' (IDENT, not a reserved word) / 'switch' (IDENT, 예약어 아님)
    let subject = null;
    if(!this.at('NEWLINE')) subject = this.parseExprList();
    this.skipNewlines();
    if(!this.at('INDENT')) throw new PineParseError(pineMsg('switch 블록이 필요합니다', 'A switch block is required'), line);
    this.next();
    const cases = []; let def = null;
    while(!this.at('DEDENT') && !this.at('EOF')){
      this.skipNewlines();
      if(this.at('DEDENT') || this.at('EOF')) break;
      if(this.atOp('=>')){
        this.next();
        def = this.at('NEWLINE') ? this.parseBlock() : [{ type: 'ExprStmt', expr: this.parseExprList(), line }];
      } else {
        const val = this.parseExprList();
        this.expectOp('=>');
        const body = this.at('NEWLINE') ? this.parseBlock() : [{ type: 'ExprStmt', expr: this.parseExprList(), line }];
        cases.push({ val, body });
      }
      this.skipNewlines();
    }
    if(this.at('DEDENT')) this.next();
    return { type: 'Switch', subject, cases, def, line };
  }

  // ---- Expression parser chain ----
  // ---- 식(expression) 파서 체인 ----
  parseTernary(){
    const cond = this.parseOr();
    if(this.atOp('?')){
      this.next();
      const a = this.parseTernary();
      this.expectOp(':');
      const b = this.parseTernary();
      return { type: 'Ternary', cond, then: a, else: b, line: cond.line, id: this.nodeIdCounter++ };
    }
    return cond;
  }
  parseOr(){
    let l = this.parseAnd();
    while(this.atKw('or')){ this.next(); const r = this.parseAnd(); l = { type: 'Binary', op: 'or', left: l, right: r, line: l.line }; }
    return l;
  }
  parseAnd(){
    let l = this.parseNot();
    while(this.atKw('and')){ this.next(); const r = this.parseNot(); l = { type: 'Binary', op: 'and', left: l, right: r, line: l.line }; }
    return l;
  }
  parseNot(){
    if(this.atKw('not')){ const line = this.peek().line; this.next(); return { type: 'Unary', op: 'not', arg: this.parseNot(), line }; }
    return this.parseCompare();
  }
  parseCompare(){
    let l = this.parseAdd();
    while(this.at('OP') && PINE_COMPARE_OPS.has(this.peek().value)){
      const op = this.next().value; const r = this.parseAdd();
      l = { type: 'Binary', op, left: l, right: r, line: l.line };
    }
    return l;
  }
  parseAdd(){
    let l = this.parseMul();
    while((this.atOp('+') || this.atOp('-'))){
      const op = this.next().value; const r = this.parseMul();
      l = { type: 'Binary', op, left: l, right: r, line: l.line };
    }
    return l;
  }
  parseMul(){
    let l = this.parseUnary();
    while(this.atOp('*') || this.atOp('/') || this.atOp('%')){
      const op = this.next().value; const r = this.parseUnary();
      l = { type: 'Binary', op, left: l, right: r, line: l.line };
    }
    return l;
  }
  parseUnary(){
    if(this.atOp('-') || this.atOp('+')){
      const op = this.next().value; const arg = this.parseUnary();
      return { type: 'Unary', op, arg, line: arg.line };
    }
    return this.parsePostfix();
  }
  parsePostfix(){
    let node = this.parsePrimary();
    for(;;){
      if(this.atOp('.')){
        this.next();
        const t = this.next();
        if(t.type !== 'IDENT') throw new PineParseError(pineMsg('. 뒤에는 이름이 와야 합니다', "A name must follow '.'"), t.line);
        node = { type: 'Member', obj: node, prop: t.value, line: node.line };
        // Syntax like array.new<Type>(...) / matrix.new<Type>(...) / map.new<K,V>(...), where a
        // generic type argument in <...> is attached after the function name — since types are
        // dynamic, the type argument itself is discarded and only the following (...) call
        // arguments continue to be parsed. Because '<' could genuinely be a "less than" comparison,
        // it is only consumed when it comes right after '.new' and is followed by a matching '>'
        // that is immediately followed by '(' (to avoid false positives).
        // array.new<Type>(...) / matrix.new<Type>(...) / map.new<K,V>(...) 처럼 함수 이름 뒤에
        // 제네릭 타입 인자를 <...>로 붙이는 문법 — 동적 타입이라 타입 인자 자체는 버리고 뒤따르는
        // (...) 호출 인자만 이어서 파싱한다. '<'가 진짜 "보다 작다" 비교식일 수도 있어서, '.new'
        // 뒤에 오고 실제로 짝이 맞는 '>' 바로 뒤에 '('가 있을 때만 소비한다(오탐 방지).
        if(t.value === 'new' && this.atOp('<') && this.looksLikeGenericArgs()){
          // The type argument has no effect on runtime behavior (types are dynamic), but it is
          // used as-is by static type inference — this is the only place that reveals that the
          // result of array.new<int>() is array<int>.
          // 타입 인자는 런타임 동작에는 영향이 없지만(동적 타입) 정적 타입 추론에는 그대로
          // 쓰인다 — array.new<int>()의 결과가 array<int>임을 여기서만 알 수 있다.
          node.typeArgs = this.readGenericArgs();
        }
      } else if(this.atOp('(')){
        node = { type: 'Call', callee: node, args: this.parseArgs(), line: node.line, id: this.nodeIdCounter++ };
      } else if(this.atOp('[')){
        // Array-type notation like 'line[] arr' (common on v6 typed function parameters / struct
        // fields) — real indexing (x[1], x[i]) always has an expression inside the brackets, so
        // empty brackets (immediately followed by ']') can never be indexing, only a type suffix.
        // This site parses a function as "just an ordinary call expression" first and only
        // recognizes it as a function declaration once it sees '=>' afterward, so only the
        // brackets are consumed and the node is left as-is — that way finishFuncDecl's isTypeWord
        // skip logic can still see the type name (e.g. line) intact.
        // 'line[] arr' 같은 배열 타입 표기(v6 타입 붙은 함수 매개변수/구조체 필드에서 자주 나옴) —
        // 실제 인덱싱(x[1], x[i])은 대괄호 안에 항상 식이 있으므로 대괄호가 비어있으면(바로 ']')
        // 절대 인덱싱이 아니라 타입 접미사다. 이 자리는 함수를 "일단 평범한 호출식"으로 파싱한 뒤
        // '=>'를 보고 나서야 함수 선언인 걸 알아채는 구조라, finishFuncDecl의 isTypeWord 스킵 로직이
        // 타입 이름(예: line)을 그대로 볼 수 있게 대괄호만 소비하고 노드는 그대로 둔다.
        if(this.peek(1).type === 'OP' && this.peek(1).value === ']'){
          this.next(); this.next();
          // The node is left as-is; only a marker saying "[] was attached" is kept — finishFuncDecl
          // sees this and records the parameter type of 'float[] src' as array<float> rather than
          // float.
          // 노드는 그대로 두되 "[] 가 붙어 있었다"는 표시만 남긴다 — finishFuncDecl이 이걸 보고
          // 'float[] src'의 매개변수 타입을 float이 아니라 array<float>로 기록한다.
          node.arraySuffix = true;
          continue;
        }
        this.next();
        const idx = this.parseTernary();
        this.expectOp(']');
        node = { type: 'Index', obj: node, index: idx, line: node.line, id: this.nodeIdCounter++ };
      } else break;
    }
    return node;
  }
  looksLikeGenericArgs(){
    let depth = 0, o = 0;
    do{
      const t = this.peek(o);
      if(t.type === 'EOF' || t.type === 'NEWLINE') return false;
      if(t.type === 'OP' && t.value === '<') depth++;
      else if(t.type === 'OP' && t.value === '>') depth--;
      o++;
    } while(depth > 0);
    return this.peek(o).type === 'OP' && this.peek(o).value === '(';
  }
  // Consumes '<int>' / '<string, float>' and returns a list of type names split on top-level commas.
  // '<int>' / '<string, float>' 를 소비하면서 최상위 콤마 기준으로 쪼갠 타입 이름 목록을 돌려준다.
  readGenericArgs(){
    let depth = 0;
    const parts = []; let cur = '';
    do{
      const t = this.next();
      if(t.type === 'OP' && t.value === '<'){
        depth++;
        if(depth === 1) continue; // The outermost '<' is not included in the notation / 바깥쪽 '<'는 표기에 안 넣는다
      } else if(t.type === 'OP' && t.value === '>'){
        depth--;
        if(depth === 0) break;
      } else if(t.type === 'OP' && t.value === ',' && depth === 1){
        parts.push(cur); cur = ''; continue;
      }
      if(!(t.type === 'IDENT' && PINE_TYPE_QUALIFIERS.has(t.value))) cur += t.value;
    } while(depth > 0);
    if(cur) parts.push(cur);
    return parts;
  }
  // Detects a function parameter with a generic type attached, like 'array<lvl> levels'. At this
  // point it's still being parsed as "just an argument list" without knowing yet whether it's a
  // function declaration or a plain call, so left untouched, '<' and '>' would just be read as
  // comparison operators, producing a nonsensical expression like 'array < lvl > levels' (which
  // then errors in finishFuncDecl with "Function parameters must be variable names"). Single-word
  // types (e.g. 'float source') are already skipped on the finishFuncDecl side, so this handles
  // only the narrower case of a generic (<...>) attached.
  // 'array<lvl> levels' 같은 제네릭 타입이 붙은 함수 매개변수 감지. 이 자리는 아직 함수 선언인지
  // 그냥 호출인지 모르는 채로 "일단 인자 목록"으로 파싱하는 중이라, 손 안 대면 '<' '>' 가 그냥
  // 비교 연산자로 읽혀서 'array < lvl > levels' 같은 엉뚱한 식이 되어버린다(그러다 finishFuncDecl에서
  // "매개변수는 변수명이어야 합니다" 에러). 단일 단어 타입(예: 'float source')은 이미 finishFuncDecl
  // 쪽에서 스킵 처리가 되므로, 여기서는 제네릭(<...>)이 붙은 경우만 좁혀서 처리한다.
  looksLikeGenericTypedArg(){
    this.lastGenericArgType = null;
    if(!(this.peek(1).type === 'OP' && this.peek(1).value === '<')) return 0;
    const r = this.readTypeAt(0);
    if(!r) return 0;
    if(this.peek(r.next).type === 'IDENT'){
      const after = this.peek(r.next + 1);
      if(after.type === 'OP' && (after.value === ',' || after.value === ')')){
        this.lastGenericArgType = r.type;
        return r.next;
      }
    }
    return 0;
  }
  parseArgs(){
    this.expectOp('(');
    const args = [];
    this.skipNewlines();
    while(!this.atOp(')')){
      this.skipNewlines();
      const genericSkip = this.looksLikeGenericTypedArg();
      if(genericSkip){
        const argType = this.lastGenericArgType;
        for(let k = 0; k < genericSkip; k++) this.next();
        const nameTok = this.next();
        args.push({ named: false, declType: argType, value: { type: 'Ident', name: nameTok.value, line: nameTok.line } });
      } else if(this.at('IDENT') && this.peek(1).type === 'OP' && this.peek(1).value === '='){
        // named arg: IDENT '=' Expr  (excluding a comparison like IDENT '==', so check that the next token is a single '=')
        // named arg: IDENT '=' Expr  (단, IDENT '==' 같은 비교 연산은 제외해야 하므로 다음 토큰이 '=' 하나인지 확인)
        const nameTok = this.next(); this.next();
        const value = this.parseTernary();
        args.push({ named: true, name: nameTok.value, value });
      } else {
        args.push({ named: false, value: this.parseTernary() });
      }
      this.skipNewlines();
      if(this.atOp(',')){ this.next(); this.skipNewlines(); }
    }
    this.expectOp(')');
    return args;
  }
  parsePrimary(){
    const t = this.peek();
    if(t.type === 'NUMBER'){ this.next(); return { type: 'Number', value: t.value, isInt: t.isInt, line: t.line }; }
    if(t.type === 'STRING'){ this.next(); return { type: 'String', value: t.value, isColor: t.isColor, line: t.line }; }
    if(t.type === 'KEYWORD' && t.value === 'true'){ this.next(); return { type: 'Bool', value: true, line: t.line }; }
    if(t.type === 'KEYWORD' && t.value === 'false'){ this.next(); return { type: 'Bool', value: false, line: t.line }; }
    if(t.type === 'KEYWORD' && t.value === 'na'){
      if(this.peek(1).type === 'OP' && this.peek(1).value === '('){ this.next(); return { type: 'Ident', name: 'na', line: t.line }; }
      this.next(); return { type: 'Na', line: t.line };
    }
    if(t.type === 'KEYWORD' && t.value === 'if'){ return this.parseIf(); }
    if(t.type === 'KEYWORD' && t.value === 'switch'){ return this.parseSwitch(); }
    if(t.type === 'IDENT'){ this.next(); return { type: 'Ident', name: t.value, line: t.line }; }
    if(t.type === 'OP' && t.value === '('){
      this.next();
      this.skipNewlines();
      const e = this.parseExprList();
      this.skipNewlines();
      this.expectOp(')');
      return e;
    }
    if(t.type === 'OP' && t.value === '['){
      this.next();
      this.skipNewlines();
      const items = [];
      while(!this.atOp(']')){
        items.push(this.parseTernary());
        this.skipNewlines();
        if(this.atOp(',')){ this.next(); this.skipNewlines(); }
      }
      this.expectOp(']');
      return { type: 'ArrayLiteral', items, line: t.line };
    }
    throw new PineParseError(pineMsg(`예상치 못한 토큰 '${t.value === null ? t.type : t.value}'`, `Unexpected token '${t.value === null ? t.type : t.value}'`), t.line);
  }
}

function pineParse(source){
  const tokens = pineTokenize(source);
  const parser = new PineParser(tokens);
  const ast = parser.parseProgram();
  // Immediately after parsing, exactly once, static types are attached across the whole AST
  // (pine-types.js). This adds nothing to the execution path that repeats every bar — the result
  // is cached on each node and merely looked up when choosing an overload.
  // 파싱 직후 딱 한 번, AST 전체에 정적 타입을 붙인다(pine-types.js). 봉마다 반복되는 실행
  // 경로에는 아무것도 안 더하고, 결과는 노드에 캐시돼 오버로드 선택 때 조회만 된다.
  if(typeof pineInferTypes === 'function') pineInferTypes(ast, parser.userTypeNames);
  return ast;
}
