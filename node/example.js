// node node/example.js
const OpenPine = require('./index.js');

const source = `//@version=6
indicator("SMA demo", overlay=true)
len = input.int(14, "Length")
s = ta.sma(close, len)
plot(s, "SMA")
`;

// Arbitrary bar data (time is a unix timestamp in seconds)
// 임의의 봉 데이터 (time은 초 단위 unix timestamp)
const bars = [];
let price = 100;
for(let i = 0; i < 30; i++){
  price += (Math.random() - 0.5) * 2;
  const o = price, c = price + (Math.random() - 0.5);
  bars.push({
    time: 1700000000 + i * 60,
    open: o, high: Math.max(o, c) + 0.5, low: Math.min(o, c) - 0.5, close: c, volume: 1000 + i,
  });
}

const result = OpenPine.run(source, bars, { inputOverrides: {} });
const smaPlot = [...result.plots.values()][0];
console.log('SMA last 5 values:', smaPlot.values.slice(-5));
