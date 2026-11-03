# VFO-Knob Browser Flasher

This static web app installs the latest published **setup firmware** on the
ESP32-S3 in a Waveshare ESP32-S3-Knob-Touch-LCD-1.8. It uses Espressif's
`esptool-js` over the Web Serial API, so end users need desktop Chrome or Edge,
not Linux, Python esptool, or ESP-IDF.

## Run locally

Install Node.js 18 or newer, then from this directory:

```sh
npm install
npm run dev
```

Open the localhost URL printed by Vite in desktop Chrome or Edge. Web Serial
is available only in a secure context: HTTPS or localhost.

## GitHub Pages

The repository workflow publishes only `tools/web-flasher/dist` as the
project's Pages site. In the VFO-Knob fork, set **Settings → Pages → Build and
deployment → Source** to **GitHub Actions** once. The deploy workflow then
updates `https://mrjoshmurray.github.io/VFO-Knob/` when the flasher changes.
This is a project site in its own repository; it does not replace a user or
organization Pages site hosted from another repository.

## Install on the knob

1. Connect the knob with a USB data cable and use the plug orientation that
   reaches the ESP32-S3 USB JTAG/serial port (VID:PID `303A:1001`). If Windows
   shows `USB-SERIAL CH340 (COM*)`, flip the plug: that orientation reaches the
   companion chip, not the S3.
2. If the knob is already running VFO-Knob over USB, its S3 serial port is
   available for about six seconds at boot before USB networking takes over.
   Hold a finger on the display through startup to keep the serial port
   available; otherwise Windows may show a network adapter instead of a COM
   port.
3. Check the erase acknowledgement, choose **Connect and flash**, and select
   the Espressif USB JTAG/serial port in Chrome's picker.
4. Confirm the final erase prompt. The page downloads the setup release and
   its provisioning bundle from the public `firmware` branch, checks file
   sizes and SHA-256 digests, verifies the detected chip is an ESP32-S3, then
   erases and writes the bootloader, partition table, SD-card setup marker,
   and setup app at the offsets from the release manifest.
5. After the knob restarts, join its `VFOKnob` Wi-Fi network from a phone,
   configure Wi-Fi, and choose the desired radio firmware on the knob.

The setup flash is destructive to the S3's entire flash, including saved
settings. It does not change the second ESP32 chip.

## Install Bluetooth firmware

The **Install Bluetooth firmware** section provisions the second ESP32 over
its CH340 USB serial port. Flip the USB-C plug to reach that chip, acknowledge
the write, and choose its port in Chrome's picker. The page checks the chip is
an ESP32-U4WDH at revision 3 or later before writing. It fetches the published
companion image and bench files from the public `firmware` branch, verifies
each file against its SHA-256 manifest, then writes the bootloader, partition
table, OTA data and app at their published offsets. It does not erase the
whole chip or touch NVS, so saved Bluetooth pairings are preserved; the S3 is
untouched. Windows may need the CH340 driver.

This browser flow installs the latest official companion release. Developers
can still use `tools/install-setup.sh --second-chip` or the companion's
development update API; those workflows require ESP-IDF 5.5.x.

## Custom BIN testing

The **Test a custom BIN** section accepts a local `.bin` file. It is read by
the browser and is not uploaded to a server. Custom images are not checked
against a release manifest or authenticated by the page.

- **Application BIN** writes to the first OTA app slot at `0x20000` without a
   full-chip erase. It leaves the bootloader, partition table and other OTA slot
   untouched. It may not boot if the active OTA slot or signing key does not
   match.
- **Merged full-flash BIN** writes at `0x0` after erasing all 16 MiB. Use an
   ESP-IDF merged image containing the ESP32-S3 bootloader, partition table and
   application at their standard offsets. This replaces settings and the
   bootloader's signing trust; use only for development or recovery images for
   this exact board.

For USB-tethered Thetis, set **TCI Server Bind IP:Port** in Thetis Setup to
`10.55.42.2:50001` and enable **TCI Server Running**. The first Thetis knob
image is receive-only until disconnect-triggered unkey behavior is proven.

The official setup flow remains limited to the published bundle and known
offsets. Its manifests are fetched live, so it follows future setup releases
without a code change.

## Checks

```sh
npm test
npm run build
```

Web Serial is supported by desktop Chromium browsers, not Safari or Firefox.