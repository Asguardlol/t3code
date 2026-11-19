import {
  type DeviceInspectTarget,
  DeviceOperationError,
  type DevicePlatform,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import type { DeviceHostReady } from "./DeviceHost.ts";
import { webKitFrontendPath } from "./DeviceInspectWebKit.ts";

type Runner = DeviceHostReady["run"];
type ForwardPort = NonNullable<DeviceHostReady["forwardPort"]>;

interface InspectDevice {
  readonly id: string;
  readonly platform: DevicePlatform;
  readonly version: string;
  readonly physical: boolean;
}

interface InspectListing {
  readonly unsupported: string | null;
  readonly targets: ReadonlyArray<DeviceInspectTarget>;
}

// Each Chromium browser and debuggable web view exposes one of these abstract sockets.
const DEVTOOLS_SOCKET = /@([\w.]*devtools_remote(?:_\d+)?)\s*$/;
const FALLBACK_FRONTEND_REVISION = "/inspect-frontend/serve_rev/@";
const RELAY_LIFETIME = Duration.hours(1);

// Only the authenticated listing mints tokens, and each names one page, so the relay can't be
// pointed at any other loopback socket.
const relays = new Map<string, { readonly url: string; readonly expiresAt: number }>();

const mintRelay = Effect.fn("DeviceInspect.mintRelay")(function* (
  random: SecureRandom.SecureRandom["Service"],
  url: string,
) {
  const now = yield* Clock.currentTimeMillis;
  for (const [token, relay] of relays) if (relay.expiresAt < now) relays.delete(token);
  const token = Buffer.from(yield* random.randomBytes(24)).toString("base64url");
  relays.set(token, { url, expiresAt: now + Duration.toMillis(RELAY_LIFETIME) });
  return token;
});

export const resolveInspectRelay = Effect.fn("DeviceInspect.resolveRelay")(function* (
  token: string,
) {
  const relay = relays.get(token);
  if (relay === undefined || relay.expiresAt < (yield* Clock.currentTimeMillis)) return null;
  return relay.url;
});

const CdpPage = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.String,
  url: Schema.String,
  webSocketDebuggerUrl: Schema.optional(Schema.String),
  devtoolsFrontendUrl: Schema.optional(Schema.String),
});
const decodePages = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(CdpPage)));

const CdpVersion = Schema.Struct({
  Browser: Schema.optional(Schema.String),
  "Android-Package": Schema.optional(Schema.String),
  "WebKit-Version": Schema.optional(Schema.String),
});
const decodeVersion = Schema.decodeUnknownEffect(Schema.fromJsonString(CdpVersion));

const commandFailed =
  (operation: string) => (result: { code: number; stdout: string; stderr: string }) =>
    result.code === 0
      ? Effect.succeed(result.stdout)
      : Effect.fail(
          new DeviceOperationError({
            operation,
            reason: "command_failed",
            exitCode: result.code,
            cause: result,
          }),
        );

const getText = (http: HttpClient.HttpClient, operation: string, url: string) =>
  HttpClient.withScope(http)
    .get(url)
    .pipe(
      Effect.flatMap((response) => response.text),
      Effect.timeout(Duration.seconds(3)),
      Effect.scoped,
      Effect.mapError(
        (cause) => new DeviceOperationError({ operation, reason: "request_failed", cause }),
      ),
    );

/** Reuses an existing forward so listing repeatedly does not leak host ports. */
const forwardSocket = Effect.fn("DeviceInspect.forwardSocket")(function* (
  run: Runner,
  serial: string,
  socket: string,
) {
  const existing = yield* run("adb", ["-s", serial, "forward", "--list"]).pipe(
    Effect.flatMap(commandFailed("inspect forward list")),
  );
  const match = existing
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([owner, , remote]) => owner === serial && remote === `localabstract:${socket}`);
  const port = match?.[1]?.replace("tcp:", "");
  if (port) return Number(port);
  const created = yield* run("adb", [
    "-s",
    serial,
    "forward",
    "tcp:0",
    `localabstract:${socket}`,
  ]).pipe(Effect.flatMap(commandFailed("inspect forward")));
  return Number(created.trim());
});

const ownerName = (socket: string, version: typeof CdpVersion.Type) => {
  const pkg = version["Android-Package"];
  if (socket.startsWith("webview_devtools_remote")) return pkg ? `Web view · ${pkg}` : "Web view";
  return version.Browser?.split("/")[0] ?? pkg ?? socket;
};

