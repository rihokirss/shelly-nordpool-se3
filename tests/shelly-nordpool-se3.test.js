"use strict";

process.env.TZ = "Europe/Helsinki";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const controller = require("../src/shelly-nordpool-se3.source.js");

function makeLocalDaySlots(dateKey, priceFactory) {
  const bounds = controller.localDayBounds(dateKey);
  const count = Math.round((bounds.end - bounds.start) / (15 * 60 * 1000));
  const slots = [];
  for (let i = 0; i < count; i++) {
    const start = bounds.start + i * 15 * 60 * 1000;
    slots.push({
      start,
      end: start + 15 * 60 * 1000,
      price: priceFactory ? priceFactory(i, count) : i
    });
  }
  return slots;
}

function responseBody(slots, includeArea = true) {
  return JSON.stringify({
    currency: "EUR",
    multiAreaEntries: slots.map((slot) => ({
      deliveryStart: new Date(slot.start).toISOString(),
      deliveryEnd: new Date(slot.end).toISOString(),
      entryPerArea: includeArea ? { SE3: slot.price } : { FI: slot.price }
    })),
    // Nord Pool includes these summary records after multiAreaEntries. They
    // have deliveryStart fields but are not quarter-hour price entries.
    blockPriceAggregates: slots.length ? [{
      blockName: "Off-peak 1",
      deliveryStart: new Date(slots[0].start).toISOString(),
      deliveryEnd: new Date(slots[slots.length - 1].end).toISOString(),
      averagePricePerArea: { SE3: { average: 10, min: 1, max: 20 } }
    }] : []
  });
}

test("6 h and 3 h select exactly 24 and 12 cheapest quarter-hours", () => {
  const slots = makeLocalDaySlots("20260808", (i) => 100 - i);
  const plan = controller.buildPlan("20260808", slots, [6, 3]);

  assert.equal(plan.count, 96);
  assert.equal(controller.countSelected(plan.masks[0]), 24);
  assert.equal(controller.countSelected(plan.masks[1]), 12);
  assert.deepEqual(plan.masks[0].slice(72), new Array(24).fill(true));
  assert.deepEqual(plan.masks[1].slice(84), new Array(12).fill(true));
});

test("equal prices are resolved chronologically", () => {
  const slots = makeLocalDaySlots("20260808", () => 10);
  const mask = controller.selectCheapest(slots, 1);

  assert.deepEqual(mask.slice(0, 4), [true, true, true, true]);
  assert.equal(controller.countSelected(mask), 4);
});

test("negative prices sort before positive prices", () => {
  const slots = makeLocalDaySlots("20260808", (i) => i === 50 ? -25 : i === 20 ? -5 : 10);
  const mask = controller.selectCheapest(slots, 0.5);

  assert.equal(controller.countSelected(mask), 2);
  assert.equal(mask[50], true);
  assert.equal(mask[20], true);
});

test("0 h disables a channel and 24 h selects a full normal day", () => {
  const slots = makeLocalDaySlots("20260808");
  assert.equal(controller.countSelected(controller.selectCheapest(slots, 0)), 0);
  assert.equal(controller.countSelected(controller.selectCheapest(slots, 24)), 96);
});

test("hour settings are clamped and rounded to quarter-hours", () => {
  assert.equal(controller.normalizeHours(-1, 6), 0);
  assert.equal(controller.normalizeHours(25, 6), 24);
  assert.equal(controller.normalizeHours(6.12, 6), 6);
  assert.equal(controller.normalizeHours(6.13, 6), 6.25);
  assert.equal(controller.selectedCount(6, 96), 24);
});

test("date-key arithmetic works without Date.setDate", () => {
  assert.equal(controller.addDaysKey("20260808", -1), "20260807");
  assert.equal(controller.addDaysKey("20260808", 1), "20260809");
  assert.equal(controller.addDaysKey("20260329", 1), "20260330");
  assert.equal(controller.addDaysKey("20261025", -1), "20261024");
});

test("local calendar days support 92, 96 and 100 quarter-hours", () => {
  assert.equal(controller.validateLocalDaySlots(makeLocalDaySlots("20260329"), "20260329").length, 92);
  assert.equal(controller.validateLocalDaySlots(makeLocalDaySlots("20260808"), "20260808").length, 96);
  assert.equal(controller.validateLocalDaySlots(makeLocalDaySlots("20261025"), "20261025").length, 100);
});

test("24 h is capped to the actual number of slots on the spring DST day", () => {
  const slots = makeLocalDaySlots("20260329");
  assert.equal(controller.countSelected(controller.selectCheapest(slots, 24)), 92);
});

