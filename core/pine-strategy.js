/* pine-strategy.js
   Core simulation of order fills, positions, and P&L for strategy() scripts.
   pine-interpreter.js calls processStrategyBar() once at the end of the bar loop to fill pending
   orders/brackets against that bar's OHLC and mark-to-market, while the strategy.* functions in
   pine-builtins.js enqueue orders via pineStrategyQueueEntry and similar.

   Execution timing model (approximated on a confirmed-bar basis only, since no real tick data is
   available — see PINE_ENGINE.md):
   - A market order placed on bar i fills at bar i+1's open (+ slippage).
   - Limit/stop orders are checked against each bar's [low,high] range starting from bar i+1, and
     fill when touched (they remain pending until canceled).
   - strategy.exit's profit target/stop loss/trailing stop are checked every bar for as long as the
     corresponding entry stays open.
   - As an exception, only market orders with process_orders_on_close=true (or immediately=true on
     strategy.close-type calls) fill immediately at the close of the bar the order was placed on.
   - If both the profit target and stop loss fall within range on the same bar, the stop loss is
     conservatively filled first.
   - Slippage's "1 tick" is computed using Hyperliquid's actual price-unit rule (5 significant
     digits — e.g. for BTC 65432 with 5 integer digits, tick=1; for ETH 1423.3 with 4 integer
     digits + 1 decimal, tick=0.1; for SOL 72.122 with 2 integer digits + 3 decimals, tick=0.001).
     This doesn't account for the per-symbol szDecimals cap (this app doesn't have that
     information), but in practice the 5-significant-digit rule is what governs fill prices for
     nearly all active pairs, so this is accurate enough — it's exactly the same rule js/util.js's
     formatPrice() uses to display prices on screen.
   strategy() 스크립트의 주문 체결 · 포지션 · 손익 시뮬레이션 코어.
   pine-interpreter.js가 bar 루프 끝에서 processStrategyBar()를 한 번씩 불러 그 bar의 OHLC로
   대기 주문/브라켓을 체결하고 마크투마켓하며, pine-builtins.js의 strategy.* 함수들이
   pineStrategyQueueEntry 등으로 주문을 큐에 넣는다.

   실행 타이밍 모델(다른 실제 틱 데이터가 없어 확정봉 기준으로만 근사한 것 — PINE_ENGINE.md 참고):
   - bar i에서 낸 시장가 주문은 bar i+1의 시가(+슬리피지)에 체결된다.
   - 지정가/스탑 주문은 bar i+1부터 매 bar [low,high] 범위를 검사해 닿으면 체결(취소 전까지 계속 대기).
   - strategy.exit의 익절/손절/트레일링은 해당 진입이 열려있는 동안 매 bar 계속 검사한다.
   - process_orders_on_close=true(또는 strategy.close류의 immediately=true)인 시장가 주문만
     예외적으로 "주문을 낸 그 bar의 종가"에 바로 체결한다.
   - 같은 bar에 익절/손절이 동시에 range 안에 들어오면 보수적으로 손절을 먼저 체결시킨다.
   - 슬리피지의 "1틱"은 하이퍼리퀴드의 실제 가격 단위 규칙(유효숫자 5자리 — 예: BTC 65432처럼
     정수부가 5자리면 틱=1, ETH 1423.3처럼 정수부 4자리+소수 1자리면 틱=0.1, SOL 72.122처럼
     정수부 2자리+소수 3자리면 틱=0.001)로 계산한다. 심볼별 szDecimals 상한까지는 반영 못 하지만
     (그 정보를 이 앱이 갖고 있지 않음), 실제로 거의 모든 활성 페어에서 체결가를 좌우하는 건
     5자리 유효숫자 규칙 쪽이라 이걸로 충분히 정확하다 — js/util.js의 formatPrice()가 화면에
     가격을 표시할 때 쓰는 것과 완전히 같은 규칙이다.
*/

