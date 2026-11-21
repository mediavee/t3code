import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { threadFleetAtom } from "../../state/threads";
import { useOpenThreadLink } from "./useOpenThreadLink";

/** Where the children this thread started stand, so nobody has to ask. */
export function ThreadFleetStrip({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const fleet = useAtomValue(threadFleetAtom(threadRef));
  const openThread = useOpenThreadLink(threadRef?.environmentId ?? null);
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
    <View
      accessibilityLabel={gt("Child threads")}
      className="flex-row flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2"
    >
      {firstBlocked !== null ? (
        <Button
          label={gt(
            "{count, plural, one {{count} waiting for an answer} other {{count} waiting for an answer}}",
            { count: fleet.blocked },
          )}
          tone="text"
          size="compact"
          onPress={() => openThread(firstBlocked)}
        />
      ) : null}
      {counts.map((label) => (
        <Text key={label} className="text-xs text-foreground-muted">
          {label}
        </Text>
      ))}
    </View>
  );
}