const chromeFrontendPath = (page: typeof CdpPage.Type, version: typeof CdpVersion.Type) => {
  if (page.devtoolsFrontendUrl?.startsWith("http"))
    return `/inspect-frontend${new URL(page.devtoolsFrontendUrl).pathname}`;
  const revision = version["WebKit-Version"]?.match(/@([0-9a-f]{40})/)?.[1] ?? "";
  return `${FALLBACK_FRONTEND_REVISION}${revision}/inspector.html`;
};

const listAndroid = Effect.fn("DeviceInspect.listAndroid")(function* (
  http: HttpClient.HttpClient,
  random: SecureRandom.SecureRandom["Service"],
  ready: DeviceHostReady,
  forwardPort: ForwardPort,
  serial: string,
) {
  const sockets = yield* ready.run("adb", ["-s", serial, "shell", "cat", "/proc/net/unix"]).pipe(
    Effect.flatMap(commandFailed("inspect sockets")),
    Effect.map((table) => [
      ...new Set(
        table.split("\n").flatMap((line) => {
          const socket = line.match(DEVTOOLS_SOCKET)?.[1];
          return socket ? [socket] : [];
        }),
      ),
    ]),
  );
  const perSocket = yield* Effect.forEach(
    sockets,
    (socket) =>
      Effect.gen(function* () {
        const port = yield* forwardSocket(ready.run, serial, socket).pipe(
          Effect.flatMap(forwardPort),
        );
        const base = `http://127.0.0.1:${port}`;
        const version = yield* getText(http, "inspect version", `${base}/json/version`).pipe(
          Effect.flatMap(decodeVersion),
          Effect.orElseSucceed((): typeof CdpVersion.Type => ({})),
        );
        const pages = yield* getText(http, "inspect pages", `${base}/json/list`).pipe(
          Effect.flatMap(decodePages),
        );
        return yield* Effect.forEach(
          pages.filter((page) => page.type === "page" && page.webSocketDebuggerUrl !== undefined),
          (page) =>
            mintRelay(random, `ws://127.0.0.1:${port}/devtools/page/${page.id}`).pipe(
              Effect.map((relayToken): DeviceInspectTarget => ({
                id: `${socket}/${page.id}`,
                title: page.title || page.url,
                url: page.url,
                owner: ownerName(socket, version),
                frontendPath: chromeFrontendPath(page, version),
                relayToken,
              })),
            ),
        );
      }).pipe(
        // A browser can close between listing its socket and answering; skip it rather than fail.
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 4 },
  );
  return perSocket.flat();
});

// Starts or reuses ios_webkit_debug_proxy for one device; prints `ok <port>` or `error <reason>`.
// Not yet run on a Mac.
const IOS_PROXY_SCRIPT = [
  "set -u",
  'udid="$1"; physical="$2"; node="$3"',
  'command -v ios_webkit_debug_proxy >/dev/null 2>&1 || { echo "error missing-proxy"; exit 0; }',
  'if [ "$physical" = 1 ]; then',
  '  source="usbmux"',
  "else",
  '  pid=$(pgrep -f "launchd_sim .*/Devices/$udid/" | head -n 1)',
  '  [ -n "$pid" ] || { echo "error not-booted"; exit 0; }',
  "  socket=$(lsof -a -p \"$pid\" -U -F n 2>/dev/null | sed -n 's/^n//p' | grep 'com[.]apple[.]webinspectord_sim[.]socket$' | head -n 1)",
  '  [ -n "$socket" ] || { echo "error no-inspector"; exit 0; }',
  '  source="unix:$socket"',
  "fi",
  'state="$HOME/.t3/device/inspect/$udid"',
  'mkdir -p "$state"',
  'if [ -f "$state/pid" ] && kill -0 "$(cat "$state/pid")" 2>/dev/null && [ "$(cat "$state/source" 2>/dev/null)" = "$source" ]; then',
  '  echo "ok $(cat "$state/port")"; exit 0',
  "fi",
  '[ -f "$state/pid" ] && kill "$(cat "$state/pid")" 2>/dev/null',
  // Two free loopback ports: the proxy's device list, then this device's page list.
  'ports=$("$node" -e \'const net=require("net");const ports=[];const take=()=>{const s=net.createServer().listen(0,"127.0.0.1",()=>{ports.push(s.address().port);s.close(()=>ports.length<2?take():console.log(ports.join(" ")))})};take()\')',
  'list="${ports% *}"; port="${ports#* }"',
  'if [ "$physical" = 1 ]; then',
  '  set -- -c "null:$list,$udid:$port"',
  "else",
  '  set -- -s "$source" -c "null:$list,:$port-$port"',
  "fi",
  'nohup ios_webkit_debug_proxy "$@" -F >"$state/log" 2>&1 </dev/null &',
  'echo $! >"$state/pid"; echo "$source" >"$state/source"; echo "$port" >"$state/port"',
  "i=0",
  'while [ "$i" -lt 40 ]; do',
  '  curl -fsS "http://127.0.0.1:$port/json" >/dev/null 2>&1 && { echo "ok $port"; exit 0; }',
  "  i=$((i + 1)); sleep 0.25",
  "done",
  "echo \"error proxy-start $(tail -n 3 \"$state/log\" 2>/dev/null | tr '\\n' ' ')\"",
].join("\n");

