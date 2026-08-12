# Nord Pool SE3 quarter-hour controller for Shelly

This project controls one or two Shelly Gen3/Gen4 relay outputs during the cheapest SE3 day-ahead quarter-hours. For a click-by-click setup, see [INSTALL.md](INSTALL.md).

Defaults:

- OUT0: 6 hours/day, or the 24 cheapest quarter-hours
- OUT1: 3 hours/day, or the 12 cheapest quarter-hours
- price area: SE3, EUR/MWh
- next-day fetch starts at 20:00 local time

The periods do not need to be consecutive. The controller detects at startup whether the device has one or two `switch` outputs and creates controls only for outputs that exist.

## Why the price feed is compact

Nord Pool's official response is too large to parse reliably in the small shared mJS heap on some Shelly 2PM Gen4 devices. More device RAM does not mean that an individual Shelly script receives a larger JavaScript heap.

A GitHub Actions job therefore downloads and validates the official Nord Pool data outside the Shelly, then publishes a compact daily file of about 0.8 kB on this repository's `prices` branch. The Shelly downloads only that compact file. It no longer needs a third price-fetcher script.

The feed builder:

- requests official Nord Pool `DayAheadPrices` data for SE3;
- combines adjacent market dates;
- filters exact Aland/Finnish local calendar days;
- verifies numeric prices, unique ordered timestamps, 15-minute duration and a complete 92/96/100-interval day;
- encodes price order with fixed-width values so equal prices retain chronological order.

The workflow checks hourly, but does not query Nord Pool when all required files already exist. Before 20:00 Aland/Finnish time it only requires today's file; from 20:00 onward it also requires tomorrow's file. A missing file is retried on the next hourly check. Source: [`scripts/update-se3-feed.mjs`](scripts/update-se3-feed.mjs). Workflow: [`.github/workflows/update-se3-feed.yml`](.github/workflows/update-se3-feed.yml).

The `prices` branch keeps the most recent 30 local calendar days plus a possible tomorrow file. It is a generated snapshot branch with a single current commit: each actual update replaces that snapshot instead of accumulating price-file history. The normal `main` branch and its source-code history are not rewritten.

## Requirements

- Shelly Gen3 or Gen4 with one or two switch outputs
- current firmware, internet access and synchronized time
- device timezone set to Aland/Finnish local time, for example `Europe/Helsinki`
- controller installed as script 1 and monitor installed as script 2, unless IDs are changed in both scripts

The scripts do not change firmware, timezone, input modes or electrical protection settings.

## Installation

1. Create script 1 named `NordPool SE3` and paste in [`shelly-nordpool-se3.js`](shelly-nordpool-se3.js).
2. Enable auto-start for script 1, but do not start it yet.
3. Create script 2 named `NordPool SE3 monitor` and paste in [`shelly-nordpool-se3-monitor.js`](shelly-nordpool-se3-monitor.js).
4. Leave auto-start disabled for script 2.
5. Start script 1. It starts script 2 automatically.

If an older installation still has `NordPool SE3 fetcher` as script 3, stop it, disable its auto-start and delete it. The current controller never calls script 3.

The scripts create these virtual components only when their IDs are free:

- `group:250` — **Nord Pool SE3**
- `number:250` — **OUT0 cheap hours**
- `number:251` — **OUT1 cheap hours**, only if `switch:1` exists
- `text:250` — **Run today**
- `text:251` — **Now**
- `text:252` — **Next**

An unrelated component at one of these IDs is not overwritten; startup stops safely instead.

## Selection and local dates

The feed uses absolute delivery timestamps and `Europe/Helsinki`, which has the same time rules as Aland. SE3 uses the Stockholm market day, so two adjacent market responses are combined before filtering local 00:00–24:00.

- spring DST day: 92 quarter-hours
- normal day: 96 quarter-hours
- autumn DST day: 100 quarter-hours

For each output, `round(hours × 4)` lowest-price intervals are selected. Equal-price intervals are selected from earliest to latest. A 24-hour setting selects every available interval, including all 92 or 100 intervals on DST days.

## Configuration

