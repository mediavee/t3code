// Values T3 knows are secret, so tool output that prints one can be masked. Memory only: a value
// is never written anywhere by this service, and a restart forgets request_secret answers.
import type { ServerSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Settings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import { knownSecretValues } from "./secretRedaction.ts";

export class KnownSecrets extends Context.Service<
  KnownSecrets,
  {
    readonly remember: (values: ReadonlyArray<string>) => Effect.Effect<void>;
    /** The values to mask, longest first, or null while masking is turned off. */
    readonly current: Effect.Effect<ReadonlyArray<string> | null>;
  }
>()("t3/secrets/KnownSecrets") {}

function sensitiveEnvironmentValues(settings: ServerSettings): string[] {
  return Object.values(settings.providerInstances).flatMap((instance) =>
    (instance.environment ?? []).flatMap((variable) =>
      variable.sensitive && typeof variable.value === "string" && variable.value !== SECRET_REDACTED
        ? [variable.value]
        : [],
    ),
  );
}

/** `settings` undefined masks with no setting: on, without provider environments. */
const make = Effect.fn("KnownSecrets.make")(function* (
  settings: Effect.Effect<ServerSettings | undefined>,
  initial: ReadonlyArray<string> = [],
) {
  const remembered = new Set<string>(knownSecretValues(initial));
  let cache: { readonly settings: ServerSettings; readonly values: string[] } | undefined;

  const remember: KnownSecrets["Service"]["remember"] = (values) =>
    Effect.sync(() => {
      for (const value of knownSecretValues(values)) {
        if (remembered.has(value)) continue;
        remembered.add(value);
        cache = undefined;
      }
    });

  const current: KnownSecrets["Service"]["current"] = settings.pipe(
    Effect.map((snapshot) => {
      if (snapshot === undefined) return knownSecretValues(remembered);
      if (!snapshot.maskSecretsInToolOutput) return null;
      if (cache?.settings !== snapshot) {
        cache = {
          settings: snapshot,
          values: knownSecretValues([...remembered, ...sensitiveEnvironmentValues(snapshot)]),
        };
      }
      return cache.values;
    }),
  );

  return KnownSecrets.of({ remember, current });
});

export const layer = Layer.effect(
  KnownSecrets,
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    // Unreadable settings still mask what this server was given.
    return yield* make(settings.getSettings.pipe(Effect.orElseSucceed(() => undefined)));
  }),
);

/** Masking on, with `values` already known and no settings to read. */
export const layerTest = (values: ReadonlyArray<string> = []) =>
  Layer.effect(KnownSecrets, make(Effect.undefined, values));
