/* Nord Pool SE3 status display and fail-safe watchdog. */

var CONFIG = {
  controllerScriptId: 1,
  kvsKey: "np_se3_plan_v1",
  outputIds: [0, 1],
  groupId: 250,
  settingNumberIds: [250, 251],
  statusIds: [250, 251, 252],
  statusNames: ["Run today", "Now", "Next"],
  refreshMs: 60000
};

var lastText = ["", "", ""];
var statusReady = [false, false, false];
var outputCount = 0;

function log(message) {
  print("[NordPool monitor] " + message);
}

function pad2(value) {
  return value < 10 ? "0" + value : "" + value;
}

function dateKey(date) {
  return "" + date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate());
}

function dayBounds(key) {
  var start = new Date(
    Number(key.substring(0, 4)), Number(key.substring(4, 6)) - 1,
    Number(key.substring(6, 8)), 0, 0, 0, 0
  );
  var end = new Date(
    start.getFullYear(), start.getMonth(), start.getDate() + 1,
    0, 0, 0, 0
  );
  return [start.getTime(), end.getTime()];
}

function bitIsOn(hex, index) {
  var value = parseInt(hex.charAt(Math.floor(index / 4)), 16);
  return (value & (1 << (index % 4))) !== 0;
}

function show(field, value) {
  if (value === lastText[field]) return;
  lastText[field] = value;
  if (statusReady[field]) Shelly.call("Text.Set", { id: CONFIG.statusIds[field], value: value });
  log(value);
}

function controllerIsRunning() {
  var status = Shelly.getComponentStatus("script", CONFIG.controllerScriptId);
  return status && status.running;
}

function forceOutputsOff(reason) {
  for (var channel = 0; channel < outputCount; channel++) {
    var outputId = CONFIG.outputIds[channel];
    var status = Shelly.getComponentStatus("switch", outputId);
    if (!status || status.output) {
      Shelly.call("Switch.Set", { id: outputId, on: false, tag: "np-watchdog" });
    }
  }
  show(1, "SAFE OFF | " + reason);
  show(2, "Controller unavailable");
}

function planForToday(data, today) {
  if (!data || data.v !== 1 || !data.p) return null;
  for (var index = 0; index < data.p.length; index++) {
    if (data.p[index].d === today) return data.p[index];
  }
  return null;
}

function planIsValid(plan, bounds) {
  if (!plan || typeof plan.a !== "string" || typeof plan.b !== "string") return false;
  var expected = Math.round((bounds[1] - bounds[0]) / 900000);
  return plan.n === expected &&
    plan.a.length === Math.ceil(plan.n / 4) &&
    plan.b.length === Math.ceil(plan.n / 4);
}

function elapsedHours(mask, completedSlots) {
  var count = 0;
  for (var index = 0; index < completedSlots; index++) {
    if (bitIsOn(mask, index)) count++;
  }
  return count / 4;
}

function clockText(timestamp) {
  var date = new Date(timestamp);
  return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
}

function nextChange(mask, plan, slot, dayStart) {
  if (slot < 0) return "starts 00:00";
  if (slot >= plan.n) return "finished";
  var current = bitIsOn(mask, slot);
  for (var index = slot + 1; index < plan.n; index++) {
    var next = bitIsOn(mask, index);
    if (next !== current) {
      return (next ? "ON " : "OFF ") + clockText(dayStart + index * 900000);
    }
  }
  return "no more changes";
}

function displayPlan(plan, bounds) {
  var slot = Math.floor((Date.now() - bounds[0]) / 900000);
  var completed = slot;
  if (completed < 0) completed = 0;
  if (completed > plan.n) completed = plan.n;
  var output0 = Shelly.getComponentStatus("switch", CONFIG.outputIds[0]);
  var actual0 = output0 && output0.output ? "ON" : "OFF";
  var planned0 = slot >= 0 && slot < plan.n && bitIsOn(plan.a, slot) ? "ON" : "OFF";
  if (outputCount > 1) {
    var output1 = Shelly.getComponentStatus("switch", CONFIG.outputIds[1]);
    var actual1 = output1 && output1.output ? "ON" : "OFF";
    var planned1 = slot >= 0 && slot < plan.n && bitIsOn(plan.b, slot) ? "ON" : "OFF";
    show(0, "OUT0 " + elapsedHours(plan.a, completed) + "/" + plan.x / 4 + " h, " +
      "OUT1 " + elapsedHours(plan.b, completed) + "/" + plan.y / 4 + " h");
    show(1, "Planned OUT0 " + planned0 + ", OUT1 " + planned1 +
      " | actual OUT0 " + actual0 + ", OUT1 " + actual1);
    show(2, "OUT0 " + nextChange(plan.a, plan, slot, bounds[0]) +
      " | OUT1 " + nextChange(plan.b, plan, slot, bounds[0]));
    return;
  }
  show(0, "OUT0 " + elapsedHours(plan.a, completed) + "/" + plan.x / 4 + " h");
  show(1, "Planned OUT0 " + planned0 + " | actual OUT0 " + actual0);
  show(2, "OUT0 " + nextChange(plan.a, plan, slot, bounds[0]));
}

