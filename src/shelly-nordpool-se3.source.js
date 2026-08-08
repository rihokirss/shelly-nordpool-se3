/*
 * Nord Pool SE3 quarter-hour controller for one- or two-output Shelly devices.
 *
 * OUT0 and OUT1 independently use the cheapest configured number of
 * quarter-hours in each Aland local calendar day. Prices are fetched from
 * Nord Pool in EUR/MWh. Network fees, taxes and retailer margins are not
 * included.
 */

var CONFIG = {
  area: "SE3",
  currency: "EUR",
  apiBase: "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices",
  kvsKey: "np_se3_plan_v1",
  groupId: 250,
  numberIds: [250, 251],
  outputIds: [0, 1],
  defaultHours: [6, 3],
  retryMs: 5 * 60 * 1000,
  healthMs: 60 * 1000,
  safetySeconds: 16 * 60,
  tomorrowFetchHour: 20,
  dryRun: false
};

var COMPONENT_NAMES = {
  group: "Nord Pool SE3",
  out0: "OUT0 cheap hours",
  out1: "OUT1 cheap hours"
};

var STATE = {
  hours: [CONFIG.defaultHours[0], CONFIG.defaultHours[1]],
  outputCount: 0,
  plans: {},
  priceCache: {},
  inflight: false,
  lastAttemptMs: 0,
  boundaryTimer: null,
  healthTimer: null,
  lastDesired: [null, null],
  ready: false
};

function log(message) {
  print("[NordPool SE3] " + message);
}

function pad2(value) {
  return value < 10 ? "0" + value : "" + value;
}

function localDateKey(date) {
  return "" + date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate());
}

function displayDate(key) {
  return key.substring(0, 4) + "-" + key.substring(4, 6) + "-" + key.substring(6, 8);
}

function dateFromKey(key, hour) {
  return new Date(
    Number(key.substring(0, 4)),
    Number(key.substring(4, 6)) - 1,
    Number(key.substring(6, 8)),
    hour || 0,
    0,
    0,
    0
  );
}

function addDaysKey(key, days) {
  var date = dateFromKey(key, 12);
  return localDateKey(new Date(date.getTime() + days * 24 * 60 * 60 * 1000));
}

function localDayBounds(key) {
  var start = dateFromKey(key, 0);
  var end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 1,
    0,
    0,
    0,
    0
  );
  return { start: start.getTime(), end: end.getTime() };
}

function finiteNumber(value) {
  return typeof value === "number" && value === value && value !== Infinity && value !== -Infinity;
}

function normalizeHours(value, fallback) {
  var hours = Number(value);
  if (!finiteNumber(hours)) hours = fallback;
  if (hours < 0) hours = 0;
  if (hours > 24) hours = 24;
  return Math.round(hours * 4) / 4;
}

function selectedCount(hours, slotCount) {
  var count = Math.round(normalizeHours(hours, 0) * 4);
  if (count > slotCount) count = slotCount;
  return count;
}

function selectCheapest(slots, hours) {
  var ranked = [];
  var mask = [];
  var i;
  for (i = 0; i < slots.length; i++) {
    ranked.push({ index: i, price: slots[i].price, start: slots[i].start });
    mask.push(false);
  }
  ranked.sort(function (a, b) {
    if (a.price !== b.price) return a.price - b.price;
    return a.start - b.start;
  });
  var count = selectedCount(hours, slots.length);
  for (i = 0; i < count; i++) mask[ranked[i].index] = true;
  return mask;
}

function countSelected(mask) {
  var count = 0;
  for (var i = 0; i < mask.length; i++) if (mask[i]) count++;
  return count;
}

function maskToHex(mask) {
  var output = "";
  for (var i = 0; i < mask.length; i += 4) {
    var nibble = 0;
    for (var bit = 0; bit < 4; bit++) {
      if (i + bit < mask.length && mask[i + bit]) nibble += 1 << bit;
    }
    output += nibble.toString(16);
  }
  return output;
}

function hexToMask(hex, length) {
  if (typeof hex !== "string" || hex.length !== Math.ceil(length / 4)) {
    throw new Error("Invalid plan bitmask length");
  }
  var mask = [];
  for (var i = 0; i < hex.length; i++) {
    var nibble = parseInt(hex.charAt(i), 16);
    if (nibble !== nibble) throw new Error("Invalid plan bitmask");
    for (var bit = 0; bit < 4 && mask.length < length; bit++) {
      mask.push((nibble & (1 << bit)) !== 0);
    }
  }
  return mask;
}

