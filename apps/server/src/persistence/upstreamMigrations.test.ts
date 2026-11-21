// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { migrationManifest } from "./Migrations.ts";

// Numbered migrations belong to upstream: a fork row at an id would hide upstream's migration there
// after a sync. Fork schema goes in unnumbered hooks such as Migrations/ForkIndexes.ts.
// CI checkouts are shallow and have no upstream remote, so the tree is checked against this
// manifest; where upstream is fetched, the manifest is checked against the merge base.
const MANIFEST_PATH = NodePath.join(import.meta.dirname, "upstreamMigrations.json");
const MIGRATIONS_DIR = NodePath.join(import.meta.dirname, "Migrations");
const NUMBERED_MIGRATION = /^(\d+)_(\w+)\.ts$/;
const REGENERATE = `T3_UPDATE_UPSTREAM_MIGRATIONS=1 vp test run src/persistence/upstreamMigrations.test.ts`;

type Manifest = Readonly<Record<string, string>>;

const readManifest = (): Manifest => JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8"));

const sortById = (entries: ReadonlyArray<readonly [string, string]>): Manifest =>
  Object.fromEntries(
    entries.toSorted(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10)),
  );

const gitBlobId = (contents: Buffer) =>
  NodeCrypto.createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex");

const treeMigrations = () =>
  sortById(
    NodeFS.readdirSync(MIGRATIONS_DIR)
      .filter((name) => NUMBERED_MIGRATION.test(name))
      .map((name) => [name, gitBlobId(NodeFS.readFileSync(NodePath.join(MIGRATIONS_DIR, name)))]),
  );

const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: import.meta.dirname,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/** The commit the fork last merged from upstream, or undefined where upstream is not fetched. */
const upstreamMergeBase = () => {
  const ref = process.env.T3_UPSTREAM_REF ?? "upstream/main";
  try {
    return git(["merge-base", "HEAD", git(["rev-parse", "--verify", "--quiet", ref])]);
  } catch {
    return undefined;
  }
};

const mergeBaseMigrations = (commit: string) => {
  const root = git(["rev-parse", "--show-toplevel"]);
  const dir = NodePath.relative(root, MIGRATIONS_DIR).split(NodePath.sep).join("/");
  const migrations = sortById(
    git(["ls-tree", "--full-tree", commit, "--", `${dir}/`])
      .split("\n")
      .flatMap((line) => {
        const [meta, path] = line.split("\t");
        const name = path?.slice(dir.length + 1) ?? "";
        const blob = meta?.split(" ")[2];
        return NUMBERED_MIGRATION.test(name) && blob ? [[name, blob] as const] : [];
      }),
  );
  if (Object.keys(migrations).length === 0) throw new Error(`No migrations at ${commit}:${dir}.`);
  return migrations;
};

const mergeBase = upstreamMergeBase();

if (process.env.T3_UPDATE_UPSTREAM_MIGRATIONS === "1") {
  if (mergeBase === undefined) {
    throw new Error("Fetch upstream (or set T3_UPSTREAM_REF) to regenerate the manifest.");
  }
  // Written from upstream's tree, never the working tree, so it cannot bless a fork edit.
  NodeFS.writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify(mergeBaseMigrations(mergeBase), null, 2)}\n`,
  );
}

it("keeps the numbered migrations identical to upstream's", () => {
  const manifest = readManifest();
  assert.deepStrictEqual(
    treeMigrations(),
    manifest,
    `Numbered migrations differ from upstream's. Move fork schema to an unnumbered hook; after an upstream sync, run ${REGENERATE}.`,
  );
  assert.deepStrictEqual(
    migrationManifest,
    Object.keys(manifest).map((name) => {
      const [, id, migration] = NUMBERED_MIGRATION.exec(name)!;
      return [Number(id), migration] as const;
    }),
    "migrationEntries must list exactly upstream's numbered migrations.",
  );
});

it.skipIf(mergeBase === undefined)("matches upstream's migrations at the fork's merge base", () => {
  assert.deepStrictEqual(
    readManifest(),
    mergeBaseMigrations(mergeBase!),
    `The manifest is not upstream's at ${mergeBase}; run ${REGENERATE}.`,
  );
});
