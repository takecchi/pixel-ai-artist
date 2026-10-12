/**
 * The bootstrap a git-installed plugin runs once, kept out of the entry point
 * so a test can read it without executing npm.
 *
 * `npm ci`, not `npm install`: a git install carries package-lock.json, and
 * `ci` refuses to resolve anything the lockfile did not pin. `--ignore-scripts`
 * because dependency lifecycle scripts are the remote-code half of a
 * supply-chain compromise and nothing here needs them: CI's `launcher` job
 * builds this same tree under exactly these flags.
 */
export function buildSteps() {
  return [
    ["ci", "--silent", "--no-audit", "--no-fund", "--ignore-scripts"],
    ["run", "--silent", "build"],
  ];
}