function extractTargetSlots(body, targetKey, output) {
  if (typeof body !== "string" || body.indexOf("\"multiAreaEntries\"") < 0) {
    throw new Error("Nord Pool response has no multiAreaEntries array");
  }

  var slots = output || [];
  var position = 0;
  var seen = 0;
  var startLabel = "\"deliveryStart\":\"";
  var endLabel = "\"deliveryEnd\":\"";
  var areaLabel = "\"entryPerArea\":{";
  var priceLabel = "\"" + CONFIG.area + "\":";
  var entriesEnd = body.indexOf("\"blockPriceAggregates\"");
  if (entriesEnd < 0) entriesEnd = body.length;

  while (true) {
    var startAt = body.indexOf(startLabel, position);
    if (startAt < 0 || startAt >= entriesEnd) break;
    startAt += startLabel.length;
    var startEnd = body.indexOf("\"", startAt);
    var endAt = body.indexOf(endLabel, startEnd);
    if (startEnd < 0 || endAt < 0) throw new Error("Invalid delivery timestamp fields");
    endAt += endLabel.length;
    var endEnd = body.indexOf("\"", endAt);
    var areaAt = body.indexOf(areaLabel, endEnd);
    if (endEnd < 0 || areaAt < 0) throw new Error("Invalid entryPerArea field");
    areaAt += areaLabel.length;
    var areaEnd = body.indexOf("}", areaAt);
    if (areaEnd < 0) throw new Error("Invalid entryPerArea object");

    var start = new Date(body.substring(startAt, startEnd)).getTime();
    var end = new Date(body.substring(endAt, endEnd)).getTime();
    if (!finiteNumber(start) || !finiteNumber(end)) throw new Error("Invalid delivery timestamp");

    if (localDateKey(new Date(start)) === targetKey) {
      var priceAt = body.indexOf(priceLabel, areaAt);
      if (priceAt < 0 || priceAt >= areaEnd) {
        throw new Error("Nord Pool response has no numeric " + CONFIG.area + " price");
      }
      priceAt += priceLabel.length;
      var priceEnd = priceAt;
      while (priceEnd < areaEnd && ",}".indexOf(body.charAt(priceEnd)) < 0) priceEnd++;
      var price = Number(body.substring(priceAt, priceEnd));
      if (!finiteNumber(price)) throw new Error("Nord Pool response has no numeric " + CONFIG.area + " price");
      slots.push({ start: start, end: end, price: price });
    }
    seen++;
    position = areaEnd + 1;
  }

  if (seen === 0) throw new Error("Nord Pool response has no delivery entries");
  return slots;
}

function validateLocalDaySlots(slots, targetKey) {
  var bounds = localDayBounds(targetKey);
  var expectedCount = Math.round((bounds.end - bounds.start) / (15 * 60 * 1000));
  slots.sort(function (a, b) { return a.start - b.start; });
  if (slots.length !== expectedCount) {
    throw new Error("Expected " + expectedCount + " local quarter-hours, received " + slots.length);
  }
  for (var i = 0; i < slots.length; i++) {
    var expectedStart = bounds.start + i * 15 * 60 * 1000;
    if (slots[i].start !== expectedStart) throw new Error("Missing, duplicate or unordered quarter-hour");
    if (slots[i].end - slots[i].start !== 15 * 60 * 1000) throw new Error("Delivery interval is not 15 minutes");
    if (!finiteNumber(slots[i].price)) throw new Error("Delivery price is not numeric");
  }
  if (slots[slots.length - 1].end !== bounds.end) throw new Error("Local day does not end at midnight");
  return slots;
}

function buildPlan(dateKey, slots, hours) {
  var validSlots = validateLocalDaySlots(slots, dateKey);
  var mask0 = selectCheapest(validSlots, hours[0]);
  var mask1 = selectCheapest(validSlots, hours[1]);
  return {
    date: dateKey,
    count: validSlots.length,
    masks: [mask0, mask1],
    selected: [countSelected(mask0), countSelected(mask1)]
  };
}

