/* Low-memory fetcher; keep auto-start off. */

var CTRL_ID = 1;
var REQ_KEY = "np_se3_req_v1";
var API = "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices";
var RETRY = 300000;

var job = null;
var expected = 0;
var dayStart = 0;
var count = 0;
var limits = [0, 0];
var modes = [0, 0];
var lowText = "";
var highText = "";
var lowCount = 0;
var highCount = 0;
var lowNeed = 0;
var highNeed = 0;
var market = 0;

function log(message) {
  print("[NordPool fetcher] " + message);
}

function pad(value) {
  return value < 10 ? "0" + value : "" + value;
}

function dateKey(date) {
  return "" + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
}

function dateText(key) {
  return key.substring(0, 4) + "-" + key.substring(4, 6) + "-" + key.substring(6, 8);
}

function dateAt(key, hour) {
  return new Date(Number(key.substring(0, 4)), Number(key.substring(4, 6)) - 1,
    Number(key.substring(6, 8)), hour, 0, 0, 0);
}

function addDay(key, amount) {
  return dateKey(new Date(dateAt(key, 12).getTime() + amount * 86400000));
}

function isNumber(value) {
  return typeof value === "number" && value === value && value !== Infinity && value !== -Infinity;
}

function priceCode(price) {
  var value = Math.round(price * 1000) + 50000000;
  var text = "" + value;
  if (value < 0 || text.length > 8) throw new Error("Price range");
  return "00000000".substring(text.length) + text;
}

function insertPrice(code, slot, reverse) {
  var text = reverse ? highText : lowText;
  var kept = reverse ? highCount : lowCount;
  var need = reverse ? highNeed : lowNeed;
  if (need === 0) return;
  var low = 0;
  var high = kept;
  while (low < high) {
    var middle = Math.floor((low + high) / 2);
    var existing = text.substring(middle * 10, middle * 10 + 8);
    if ((reverse && code >= existing) || (!reverse && code < existing)) high = middle;
    else low = middle + 1;
  }
  if (low >= need && kept >= need) return;
  var slotText = slot.toString(36);
  if (slotText.length < 2) slotText = "0" + slotText;
  var at = low * 10;
  text = text.substring(0, at) + code + slotText + text.substring(at);
  if (text.length > need * 10) text = text.substring(0, need * 10);
  if (reverse) {
    highText = text;
    if (highCount < need) highCount++;
  } else {
    lowText = text;
    if (lowCount < need) lowCount++;
  }
}

function keepPrice(price, slot) {
  var code = priceCode(price);
  insertPrice(code, slot, false);
  insertPrice(code, slot, true);
}

function mask(channel) {
  var limit = limits[channel];
  var digits = [];
  var length = Math.ceil(expected / 4);
  for (var index = 0; index < length; index++) digits.push(0);
  if (limit === expected || modes[channel] === 1) {
    for (var all = 0; all < expected; all++) digits[Math.floor(all / 4)] += 1 << (all % 4);
  }
  var records = modes[channel] === 1 ? highText : lowText;
  var recordCount = modes[channel] === 1 ? expected - limit : limit;
  for (var rank = 0; rank < recordCount; rank++) {
    var slot = parseInt(records.substring(rank * 10 + 8, rank * 10 + 10), 36);
    var bit = 1 << (slot % 4);
    if (modes[channel] === 1) digits[Math.floor(slot / 4)] -= bit;
    else digits[Math.floor(slot / 4)] += bit;
  }
  var text = "";
  for (var digit = 0; digit < length; digit++) text += digits[digit].toString(16);
  return text;
}

