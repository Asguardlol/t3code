// WebKit's open-source Web Inspector, served from T3's origin with T3's own host object so it
// runs in any browser.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../config.ts";

// WebKit main on 2026-11-19.
const WEBKIT_COMMIT = "c27308aa0db06a3d82fba02e177a42e1fb0b0f20";
const UI_DIRECTORY = "Source/WebInspectorUI/UserInterface";

// iOS versions with a protocol description (Protocol/Legacy/iOS/<version>) at this commit.
const PROTOCOL_VERSIONS = [
  "13.0",
  "13.4",
  "14.0",
  "14.5",
  "15.0",
  "15.4",
  "16.0",
  "16.4",
  "17.0",
  "17.2",
  "17.4",
  "18.0",
  "18.2",
  "18.4",
  "26.0",
  "26.2",
  "26.4",
  "27.0",
  "27.3",
] as const;

const versionNumber = (version: string) => {
  const match = version.match(/(\d+)(?:\.(\d+))?/);
  return match ? Number(match[1]) * 1000 + Number(match[2] ?? 0) : null;
};

// A protocol description newer than the device names commands the device lacks.
export const webKitFrontendPath = (deviceVersion: string) => {
  const device = versionNumber(deviceVersion);
  const protocol =
    device === null
      ? PROTOCOL_VERSIONS.at(-1)!
      : (PROTOCOL_VERSIONS.findLast((version) => versionNumber(version)! <= device) ??
        PROTOCOL_VERSIONS[0]);
  return `/inspect-webkit/Main.html?protocol=${protocol}`;
};

const SKIPPED = /^(?:Test\/|Test\.html$|TestStub\.html$|Protocol\/Legacy\/macOS\/)/;

const GitHubEntry = Schema.Struct({ name: Schema.String, sha: Schema.String, type: Schema.String });
const GitHubTree = Schema.Struct({
  truncated: Schema.Boolean,
  tree: Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.String })),
});

const downloadLock = Semaphore.makeUnsafe(1);

class WebKitDownloadError extends Schema.TaggedError<WebKitDownloadError>()("WebKitDownloadError", {
  step: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not download WebKit's Web Inspector while ${this.step}.`;
  }
}

const download = Effect.fn("DeviceInspectWebKit.download")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = HttpClient.withScope(yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeader("user-agent", "t3code")),
    HttpClient.filterStatusOk,
  );
  const getJson = <S extends Schema.Top>(step: string, url: string, schema: S) =>
    http.get(url).pipe(
      Effect.flatMap((response) => response.text),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.scoped,
      Effect.mapError((cause) => new WebKitDownloadError({ step, cause })),
    );
  const api = "https://api.github.com/repos/WebKit/WebKit";
  const parent = yield* getJson(
    "listing the inspector folder",
    `${api}/contents/${path.dirname(UI_DIRECTORY)}?ref=${WEBKIT_COMMIT}`,
    Schema.Array(GitHubEntry),
  );
  const folder = parent.find((entry) => entry.name === path.basename(UI_DIRECTORY));
  if (folder === undefined)
    return yield* new WebKitDownloadError({
      step: "finding the inspector folder",
      cause: new Error(`${UI_DIRECTORY} is missing at ${WEBKIT_COMMIT}`),
    });
  const tree = yield* getJson(
    "listing the inspector files",
    `${api}/git/trees/${folder.sha}?recursive=1`,
    GitHubTree,
  );
  if (tree.truncated)
    return yield* new WebKitDownloadError({
      step: "listing the inspector files",
      cause: new Error("GitHub truncated the file list"),
    });
  const staging = `${directory}.partial`;
  yield* fs.remove(staging, { recursive: true, force: true });
  yield* Effect.forEach(
    tree.tree.filter((entry) => entry.type === "blob" && !SKIPPED.test(entry.path)),
    (entry) =>
      http
        .get(
          `https://raw.githubusercontent.com/WebKit/WebKit/${WEBKIT_COMMIT}/${UI_DIRECTORY}/${entry.path}`,
        )
        .pipe(
          Effect.flatMap((response) => response.arrayBuffer),
          Effect.scoped,
          Effect.mapError((cause) => new WebKitDownloadError({ step: entry.path, cause })),
          Effect.flatMap((body) =>
            Effect.gen(function* () {
              const file = path.join(staging, ...entry.path.split("/"));
              yield* fs.makeDirectory(path.dirname(file), { recursive: true });
              yield* fs.writeFile(file, new Uint8Array(body));
            }),
          ),
        ),
    { concurrency: 16, discard: true },
  );
  yield* fs.rename(staging, directory);
});

