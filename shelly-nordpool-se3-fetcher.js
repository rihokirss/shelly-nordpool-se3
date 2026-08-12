/* Minimal Nord Pool SE3 price fetcher. Keep this script's auto-start disabled. */

var CONFIG = {
  controllerScriptId: 1,
  kvsKey: "np_se3_plan_v1",
  requestKey: "np_se3_req_v1",
  api: "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices",
  area: "SE3",
  retryMs: 300000
};

var state = null;

function log(message) {
  print("[NordPool fetcher] " + message);
}

function pad2(value) {
  return value < 10 ? "0" + value : "" + value;
}

function dateKey(date) {
  return "" + date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate());
}

function dateText(key) {
  return key.substring(0, 4) + "-" + key.substring(4, 6) + "-" + key.substring(6, 8);
}

function dateAt(key, hour) {
  return new Date(
    Number(key.substring(0, 4)), Number(key.substring(4, 6)) - 1,
    Number(key.substring(6, 8)), hour || 0, 0, 0, 0
  );
}

function addDay(key, amount) {
  return dateKey(new Date(dateAt(key, 12).getTime() + amount * 86400000));
}

function dayBounds(key) {
  var start = dateAt(key, 0);
  var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0);
  return [start.getTime(), end.getTime()];
}

function isNumber(value) {
  return typeof value === "number" && value === value && value !== Infinity && value !== -Infinity;
}

function contains(indexes, wanted) {
  for (var index = 0; index < indexes.length; index++) {
    if (indexes[index] === wanted) return true;
  }
  return false;
}

function toHex(indexes, length) {
  var text = "";
  for (var index = 0; index < length; index += 4) {
    var value = 0;
    for (var bit = 0; bit < 4; bit++) {
      if (index + bit < length && contains(indexes, index + bit)) value += 1 << bit;
    }
    text += value.toString(16);
  }
  return text;
}

function keepCheapest(selection, price, slot, limit) {
  if (limit < 1) return;
  var position = selection.prices.length;
  for (var index = 0; index < selection.prices.length; index++) {
    if (price < selection.prices[index]) {
      position = index;
      break;
    }
  }
  if (position >= limit && selection.prices.length >= limit) return;
  selection.prices.splice(position, 0, price);
  selection.indexes.splice(position, 0, slot);
  if (selection.prices.length > limit) {
    selection.prices.splice(limit, 1);
    selection.indexes.splice(limit, 1);
  }
}

function createBuffer(request) {
  var bounds = dayBounds(request.d);
  var expected = Math.round((bounds[1] - bounds[0]) / 900000);
  return {
    count: 0,
    expected: expected,
    limits: [Math.min(Math.round(request.h[0] * 4), expected), Math.min(Math.round(request.h[1] * 4), expected)],
    selected: [{ prices: [], indexes: [] }, { prices: [], indexes: [] }],
    minimum: null,
    maximum: null
  };
}

function parsePrices(body) {
  var buffer = state.buffer;
  var target = state.request.d;
  var bounds = dayBounds(target);
  var startLabel = "\"deliveryStart\":\"";
  var endLabel = "\"deliveryEnd\":\"";
  var areaLabel = "\"entryPerArea\":{";
  var priceLabel = "\"" + CONFIG.area + "\":";
  var entriesEnd = body.indexOf("\"blockPriceAggregates\"");
  var position = 0;
  var seen = 0;
  if (typeof body !== "string" || body.indexOf("\"multiAreaEntries\"") < 0) throw new Error("Invalid response");
  if (entriesEnd < 0) entriesEnd = body.length;
  while (true) {
    var startAt = body.indexOf(startLabel, position);
    if (startAt < 0 || startAt >= entriesEnd) break;
    startAt += startLabel.length;
    var startEnd = body.indexOf("\"", startAt);
    var endAt = body.indexOf(endLabel, startEnd) + endLabel.length;
    var endEnd = body.indexOf("\"", endAt);
    var areaAt = body.indexOf(areaLabel, endEnd) + areaLabel.length;
    var areaEnd = body.indexOf("}", areaAt);
    if (startEnd < 0 || endAt < endLabel.length || endEnd < 0 || areaAt < areaLabel.length || areaEnd < 0) {
      throw new Error("Invalid delivery entry");
    }
    var start = new Date(body.substring(startAt, startEnd)).getTime();
    var end = new Date(body.substring(endAt, endEnd)).getTime();
    if (!isNumber(start) || !isNumber(end) || end - start !== 900000) throw new Error("Invalid interval time");
    if (dateKey(new Date(start)) === target) {
      if (start !== bounds[0] + buffer.count * 900000) throw new Error("Missing or duplicate interval");
      var priceAt = body.indexOf(priceLabel, areaAt);
      if (priceAt < 0 || priceAt >= areaEnd) throw new Error("Missing SE3 price");
      priceAt += priceLabel.length;
      var priceEnd = priceAt;
      while (priceEnd < areaEnd && ",}".indexOf(body.charAt(priceEnd)) < 0) priceEnd++;
      var price = Number(body.substring(priceAt, priceEnd));
      if (!isNumber(price)) throw new Error("Invalid SE3 price");
      if (buffer.minimum === null || price < buffer.minimum) buffer.minimum = price;
      if (buffer.maximum === null || price > buffer.maximum) buffer.maximum = price;
      keepCheapest(buffer.selected[0], price, buffer.count, buffer.limits[0]);
      keepCheapest(buffer.selected[1], price, buffer.count, buffer.limits[1]);
      buffer.count++;
    }
    seen++;
    position = areaEnd + 1;
  }
  if (seen === 0) throw new Error("No delivery entries");
}

