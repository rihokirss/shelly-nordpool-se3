var CONFIG = {
  area: "SE3",
  api: "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices",
  kvsKey: "np_se3_plan_v1",
  outputIds: [0, 1],
  monitorScriptId: 2,
  numberIds: [250, 251],
  groupId: 250,
  defaultHours: [6, 3],
  tomorrowFetchHour: 20,
  retryMs: 300000,
  safetySeconds: 960,
  dryRun: false
};

var NAMES = {
  group: "Nord Pool SE3",
  out0: "OUT0 cheap hours",
  out1: "OUT1 cheap hours"
};

var state = {
  hours: [CONFIG.defaultHours[0], CONFIG.defaultHours[1]],
  outputCount: 0,
  plans: [],
  busy: false,
  ready: false,
  lastTry: 0
};

function log(message) {
  print("[NordPool SE3] " + message);
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
    Number(key.substring(0, 4)),
    Number(key.substring(4, 6)) - 1,
    Number(key.substring(6, 8)),
    hour || 0, 0, 0, 0
  );
}

function addDay(key, amount) {
  var noon = dateAt(key, 12).getTime();
  return dateKey(new Date(noon + amount * 86400000));
}

function dayBounds(key) {
  var startDate = dateAt(key, 0);
  var endDate = new Date(
    startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 1,
    0, 0, 0, 0
  );
  return [startDate.getTime(), endDate.getTime()];
}

function isNumber(value) {
  return typeof value === "number" && value === value && value !== Infinity && value !== -Infinity;
}

function cleanHours(value, fallback) {
  var hours = Number(value);
  if (!isNumber(hours)) hours = fallback;
  if (hours < 0) hours = 0;
  if (hours > 24) hours = 24;
  return Math.round(hours * 4) / 4;
}

function wantedCount(hours, available) {
  var count = Math.round(cleanHours(hours, 0) * 4);
  return count > available ? available : count;
}

function channelHours(channel) {
  return channel < state.outputCount ? state.hours[channel] : 0;
}

function maskToHex(mask) {
  var text = "";
  for (var index = 0; index < mask.length; index += 4) {
    var value = 0;
    for (var bit = 0; bit < 4; bit++) {
      if (index + bit < mask.length && mask[index + bit]) value += 1 << bit;
    }
    text += value.toString(16);
  }
  return text;
}

function bitIsOn(hex, index) {
  var value = parseInt(hex.charAt(Math.floor(index / 4)), 16);
  return (value & (1 << (index % 4))) !== 0;
}

function countHexBits(hex, length) {
  var count = 0;
  for (var index = 0; index < length; index++) if (bitIsOn(hex, index)) count++;
  return count;
}

function selectMask(prices, hours) {
  var selected = [];
  var index;

  for (index = 0; index < prices.length; index++) {
    selected.push(false);
  }
  var count = wantedCount(hours, prices.length);
  for (var chosen = 0; chosen < count; chosen++) {
    var best = -1;
    for (index = 0; index < prices.length; index++) {
      if (!selected[index] && (best < 0 || prices[index] < prices[best])) best = index;
    }
    selected[best] = true;
  }
  return maskToHex(selected);
}

function buildPlan(key, prices) {
  var bounds = dayBounds(key);
  var expected = Math.round((bounds[1] - bounds[0]) / 900000);
  if (prices.length !== expected) throw new Error("Expected " + expected + " intervals, got " + prices.length);

  var minimum = null;
  var maximum = null;
  for (var index = 0; index < prices.length; index++) {
    if (!isNumber(prices[index])) throw new Error("Invalid price");
    if (minimum === null || prices[index] < minimum) minimum = prices[index];
    if (maximum === null || prices[index] > maximum) maximum = prices[index];
  }

  var plan = {
    d: key,
    n: prices.length,
    a: selectMask(prices, channelHours(0)),
    b: selectMask(prices, channelHours(1)),
    x: wantedCount(channelHours(0), prices.length),
    y: wantedCount(channelHours(1), prices.length)
  };
  var selectionText = "OUT0=" + plan.x;
  if (state.outputCount > 1) selectionText += ", OUT1=" + plan.y;
  log("Plan " + dateText(key) + ": " + plan.n + " intervals, " + selectionText +
    ", prices=" + minimum + ".." + maximum + " EUR/MWh");
  return plan;
}

function findPlan(key) {
  for (var index = 0; index < state.plans.length; index++) {
    if (state.plans[index].d === key) return state.plans[index];
  }
  return null;
}

