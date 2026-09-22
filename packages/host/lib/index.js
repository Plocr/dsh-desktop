/* dsh-desktop-host - adapted from deepseek-ai/deepseek-harness apps/desktop-host (MIT). */

// src/index.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { loadLayeredEnv, loadProfileDirectory } from "@deepseek-ai/dsh-app-boot";
import { runProfile } from "@deepseek-ai/dsh/profile-boot";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
var DESKTOP_PROFILE_IDENTITY = "desktop";
var DEFAULT_PORT = 19387;
var PNPM_STATE_DIR = join("desktop", "pnpm");
function desktopPackageManager(pnpmEntry) {
  const nodeDir = dirname(process.execPath);
  const root = join(resolveDshHome(), PNPM_STATE_DIR);
  const store = join(root, "store");
  const cache = join(root, "cache");
  const state = join(root, "state");
  const config = join(root, "config");
  const home = join(root, "home");
  for (const dir of [store, cache, state, config, home]) mkdirSync(dir, { recursive: true, mode: 448 });
  const npmrc = join(config, "npmrc");
  if (!existsSync(npmrc)) {
    try {
      appendFileSync(npmrc, "");
    } catch {
    }
  }
  return {
    command: process.execPath,
    // 子命令之前放全局参数：pnpm 接受 `pnpm --config.x=y <command>`。
    // store-dir 与旧的壳内事务完全一致 —— 既有 profile 的 node_modules 就是从这个 store
    // 链接出来的，换 store 会让 pnpm 直接 ERR_PNPM_UNEXPECTED_STORE。
    //
    // 注意这里的 `command` 是本进程的 execPath：宿主已经跑在**自家 Electron 二进制**上
    // （ELECTRON_RUN_AS_NODE 模式），所以 pnpm 也由同一个二进制执行——不再随包一个独立的
    // node.exe（杀软误报面 + 50 MB 体积，见 docs/ANTIVIRUS-FALSE-POSITIVE.md）。
    // `--expose-internals` 已移除：实测 pnpm 11 的 install/add/remove 都不需要它，
    // 而这个 flag 在行为启发式里非常显眼。
    args: [
      resolve(pnpmEntry),
      "--config.registry=https://registry.npmjs.org/",
      `--config.store-dir=${store}`,
      "--config.enable-global-virtual-store=false",
      `--config.userconfig=${npmrc}`
    ],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PATH: `${nodeDir}${delimiter}${process.env.PATH ?? ""}`,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: state,
      PNPM_HOME: home,
      COREPACK_HOME: home,
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      NPM_CONFIG_STORE_DIR: store,
      NPM_CONFIG_USERCONFIG: npmrc
    }
  };
}
function dshVersion(runtimeDir) {
  const path = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest.version !== "string") throw new Error("dsh desktop: installed dsh manifest has no version");
  return manifest.version;
}
async function runDesktopHost(runtimeDir, projectDir, options = {}) {
  const absoluteProject = resolve(projectDir);
  mkdirSync(absoluteProject, { recursive: true });
  const installAnchor = join(resolve(runtimeDir), "node_modules", "@deepseek-ai", "dsh", "package.json");
  const profile = loadProfileDirectory("dsh", absoluteProject, installAnchor);
  const application = runProfile({
    environment: loadLayeredEnv("dsh"),
    profile: DESKTOP_PROFILE_IDENTITY,
    // 官方：打包走 runtime（按解析代强制解析），开发走 link（把链接物化进 profile）。
    resolutionMode: options.allowLinkedPackages === true ? "link" : "runtime",
    resolvedProfile: { profile, installAnchor },
    // 官方桌面端不加任何私有补丁文件：桌面与浏览器共用同一套组合，
    // 差异只在「--no-open」与 Electron 侧的原生能力上。
    patchFiles: [],
    // `--no-open` 是官方桌面端的关键参数：绝不在启动时拉起浏览器（用户手动点托盘才开）。
    args: ["--no-open", "--port", String(options.port ?? DEFAULT_PORT)],
    ...options.pnpmEntry === void 0 ? {} : { packageManager: desktopPackageManager(options.pnpmEntry) }
  });
  let stopping;
  const dispose = () => stopping ??= (async () => {
    const running = await application.catch(() => void 0);
    await running?.shutdown.shutdown(0);
  })();
  const { ctx } = await application;
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`);
  return {
    dshVersion: dshVersion(resolve(runtimeDir)),
    url,
    injections: ctx.webServer.collectIndexInjections(),
    dispose
  };
}
async function main() {
  const runtimeDir = process.argv[2];
  const projectDir = process.argv[3];
  if (runtimeDir === void 0 || projectDir === void 0 || process.send === void 0) {
    throw new Error("dsh desktop: expected runtime and profile directories plus a Node IPC channel");
  }
  let pnpmEntry;
  let port;
  let allowLinkedPackages = false;
  const argv = process.argv.slice(4);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--allow-linked-profile") {
      allowLinkedPackages = true;
      continue;
    }
    if (flag === "--pnpm" || flag === "--port") {
      const value = argv[index + 1];
      if (value === void 0) throw new Error(`dsh desktop: ${flag} requires a value`);
      if (flag === "--pnpm") pnpmEntry = value;
      else {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`dsh desktop: invalid --port ${value}`);
        port = parsed;
      }
      index += 1;
      continue;
    }
    throw new Error(`dsh desktop: unsupported internal option ${JSON.stringify(flag)}`);
  }
  const send = (event) => {
    if (process.send === void 0 || !process.connected) return;
    try {
      process.send(event);
    } catch (error) {
      if (error.code !== "ERR_IPC_CHANNEL_CLOSED") throw error;
    }
  };
  const controller = await runDesktopHost(runtimeDir, projectDir, {
    ...pnpmEntry === void 0 ? {} : { pnpmEntry },
    ...port === void 0 ? {} : { port },
    allowLinkedPackages
  });
  send({
    type: "ready",
    dshVersion: controller.dshVersion,
    url: controller.url,
    injections: controller.injections
  });
  let requestedExitCode = 0;
  let stopping;
  const stop = (exitCode = 0) => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    stopping ??= (async () => {
      await controller.dispose();
      send({ type: "shutdown-complete" });
      if (process.connected) process.disconnect();
      process.exitCode = requestedExitCode;
    })();
    return stopping;
  };
  process.on("message", (message) => {
    if (typeof message === "object" && message !== null && message.type === "shutdown") {
      void stop();
      return;
    }
    send({ type: "fatal", message: "dsh desktop: invalid Electron IPC command" });
    void stop(1);
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
    if (process.send !== void 0 && process.connected) process.send({ type: "fatal", message });
    else process.stderr.write(`dsh desktop: ${message}
`);
    process.exitCode = 1;
  });
}
export {
  runDesktopHost
};
