import { ESPLoader } from "esptool-js";
import { createCustomFlashPlan, loadVerifiedFlashPlan } from "./flash-plan.js";
import { inspectCompanionChip, loadVerifiedCompanionFlashPlan } from "./companion-plan.js";
import { SafeTransport } from "./safe-transport.js";
import "./style.css";

const button = document.querySelector("#flash-button");
const consent = document.querySelector("#erase-consent");
const customButton = document.querySelector("#custom-flash-button");
const customConsent = document.querySelector("#custom-erase-consent");
const customConsentCopy = document.querySelector("#custom-consent-copy");
const customImageKind = document.querySelector("#custom-image-kind");
const customBinFile = document.querySelector("#custom-bin-file");
const customBinName = document.querySelector("#custom-bin-name");
const customImageHint = document.querySelector("#custom-image-hint");
const customStatus = document.querySelector("#custom-status");
const customProgressFill = document.querySelector("#custom-progress-fill");
const customProgressLabel = document.querySelector("#custom-progress-label");
const customLog = document.querySelector("#custom-log");
const companionButton = document.querySelector("#companion-flash-button");
const companionConsent = document.querySelector("#companion-consent");
const companionRelease = document.querySelector("#companion-release");
const companionStatus = document.querySelector("#companion-status");
const companionProgressFill = document.querySelector("#companion-progress-fill");
const companionProgressLabel = document.querySelector("#companion-progress-label");
const companionLog = document.querySelector("#companion-log");
const status = document.querySelector("#status");
const releaseVersion = document.querySelector("#release-version");
const progressFill = document.querySelector("#progress-fill");
const progressLabel = document.querySelector("#progress-label");
const log = document.querySelector("#log");
let busy = false;

function setStatus(message, kind = "", target = status) {
  target.textContent = message;
  target.dataset.kind = kind;
}

function appendLog(message, target = log) {
  const lines = [...target.textContent.split("\n"), String(message)];
  target.textContent = lines.slice(-240).join("\n");
  target.scrollTop = target.scrollHeight;
}

function setProgress(percent, fill = progressFill, label = progressLabel) {
  const bounded = Math.max(0, Math.min(100, percent));
  fill.style.width = `${bounded}%`;
  label.textContent = `${Math.round(bounded)}%`;
}

function updateButton() {
  const serialAvailable = "serial" in navigator;
  button.disabled = busy || !consent.checked || !("serial" in navigator);
  customButton.disabled = busy || !customConsent.checked || !customBinFile.files?.length || !serialAvailable;
  companionButton.disabled = busy || !companionConsent.checked || !serialAvailable;
}

function updateCustomImageDetails() {
  const fullImage = customImageKind.value === "full";
  const file = customBinFile.files?.[0];
  customConsent.checked = false;
  customBinName.textContent = file ? `${file.name} · ${file.size.toLocaleString()} bytes` : "No BIN selected.";
  customImageHint.textContent = fullImage
    ? "Choose an ESP-IDF merged image containing bootloader, partition table, and app at their standard offsets. This erases all 16 MiB and replaces the complete flash layout."
    : "Application images must fit the 3 MiB OTA partition. This writes slot 0 only at 0x20000; the bootloader, partition table, and other slot are untouched."
  customConsentCopy.textContent = fullImage
    ? "I understand this erases and replaces the entire S3 flash."
    : "I understand this writes application slot 0 at 0x20000.";
  updateButton();
}

consent.addEventListener("change", updateButton);
customConsent.addEventListener("change", updateButton);
customImageKind.addEventListener("change", updateCustomImageDetails);
customBinFile.addEventListener("change", updateCustomImageDetails);

if (!("serial" in navigator)) {
  setStatus("Web Serial is unavailable. Use desktop Chrome or Edge over HTTPS or localhost.", "error");
  appendLog("This browser does not expose navigator.serial.");
}