// The value of the "last (5th) digit" under the 5-significant-digit rule = the minimum price unit
// (tick). Computing the digit count directly via Math.log10() can be off by one digit for values
// that are exact powers of 10 (e.g. 1000) due to floating-point error, so toExponential() is used
// instead to get the exact exponent.
// 5자리 유효숫자 규칙에서 "마지막(5번째) 자리"의 값 = 최소 가격 단위(틱). Math.log10()으로 직접
// 자릿수를 구하면 부동소수점 오차로 정확히 10의 거듭제곱인 값(예: 1000)에서 한 자리씩 밀릴 수
// 있어서, toExponential()로 정확한 지수를 뽑아 쓴다.
function pineStrategyTickSize(price){
  const p = Math.abs(price);
  if(!(p > 0)) return 1e-8;
  const exp = parseInt(p.toExponential().split('e')[1], 10);
  return Math.pow(10, exp - 4);
}

function pineStrategyCommission(state, qty, price){
  if(!state.commissionValue) return 0;
  if(state.commissionType === 'cash_per_contract') return state.commissionValue * qty;
  if(state.commissionType === 'cash_per_order') return state.commissionValue;
  return (state.commissionValue / 100) * qty * price; // percent (default) / percent (기본값)
}

function createPineStrategyState(opts){
  const initialCapital = opts.initialCapital != null ? opts.initialCapital : 1000000;
  return {
    initialCapital,
    qtyType: opts.qtyType || 'fixed', // 'fixed' | 'cash' | 'percent_of_equity'
    qtyValue: opts.qtyValue != null ? opts.qtyValue : 1,
    commissionType: opts.commissionType || 'percent',
    commissionValue: opts.commissionValue || 0,
    slippageTicks: opts.slippageTicks || 0,
    pyramiding: Math.max(1, opts.pyramiding || 1),
    processOrdersOnClose: !!opts.processOrdersOnClose,
    // Test period (same concept as TradingView Strategy Tester's "Test Period") — unix seconds;
    // null means no lower/upper bound (the full range loaded on the chart). Can only be set from
    // the Properties tab (there is no corresponding parameter in the strategy() script arguments).
    // 테스트 기간(TradingView Strategy Tester의 "Test Period"와 동일한 개념) — unix seconds,
    // null이면 하한/상한 없음(차트에 로드된 전체 구간). Properties 탭에서만 설정 가능(스크립트
    // strategy() 인자에는 대응하는 파라미터가 없다).
    testStart: opts.testStart != null ? opts.testStart : null,
    testEnd: opts.testEnd != null ? opts.testEnd : null,
    cash: initialCapital,
    entryCount: 0, // Number of fills (entries) accumulated in the current direction — compared against the pyramiding limit (includes ones merged into the same id) / 지금 방향으로 누적된 체결(진입) 횟수 — pyramiding 한도와 비교(같은 id로 합쳐진 것도 포함)
    entries: [], // Currently open entries: {id, direction, qty, avgPrice, entryBarIdx, entryTime, commissionPaid} / 현재 열린 진입들: {id, direction, qty, avgPrice, entryBarIdx, entryTime, commissionPaid}
    pendingOrders: [],
    brackets: [], // Active brackets registered via strategy.exit / strategy.exit로 등록된 활성 브라켓
    closedTrades: [],
    equityCurve: new Array(0),
    openProfit: 0,
    equity: initialCapital,
    maxEquity: initialCapital,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    grossProfit: 0,
    grossLoss: 0,
    winTrades: 0,
    lossTrades: 0,
  };
}

function pineStrategyPositionSize(state){ return state.entries.reduce((s, e) => s + e.direction * e.qty, 0); }
function pineStrategyPositionAvgPrice(state){
  const size = pineStrategyPositionSize(state);
  if(!size) return 0;
  const dir = size > 0 ? 1 : -1;
  const relevant = state.entries.filter(e => e.direction === dir);
  const totalQty = relevant.reduce((s, e) => s + e.qty, 0);
  if(!totalQty) return 0;
  return relevant.reduce((s, e) => s + e.qty * e.avgPrice, 0) / totalQty;
}

