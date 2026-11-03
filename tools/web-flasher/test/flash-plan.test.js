import test from "node:test";
import assert from "node:assert/strict";
import { createCustomFlashPlan, createFlashPlan } from "../src/flash-plan.js";
import { createCompanionFlashPlan, inspectCompanionChip } from "../src/companion-plan.js";
import { SafeTransport } from "../src/safe-transport.js";

function manifests() {
  return [
    {
      project: "vfo-knob-setup",
      version: "1.22.0",
      file: "vfo-knob-setup-1.22.0.bin",
      sha256: "a".repeat(64),
      size: 2048,
    },
    {
      project: "vfo-knob-setup",
      release: "1.22.0",
      chip: "esp32s3",
      flash: { mode: "dio", freq: "80m", size: "keep", erase_all: true },
      app_offset: "0x20000",
      files: {
        "bootloader.bin": { offset: "0x0", sha256: "b".repeat(64), size: 1024 },
        "partition-table.bin": { offset: "0x8000", sha256: "c".repeat(64), size: 512 },
        "sdwipe.bin": { offset: "0x9000", sha256: "d".repeat(64), size: 256 },
      },
    },
  ];
}

function companionManifests() {
  return [
    {
      project: "vfo-knob-companion",
      version: "1.21.1",
      file: "vfo-knob-companion-1.21.1.bin",
      sha256: "a".repeat(64),
      size: 8192,
    },
    {
      project: "vfo-knob-companion",
      release: "1.21.1",
      bootloader_version: 2,
      files: {
        "bootloader.bin": { offset: "0x1000", sha256: "b".repeat(64), size: 1024 },
        "partition-table.bin": { offset: "0x8000", sha256: "c".repeat(64), size: 512 },
        "ota_data_initial.bin": { offset: "0xe000", sha256: "d".repeat(64), size: 0x2000 },
      },
    },
  ];
}

test("creates the exact ordered S3 flash plan", () => {
  const plan = createFlashPlan(...manifests());
  assert.equal(plan.version, "1.22.0");
  assert.deepEqual(plan.files.map(({ name, address }) => [name, address]), [
    ["bootloader.bin", 0x0],
    ["partition-table.bin", 0x8000],
    ["sdwipe.bin", 0x9000],
    ["vfo-knob-setup-1.22.0.bin", 0x20000],
  ]);
});

test("rejects a wrong chip or changed flash layout", () => {
  const [setup, bench] = manifests();
  assert.throws(() => createFlashPlan(setup, { ...bench, chip: "esp32" }), /not for the ESP32-S3/);
  assert.throws(() => createFlashPlan(setup, { ...bench, release: "1.21.8" }), /different releases/);
  assert.throws(() => createFlashPlan(setup, { ...bench, app_offset: "0x10000" }), /unexpected flash offset/);
  assert.throws(() => createFlashPlan(setup, { ...bench, files: { ...bench.files, "sdwipe.bin": { ...bench.files["sdwipe.bin"], offset: "0x10000" } } }), /sdwipe.bin has an unexpected flash offset/);
});

test("rejects unsafe firmware names and malformed hashes", () => {
  const [setup, bench] = manifests();
  assert.throws(() => createFlashPlan({ ...setup, file: "../firmware.bin" }, bench), /invalid image filename/);
  assert.throws(() => createFlashPlan({ ...setup, sha256: "bad" }, bench), /invalid SHA-256/);
});

test("creates a second-chip provisioning plan without erasing NVS", () => {
  const plan = createCompanionFlashPlan(...companionManifests());
  assert.equal(plan.version, "1.21.1");
  assert.equal(plan.eraseAll, false);
  assert.equal(plan.flashFreq, "40m");
  assert.deepEqual(plan.files.map(({ name, address }) => [name, address]), [
    ["bootloader.bin", 0x1000],
    ["partition-table.bin", 0x8000],
    ["ota_data_initial.bin", 0xe000],
    ["vfo-knob-companion-1.21.1.bin", 0x20000],
  ]);
});