const uiDirectory = Effect.fn("DeviceInspectWebKit.uiDirectory")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(config.stateDir, "caches", "webkit-inspector", WEBKIT_COMMIT);
  if (yield* fs.exists(directory)) return directory;
  // Concurrent page loads wait for one download.
  return yield* downloadLock.withPermit(
    Effect.gen(function* () {
      if (!(yield* fs.exists(directory))) yield* download(directory);
      return directory;
    }),
  );
});

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
};

const HOST_SCRIPT = "T3InspectorHost.js";
const extensionOf = (file: string) => file.slice(file.lastIndexOf("."));

const IMMUTABLE = { "cache-control": "public, max-age=86400, immutable" };

export const serveWebKitFile = Effect.fn("DeviceInspectWebKit.serve")(function* (file: string) {
  if (file.split("/").some((segment) => segment === "" || segment.startsWith(".")))
    return HttpServerResponse.text("Not Found", { status: 404 });
  // Apple's internal additions, absent from every public build.
  if (file.startsWith("WebKitAdditions/"))
    return HttpServerResponse.text("", {
      contentType: CONTENT_TYPES[extensionOf(file)] ?? "text/plain",
      headers: IMMUTABLE,
    });
  if (file === HOST_SCRIPT)
    return HttpServerResponse.text(INSPECTOR_HOST, {
      contentType: CONTENT_TYPES[".js"]!,
      headers: { "cache-control": "no-cache" },
    });
  // Optional so the hub proxy runs without it, as in its tests.
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  if (Option.isNone(config)) return HttpServerResponse.text("Not Found", { status: 404 });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* uiDirectory(config.value);
  const location = path.join(directory, ...file.split("/"));
  if (!(yield* fs.exists(location))) return HttpServerResponse.text("Not Found", { status: 404 });
  const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  if (file === "Main.html") {
    // The host has to exist before the UI's first scripts ask it for strings and protocol files.
    const page = (yield* fs.readFileString(location)).replace(
      '<script src="Base/WebInspector.js"></script>',
      `$&\n    <script src="${HOST_SCRIPT}"></script>`,
    );
    return HttpServerResponse.text(page, { contentType, headers: { "cache-control": "no-cache" } });
  }
  return HttpServerResponse.uint8Array(yield* fs.readFile(location), {
    contentType,
    headers: IMMUTABLE,
  });
});

