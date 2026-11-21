import * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as KnownSecrets from "./KnownSecrets.ts";
import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "./secretProviderDefinitions.ts";
import * as Settings from "../serverSettings.ts";

const layerCore = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    return SecretResolverCore.layer({
      drivers: BUILT_IN_SECRET_PROVIDER_DRIVER_LIST,
      secretProviders: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.secretProviders),
        Effect.orElseSucceed((): ServerSettings["secretProviders"] => ({})),
      ),
    });
  }),
);

/** Every value read through a secret reference becomes one tool output is masked for. */
export const rememberingReads = <E, R>(
  core: Layer.Layer<SecretResolverCore.SecretResolver, E, R>,
) =>
  Layer.effect(
    SecretResolverCore.SecretResolver,
    Effect.gen(function* () {
      const resolver = yield* SecretResolverCore.SecretResolver;
      const known = yield* KnownSecrets.KnownSecrets;
      return SecretResolverCore.SecretResolver.of({
        ...resolver,
        read: Effect.fn("SecretResolver.read")(function* (references, options) {
          const values = yield* resolver.read(references, options);
          yield* known.remember(values.filter((value) => value !== undefined));
          return values;
        }),
      });
    }),
  ).pipe(Layer.provide(core));

export const layer = rememberingReads(layerCore).pipe(Layer.provideMerge(KnownSecrets.layer));
