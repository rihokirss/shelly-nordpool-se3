var CONFIG = {
  area: "SE3",
  api: "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices",
  kvsKey: "np_se3_plan_v1",
  requestKey: "np_se3_req_v1",
  outputIds: [0, 1],
  monitorScriptId: 2,
  fetcherScriptId: 3,
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

function bitIsOn(hex, index) {
  var value = parseInt(hex.charAt(Math.floor(index / 4)), 16);
  return (value & (1 << (index % 4))) !== 0;
}

function countHexBits(hex, length) {
  var count = 0;
  for (var index = 0; index < length; index++) if (bitIsOn(hex, index)) count++;
  return count;
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
    Shelly.call("KVS.Get", { key: CONFIG.requestKey }, function (requestResult, requestError) {
      if (requestError === 0 && requestResult) {
        try {
          var request = typeof requestResult.value === "string" ? JSON.parse(requestResult.value) : requestResult.value;
          if (request && request.retry && request.retry > Date.now()) state.lastTry = Date.now();
        } catch (error) {
          log("Ignored invalid fetch request");
        }
      }
      done();
    });
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

function outputsAreOff() {
  for (var channel = 0; channel < state.outputCount; channel++) {
    var status = Shelly.getComponentStatus("switch", CONFIG.outputIds[channel]);
    if (status && status.output) return false;
  }
  return true;
}

function stopForFetcher() {
  Shelly.call("Script.Stop", { id: Script.id });
}

function fetcherStarted(result, errorCode, errorMessage) {
  if (errorCode !== 0) {
    state.busy = false;
    log("Could not start price fetcher: " + errorMessage);
    startMonitor();
    return;
  }
  Timer.set(1500, false, stopForFetcher);
}

function monitorStoppedForFetch() {
  Shelly.call("Script.Start", { id: CONFIG.fetcherScriptId }, fetcherStarted);
}

function fetchRequestSaved(result, errorCode, errorMessage) {
  if (errorCode !== 0) {
    state.busy = false;
    log("Could not save fetch request: " + errorMessage);
    return;
  }
  Shelly.call("Script.Stop", { id: CONFIG.monitorScriptId }, monitorStoppedForFetch);
}

function requestPrices(force) {
  if (!state.ready || state.busy) return;
  var target = missingPlanDate();
  if (!target) {
    startMonitor();
    return;
  }
  if (!force && state.lastTry && Date.now() - state.lastTry < CONFIG.retryMs) {
    startMonitor();
    return;
  }
  if (!outputsAreOff()) {
    applyOutputs(false);
    startMonitor();
    return;
  }
  state.busy = true;
  state.lastTry = Date.now();
  var request = {
    d: target,
    h: [channelHours(0), channelHours(1)],
    c: state.outputCount,
    retry: 0
  };
  Shelly.call("KVS.Set", { key: CONFIG.requestKey, value: JSON.stringify(request) }, fetchRequestSaved);
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
  requestPrices(false);
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
