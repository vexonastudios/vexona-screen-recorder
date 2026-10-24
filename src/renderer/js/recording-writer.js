// Only bounded slices cross IPC. Failed/unwritten slices stay available for Retry.
class RecordingWriter {
  constructor(bridge, { onFailure = () => {}, onPressure = () => {} } = {}) {
    this.bridge = bridge;
    this.onFailure = onFailure;
    this.onPressure = onPressure;
    this.jobs = [];
    this.queuedBytes = 0;
    this.sequence = 0;
    this.bytes = 0;
    this.error = null;
    this.draining = null;
    this.overflow = false;
    this.completed = null;
  }
  async begin(name) {
    const session = await this.bridge.beginRecording(name);
    this.id = session.id;
    this.chunkSize = Math.min(session.maxChunk, 1024 * 1024);
    return this;
  }
  add(blob) {
    if (!blob?.size) return;
    if (this.queuedBytes + blob.size > 32 * 1024 * 1024) {
      this.overflow = true;
      this.error = Error(
        "Disk writes could not keep up. The on-disk portion is recoverable.",
      );
      this.onFailure(this.error);
      return;
    }
    this.jobs.push({ blob, offset: 0 });
    this.queuedBytes += blob.size;
    if (this.queuedBytes >= 8 * 1024 * 1024) this.onPressure(true);
    this.drain().catch(() => {});
  }
  drain() {
    if (this.draining) return this.draining;
    if (this.error) return Promise.reject(this.error);
    this.draining = (async () => {
      while (this.jobs.length) {
        const job = this.jobs[0],
          end = Math.min(job.blob.size, job.offset + this.chunkSize);
        const data = new Uint8Array(
          await job.blob.slice(job.offset, end).arrayBuffer(),
        );
        const result = await this.bridge.appendRecording(
          this.id,
          this.sequence,
          data,
        );
        if (result.next !== this.sequence + 1)
          throw Error("Recording write acknowledgment was out of order.");
        this.sequence++;
        this.bytes = result.bytes;
        this.queuedBytes -= data.length;
        job.offset = end;
        if (end === job.blob.size) this.jobs.shift();
        if (this.queuedBytes < 2 * 1024 * 1024) this.onPressure(false);
      }
    })()
      .catch((error) => {
        this.error = error;
        this.onFailure(error);
        throw error;
      })
      .finally(() => {
        this.draining = null;
      });
    return this.draining;
  }
  async finish() {
    if (this.completed) return this.completed;
    if (this.overflow) throw this.error;
    do {
      await this.drain();
    } while (this.jobs.length);
    this.completed = await this.bridge.finishRecording(this.id);
    return this.completed;
  }
  async retry(elsewhere = false) {
    if (this.overflow) throw this.error;
    if (elsewhere) {
      const moved = await this.bridge.relocateRecording(this.id);
      if (!moved) return null;
    }
    this.error = null;
    return this.finish();
  }
  async preserve() {
    await this.draining?.catch(() => {});
    await this.bridge.preserveRecording(this.id);
    this.jobs = [];
    this.queuedBytes = 0;
  }
}
if (typeof module !== "undefined") module.exports = { RecordingWriter };
else window.RecordingWriter = RecordingWriter;
