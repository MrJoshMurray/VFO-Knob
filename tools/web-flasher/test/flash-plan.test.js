import test from "node:test";
import assert from "node:assert/strict";
import { createFlashPlan } from "../src/flash-plan.js";

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