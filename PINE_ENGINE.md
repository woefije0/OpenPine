# OpenPine Engine — Supported Scope & Known Limitations

`core/pine-engine.js` (lexer/parser) + `core/pine-types.js` (static type inference) +
`core/pine-interpreter.js` (executor) + `core/pine-builtins.js` (built-in functions) +
`core/pine-strategy.js` (`strategy()` backtest order/fill simulation) together form a from-scratch
subset engine for TradingView Pine Script **indicator/strategy scripts**. It is not TradingView's official engine — it's an independent
implementation — so it isn't 100% identical to real Pine. Everything documented here was confirmed
by actually pasting a wide range of public scripts into it and testing them.

OpenPine has no rendering layer of its own. Wherever this document says something "isn't drawn" or
describes a color/z-order/layering rule, that's describing what data the engine computes and
returns (a value, a color, an ordering) — actually putting pixels on a screen is entirely up to
whatever host application embeds the engine.

## Execution Model

Pine's core model is that "the entire script re-runs from the top on every bar." This engine does
the same: the interpreter walks the whole AST again, `bars.length` times. Only variables declared
with `var` (including `var` inside a function) carry their value over from the previous bar; an
ordinary `=` variable is recomputed fresh every bar.

**Incremental last-bar recompute**: Re-running a script from scratch on every single live tick of
an in-progress (unconfirmed) bar is expensive. `PineInterpreter.runIncrementalLastBar(bars)` gives
a host a way to avoid that: it rewinds to a `callState` snapshot taken right before the last bar
was first executed, then recomputes only that one bar (built-ins with per-callsite accumulated
state, like `ta.*`, are handled correctly by this snapshot/restore too). It returns `null` — meaning
the host should fall back to a full `run()` instead — in two cases: the bar count changed (a new
bar was confirmed since the last call), or the script isn't eligible for this rewind at all.
Eligibility (`this.incrementalEligible`, computed by `refreshIncrementalEligibility()`, called
automatically at the end of `run()`) excludes any script using `strategy(...)`,
`line.new`/`box.new`/`label.new`/`table.new`, or a `var` global holding an array/map/struct —
rewinding those isn't safe (drawing objects could get duplicated, among other cumulative side
effects), so they're always fully re-run on every new bar instead.
`barstate.isconfirmed`/`isrealtime`/`isnew` themselves are unaffected by any of this either way.

**Static type inference**: right after parsing, `core/pine-types.js` walks the AST exactly once,
tagging each node with a compile-time type (`int`/`float`/`color`/`string`/`array<T>`/user types,
etc.) cached on the node. Nothing is added to the per-bar execution path (the one-time cost is
absorbed into parsing). It's currently only used for `method` overload resolution — runtime values
alone can't distinguish `int`/`float` from `color`/`string` — and never affects value computation
itself. See the `method` overloading section below for the exact rules and remaining limits.

## Not Supported At All (fails immediately with an error)

- **`library(...)` scripts**, `export`/`import` — the external-library family.
- **All of `request.*` except `request.security()`/`request.security_lower_tf()`** —
  `request.dividends`, `request.splits`, `request.earnings`, `request.financial`,
  `request.economic`, `request.currency_rate`, etc.
- **`syminfo.*()`, `ticker.*()`, `chart.*()` (except `chart.point.new`), `polyline.*`, `log.*`** —
  not implemented as function calls. (Using `syminfo.*` as a *value* does return a real value — see
  "Partial support" below.)
- Undefined names/functions, indexing a non-array value, an array index out of range, `pop()`/
  `shift()` on an empty array, `for ... by 0`, more than 200,000 iterations in a single `while`/`for`
  execution (treated as an infinite loop — a safety net against something like `for i = 0 to 1e9`
  freezing everything on one line), more than 60 levels of function-call nesting (recursion is
  effectively impossible), `break`/`continue` outside a loop, `:=` on an undeclared variable,
  `obj.field := ...` on a non-struct value or a field that doesn't exist.

## Silently Ignored (no error, just does nothing)

- `plotcandle()`, `plotbar()`, `plotarrow()` — accepted, but produce no output at all (not even
  data a host could choose to render).
- `alertcondition()`, `alert()` — accepted, but there is no alert system, so nothing ever fires.
- `strategy.risk.max_drawdown()`, `strategy.risk.max_intraday_loss()`,
  `strategy.risk.max_intraday_filled_orders()`, `strategy.risk.max_position_size()`,
  `strategy.risk.allow_entry_in()` — accepted, but never actually enforced (there's no logic that
  blocks new orders based on an intraday loss cap, etc).
- Using a namespace like `ticker`/`currency`/`session`/`earnings`/`dividends`/`splits`/`format`/
  `xloc`/`yloc`/`text`/`strategy`/`order`/`display`/`extend`/`adjustment`/`settle` **as a value
  rather than a function call** (e.g. `xloc.bar_time`) just returns its own dotted-path string
  (`"xloc.bar_time"`) — harmless if only used for internal comparisons, but looks wrong if displayed
  directly. `syminfo.*` is the exception and returns a real value (see below).
- Exceeding the line/box/label count cap (50 by default) silently deletes the oldest one first, no
  warning.
- If `input()`'s default value is a computed expression rather than a literal (a common "choose a
  source" pattern), it's silently excluded from the auto-generated settings-panel metadata (the
  value itself still works correctly at runtime).

## Partial Support / Known Limitations

