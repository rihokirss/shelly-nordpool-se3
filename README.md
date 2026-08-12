# Nord Pool SE3 quarter-hour controller for Shelly Gen3 and Gen4

New to Shelly scripts? Start with the step-by-step [`INSTALL.md`](INSTALL.md) guide. It explains exactly what to click and what a successful installation looks like.

This Shelly script controls one or two relay outputs using Nord Pool SE3 day-ahead prices. At startup it detects whether `switch:0` only or both `switch:0` and `switch:1` exist. Each available output runs during its configured number of cheapest 15-minute delivery periods in an Aland local calendar day.

Default settings:

- OUT0: 6 hours/day = 24 cheapest quarter-hours
- OUT1, when the device has a second output: 3 hours/day = 12 cheapest quarter-hours
- Price basis: SE3 spot price in EUR/MWh, excluding VAT, grid fees and retailer margin

The selected periods do not need to be consecutive.

## Requirements

- A Shelly Gen3 or Gen4 device with one or two switch outputs; fully tested on Shelly 2PM Gen3 firmware 2.0.0
- Working internet and time synchronization on the Shelly
- Device timezone following Aland/Finnish local time, such as `Europe/Helsinki`, `Europe/Mariehamn` or another zone with the same UTC offset and DST rules
- Access to the device web interface

The script does not change the device timezone, input modes, firmware or electrical protection limits.

## How it works

Nord Pool returns SE3 delivery periods using absolute UTC timestamps and the SE3/Stockholm market day. Aland local time is one hour ahead of Stockholm. The script therefore fetches two adjacent SE3 market dates, combines their entries and filters them by the Shelly's local calendar date from 00:00 to 24:00.

On a normal day this produces 96 quarter-hours. European daylight-saving transitions are handled as actual local days:

- spring transition: 92 quarter-hours
- normal day: 96 quarter-hours
- autumn transition: 100 quarter-hours

For each output, the script sorts the local day's intervals by price and then by timestamp. It selects `configured hours × 4` intervals. Equal prices are resolved in chronological order.

No Shelly Schedule jobs are created. The script applies output states at quarter-hour boundaries and performs a health check every minute.

## Installation

1. Open the Shelly web interface.
2. Open **Scripts** and select **Create script**.
3. Name it `NordPool SE3`.
4. Copy the complete contents of `shelly-nordpool-se3.js` into the editor.
5. Save the script, but do not start it yet.
6. Enable script auto-start.
7. Create script 2 named `NordPool SE3 monitor`, copy in `shelly-nordpool-se3-monitor.js`, save it and leave auto-start disabled.
8. Create script 3 named `NordPool SE3 fetcher`, copy in `shelly-nordpool-se3-fetcher.js`, save it and leave auto-start disabled.
9. Start only the controller. It starts the monitor and invokes the fetcher when needed.

The default configuration expects controller ID 1, monitor ID 2 and fetcher ID 3. If the assigned IDs differ, update `monitorScriptId`, `fetcherScriptId` and `controllerScriptId` in the relevant `CONFIG` objects before starting them.

The script creates these virtual components only when their IDs are free:

- `group:250` — **Nord Pool SE3**
- `number:250` — **OUT0 cheap hours**
- `number:251` — **OUT1 cheap hours**, only when `switch:1` exists
- `text:250` — **Run today** (created by the monitor script)
- `text:251` — **Now** (created by the monitor script)
- `text:252` — **Next** (created by the monitor script)

If one of those IDs is already occupied by an unrelated component, startup stops safely and the existing component is not modified.

The group and settings for the detected outputs appear as soon as the controller starts. The controller starts the monitor automatically, which then adds **Run today**, **Now** and **Next**. A one-output device does not create or display an OUT1 setting and never sends an OUT1 relay command.

`shelly-nordpool-se3.js` is the readable production runtime used on the device. An extended source with Node-test exports is kept in `src/shelly-nordpool-se3.source.js` for regression testing of the date, selection and KVS algorithms.

`shelly-nordpool-se3-monitor.js` creates the three status fields and provides the fail-safe watchdog. `shelly-nordpool-se3-fetcher.js` is a minimal HTTP runtime that downloads and validates prices, writes the compact plan and then stops itself.

Shelly scripts share a roughly 25 kB mJS memory pool even when the device has substantially more system RAM. Before a download, the controller waits until outputs are OFF, stops the monitor, starts the minimal fetcher and stops itself. The fetcher saves either a plan or a five-minute retry time, restarts the controller and stops itself. This prevents the 11 kB Nord Pool response from sharing the script pool with the larger controller and monitor runtimes.

## Configuration

Open **Components → Nord Pool SE3** in the Shelly web interface.

Each output has a persistent 0–24 hour setting with a 0.25-hour step:

- `6.00` means 24 selected quarter-hours
- `3.00` means 12 selected quarter-hours
- `0.25` means one selected quarter-hour
- `0.00` disables that output and keeps it off

A settings change invalidates the old plan and requests the two required market dates again. Until a plan matching the new settings is available, the automation fails safe to OFF.

## Price updates

The script requests prices directly from:

```text
https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices
```

It requests today's plan at startup when no matching cached plan exists. Starting at 20:00 local time it also requests the next local day's prices.

