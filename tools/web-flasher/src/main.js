import { ESPLoader, Transport } from "esptool-js";
import { createCustomFlashPlan, loadVerifiedFlashPlan } from "./flash-plan.js";
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
const status = document.querySelector("#status");
const releaseVersion = document.querySelector("#release-version");
const progressFill = document.querySelector("#progress-fill");
const progressLabel = document.querySelector("#progress-label");
const log = document.querySelector("#log");
let busy = false;

function setStatus(message, kind = "") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function appendLog(message) {
  const lines = [...log.textContent.split("\n"), String(message)];
  log.textContent = lines.slice(-240).join("\n");
  log.scrollTop = log.scrollHeight;
}

function setProgress(percent) {
  const bounded = Math.max(0, Math.min(100, percent));
  progressFill.style.width = `${bounded}%`;
  progressLabel.textContent = `${Math.round(bounded)}%`;
}

function updateButton() {
  const serialAvailable = "serial" in navigator;
  button.disabled = busy || !consent.checked || !("serial" in navigator);
  customButton.disabled = busy || !customConsent.checked || !customBinFile.files?.length || !serialAvailable;
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

async function flashPlan(plan, confirmation, successMessage) {
  let port;
  let transport;
  let loader;
  let chipDetected = false;
  let resetDone = false;

  try {
    if (!window.isSecureContext) throw new Error("Open this page over HTTPS or localhost to use USB serial.");

    setStatus("Choose the knob's ESP32-S3 USB port.");
    appendLog("Requesting access to Espressif USB JTAG/serial (303A:1001)…");
    port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }] });

    transport = new Transport(port);
    loader = new ESPLoader({
      transport,
      baudrate: 460800,
      debugLogging: false,
      terminal: { clean() {}, writeLine: appendLog, write: (line) => appendLog(line) },
    });

    setStatus("Connecting to the knob and checking its chip.");
    const chipName = await loader.main();
    chipDetected = true;
    appendLog(`Detected ${chipName}.`);
    if (!chipName.includes("ESP32-S3")) throw new Error(`Expected ESP32-S3, found ${chipName}. Check the USB-C plug orientation.`);

    const accepted = window.confirm(confirmation);
    if (!accepted) {
      setStatus("Flash cancelled. No write was started.");
      appendLog("Cancelled before writing.");
      return;
    }

    const totalBytes = plan.files.reduce((sum, file) => sum + file.data.length, 0);
    const priorBytes = (fileIndex) => plan.files.slice(0, fileIndex).reduce((sum, file) => sum + file.data.length, 0);
    setStatus(plan.eraseAll
      ? "Erasing and flashing the full S3 image. Keep the cable connected."
      : "Writing the application image. Keep the cable connected.");
    appendLog(plan.eraseAll ? "Beginning full S3 flash erase and write…" : "Beginning app-slot write…");

    await loader.writeFlash({
      fileArray: plan.files.map(({ data, address }) => ({ data, address })),
      flashMode: "dio",
      flashFreq: "80m",
      flashSize: "keep",
      eraseAll: plan.eraseAll ?? true,
      compress: true,
      reportProgress: (fileIndex, written, fileTotal) => {
        const currentBytes = fileTotal > 0 ? (written / fileTotal) * plan.files[fileIndex].data.length : 0;
        setProgress(((priorBytes(fileIndex) + currentBytes) / totalBytes) * 100);
      },
    });

    appendLog("Flash write completed.");
    await loader.after("hard_reset");
    resetDone = true;
    setProgress(100);
    setStatus(successMessage, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, "error");
    appendLog(`ERROR: ${message}`);
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
  setProgress(0);
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
  setProgress(0);

  try {
    const file = customBinFile.files?.[0];
    if (!file) throw new Error("Choose a custom .bin file first.");
    setStatus("Reading your custom BIN locally.");
    const data = new Uint8Array(await file.arrayBuffer());
    const plan = createCustomFlashPlan(file.name, data, customImageKind.value);
    releaseVersion.textContent = `Custom · ${file.name}`;
    appendLog(`Loaded ${file.name} · ${data.length.toLocaleString()} bytes · not release-verified`);

    const confirmation = plan.eraseAll
      ? `Flash full image ${file.name}?\n\nThis erases all ESP32-S3 flash, including firmware, settings, and files, and replaces the bootloader and partition table. Only continue with a merged image for this exact board. The companion chip is not changed.`
      : `Flash application image ${file.name} at 0x20000?\n\nThis does not erase the full chip or update the bootloader, partition table, OTA selection, or signing trust. It may not boot if the current slot or signing key does not match. The companion chip is not changed.`;
    const successMessage = plan.eraseAll
      ? "Custom full image installed. The knob has restarted."
      : "Custom application image written. The knob has restarted if this slot is selected and trusted.";
    await flashPlan(plan, confirmation, successMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, "error");
    appendLog(`ERROR: ${message}`);
  } finally {
    busy = false;
    updateButton();
  }
});

updateCustomImageDetails();
updateButton();