function serializePlans(plans, dateKeys) {
  var data = { v: 1 };
  var outIndex = 0;
  for (var i = 0; i < dateKeys.length && outIndex < 2; i++) {
    var plan = plans[dateKeys[i]];
    if (!plan) continue;
    data["d" + outIndex] = plan.date;
    data["n" + outIndex] = plan.count;
    data["a" + outIndex] = maskToHex(plan.masks[0]);
    data["b" + outIndex] = maskToHex(plan.masks[1]);
    data["x" + outIndex] = plan.selected[0];
    data["y" + outIndex] = plan.selected[1];
    outIndex++;
  }
  return JSON.stringify(data);
}

function deserializePlans(value) {
  var data = typeof value === "string" ? JSON.parse(value) : value;
  if (!data || data.v !== 1) throw new Error("Unsupported KVS plan version");
  var plans = {};
  for (var i = 0; i < 2; i++) {
    var date = data["d" + i];
    if (!date) continue;
    var count = Number(data["n" + i]);
    var selected0 = Number(data["x" + i]);
    var selected1 = Number(data["y" + i]);
    if (count < 1 || !finiteNumber(count) || !finiteNumber(selected0) || !finiteNumber(selected1)) {
      throw new Error("Invalid KVS plan metadata");
    }
    var mask0 = hexToMask(data["a" + i], count);
    var mask1 = hexToMask(data["b" + i], count);
    if (countSelected(mask0) !== selected0 || countSelected(mask1) !== selected1) {
      throw new Error("KVS plan checksum mismatch");
    }
    plans[date] = {
      date: date,
      count: count,
      masks: [mask0, mask1],
      selected: [selected0, selected1]
    };
  }
  return plans;
}

function planMatchesSettings(plan) {
  if (!plan) return false;
  var bounds = localDayBounds(plan.date);
  var expectedCount = Math.round((bounds.end - bounds.start) / (15 * 60 * 1000));
  if (plan.count !== expectedCount) return false;
  if (!plan.masks || plan.masks.length !== 2) return false;
  if (plan.masks[0].length !== plan.count || plan.masks[1].length !== plan.count) return false;
  if (plan.selected[0] !== selectedCount(STATE.hours[0], plan.count)) return false;
  if (plan.selected[1] !== selectedCount(STATE.hours[1], plan.count)) return false;
  return countSelected(plan.masks[0]) === plan.selected[0] && countSelected(plan.masks[1]) === plan.selected[1];
}

function currentDateKey() {
  return localDateKey(new Date());
}

function hasDeviceTime() {
  if (typeof Shelly === "undefined") return true;
  var status = Shelly.getComponentStatus("sys");
  return status && status.unixtime > 1000000000;
}

function currentSlotIndex(plan, nowMs) {
  var bounds = localDayBounds(plan.date);
  if (nowMs < bounds.start || nowMs >= bounds.end) return -1;
  return Math.floor((nowMs - bounds.start) / (15 * 60 * 1000));
}

function setOutput(channel, desired, refreshSafetyTimer) {
  if (channel >= STATE.outputCount) return;
  var outputId = CONFIG.outputIds[channel];
  if (CONFIG.dryRun) {
    if (STATE.lastDesired[channel] !== desired || refreshSafetyTimer) {
      log("DRY RUN: OUT" + channel + " -> " + (desired ? "ON" : "OFF"));
    }
    STATE.lastDesired[channel] = desired;
    return;
  }

  var status = Shelly.getComponentStatus("switch", outputId);
  var actual = status ? status.output : null;
  var shouldCall = actual === null || actual !== desired || (desired && refreshSafetyTimer);
  if (!shouldCall) {
    STATE.lastDesired[channel] = desired;
    return;
  }

  var params = { id: outputId, on: desired, tag: "np-se3" };
  if (desired) params.toggle_after = CONFIG.safetySeconds;
  Shelly.call("Switch.Set", params, function (result, errorCode, errorMessage) {
    if (errorCode !== 0) log("OUT" + channel + " command failed: " + errorMessage);
  });
  log("OUT" + channel + " -> " + (desired ? "ON" : "OFF"));
  STATE.lastDesired[channel] = desired;
}

function applyOutputs(refreshSafetyTimer) {
  if (!hasDeviceTime()) {
    setOutput(0, false, false);
    setOutput(1, false, false);
    return;
  }
  var today = currentDateKey();
  var plan = STATE.plans[today];
  if (!planMatchesSettings(plan)) {
    setOutput(0, false, false);
    setOutput(1, false, false);
    return;
  }
  var index = currentSlotIndex(plan, Date.now());
  if (index < 0 || index >= plan.count) {
    setOutput(0, false, false);
    setOutput(1, false, false);
    return;
  }
  setOutput(0, plan.masks[0][index], refreshSafetyTimer);
  setOutput(1, plan.masks[1][index], refreshSafetyTimer);
}

