/* Tiny HTTP worker; keep auto-start off. */

var CTRL = 1;
var REQ = "np_se3_req_v1";
var TMP = "np_se3_tmp_";
var API = "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices";
var job = null;
var prices = "";
var found = 0;
var part = 0;
var parts = 0;

function log(message) {
  print("[NordPool fetcher] " + message);
}

function dateText(key) {
  return key.substring(0, 4) + "-" + key.substring(4, 6) + "-" + key.substring(6, 8);
}

function numberOk(value) {
  return typeof value === "number" && value === value && value !== Infinity && value !== -Infinity;
}

function priceCode(price) {
  var value = Math.round(price * 1000) + 50000000;
  var text = "" + value;
  if (value < 0 || text.length > 8) throw new Error("Price range");
  return "00000000".substring(text.length) + text;
}

function parse(body) {
  var startTag = "\"deliveryStart\":\"";
  var areaTag = "\"entryPerArea\":{";
  var priceTag = "\"SE3\":";
  var position = 0;
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
    if (!numberOk(start)) throw new Error("Bad interval");

    if (start >= job.s && start < job.s + job.n * 900000) {
      if (start !== job.s + (job.count + found) * 900000) throw new Error("Missing slot");
      var priceAt = body.indexOf(priceTag, areaAt);
      if (priceAt < 0 || priceAt >= areaEnd) throw new Error("Missing SE3 price");
      priceAt += priceTag.length;
      var priceEnd = priceAt;
      while (priceEnd < areaEnd && ",}".indexOf(body.charAt(priceEnd)) < 0) priceEnd++;
      var price = Number(body.substring(priceAt, priceEnd));
      if (!numberOk(price)) throw new Error("Bad SE3 price");
      prices += priceCode(price);
      found++;
    }
    position = areaEnd + 1;
  }
  if (found === 0) throw new Error("No local slots");
}

function fetched(result, errorCode, errorMessage) {
  try {
    if (errorCode !== 0 || !result || result.code !== 200) throw new Error("HTTP " + errorCode + " " + errorMessage);
    parse(result.body);
    result = null;
    if (job.phase === 1 && job.count + found !== job.n) throw new Error("Incomplete day");
    parts = Math.ceil(prices.length / 240);
    writePart();
  } catch (error) {
    fail(error.message || "Fetch failed");
  }
}

function writePart() {
  if (part >= parts) return phaseSaved();
  var key = TMP + (job.phase === 0 ? part : job.parts[0] + part);
  Shelly.call("KVS.Set", { key: key, value: prices.substring(part * 240, part * 240 + 240) }, function (result, code, message) {
    if (code !== 0) return fail("KVS " + message);
    part++;
    writePart();
  });
}

function phaseSaved() {
  job.count += found;
  job.parts[job.phase] = parts;
  job.phase++;
  prices = "";
  Shelly.call("KVS.Set", { key: REQ, value: JSON.stringify(job) }, function (result, code, message) {
    if (code !== 0) return fail("KVS " + message);
    restart();
  });
}

function stopSelf() {
  Shelly.call("Script.Stop", { id: Script.id });
}

function restart() {
  Shelly.call("Script.Start", { id: CTRL }, stopSelf);
}

function fail(message) {
  log(message + "; retry in 5 min");
  prices = "";
  job.retry = Math.floor(Date.now()) + 300000;
  Shelly.call("KVS.Set", { key: REQ, value: JSON.stringify(job) }, restart);
}

function loaded(result, errorCode) {
  try {
    if (errorCode !== 0 || !result) throw new Error("No request");
    job = typeof result.value === "string" ? JSON.parse(result.value) : result.value;
    if (!job || job.phase > 1 || job.retry > Date.now()) throw new Error("Not ready");
    var key = job.m[job.phase];
    var url = API + "?currency=EUR&market=DayAhead&deliveryArea=SE3&date=" + dateText(key);
    Shelly.call("HTTP.GET", { url: url, timeout: 30 }, fetched);
  } catch (error) {
    if (job) restart(); else stopSelf();
  }
}

Shelly.call("KVS.Get", { key: REQ }, loaded);
