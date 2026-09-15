/* dsh-desktop-host - adapted from deepseek-ai/deepseek-harness apps/desktop-host (MIT). */

// src/index.ts
import { createRequire } from "node:module";
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  loadLayeredEnv,
  loadProfileDirectory,
  loadOverlayPatches
} from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";
import { renderIndexInjections } from "@deepseek-ai/dsh-host-webserver";

// src/wire.ts
var DESKTOP_HOST_PROTOCOL_VERSION = 3;
var DESKTOP_REQUEST_PIPE_FD = 3;
var DESKTOP_RESPONSE_PIPE_FD = 4;
var DESKTOP_PIPE_CHUNK_BYTES = 64 * 1024;
var FRAME_MAGIC = 1146308659;
var FRAME_HEADER_BYTES = 13;
var MAX_CONTROL_PAYLOAD_BYTES = 1024 * 1024;
var REQUEST_FRAME_START = 1;
var REQUEST_FRAME_DATA = 2;
var REQUEST_FRAME_END = 3;
var REQUEST_FRAME_CANCEL = 4;
var RESPONSE_FRAME_START = 1;
var RESPONSE_FRAME_DATA = 2;
var RESPONSE_FRAME_END = 3;
var RESPONSE_FRAME_ERROR = 4;
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isHeaders(value) {
  return Array.isArray(value) && value.every((header) => Array.isArray(header) && header.length === 2 && typeof header[0] === "string" && typeof header[1] === "string");
}
function assertStreamId(streamId) {
  if (!Number.isInteger(streamId) || streamId < 1 || streamId > 4294967295) {
    throw new Error(`dsh desktop: invalid pipe stream id ${String(streamId)}`);
  }
}
function encodeFrame(type, streamId, payload) {
  assertStreamId(streamId);
  const limit = type === RESPONSE_FRAME_DATA ? DESKTOP_PIPE_CHUNK_BYTES : MAX_CONTROL_PAYLOAD_BYTES;
  if (payload.byteLength > limit) {
    throw new Error(`dsh desktop: response pipe frame exceeds the ${String(limit)}-byte limit`);
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(FRAME_MAGIC, 0);
  frame.writeUInt8(type, 4);
  frame.writeUInt32BE(streamId, 5);
  frame.writeUInt32BE(payload.byteLength, 9);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}
function encodeJsonFrame(type, streamId, value) {
  return encodeFrame(type, streamId, Buffer.from(JSON.stringify(value), "utf8"));
}
function encodeDesktopResponseStart(streamId, response) {
  return encodeJsonFrame(RESPONSE_FRAME_START, streamId, response);
}
function encodeDesktopResponseData(streamId, data) {
  return encodeFrame(RESPONSE_FRAME_DATA, streamId, Buffer.from(data));
}
function encodeDesktopResponseEnd(streamId) {
  return encodeFrame(RESPONSE_FRAME_END, streamId, Buffer.alloc(0));
}
function encodeDesktopResponseError(streamId, message) {
  return encodeJsonFrame(RESPONSE_FRAME_ERROR, streamId, { message });
}
var DesktopHostRequestDecoder = class {
  buffer = Buffer.alloc(0);
  /**
   * Append bytes and return every complete request frame.
   * @param chunk - next bytes read from the Electron request pipe.
   * @returns complete frames in pipe order.
   */
  push(chunk) {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];
    for (; ; ) {
      const frame = this.next();
      if (frame === void 0) return frames;
      frames.push(frame);
    }
  }
  /** Reject EOF that splits a frame. */
  finish() {
    if (this.buffer.byteLength !== 0) throw new Error("dsh desktop: Electron request pipe ended inside a frame");
  }
  next() {
    if (this.buffer.byteLength < FRAME_HEADER_BYTES) return void 0;
    if (this.buffer.readUInt32BE(0) !== FRAME_MAGIC) throw new Error("dsh desktop: invalid Electron request frame marker");
    const rawType = this.buffer.readUInt8(4);
    const streamId = this.buffer.readUInt32BE(5);
    const payloadLength = this.buffer.readUInt32BE(9);
    assertStreamId(streamId);
    const limit = rawType === REQUEST_FRAME_DATA ? DESKTOP_PIPE_CHUNK_BYTES : MAX_CONTROL_PAYLOAD_BYTES;
    if (payloadLength > limit) {
      throw new Error(`dsh desktop: Electron request frame exceeds the ${String(limit)}-byte limit`);
    }
    const frameLength = FRAME_HEADER_BYTES + payloadLength;
    if (this.buffer.byteLength < frameLength) return void 0;
    const payload = this.buffer.subarray(FRAME_HEADER_BYTES, frameLength);
    this.buffer = this.buffer.subarray(frameLength);
    switch (rawType) {
      case REQUEST_FRAME_START:
        return this.parseStart(streamId, payload);
      case REQUEST_FRAME_DATA:
        return { type: "data", streamId, data: payload };
      case REQUEST_FRAME_END:
        if (payloadLength !== 0) throw new Error("dsh desktop: Electron request end frame carried a payload");
        return { type: "end", streamId };
      case REQUEST_FRAME_CANCEL:
        if (payloadLength !== 0) throw new Error("dsh desktop: Electron request cancel frame carried a payload");
        return { type: "cancel", streamId };
      default:
        throw new Error(`dsh desktop: unknown Electron request frame type ${String(rawType)}`);
    }
  }
  parseStart(streamId, payload) {
    let value;
    try {
      value = JSON.parse(payload.toString("utf8"));
    } catch (error) {
      throw new Error(`dsh desktop: Electron request start payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(value) || typeof value.url !== "string" || typeof value.method !== "string" || !isHeaders(value.headers) || typeof value.hasBody !== "boolean") {
      throw new Error("dsh desktop: invalid Electron request start payload");
    }
    return {
      type: "start",
      streamId,
      url: value.url,
      method: value.method,
      headers: value.headers,
      hasBody: value.hasBody
    };
  }
};

// src/index.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function isDesktopHostCommand(message) {
  return typeof message === "object" && message !== null && "type" in message && message.type === "shutdown";
}
var DESKTOP_PATCH = fileURLToPath(new URL("../config/desktop.cordis.patch.yml", import.meta.url));
var ROOT_CONFIG = "# Electron desktop composition root; package transactions own this file.\n[]\n";
var ROOT_CONFIG_FILENAME = "desktop.cordis.yml";
var DESKTOP_STREAM_PATH = "/.dsh/remote-stream";
var DESKTOP_TRANSPORT_SCRIPT = `globalThis.__DSH_TRANSPORT__={
  ownsHost:true,
  async *openStream(endpoint,payload,signal){
    const response=await fetch(${JSON.stringify(DESKTOP_STREAM_PATH)},{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload}),signal
    })
    if(!response.ok||response.body===null)throw new Error('desktop stream transport failed: HTTP '+response.status)
    const reader=response.body.getReader(),decoder=new TextDecoder()
    let pending=''
    for(;;){
      const {done,value}=await reader.read()
      pending+=decoder.decode(value,{stream:!done})
      let newline
      while((newline=pending.indexOf('\\n'))!==-1){
        const line=pending.slice(0,newline);pending=pending.slice(newline+1)
        if(line!=='')yield JSON.parse(line)
      }
      if(done)break
    }
    if(pending!=='')yield JSON.parse(pending)
  }
}`;
var MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json"
};
function readManifest(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord2(value)) throw new Error(`dsh desktop: ${path} must contain a package manifest`);
  return {
    ...typeof value.name === "string" ? { name: value.name } : {},
    ...typeof value.version === "string" ? { version: value.version } : {}
  };
}
function packageManifestPath(projectDir, packageName) {
  const path = join(projectDir, "node_modules", ...packageName.split("/"), "package.json");
  if (!existsSync(path)) throw new Error(`dsh desktop: installed package ${JSON.stringify(packageName)} has no manifest`);
  return path;
}
function isProjectPath(projectDir, target) {
  const root = realpathSync(projectDir);
  const path = realpathSync(target);
  return path === root || path.startsWith(root + sep);
}
async function healModuleFallback(runtimeDir, projectDir) {
  const installAnchor = packageManifestPath(runtimeDir, "@deepseek-ai/dsh");
  const profile = loadProfileDirectory("dsh desktop", projectDir, installAnchor);
  await healProfilesModuleFallback({ installAnchor, profile });
}
function desktopPatches(runtimeDir, projectDir, allowLinkedPackages) {
  const dshRoot = dirname(packageManifestPath(runtimeDir, "@deepseek-ai/dsh"));
  const profile = loadProfileDirectory("dsh desktop", projectDir, join(dshRoot, "package.json"));
  for (const layer of profile.layers) {
    if (!allowLinkedPackages && !isProjectPath(projectDir, layer.packageDir) && !isProjectPath(runtimeDir, layer.packageDir)) {
      throw new Error(`dsh desktop: profile bundle ${JSON.stringify(layer.packageName)} resolved outside the Desktop runtime and profile`);
    }
  }
  const layers = [
    ...profile.layers.map((layer) => layer.patches),
    profile.patches,
    loadOverlayPatches("dsh desktop", DESKTOP_PATCH)
  ];
  const rows = new Map(composeEntries(layers).flatMap((row) => typeof row.id === "string" ? [[row.id, row]] : []));
  const agentPresets = rows.get("agent-presets");
  if (agentPresets !== void 0) {
    layers.push([{
      id: "agent-presets",
      config: {
        ...agentPresets.config ?? {},
        roots: [{ path: join(dshRoot, "config", "agent-presets"), trust: "system" }]
      }
    }]);
  }
  return layers.flat();
}
function dshVersion(runtimeDir) {
  const manifest = readManifest(packageManifestPath(runtimeDir, "@deepseek-ai/dsh"));
  if (typeof manifest.version !== "string") throw new Error("dsh desktop: installed dsh manifest has no version");
  return manifest.version;
}
function assetHandler(ctx, runtimeDir) {
  const require2 = createRequire(join(runtimeDir, "package.json"));
  const distIndex = require2.resolve("@deepseek-ai/dsh-web-frontend/dist/index.html");
  const distRoot = realpathSync(dirname(distIndex));
  const renderIndex = async () => {
    const rows = [{ kind: "script", placement: "head", text: DESKTOP_TRANSPORT_SCRIPT }];
    ctx.emit("webserver/index-inject", rows);
    const body = renderIndexInjections(await readFile(distIndex, "utf8"), rows);
    return new Response(body, { headers: { "content-type": MIME[".html"] ?? "text/html; charset=utf-8" } });
  };
  return {
    requestBodyMode: () => "buffered",
    async fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const url = new URL(request.url);
      if (url.pathname.startsWith("/plugins/")) return ctx.clientModules.fetchBundle(request);
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response(null, { status: 400 });
      }
      if (pathname === "/" || pathname === "/index.html") return renderIndex();
      const target = resolve(normalize(join(distRoot, pathname)));
      if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 });
      try {
        const realTarget = realpathSync(target);
        if (realTarget !== distRoot && !realTarget.startsWith(distRoot + sep)) return new Response(null, { status: 403 });
        return new Response(request.method === "HEAD" ? null : await readFile(realTarget), {
          headers: { "content-type": MIME[extname(realTarget)] ?? "application/octet-stream" }
        });
      } catch {
        return renderIndex();
      }
    }
  };
}
function remoteStreamHandler(ctx) {
  return {
    requestBodyMode: () => "buffered",
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const gateway = ctx.get("typertGateway");
      if (gateway === void 0) return new Response("gateway unavailable", { status: 503 });
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }
      if (!isRecord2(body) || typeof body.endpoint !== "string") {
        return new Response("invalid stream request", { status: 400 });
      }
      const abort = new AbortController();
      const cancel = () => {
        abort.abort(request.signal.reason);
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            const values = await gateway.wireStream.open(body.endpoint, body.payload, abort.signal);
            for await (const value of values) {
              controller.enqueue(encoder.encode(`${JSON.stringify(value)}
`));
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          } finally {
            request.signal.removeEventListener("abort", cancel);
          }
        },
        cancel(reason) {
          abort.abort(reason);
          request.signal.removeEventListener("abort", cancel);
        }
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
    }
  };
}
async function runDesktopHost(runtimeDir, projectDir, writeResponse, options = {}) {
  const absoluteProject = resolve(projectDir);
  mkdirSync(absoluteProject, { recursive: true });
  const rootConfig = join(absoluteProject, ROOT_CONFIG_FILENAME);
  writeFileSync(rootConfig, ROOT_CONFIG);
  const environment = loadLayeredEnv("dsh desktop");
  await healModuleFallback(resolve(runtimeDir), absoluteProject);
  let current;
  const ctx = await boot("dsh desktop", rootConfig, structuredClone(desktopPatches(
    resolve(runtimeDir),
    absoluteProject,
    options.allowLinkedPackages === true
  )), (hostCtx) => {
    current = hostCtx;
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    provideCmdline(hostCtx, { args: [], exit: () => {
    } });
  });
  current = ctx;
  const connection = ctx.get("connection");
  const clientModules = ctx.get("clientModules");
  const gateway = ctx.get("typertGateway");
  if (connection === void 0 || clientModules === void 0 || gateway === void 0) {
    await ctx.fiber.dispose();
    throw new Error("dsh desktop: composition did not provide connection, typertGateway, and clientModules");
  }
  const api = connection.createSharedFetchHandler("/api");
  const assets = assetHandler(ctx, resolve(runtimeDir));
  const streams = remoteStreamHandler(ctx);
  const requests = /* @__PURE__ */ new Map();
  let disposing;
  const dispose = async () => {
    disposing ??= (async () => {
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      await current?.fiber.dispose();
      current = void 0;
    })();
    await disposing;
  };
  return {
    dshVersion: dshVersion(resolve(runtimeDir)),
    cancel(streamId) {
      requests.get(streamId)?.abort();
    },
    async fetch(command, body) {
      if (disposing !== void 0) throw new Error("dsh desktop: host is disposing");
      const controller = new AbortController();
      requests.set(command.streamId, controller);
      try {
        const url = new URL(command.request.url);
        const init = {
          method: command.request.method,
          headers: new Headers(command.request.headers.map(([name, value]) => [name, value])),
          ...body === null ? {} : { body, duplex: "half" },
          signal: controller.signal
        };
        const request = new Request(url, init);
        const response = url.pathname === DESKTOP_STREAM_PATH ? await streams.fetch(request) : url.pathname.startsWith("/api/") ? await api.fetch(request) : await assets.fetch(request);
        await writeResponse(encodeDesktopResponseStart(command.streamId, {
          status: response.status,
          headers: [...response.headers.entries()],
          hasBody: response.body !== null
        }));
        if (response.body !== null) {
          for await (const chunk of response.body) {
            const bytes = Buffer.from(chunk);
            for (let offset = 0; offset < bytes.byteLength; offset += DESKTOP_PIPE_CHUNK_BYTES) {
              await writeResponse(encodeDesktopResponseData(
                command.streamId,
                bytes.subarray(offset, offset + DESKTOP_PIPE_CHUNK_BYTES)
              ));
            }
          }
        }
        await writeResponse(encodeDesktopResponseEnd(command.streamId));
      } catch (error) {
        if (!controller.signal.aborted) {
          await writeResponse(encodeDesktopResponseError(
            command.streamId,
            error instanceof Error ? error.message : String(error)
          ));
        }
      } finally {
        requests.delete(command.streamId);
      }
    },
    dispose
  };
}
async function main() {
  const runtimeDir = process.argv[2];
  const projectDir = process.argv[3];
  if (runtimeDir === void 0 || projectDir === void 0 || process.send === void 0) {
    throw new Error("dsh desktop: expected runtime and profile directories, byte pipes, and a Node IPC channel");
  }
  const option = process.argv[4];
  if (option !== void 0 && option !== "--allow-linked-profile") {
    throw new Error(`dsh desktop: unsupported internal option ${JSON.stringify(option)}`);
  }
  const requestPipe = createReadStream("", { fd: DESKTOP_REQUEST_PIPE_FD, autoClose: false });
  const responsePipe = createWriteStream("", { fd: DESKTOP_RESPONSE_PIPE_FD, autoClose: false });
  let responseWriteTail = Promise.resolve();
  const writeResponse = (frame) => {
    const write = responseWriteTail.then(async () => {
      if (responsePipe.destroyed) throw new Error("dsh desktop: Electron response pipe is unavailable");
      if (!responsePipe.write(frame)) await once(responsePipe, "drain");
    });
    responseWriteTail = write.catch(() => void 0);
    return write;
  };
  const send = (event) => {
    if (process.send === void 0 || !process.connected) return;
    try {
      process.send(event);
    } catch (error) {
      if (error.code !== "ERR_IPC_CHANNEL_CLOSED") throw error;
    }
  };
  const controller = await runDesktopHost(runtimeDir, projectDir, writeResponse, { allowLinkedPackages: option !== void 0 });
  send({
    type: "ready",
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    dshVersion: controller.dshVersion
  });
  const decoder = new DesktopHostRequestDecoder();
  const requestBodies = /* @__PURE__ */ new Map();
  const blockedRequests = /* @__PURE__ */ new Set();
  const discardedRequestBodies = /* @__PURE__ */ new Set();
  const runs = /* @__PURE__ */ new Set();
  let lastStreamId = 0;
  let requestedExitCode = 0;
  let stopping;
  const resumeRequestPipe = () => {
    if (blockedRequests.size === 0) requestPipe.resume();
  };
  const stop = (exitCode = 0) => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    stopping ??= (async () => {
      requestPipe.pause();
      requestPipe.removeAllListeners("data");
      const stopped = new Error("dsh desktop: Host is stopping");
      for (const body of requestBodies.values()) body.error(stopped);
      requestBodies.clear();
      blockedRequests.clear();
      discardedRequestBodies.clear();
      requestPipe.destroy();
      closeSync(DESKTOP_REQUEST_PIPE_FD);
      await controller.dispose();
      await Promise.allSettled([...runs]);
      await responseWriteTail.catch(() => void 0);
      if (!responsePipe.destroyed) {
        await new Promise((resolvePromise) => {
          responsePipe.end(resolvePromise);
        });
        responsePipe.destroy();
      }
      closeSync(DESKTOP_RESPONSE_PIPE_FD);
      if (process.connected) process.disconnect();
      process.exitCode = requestedExitCode;
    })();
    return stopping;
  };
  const failTransport = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    send({ type: "fatal", message });
    void stop(1);
  };
  const beginRequest = (frame) => {
    if (frame.streamId <= lastStreamId) {
      throw new Error(`dsh desktop: Electron reused or reordered request stream ${String(frame.streamId)}`);
    }
    lastStreamId = frame.streamId;
    let body = null;
    if (frame.hasBody) {
      body = new ReadableStream({
        start(controllerOfBody) {
          requestBodies.set(frame.streamId, controllerOfBody);
        },
        pull() {
          blockedRequests.delete(frame.streamId);
          resumeRequestPipe();
        },
        cancel() {
          requestBodies.delete(frame.streamId);
          blockedRequests.delete(frame.streamId);
          controller.cancel(frame.streamId);
          resumeRequestPipe();
        }
      });
    }
    const run = controller.fetch({
      streamId: frame.streamId,
      request: {
        url: frame.url,
        method: frame.method,
        headers: frame.headers
      }
    }, body);
    runs.add(run);
    void run.catch(failTransport).finally(() => {
      runs.delete(run);
      const openBody = requestBodies.get(frame.streamId);
      if (openBody === void 0) return;
      openBody.error(new Error("dsh desktop: response completed before the request body ended"));
      requestBodies.delete(frame.streamId);
      blockedRequests.delete(frame.streamId);
      discardedRequestBodies.add(frame.streamId);
      resumeRequestPipe();
    });
  };
  const handleRequestFrame = (frame) => {
    switch (frame.type) {
      case "start":
        beginRequest(frame);
        return;
      case "data": {
        const body = requestBodies.get(frame.streamId);
        if (body === void 0) {
          if (discardedRequestBodies.has(frame.streamId)) return;
          throw new Error(`dsh desktop: Electron sent body data for inactive stream ${String(frame.streamId)}`);
        }
        body.enqueue(frame.data);
        if ((body.desiredSize ?? 0) <= 0) {
          blockedRequests.add(frame.streamId);
          requestPipe.pause();
        }
        return;
      }
      case "end": {
        const body = requestBodies.get(frame.streamId);
        if (body === void 0) {
          if (discardedRequestBodies.delete(frame.streamId)) return;
          throw new Error(`dsh desktop: Electron ended inactive body stream ${String(frame.streamId)}`);
        }
        body.close();
        requestBodies.delete(frame.streamId);
        blockedRequests.delete(frame.streamId);
        resumeRequestPipe();
        return;
      }
      case "cancel": {
        if (frame.streamId > lastStreamId) {
          throw new Error(`dsh desktop: Electron canceled unknown stream ${String(frame.streamId)}`);
        }
        const body = requestBodies.get(frame.streamId);
        body?.error(new Error("dsh desktop: Electron canceled the request"));
        requestBodies.delete(frame.streamId);
        blockedRequests.delete(frame.streamId);
        discardedRequestBodies.delete(frame.streamId);
        controller.cancel(frame.streamId);
        resumeRequestPipe();
        return;
      }
      default:
        frame;
    }
  };
  requestPipe.on("data", (chunk) => {
    try {
      for (const frame of decoder.push(Buffer.from(chunk))) handleRequestFrame(frame);
    } catch (error) {
      failTransport(error);
    }
  });
  requestPipe.once("end", () => {
    if (stopping !== void 0) return;
    try {
      decoder.finish();
      failTransport(new Error("dsh desktop: Electron request pipe ended"));
    } catch (error) {
      failTransport(error);
    }
  });
  requestPipe.once("error", failTransport);
  responsePipe.once("error", failTransport);
  process.on("message", (message) => {
    if (!isDesktopHostCommand(message)) {
      send({ type: "fatal", message: "dsh desktop: invalid Electron IPC command" });
      void stop(1);
      return;
    }
    void stop();
  });
  process.once("disconnect", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
}
if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.send !== void 0) process.send({ type: "fatal", message });
    else process.stderr.write(`dsh desktop: ${message}
`);
    process.exitCode = 1;
  });
}
export {
  DESKTOP_HOST_PROTOCOL_VERSION,
  runDesktopHost
};