function pineStrategyInRange(state, time){
  if(state.testStart != null && time < state.testStart) return false;
  if(state.testEnd != null && time > state.testEnd) return false;
  return true;
}

function pineStrategyDefaultQty(state, price){
  if(state.qtyType === 'cash') return price > 0 ? state.qtyValue / price : 0;
  if(state.qtyType === 'percent_of_equity') return price > 0 ? (state.equity * (state.qtyValue / 100)) / price : 0;
  return state.qtyValue; // fixed
}

// ---------- Order queue ----------
// ---------- 주문 큐 ----------
function pineStrategyQueueOrder(state, order, curBarIdx){
  order.queuedAtBar = curBarIdx;
  order.canceled = false;
  order.filled = false;
  state.pendingOrders.push(order);
  return order;
}

function pineStrategyCancel(state, id){
  state.pendingOrders.forEach(o => { if(o.id === id) o.canceled = true; });
  state.brackets.forEach(b => { if(b.id === id) b.canceled = true; });
}
function pineStrategyCancelAll(state){
  state.pendingOrders.forEach(o => { o.canceled = true; });
  state.brackets.forEach(b => { b.canceled = true; });
}
function pineStrategyCancelOcaSiblings(state, ocaName, exceptOrder){
  if(!ocaName) return;
  state.pendingOrders.forEach(o => { if(o !== exceptOrder && o.ocaName === ocaName) o.canceled = true; });
}