test("rejects companion releases with unsafe layout or wrong version", () => {
  const [companion, bench] = companionManifests();
  assert.throws(() => createCompanionFlashPlan(companion, { ...bench, release: "1.21.0" }), /different releases/);
  assert.throws(() => createCompanionFlashPlan(companion, { ...bench, bootloader_version: 1 }), /unsupported bootloader/);
  assert.throws(() => createCompanionFlashPlan(companion, {
    ...bench,
    files: { ...bench.files, "bootloader.bin": { ...bench.files["bootloader.bin"], offset: "0x0" } },
  }), /unexpected flash offset/);
  assert.throws(() => createCompanionFlashPlan({ ...companion, size: 8193 }, bench), /invalid signed-image size/);
});

test("releases a serial writer when a write rejects", async () => {
  let locked = false;
  const device = {
    get writable() {
      return {
        get locked() { return locked; },
        getWriter() {
          if (locked) throw new TypeError("stream already locked");
          locked = true;
          return {
            async write() { throw new Error("serial write failed"); },
            releaseLock() { locked = false; },
          };
        },
      };
    },
  };
  const transport = new SafeTransport(device);
  await assert.rejects(transport.write(new Uint8Array([1])), /serial write failed/);
  assert.equal(locked, false);
  await assert.rejects(transport.write(new Uint8Array([2])), /serial write failed/);
  assert.equal(locked, false);
});

test("reports when another writer already holds the serial stream", async () => {
  const transport = new SafeTransport({ writable: { locked: true } });
  await assert.rejects(transport.write(new Uint8Array([1])), /already locked before esptool could write/);
});

test("inspects companion identity with sequential serial reads", async () => {
  let activeReads = 0;
  let maximumConcurrentReads = 0;
  const read = async (result) => {
    activeReads++;
    maximumConcurrentReads = Math.max(maximumConcurrentReads, activeReads);
    await Promise.resolve();
    activeReads--;
    return result;
  };
  const chip = {
    getChipDescription: () => read("ESP32-U4WDH (revision 3)"),
    getChipRevision: () => read(3),
  };
  const identity = await inspectCompanionChip(chip, {});
  assert.deepEqual(identity, { description: "ESP32-U4WDH (revision 3)", revision: 3 });
  assert.equal(maximumConcurrentReads, 1);
});

test("plans an application BIN for the first OTA slot without a full erase", () => {
  const image = new Uint8Array([0xe9, 0x00, 0x00]);
  const plan = createCustomFlashPlan("vfo-knob-thetis.bin", image, "app");
  assert.equal(plan.eraseAll, false);
  assert.deepEqual(plan.files.map(({ name, address, size }) => [name, address, size]), [
    ["vfo-knob-thetis.bin", 0x20000, 3],
  ]);
});

test("plans an ESP-IDF merged BIN from offset zero with a full erase", () => {
  const image = new Uint8Array(0x20001);
  image[0] = 0xe9;
  image[0x8000] = 0xaa;
  image[0x8001] = 0x50;
  image[0x20000] = 0xe9;
  const plan = createCustomFlashPlan("vfo-knob-thetis-merged.bin", image, "full");
  assert.equal(plan.eraseAll, true);
  assert.deepEqual(plan.files.map(({ address, size }) => [address, size]), [[0, image.length]]);
});

test("rejects malformed or oversized custom images before flashing", () => {
  assert.throws(() => createCustomFlashPlan("firmware.bin", new Uint8Array([0]), "app"), /application image/);
  assert.throws(() => createCustomFlashPlan("firmware.bin", new Uint8Array([0xe9]), "full"), /full image must contain/);
  assert.throws(() => createCustomFlashPlan("firmware.hex", new Uint8Array([0xe9]), "app"), /Choose a .bin/);
  assert.throws(() => createCustomFlashPlan("firmware.bin", new Uint8Array([0xe9]), "other"), /Choose an application/);
});