function marketUrl(key) {
  return CONFIG.api + "?currency=EUR&market=DayAhead&deliveryArea=" + CONFIG.area + "&date=" + dateText(key);
}

function fetchNext() {
  var marketDate = state.marketDates[state.marketIndex];
  log("Fetching SE3 market date " + dateText(marketDate));
  Shelly.call("HTTP.GET", { url: marketUrl(marketDate), timeout: 30 }, handleResponse);
}

function handleResponse(result, errorCode, errorMessage) {
  try {
    if (errorCode !== 0 || !result || result.code !== 200) throw new Error("HTTP " + errorCode + " " + errorMessage);
    parsePrices(result.body);
    result = null;
    state.marketIndex++;
    if (state.marketIndex < state.marketDates.length) Timer.set(5000, false, fetchNext);
    else Timer.set(1, false, finishFetch);
  } catch (error) {
    fail(error.message || "Price parse failed");
  }
}

function buildPlan() {
  var buffer = state.buffer;
  if (buffer.count !== buffer.expected) throw new Error("Expected " + buffer.expected + " intervals, got " + buffer.count);
  return {
    d: state.request.d,
    n: buffer.expected,
    a: toHex(buffer.selected[0].indexes, buffer.expected),
    b: toHex(buffer.selected[1].indexes, buffer.expected),
    x: buffer.limits[0],
    y: buffer.limits[1]
  };
}

function mergePlan(result, errorCode) {
  var data = { v: 1, p: [] };
  if (errorCode === 0 && result) {
    try {
      var stored = typeof result.value === "string" ? JSON.parse(result.value) : result.value;
      if (stored && stored.v === 1 && stored.p) data = stored;
    } catch (error) {
      data = { v: 1, p: [] };
    }
  }
  var plan;
  try {
    plan = buildPlan();
  } catch (error) {
    fail(error.message || "Plan failed");
    return;
  }
  var kept = [];
  for (var index = 0; index < data.p.length; index++) if (data.p[index].d !== plan.d) kept.push(data.p[index]);
  kept.push(plan);
  while (kept.length > 2) kept.splice(0, 1);
  data.p = kept;
  Shelly.call("KVS.Set", { key: CONFIG.kvsKey, value: JSON.stringify(data) }, planSaved);
}

function finishFetch() {
  Shelly.call("KVS.Get", { key: CONFIG.kvsKey }, mergePlan);
}

function stopSelf() {
  Shelly.call("Script.Stop", { id: Script.id });
}

function controllerStarted() {
  Timer.set(1000, false, stopSelf);
}

function startController() {
  Shelly.call("Script.Start", { id: CONFIG.controllerScriptId }, controllerStarted);
}

function requestDeleted() {
  startController();
}

function planSaved(result, errorCode, errorMessage) {
  if (errorCode !== 0) {
    fail("KVS save failed: " + errorMessage);
    return;
  }
  log("Plan " + dateText(state.request.d) + " saved: " + state.buffer.expected +
    " intervals, OUT0=" + state.buffer.limits[0] +
    (state.request.c > 1 ? ", OUT1=" + state.buffer.limits[1] : "") +
    ", prices=" + state.buffer.minimum + ".." + state.buffer.maximum + " EUR/MWh");
  Shelly.call("KVS.Delete", { key: CONFIG.requestKey }, requestDeleted);
}

function retrySaved() {
  startController();
}

function fail(message) {
  log("Fetch failed: " + message + "; retry in 5 min");
  state.request.retry = Math.floor(Date.now()) + CONFIG.retryMs;
  Shelly.call("KVS.Set", { key: CONFIG.requestKey, value: JSON.stringify(state.request) }, retrySaved);
}

function requestLoaded(result, errorCode) {
  if (errorCode !== 0 || !result) {
    log("No fetch request; stopping");
    stopSelf();
    return;
  }
  try {
    var request = typeof result.value === "string" ? JSON.parse(result.value) : result.value;
    if (!request || !request.d || !request.h || request.retry > Date.now()) throw new Error("Request is not ready");
    state = {
      request: request,
      marketDates: [addDay(request.d, -1), request.d],
      marketIndex: 0,
      buffer: createBuffer(request)
    };
    fetchNext();
  } catch (error) {
    log(error.message || "Invalid fetch request");
    startController();
  }
}

Shelly.call("KVS.Get", { key: CONFIG.requestKey }, requestLoaded);