test("Nord Pool JSON extraction uses absolute timestamps and the local target date", () => {
  const targetSlots = makeLocalDaySlots("20260808", (i) => i / 10);
  const before = {
    start: targetSlots[0].start - 15 * 60 * 1000,
    end: targetSlots[0].start,
    price: 999
  };
  const after = {
    start: targetSlots[targetSlots.length - 1].end,
    end: targetSlots[targetSlots.length - 1].end + 15 * 60 * 1000,
    price: 999
  };
  const extracted = controller.extractTargetSlots(responseBody([before, ...targetSlots, after]), "20260808");

  assert.equal(extracted.length, 96);
  assert.equal(extracted[0].start, targetSlots[0].start);
  assert.equal(extracted[95].start, targetSlots[95].start);
});

test("malformed JSON, missing SE3 and incomplete days are rejected", () => {
  const slots = makeLocalDaySlots("20260808");
  assert.throws(() => controller.extractTargetSlots("not json", "20260808"));
  assert.throws(() => controller.extractTargetSlots(responseBody(slots, false), "20260808"), /SE3/);
  assert.throws(() => controller.validateLocalDaySlots(slots.slice(1), "20260808"), /Expected/);
});

test("KVS serialization restores both channel plans and detects corruption", () => {
  const todaySlots = makeLocalDaySlots("20260808", (i) => 100 - i);
  const tomorrowSlots = makeLocalDaySlots("20260809", (i) => i);
  const plans = {
    20260808: controller.buildPlan("20260808", todaySlots, [6, 3]),
    20260809: controller.buildPlan("20260809", tomorrowSlots, [6, 3])
  };
  const serialized = controller.serializePlans(plans, ["20260808", "20260809"]);
  const restored = controller.deserializePlans(serialized);

  assert.ok(serialized.length <= 253);
  assert.deepEqual(restored["20260808"].selected, [24, 12]);
  assert.deepEqual(restored["20260809"].selected, [24, 12]);
  assert.deepEqual(restored["20260808"].masks, plans["20260808"].masks);

  const corrupted = JSON.parse(serialized);
  corrupted.x0 = 23;
  assert.throws(() => controller.deserializePlans(JSON.stringify(corrupted)), /checksum/);
});

test("current slot indexing follows elapsed absolute quarters across the local day", () => {
  const slots = makeLocalDaySlots("20261025");
  const plan = controller.buildPlan("20261025", slots, [6, 3]);
  const bounds = controller.localDayBounds("20261025");

  assert.equal(controller.currentSlotIndex(plan, bounds.start), 0);
  assert.equal(controller.currentSlotIndex(plan, bounds.start + 99 * 15 * 60 * 1000), 99);
  assert.equal(controller.currentSlotIndex(plan, bounds.end), -1);
});

test("readable controller delegates a missing plan to the price fetcher", () => {
  const logs = [];
  const kvsWrites = [];
  const monitorCalls = [];
  let monitorRunning = true;

  const context = {
    Script: { id: 1 },
    print: (line) => logs.push(line),
    Timer: {
      set: (delay, repeat, callback) => {
        if (delay <= 5000 && !repeat) callback();
        return 1;
      },
      clear: () => undefined
    },
    Shelly: {
      getDeviceInfo: () => ({ app: "S2PMG3", ver: "2.0.0" }),
      getComponentStatus: (type, id) => {
        if (type === "sys") return { unixtime: Math.floor(Date.now() / 1000) };
        if (type === "number") return { value: id === 250 ? 6 : 3 };
        if (type === "switch") return { output: false };
        if (type === "script" && id === 2) return { running: monitorRunning };
        return null;
      },
      call: (method, params, callback) => {
        if (method === "Shelly.GetComponents") {
          callback({ components: [
            { key: "group:250", config: { name: "Nord Pool SE3" } },
            { key: "number:250", config: { name: "OUT0 cheap hours" } },
            { key: "number:251", config: { name: "OUT1 cheap hours" } }
          ] }, 0, "");
        } else if (method === "Number.SetConfig" || method === "Group.Set" || method === "Switch.Set") {
          callback({}, 0, "");
        } else if (method === "Number.GetStatus") {
          callback({ value: params.id === 250 ? 6 : 3 }, 0, "");
        } else if (method === "KVS.Get") {
          callback(null, 1, "Not found");
        } else if (method === "KVS.Set") {
          kvsWrites.push(params.value);
          callback({}, 0, "");
        } else if (method === "Script.Stop") {
          monitorCalls.push(`${method}:${params.id}`);
          if (callback) callback({}, 0, "");
        } else if (method === "Script.Start") {
          monitorRunning = true;
          monitorCalls.push(`${method}:${params.id}`);
          if (callback) callback({}, 0, "");
        } else {
          throw new Error(`Unexpected Shelly call: ${method}`);
        }
      }
    }
  };

  const runtimePath = path.join(__dirname, "..", "shelly-nordpool-se3.js");
  vm.runInNewContext(fs.readFileSync(runtimePath, "utf8"), context, { filename: runtimePath });

  assert.equal(kvsWrites.length, 1);
  assert.deepEqual(JSON.parse(kvsWrites[0]).h, [6, 3]);
  assert.deepEqual(monitorCalls, ["Script.Stop:2", "Script.Start:3", "Script.Stop:1"]);
  assert.equal(context.state.busy, true);
});