function persistPlans() {
  if (!hasDeviceTime()) return;
  var today = currentDateKey();
  var value = serializePlans(STATE.plans, [today, addDaysKey(today, 1)]);
  if (value.length > 253) {
    log("KVS plan is too large (" + value.length + " bytes)");
    return;
  }
  Shelly.call("KVS.Set", { key: CONFIG.kvsKey, value: value }, function (result, errorCode, errorMessage) {
    if (errorCode !== 0) log("Could not save KVS plan: " + errorMessage);
  });
}

function logPlan(plan, slots) {
  var minimum = null;
  var maximum = null;
  for (var i = 0; i < slots.length; i++) {
    if (minimum === null || slots[i].price < minimum) minimum = slots[i].price;
    if (maximum === null || slots[i].price > maximum) maximum = slots[i].price;
  }
  log(
    "Plan " + displayDate(plan.date) + ": " + plan.count + " intervals, OUT0=" +
    plan.selected[0] + ", OUT1=" + plan.selected[1] + ", price range=" +
    minimum + ".." + maximum + " EUR/MWh"
  );
}

function marketUrl(marketDateKey) {
  return CONFIG.apiBase + "?currency=" + CONFIG.currency +
    "&market=DayAhead&deliveryArea=" + CONFIG.area +
    "&date=" + displayDate(marketDateKey);
}

function fetchMarketDate(marketDateKey, targetKey, accumulated, done) {
  var url = marketUrl(marketDateKey);
  log("Fetching " + CONFIG.area + " market date " + displayDate(marketDateKey));
  Shelly.call("HTTP.GET", { url: url, timeout: 30 }, function (result, errorCode, errorMessage) {
    try {
      if (errorCode !== 0 || !result || result.code !== 200 || typeof result.body !== "string") {
        throw new Error("HTTP.GET failed: " + errorCode + " " + errorMessage);
      }
      extractTargetSlots(result.body, targetKey, accumulated);
      result = null;
      done(true, null);
    } catch (error) {
      done(false, error.message || "Unknown fetch error");
    }
  });
}

function fetchLocalDay(targetKey) {
  if (STATE.inflight) return;
  STATE.inflight = true;
  STATE.lastAttemptMs = Date.now();
  var accumulated = [];
  var previousMarketDate = addDaysKey(targetKey, -1);

  fetchMarketDate(previousMarketDate, targetKey, accumulated, function (ok, message) {
    if (!ok) {
      finishFetchFailure(targetKey, message);
      return;
    }
    Timer.set(5000, false, function () {
      fetchMarketDate(targetKey, targetKey, accumulated, function (secondOk, secondMessage) {
        if (!secondOk) {
          finishFetchFailure(targetKey, secondMessage);
          return;
        }
        Timer.set(1, false, function () {
          try {
            var slots = validateLocalDaySlots(accumulated, targetKey);
            var plan = buildPlan(targetKey, slots, STATE.hours);
            STATE.priceCache[targetKey] = slots;
            STATE.plans[targetKey] = plan;
            STATE.inflight = false;
            STATE.lastAttemptMs = 0;
            logPlan(plan, slots);
            persistPlans();
            applyOutputs(true);
            refreshNeeded(false);
          } catch (error) {
            finishFetchFailure(targetKey, error.message || "Invalid local day");
          }
        });
      });
    });
  });
}

function finishFetchFailure(targetKey, message) {
  STATE.inflight = false;
  log("Price fetch for " + displayDate(targetKey) + " failed: " + message + ". Retrying in 5 minutes.");
  applyOutputs(false);
}

function desiredFetchDate() {
  if (!hasDeviceTime()) return null;
  var today = currentDateKey();
  if (!planMatchesSettings(STATE.plans[today])) return today;
  if (new Date().getHours() >= CONFIG.tomorrowFetchHour) {
    var tomorrow = addDaysKey(today, 1);
    if (!planMatchesSettings(STATE.plans[tomorrow])) return tomorrow;
  }
  return null;
}

function refreshNeeded(force) {
  if (STATE.inflight || !STATE.ready) return;
  var target = desiredFetchDate();
  if (!target) return;
  if (!force && STATE.lastAttemptMs && Date.now() - STATE.lastAttemptMs < CONFIG.retryMs) return;
  fetchLocalDay(target);
}