// What Safari provides natively, for a web page: WebCore/inspector/InspectorFrontendHost.idl.
const INSPECTOR_HOST = String.raw`"use strict";
(() => {
  const params = new URLSearchParams(location.search);
  const protocol = /^\d+\.\d+$/.test(params.get("protocol") || "") ? params.get("protocol") : null;
  const target = params.get("wss") ? "wss://" + params.get("wss") : params.get("ws") ? "ws://" + params.get("ws") : null;
  const platform = /Mac/.test(navigator.platform) ? "mac" : /Win/.test(navigator.platform) ? "windows" : "linux";
  const pending = [];
  let socket = null;
  let zoom = 1;

  // There is no localized strings file outside Safari; the UI then shows its English strings.
  WI.dontLocalizeUserInterface = true;

  // WebKit-only CSS OM the UI falls back to when computedStyleMap has no number.
  window.CSSPrimitiveValue ??= { CSS_PX: 5 };
  CSSStyleDeclaration.prototype.getPropertyCSSValue ??= function (property) {
    const value = parseFloat(this.getPropertyValue(property));
    return Number.isNaN(value) ? null : { getFloatValue: () => value };
  };

  const disconnected = (reason) => {
    document.title = "Disconnected · Web Inspector";
    if (window.WI && WI.Toast) WI.Toast.show?.(reason);
    else console.warn(reason);
  };

  window.InspectorFrontendHost = {
    connect() {
      if (!target) return disconnected("No page to inspect: the address has no ws parameter.");
      socket = new WebSocket(target);
      socket.addEventListener("open", () => {
        for (const message of pending.splice(0)) socket.send(message);
      });
      socket.addEventListener("message", (event) => InspectorFrontendAPI.dispatchMessageAsync(event.data));
      socket.addEventListener("close", () => disconnected("The page closed or the device disconnected."));
    },
    sendMessageToBackend(message) {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(message);
      else pending.push(message);
    },

    isRemote: true,
    localizedStringsURL: "",
    backendCommandsURL: protocol ? "Protocol/Legacy/iOS/" + protocol + "/InspectorBackendCommands.js" : "",
    inspectionLevel: 1,
    debuggableInfo: {
      debuggableType: "web-page",
      targetPlatformName: "iOS",
      targetBuildVersion: "",
      targetProductVersion: protocol || "",
      targetIsSimulator: params.get("simulator") !== "0",
    },
    platform,
    platformVersionName: "",
    supportsShowCertificate: false,
    supportsDiagnosticLogging: false,
    supportsWebExtensions: false,

    loaded() {},
    closeWindow() {},
    reopen() { location.reload(); },
    reset() { location.reload(); },
    bringToFront() {},
    inspectedURLChanged(title) { document.title = title + " · Web Inspector"; },
    showCertificate() { return false; },
    setZoomFactor(factor) { zoom = factor; document.documentElement.style.zoom = String(factor); },
    zoomFactor() { return zoom; },
    setForcedAppearance() {},
    userInterfaceLayoutDirection() { return document.dir === "rtl" ? "rtl" : "ltr"; },
    supportsDockSide() { return false; },
    requestSetDockSide() {},
    setAttachedWindowHeight() {},
    setAttachedWindowWidth() {},
    setSheetRect() {},
    startWindowDrag() {},
    moveWindowBy() {},
    copyText(text) { navigator.clipboard?.writeText(text); },
    killText() {},
    openURLExternally(url) { window.open(url, "_blank", "noopener"); },
    revealFileExternally() {},
    requestDisableSiteIsolation() {},
    canSave() { return true; },
    save(saveDatas) {
      for (const data of saveDatas) {
        const bytes = data.base64Encoded ? Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0)) : data.content;
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([bytes]));
        link.download = (data.url || "web-inspector").split("/").pop() || "web-inspector";
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 0);
      }
    },
    canLoad() { return false; },
    load() { return Promise.reject(new Error("Loading files is unavailable here.")); },
    canPickColorFromScreen() { return false; },
    pickColorFromScreen() { return Promise.reject(new Error("Unavailable here.")); },
    showContextMenu(event, items) { new WI.SoftContextMenu(items).show(event); },
    dispatchEventAsContextMenuEvent() {},
    unbufferedLog(message) { console.log(message); },
    isUnderTest() { return false; },
    beep() {},
    inspectInspector() {},
    isBeingInspected() { return false; },
    setAllowsInspectingInspector() {},
    engineeringSettingsAllowed() { return false; },
    getPath(value) { return value instanceof File ? value.name : new Path2D(); },
    getCurrentX() { return 0; },
    getCurrentY() { return 0; },
    setPath() {},
  };
})();
`;
