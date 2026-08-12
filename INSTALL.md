# Easy installation guide

This guide installs the Nord Pool SE3 controller on a clean one- or two-output Shelly Gen3 or Gen4. You do not need programming experience. Three readable scripts are used: the controller, the status/watchdog monitor and a small price fetcher.

## Before you start

You need:

- a one- or two-output Shelly Gen3 or Gen4 connected to Wi-Fi and the internet;
- its local web address, for example `http://192.168.1.100`;
- current Shelly firmware;
- the Shelly timezone set to Finnish/Aland time, for example `Europe/Helsinki`;
- no load connected while doing the first test.

The clean installation expects the controller to become script 1, the monitor script 2 and the fetcher script 3. Create them in exactly this order. Do not start the controller until all three have been saved.

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
10. Save it, but do not select **Start** yet.

Do not start it yet. Create the next two scripts first.

## 2. Install the status monitor

1. Return to **Scripts** and select **Create script** again.
2. Enter the name `NordPool SE3 monitor`.
3. In GitHub, open [`shelly-nordpool-se3-monitor.js`](shelly-nordpool-se3-monitor.js).
4. Select **Raw**, select all the text and copy it.
5. Paste the copied text into the Shelly editor and select **Save**.
6. Leave this script's own **Run on startup** or **Auto start** option disabled.
7. Do not start it manually.

## 3. Install the price fetcher

1. Select **Create script** once more.
2. Enter the name `NordPool SE3 fetcher`.
3. In GitHub, open [`shelly-nordpool-se3-fetcher.js`](shelly-nordpool-se3-fetcher.js).
4. Select **Raw**, select all the text and copy it.
5. Paste it into the Shelly editor and select **Save**.
6. Leave its **Run on startup** or **Auto start** option disabled.
7. Do not start it manually.

The fetcher is intentionally separate because Shelly gives scripts a small shared JavaScript memory pool even on Gen4 devices. The controller starts the fetcher only while downloading prices and the fetcher stops itself afterwards.

## 4. Start and check the controller

1. Open the `NordPool SE3` controller script.
2. Select **Start**.
3. Wait up to one minute for the first price download.

Then open **Components**, look for the **Nord Pool SE3** group and confirm that it contains **OUT0 cheap hours**, initially `6`. On a two-output device it also contains **OUT1 cheap hours**, initially `3`.

A successful first download appears in the fetcher console as a line similar to:

```text
[NordPool fetcher] Plan ready: 2026-08-08, 96 slots
```

The date will be different. A one-output device shows only `OUT0=24`. A local day contains 92, 96 or 100 intervals depending on daylight saving time.

## 5. Check the complete installation

Open **Components -> Nord Pool SE3**. A two-output device contains five items; a one-output device contains four because OUT1 is omitted:

- **OUT0 cheap hours**;
- **OUT1 cheap hours**, only on a two-output device;
- **Run today** - completed scheduled cheap periods today;
- **Now** - planned and actual relay states;
- **Next** - the next planned state change for each output.

Open **Scripts** and confirm:

- `NordPool SE3` is running and auto-start is enabled;
- `NordPool SE3 monitor` is running and its own auto-start is disabled;
- `NordPool SE3 fetcher` is normally stopped and its own auto-start is disabled.

It is normal for the controller and monitor to stop briefly while the fetcher downloads prices. They start again automatically.

## 6. Choose the daily run time

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

Confirm that the monitor was created second as script 2 and the fetcher third as script 3. Their own auto-start options should remain disabled. Start only the controller.

### The output or outputs stay off

This is the safe state. The usual causes are missing device time, no complete price response yet or all available hour settings being zero. The controller retries a missing price plan every five minutes.

### The device starts in safe mode

Reboot it once from **Settings -> Reboot** after confirming that the readable scripts were copied completely. In Shelly safe mode, scripts do not start automatically.

### The scripts received different ID numbers

The easiest clean-device fix is to delete only these three scripts, wait for the Shelly to return if it reboots, and recreate them in controller-monitor-fetcher order. Advanced users can instead update the script IDs in each `CONFIG` object.

## Electrical safety

The first test should be performed without connected loads. Before connecting heating equipment, verify the exact Shelly model's per-channel current and power limits. Use correctly rated contactors for loads that exceed the relay limits, have high inrush current or require electrical isolation. Mains wiring should be performed by a qualified person.

For detailed behavior, troubleshooting and safe removal instructions, see [`README.md`](README.md).