function rebuildCachedPlans() {
  for (var key in STATE.priceCache) {
    try {
      STATE.plans[key] = buildPlan(key, STATE.priceCache[key], STATE.hours);
      logPlan(STATE.plans[key], STATE.priceCache[key]);
    } catch (error) {
      log("Could not rebuild cached plan " + key + ": " + error.message);
      delete STATE.plans[key];
    }
  }
  persistPlans();
  applyOutputs(true);
}

function updateHours(out0, out1) {
  var normalized0 = normalizeHours(out0, CONFIG.defaultHours[0]);
  var normalized1 = STATE.outputCount > 1 ? normalizeHours(out1, CONFIG.defaultHours[1]) : 0;
  if (normalized0 === STATE.hours[0] && normalized1 === STATE.hours[1]) return false;
  STATE.hours[0] = normalized0;
  STATE.hours[1] = normalized1;
  var settingsText = "OUT0=" + normalized0 + " h";
  if (STATE.outputCount > 1) settingsText += ", OUT1=" + normalized1 + " h";
  log("Settings changed: " + settingsText);
  rebuildCachedPlans();
  STATE.lastAttemptMs = 0;
  refreshNeeded(true);
  return true;
}

function pollSettings() {
  var status0 = Shelly.getComponentStatus("number", CONFIG.numberIds[0]);
  if (!status0) return;
  if (STATE.outputCount < 2) {
    updateHours(status0.value, 0);
    return;
  }
  var status1 = Shelly.getComponentStatus("number", CONFIG.numberIds[1]);
  if (status1) updateHours(status0.value, status1.value);
}

function maintenance() {
  pollSettings();
  applyOutputs(false);
  refreshNeeded(false);
}

function scheduleBoundary() {
  if (STATE.boundaryTimer !== null) Timer.clear(STATE.boundaryTimer);
  var now = Date.now();
  var quarterMs = 15 * 60 * 1000;
  var delay = quarterMs - (now % quarterMs) + 250;
  STATE.boundaryTimer = Timer.set(delay, false, function () {
    applyOutputs(true);
    scheduleBoundary();
  });
}

function loadPlans(done) {
  Shelly.call("KVS.Get", { key: CONFIG.kvsKey }, function (result, errorCode) {
    if (errorCode === 0 && result) {
      try {
        STATE.plans = deserializePlans(result.value);
        log("Loaded cached plans from KVS");
      } catch (error) {
        log("Ignoring invalid KVS plan: " + error.message);
        STATE.plans = {};
      }
    }
    done();
  });
}

function expectedNumberConfig(channel) {
  return {
    name: channel === 0 ? COMPONENT_NAMES.out0 : COMPONENT_NAMES.out1,
    min: 0,
    max: 24,
    default_value: CONFIG.defaultHours[channel],
    persisted: true,
    meta: { ui: { view: "slider", unit: "h/day", step: 0.25 } }
  };
}

function componentByKey(components, key) {
  for (var i = 0; i < components.length; i++) {
    if (components[i].key === key) return components[i];
  }
  return null;
}

function ensureVirtualComponents(done) {
  Shelly.call("Shelly.GetComponents", { dynamic_only: true, include: ["config", "status"] }, function (result, errorCode, errorMessage) {
    if (errorCode !== 0 || !result) {
      log("Could not inspect virtual components: " + errorMessage);
      done(false);
      return;
    }
    var components = result.components || [];
    var tasks = [
      { key: "group:" + CONFIG.groupId, type: "group", id: CONFIG.groupId, name: COMPONENT_NAMES.group, config: { name: COMPONENT_NAMES.group } },
      { key: "number:" + CONFIG.numberIds[0], type: "number", id: CONFIG.numberIds[0], name: COMPONENT_NAMES.out0, config: expectedNumberConfig(0) }
    ];
    if (STATE.outputCount > 1) {
      tasks.push({ key: "number:" + CONFIG.numberIds[1], type: "number", id: CONFIG.numberIds[1], name: COMPONENT_NAMES.out1, config: expectedNumberConfig(1) });
    }
    var taskIndex = 0;

    function nextTask() {
      if (taskIndex >= tasks.length) {
        var members = ["number:" + CONFIG.numberIds[0]];
        if (STATE.outputCount > 1) members.push("number:" + CONFIG.numberIds[1]);
        Shelly.call("Group.Set", { id: CONFIG.groupId, value: members }, function (groupResult, groupError, groupMessage) {
          if (groupError !== 0) {
            log("Could not configure the settings group: " + groupMessage);
            done(false);
          } else {
            done(true);
          }
        });
        return;
      }

      var task = tasks[taskIndex++];
      var existing = componentByKey(components, task.key);
      if (existing) {
        var existingName = existing.config ? existing.config.name : null;
        if (existingName !== task.name) {
          log("Virtual component conflict at " + task.key + "; existing component was not modified");
          done(false);
          return;
        }
        if (task.type === "number") {
          Shelly.call("Number.SetConfig", { id: task.id, config: task.config }, function (setResult, setError, setMessage) {
            if (setError !== 0) {
              log("Could not update " + task.key + ": " + setMessage);
              done(false);
            } else {
              nextTask();
            }
          });
        } else {
          nextTask();
        }
        return;
      }

      Shelly.call("Virtual.Add", { type: task.type, id: task.id, config: task.config }, function (addResult, addError, addMessage) {
        if (addError !== 0) {
          log("Could not create " + task.key + ": " + addMessage);
          done(false);
        } else {
          log("Created virtual component " + task.key);
          nextTask();
        }
      });
    }

    nextTask();
  });
}

