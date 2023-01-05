import {
  getMonorepoDefaultSettings,
  LocalFileSystemDetector,
  MissingBuildPipeline,
  MissingBuildTarget,
} from '../src';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { FixtureFilesystem } from './utils/fixture-filesystem';

describe('getMonorepoDefaultSettings', () => {
  test('MissingBuildTarget is an error', () => {
    const missingBuildTarget = new MissingBuildTarget();
    expect(missingBuildTarget).toBeInstanceOf(Error);
    expect(missingBuildTarget.message).toBe(
      'Missing required `build` target in either nx.json, project.json, or package.json Nx configuration.'
    );
  });
  test('MissingBuildPipeline is an error', () => {
    const missingBuildPipeline = new MissingBuildPipeline();
    expect(missingBuildPipeline).toBeInstanceOf(Error);
    expect(missingBuildPipeline.message).toBe(
      'Missing required `build` pipeline in turbo.json or package.json Turbo configuration.'
    );
  });

  test.each([
    ['turbo', 'turbo'],
    ['turbo-package-config', 'turbo'],
    ['nx', 'nx'],
    ['nx-package-config', 'nx'],
    ['nx-project-and-package-config-1', 'nx'],
    ['nx-project-and-package-config-2', 'nx'],
    ['nx-project-config', 'nx'],
  ])('fixture %s', async (fixture, expectedResultKey) => {
    const expectedResultMap: Record<string, Record<string, string>> = {
      turbo: {
        monorepoManager: 'turbo',
        buildCommand: 'cd ../.. && npx turbo run build --filter=app-1...',
        installCommand: 'cd ../.. && yarn install',
        commandForIgnoringBuildStep: 'cd ../.. && npx turbo-ignore',
      },
      nx: {
        monorepoManager: 'nx',
        buildCommand: 'cd ../.. && npx nx build app-1',
        installCommand: 'cd ../.. && yarn install',
      },
    };

    const ffs = new FixtureFilesystem(
      path.join(__dirname, 'fixtures', 'get-monorepo-default-settings', fixture)
    );
    const result = await getMonorepoDefaultSettings(
      'app-1',
      'packages/app-1',
      '../..',
      ffs
    );
    expect(result).toStrictEqual(expectedResultMap[expectedResultKey]);
  });

  test('returns null when neither nx nor turbo is detected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monorepo-test-'));
    const lfs = new LocalFileSystemDetector(dir);
    const result = await getMonorepoDefaultSettings('', '', '', lfs);
    expect(result).toBe(null);
  });
});
