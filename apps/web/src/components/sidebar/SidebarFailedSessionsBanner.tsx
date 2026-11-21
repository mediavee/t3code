import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { m } from "~/i18n/messages";
import { useQuietThreadShells, useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  failedSessionsGroups,
  failedSessionsSince,
  type FailedSessionsGroup,
} from "./failedSessionsBanner.logic";

/** Offers Resume all while sessions failed on a provider error in the last hour. */
export function SidebarFailedSessionsBanner() {
  const shells = useQuietThreadShells();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [resumedAt, setResumedAt] = useState<ReadonlyMap<EnvironmentId, number>>(() => new Map());
  const { groups, expiresAtMs } = failedSessionsGroups(shells, nowMs, resumedAt);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the count follows the wall clock, which React cannot observe
  useEffect(() => {
    if (expiresAtMs === null) return;
    const timer = setTimeout(() => setNowMs(Date.now()), Math.max(0, expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAtMs]);

  return groups.map((group) => (
    <FailedSessionsResume
      key={group.environmentId}
      group={group}
      onResumed={(atMs) =>
        setResumedAt((current) => new Map(current).set(group.environmentId, atMs))
      }
    />
  ));
}

function FailedSessionsResume({
  group,
  onResumed,
}: {
  group: FailedSessionsGroup;
  onResumed: (atMs: number) => void;
}) {
  const t = useMessages();
  const resume = useAtomCommand(orchestrationEnvironment.resumeFailedThreads);
  const permitted = useAtomValue(
    orchestrationEnvironment.resumeFailedThreads.permissionAtom(group.environmentId),
  );
  const supported =
    useServerConfigs().get(group.environmentId)?.environment.capabilities.failedThreadsResume ===
    true;
  const [pending, setPending] = useState(false);
  if (!permitted || !supported) return null;

  const resumeAll = async () => {
    setPending(true);
    const clickedAtMs = Date.now();
    const result = await resume({
      environmentId: group.environmentId,
      input: { since: failedSessionsSince(clickedAtMs) },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add({
        type: "error",
        title: m(msg("Could not resume the failed sessions")),
        description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
      });
      return;
    }
    onResumed(clickedAtMs);
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 text-2xs leading-6 text-warning">
      <TriangleAlertIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        {t(
          msg(
            "{count, plural, one {{count} session failed in the last hour} other {{count} sessions failed in the last hour}}",
          ),
          { count: group.count },
        )}
      </span>
      <span aria-hidden>·</span>
      <InlineButton className="shrink-0" disabled={pending} onClick={() => void resumeAll()}>
        {t(msg("Resume all"))}
      </InlineButton>
    </div>
  );
}
