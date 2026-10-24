const test = require("node:test"),
  assert = require("node:assert/strict");
const { RecordingWriter } = require("../src/renderer/js/recording-writer");
function bridge() {
  let sequence = 0,
    bytes = 0;
  const seen = [];
  return {
    seen,
    beginRecording: async () => ({ id: "fixture", maxChunk: 2 * 1024 * 1024 }),
    appendRecording: async (id, seq, data) => {
      assert.equal(seq, sequence++);
      seen.push(data.length);
      bytes += data.length;
      return { next: sequence, bytes };
    },
    finishRecording: async () => "/fixture.webm",
    preserveRecording: async () => {},
    relocateRecording: async () => true,
  };
}
test("large blobs are written in bounded acknowledged slices with no retained recording after save", async () => {
  const api = bridge(),
    writer = await new RecordingWriter(api).begin();
  writer.add(new Blob([new Uint8Array(6 * 1024 * 1024)]));
  assert.equal(await writer.finish(), "/fixture.webm");
  assert.ok(api.seen.every((size) => size <= 1024 * 1024));
  assert.equal(writer.jobs.length, 0);
  assert.equal(writer.queuedBytes, 0);
});
test("a failed write preserves its exact offset for Retry and never finalizes an incomplete recording", async () => {
  const api = bridge(),
    original = api.appendRecording;
  let fail = true,
    finished = 0;
  api.appendRecording = async (...args) => {
    if (fail) throw Error("disk unavailable");
    return original(...args);
  };
  api.finishRecording = async () => {
    finished++;
    return "/fixture.webm";
  };
  const writer = await new RecordingWriter(api).begin();
  writer.add(new Blob([new Uint8Array(100)]));
  await assert.rejects(writer.finish(), /disk/);
  assert.equal(finished, 0);
  assert.equal(writer.jobs.length, 1);
  fail = false;
  assert.equal(await writer.retry(), "/fixture.webm");
  assert.equal(finished, 1);
  assert.deepEqual(api.seen, [100]);
});
test("write pressure pauses capture and bounded overflow is reported instead of claiming a successful save", async () => {
  const api = bridge();
  let release;
  api.appendRecording = () =>
    new Promise((resolve) => {
      release = () => resolve({ next: 1, bytes: 8 * 1024 * 1024 });
    });
  const pressure = [];
  const writer = await new RecordingWriter(api, {
    onPressure: (value) => pressure.push(value),
  }).begin();
  writer.add(new Blob([new Uint8Array(9 * 1024 * 1024)]));
  assert.deepEqual(pressure, [true]);
  writer.add(new Blob([new Uint8Array(33 * 1024 * 1024)]));
  assert.equal(writer.overflow, true);
  await assert.rejects(writer.finish(), /keep up/);
  release?.();
});