async function flashPlan(plan, confirmation, successMessage, ui = {}) {
  let port;
  let transport;
  let loader;
  let chipDetected = false;
  let resetDone = false;
  const reportStatus = (message, kind = "") => setStatus(message, kind, ui.status ?? status);
  const reportLog = (message) => appendLog(message, ui.log ?? log);
  const reportProgress = (percent) => setProgress(percent, ui.progressFill ?? progressFill, ui.progressLabel ?? progressLabel);

  try {
    if (!window.isSecureContext) throw new Error("Open this page over HTTPS or localhost to use USB serial.");

    reportStatus("Choose the knob's ESP32-S3 USB port.");
    reportLog("Requesting access to Espressif USB JTAG/serial (303A:1001)…");
    port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }] });

    transport = new SafeTransport(port);
    loader = new ESPLoader({
      transport,
      baudrate: 460800,
      debugLogging: false,
      terminal: { clean() {}, writeLine: reportLog, write: reportLog },
    });

    reportStatus("Connecting to the knob and checking its chip.");
    const chipName = await loader.main();
    chipDetected = true;
    reportLog(`Detected ${chipName}.`);
    if (!chipName.includes("ESP32-S3")) throw new Error(`Expected ESP32-S3, found ${chipName}. Check the USB-C plug orientation.`);

    const accepted = window.confirm(confirmation);
    if (!accepted) {
      reportStatus("Flash cancelled. No write was started.");
      reportLog("Cancelled before writing.");
      return;
    }

    const totalBytes = plan.files.reduce((sum, file) => sum + file.data.length, 0);
    const priorBytes = (fileIndex) => plan.files.slice(0, fileIndex).reduce((sum, file) => sum + file.data.length, 0);
    reportStatus(plan.eraseAll
      ? "Erasing and flashing the full S3 image. Keep the cable connected."
      : "Writing the application image. Keep the cable connected.");
    reportLog(plan.eraseAll ? "Beginning full S3 flash erase and write…" : "Beginning app-slot write…");

    await loader.writeFlash({
      fileArray: plan.files.map(({ data, address }) => ({ data, address })),
      flashMode: "dio",
      flashFreq: "80m",
      flashSize: "keep",
      eraseAll: plan.eraseAll ?? true,
      compress: true,
      reportProgress: (fileIndex, written, fileTotal) => {
        const currentBytes = fileTotal > 0 ? (written / fileTotal) * plan.files[fileIndex].data.length : 0;
        reportProgress(((priorBytes(fileIndex) + currentBytes) / totalBytes) * 100);
      },
    });

    reportLog("Flash write completed.");
    await loader.after("hard_reset");
    resetDone = true;
    reportProgress(100);
    reportStatus(successMessage, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportStatus(message, "error");
    reportLog(`ERROR: ${message}`);
  } finally {
    if (loader && chipDetected && !resetDone) {
      try {
        await loader.after("hard_reset");
      } catch {
        // Keep the original flash result visible if resetting fails.
      }
    }
    if (transport) {
      try {
        await transport.disconnect();
      } catch {
        // The port may already have closed after a failed connection.
      }
    }
    busy = false;
    updateButton();
  }
}

button.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  updateButton();
  setProgress(0, customProgressFill, customProgressLabel);
  customStatus.dataset.kind = "";
  customStatus.textContent = "Reading your custom BIN locally.";
  customLog.textContent = "Ready.";
  releaseVersion.textContent = "Checking release…";

  try {
    if (!window.crypto?.subtle) throw new Error("Secure Web Crypto is unavailable; open this page over HTTPS or localhost.");
    setStatus("Downloading and verifying the official setup files.");
    appendLog("Fetching release manifests and firmware from Guru-RF/VFO-Knob…");
    const plan = await loadVerifiedFlashPlan();
    releaseVersion.textContent = plan.version;
    for (const file of plan.files) appendLog(`Verified ${file.name} · ${file.size.toLocaleString()} bytes · SHA-256 OK`);
    await flashPlan(
      plan,
      `Install VFO-Knob setup firmware ${plan.version}?\n\nThis erases the ESP32-S3's entire flash, including existing firmware and settings. The companion chip is not changed.`,
      "Setup firmware installed. Use your phone to join VFOKnob and select Wi-Fi.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, "error");
    appendLog(`ERROR: ${message}`);
  } finally {
    busy = false;
    updateButton();
  }
});

customButton.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  updateButton();
  setProgress(0, customProgressFill, customProgressLabel);
  customStatus.textContent = "Reading your custom BIN locally.";
  customStatus.dataset.kind = "";
  customLog.textContent = "Ready.";

  try {
    const file = customBinFile.files?.[0];
    if (!file) throw new Error("Choose a custom .bin file first.");
    const data = new Uint8Array(await file.arrayBuffer());
    const plan = createCustomFlashPlan(file.name, data, customImageKind.value);
    appendLog(`Loaded ${file.name} · ${data.length.toLocaleString()} bytes · not release-verified`, customLog);

    const confirmation = plan.eraseAll
      ? `Flash full image ${file.name}?\n\nThis erases all ESP32-S3 flash, including firmware, settings, and files, and replaces the bootloader and partition table. Only continue with a merged image for this exact board. The companion chip is not changed.`
      : `Flash application image ${file.name} at 0x20000?\n\nThis does not erase the full chip or update the bootloader, partition table, OTA selection, or signing trust. It may not boot if the current slot or signing key does not match. The companion chip is not changed.`;
    const successMessage = plan.eraseAll
      ? "Custom full image installed. The knob has restarted."
      : "Custom application image written. The knob has restarted if this slot is selected and trusted.";
    await flashPlan(plan, confirmation, successMessage, {
      status: customStatus,
      log: customLog,
      progressFill: customProgressFill,
      progressLabel: customProgressLabel,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, "error", customStatus);
    appendLog(`ERROR: ${message}`, customLog);
  } finally {
    busy = false;
    updateButton();
  }
});

companionConsent.addEventListener("change", () => {
  updateButton();
  setStatus(
    companionConsent.checked
      ? "Ready. Connect the second chip in CH340 orientation, then start the installer."
      : "Check the box above to enable the installer.",
    "",
    companionStatus,
  );
});

