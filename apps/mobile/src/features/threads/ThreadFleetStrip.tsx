import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { threadFleetAtom } from "../../state/threads";
import { useOpenThreadLink } from "./useOpenThreadLink";

/** Where the children this thread started stand, so nobody has to ask. */
export function ThreadFleetStrip({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const fleet = useAtomValue(threadFleetAtom(threadRef));
  const gt = useGT();
  if (threadRef === null || fleet === null) return null;
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
      className={cn(
        "flex-row flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2",
        Platform.OS === "android" ? "bg-thread-canvas" : "bg-screen",
      )}
    >
      {fleet.firstBlocked !== null ? (
        <WaitingChip
          via={threadRef}
          child={fleet.firstBlocked}
          label={gt(
            "{count, plural, one {{count} waiting for an answer} other {{count} waiting for an answer}}",
            { count: fleet.blocked },
          )}
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

function WaitingChip(props: {
  readonly via: ScopedThreadRef;
  readonly child: ScopedThreadRef;
  readonly label: string;
}) {
  const openThread = useOpenThreadLink(props.via.environmentId);
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={{ top: 8, bottom: 8 }}
      className="rounded-full border border-warning-border bg-warning px-2.5 py-1"
      onPress={() => openThread(props.child)}
    >
      <Text className="text-xs text-warning-foreground">{props.label}</Text>
    </Pressable>
  );
}