- **`syminfo.*`** — returns a real value for whatever the host actually told the engine (via
  `PineHost`/`setSymbol()`); everything else falls back to its own name as a string.
  - `syminfo.mintick`/`minmove`/`pricescale` — an approximate tick derived by applying a fixed
    5-significant-figure rule (matching Hyperliquid's convention — the same rule
    `pine-strategy.js`'s slippage calculation uses) to the current bar's close. This is a fixed
    heuristic, not configurable per host, and doesn't account for any symbol-specific tick-size
    metadata (a real exchange's actual minimum tick can differ from this approximation).
  - `syminfo.ticker`/`tickerid`/`prefix`/`basecurrency`/`description` are derived from
    `PineHost.coin`/`isSpot` (see `pine-host.js`) — `ticker` comes out as e.g. `"BTCUSD.P"`
    (`"BTCUSD"` for spot), `tickerid` as `"HYPERLIQUID:BTCUSD.P"` (the `"HYPERLIQUID:"` prefix is
    currently hardcoded, not host-configurable), `prefix` is always `"HYPERLIQUID"`.
  - `currency` is always `"USD"`, `type` is always `"crypto"`, `timezone` is always `"Etc/UTC"`,
    `pointvalue` is always `1`.
  - Any other `syminfo.*` name just returns its own name as a string, as before.
- **`str.tostring(value, format)` / `str.format("{0,number,#.##}", ...)`** — supports a subset of
  Java's `DecimalFormat` (`#` = digit shown if present, `0` = zero-padded digit, `,` = thousands
  separator, `%` = multiply by 100 and append a percent sign, literal characters around the pattern
  are preserved). `format.mintick` (rounds to the symbol's tick precision) / `format.percent` /
  `format.volume` are also handled.
- **`fill(plot1, plot2, color, title, ...)`** — when `plot1`/`plot2` are the values returned by
  `plot()`/`hline()` (e.g. `p1 = plot(upper)`, then `fill(p1, p2, color=...)`), the engine tracks
  the filled region between the two series per bar, including a `color` that changes bar-to-bar
  (e.g. a cloud that flips green/red with trend). **Not supported:** the 4-threshold gradient form
  that additionally takes `top`/`bottom` (`fill(plot1, plot2, top, bottom, top_color, bottom_color,
  ...)`) is only ever treated as a solid-color fill. **Transparency:** real Pine's `fill()` defaults
  `transp` to 90 (`plot()` and others default to 0) — `fill(p1, p2, color=gray)` with only a bare
  color and no explicit `transp=`/`color.new()` alpha comes out as a light 10%-opacity shade, not
  opaque. If `transp=` was given explicitly, or the color already carries alpha from
  `color.new()`/`color.rgb()`, that value is respected as-is (the default of 90 never overrides it).
  How (and whether) a host actually draws this — z-order relative to candles, layering multiple
  fills, etc. — is entirely up to the host; the engine only computes the per-bar values/colors.
- **`barcolor(color, ...)`** — computes a per-bar candle color, returned as its own entry per call
  site, structurally identical to `bgcolor()` below (each `barcolor()` call in the script gets its
  own array of per-bar colors in the result — the engine never merges multiple call sites into one
  "final" color itself). A bar with `color` = `na` has no entry for that call site on that bar
  (meaning "leave whatever color the bar would otherwise have"). If more than one call site (or
  script) targets the same bar, which one visually wins is entirely up to the host to decide when
  applying them to its own candle rendering.
- **`bgcolor(color, offset, ...)`** — computes a per-bar background color, returned as its own
  entry per call site (every `bgcolor()` call in the script gets its own array of per-bar colors in
  the result). A bar with `color` = `na` has no entry for that call site on that bar. Multiple
  `bgcolor()` calls on the same bar are independent per-call-site values — whether/how a host
  layers or blends them (e.g. compositing translucent colors in call order) is entirely up to the
  host. `offset=` shifting into future bars is supported (the same way `plot()`/`shape()` extend
  the bar array as needed). **Transparency:** unlike `fill()`, no default `transp` is pushed onto
  the color — real Pine's `bgcolor()` has no such default, so whatever color the script computed
  (typically via `color.new(..., 90)`, since giving the alpha explicitly is the common idiom for
  this function) is passed through as-is.
- **`request.security()`**
  - `symbol` — when it names the chart's own symbol (empty/omitted, matching `syminfo.ticker`/
    `syminfo.tickerid`, or a `ticker.heikinashi()` marker), resolves against this chart's own bars.
    When it names a **different** symbol, it's only ever resolved from `options.lowerTfCache`
    entries keyed for that exact symbol (see below) — it is never served from this chart's own
    bars, even as a fallback, since that would silently return the wrong symbol's prices under the
    requested symbol's name.
  - **When the chart's own interval is an exact divisor of the requested timeframe** (e.g. asking
    for `"5"` on a 1-minute chart) — same-symbol requests only — the main bars are grouped directly
    and synthesized correctly with no `lowerTfCache` needed at all, since bar boundaries always
    line up exactly with timeframe boundaries in that case.
  - **Otherwise** (a non-divisor timeframe for the current symbol, or any timeframe for a different
    symbol), the requested resolution is resolved from `options.lowerTfCache`: an exact key match
    is used directly; failing that, any entry whose own timeframe evenly divides the requested one
    is aggregated on the fly (`PineInterpreter.resolveLowerTfBars` — picking the coarsest valid
    divisor candidate, to minimize aggregation work). **Fetching that data is entirely the host's
    job** — the engine never performs any network access on its own. If nothing usable is in the
    cache, the result is `na` for every bar (there is no unsafe fallback for a different symbol,
    and a non-divisor same-symbol request without cache data is also `na` rather than an
    inaccurate guess).
  - `expression` is evaluated exactly once per synthesized higher-timeframe bar (bucket), with
    `curBar` advancing normally (the same pattern as `request.security_lower_tf()`). `ta.*` state
    functions correctly advance exactly once only when an HTF bar genuinely progresses, and there
    is no history-length cap. `lookahead` (default off) set to `barmerge.lookahead_on` makes the
    not-yet-closed higher-timeframe bar's final (future-completed) value apply retroactively from
    the first main bar in that span — matching real Pine's repaint behavior.
  - Week/month-unit timeframe bucketing is approximate (month = 30 days; week = an offset from the
    Monday nearest 1970-01-01). An empty-string timeframe (`''`, "same as the current chart") is
    treated as roughly 1 minute *for divisor-aggregation purposes* — but a `request.security()`
    call whose timeframe is genuinely empty (`timeframe.period`) for a **different** symbol isn't
    supported at all and always returns `na`, since there's no timeframe string in that case to
    align cache entries by.
  - Unlike the original app this engine was extracted from, there is **no built-in depth limit** on
    how far back `request.security()`/`request.security_lower_tf()` can see — that entirely depends
    on how much data the host supplies in `lowerTfCache`. There is also no restriction requiring
    `timeframe` to be a literal string constant — a dynamically computed timeframe (or symbol)
    string works exactly the same way, since resolution happens per-call at runtime rather than by
    scanning the script ahead of time.
- **`request.security_lower_tf()`**
  - Resolved the same way as a non-divisor `request.security()` call — via
    `options.lowerTfCache`/`resolveLowerTfBars`, with the same same-symbol vs. different-symbol
    rules described above. If nothing usable is in the cache, every bar just gets an empty array.
  - If `expression` is a tuple (`[high, low, close, volume]`), as in real Pine, this returns not one
    array but **one array per element** — `[h, l, c, v] = request.security_lower_tf(...)`
    destructuring works correctly (including when the data couldn't be resolved at all — the result
    is still the right number of empty arrays, so destructuring never breaks). The same applies when
    a user function returning a tuple is passed instead of a literal.
- **`matrix.*`** (`MATRIX_METHODS` in `core/pine-builtins.js`) — structural operations (`get`/`set`/
  `row`/`col`/`fill`/`add_row`/`add_col`/`reshape`/`transpose`/`concat`/`submatrix`/`swap_*`/
  `reverse`) and statistics (`avg`/`min`/`max`/`sum`/`median`/`mode`) are all exact. Linear algebra
  has some constraints:
  - `det`/`inv`/`rank`/`mult`/`pow`/`trace`/`is_*` — based on Gaussian elimination with partial
    pivoting, exact at any size.
  - `eigenvalues`/`eigenvectors`/`is_stable` — **symmetric matrices only** (Jacobi eigenvalue
    algorithm). A non-symmetric matrix (where real eigenvalues aren't guaranteed — complex
    eigenvalues are possible) throws an error — this matches real TradingView's own documented
    scope (symmetric matrices only), not an extra restriction on top of it.
  - `pinv` (pseudo-inverse) — computed via the closed-form formula for a full-rank matrix only
    (`(AᵀA)⁻¹Aᵀ` when columns ≥ rows, else `Aᵀ(AAᵀ)⁻¹`). Not the general SVD-based solution, so a
    rank-deficient matrix throws an error.
  - A generic type argument like `matrix.new<Type>(...)` is simply discarded by the parser (no
    effect on the value itself — same as `array.new<Type>()`).