// ---------- Order execution ----------
// ---------- 체결 실행 ----------
// direction: 1 (long) / -1 (short). If an opposite-direction position exists, it is fully closed
// before opening the new one (Pine's default net-position model).
// pyramiding means "the number of fills allowed in the same direction," so re-entering with the
// same id and merging quantity into an existing entry must count toward the limit the same way
// entering with a new id does (tracked via state.entryCount — relying on state.entries.length
// alone misses "the count of merges into the same id," which caused a bug where, in scripts whose
// signal stayed true for several consecutive bars, quantity would pile up infinitely on the same
// id even with pyramiding=1).
// direction: 1(롱)/-1(숏). 반대 방향 포지션이 있으면 전부 청산 후 새로 연다(Pine 기본 넷 포지션 모델).
// pyramiding은 "같은 방향으로 허용되는 체결 횟수"를 뜻해서, 같은 id로 다시 들어와 기존 진입에
// 수량을 합치는 경우도 새 id로 진입하는 경우와 똑같이 한도에 포함시켜야 한다(state.entryCount로
// 추적 — state.entries.length만 보면 "같은 id로 합쳐진 횟수"가 안 잡혀서, 신호가 여러 bar 연속으로
// 참인 스크립트에서 pyramiding=1이어도 같은 id에 수량이 무한히 쌓이는 버그가 있었다).
function pineStrategyExecuteEntry(state, { id, direction, qty, price, barIdx, time, comment }){
  const curSize = pineStrategyPositionSize(state);
  // When entering while holding an opposite position (a reversal), real exchanges/TradingView fill
  // "the existing position's closing portion + the new position's opening portion" together as one
  // order — e.g. if you're holding a short of 1 and call strategy.entry(long, qty=1), 2 contracts
  // are actually bought (1 covers the short, 1 opens a new long), so the net position becomes +1.
  // The quantity shown on the trade marker ("+2") also refers to this combined order size.
  // reversedQty remembers that closing portion (= the share carried along in this one order) and
  // adds it to the new entry's orderQty.
  // 반대 포지션을 안고 있는 상태에서 진입하면(반전) 실제 거래소/TradingView는 "기존 포지션
  // 청산분 + 새 포지션 진입분"을 한 주문으로 같이 체결한다 — 예를 들어 숏 1을 들고 있는데
  // strategy.entry(long, qty=1)을 부르면 실제로는 2계약을 매수해서(1은 숏을 덮고, 1은 새 롱을
  // 연다) 순포지션이 +1이 된다. 매매 마커에 찍히는 수량("+2")도 이 합산 주문 크기를 뜻한다.
  // reversedQty는 그 청산분(=이번 한 주문에 같이 실린 몫)을 기억해뒀다가 새 entry의 orderQty에 더한다.
  let reversedQty = 0;
  if(curSize !== 0 && Math.sign(curSize) !== direction){
    reversedQty = Math.abs(curSize);
    // viaReversal=true — this close is not a separate order but part of the reversal order, so on
    // the trade-marker side it is not drawn as an independent close marker; instead it is merged
    // into and shown on the new entry's marker (pine-import.js).
    // viaReversal=true — 이 청산은 별도 주문이 아니라 반전 주문의 일부라서, 매매 마커 쪽에서
    // 독립된 청산 마커를 그리지 않고 새 entry의 마커에 합쳐서 보여준다(pine-import.js).
    pineStrategyCloseEntries(state, state.entries.slice(), price, barIdx, time, comment || 'reverse', true); // Once everything is closed, pineStrategyCloseQty resets entryCount back to 0 / 다 청산되면 pineStrategyCloseQty가 entryCount를 0으로 되돌려준다
  }
  if(state.entryCount >= state.pyramiding) return; // Pyramiding limit exceeded — silently ignored (includes merges into the same id) / 피라미딩 한도 초과 — 조용히 무시(같은 id로 합치는 것도 포함)
  const commission = pineStrategyCommission(state, qty, price);
  state.cash -= commission;
  state.entryCount++;
  const existing = state.entries.find(e => e.id === id && e.direction === direction);
  if(existing){
    const newQty = existing.qty + qty;
    existing.avgPrice = (existing.avgPrice * existing.qty + price * qty) / newQty;
    existing.qty = newQty;
    existing.commissionPaid += commission;
    // When re-adding to the same id via pyramiding, the comment is discarded — the same rule as
    // entryTime/entryBarIdx not changing from the original fill (the entry itself is treated as
    // one, and the original comment is the representative value).
    // orderQty (the order size of the original fill) is likewise left untouched.
    // 피라미딩으로 같은 id에 다시 물릴 때의 comment는 버린다 — entryTime/entryBarIdx도 최초
    // 체결 기준으로 안 바뀌는 것과 같은 규칙(진입 자체는 하나로 취급, 최초 comment가 대표값).
    // orderQty(최초 체결의 주문 크기)도 마찬가지로 안 건드린다.
    return;
  }
  // The comment (strategy.entry's comment= argument) must be saved here so trade markers/fill
  // history can later show "why this was entered" — previously it was only received as an
  // argument and never stored anywhere, so it always got lost.
  // orderQty = requested qty + the portion closed together via reversal — the "actual order
  // quantity" to display on the trade marker.
  // comment(strategy.entry의 comment= 인자)를 여기서 저장해둬야 나중에 매매 마커/체결 내역에
  // "왜 들어갔는지" 표시할 수 있다 — 예전엔 인자로만 받고 아무 데도 저장하지 않아서 늘 사라졌다.
  // orderQty = 요청한 qty + 반전으로 같이 청산된 몫 — 매매 마커에 표시할 "실제 주문 수량".
  state.entries.push({ id, direction, qty, avgPrice: price, entryBarIdx: barIdx, entryTime: time, commissionPaid: commission, entryComment: comment || '', orderQty: qty + reversedQty });
}

