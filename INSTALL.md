# Easy installation guide

This guide installs the Nord Pool SE3 controller on a clean one- or two-output Shelly Gen3 or Gen4. No programming experience is needed. The current version uses two scripts.

## Before you start

You need a Shelly connected to Wi-Fi and the internet, current firmware, correct local time, and the timezone set to Finnish/Aland time such as `Europe/Helsinki`. Perform the first test without connected loads.

For the default IDs, create the controller first so it becomes script 1 and the monitor second so it becomes script 2.

## 1. Install the controller

1. Open the Shelly web interface and select **Scripts**.
2. Select **Create script** and name it `NordPool SE3`.
3. Open [`shelly-nordpool-se3.js`](shelly-nordpool-se3.js) on GitHub, select **Raw**, copy all text and paste it into the Shelly editor.
4. Save the script.
5. Enable **Run on startup** (or **Auto start**), but do not start it yet.

## 2. Install the monitor

1. Return to **Scripts**, create another script and name it `NordPool SE3 monitor`.
2. Open [`shelly-nordpool-se3-monitor.js`](shelly-nordpool-se3-monitor.js), select **Raw**, copy all text and paste it into the editor.
3. Save it and leave its own **Run on startup** disabled.
4. Do not start it manually.

No fetcher script is required. If this is an upgrade and a `NordPool SE3 fetcher` script exists, stop it, disable auto-start and delete it.

## 3. Start the controller

Open `NordPool SE3` and select **Start**. The controller automatically starts the monitor.

Within a short time, the controller console should contain lines similar to:

```text
[NordPool SE3] Detected 2 switch outputs
[NordPool SE3] Settings: OUT0=6 h, OUT1=3 h
[NordPool SE3] Fetching compact SE3 prices for 2026-08-12
[NordPool SE3] Accepted compact plan for 2026-08-12 (96 quarters)
```

The date and output count may differ. If the current interval is not selected, both relays correctly remain off.

## 4. Check Components

Open **Components → Nord Pool SE3**. A two-output device should show:

- **OUT0 cheap hours**, initially 6
- **OUT1 cheap hours**, initially 3
- **Run today**
- **Now**
- **Next**

A one-output device omits OUT1. It never sends commands to a nonexistent second output.

Open **Scripts** and confirm:

- `NordPool SE3` is running and auto-start is enabled;
- `NordPool SE3 monitor` is running and its own auto-start is disabled;
- there is no active `NordPool SE3 fetcher`.

The monitor can stop for a moment during a price download and then start again automatically.

## 5. Choose daily run time

Change the hour settings under **Components → Nord Pool SE3**:

- `6.00` selects the 24 cheapest quarter-hours;
- `3.00` selects the 12 cheapest quarter-hours;
- `0.25` selects one cheapest quarter-hour;
- `0.00` disables the output.

Intervals do not need to be consecutive. A settings change safely turns outputs off until the replacement plan has been calculated.

## If something does not work

### The group does not appear

Open the controller console. Confirm correct time/timezone and that controller is script 1. A conflict with virtual component IDs 250–252 stops installation safely.

### Run today, Now and Next do not appear

Confirm that the monitor was created as script 2 and contains the current complete file. Start only the controller; it starts the monitor.

### Gen4 says `Script ran out of memory`

Verify that only the current controller and monitor are installed. The controller's first configuration lines must contain `feedBase` with `raw.githubusercontent.com`. An old controller that references Nord Pool's large API directly, or an old fetcher script, is not the current version.

### Outputs stay off

OFF is the safe state. Check device time, internet, hour settings and both script consoles. The controller retries a missing price file every five minutes.

### The device is in safe mode

Scripts do not auto-start in Shelly safe mode. Reboot once from **Settings → Reboot**, then start the controller manually and inspect its console.

### Scripts have different IDs

On a clean device, delete only these automation scripts and recreate controller first, monitor second. Advanced users may instead change `monitorScriptId` in the controller and `controllerScriptId` in the monitor.

## Electrical safety

Test without connected loads. Verify the exact Shelly model's channel, total-power and inrush limits before connecting equipment. Use suitable contactors when required. Mains wiring should be performed by a qualified person.

For technical behavior, fail-safe details and removal instructions, see [README.md](README.md).
