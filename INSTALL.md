# Easy installation guide

This guide installs the Nord Pool SE3 controller on a clean one- or two-output Shelly Gen3. You do not need programming experience. The first script detects and controls the available outputs. The second script adds the status fields and safety watchdog.

## Before you start

You need:

- a one- or two-output Shelly Gen3 connected to Wi-Fi and the internet;
- its local web address, for example `http://192.168.1.100`;
- current Shelly firmware;
- the Shelly timezone set to Finnish/Aland time, for example `Europe/Helsinki`;
- no load connected while doing the first test.

The clean installation below expects the controller to become script 1 and the monitor to become script 2. Create them in exactly this order.

## 1. Install the controller

1. Open the Shelly web address in a browser.
2. Select **Scripts** in the left menu.
3. Select **Create script**.
4. Enter the name `NordPool SE3`.
5. In GitHub, open [`shelly-nordpool-se3.js`](shelly-nordpool-se3.js).
6. Select **Raw**, select all the text and copy it.
7. Paste the copied text into the empty Shelly script editor. Replace any example text already in the editor.
8. Select **Save**.
9. Enable the script's **Run on startup** or **Auto start** option.
10. Select **Start**.

Wait up to one minute. Do not create the second script until the first one has been saved as script 1.

## 2. Check the controller

1. Open **Components** in the Shelly menu.
2. Look for the **Nord Pool SE3** group.
3. Confirm that the group contains **OUT0 cheap hours**, initially `6`.
4. On a two-output device, also confirm that it contains **OUT1 cheap hours**, initially `3`. A one-output device intentionally does not show OUT1.
5. Return to **Scripts**, open `NordPool SE3` and check its console.

A successful first download contains a line similar to:

```text
[NordPool SE3] Plan 2026-08-08: 96 intervals, OUT0=24, OUT1=12, prices=... EUR/MWh
```

The date and prices will be different. A one-output device shows only `OUT0=24`. A normal day has 96 intervals. Daylight-saving transition days can have 92 or 100.

## 3. Install the status monitor

1. Return to **Scripts** and select **Create script** again.
2. Enter the name `NordPool SE3 monitor`.
3. In GitHub, open [`shelly-nordpool-se3-monitor.js`](shelly-nordpool-se3-monitor.js).
4. Select **Raw**, select all the text and copy it.
5. Paste the copied text into the Shelly editor and select **Save**.
6. Leave this script's own **Run on startup** or **Auto start** option disabled.
7. Select **Start** once.

The controller will start and stop the monitor automatically. Its own auto-start must stay disabled because both scripts share a small memory pool during Nord Pool downloads.

## 4. Check the complete installation

Open **Components -> Nord Pool SE3**. A two-output device contains five items; a one-output device contains four because OUT1 is omitted:

- **OUT0 cheap hours**;
- **OUT1 cheap hours**, only on a two-output device;
- **Run today** - completed scheduled cheap periods today;
- **Now** - planned and actual relay states;
- **Next** - the next planned state change for each output.

Open **Scripts** and confirm:

- `NordPool SE3` is running and auto-start is enabled;
- `NordPool SE3 monitor` is running and its own auto-start is disabled.

It is normal for the monitor to stop briefly while prices are downloaded.

## 5. Choose the daily run time

Open **Components -> Nord Pool SE3** and change either hour setting.

- `6.00` means the 24 cheapest quarter-hours.
- `3.00` means the 12 cheapest quarter-hours.
- `0.25` means the single cheapest quarter-hour.
- `0.00` disables that output.

The intervals do not need to be consecutive. After a setting changes, all available outputs stay safely off until a complete replacement price plan has been downloaded.

## If something does not work

### The Nord Pool SE3 group does not appear

Open the controller console and look for an error. Check that the device has internet access, correct local time and the correct timezone. Also confirm that the controller is script 1.

### Run today, Now and Next do not appear

Confirm that the monitor was created second as script 2, saved and started once. Its own auto-start should remain disabled.

### The output or outputs stay off

This is the safe state. The usual causes are missing device time, no complete price response yet or all available hour settings being zero. The controller retries a missing price plan every five minutes.

### The device starts in safe mode

Reboot it once from **Settings -> Reboot** after confirming that the readable scripts were copied completely. In Shelly safe mode, scripts do not start automatically.

### The scripts received different ID numbers

The easiest clean-device fix is to delete only these two scripts, wait for the Shelly to return if it reboots, and create the controller first and the monitor second. Advanced users can instead change `monitorScriptId` in the controller and `controllerScriptId` in the monitor.

## Electrical safety

The first test should be performed without connected loads. Before connecting heating equipment, verify the exact Shelly model's per-channel current and power limits. Use correctly rated contactors for loads that exceed the relay limits, have high inrush current or require electrical isolation. Mains wiring should be performed by a qualified person.

For detailed behavior, troubleshooting and safe removal instructions, see [`README.md`](README.md).