// Closes part (or all) of an entry's qty — for a partial close, the entry stays in state.entries
// with its remaining quantity; for a full close, it is removed from the array and any brackets
// attached to that entry are canceled too.
// (Previously, a new "detached piece" object was created and passed for partial closes, but that
// piece wasn't in state.entries so indexOf couldn't find it and nothing happened — this was fixed
// by switching to a scheme that takes just an entry reference + quantity, directly shrinking the
// original entry in place.)
// viaReversal: true if this close happened during strategy.entry()'s reversal (reverse) handling —
// on the trade-marker side (pine-import.js), this close is not drawn as an independent marker;
// it's only reflected in (merged into the quantity of) the new entry's marker that was filled
// together in the same order. Always false for explicit strategy.close()/exit().
// entry의 qty 중 일부(또는 전부)를 청산한다 — 부분청산이면 entry는 남은 수량으로 state.entries에
// 그대로 남고, 전량청산이면 배열에서 빠지고 그 entry에 붙어있던 브라켓들도 함께 취소된다.
// (전에는 부분청산용으로 "떨어져나온 조각" 객체를 새로 만들어 넘겼는데, 그 조각은 state.entries
// 안에 없어서 indexOf가 못 찾아 아무 일도 안 일어나는 버그가 있었다 — entry 참조 + 수량만 받는
// 방식으로 바꿔서 원본 entry를 그 자리에서 직접 줄이도록 고쳤다.)
// viaReversal: 이 청산이 strategy.entry()의 반전(reverse) 처리 중에 일어났으면 true — 매매 마커
// 쪽(pine-import.js)에서 이 청산은 독립된 마커로 그리지 않고, 같은 주문으로 함께 체결된 새
// entry의 마커(수량에 합산됨)에만 반영한다. 명시적 strategy.close()/exit()에서는 항상 false.
function pineStrategyCloseQty(state, entry, qty, price, barIdx, time, comment, viaReversal){
  const idx = state.entries.indexOf(entry);
  if(idx === -1) return;
  const closeQty = Math.min(qty, entry.qty);
  if(!(closeQty > 0)) return;
  const commissionShare = entry.commissionPaid * (closeQty / entry.qty);
  const exitCommission = pineStrategyCommission(state, closeQty, price);
  const pnl = entry.direction * (price - entry.avgPrice) * closeQty - commissionShare - exitCommission;
  state.cash += entry.direction * (price - entry.avgPrice) * closeQty - exitCommission;
  if(pnl > 0){ state.grossProfit += pnl; state.winTrades++; }
  else if(pnl < 0){ state.grossLoss += pnl; state.lossTrades++; }
  state.closedTrades.push({
    id: entry.id, direction: entry.direction, qty: closeQty,
    entryPrice: entry.avgPrice, entryTime: entry.entryTime, entryBarIdx: entry.entryBarIdx,
    exitPrice: price, exitTime: time, exitBarIdx: barIdx,
    pnl, comment: comment || '', entryComment: entry.entryComment || '', // comment is this close's (exit's) comment, entryComment is the comment from when it entered / comment는 이 청산(exit)의 comment, entryComment는 진입할 때의 comment
    entryOrderQty: entry.orderQty != null ? entry.orderQty : closeQty, // the actual order quantity when this entry was opened (includes the closed portion if it was a reversal) / 이 entry가 열릴 때의 실제 주문 수량(반전이었으면 청산분 포함)
    viaReversal: !!viaReversal,
  });
  entry.qty -= closeQty;
  entry.commissionPaid -= commissionShare;
  if(entry.qty <= 1e-9){
    state.entries.splice(idx, 1); // the index found above — the array order doesn't change in between / 위에서 이미 찾아둔 인덱스 — 그 사이 배열 순서는 안 바뀐다
    state.brackets.forEach(b => { if(b.entryRef === entry) b.canceled = true; });
  }
  if(!state.entries.length) state.entryCount = 0; // once fully flat, reset the pyramiding count too / 완전히 플랫이 됐으면 피라미딩 카운트도 리셋
}
function pineStrategyCloseEntries(state, entries, price, barIdx, time, comment, viaReversal){
  entries.forEach(e => pineStrategyCloseQty(state, e, e.qty, price, barIdx, time, comment, viaReversal));
}

