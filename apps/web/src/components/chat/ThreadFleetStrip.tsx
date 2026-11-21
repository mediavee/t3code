import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { threadFleetAtom } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";

/** Where the children this thread started stand, so nobody has to ask. */
export function ThreadFleetStrip({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const fleet = useAtomValue(threadFleetAtom(threadRef));
  const navigate = useNavigate();
  const gt = useGT();
  if (fleet === null) return null;
  const firstBlocked = fleet.firstBlocked;
  const counts = [
    fleet.running > 0 &&
      gt("{count, plural, one {{count} running} other {{count} running}}", {
        count: fleet.running,
      }),
    fleet.failed > 0 &&
      gt("{count, plural, one {{count} failed} other {{count} failed}}", { count: fleet.failed }),
    fleet.done > 0 &&
      gt("{count, plural, one {{count} done} other {{count} done}}", { count: fleet.done }),
    fleet.openPullRequests > 0 &&
      gt("{count, plural, one {{count} open PR} other {{count} open PRs}}", {
        count: fleet.openPullRequests,
      }),
  ].filter((label) => label !== false);
  return (
    <div
      role="group"
      aria-label={gt("Child threads")}
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground"
    >
      {firstBlocked !== null ? (
        <Button
          size="micro"
          variant="warning-outline"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(firstBlocked),
            })
          }
        >
          {gt(
            "{count, plural, one {{count} waiting for an answer} other {{count} waiting for an answer}}",
            { count: fleet.blocked },
          )}
        </Button>
      ) : null}
      {counts.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </div>
  );
}
