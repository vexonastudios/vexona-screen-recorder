const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { Readable } = require("node:stream");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
function mediaProtocol(store) {
  const tokens = new Map(),
    files = new Map();
  return {
    async urlFor(file) {
      const allowed = await store.validFile(file);
      if (files.has(allowed))
        return "vexona-media://capture/" + files.get(allowed);
      const id = randomUUID();
      tokens.set(id, allowed);
      files.set(allowed, id);
      if (tokens.size > 1024) {
        const oldest = tokens.keys().next().value;
        files.delete(tokens.get(oldest));
        tokens.delete(oldest);
      }
      return "vexona-media://capture/" + id;
    },
    async handle(request) {
      try {
        const url = new URL(request.url),
          id = url.pathname.slice(1),
          file = tokens.get(id);
        if (
          !["GET", "HEAD"].includes(request.method) ||
          url.hostname !== "capture" ||
          !file
        )
          return new Response(null, { status: 404 });
        const safe = await store.validFile(file),
          stat = await fs.stat(safe),
          type = {
            ".webm": "video/webm",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
          }[path.extname(safe).toLowerCase()];
        let start = 0,
          end = stat.size - 1,
          status = 200;
        const range = request.headers.get("Range");
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2]))
            return new Response(null, { status: 416 });
          start = match[1]
            ? Number(match[1])
            : Math.max(0, stat.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start > end ||
            start < 0 ||
            start >= stat.size
          )
            return new Response(null, {
              status: 416,
              headers: { "Content-Range": "bytes */" + stat.size },
            });
          status = 206;
        }
        const headers = {
          "Content-Type": type,
          "Accept-Ranges": "bytes",
          "Content-Length": String(Math.max(0, end - start + 1)),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        };
        if (status === 206)
          headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
        return new Response(
          request.method === "HEAD" || !stat.size
            ? null
            : Readable.toWeb(createReadStream(safe, { start, end })),
          { status, headers },
        );
      } catch {
        return new Response(null, { status: 404 });
      }
    },
  };
}
module.exports = { mediaProtocol };