function pineStrategyQueueEntry(state, opts, curBarIdx){
  if(!pineStrategyInRange(state, opts.time)) return null; // outside the test period (Properties tab) — the signal itself is ignored / 테스트 기간(Properties 탭) 밖 — 신호 자체를 무시
  const order = Object.assign({ kind: 'entry' }, opts);
  if(state.processOrdersOnClose && order.limit == null && order.stop == null){
    pineStrategyExecuteEntry(state, { id: order.id, direction: order.direction, qty: order.qty, price: opts.marketPrice, barIdx: curBarIdx, time: opts.time, comment: order.comment });
    return null;
  }
  return pineStrategyQueueOrder(state, order, curBarIdx);
}
function pineStrategyQueueClose(state, opts, curBarIdx){
  if(!pineStrategyInRange(state, opts.time)) return null;
  const order = Object.assign({ kind: 'close' }, opts);
  if(state.processOrdersOnClose || opts.immediately){
    pineStrategyFillClose(state, order, opts.marketPrice, curBarIdx, opts.time);
    return null;
  }
  return pineStrategyQueueOrder(state, order, curBarIdx);
}
function pineStrategyFillClose(state, order, price, barIdx, time){
  const targets = order.id ? state.entries.filter(e => e.id === order.id) : state.entries.slice();
  const pct = (order.qtyPercent != null ? Math.min(100, Math.max(0, order.qtyPercent)) : 100) / 100;
  targets.forEach(e => pineStrategyCloseQty(state, e, e.qty * pct, price, barIdx, time, order.comment));
}

// strategy.exit — registers a profit/loss/trail bracket (no immediate fill, checked every bar)
// strategy.exit — profit/loss/trail 브라켓 등록(즉시 체결 없음, 매 bar 검사됨)
function pineStrategyRegisterExit(state, opts, curBarIdx){
  if(!pineStrategyInRange(state, opts.time)) return null;
  const targetEntries = opts.fromEntry ? state.entries.filter(e => e.id === opts.fromEntry) : state.entries.slice();
  if(!targetEntries.length) return null;
  const brackets = targetEntries.map(e => ({
    id: opts.id, entryRef: e, ocaName: opts.ocaName, comment: opts.comment,
    qty: opts.qty != null ? opts.qty : (opts.qtyPercent != null ? e.qty * (opts.qtyPercent / 100) : e.qty),
    limitPrice: opts.limit != null ? opts.limit : (opts.profit != null ? e.avgPrice + e.direction * opts.profit : null),
    stopPrice: opts.stop != null ? opts.stop : (opts.loss != null ? e.avgPrice - e.direction * opts.loss : null),
    trailPoints: opts.trailPoints, trailOffset: opts.trailOffset,
    trailActive: false, trailStopPrice: null, trailBestPrice: e.avgPrice,
    registeredAtBar: curBarIdx, canceled: false,
  }));
  state.brackets.push(...brackets);
  return brackets;
}

// ---------- Per bar: fill pending orders + check brackets + mark-to-market ----------
// ---------- bar마다: 대기 주문 체결 + 브라켓 체크 + 마크투마켓 ----------
function pineStrategyFillPriceForLevel(bar, level, isUpperTrigger){
  // If a gap already opened past that level, fill at the open; otherwise fill at the level itself
  // 갭으로 이미 그 레벨을 넘어 시작했으면 시가에 체결, 아니면 레벨 그 자체에 체결
  if(isUpperTrigger) return bar.open >= level ? bar.open : level;
  return bar.open <= level ? bar.open : level;
}