- **`method` overloading** (defining the same name across multiple types — a pattern real Pine
  formally supports)
  - Candidates are picked by **static type**, just like the real Pine compiler.
    `core/pine-types.js` walks the AST once right after parsing and tags each node with a type
    (`_st`), and the interpreter picks based on the receiver node's tagged type, caching the result
    per call site. This means overloads split across pairs that runtime values alone can't
    distinguish — `int`/`float` or `color`/`string` (both are just a JS number/string at runtime) —
    are still selected correctly. Both dot-call (`x.f()`) and bare-name call (`f(x)`) forms behave
    identically.
  - Type sources include literal notation (`5` is `int`, `5.0` is `float`, `#ff0000` is `color`),
    declared types (`float x = 0`; an `int qty` field; a `simple string maType` parameter),
    back-inference from an assignment (`c = color.new(...)` → `color`), the return-type table for
    built-in functions/variables, array/map element types (`.get()` on `array.new<int>()` is
    `int`), ternary/`switch` branch merging (`int` mixed with `float` becomes `float`; `na` follows
    the other branch's type), and **per-call-site specialization** of user functions (calling
    `dbl(x) => x * 2` as `dbl(3)` is treated as returning `int`; as `dbl(3.5)`, `float`).
  - Where a static type can't be determined, it falls back to the runtime value as before, and if
    that doesn't cleanly match either, the first-declared candidate is used (the reasoning being
    that a best guess beats crashing). Two limitations remain:
    - An overload that only diverges **inside the body** of a generic function whose untyped
      parameter is called with different types at different call sites — since multiple types flow
      into the same AST node, that node is marked "can't determine statically" and falls back to
      runtime (better than confidently picking the wrong one).
    - Variables received from a tuple-returning expression (`[a, b] = ta.macd(...)`, or a user
      function returning multiple values) — per-element types aren't built yet, so these are always
      "unknown."
  - Static types are only ever used for overload selection — arithmetic results and values
    themselves are completely unchanged (e.g. this engine's `/` is real division even between two
    `int`s, and the static type reflects that actual behavior as `float`).
- **Color-branch tracking** (lets a plot's per-condition colors be edited separately in a
  settings-panel style UI) — only recognizes the ternary (`?:`) and `iff()` patterns. Splitting a
  color with `switch` or a separate helper function collapses everything into one color.
- **`label.new`'s `style=`** — the engine only ever keeps one of five buckets on the returned
  `PineLabel` object: `label_up`/`_down`/`_left`/`_right`/`_center` (`pineLabelStyleFromConst` in
  `core/pine-builtins.js`). Any icon-only style (`circle`/`square`/`triangleup`/`diamond`/`flag`/
  `cross`/`xcross`/`arrowup`/`arrowdown`/`none`) is folded into `label_down` at this point — the
  distinction is discarded before a host ever sees it, so no host-side renderer can recover which
  icon style was originally requested from the returned object alone.
- **Drawing objects on `overlay=false` (dedicated-pane) scripts** — `line.new`/`box.new`/
  `label.new`/`linefill.new` are only meaningful for `overlay=true` scripts; a dedicated-pane
  script's coordinate system doesn't line up with the main chart's, and this engine doesn't attempt
  to translate between them. The count cap (50, oldest deleted first) is shared with line/box/label
  as elsewhere, and deleting a referenced line also removes any fill between it and another line.