const IOS_PROXY_ERRORS: Readonly<Record<string, string>> = {
  "missing-proxy":
    "Web inspection for iOS needs ios_webkit_debug_proxy on the Mac. Install it there with `brew install ios-webkit-debug-proxy`.",
  "not-booted": "Boot the simulator to inspect its web content.",
  "no-inspector":
    "The simulator's Web Inspector isn't running yet. Open Safari or the app, then refresh.",
};

const IwdpPage = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  webSocketDebuggerUrl: Schema.String,
  appId: Schema.optional(Schema.String),
});
const decodeIwdpPages = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(IwdpPage)));

const listIos = Effect.fn("DeviceInspect.listIos")(function* (
  http: HttpClient.HttpClient,
  random: SecureRandom.SecureRandom["Service"],
  ready: DeviceHostReady,
  forwardPort: ForwardPort,
  device: InspectDevice,
): Effect.fn.Return<InspectListing, DeviceOperationError> {
  const started = yield* ready
    .run(
      "sh",
      [
        "-c",
        IOS_PROXY_SCRIPT,
        "t3-inspect",
        device.id,
        device.physical ? "1" : "0",
        ready.nodePath,
      ],
      { timeoutMs: 30_000 },
    )
    .pipe(Effect.flatMap(commandFailed("inspect proxy")));
  const [status, ...detail] = started.trim().split(" ");
  if (status !== "ok") {
    const reason = detail[0] ?? "";
    return {
      unsupported:
        IOS_PROXY_ERRORS[reason] ??
        `ios_webkit_debug_proxy didn't start on the Mac: ${detail.join(" ") || "no output"}`,
      targets: [],
    };
  }
  const port = yield* forwardPort(Number(detail[0]));
  const pages = yield* getText(http, "inspect pages", `http://127.0.0.1:${port}/json`).pipe(
    Effect.flatMap(decodeIwdpPages),
    Effect.mapError(
      (cause) =>
        new DeviceOperationError({ operation: "inspect pages", reason: "invalid_payload", cause }),
    ),
  );
  const frontendPath = webKitFrontendPath(device.version);
  const targets = yield* Effect.forEach(
    pages.flatMap((page) => {
      const number = page.webSocketDebuggerUrl.match(/\/devtools\/page\/(\d+)$/)?.[1];
      return number === undefined ? [] : [{ page, number }];
    }),
    ({ page, number }) =>
      mintRelay(random, `ws://127.0.0.1:${port}/devtools/page/${number}`).pipe(
        Effect.map((relayToken): DeviceInspectTarget => ({
          id: `${page.appId ?? "page"}/${number}`,
          title: page.title || page.url,
          url: page.url,
          // The proxy names apps only by process, so Safari and web views look alike here.
          owner: page.appId ? `WebKit · ${page.appId}` : "WebKit",
          frontendPath,
          relayToken,
        })),
      ),
  );
  return { unsupported: null, targets };
});

export const listInspectTargets = Effect.fn("DeviceInspect.list")(function* (input: {
  readonly http: HttpClient.HttpClient | null;
  readonly random: SecureRandom.SecureRandom["Service"] | null;
  readonly ready: DeviceHostReady;
  readonly device: InspectDevice;
}): Effect.fn.Return<InspectListing, DeviceOperationError> {
  const { http, random, ready, device } = input;
  if (http === null || random === null)
    return { unsupported: "Web inspection is unavailable in this server.", targets: [] };
  if (ready.forwardPort === undefined)
    return { unsupported: "This device host can't forward ports for web inspection.", targets: [] };
  if (device.platform === "ios")
    return yield* listIos(http, random, ready, ready.forwardPort, device);
  return {
    unsupported: null,
    targets: yield* listAndroid(http, random, ready, ready.forwardPort, device.id),
  };
});