function pineStrategyProcessPendingOrders(state, bar, barIdx){
  let ordersDone = false, bracketsDone = false;
  for(const order of state.pendingOrders){
    if(order.filled || order.canceled){ ordersDone = true; continue; }
    if(order.queuedAtBar >= barIdx) continue; // an order just placed on this bar is checked starting from the next bar / 이번 bar에 방금 낸 주문은 다음 bar부터 검사
    let fillPrice = null;
    if(order.kind === 'entry'){
      if(order.limit == null && order.stop == null){
        fillPrice = bar.open + order.direction * pineStrategyTickSize(bar.open) * state.slippageTicks;
      } else if(order.limit != null){
        const isUpper = order.direction < 0; // a short-entry limit = sold at that price or higher / 숏 진입 지정가 = 그 가격 이상에서 팔림
        const touched = isUpper ? bar.high >= order.limit : bar.low <= order.limit;
        if(touched) fillPrice = pineStrategyFillPriceForLevel(bar, order.limit, isUpper);
      } else if(order.stop != null){
        const isUpper = order.direction > 0; // a long-entry stop = bought once price rises to that level or above / 롱 진입 스탑 = 그 가격 이상으로 오르면 매수
        const touched = isUpper ? bar.high >= order.stop : bar.low <= order.stop;
        if(touched){
          fillPrice = pineStrategyFillPriceForLevel(bar, order.stop, isUpper);
          fillPrice += order.direction * pineStrategyTickSize(fillPrice) * state.slippageTicks;
        }
      }
      if(fillPrice != null){
        order.filled = true; ordersDone = true;
        pineStrategyExecuteEntry(state, { id: order.id, direction: order.direction, qty: order.qty, price: fillPrice, barIdx, time: bar.time, comment: order.comment });
        pineStrategyCancelOcaSiblings(state, order.ocaName, order);
      }
    } else if(order.kind === 'close'){
      order.filled = true; ordersDone = true;
      fillPrice = bar.open;
      pineStrategyFillClose(state, order, fillPrice, barIdx, bar.time);
    }
  }
  // If nothing was filled or canceled, there's no reason to rebuild the array (removes the
  // duplicate copy that used to be made twice per bar). cancelOcaSiblings etc. may have canceled
  // other orders mid-loop, so that case is also covered by ordersDone.
  // 체결/취소된 게 하나도 없으면 배열을 새로 만들 이유가 없다(bar마다 두 벌씩 만들어지던 사본 제거).
  // cancelOcaSiblings 등이 루프 도중 다른 주문을 취소했을 수도 있어 그 경우도 ordersDone에 포함된다.
  if(ordersDone || state.pendingOrders.some(o => o.filled || o.canceled)) state.pendingOrders = state.pendingOrders.filter(o => !o.filled && !o.canceled);

  // Brackets (profit target/stop loss/trailing) — starting from the bar after registration; if
  // the profit target and stop loss both trigger on the same bar, the stop loss goes first.
  // 브라켓(익절/손절/트레일링) — 등록된 다음 bar부터, 익절/손절이 같은 bar에 동시에 걸리면 손절 먼저.
  for(const b of state.brackets){
    if(b.canceled){ bracketsDone = true; continue; }
    if(state.entries.indexOf(b.entryRef) === -1){ b.canceled = true; bracketsDone = true; continue; } // already closed via another path / 이미 다른 경로로 청산됨
    if(b.registeredAtBar >= barIdx) continue;
    const dir = b.entryRef.direction;
    if(b.trailPoints != null){
      const favorable = dir > 0 ? bar.high : bar.low;
      if(!b.trailActive){
        const moved = dir * (favorable - b.entryRef.avgPrice);
        if(moved >= b.trailPoints){ b.trailActive = true; b.trailBestPrice = favorable; }
      } else if(dir * (favorable - b.trailBestPrice) > 0){
        b.trailBestPrice = favorable;
      }
      if(b.trailActive) b.trailStopPrice = b.trailBestPrice - dir * (b.trailOffset || 0);
    }
    let fillPrice = null;
    const stopLevel = b.trailActive ? b.trailStopPrice : b.stopPrice;
    if(stopLevel != null){
      const touched = dir > 0 ? bar.low <= stopLevel : bar.high >= stopLevel;
      if(touched) fillPrice = pineStrategyFillPriceForLevel(bar, stopLevel, dir < 0);
    }
    if(fillPrice == null && b.limitPrice != null){
      const touched = dir > 0 ? bar.high >= b.limitPrice : bar.low <= b.limitPrice;
      if(touched) fillPrice = pineStrategyFillPriceForLevel(bar, b.limitPrice, dir > 0);
    }
    if(fillPrice != null){
      b.canceled = true; bracketsDone = true;
      pineStrategyCloseQty(state, b.entryRef, b.qty, fillPrice, barIdx, bar.time, b.comment);
      pineStrategyCancelOcaSiblings(state, b.ocaName, null);
    }
  }
  if(bracketsDone || state.brackets.some(b => b.canceled)) state.brackets = state.brackets.filter(b => !b.canceled);
}

