// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { migrationManifest } from "./Migrations.ts";

// Numbered migrations belong to upstream: a fork row at an id would hide upstream's migration there
// after a sync. Fork schema goes in unnumbered hooks such as Migrations/ForkIndexes.ts.
// CI checkouts are shallow and have no upstream remote, so the tree is checked against this
// manifest; T3_UPSTREAM_REF (the upstream tag being merged) checks the manifest against that tag.
const MANIFEST_PATH = NodePath.join(import.meta.dirname, "upstreamMigrations.json");
const MIGRATIONS_DIR = NodePath.join(import.meta.dirname, "Migrations");
const NUMBERED_MIGRATION = /^(\d+)_(\w+)\.ts$/;
const REGENERATE =
  "T3_UPSTREAM_REF=<upstream tag> T3_UPDATE_UPSTREAM_MIGRATIONS=1 vp test run apps/server/src/persistence/upstreamMigrations.test.ts";

type Manifest = Readonly<Record<string, string>>;

const readManifest = (path: string): Manifest => JSON.parse(NodeFS.readFileSync(path, "utf8"));

const writeManifest = (path: string, manifest: Manifest) =>
  NodeFS.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

const sortById = (entries: ReadonlyArray<readonly [string, string]>): Manifest =>
  Object.fromEntries(
    entries.toSorted(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10)),
  );

const gitBlobId = (contents: Buffer) =>
  NodeCrypto.createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex");

const treeMigrations = (dir: string) =>
  sortById(
    NodeFS.readdirSync(dir)
      .filter((name) => NUMBERED_MIGRATION.test(name))
      .map((name) => [name, gitBlobId(NodeFS.readFileSync(NodePath.join(dir, name)))]),
  );

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** The numbered migrations in `ref`'s own tree, for the migrations directory `dir`. */
const refMigrations = (dir: string, ref: string) => {
  const root = git(dir, ["rev-parse", "--show-toplevel"]);
  const relative = NodePath.relative(root, dir).split(NodePath.sep).join("/");
  const migrations = sortById(
    git(dir, ["ls-tree", "--full-tree", ref, "--", `${relative}/`])
      .split("\n")
      .flatMap((line) => {
        const [meta, path] = line.split("\t");
        const name = path?.slice(relative.length + 1) ?? "";
        const blob = meta?.split(" ")[2];
        return NUMBERED_MIGRATION.test(name) && blob ? [[name, blob] as const] : [];
      }),
  );
  if (Object.keys(migrations).length === 0) throw new Error(`No migrations at ${ref}:${relative}.`);
  return migrations;
};

const upstreamRef = process.env.T3_UPSTREAM_REF?.trim() || undefined;

if (process.env.T3_UPDATE_UPSTREAM_MIGRATIONS === "1") {
  if (upstreamRef === undefined) {
    throw new Error(`Set T3_UPSTREAM_REF to the upstream tag being merged: ${REGENERATE}`);
  }
  // Written from upstream's tree, never the working tree, so it cannot bless a fork edit.
  writeManifest(MANIFEST_PATH, refMigrations(MIGRATIONS_DIR, upstreamRef));
}

it("keeps the numbered migrations identical to upstream's", () => {
  const manifest = readManifest(MANIFEST_PATH);
  assert.deepStrictEqual(
    treeMigrations(MIGRATIONS_DIR),
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

it.skipIf(upstreamRef === undefined)("matches upstream's migrations at T3_UPSTREAM_REF", () => {
  assert.deepStrictEqual(
    readManifest(MANIFEST_PATH),
    refMigrations(MIGRATIONS_DIR, upstreamRef!),
    `The manifest is not upstream's at ${upstreamRef}; run ${REGENERATE}.`,
  );
});

it("compares and regenerates the manifest from a ref's own tree", () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upstream-migrations-"));
  try {
    const dir = NodePath.join(repo, "Migrations");
    const manifestPath = NodePath.join(repo, "manifest.json");
    const commit = (tag: string) => {
      git(repo, ["add", "-A"]);
      git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", tag]);
      git(repo, ["tag", tag]);
    };
    git(repo, ["init", "-q"]);
    NodeFS.mkdirSync(dir);
    NodeFS.writeFileSync(NodePath.join(dir, "001_First.ts"), "export default 1;\n");
    commit("older");
    NodeFS.writeFileSync(NodePath.join(dir, "002_Second.ts"), "export default 2;\n");
    NodeFS.writeFileSync(NodePath.join(dir, "ForkIndexes.ts"), "export default 0;\n");
    commit("newer");
    // A fork edit after the tag must not reach the regenerated manifest.
    NodeFS.writeFileSync(NodePath.join(dir, "002_Second.ts"), "export default 3;\n");

    writeManifest(manifestPath, refMigrations(dir, "newer"));
    const manifest = readManifest(manifestPath);
    assert.deepStrictEqual(Object.keys(manifest), ["001_First.ts", "002_Second.ts"]);
    assert.notDeepEqual(refMigrations(dir, "older"), manifest);
    assert.deepStrictEqual(refMigrations(dir, "newer"), manifest);
    assert.notDeepEqual(treeMigrations(dir), manifest);
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});