function readInitialSettings(done) {
  Shelly.call("Number.GetStatus", { id: CONFIG.numberIds[0] }, function (result0, error0, message0) {
    if (error0 !== 0 || !result0) {
      log("Could not read OUT0 hours: " + message0);
      done(false);
      return;
    }
    STATE.hours[0] = normalizeHours(result0.value, CONFIG.defaultHours[0]);
    if (STATE.outputCount < 2) {
      STATE.hours[1] = 0;
      log("Settings: OUT0=" + STATE.hours[0] + " h");
      done(true);
      return;
    }
    Shelly.call("Number.GetStatus", { id: CONFIG.numberIds[1] }, function (result1, error1, message1) {
      if (error1 !== 0 || !result1) {
        log("Could not read OUT1 hours: " + message1);
        done(false);
        return;
      }
      STATE.hours[1] = normalizeHours(result1.value, CONFIG.defaultHours[1]);
      log("Settings: OUT0=" + STATE.hours[0] + " h, OUT1=" + STATE.hours[1] + " h");
      done(true);
    });
  });
}

function detectOutputs() {
  STATE.outputCount = 0;
  for (var channel = 0; channel < CONFIG.outputIds.length; channel++) {
    if (!Shelly.getComponentStatus("switch", CONFIG.outputIds[channel])) break;
    STATE.outputCount++;
  }
  if (STATE.outputCount < 1) {
    log("Startup stopped: no switch outputs detected");
    return false;
  }
  log("Detected " + STATE.outputCount + " switch output" + (STATE.outputCount === 1 ? "" : "s"));
  return true;
}

function startRuntime() {
  STATE.ready = true;
  applyOutputs(true);
  scheduleBoundary();
  STATE.healthTimer = Timer.set(CONFIG.healthMs, true, maintenance);
  refreshNeeded(true);
  log("Controller started" + (CONFIG.dryRun ? " in DRY RUN mode" : ""));
}

function boot() {
  var info = Shelly.getDeviceInfo();
  log("Starting on " + info.app + " firmware " + info.ver);
  if (!detectOutputs()) return;
  ensureVirtualComponents(function (componentsOk) {
    if (!componentsOk) {
      setOutput(0, false, false);
      setOutput(1, false, false);
      log("Startup stopped because settings components are unavailable");
      return;
    }
    readInitialSettings(function (settingsOk) {
      if (!settingsOk) {
        setOutput(0, false, false);
        setOutput(1, false, false);
        return;
      }
      loadPlans(startRuntime);
    });
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CONFIG: CONFIG,
    STATE: STATE,
    localDateKey: localDateKey,
    addDaysKey: addDaysKey,
    localDayBounds: localDayBounds,
    normalizeHours: normalizeHours,
    selectedCount: selectedCount,
    selectCheapest: selectCheapest,
    countSelected: countSelected,
    maskToHex: maskToHex,
    hexToMask: hexToMask,
    extractTargetSlots: extractTargetSlots,
    validateLocalDaySlots: validateLocalDaySlots,
    buildPlan: buildPlan,
    serializePlans: serializePlans,
    deserializePlans: deserializePlans,
    currentSlotIndex: currentSlotIndex
  };
}

if (typeof Shelly !== "undefined") boot();
