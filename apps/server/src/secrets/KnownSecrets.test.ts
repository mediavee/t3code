import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, SecretProviderId } from "@t3tools/contracts";
import * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as KnownSecrets from "./KnownSecrets.ts";
import * as SecretResolver from "./SecretResolver.ts";

const providerInstances = {
  [ProviderInstanceId.make("codex_work")]: {
    driver: ProviderDriverKind.make("codex"),
    environment: [
      { name: "OPENAI_API_KEY", value: "fake-env-key-2222", sensitive: true },
      { name: "CODEX_HOME", value: "/home/me/.codex-work", sensitive: false },
    ],
    config: {},
  },
};

it.effect("masks sensitive provider environment values, not the others", () =>
  Effect.gen(function* () {
    const known = yield* KnownSecrets.KnownSecrets;
    assert.deepEqual(yield* known.current, ["fake-env-key-2222"]);
  }).pipe(
    Effect.provide(
      KnownSecrets.layer.pipe(Layer.provide(ServerSettings.layerTest({ providerInstances }))),
    ),
  ),
);

it.effect("masks nothing once the setting is off", () =>
  Effect.gen(function* () {
    const known = yield* KnownSecrets.KnownSecrets;
    yield* known.remember(["fake-answer-1111"]);
    assert.isNull(yield* known.current);
  }).pipe(
    Effect.provide(
      KnownSecrets.layer.pipe(
        Layer.provide(
          ServerSettings.layerTest({ providerInstances, maskSecretsInToolOutput: false }),
        ),
      ),
    ),
  ),
);

it.effect("remembers each value read through a secret reference", () =>
  Effect.gen(function* () {
    const resolver = yield* SecretResolverCore.SecretResolver;
    const known = yield* KnownSecrets.KnownSecrets;
    const reference = { provider: SecretProviderId.make("vault"), reference: "fake://token" };
    assert.deepEqual(yield* resolver.read([reference, reference]), ["fake-vault-3333", undefined]);
    assert.deepEqual(yield* known.current, ["fake-vault-3333"]);
  }).pipe(
    Effect.provide(
      SecretResolver.rememberingReads(
        Layer.mock(SecretResolverCore.SecretResolver)({
          read: () => Effect.succeed(["fake-vault-3333", undefined]),
        }),
      ).pipe(Layer.provideMerge(KnownSecrets.layerTest())),
    ),
  ),
);