test("controller restarts the watchdog while a failed fetch waits for retry", () => {
  const scriptStarts = [];
  const retry = JSON.stringify({ d: controller.localDateKey(new Date()), h: [6, 3], c: 2, retry: Date.now() + 300000 });
  const context = {
    Script: { id: 1 },
    print: () => undefined,
    Timer: { set: () => 1, clear: () => undefined },
    Shelly: {
      getDeviceInfo: () => ({ app: "S2PMG3", ver: "2.0.0" }),
      getComponentStatus: (type, id) => {
        if (type === "sys") return { unixtime: Math.floor(Date.now() / 1000) };
        if (type === "switch") return { output: false };
        if (type === "number") return { value: id === 250 ? 6 : 3 };
        if (type === "script" && id === 2) return { running: false };
        return null;
      },
      call: (method, params, callback) => {
        if (method === "Shelly.GetComponents") {
          callback({ components: [
            { key: "group:250", config: { name: "Nord Pool SE3" } },
            { key: "number:250", config: { name: "OUT0 cheap hours" } },
            { key: "number:251", config: { name: "OUT1 cheap hours" } }
          ] }, 0, "");
        } else if (method === "Group.Set" || method === "Switch.Set") {
          callback({}, 0, "");
        } else if (method === "KVS.Get") {
          callback(params.key === "np_se3_req_v1" ? { value: retry } : null,
            params.key === "np_se3_req_v1" ? 0 : 1, "Not found");
        } else if (method === "Script.Start") {
          scriptStarts.push(params.id);
          if (callback) callback({}, 0, "");
        } else {
          throw new Error(`Unexpected Shelly call: ${method}`);
        }
      }
    }
  };

  const runtimePath = path.join(__dirname, "..", "shelly-nordpool-se3.js");
  vm.runInNewContext(fs.readFileSync(runtimePath, "utf8"), context, { filename: runtimePath });
  assert.deepEqual(scriptStarts, [2]);
  assert.equal(context.state.busy, false);
});

test("production runtime detects a one-output Shelly and omits OUT1 controls", () => {
  const logs = [];
  const virtualAdds = [];
  const groupCalls = [];
  const switchCalls = [];
  const kvsWrites = [];

  const context = {
    Script: { id: 1 },
    print: (line) => logs.push(line),
    Timer: {
      set: (delay, repeat, callback) => {
        if (delay <= 5000 && !repeat) callback();
        return 1;
      },
      clear: () => undefined
    },
    Shelly: {
      getDeviceInfo: () => ({ app: "S1PMG3", ver: "2.0.0" }),
      getComponentStatus: (type, id) => {
        if (type === "sys") return { unixtime: Math.floor(Date.now() / 1000) };
        if (type === "switch") return id === 0 ? { output: false } : null;
        if (type === "number") return id === 250 ? { value: 6 } : null;
        return null;
      },
      call: (method, params, callback) => {
        if (method === "Shelly.GetComponents") {
          callback({ components: [] }, 0, "");
        } else if (method === "Virtual.Add") {
          virtualAdds.push(params);
          callback({}, 0, "");
        } else if (method === "Group.Set") {
          groupCalls.push(params);
          callback({}, 0, "");
        } else if (method === "KVS.Get") {
          callback(null, 1, "Not found");
        } else if (method === "KVS.Set") {
          kvsWrites.push(params.value);
          callback({}, 0, "");
        } else if (method === "Script.Start" || method === "Script.Stop") {
          if (callback) callback({}, 0, "");
        } else if (method === "Switch.Set") {
          switchCalls.push(params);
          callback({}, 0, "");
        } else {
          throw new Error(`Unexpected Shelly call: ${method}`);
        }
      }
    }
  };

  const runtimePath = path.join(__dirname, "..", "shelly-nordpool-se3.js");
  vm.runInNewContext(fs.readFileSync(runtimePath, "utf8"), context, { filename: runtimePath });

  assert.equal(context.state.outputCount, 1);
  assert.deepEqual(JSON.parse(kvsWrites[0]).h, [6, 0]);
  assert.deepEqual(virtualAdds.filter((item) => item.type === "number").map((item) => item.id), [250]);
  assert.deepEqual(Array.from(groupCalls[0].value), ["number:250"]);
  assert.ok(switchCalls.every((item) => item.id === 0));
  assert.match(logs.join("\n"), /Detected 1 switch output/);
  assert.doesNotMatch(logs.join("\n"), /OUT1=/);
});

