import { ESPLoader, Transport } from "esptool-js";
import { loadVerifiedFlashPlan } from "./flash-plan.js";
import "./style.css";

const button = document.querySelector("#flash-button");
const consent = document.querySelector("#erase-consent");
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
  button.disabled = busy || !consent.checked || !("serial" in navigator);
}

consent.addEventListener("change", updateButton);

if (!("serial" in navigator)) {
  setStatus("Web Serial is unavailable. Use desktop Chrome or Edge over HTTPS or localhost.", "error");
  appendLog("This browser does not expose navigator.serial.");
}

button.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  updateButton();
  setProgress(0);
  releaseVersion.textContent = "Checking release…";

  let port;
  let transport;
  let loader;
  let chipDetected = false;
  let resetDone = false;

  try {
    if (!window.isSecureContext) throw new Error("Open this page over HTTPS or localhost to use USB serial.");
    if (!window.crypto?.subtle) throw new Error("Secure Web Crypto is unavailable; open this page over HTTPS or localhost.");

    setStatus("Choose the knob's ESP32-S3 USB port.");
    appendLog("Requesting access to Espressif USB JTAG/serial (303A:1001)…");
    port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }] });

    setStatus("Downloading and verifying the official setup files.");
    appendLog("Fetching release manifests and firmware from Guru-RF/VFO-Knob…");
    const plan = await loadVerifiedFlashPlan();
    releaseVersion.textContent = plan.version;
    for (const file of plan.files) appendLog(`Verified ${file.name} · ${file.size.toLocaleString()} bytes · SHA-256 OK`);

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

    const accepted = window.confirm(
      `Install VFO-Knob setup firmware ${plan.version}?\n\nThis erases the ESP32-S3's entire flash, including existing firmware and settings. The companion chip is not changed.`,
    );
    if (!accepted) {
      setStatus("Flash cancelled. The knob was not erased.");
      appendLog("Cancelled before erase.");
      return;
    }

    const totalBytes = plan.files.reduce((sum, file) => sum + file.data.length, 0);
    const priorBytes = (fileIndex) => plan.files.slice(0, fileIndex).reduce((sum, file) => sum + file.data.length, 0);
    setStatus("Erasing and flashing the setup firmware. Keep the cable connected.");
    appendLog("Beginning full S3 flash erase and write…");

    await loader.writeFlash({
      fileArray: plan.files.map(({ data, address }) => ({ data, address })),
      flashMode: "dio",
      flashFreq: "80m",
      flashSize: "keep",
      eraseAll: true,
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
    setStatus("Setup firmware installed. Use your phone to join VFOKnob and select Wi-Fi.", "success");
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
});

updateButton();