- **`strategy(...)` backtesting** (`core/pine-strategy.js`) — approximates order fills from
  confirmed-bar OHLC only (no real tick-by-tick data), so results won't exactly match TradingView's.
  - **Fill timing**: a market order placed on bar *i* fills at bar *i+1*'s open (plus slippage). A
    limit/stop order fills starting from bar *i+1*, the first time any subsequent bar's
    `[low, high]` range touches its price (it keeps waiting until it does).
    `strategy.exit()`'s take-profit/stop-loss/trailing brackets are checked the same way, every bar
    an entry stays open. The one exception: a market order with `process_orders_on_close=true` (or
    `immediately=true` on a `strategy.close`-family call) fills right at the close of the bar it was
    placed on.
  - If a take-profit and a stop-loss both fall within the same bar's `[low, high]` range
    simultaneously, the stop-loss is filled first (the conservative assumption).
  - `slippage` (in ticks) — "1 tick" is computed using a fixed 5-significant-figure price rule
    (e.g. BTC at 65432 → tick 1, ETH at 1423.3 → tick 0.1, SOL at 72.122 → tick 0.001), matching
    Hyperliquid's actual price-unit convention — the same rule `syminfo.mintick` uses (see above).
    It doesn't account for any symbol-specific tick-size cap.
  - Only a net-position model is supported — an opposite-direction `strategy.entry` fully closes
    the existing position before opening the new one (matching real Pine's default behavior).
    Hedging (simultaneous long+short) isn't supported.
  - `pyramiding` defaults to 1 (no additional entries) if not set.
  - `strategy.order()` is treated identically to `strategy.entry()` (including automatically
    closing an opposite position) — an approximation of real Pine's "fills immediately with no
    position netting" behavior.
  - `strategy.close()`'s absolute `qty` argument is ignored — only `qty_percent` is supported
    (100% by default).
  - `strategy.exit()`'s `trail_price` (an absolute-price trailing trigger) isn't supported — only
    the `trail_points`/`trail_offset` combination is.
  - **Test period** (a start/end date, analogous to TradingView's Properties-tab range) — bars
    outside the given range simply skip `strategy.entry`/`order`/`close`/`close_all`/`exit` calls
    entirely (silently), and pending-order fills/mark-to-market are skipped too (the equity curve
    just stops moving once the range ends). If not given, the entire supplied bar range is used.
    There's no corresponding parameter on the `strategy(...)` script call itself — pass it via
    `options.strategyPropsOverride` when calling `OpenPine.run()` instead.
  - `margin_long`/`margin_short` (margin calls) aren't supported — an order always fills regardless
    of available funds.
  - `calc_on_every_tick` is ignored — this engine always calculates on confirmed-bar closes only
    (the same reason `barstate.isconfirmed` is always `true`).
  - OCA (`oca_name`/`oca_type`) is approximated as "one fills, the rest cancel" —
    `strategy.oca.reduce` (quantity reduction) is also just treated as a cancel.
  - **Trade markers** — the result includes, for each entry/exit, a filled quantity (signed for
    buy/sell) and the `comment=` text (e.g. `strategy.entry(..., comment="Bullish")` → a `+1` marker
    carrying `"Bullish"`). When pyramiding stacks multiple fills onto the same id/direction, only
    the first fill's comment is kept (they're merged into one entry internally).
    **Reversal orders**: calling `strategy.entry()` while holding an opposite-direction position is
    treated as one order that both closes the existing position and opens the new one — holding
    short 1 and calling `strategy.entry(long, qty=1)` produces a marker for `+2` (covering the
    short 1, plus the new long 1). The position closed by the reversal doesn't get its own separate
    exit marker (avoiding two overlapping markers on the same bar) — only explicit closes via
    `strategy.close()`/`strategy.exit()` always get their own exit marker, since those aren't
    reversals.

## Supported (summary)

Variable declarations (`var`/`varip` included, including `var` inside a function persisting across
bars), `if`/`else`, `for` (counting / `for..in` / `for [idx,val] in`), `while`, `switch`,
`break`/`continue`, user-defined functions and `method`s (including type-based overloading — picked
by static type, so overloads split across `int`/`float` or `color`/`string` work too), typed
declarations/parameters/fields (`float x = 0`; an uninitialized declaration like `int x`;
`simple string t`; `array<lvl> levels`; `float[] xs`), user-defined types (`type` — structs,
nestable), arrays (all of `array.*` — including `slice`/`binary_search*`/`percentrank`/
`covariance`/`standardize`), tuples (`[a,b] = ...`), most of `ta.*`/`math.*`/`color.*`/`str.*`/
`input.*` (including built-in series variables used without parentheses — `ta.tr`/`ta.obv`/
`ta.accdist`/`ta.vwap`/`ta.iii`/`ta.nvi`/`ta.pvi`/`ta.pvt`/`ta.wad`/`ta.wvad`), `request.security()`/
`request.security_lower_tf()` (under the constraints above), `plot()`/`hline()`/`plotshape()`/
`plotchar()`, `line.new`/`box.new`/`label.new` (and their `.set_*` methods), `linefill.new`/
`delete`/`set_color`/`get_line1`/`get_line2`/`linefill.all`, type casts (`int()`/`float()`/
`bool()`/`string()`/`color()`/`line()`/`label()`/`box()`/`table()`/`linefill()` — including forms
like `matrix.new<line>(1, 10, line(na))` used to create an empty initial value), `table.new`/
`table.cell` (and `.delete`/`cell_set_*` etc — actual on-screen rendering is entirely up to the
host embedding the engine; the engine returns the table object with its cells populated),
`map.*` (`put`/`get`/`contains`/`remove`/`clear`/`copy`/`keys`/`values`/`size`/`put_all`),
`matrix.*` (all structural/statistical operations, plus `det`/`inv`/`rank`/`mult`/`pow`/
`eigenvalues`/`eigenvectors`/`pinv` under the constraints above), `strategy(...)` backtesting
(`strategy.entry`/`order`/`close`/`close_all`/`exit`/`cancel`/`cancel_all`, under the constraints
above — fill/PnL results are returned in `OpenPine.run()`'s result object).

---
This reflects what was actually confirmed by testing as of the last update, and the engine may
keep expanding after that — if this document and the actual code (the comments at the top of
`core/pine-*.js`) ever seem to disagree, trust the code.



# OpenPine 엔진 (한국어) — 지원 범위 & 알려진 제약

`core/pine-engine.js`(렉서/파서) + `core/pine-types.js`(정적 타입 추론) + `core/pine-interpreter.js`
(실행기) + `core/pine-builtins.js`(내장 함수) + `core/pine-strategy.js`(strategy 백테스트
주문/체결 시뮬레이션)로 구성된, TradingView Pine Script **indicator/strategy 스크립트**용
자체 구현 서브셋 엔진이다. TradingView 공식 엔진이 아니라
독립적으로 구현한 것이므로, 실제 Pine과 100% 동일하지는 않다. 여기 적힌 내용은 실제로 여러
공개 스크립트를 붙여넣어 테스트하면서 확인된 것들이다.

OpenPine 자체에는 렌더링 레이어가 없다. 이 문서에서 뭔가 "그려지지 않는다"거나 색/z-order/
레이어링 규칙을 설명하는 부분은, 전부 엔진이 **계산해서 돌려주는 데이터**(값, 색, 순서)에 대한
설명이다 — 실제로 화면에 픽셀을 찍는 건 전적으로 이 엔진을 임베드하는 호스트 애플리케이션의 몫이다.

## 실행 모델

Pine의 핵심 모델은 "스크립트 전체가 매 bar마다 처음부터 다시 실행된다"는 것이다. 이 엔진도
동일하게 `bars.length`번만큼 AST 전체를 매번 다시 훑는다. `var`로 선언한 변수(함수 내부의 `var`도
포함)만 이전 bar의 값을 그대로 들고 오고, 일반 `=` 변수는 매 bar 새로 계산된다.

**마지막 봉 증분 재계산**: 아직 진행 중인(미확정) 마지막 봉의 매 실시간 틱마다 스크립트를 처음부터
다시 실행하는 건 무겁다. `PineInterpreter.runIncrementalLastBar(bars)`는 호스트가 이걸 피할 수
있게 해준다 — 그 봉을 처음 실행하기 직전에 찍어둔 `callState` 스냅샷으로 되돌린 뒤 마지막 봉
하나만 다시 계산한다(`ta.*`처럼 콜사이트별로 누적 상태를 갖는 내장 함수도 이 스냅샷/복원으로
정확히 처리됨). 두 경우엔 `null`을 돌려주는데(호스트는 이때 그냥 `run()`을 통째로 다시 불러야
한다) — 봉 개수가 바뀐 경우(마지막 호출 이후 새 봉이 확정됨), 또는 애초에 이 되돌리기 대상이 될
자격이 없는 스크립트인 경우다. 자격 여부(`this.incrementalEligible`, `refreshIncrementalEligibility()`
가 계산하며 `run()` 끝에서 자동으로 호출됨)는 `strategy(...)`, `line.new`/`box.new`/`label.new`/
`table.new`, 또는 배열·맵·구조체를 담는 `var` 전역 변수를 쓰는 스크립트를 전부 제외한다 — 그런
스크립트는 되돌리기가 안전하지 않아서(그리기 객체가 중복 생성되는 등 부작용이 누적될 수 있음)
매 새 봉마다 항상 전체를 다시 실행한다. `barstate.isconfirmed`/`isrealtime`/`isnew` 자체의 값은
이 변화와 무관하게 항상 동일하다.

**정적 타입 추론**: 파싱이 끝난 직후 `core/pine-types.js`가 AST를 딱 한 번 훑어 각 노드에
컴파일타임 타입(`int`/`float`/`color`/`string`/`array<T>`/사용자 타입 등)을 매겨 노드에
캐시해둔다. 봉마다 반복되는 실행 경로에는 아무것도 안 더한다(일회성 비용은 파싱 비용에 묻히는
수준). 지금은 `method` 오버로딩 선택에만 쓰이며 — 런타임 값만으로는 `int`/`float`와
`color`/`string`이 구분되지 않기 때문 — 값 계산 자체에는 전혀 영향을 주지 않는다. 자세한 규칙과
남은 한계는 아래 `method` 오버로딩 항목 참고.

## 아예 안 되는 것 (에러로 바로 중단)

- **`library(...)` 스크립트**, `export`/`import` — 외부 라이브러리 계열.
- **`request.*` 중 `request.security()`/`request.security_lower_tf()`를 제외한 나머지** —
  `request.dividends`, `request.splits`, `request.earnings`, `request.financial`,
  `request.economic`, `request.currency_rate` 등.
- **`syminfo.*()`, `ticker.*()`, `chart.*()`(`chart.point.new` 제외), `polyline.*`, `log.*`** —
  함수 호출 형태는 미구현. (`syminfo.*`를 값으로 쓰는 건 실제 값이 나온다 — 아래 "부분 지원" 참고)
- 정의되지 않은 이름/함수, 배열이 아닌 값 인덱싱, 배열 범위 초과, 빈 배열 `pop()`/`shift()`,
  `for ... by 0`, `while`/`for` 한 번 실행에 20만 회 초과 반복(무한루프로 간주 — `for i = 0 to 1e9`
  같은 한 줄에 탭이 통째로 멈추는 걸 막는 안전장치), 함수 호출 60단계 초과(재귀 사실상 불가),
  `break`/`continue`를 루프 밖에서 사용, 정의 안 된 변수에 `:=`, struct 아닌 값/없는 필드에
  `obj.field := ...`.

## 조용히 무시되는 것 (에러 없이 그냥 아무 일도 안 일어남)

- `plotcandle()`, `plotbar()`, `plotarrow()` — 받아들이긴 하는데 아무 데이터도 안 나온다(호스트가
  렌더링하고 싶어도 할 수 있는 데이터 자체가 없음).
- `alertcondition()`, `alert()` — 알림 시스템 자체가 없어서 절대 안 울림.
- `strategy.risk.max_drawdown()`, `strategy.risk.max_intraday_loss()`,
  `strategy.risk.max_intraday_filled_orders()`, `strategy.risk.max_position_size()`,
  `strategy.risk.allow_entry_in()` — 받아들이긴 하는데 실제로 적용은 안 됨(일중 손실 한도 등으로
  신규 주문을 막는 로직 자체가 없음).
- `ticker`/`currency`/`session`/`earnings`/`dividends`/`splits`/`format`/`xloc`/`yloc`/`text`/
  `strategy`/`order`/`display`/`extend`/`adjustment`/`settle` 같은 네임스페이스를 **함수 호출이
  아니라 값으로만** 쓰면(예: `xloc.bar_time`), 자기 자신의 점(dot) 경로 문자열(`"xloc.bar_time"`)이
  그대로 반환됨 — 내부 비교용으로만 쓰면 문제없지만 화면에 그대로 표시하면 이상하게 보인다.
  `syminfo.*`는 예외로 진짜 값을 준다(아래 참고).
- 라인/박스/라벨 개수 제한(기본 50개) 초과 시 가장 오래된 것부터 경고 없이 조용히 삭제됨.
- `input()`의 기본값이 리터럴이 아닌 계산식(흔한 "소스 선택" 패턴)이면, 자동 생성되는 설정 패널
  메타데이터에서 조용히 제외됨(값 자체는 정상 동작).

## 부분 지원 / 알려진 제약

- **`syminfo.*`** — 호스트가 실제로 알려준 만큼은(`PineHost`/`setSymbol()` 경유) 진짜 값을 주고,
  그 외는 자기 이름 문자열로 폴백한다.
  - `syminfo.mintick`/`minmove`/`pricescale` — 고정된 유효숫자 5자리 규칙(하이퍼리퀴드의 관례와
    일치 — `pine-strategy.js`의 슬리피지 계산과 같은 규칙)을 현재 봉 종가에 적용해서 구한 근사
    틱이다. 호스트별로 설정 가능한 값이 아니라 고정 휴리스틱이고, 심볼별 틱 사이즈 메타데이터는
    반영하지 않는다(실제 거래소의 진짜 최소 틱은 이 근사치와 다를 수 있음).
  - `syminfo.ticker`/`tickerid`/`prefix`/`basecurrency`/`description`은 `PineHost.coin`/`isSpot`
    (`pine-host.js` 참고)에서 만들어진다 — `ticker`는 `"BTCUSD.P"`(현물이면 `"BTCUSD"`),
    `tickerid`는 `"HYPERLIQUID:BTCUSD.P"`(`"HYPERLIQUID:"` 접두사는 현재 하드코딩돼 있고 호스트가
    바꿀 수 없다), `prefix`는 항상 `"HYPERLIQUID"`.
  - `currency`는 항상 `"USD"`, `type`은 항상 `"crypto"`, `timezone`은 항상 `"Etc/UTC"`,
    `pointvalue`는 항상 `1`.
  - 그 외 `syminfo.*` 이름은 예전처럼 자기 이름 문자열이 나온다.
- **`str.tostring(value, format)` / `str.format("{0,number,#.##}", ...)`** — Java DecimalFormat의
  부분집합을 지원한다(`#`=있으면 찍는 자리, `0`=0으로 채우는 자리, `,`=천 단위 구분, `%`=100 곱하고
  % 붙임, 패턴 앞뒤 리터럴 유지). `format.mintick`(심볼 틱 자릿수로 반올림)/`format.percent`/
  `format.volume`도 처리한다.
- **`fill(plot1, plot2, color, title, ...)`** — `plot1`/`plot2` 자리에 `plot()`/`hline()`이 돌려준
  값을 넘기면(예: `p1 = plot(upper)` 후 `fill(p1, p2, color=...)`) 두 시리즈 사이의 채움 영역을 봉
  단위로 추적한다, `color`가 봉마다 달라지는 스크립트(추세에 따라 초록/빨강이 바뀌는 구름 등)도
  포함해서. **미지원:** `top`/`bottom` 두 값을 추가로 받아 그라데이션으로 채우는 4-threshold 버전
  (`fill(plot1, plot2, top, bottom, top_color, bottom_color, ...)`)은 단색 fill로만 처리된다.
  **투명도**: 실제 Pine의 `fill()`은 `transp` 기본값이 90이다(`plot()` 등 다른 함수는 기본값 0) —
  `fill(p1, p2, color=gray)`처럼 색만 주고 `transp=`도 `color.new()`도 안 쓰면 불투명이 아니라 10%
  불투명도의 옅은 음영으로 계산된다. `transp=`를 명시했거나 `color.new()`/`color.rgb()`로 이미
  알파를 넣어 넘긴 색이면 그 값을 그대로 존중한다(기본값 90이 덮어쓰지 않음). 실제로 이걸 어떻게
  (그리고 그릴지 말지) 그리는지 — 캔들과의 z-order, 여러 fill의 레이어링 등 — 는 전적으로 호스트
  몫이다. 엔진은 봉별 값/색만 계산해서 돌려준다.
- **`barcolor(color, ...)`** — 봉별 캔들 색을 계산해서, 아래 `bgcolor()`와 구조적으로 동일하게
  콜사이트마다 독립적인 항목으로 돌려준다(스크립트 안의 `barcolor()` 호출 하나하나가 결과에서
  각자 자기 봉별 색 배열을 갖는다 — 엔진 자체가 여러 콜사이트를 하나의 "최종" 색으로 합치는 일은
  없다). `color`가 `na`인 봉은 그 콜사이트에 해당 봉 항목이 없다("원래 색 그대로 두라"는 뜻).
  같은 봉을 여러 콜사이트(또는 여러 스크립트)가 동시에 타겟하면, 실제로 어느 쪽이 화면에 보일지는
  전적으로 호스트가 자기 캔들 렌더링에 적용할 때 정하기 나름이다.
- **`bgcolor(color, offset, ...)`** — 봉별 배경 색을 계산해서, 콜사이트마다 독립적인 항목으로
  돌려준다(스크립트 안의 `bgcolor()` 호출 하나하나가 결과에서 각자 자기 봉별 색 배열을 갖는다).
  `color`가 `na`인 봉은 그 콜사이트에 해당 봉 항목이 없다. 같은 봉에 걸린 여러 `bgcolor()` 호출은
  서로 독립된 콜사이트별 값이다 — 이걸 어떻게 레이어링/블렌딩할지(예: 호출 순서대로 반투명 색을
  겹쳐 합성) 는 전적으로 호스트 몫이다. `offset=`으로 미래 봉까지 밀어 칠하는 것도 지원한다
  (plot/shape가 필요한 만큼 봉 배열을 늘리는 것과 같은 방식). **투명도**: `fill()`과 달리 `transp`
  기본값을 밀어주지 않는다 — 실제 Pine의 `bgcolor()`엔 그런 기본값이 없어서, 스크립트가 계산한
  색(`color.new(..., 90)`처럼 알파를 직접 지정하는 게 이 함수의 일반적인 관용구다)을 그대로
  옮긴다.
- **`request.security()`**
  - `symbol` — 이 차트 자신의 심볼을 가리키면(비어있거나/생략됐거나, `syminfo.ticker`/
    `syminfo.tickerid`와 일치하거나, `ticker.heikinashi()` 마커일 때) 이 차트 자신의 봉으로
    계산한다. **다른** 심볼을 가리키면, 그 정확한 심볼로 키가 잡힌 `options.lowerTfCache` 항목
    (아래 참고)에서만 풀린다 — 이 차트 자신의 봉으로는 폴백으로도 절대 서빙되지 않는다(그러면
    조용히 엉뚱한 심볼의 가격을 요청한 심볼 이름으로 돌려주게 되기 때문).
  - **차트 자체 간격이 요청 timeframe의 정확한 약수일 때**(예: 1분봉 차트에서 `"5"` 요청 — 같은
    심볼 요청에 한함)는 메인 봉을 그대로 묶어서 `lowerTfCache` 없이도 정확하게 합성된다 — 이
    경우엔 봉 경계가 항상 타임프레임 경계와 정확히 맞아떨어지기 때문이다.
  - **그 외**(현재 심볼의 약수가 아닌 timeframe, 또는 다른 심볼의 아무 timeframe)는
    `options.lowerTfCache`에서 요청 해상도를 찾는다: 정확히 일치하는 키가 있으면 그대로 쓰고,
    없으면 요청 timeframe을 정확히 나누어떨어지게 하는(약수인) 다른 항목을 즉석에서
    합성한다(`PineInterpreter.resolveLowerTfBars` — 약수 후보가 여럿이면 합성량이 가장 적은 가장
    굵은 것을 고른다). **그 데이터를 실제로 받아오는 건 전적으로 호스트 책임**이다 — 엔진은
    스스로 네트워크에 접근하는 일이 전혀 없다. 캐시에 쓸 만한 게 없으면 모든 봉이 `na`다(다른
    심볼에는 안전한 폴백이 없고, 캐시 없는 같은 심볼의 비배수 요청도 부정확한 추측 대신 `na`다).
  - `expression`은 합성된 상위 타임프레임 봉(버킷) 하나당 딱 한 번, `curBar`를 정상적으로
    증가시키며 평가한다(`request.security_lower_tf()`와 같은 패턴). `ta.*` 상태 함수도 실제 HTF
    봉이 진행될 때만 정확히 한 번 전진하고, 히스토리 길이 제한도 없다. `lookahead`(기본은 off)를
    `barmerge.lookahead_on`으로 주면, 아직 안 닫힌 상위 봉의 최종(미래 완성) 값이 그 봉 구간 첫
    메인 봉부터 소급 적용된다 — 실제 Pine과 같은 리페인트 동작.
  - 월/주 단위 타임프레임 버킷 계산은 근사치다(월=30일, 주=1970-01-01 월요일 기준 오프셋). 빈
    문자열 타임프레임(`''`, "현재 차트와 동일")은 *약수 합성 목적으로는* 대략 1분 단위로 취급된다
    — 하지만 timeframe이 진짜로 비어있는(`timeframe.period`) `request.security()`로 **다른** 심볼을
    요청하는 건 아예 지원하지 않고 항상 `na`다 — 이 경우엔 캐시 항목을 맞춰볼 timeframe 문자열이
    없기 때문이다.
  - 이 엔진이 추출된 원본 앱과 달리, `request.security()`/`request.security_lower_tf()`가 얼마나
    과거까지 볼 수 있는지에 대한 **내장 상한이 없다** — 전적으로 호스트가 `lowerTfCache`에 얼마나
    많은 데이터를 넣어주는지에 달려 있다. `timeframe`이 리터럴 문자열이어야 한다는 제약도 없다 —
    동적으로 계산된 timeframe(또는 symbol) 문자열도 똑같이 동작한다. 해석이 스크립트를 미리
    스캔하는 방식이 아니라 호출마다 그 자리에서 이뤄지기 때문이다.
- **`request.security_lower_tf()`**
  - 약수가 아닌 `request.security()` 호출과 같은 방식으로 풀린다 — `options.lowerTfCache`/
    `resolveLowerTfBars`를 거치고, 위에서 설명한 같은 심볼/다른 심볼 규칙도 동일하게 적용된다.
    캐시에 쓸 만한 게 없으면 모든 봉이 그냥 빈 배열이다.
  - `expression`이 튜플이면(`[high, low, close, volume]`) 실제 Pine처럼 배열 하나가 아니라 **원소
    개수만큼의 배열**을 돌려준다 — `[h, l, c, v] = request.security_lower_tf(...)` 구조 분해가
    정확히 동작한다(데이터를 아예 못 찾은 경우에도 원소 개수만큼의 빈 배열이 나와서 구조 분해가
    깨지지 않는다). 튜플을 돌려주는 사용자 함수를 리터럴 대신 넘겨도 마찬가지다.
- **`matrix.*`** (`core/pine-builtins.js`의 `MATRIX_METHODS`) — 구조 조작(`get`/`set`/`row`/`col`/
  `fill`/`add_row`/`add_col`/`reshape`/`transpose`/`concat`/`submatrix`/`swap_*`/`reverse`)과
  통계(`avg`/`min`/`max`/`sum`/`median`/`mode`)는 전부 정확하다. 선형대수 쪽은 제약이 있다:
  - `det`/`inv`/`rank`/`mult`/`pow`/`trace`/`is_*` — 부분 피벗팅 가우스 소거법 기반이라 임의
    크기에서 정확하다.
  - `eigenvalues`/`eigenvectors`/`is_stable` — **대칭행렬에서만 지원**(Jacobi 고유값 알고리즘).
    실수 고유값이 보장되지 않는 비대칭 행렬(복소 고유값 가능)에 쓰면 에러로 중단된다 — 실제
    TradingView 문서도 대칭행렬만 대상으로 명시하므로, 추가 제약이 아니라 같은 범위다.
  - `pinv`(유사역행렬) — 완전계수(full rank) 행렬만 정공식(열≥행이면 `(AᵀA)⁻¹Aᵀ`, 아니면
    `Aᵀ(AAᵀ)⁻¹`)으로 계산한다. SVD 기반 일반해가 아니라서 계수 부족(rank-deficient) 행렬에는
    에러로 중단된다.
  - `matrix.new<Type>(...)`처럼 붙는 제네릭 타입 인자는 파서가 그냥 버린다(값 자체엔 영향 없음 —
    `array.new<Type>()`도 마찬가지).
- **`method` 오버로딩** (같은 이름을 여러 타입에 걸쳐 정의하는 것 — 실제 Pine이 정식 지원하는
  패턴)
  - 실제 Pine 컴파일러처럼 **정적 타입**으로 후보를 고른다. `core/pine-types.js`가 파싱 직후
    AST를 한 번 훑어 각 노드에 타입을 매겨두고(`_st`), 인터프리터는 리시버 노드의 그 타입을 보고
    고른 뒤 결과를 콜사이트에 캐시한다. 그래서 `int`/`float`나 `color`/`string`처럼 런타임 값만
    으로는 구분이 안 되는(둘 다 JS number / JS string) 쌍으로 갈리는 오버로드도 제대로 선택된다.
    점 호출(`x.f()`)과 맨 이름 호출(`f(x)`) 양쪽 다 같게 동작한다.
  - 타입의 출처는 리터럴 표기(`5`는 int, `5.0`은 float, `#ff0000`은 color), 선언 타입
    (`float x = 0`, `int qty` 필드, `simple string maType` 매개변수), 대입식에서의 역추론
    (`c = color.new(...)` → color), 내장 함수/변수의 리턴 타입표, 배열·맵의 원소 타입
    (`array.new<int>()`의 `.get()`은 int), 삼항/`switch` 분기 병합(int와 float가 섞이면 float,
    `na`는 반대편 분기 타입을 따라감), 그리고 사용자 함수의 **콜사이트별 특수화**다
    (`dbl(x) => x * 2`를 `dbl(3)`으로 부르면 int, `dbl(3.5)`로 부르면 float를 돌려준다고 본다).
  - 정적 타입을 정할 수 없는 자리에서는 예전처럼 런타임 값으로 폴백하고, 그것도 정확히·느슨하게
    모두 안 맞으면 첫 번째로 선언된 후보로 간다(죽는 것보단 최선의 추정이 낫다는 판단). 남아 있는
    한계는 아래 둘:
    - 타입 표기가 없는 매개변수를 서로 다른 타입으로 부르는 제네릭 함수의 **본문 안에서** 갈리는
      오버로드 — 같은 AST 노드에 여러 타입이 흘러들므로 그 노드는 "정적으로는 못 정함"으로
      표시되고 런타임 폴백을 쓴다(엉뚱한 쪽을 확신하고 고르는 것보다 낫다는 판단).
    - 튜플을 돌려주는 식(`[a, b] = ta.macd(...)`, 여러 값을 돌려주는 사용자 함수)으로 받은
      변수들 — 원소별 타입을 아직 안 만들어서 전부 "모름"이다.
  - 정적 타입은 오버로드 선택에만 쓰인다 — 산술 결과나 값 자체는 예전과 완전히 같다(예: 이
    엔진의 `/`는 int끼리라도 실수 나눗셈이고, 정적 타입도 그 실제 동작에 맞춰 float로 둔다).
- **색상 분기 추적** (설정 패널에서 조건별로 색을 따로 편집할 수 있게 해주는 기능) — 삼항연산자
  (`?:`)와 `iff()` 패턴만 인식한다. `switch`나 별도 헬퍼 함수로 색을 나누면 전부 색 하나로
  뭉뚱그려진다.
- **`label.new`의 `style=`** — 엔진은 돌려주는 `PineLabel` 객체에 다섯 종류
  (`label_up`/`_down`/`_left`/`_right`/`_center`) 중 하나만 남긴다(`core/pine-builtins.js`의
  `pineLabelStyleFromConst`). 아이콘 전용 스타일(`circle`/`square`/`triangleup`/`diamond`/`flag`/
  `cross`/`xcross`/`arrowup`/`arrowdown`/`none`)은 전부 이 단계에서 `label_down`으로 뭉개진다 —
  호스트가 보기도 전에 이미 구분이 사라져서, 반환된 객체만으로는 어떤 아이콘 스타일이었는지
  호스트 쪽에서 복원할 방법이 없다.
- **`overlay=false`(전용 패널) 스크립트의 그리기 객체** — `line.new`/`box.new`/`label.new`/
  `linefill.new`는 `overlay=true` 스크립트에서만 의미가 있다 — 전용 패널 스크립트의 좌표계는
  메인 차트와 안 맞고, 이 엔진은 그 둘 사이를 변환하려 하지 않는다. 개수 상한(50개, 오래된 것부터
  삭제)은 다른 곳과 마찬가지로 line/box/label이 공유하고, 참조하는 선이 지워지면 그 선과 다른
  선 사이의 채움도 같이 사라진다.
- **`strategy(...)` 백테스트** (`core/pine-strategy.js`) — 실제 틱 데이터 없이 확정봉(OHLC)만으로
  주문 체결을 근사하므로, TradingView 실제 결과와 완전히 같지는 않다.
  - **체결 타이밍**: bar i에서 낸 시장가 주문은 bar i+1의 시가(+슬리피지)에 체결된다. 지정가/
    스탑 주문은 bar i+1부터 매 bar의 `[low, high]`가 그 가격에 닿을 때 체결(닿을 때까지 계속
    대기). `strategy.exit`의 익절/손절/트레일링 브라켓도 해당 진입이 열려있는 동안 매 bar 계속
    검사한다. `process_orders_on_close=true`(또는 `strategy.close`류의 `immediately=true`)인
    시장가 주문만 예외적으로 주문을 낸 그 bar의 종가에 바로 체결된다.
  - 같은 bar에 익절/손절이 동시에 `[low, high]` 범위 안에 들어오면 보수적으로 손절을 먼저
    체결시킨다.
  - `slippage`(틱 단위)의 "1틱"은 고정된 유효숫자 5자리 가격 규칙(예: BTC 65432→틱 1, ETH
    1423.3→틱 0.1, SOL 72.122→틱 0.001)으로 계산하며, 하이퍼리퀴드의 실제 가격 단위 관례와
    일치한다 — `syminfo.mintick`과 같은 규칙(위 참고)이다. 심볼별 틱 사이즈 상한까지는 반영하지
    않는다.
  - 포지션은 순 포지션(net position) 모델만 지원 — 반대 방향 `strategy.entry`가 들어오면 기존
    포지션을 전량 청산 후 새로 연다(실제 Pine 기본 동작과 동일). 헤징(동시 롱+숏)은 지원하지
    않는다.
  - `pyramiding` 기본값은 1(추가 진입 불가)로 취급한다.
  - `strategy.order()`는 별도 처리 없이 `strategy.entry()`와 동일하게 처리한다(반대 포지션 자동
    청산 포함) — 실제 Pine의 "포지션 정리 없이 바로 체결" 동작과는 다른 근사치.
  - `strategy.close()`의 절대 수량(`qty`) 인자는 무시하고 `qty_percent`만 지원한다(기본 100%).
  - `strategy.exit()`의 `trail_price`(절대가 트레일링 트리거)는 미지원 — `trail_points`/
    `trail_offset` 조합만 지원한다.
  - **테스트 기간**(TradingView "속성" 탭의 시작/종료일에 대응) — 지정하면 그 범위 밖 bar에서는
    `strategy.entry`/`order`/`close`/`close_all`/`exit` 호출 자체가 조용히 무시되고, 대기 주문
    체결·마크투마켓도 건너뛴다(자산곡선은 기간이 끝난 시점에서 멈춘 채로 남는다). 지정하지 않으면
    넘겨받은 전체 봉 구간이 대상이다. `strategy(...)` 스크립트 인자 자체에는 대응하는 파라미터가
    없다 — `OpenPine.run()`을 부를 때 `options.strategyPropsOverride`로 넘긴다.
  - `margin_long`/`margin_short`(증거금 콜)은 지원 안 함 — 자금이 부족해도 항상 체결 가능하다고
    가정한다.
  - `calc_on_every_tick`은 무시 — 이 엔진은 항상 확정봉 종가 기준으로만 계산한다
    (`barstate.isconfirmed`가 항상 `true`인 것과 같은 이유).
  - OCA(`oca_name`/`oca_type`)는 "하나 체결되면 나머지 취소"로만 근사 구현 —
    `strategy.oca.reduce`(수량 축소)도 `cancel`과 동일하게 취소로 처리한다.
  - **매매 마커** — 결과에 진입/청산마다 체결 수량(부호로 매수/매도 표시)과 `comment=` 문구가
    함께 포함된다(예: `strategy.entry(..., comment="Bullish")` → `+1` 마커에 `"Bullish"`가
    딸려옴). 피라미딩으로 같은 id·방향에 여러 번 물릴 때는 최초 체결의 comment만 남는다(내부적
    으로 하나의 진입으로 합쳐지기 때문).
    **반전(reverse) 주문**: 반대 방향 포지션을 들고 있는 상태에서 `strategy.entry()`를 부르면
    "기존 포지션 청산분 + 새 포지션 진입분"을 한 주문으로 체결한 것으로 취급한다 — 숏 1을 들고
    있다가 `strategy.entry(long, qty=1)`을 부르면 마커에는 `+2`로 표시된다(숏 1을 덮는 몫 + 새
    롱 1). 이때 반전으로 인해 청산된 포지션은 별도의 청산 마커를 갖지 않는다(같은 봉에 두 마커가
    겹쳐 찍혀 헷갈리는 것을 막기 위함). `strategy.close()`/`strategy.exit()`로 인한 명시적 청산은
    반전이 아니므로 항상 자기 자신의 청산 마커를 갖는다.

## 지원하는 것 (요약)

변수 선언(`var`/`varip` 포함, 함수 내부의 `var`도 bar 간 상태 유지됨), `if`/`else`, `for`(카운팅 /
`for..in` / `for [idx,val] in`), `while`, `switch`, `break`/`continue`, 사용자 정의 함수와
`method`(타입별 오버로딩 포함 — 정적 타입으로 고르므로 `int`/`float`, `color`/`string`으로 갈리는
것도 됨), 타입 표기가 붙은 선언·매개변수·필드(`float x = 0`, `int x`처럼 초기값 없는 선언,
`simple string t`, `array<lvl> levels`, `float[] xs`), 사용자 정의 타입(`type` — struct, 중첩
가능), 배열(`array.*` 전체 — `slice`/`binary_search*`/`percentrank`/`covariance`/`standardize`
등 포함), 튜플(`[a,b] = ...`), `ta.*`/`math.*`/`color.*`/`str.*`/`input.*` 대부분(괄호 없이 값으로
쓰는 내장 시리즈 변수 `ta.tr`/`ta.obv`/`ta.accdist`/`ta.vwap`/`ta.iii`/`ta.nvi`/`ta.pvi`/`ta.pvt`/
`ta.wad`/`ta.wvad` 포함), `request.security()`/`request.security_lower_tf()`(위 제약 하에),
`plot()`/`hline()`/`plotshape()`/`plotchar()`, `line.new`/`box.new`/`label.new`(및 `.set_*`
메서드들), `linefill.new`/`delete`/`set_color`/`get_line1`/`get_line2`/`linefill.all`, 타입 캐스트
(`int()`/`float()`/`bool()`/`string()`/`color()`/`line()`/`label()`/`box()`/`table()`/`linefill()`
— `matrix.new<line>(1, 10, line(na))`처럼 빈 초기값을 만드는 형태), `table.new`/`table.cell`(및
`.delete`/`cell_set_*` 등 — 실제 화면 렌더링은 전적으로 이 엔진을 임베드하는 호스트 몫이고,
엔진은 cells가 채워진 table 객체를 돌려준다), `map.*`(`put`/`get`/`contains`/`remove`/`clear`/
`copy`/`keys`/`values`/`size`/`put_all`), `matrix.*`(구조 조작·통계 전체 + `det`/`inv`/`rank`/
`mult`/`pow`/`eigenvalues`/`eigenvectors`/`pinv` — 위 "부분 지원" 제약 하에), `strategy(...)`
백테스트(`strategy.entry`/`order`/`close`/`close_all`/`exit`/`cancel`/`cancel_all`, 위 제약 하에
— 체결·손익 결과는 `OpenPine.run()`의 결과 객체에 담겨 나온다).

---
마지막 갱신 시점 기준으로 실제 테스트를 통해 확인된 내용이며, 이후 엔진이 계속 확장될 수 있으므로
이 문서와 실제 코드(`core/pine-*.js` 상단 주석)가 어긋나 보이면 코드 쪽이 최신이라고 보면 된다.
