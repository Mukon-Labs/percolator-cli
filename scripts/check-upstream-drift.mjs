#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    workspace: resolve(scriptDirectory, "../.."),
    manifest: resolve(scriptDirectory, "../upstream-sync.json"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace" || argument === "--manifest") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a path`);
      }
      options[argument.slice(2)] = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return options;
}

function git(repository, args, allowFailure = false) {
  if (allowFailure) {
    return spawnSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function validateEntry(entry) {
  for (const key of ["name", "relativePath", "upstreamRef", "auditedUpstreamSha", "policy"]) {
    if (typeof entry[key] !== "string" || entry[key].length === 0) {
      throw new Error(`invalid ${key} for upstream entry ${entry.name ?? "<unnamed>"}`);
    }
  }
}

function isAncestor(repository, ancestor, descendant) {
  return git(repository, ["merge-base", "--is-ancestor", ancestor, descendant], true).status === 0;
}

function inspectEntry(workspace, entry) {
  validateEntry(entry);
  const repository = resolve(workspace, entry.relativePath);
  const tip = git(repository, ["rev-parse", "--verify", `${entry.upstreamRef}^{commit}`]);
  git(repository, ["cat-file", "-e", `${entry.auditedUpstreamSha}^{commit}`]);

  const result = { entry, repository, tip, state: "current", commits: [] };
  if (tip !== entry.auditedUpstreamSha) {
    if (isAncestor(repository, entry.auditedUpstreamSha, tip)) {
      result.state = "advanced";
      result.commits = git(repository, [
        "log",
        "--oneline",
        "--no-decorate",
        `${entry.auditedUpstreamSha}..${tip}`,
      ]).split("\n").filter(Boolean);
    } else if (isAncestor(repository, tip, entry.auditedUpstreamSha)) {
      result.state = "rewound";
    } else {
      result.state = "diverged";
    }
  }

  if (entry.requiredAncestorOf) {
    git(repository, ["cat-file", "-e", `${entry.requiredAncestorOf}^{commit}`]);
    result.requiredAncestorPresent = isAncestor(
      repository,
      entry.auditedUpstreamSha,
      entry.requiredAncestorOf,
    );
  }

  return result;
}

export function checkWorkspace({ workspace, manifest }) {
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.repositories)) {
    throw new Error("unsupported or invalid upstream-sync manifest");
  }

  const candidates = Array.isArray(parsed.watchedCandidateRefs)
    ? parsed.watchedCandidateRefs
    : [];
  const required = parsed.repositories.map((entry) => ({ ...entry, candidate: false }));
  const watched = candidates.map((entry) => ({ ...entry, candidate: true }));
  const results = [...required, ...watched].map((entry) => inspectEntry(workspace, entry));

  let drift = false;
  let invalidCompatibility = false;
  for (const result of results) {
    const label = result.entry.candidate ? "WATCH" : "MAIN";
    if (result.state === "current") {
      console.log(`OK    ${label} ${result.entry.name}: ${result.tip.slice(0, 12)}`);
    } else {
      drift = true;
      console.log(
        `DRIFT ${label} ${result.entry.name}: ${result.state} from ` +
          `${result.entry.auditedUpstreamSha.slice(0, 12)} to ${result.tip.slice(0, 12)}`,
      );
      for (const commit of result.commits.slice(0, 25)) {
        console.log(`      ${commit}`);
      }
      if (result.commits.length > 25) {
        console.log(`      ... ${result.commits.length - 25} more commit(s)`);
      }
    }

    if (result.requiredAncestorPresent === false) {
      invalidCompatibility = true;
      console.log(
        `ERROR ${result.entry.name}: audited upstream commit is not contained by ` +
          `${result.entry.requiredAncestorOf}`,
      );
    }
  }

  return invalidCompatibility ? 3 : drift ? 2 : 0;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(
        "Usage: node scripts/check-upstream-drift.mjs " +
          "[--workspace PATH] [--manifest PATH]",
      );
      return 0;
    }
    return checkWorkspace(options);
  } catch (error) {
    console.error(`upstream drift check failed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
