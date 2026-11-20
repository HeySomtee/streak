import { execFileSync } from 'node:child_process';

/** Fixture tests run in their own Node process, never in the parent candidate hook. */
export function isolateFixtureGit() {
  const names = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
    .trim()
    .split(/\r?\n/);
  const local = new Set(names.map((name) => name.toUpperCase()));
  for (const name of Object.keys(process.env)) {
    if (local.has(name.toUpperCase()) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/i.test(name))
      delete process.env[name];
  }
}