function refresh() {
  if (!controllerIsRunning()) {
    forceOutputsOff("controller script is stopped");
    return;
  }
  Shelly.call("KVS.Get", { key: CONFIG.kvsKey }, function (result, errorCode) {
    if (errorCode !== 0 || !result) {
      show(0, "No cached plan for today");
      show(1, "Controller running | outputs fail safe to OFF");
      show(2, "Waiting for prices");
      return;
    }
    try {
      var data = typeof result.value === "string" ? JSON.parse(result.value) : result.value;
      var today = dateKey(new Date());
      var bounds = dayBounds(today);
      var plan = planForToday(data, today);
      if (!planIsValid(plan, bounds)) {
        show(0, "No valid plan for today");
        show(1, "Controller running | outputs fail safe to OFF");
        show(2, "Waiting for prices");
        return;
      }
      displayPlan(plan, bounds);
    } catch (error) {
      show(0, "Cached plan is invalid");
      show(1, "Controller running | outputs fail safe to OFF");
      show(2, "Waiting for prices");
    }
  });
}

function setGroup() {
  var members = ["number:" + CONFIG.settingNumberIds[0]];
  if (outputCount > 1) members.push("number:" + CONFIG.settingNumberIds[1]);
  for (var field = 0; field < CONFIG.statusIds.length; field++) {
    if (statusReady[field]) members.push("text:" + CONFIG.statusIds[field]);
  }
  Shelly.call("Group.Set", { id: CONFIG.groupId, value: members });
}

function detectOutputs() {
  outputCount = 0;
  for (var channel = 0; channel < CONFIG.outputIds.length; channel++) {
    if (!Shelly.getComponentStatus("switch", CONFIG.outputIds[channel])) break;
    outputCount++;
  }
  if (outputCount < 1) {
    log("Monitor stopped: no switch outputs detected");
    return false;
  }
  log("Detected " + outputCount + " switch output" + (outputCount === 1 ? "" : "s"));
  return true;
}

function startMonitor() {
  Shelly.addStatusHandler(function (event) {
    if (event.name !== "script" || event.id !== CONFIG.controllerScriptId || !event.delta) return;
    if (event.delta.running === false) {
      forceOutputsOff("controller stopped");
    } else if (event.delta.running === true) {
      Timer.set(1000, false, function () {
        setGroup();
        refresh();
      });
    }
  });
  setGroup();
  refresh();
  Timer.set(CONFIG.refreshMs, true, refresh);
  log("Monitor and watchdog started");
}

function createStatusComponent(field) {
  if (field >= CONFIG.statusIds.length) {
    startMonitor();
    return;
  }
  var config = {
    name: CONFIG.statusNames[field],
    default_value: "Waiting for data",
    persisted: false,
    max_len: 120,
    meta: { ui: { view: "label" } }
  };
  var id = CONFIG.statusIds[field];
  Shelly.call("Text.GetConfig", { id: id }, function (result, errorCode) {
    if (errorCode === 0 && result) {
      if (result.name !== CONFIG.statusNames[field]) log("Component conflict at text:" + id + "; field disabled");
      else statusReady[field] = true;
      createStatusComponent(field + 1);
      return;
    }
    Shelly.call("Virtual.Add", { type: "text", id: id, config: config }, function (addResult, addError, addMessage) {
      if (addError !== 0) log("text:" + id + " creation failed: " + addMessage);
      else statusReady[field] = true;
      createStatusComponent(field + 1);
    });
  });
}

if (detectOutputs()) createStatusComponent(0);