function planIsValid(plan) {
  if (!plan) return false;
  var bounds = dayBounds(plan.d);
  var expected = Math.round((bounds[1] - bounds[0]) / 900000);
  if (plan.n !== expected) return false;
  if (typeof plan.a !== "string" || typeof plan.b !== "string") return false;
  if (plan.a.length !== Math.ceil(plan.n / 4) || plan.b.length !== Math.ceil(plan.n / 4)) return false;
  if (plan.x !== wantedCount(channelHours(0), plan.n)) return false;
  if (plan.y !== wantedCount(channelHours(1), plan.n)) return false;
  return countHexBits(plan.a, plan.n) === plan.x && countHexBits(plan.b, plan.n) === plan.y;
}

function replacePlan(plan) {
  var kept = [];
  for (var index = 0; index < state.plans.length; index++) {
    if (state.plans[index].d !== plan.d) kept.push(state.plans[index]);
  }
  kept.push(plan);
  while (kept.length > 2) kept.splice(0, 1);
  state.plans = kept;
}

function savePlans() {
  var data = { v: 1, p: state.plans };
  var value = JSON.stringify(data);
  if (value.length > 253) {
    log("KVS plan is too large: " + value.length);
    return;
  }
  Shelly.call("KVS.Set", { key: CONFIG.kvsKey, value: value }, function (result, errorCode, errorMessage) {
    if (errorCode !== 0) log("KVS save failed: " + errorMessage);
  });
}

function loadPlans(done) {
  Shelly.call("KVS.Get", { key: CONFIG.kvsKey }, function (result, errorCode) {
    if (errorCode === 0 && result) {
      try {
        var data = typeof result.value === "string" ? JSON.parse(result.value) : result.value;
        if (!data || data.v !== 1 || !data.p || typeof data.p.length !== "number") throw new Error("Invalid cache");
        state.plans = data.p;
        log("Loaded cached plans");
      } catch (error) {
        state.plans = [];
        log("Ignored invalid cache");
      }
    }
    done();
  });
}

function deviceHasTime() {
  var system = Shelly.getComponentStatus("sys");
  return system && system.unixtime > 1000000000;
}

function setOutput(channel, desired, refreshTimer) {
  if (channel >= state.outputCount) return;
  if (CONFIG.dryRun) return;

  var status = Shelly.getComponentStatus("switch", CONFIG.outputIds[channel]);
  var actual = status ? status.output : null;
  if (actual === desired && !(desired && refreshTimer)) return;
  var params = { id: CONFIG.outputIds[channel], on: desired, tag: "np-se3" };
  if (desired) params.toggle_after = CONFIG.safetySeconds;
  Shelly.call("Switch.Set", params, function (result, errorCode, errorMessage) {
    if (errorCode !== 0) log("OUT" + channel + " failed: " + errorMessage);
  });
  if (actual !== desired) log("OUT" + channel + " -> " + (desired ? "ON" : "OFF"));
}

function applyOutputs(refreshTimer) {
  if (!deviceHasTime()) {
    setOutput(0, false, false);
    setOutput(1, false, false);
    return;
  }
  var today = dateKey(new Date());
  var plan = findPlan(today);
  if (!planIsValid(plan)) {
    setOutput(0, false, false);
    setOutput(1, false, false);
    return;
  }
  var bounds = dayBounds(today);
  var slot = Math.floor((Date.now() - bounds[0]) / 900000);
  if (slot < 0 || slot >= plan.n) {
    setOutput(0, false, false);
    setOutput(1, false, false);
    return;
  }
  setOutput(0, bitIsOn(plan.a, slot), refreshTimer);
  setOutput(1, bitIsOn(plan.b, slot), refreshTimer);
}

