import { fetchJson, fetchVerifiedFile } from "./flash-plan.js";

const RELEASE_ROOT = "https://raw.githubusercontent.com/Guru-RF/VFO-Knob/firmware/firmware/companion";
const REQUIRED_BENCH_FILES = [
  ["bootloader.bin", 0x1000],
  ["partition-table.bin", 0x8000],
  ["ota_data_initial.bin", 0xe000],
];
const APP_OFFSET = 0x20000;
const APP_PARTITION_SIZE = 0x1e0000;
const SECTOR_SIZE = 0x1000;

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

export async function inspectCompanionChip(chip, loader) {
  const description = await chip.getChipDescription(loader);
  const revision = await chip.getChipRevision(loader);
  return { description, revision };
}

export function createCompanionFlashPlan(companionManifest, benchManifest) {
  requireCondition(companionManifest?.project === "vfo-knob-companion", "The firmware manifest is not for the companion chip.");
  requireCondition(/^\d+\.\d+\.\d+$/.test(companionManifest.version), "The companion manifest has an invalid version.");
  requireCondition(typeof companionManifest.file === "string" && /^vfo-knob-companion-[\w.-]+\.bin$/.test(companionManifest.file), "The companion manifest has an invalid image filename.");
  validateFile(companionManifest, "The companion image");

  requireCondition(benchManifest?.project === "vfo-knob-companion", "The provisioning manifest is for another project.");
  requireCondition(benchManifest.release === companionManifest.version, "The companion image and provisioning bundle are from different releases.");
  requireCondition(benchManifest.bootloader_version === 2, "The provisioning bundle has an unsupported bootloader version.");

  const files = REQUIRED_BENCH_FILES.map(([name, expectedOffset]) => {
    const file = benchManifest.files?.[name];
    requireCondition(file, `The provisioning manifest is missing ${name}.`);
    validateFile(file, name);
    const address = parseOffset(file.offset, name);
    requireCondition(address === expectedOffset, `${name} has an unexpected flash offset.`);
    if (name === "bootloader.bin") requireCondition(file.size <= 0x7000, "The companion bootloader is too large.");
    if (name === "partition-table.bin") requireCondition(file.size <= 0x1000, "The companion partition table is too large.");
    if (name === "ota_data_initial.bin") requireCondition(file.size === 0x2000, "The companion OTA data has an unexpected size.");
    return {
      name,
      address,
      size: file.size,
      sha256: file.sha256.toLowerCase(),
      url: `${RELEASE_ROOT}/bench/${name}`,
    };
  });

  requireCondition(companionManifest.size >= 2 * SECTOR_SIZE && companionManifest.size % SECTOR_SIZE === 0,
    "The companion image has an invalid signed-image size.");
  requireCondition(companionManifest.size <= APP_PARTITION_SIZE, "The companion image is larger than its OTA partition.");
  files.push({
    name: companionManifest.file,
    address: APP_OFFSET,
    size: companionManifest.size,
    sha256: companionManifest.sha256.toLowerCase(),
    url: `${RELEASE_ROOT}/${companionManifest.file}`,
  });

  return {
    version: companionManifest.version,
    eraseAll: false,
    flashMode: "dio",
    flashFreq: "40m",
    flashSize: "keep",
    files,
  };
}

export async function loadVerifiedCompanionFlashPlan(fetchImpl = fetch, cryptoImpl = crypto) {
  const [companionManifest, benchManifest] = await Promise.all([
    fetchJson(`${RELEASE_ROOT}/manifest.json`, fetchImpl),
    fetchJson(`${RELEASE_ROOT}/bench/manifest.json`, fetchImpl),
  ]);
  const plan = createCompanionFlashPlan(companionManifest, benchManifest);
  const files = await Promise.all(plan.files.map((file) => fetchVerifiedFile(file, fetchImpl, cryptoImpl)));
  const image = files.at(-1).data;
  requireCondition(image[0] === 0xe9, "The companion image is not an ESP32 application.");
  requireCondition(image[12] === 0 && image[13] === 0, "The companion image is not built for the original ESP32.");
  requireCondition(image[image.length - SECTOR_SIZE] === 0xe7, "The companion image is missing its signed-image block.");
  return { ...plan, files };
}