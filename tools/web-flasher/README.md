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

The flash is destructive to the S3's entire flash, including saved settings.
The second ESP32 chip is not changed. Its optional companion firmware and
microSD preloading are not part of this browser workflow. Use
`tools/install-setup.sh` for the full provisioning workflow; that script
currently requires Linux and ESP-IDF 5.5.x.

The flasher is intentionally limited to the published setup bundle and its
known addresses; it does not accept arbitrary binaries or guess flash offsets.
The release manifest is fetched live, so the page follows future setup
releases without a code change.

## Checks

```sh
npm test
npm run build
```

Web Serial is supported by desktop Chromium browsers, not Safari or Firefox.