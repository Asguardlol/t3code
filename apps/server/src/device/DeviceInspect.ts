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

type Runner = DeviceHostReady["run"];

// Chrome, WebView and other Chromium browsers each expose an abstract socket named this way.
const DEVTOOLS_SOCKET = /@([\w.]*devtools_remote(?:_\d+)?)\s*$/;
const FALLBACK_FRONTEND = "https://chrome-devtools-frontend.appspot.com/serve_rev/@";
const RELAY_LIFETIME = Duration.hours(1);

/**
 * Chrome refuses debugger connections that carry a web Origin, and every browser sends one, so the
 * hub relays them. A token is handed out only by the authenticated target listing and names one
 * page, which keeps the relay from reaching any other loopback socket.
 */
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

/** The page debugger a relay token opens, while the token is current. */
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

/** The frontend matching the device browser's version; the client adds where to connect. */
const frontendUrl = (page: typeof CdpPage.Type, version: typeof CdpVersion.Type) => {
  if (page.devtoolsFrontendUrl?.startsWith("http")) {
    const url = new URL(page.devtoolsFrontendUrl);
    url.search = "";
    return url.toString();
  }
  const revision = version["WebKit-Version"]?.match(/@([0-9a-f]{40})/)?.[1] ?? "";
  return `${FALLBACK_FRONTEND}${revision}/inspector.html`;
};

const listAndroid = Effect.fn("DeviceInspect.listAndroid")(function* (
  http: HttpClient.HttpClient,
  random: SecureRandom.SecureRandom["Service"],
  run: Runner,
  serial: string,
) {
  const sockets = yield* run("adb", ["-s", serial, "shell", "cat", "/proc/net/unix"]).pipe(
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
        const port = yield* forwardSocket(run, serial, socket);
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
                frontendUrl: frontendUrl(page, version),
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

export const listInspectTargets = Effect.fn("DeviceInspect.list")(function* (input: {
  readonly http: HttpClient.HttpClient | null;
  readonly random: SecureRandom.SecureRandom["Service"] | null;
  readonly ready: DeviceHostReady;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly isLocalHost: boolean;
}): Effect.fn.Return<
  { readonly unsupported: string | null; readonly targets: ReadonlyArray<DeviceInspectTarget> },
  DeviceOperationError
> {
  // Forwarded ports open on the host, which the client reaches only when they share a machine.
  if (!input.isLocalHost)
    return { unsupported: "Web inspection works only for devices on this machine.", targets: [] };
  if (input.platform !== "android")
    return { unsupported: "Web inspection is available for Android devices.", targets: [] };
  if (input.http === null || input.random === null)
    return { unsupported: "Web inspection is unavailable in this server.", targets: [] };
  return {
    unsupported: null,
    targets: yield* listAndroid(input.http, input.random, input.ready.run, input.deviceId),
  };
});