function parse(body) {
  var startTag = "\"deliveryStart\":\"";
  var areaTag = "\"entryPerArea\":{";
  var priceTag = "\"SE3\":";
  var position = 0;
  var entries = 0;
  var dataEnd = body.indexOf("\"blockPriceAggregates\"");

  if (typeof body !== "string" || body.indexOf("\"multiAreaEntries\"") < 0) throw new Error("Bad response");
  if (dataEnd < 0) dataEnd = body.length;
  while (true) {
    var startAt = body.indexOf(startTag, position);
    if (startAt < 0 || startAt >= dataEnd) break;
    startAt += startTag.length;
    var startEnd = body.indexOf("\"", startAt);
    var areaAt = body.indexOf(areaTag, startEnd);
    if (startEnd < 0 || areaAt < 0) throw new Error("Bad entry");
    areaAt += areaTag.length;
    var areaEnd = body.indexOf("}", areaAt);
    var start = new Date(body.substring(startAt, startEnd)).getTime();
    if (!isNumber(start)) throw new Error("Bad interval");

    if (dateKey(new Date(start)) === job.d) {
      if (start !== dayStart + count * 900000) throw new Error("Missing slot");
      var priceAt = body.indexOf(priceTag, areaAt);
      if (priceAt < 0 || priceAt >= areaEnd) throw new Error("Missing SE3 price");
      priceAt += priceTag.length;
      var priceEnd = priceAt;
      while (priceEnd < areaEnd && ",}".indexOf(body.charAt(priceEnd)) < 0) priceEnd++;
      var price = Number(body.substring(priceAt, priceEnd));
      if (!isNumber(price)) throw new Error("Bad SE3 price");
      keepPrice(price, count);
      count++;
    }
    entries++;
    position = areaEnd + 1;
  }
  if (entries === 0) throw new Error("No delivery entries");
}

function fetchNext() {
  var key = market === 0 ? addDay(job.d, -1) : job.d;
  var url = API + "?currency=EUR&market=DayAhead&deliveryArea=SE3&date=" + dateText(key);
  Shelly.call("HTTP.GET", { url: url, timeout: 30 }, fetched);
}

function fetched(result, errorCode, errorMessage) {
  try {
    if (errorCode !== 0 || !result || result.code !== 200) throw new Error("HTTP " + errorCode + " " + errorMessage);
    parse(result.body);
    result = null;
    market++;
    if (market < 2) Timer.set(5000, false, fetchNext);
    else Timer.set(1, false, finish);
  } catch (error) {
    fail(error.message || "Price parsing failed");
  }
}

function finish() {
  if (count !== expected) return fail("Expected " + expected + " intervals, got " + count);
  Timer.set(1, false, saveReady);
}

function saveReady() {
  var plan = { d: job.d, n: expected, a: mask(0), b: mask(1), x: limits[0], y: limits[1] };
  Shelly.call("KVS.Set", { key: REQ_KEY, value: JSON.stringify({ plan: plan }) }, saved);
}

function saved(result, errorCode, errorMessage) {
  if (errorCode !== 0) return fail("KVS save failed: " + errorMessage);
  log("Plan ready: " + dateText(job.d) + ", " + expected + " slots");
  lowText = "";
  highText = "";
  restart();
}

function stopSelf() {
  Shelly.call("Script.Stop", { id: Script.id });
}

function restart() {
  Shelly.call("Script.Start", { id: CTRL_ID }, function () {
    stopSelf();
  });
}

function fail(message) {
  log("Fetch failed: " + message + "; retry in 5 min");
  job.retry = Math.floor(Date.now()) + RETRY;
  lowText = "";
  highText = "";
  Shelly.call("KVS.Set", { key: REQ_KEY, value: JSON.stringify(job) }, restart);
}

function loaded(result, errorCode) {
  if (errorCode !== 0 || !result) {
    return stopSelf();
  }
  try {
    job = typeof result.value === "string" ? JSON.parse(result.value) : result.value;
    if (!job || !job.d || !job.h || job.retry > Date.now()) throw new Error("Request is not ready");
    var start = dateAt(job.d, 0);
    var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0);
    dayStart = start.getTime();
    expected = Math.round((end.getTime() - dayStart) / 900000);
    limits[0] = Math.min(Math.round(job.h[0] * 4), expected);
    limits[1] = Math.min(Math.round(job.h[1] * 4), expected);
    var costs = [Math.max(limits[0], limits[1]), expected - Math.min(limits[0], limits[1]),
      limits[0] + expected - limits[1], limits[1] + expected - limits[0]];
    var choice = 0;
    for (var option = 1; option < 4; option++) if (costs[option] < costs[choice]) choice = option;
    modes = choice === 0 ? [0, 0] : (choice === 1 ? [1, 1] : (choice === 2 ? [0, 1] : [1, 0]));
    for (var channel = 0; channel < 2; channel++) {
      if (modes[channel] === 0 && limits[channel] > lowNeed) lowNeed = limits[channel];
      if (modes[channel] === 1 && expected - limits[channel] > highNeed) highNeed = expected - limits[channel];
    }
    fetchNext();
  } catch (error) {
    restart();
  }
}

Shelly.call("KVS.Get", { key: REQ_KEY }, loaded);
