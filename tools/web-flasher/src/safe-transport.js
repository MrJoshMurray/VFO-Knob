import { Transport } from "esptool-js";

export class SafeTransport extends Transport {
  async write(data) {
    const stream = this.device.writable;
    if (!stream) return;
    if (stream.locked) throw new Error("Serial output stream is already locked before esptool could write.");
    const writer = stream.getWriter();
    try {
      await writer.write(this.slipWriter(data));
    } finally {
      writer.releaseLock();
    }
  }
}