test("production runtime avoids mJS methods missing from Shelly firmware 2.0", () => {
  const runtimePath = path.join(__dirname, "..", "shelly-nordpool-se3.js");
  const runtime = fs.readFileSync(runtimePath, "utf8");
  const fetcher = fs.readFileSync(path.join(__dirname, "..", "shelly-nordpool-se3-fetcher.js"), "utf8");
  assert.doesNotMatch(runtime, /\.setDate\s*\(/);
  assert.doesNotMatch(runtime, /\.sort\s*\(/);
  assert.doesNotMatch(fetcher, /\.setDate\s*\(/);
  assert.doesNotMatch(fetcher, /\.sort\s*\(/);
  assert.ok(Buffer.byteLength(fetcher, "utf8") < 8000, "fetcher must stay below 8 kB for Gen4 mJS headroom");
});

test("minimal fetcher stores mixed cheap-ON and expensive-OFF masks", () => {
  const currentKey = controller.localDateKey(new Date());
  const localSlots = makeLocalDaySlots(currentKey, (i) => 100 - i);
  const request = JSON.stringify({ d: currentKey, h: [1, 23], c: 2, retry: 0 });
  const writes = [];
  const scriptCalls = [];
  let httpCalls = 0;

  const context = {
    Script: { id: 3 },
    print: () => undefined,
    Timer: {
      set: (delay, repeat, callback) => {
        if (!repeat) callback();
        return 1;
      }
    },
    Shelly: {
      call: (method, params, callback) => {
        if (method === "KVS.Get" && params.key === "np_se3_req_v1") {
          callback({ value: request }, 0, "");
        } else if (method === "HTTP.GET") {
          const part = httpCalls++ === 0 ? localSlots.slice(0, 4) : localSlots.slice(4);
          callback({ code: 200, body: responseBody(part) }, 0, "");
        } else if (method === "KVS.Set") {
          writes.push(params);
          callback({}, 0, "");
        } else if (method === "Script.Start" || method === "Script.Stop") {
          scriptCalls.push(`${method}:${params.id}`);
          if (callback) callback({}, 0, "");
        } else {
          throw new Error(`Unexpected fetcher call: ${method}`);
        }
      }
    }
  };

  const fetcherPath = path.join(__dirname, "..", "shelly-nordpool-se3-fetcher.js");
  vm.runInNewContext(fs.readFileSync(fetcherPath, "utf8"), context, { filename: fetcherPath });

  assert.equal(httpCalls, 2);
  const stored = JSON.parse(writes.find((item) => item.key === "np_se3_req_v1").value);
  const expectedPlan = controller.buildPlan(currentKey, localSlots, [1, 23]);
  assert.equal(stored.plan.n, localSlots.length);
  assert.equal(stored.plan.x, 4);
  assert.equal(stored.plan.y, 92);
  assert.equal(stored.plan.a, controller.maskToHex(expectedPlan.masks[0]));
  assert.equal(stored.plan.b, controller.maskToHex(expectedPlan.masks[1]));
  assert.deepEqual(scriptCalls, ["Script.Start:1", "Script.Stop:3"]);
});

test("monitor displays elapsed schedule and forces outputs off when controller stops", () => {
  const currentKey = controller.localDateKey(new Date());
  const bounds = controller.localDayBounds(currentKey);
  const count = Math.round((bounds.end - bounds.start) / (15 * 60 * 1000));
  const plan = {
    d: currentKey,
    n: count,
    a: "f".repeat(Math.ceil(count / 4)),
    b: "f".repeat(Math.ceil(count / 4)),
    x: count,
    y: count
  };
  const values = [];
  const switchCalls = [];
  const groupCalls = [];
  const oneShotTimers = [];
  let statusHandler = null;

  const context = {
    print: () => undefined,
    Timer: {
      set: (delay, repeat, callback) => {
        if (!repeat) oneShotTimers.push({ delay, callback });
        return 1;
      }
    },
    Shelly: {
      getComponentStatus: (type, id) => {
        if (type === "script") return { running: true };
        if (type === "switch") return { output: id === 0 };
        return null;
      },
      call: (method, params, callback) => {
        if (method === "Text.GetConfig") {
          const names = { 250: "Run today", 251: "Now", 252: "Next" };
          callback({ name: names[params.id] }, 0, "");
        } else if (method === "Text.Set") {
          values.push(params);
        } else if (method === "Group.Set") {
          groupCalls.push(params);
        } else if (method === "KVS.Get") {
          if (params.key === "np_se3_plan_v1") callback({ value: JSON.stringify({ v: 1, p: [plan] }) }, 0, "");
          else callback(null, 1, "Not found");
        } else if (method === "Switch.Set") {
          switchCalls.push(params);
        } else {
          throw new Error(`Unexpected monitor call: ${method}`);
        }
      },
      addStatusHandler: (handler) => {
        statusHandler = handler;
      }
    }
  };

  const monitorPath = path.join(__dirname, "..", "shelly-nordpool-se3-monitor.js");
  vm.runInNewContext(fs.readFileSync(monitorPath, "utf8"), context, { filename: monitorPath });

  assert.match(values.find((item) => item.id === 250).value, /OUT0 .*\/24 h, OUT1 .*\/24 h/);
  assert.match(values.find((item) => item.id === 251).value, /actual OUT0 ON, OUT1 OFF/);
  assert.match(values.find((item) => item.id === 252).value, /OUT0 no more changes/);
  assert.deepEqual(Array.from(groupCalls[0].value), [
    "number:250", "number:251", "text:250", "text:251", "text:252"
  ]);
  assert.equal(typeof statusHandler, "function");

  statusHandler({ name: "script", id: 1, delta: { running: false } });
  assert.equal(switchCalls.length, 1);
  assert.equal(switchCalls[0].id, 0);
  assert.equal(switchCalls[0].on, false);
  assert.equal(switchCalls[0].tag, "np-watchdog");
  assert.equal(values.filter((item) => item.id === 251).at(-1).value, "SAFE OFF | controller stopped");
  assert.equal(values.filter((item) => item.id === 252).at(-1).value, "Controller unavailable");

  statusHandler({ name: "script", id: 1, delta: { running: true } });
  assert.equal(oneShotTimers.at(-1).delay, 1000);
  oneShotTimers.at(-1).callback();
  assert.match(values.filter((item) => item.id === 251).at(-1).value, /actual OUT0 ON, OUT1 OFF/);
});

test("monitor detects one output and omits OUT1 from the group and status", () => {
  const currentKey = controller.localDateKey(new Date());
  const bounds = controller.localDayBounds(currentKey);
  const count = Math.round((bounds.end - bounds.start) / (15 * 60 * 1000));
  const plan = {
    d: currentKey,
    n: count,
    a: "f".repeat(Math.ceil(count / 4)),
    b: "0".repeat(Math.ceil(count / 4)),
    x: count,
    y: 0
  };
  const values = [];
  const groupCalls = [];
  const switchCalls = [];
  let statusHandler = null;

  const context = {
    print: () => undefined,
    Timer: { set: () => 1 },
    Shelly: {
      getComponentStatus: (type, id) => {
        if (type === "script") return { running: true };
        if (type === "switch") return id === 0 ? { output: true } : null;
        return null;
      },
      call: (method, params, callback) => {
        if (method === "Text.GetConfig") {
          const names = { 250: "Run today", 251: "Now", 252: "Next" };
          callback({ name: names[params.id] }, 0, "");
        } else if (method === "Text.Set") {
          values.push(params);
        } else if (method === "Group.Set") {
          groupCalls.push(params);
        } else if (method === "KVS.Get") {
          if (params.key === "np_se3_plan_v1") callback({ value: JSON.stringify({ v: 1, p: [plan] }) }, 0, "");
          else callback(null, 1, "Not found");
        } else if (method === "Switch.Set") {
          switchCalls.push(params);
        } else {
          throw new Error(`Unexpected monitor call: ${method}`);
        }
      },
      addStatusHandler: (handler) => {
        statusHandler = handler;
      }
    }
  };

  const monitorPath = path.join(__dirname, "..", "shelly-nordpool-se3-monitor.js");
  vm.runInNewContext(fs.readFileSync(monitorPath, "utf8"), context, { filename: monitorPath });

  assert.deepEqual(Array.from(groupCalls[0].value), [
    "number:250", "text:250", "text:251", "text:252"
  ]);
  assert.doesNotMatch(values.map((item) => item.value).join("\n"), /OUT1/);
  statusHandler({ name: "script", id: 1, delta: { running: false } });
  assert.deepEqual(switchCalls.map((item) => item.id), [0]);
});