A complete plan is saved under the Shelly KVS key:

```text
np_se3_plan_v1
```

The KVS value contains compact bitmasks for the current and next local day. This allows a valid current plan to survive a reboot or a temporary internet outage.

## Failure and fail-safe behavior

The script rejects a response when any of the following is true:

- the HTTP request fails or does not return status 200;
- the body is not valid JSON;
- a target entry has no numeric SE3 price;
- timestamps are duplicated, missing, unordered or not 15 minutes long;
- the complete local calendar day cannot be assembled.

An invalid or partial response never overwrites a valid cached plan.

- If a valid plan for the current local day exists, it remains active until the end of that day.
- If no valid current plan exists, every detected output is forced OFF.
- A missing plan is retried every five minutes, with only one price request active at a time.
- If the companion monitor sees the controller script stop, it immediately sends OFF to every detected output. It never sends an ON command.
- Every ON command includes a 16-minute Shelly `toggle_after` safety timer. The one-minute health check and each selected quarter-hour boundary refresh that timer. If the script stops or hangs while an output is on, the relay therefore returns to OFF.

The watchdog and `toggle_after` cover different failures. The watchdog handles a reported controller stop immediately. The hardware timer remains the independent fallback when the controller hangs without a stop event, or when the monitor itself is unavailable.

## Monitoring

Open the script consoles and look for messages prefixed with:

```text
[NordPool SE3]
[NordPool monitor]
[NordPool fetcher]
```

A successful plan message includes:

- local plan date;
- interval count (normally 96);
- selected interval counts for the detected outputs;
- minimum and maximum SE3 price in EUR/MWh.

You can also inspect:

- **Scripts** — running state and memory use
- **Components** — current hour settings
- **Components → Nord Pool SE3** — settings plus separate **Run today**, **Now** and **Next** fields
- **Advanced → KVS** — cached `np_se3_plan_v1` plan
- **Home** or `Shelly.GetStatus` — actual states and power for the detected outputs

With the default settings, a normal plan reports OUT0=24. On a two-output device it also reports OUT1=12.

## Manual control

While the controller is running, it owns all detected output states. A manual or physical-input change can be corrected by the next one-minute health check or quarter-hour boundary.

To take lasting manual control, wait until the fetcher is stopped, then stop the monitor first and the controller second. If only the controller is stopped, the watchdog intentionally forces every detected output off. An output that was previously turned on by the controller can still have its 16-minute safety timer active; explicitly turn the output off or set the desired manual state after stopping both running scripts.

## Dry-run testing

For a test that fetches and calculates prices without changing outputs, temporarily set:

```js
dryRun: true
```

in the controller's `CONFIG` object before uploading. Relay commands are then suppressed. Price-download messages appear in the fetcher console and plan/application messages appear in the controller console. Restore `dryRun: false`, save and restart for production use.

Local logic tests can be run with Node.js:

```powershell
node --test .\tests\shelly-nordpool-se3.test.js
```

## Troubleshooting

### The output or outputs remain off

Check the script console. The most common causes are missing device time, unavailable prices, an incomplete Nord Pool response, settings-component conflicts or all available hour settings being zero.

After a reboot, the controller may initially keep the outputs off until NTP corrects the clock. The one-minute health check then applies the valid cached plan.

### Tomorrow's plan is not available at 20:00

Publication can be delayed. The script retries automatically every five minutes and does not replace today's valid plan.

### The hour setting changed but the output did not follow the new plan

The old plan is no longer considered valid. The script must download the required market dates again. Check the console for a successful replacement plan.

### The Now component says SAFE OFF

The monitor detected that controller script ID 1 is not running and forced every detected relay off. Start the controller and inspect its console. If the controller was installed under another script ID, update `controllerScriptId` in `shelly-nordpool-se3-monitor.js`.

### A virtual-component conflict is reported

Another component already uses `group:250`, `number:250`, `number:251` or one of `text:250` through `text:252`. The scripts intentionally do not delete or overwrite it. Free those IDs or change all corresponding IDs in both `CONFIG` objects before installation.

## Removal and rollback

1. Stop and delete the `NordPool SE3 fetcher` and `NordPool SE3 monitor` scripts, then delete only `text:250`, `text:251` and `text:252` if no longer needed.
2. Stop the `NordPool SE3` controller script.
3. Turn every available output off.
4. Delete the controller script.
5. Delete only the KVS keys `np_se3_plan_v1` and `np_se3_req_v1`.
6. If they are no longer needed, delete `group:250`, `number:250` and, when it exists, `number:251` from Components.

Do not bulk-delete KVS entries or virtual components; other automations may use them.

On the tested firmware 2.0.0 device, deleting a script caused a brief device reboot and the delete RPC connection closed before returning a response. If this happens, wait for the web interface to return and verify the script list before repeating the deletion.

## Electrical safety

The initial test device had no loads connected. Before connecting equipment, verify the exact Shelly model's per-channel current and power limits. Use correctly rated contactors for heating loads or other equipment that exceeds relay limits, has high inrush current, or requires electrical isolation. Mains wiring must be performed according to local electrical regulations by a qualified person.

The script uses normal output logic: relay ON means the connected control circuit is enabled.
