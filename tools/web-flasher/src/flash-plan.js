const RELEASE_ROOT = "https://raw.githubusercontent.com/Guru-RF/VFO-Knob/firmware/firmware/setup";

const REQUIRED_BENCH_FILES = [
  ["bootloader.bin", 0x0],
  ["partition-table.bin", 0x8000],
  ["sdwipe.bin", 0x9000],
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function parseOffset(value, label) {
  requireCondition(typeof value === "string" && /^0x[\da-f]+$/i.test(value), `${label} has an invalid flash offset.`);
  return Number.parseInt(value, 16);
}

function validateFile(file, label) {
  requireCondition(file && Number.isSafeInteger(file.size) && file.size > 0, `${label} has an invalid size.`);
  requireCondition(typeof file.sha256 === "string" && /^[\da-f]{64}$/i.test(file.sha256), `${label} has an invalid SHA-256 value.`);
}

export function createFlashPlan(setupManifest, benchManifest) {
  requireCondition(setupManifest?.project === "vfo-knob-setup", "The setup manifest is for another project.");
  requireCondition(/^\d+\.\d+\.\d+$/.test(setupManifest.version), "The setup manifest has an invalid version.");
  requireCondition(typeof setupManifest.file === "string" && /^vfo-knob-setup-[\w.-]+\.bin$/.test(setupManifest.file), "The setup manifest has an invalid image filename.");
  validateFile(setupManifest, "The setup image");

  requireCondition(benchManifest?.project === "vfo-knob-setup" && benchManifest.chip === "esp32s3", "The provisioning manifest is not for the ESP32-S3 setup firmware.");
  requireCondition(benchManifest.release === setupManifest.version, "The setup image and provisioning bundle are from different releases.");
  requireCondition(benchManifest.flash?.erase_all === true, "The provisioning manifest does not request a full erase.");
  requireCondition(benchManifest.flash.mode === "dio" && benchManifest.flash.freq === "80m" && benchManifest.flash.size === "keep", "The provisioning manifest has unsupported flash settings.");
  requireCondition(parseOffset(benchManifest.app_offset, "The setup image") === 0x20000, "The setup image has an unexpected flash offset.");

  const files = REQUIRED_BENCH_FILES.map(([name, expectedOffset]) => {
    const file = benchManifest.files?.[name];
    requireCondition(file, `The provisioning manifest is missing ${name}.`);
    validateFile(file, name);
    const address = parseOffset(file.offset, name);
    requireCondition(address === expectedOffset, `${name} has an unexpected flash offset.`);
    return { name, address, size: file.size, sha256: file.sha256.toLowerCase(), url: `${RELEASE_ROOT}/bench/${name}` };
  });

  files.push({
    name: setupManifest.file,
    address: 0x20000,
    size: setupManifest.size,
    sha256: setupManifest.sha256.toLowerCase(),
    url: `${RELEASE_ROOT}/${setupManifest.file}`,
  });

  return { version: setupManifest.version, files };
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not fetch release metadata (${response.status}).`);
  return response.json();
}

async function fetchVerifiedFile(file, fetchImpl, cryptoImpl) {
  const response = await fetchImpl(file.url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not download ${file.name} (${response.status}).`);

  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length !== file.size) throw new Error(`${file.name} has the wrong size; nothing was flashed.`);

  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", data));
  const actualHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actualHash !== file.sha256) throw new Error(`${file.name} failed its SHA-256 check; nothing was flashed.`);

  return { ...file, data };
}

export async function loadVerifiedFlashPlan(fetchImpl = fetch, cryptoImpl = crypto) {
  const [setupManifest, benchManifest] = await Promise.all([
    fetchJson(`${RELEASE_ROOT}/manifest.json`, fetchImpl),
    fetchJson(`${RELEASE_ROOT}/bench/manifest.json`, fetchImpl),
  ]);
  const plan = createFlashPlan(setupManifest, benchManifest);
  const files = await Promise.all(plan.files.map((file) => fetchVerifiedFile(file, fetchImpl, cryptoImpl)));
  return { version: plan.version, files };
}