function parsePrices(body, targetKey, buffer) {
  var startLabel = "\"deliveryStart\":\"";
  var endLabel = "\"deliveryEnd\":\"";
  var areaLabel = "\"entryPerArea\":{";
  var priceLabel = "\"" + CONFIG.area + "\":";
  var position = 0;
  var seen = 0;
  var entriesEnd;
  var bounds = dayBounds(targetKey);

  if (typeof body !== "string" || body.indexOf("\"multiAreaEntries\"") < 0) throw new Error("Invalid response");
  entriesEnd = body.indexOf("\"blockPriceAggregates\"");
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

    if (dateKey(new Date(start)) === targetKey) {
      if (start !== bounds[0] + buffer.count * 900000) throw new Error("Missing or duplicate interval");
      var priceAt = body.indexOf(priceLabel, areaAt);
      if (priceAt < 0 || priceAt >= areaEnd) throw new Error("Missing SE3 price");
      priceAt += priceLabel.length;
      var priceEnd = priceAt;
      while (priceEnd < areaEnd && ",}".indexOf(body.charAt(priceEnd)) < 0) priceEnd++;
      var price = Number(body.substring(priceAt, priceEnd));
      if (!isNumber(price)) throw new Error("Invalid SE3 price");
      buffer.text += price + ",";
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

function fetchMarketDate(marketDate, targetKey, buffer, done) {
  log("Fetching SE3 market date " + dateText(marketDate));
  Shelly.call("HTTP.GET", { url: marketUrl(marketDate), timeout: 30 }, function (result, errorCode, errorMessage) {
    try {
      if (errorCode !== 0 || !result || result.code !== 200) throw new Error("HTTP " + errorCode + " " + errorMessage);
      parsePrices(result.body, targetKey, buffer);
      result = null;
      done(true, null);
    } catch (error) {
      done(false, error.message || "Price parse failed");
    }
  });
}

function fetchLocalDay(targetKey) {
  if (state.busy) return;
  state.busy = true;
  state.lastTry = Date.now();
  var buffer = { text: "", count: 0 };

  fetchMarketDate(addDay(targetKey, -1), targetKey, buffer, function (firstOk, firstError) {
    if (!firstOk) return fetchFailed(targetKey, firstError);
    Timer.set(5000, false, function () {
      fetchMarketDate(targetKey, targetKey, buffer, function (secondOk, secondError) {
        if (!secondOk) return fetchFailed(targetKey, secondError);
        Timer.set(1, false, function () {
          try {
            var prices = JSON.parse("[" + buffer.text.substring(0, buffer.text.length - 1) + "]");
            replacePlan(buildPlan(targetKey, prices));
            prices = null;
            buffer = null;
            state.busy = false;
            state.lastTry = 0;
            savePlans();
            applyOutputs(true);
            requestPrices(false);
          } catch (error) {
            fetchFailed(targetKey, error.message || "Plan failed");
          }
        });
      });
    });
  });
}

function fetchFailed(targetKey, message) {
  state.busy = false;
  log("Fetch " + dateText(targetKey) + " failed: " + message + "; retry in 5 min");
  applyOutputs(false);
  startMonitor();
}

function missingPlanDate() {
  if (!deviceHasTime()) return null;
  var today = dateKey(new Date());
  if (!planIsValid(findPlan(today))) return today;
  if (new Date().getHours() >= CONFIG.tomorrowFetchHour) {
    var tomorrow = addDay(today, 1);
    if (!planIsValid(findPlan(tomorrow))) return tomorrow;
  }
  return null;
}

function requestPrices(force) {
  if (!state.ready || state.busy) return;
  var target = missingPlanDate();
  if (!target) {
    startMonitor();
    return;
  }
  if (!force && state.lastTry && Date.now() - state.lastTry < CONFIG.retryMs) return;
  var monitor = Shelly.getComponentStatus("script", CONFIG.monitorScriptId);
  if (!monitor || !monitor.running) {
    fetchLocalDay(target);
    return;
  }
  state.busy = true;
  Shelly.call("Script.Stop", { id: CONFIG.monitorScriptId }, function () {
    Timer.set(1000, false, function () {
      state.busy = false;
      fetchLocalDay(target);
    });
  });
}

function startMonitor() {
  var status = Shelly.getComponentStatus("script", CONFIG.monitorScriptId);
  if (status && !status.running) Shelly.call("Script.Start", { id: CONFIG.monitorScriptId });
}

function readChangedSettings() {
  var first = Shelly.getComponentStatus("number", CONFIG.numberIds[0]);
  if (!first) return;
  var hours0 = cleanHours(first.value, CONFIG.defaultHours[0]);
  var hours1 = 0;
  if (state.outputCount > 1) {
    var second = Shelly.getComponentStatus("number", CONFIG.numberIds[1]);
    if (!second) return;
    hours1 = cleanHours(second.value, CONFIG.defaultHours[1]);
  }
  if (hours0 === state.hours[0] && hours1 === state.hours[1]) return;
  state.hours = [hours0, hours1];
  state.plans = [];
  state.lastTry = 0;
  var settingsText = "OUT0=" + hours0 + " h";
  if (state.outputCount > 1) settingsText += ", OUT1=" + hours1 + " h";
  log("Settings changed: " + settingsText);
  savePlans();
  applyOutputs(false);
  requestPrices(true);
}

function maintenance() {
  readChangedSettings();
  applyOutputs(true);
  requestPrices(false);
}

function scheduleBoundary() {
  var delay = 900000 - (Date.now() % 900000) + 250;
  Timer.set(delay, false, function () {
    applyOutputs(true);
    scheduleBoundary();
  });
}

function numberConfig(channel) {
  return {
    name: channel === 0 ? NAMES.out0 : NAMES.out1,
    min: 0,
    max: 24,
    default_value: CONFIG.defaultHours[channel],
    persisted: true,
    meta: { ui: { view: "slider", unit: "h/day", step: 0.25 } }
  };
}

function findComponent(components, key) {
  for (var index = 0; index < components.length; index++) {
    if (components[index].key === key) return components[index];
  }
  return null;
}

function ensureComponents(done) {
  Shelly.call("Shelly.GetComponents", { dynamic_only: true, include: ["config"] }, function (result, errorCode) {
    if (errorCode !== 0 || !result) return done(false);
    var components = result.components || [];
    var tasks = [
      ["group", CONFIG.groupId, NAMES.group, { name: NAMES.group }],
      ["number", CONFIG.numberIds[0], NAMES.out0, numberConfig(0)]
    ];
    if (state.outputCount > 1) {
      tasks.push(["number", CONFIG.numberIds[1], NAMES.out1, numberConfig(1)]);
    }
    var taskIndex = 0;

    function next() {
      if (taskIndex >= tasks.length) {
        var members = ["number:" + CONFIG.numberIds[0]];
        if (state.outputCount > 1) members.push("number:" + CONFIG.numberIds[1]);
        Shelly.call("Group.Set", {
          id: CONFIG.groupId,
          value: members
        }, function (groupResult, groupError) { done(groupError === 0); });
        return;
      }
      var task = tasks[taskIndex++];
      var key = task[0] + ":" + task[1];
      var existing = findComponent(components, key);
      if (existing) {
        if (!existing.config || existing.config.name !== task[2]) {
          log("Component conflict at " + key);
          done(false);
          return;
        }
        next();
        return;
      }
      Shelly.call("Virtual.Add", { type: task[0], id: task[1], config: task[3] }, function (addResult, addError) {
        if (addError !== 0) done(false); else next();
      });
    }
    next();
  });
}

function readInitialSettings(done) {
  var first = Shelly.getComponentStatus("number", CONFIG.numberIds[0]);
  if (!first) return done(false);
  state.hours[0] = cleanHours(first.value, CONFIG.defaultHours[0]);
  state.hours[1] = 0;
  if (state.outputCount > 1) {
    var second = Shelly.getComponentStatus("number", CONFIG.numberIds[1]);
    if (!second) return done(false);
    state.hours[1] = cleanHours(second.value, CONFIG.defaultHours[1]);
  }
  var settingsText = "OUT0=" + state.hours[0] + " h";
  if (state.outputCount > 1) settingsText += ", OUT1=" + state.hours[1] + " h";
  log("Settings: " + settingsText);
  done(true);
}

function detectOutputs() {
  state.outputCount = 0;
  for (var channel = 0; channel < CONFIG.outputIds.length; channel++) {
    if (!Shelly.getComponentStatus("switch", CONFIG.outputIds[channel])) break;
    state.outputCount++;
  }
  if (state.outputCount < 1) {
    log("Startup stopped: no switch outputs detected");
    return false;
  }
  log("Detected " + state.outputCount + " switch output" + (state.outputCount === 1 ? "" : "s"));
  return true;
}

function startController() {
  state.ready = true;
  applyOutputs(true);
  scheduleBoundary();
  Timer.set(60000, true, maintenance);
  requestPrices(true);
  log("Controller started" + (CONFIG.dryRun ? " in DRY RUN mode" : ""));
}

function boot() {
  var info = Shelly.getDeviceInfo();
  log("Starting on " + info.app + " firmware " + info.ver);
  if (!detectOutputs()) return;
  ensureComponents(function (componentsOk) {
    if (!componentsOk) {
      setOutput(0, false, false);
      setOutput(1, false, false);
      log("Startup stopped: settings unavailable");
      return;
    }
    readInitialSettings(function (settingsOk) {
      if (!settingsOk) return;
      loadPlans(startController);
    });
  });
}

boot();
