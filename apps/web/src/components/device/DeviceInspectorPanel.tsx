import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { DeviceInspectTarget, DeviceSummary, EnvironmentId } from "@t3tools/contracts";
import { ChevronLeft, RefreshCw, X } from "lucide-react";
import { T, useGT } from "gt-react";
import { useEffect, useEffectEvent, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

// Through the hub, since browsers keep a public page from opening loopback sockets.
const inspectorUrl = (target: DeviceInspectTarget, access: DeviceHubAccess) => {
  const socket = new URL(`${access.wsBase}/inspect/${target.relayToken}`);
  const url = new URL(`${access.httpBase}${target.frontendPath}`);
  url.searchParams.set(socket.protocol === "wss:" ? "wss" : "ws", socket.host + socket.pathname);
  return url.toString();
};

export function DeviceInspectorPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly device: DeviceSummary;
  readonly access: DeviceHubAccess | null;
  readonly onClose: () => void;
  readonly className?: string;
}) {
  const gt = useGT();
  const listTargets = useAtomCommand(deviceEnvironment.inspectTargets, { reportFailure: false });
  const [targets, setTargets] = useState<ReadonlyArray<DeviceInspectTarget> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<DeviceInspectTarget | null>(null);
  const { environmentId } = props;
  const { hostId, id: deviceId } = props.device;

  const load = () =>
    listTargets({ environmentId, input: { hostId, deviceId } })
      .then((result) => {
        if (result._tag === "Success") {
          setTargets(result.value.targets);
          setNotice(result.value.unsupported);
        } else {
          setTargets([]);
          setNotice(formatEnvironmentQueryError(result.cause));
        }
      })
      .finally(() => setLoading(false));
  const refresh = () => {
    setLoading(true);
    void load();
  };

  const loadOnOpen = useEffectEvent(() => void load());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists the device's open pages when the pane opens; the parent keys it by device
  useEffect(() => {
    loadOnOpen();
  }, []);

  return (
    <div
      className={cn("flex min-h-0 flex-col border-border bg-background text-sm", props.className)}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
        {selected ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Back to pages")}
            onClick={() => setSelected(null)}
          >
            <ChevronLeft />
          </Button>
        ) : null}
        <span className="min-w-0 truncate font-medium">
          {selected ? selected.title : <T>Inspect web content</T>}
        </span>
        {selected ? (
          <span className="shrink-0 truncate text-xs text-muted-foreground">{selected.owner}</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {selected ? null : (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={gt("Refresh pages")}
              disabled={loading}
              onClick={refresh}
            >
              {loading ? <Spinner size="sm" /> : <RefreshCw />}
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Close inspector")}
            onClick={props.onClose}
          >
            <X />
          </Button>
        </div>
      </div>
      {selected && props.access ? (
        <iframe
          key={selected.id}
          title={gt("DevTools for {title}", { title: selected.title })}
          src={inspectorUrl(selected, props.access)}
          className="min-h-0 w-full flex-1 border-0 bg-background"
          // oxlint-disable-next-line react/iframe-missing-sandbox -- DevTools needs script and its own storage
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {notice ? (
            <p className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{notice}</p>
          ) : null}
          {targets === null ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <Spinner size="sm" /> <T>Looking for web pages…</T>
            </div>
          ) : targets.length === 0 && notice === null ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              <T>
                No web pages are open. Open one in a browser or an app's web view on the device,
                then refresh.
              </T>
            </p>
          ) : (
            <ul className="flex flex-col">
              {targets.map((target) => (
                <li key={target.id} className="border-b last:border-b-0">
                  <button
                    type="button"
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    onClick={() => setSelected(target)}
                  >
                    <span className="truncate font-medium">{target.title}</span>
                    <span className="truncate text-xs text-muted-foreground">{target.url}</span>
                    <span className="text-xs text-muted-foreground">{target.owner}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