function pineStrategyMarkToMarket(state, bar, barIdx){
  const openProfit = state.entries.reduce((s, e) => s + e.direction * (bar.close - e.avgPrice) * e.qty, 0);
  state.openProfit = openProfit;
  state.equity = state.cash + openProfit;
  if(state.equity > state.maxEquity) state.maxEquity = state.equity;
  const dd = state.maxEquity - state.equity;
  if(dd > state.maxDrawdown){
    state.maxDrawdown = dd;
    state.maxDrawdownPct = state.maxEquity > 0 ? (dd / state.maxEquity) * 100 : 0;
  }
  state.equityCurve[barIdx] = state.equity;
}

// Processes a single bar — called by pine-interpreter.js "after" it executes that bar's statements.
// Bars outside the test period skip both fill checking and mark-to-market — the position/equity
// curve remains frozen at the end of the period (even if signals occur on later bars, they're
// already ignored in pineStrategyQueueEntry etc.).
// bar 하나 처리 — pine-interpreter.js가 그 bar의 statements를 실행한 "뒤"에 호출한다.
// 테스트 기간 밖의 bar는 체결 검사도 마크투마켓도 건너뛴다 — 포지션/자산곡선이 기간 끝에서
// 그대로 멈춘 상태로 남는다(그 이후 bar에서 신호가 나도 pineStrategyQueueEntry 등에서 이미 무시됨).
function processStrategyBar(state, bar, barIdx){
  if(!pineStrategyInRange(state, bar.time)) return;
  pineStrategyProcessPendingOrders(state, bar, barIdx);
  pineStrategyMarkToMarket(state, bar, barIdx);
}

function pineStrategyComputeStats(state){
  const netProfit = state.closedTrades.reduce((s, t) => s + t.pnl, 0);
  const totalTrades = state.closedTrades.length;
  const profitFactor = state.grossLoss !== 0 ? state.grossProfit / Math.abs(state.grossLoss) : (state.grossProfit > 0 ? Infinity : 0);
  return {
    initialCapital: state.initialCapital,
    qtyType: state.qtyType, qtyValue: state.qtyValue,
    commissionType: state.commissionType, commissionValue: state.commissionValue,
    slippageTicks: state.slippageTicks, pyramiding: state.pyramiding,
    testStart: state.testStart, testEnd: state.testEnd,
    netProfit, grossProfit: state.grossProfit, grossLoss: state.grossLoss,
    totalTrades, winTrades: state.winTrades, lossTrades: state.lossTrades,
    winRate: totalTrades ? (state.winTrades / totalTrades) * 100 : 0,
    profitFactor,
    maxDrawdown: state.maxDrawdown, maxDrawdownPct: state.maxDrawdownPct,
    equity: state.equity, openProfit: state.openProfit,
    equityCurve: state.equityCurve.slice(),
    closedTrades: state.closedTrades.slice(),
    openTrades: state.entries.map(e => ({ id: e.id, direction: e.direction, qty: e.qty, avgPrice: e.avgPrice, entryBarIdx: e.entryBarIdx, entryTime: e.entryTime, entryComment: e.entryComment || '', orderQty: e.orderQty != null ? e.orderQty : e.qty })),
  };
}