companionButton.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  updateButton();
  setProgress(0, companionProgressFill, companionProgressLabel);
  companionRelease.textContent = "Checking release…";
  companionLog.textContent = "Ready.";

  let transport;
  let loader;
  let chipDetected = false;
  let resetDone = false;
  let phase = "selecting the serial port";

  try {
    if (!window.isSecureContext) throw new Error("Open this page over HTTPS or localhost to use USB serial.");
    if (!window.crypto?.subtle) throw new Error("Secure Web Crypto is unavailable; open this page over HTTPS or localhost.");

    phase = "selecting the serial port";
    setStatus("Choose the knob's CH340 serial port with the USB-C plug flipped to the second chip.", "", companionStatus);
    appendLog("Requesting access to a serial port; the detected chip must match the knob's companion.", companionLog);
    const port = await navigator.serial.requestPort();

    phase = "loading the release";
    setStatus("Downloading and verifying the official companion files.", "", companionStatus);
    appendLog("Fetching companion firmware and provisioning manifests…", companionLog);
    const plan = await loadVerifiedCompanionFlashPlan();
    companionRelease.textContent = plan.version;
    for (const file of plan.files) appendLog(`Verified ${file.name} · ${file.size.toLocaleString()} bytes · SHA-256 OK`, companionLog);

    transport = new SafeTransport(port);
    loader = new ESPLoader({
      transport,
      baudrate: 460800,
      debugLogging: false,
      terminal: { clean() {}, writeLine: (line) => appendLog(line, companionLog), write: (line) => appendLog(line, companionLog) },
    });

    phase = "connecting to the second ESP32";
    setStatus("Connecting to the second ESP32 and checking its package and revision.", "", companionStatus);
    const chipName = await loader.main();
    chipDetected = true;
    const chip = loader.chip;
    if (chip.CHIP_NAME !== "ESP32" || typeof chip.getChipDescription !== "function" || typeof chip.getChipRevision !== "function") {
      throw new Error(`Expected the knob's ESP32 companion, found ${chipName}. Check the USB-C plug orientation.`);
    }
    const { description, revision } = await inspectCompanionChip(chip, loader);
    appendLog(`Detected ${description}, revision ${revision}.`, companionLog);
    phase = "checking the companion chip";
    if (!description.includes("ESP32-U4WDH")) throw new Error(`Expected ESP32-U4WDH, found ${description}. Nothing was written.`);
    if (revision < 3) throw new Error(`ESP32 revision ${revision} is too old for signed updates. Nothing was written.`);

    const accepted = window.confirm(
      `Install Bluetooth companion firmware ${plan.version}?\n\nThis writes the second ESP32's bootloader, partition table, OTA data, and firmware. It does not erase the chip's NVS settings or change the ESP32-S3. Continue only if the detected chip is the knob's second chip.`,
    );
    if (!accepted) {
      setStatus("Install cancelled. No write was started.", "", companionStatus);
      appendLog("Cancelled before writing.", companionLog);
      return;
    }

    setStatus("Writing the companion firmware. Keep the cable connected.", "", companionStatus);
    phase = "writing the companion flash";
    appendLog("Beginning second-chip provisioning; existing NVS is preserved…", companionLog);
    const totalBytes = plan.files.reduce((sum, file) => sum + file.data.length, 0);
    const priorBytes = (fileIndex) => plan.files.slice(0, fileIndex).reduce((sum, file) => sum + file.data.length, 0);
    await loader.writeFlash({
      fileArray: plan.files.map(({ data, address }) => ({ data, address })),
      flashMode: plan.flashMode,
      flashFreq: plan.flashFreq,
      flashSize: plan.flashSize,
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, fileTotal) => {
        const currentBytes = fileTotal > 0 ? (written / fileTotal) * plan.files[fileIndex].data.length : 0;
        setProgress(((priorBytes(fileIndex) + currentBytes) / totalBytes) * 100, companionProgressFill, companionProgressLabel);
      },
    });

    appendLog("Companion flash write completed.", companionLog);
    phase = "restarting the companion chip";
    await loader.after("hard_reset");
    resetDone = true;
    setProgress(100, companionProgressFill, companionProgressLabel);
    setStatus("Bluetooth firmware installed. Reboot the knob to start the companion.", "success", companionStatus);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Failed while ${phase}: ${message}`, "error", companionStatus);
    appendLog(error instanceof Error && error.stack ? error.stack : `ERROR: ${message}`, companionLog);
  } finally {
    if (loader && chipDetected && !resetDone) {
      try {
        await loader.after("hard_reset");
      } catch {
        // Keep the original flash result visible if resetting fails.
      }
    }
    if (transport) {
      try {
        await transport.disconnect();
      } catch {
        // The port may already have closed after a failed connection.
      }
    }
    busy = false;
    updateButton();
  }
});

updateCustomImageDetails();
updateButton();