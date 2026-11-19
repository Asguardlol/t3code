import { describe, expect, it } from "vite-plus/test";

import { webKitFrontendPath } from "./DeviceInspectWebKit.ts";

const protocolFor = (version: string) =>
  new URLSearchParams(webKitFrontendPath(version).split("?")[1]).get("protocol");

describe("webKitFrontendPath", () => {
  it("uses the newest protocol description the device is not older than", () => {
    expect(protocolFor("18.2")).toBe("18.2");
    expect(protocolFor("18.3.1")).toBe("18.2");
    expect(protocolFor("iOS 26.1")).toBe("26.0");
  });

  it("falls back to the closest description outside the known range", () => {
    expect(protocolFor("12.4")).toBe("13.0");
    expect(protocolFor("28.0")).toBe("27.3");
    expect(protocolFor("")).toBe("27.3");
  });
});