Open **Components → Nord Pool SE3**. Each available output has a persistent setting from 0 to 24 hours in 0.25-hour steps:

- `6.00` = 24 cheapest intervals
- `3.00` = 12 cheapest intervals
- `0.25` = one cheapest interval
- `0.00` = always off

Changing a setting invalidates the old plan, forces outputs off and immediately requests a replacement plan. A complete plan is cached in KVS as `np_se3_plan_v1`.

## Updates and fail-safe behavior

At startup, the controller loads a valid cached plan or fetches today's compact file. From 20:00 onward it also fetches tomorrow's file. A missing plan is retried every five minutes and only one HTTP request can run at a time.

Before its small HTTP request, the controller briefly stops the monitor to maximize free mJS memory; it starts the monitor again after success or failure. The controller itself continues running.

- A failed, malformed, wrong-date or incomplete compact file never replaces a valid cached plan.
- A valid current-day cached plan remains active through an internet or feed outage.
- Without a valid plan for today, all detected outputs are forced off.
- Every ON command includes `toggle_after: 960` (16 minutes).
- The controller refreshes state every minute and on every quarter-hour boundary.
- The monitor forces every detected output off if controller script 1 stops. It never turns an output on.

These checks mean a stopped or failed automation returns relays to OFF. They do not replace correctly designed electrical protection.

## Monitoring

The **Nord Pool SE3** component group shows:

- **Run today** — completed selected time today for each channel
- **Now** — planned and actual output state
- **Next** — next planned state change

Useful console prefixes are `[NordPool SE3]` and `[NordPool monitor]`. A successful download looks like:

```text
[NordPool SE3] Accepted compact plan for 2026-08-12 (96 quarters)
```

Also inspect **Scripts** for running/error state, **Advanced → KVS** for `np_se3_plan_v1`, and the switch power values. With no load connected, expected power is 0 W even when a relay is on.

## Manual control and dry run

While running, the controller owns the relay states and can correct a manual change within one minute. For lasting manual control, stop the monitor first and then the controller. Explicitly set the desired relay state afterward because an earlier ON command may still have its 16-minute safety timer.

To test without relay commands, set `dryRun: true` in the controller `CONFIG`, save and restart. Restore `dryRun: false` for normal operation.

Run local regression tests with Node.js:

```powershell
node --test .\tests\shelly-nordpool-se3.test.js
```

Build the compact files manually with Node 22 or newer:

```powershell
node .\scripts\update-se3-feed.mjs .\feed-test
```

## Troubleshooting

### `Script ran out of memory` on Gen4

Install the current two-script version. Delete the old `NordPool SE3 fetcher`; it is no longer used. The controller must contain `feedBase` pointing to `raw.githubusercontent.com`, not `dataportal-api.nordpoolgroup.com`.

### Outputs remain off

Check correct device time/timezone, non-zero hour settings, controller and monitor consoles, internet access and the current-day file on the `prices` branch. Safe OFF is expected until a valid current plan exists.

### Tomorrow is unavailable at 20:00

Publication can be delayed. The controller retries every five minutes. Today's valid plan remains active.

### Status says `SAFE OFF`

The monitor cannot see controller script 1 running. Start the controller or correct `controllerScriptId` in the monitor if the controller has a different ID.

### Component conflict

Free the reported IDs or consistently change the IDs in both scripts. The automation deliberately does not delete or overwrite foreign components.

## Removal and rollback

1. Stop the monitor, then stop the controller.
2. Turn every output off.
3. Delete only these two scripts (and an obsolete stopped fetcher, if present).
4. Delete only KVS key `np_se3_plan_v1`. Old installations may also remove `np_se3_req_v1` and `np_se3_tmp_0` through `np_se3_tmp_5`.
5. If no longer needed, delete only group/number/text components 250–252 created above.

Do not bulk-delete KVS entries or virtual components because other automations may use them.

## Electrical safety

First test without connected loads. Before connecting heating or other equipment, verify the exact Shelly model's per-channel current, total power and inrush limits. Use correctly rated contactors when required. Mains wiring must comply with local rules and be performed by a qualified person.

Relay ON means the connected control circuit is enabled.
