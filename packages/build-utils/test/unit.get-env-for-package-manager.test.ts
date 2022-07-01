import assert from 'assert';
import { delimiter } from 'path';
import { getEnvForPackageManager } from '../src';

describe('Test `getEnvForPackageManager()`', () => {
  const cases: Array<{
    name: string;
    args: Parameters<typeof getEnvForPackageManager>[0];
    want: unknown;
  }> = [
    {
      name: 'should do nothing to env for npm < 6 and node < 16',
      args: {
        cliType: 'npm',
        nodeVersion: { major: 14, range: '14.x', runtime: 'nodejs14.x' },
        lockfileVersion: 1,
        env: {
          FOO: 'bar',
        },
      },
      want: {
        FOO: 'bar',
      },
    },
    {
      name: 'should set path if npm 7+ is detected and node < 16',
      args: {
        cliType: 'npm',
        nodeVersion: { major: 14, range: '14.x', runtime: 'nodejs14.x' },
        lockfileVersion: 2,
        env: {
          FOO: 'bar',
          PATH: 'foo',
        },
      },
      want: {
        FOO: 'bar',
        PATH: `/node16/bin-npm7${delimiter}foo`,
      },
    },
    {
      name: 'should not set npm path if corepack enabled',
      args: {
        cliType: 'npm',
        nodeVersion: { major: 14, range: '14.x', runtime: 'nodejs14.x' },
        lockfileVersion: 2,
        env: {
          FOO: 'bar',
          ENABLE_EXPERIMENTAL_COREPACK: '1',
        },
      },
      want: {
        FOO: 'bar',
        ENABLE_EXPERIMENTAL_COREPACK: '1',
      },
    },
    {
      name: 'should not prepend npm path again if already detected',
      args: {
        cliType: 'npm',
        nodeVersion: { major: 14, range: '14.x', runtime: 'nodejs14.x' },
        lockfileVersion: 2,
        env: {
          FOO: 'bar',
          PATH: `/node16/bin-npm7${delimiter}foo`,
        },
      },
      want: {
        FOO: 'bar',
        PATH: `/node16/bin-npm7${delimiter}foo`,
      },
    },
    {
      name: 'should not set path if node is 16 and npm 7+ is detected',
      args: {
        cliType: 'npm',
        nodeVersion: { major: 16, range: '16.x', runtime: 'nodejs16.x' },
        lockfileVersion: 2,
        env: {
          FOO: 'bar',
          PATH: 'foo',
        },
      },
      want: {
        FOO: 'bar',
        PATH: 'foo',
      },
    },
    {
      name: 'should set YARN_NODE_LINKER w/yarn if it is not already defined',
      args: {
        cliType: 'yarn',
        nodeVersion: { major: 16, range: '16.x', runtime: 'nodejs16.x' },
        lockfileVersion: 2,
        env: {
          FOO: 'bar',
        },
      },
      want: {
        FOO: 'bar',
        YARN_NODE_LINKER: 'node-modules',
      },
    },
    {
      name: 'should not set YARN_NODE_LINKER if it already exists',
      args: {
        cliType: 'yarn',
        nodeVersion: { major: 16, range: '16.x', runtime: 'nodejs16.x' },
        lockfileVersion: 2,
        env: {
          FOO: 'bar',
          YARN_NODE_LINKER: 'exists',
        },
      },
      want: {
        FOO: 'bar',
        YARN_NODE_LINKER: 'exists',
      },
    },
    {
      name: 'should set path if pnpm 7+ is detected',
      args: {
        cliType: 'pnpm',
        nodeVersion: { major: 16, range: '16.x', runtime: 'nodejs16.x' },
        lockfileVersion: 5.4,
        env: {
          FOO: 'bar',
          PATH: 'foo',
        },
      },
      want: {
        FOO: 'bar',
        PATH: `/pnpm7/node_modules/.bin${delimiter}foo`,
      },
    },
    {
      name: 'should not set pnpm path if corepack is enabled',
      args: {
        cliType: 'pnpm',
        nodeVersion: { major: 16, range: '16.x', runtime: 'nodejs16.x' },
        lockfileVersion: 5.4,
        env: {
          FOO: 'bar',
          ENABLE_EXPERIMENTAL_COREPACK: '1',
        },
      },
      want: {
        FOO: 'bar',
        ENABLE_EXPERIMENTAL_COREPACK: '1',
      },
    },
    {
      name: 'should not prepend pnpm path again if already detected',
      args: {
        cliType: 'pnpm',
        nodeVersion: { major: 16, range: '16.x', runtime: 'nodejs16.x' },
        lockfileVersion: 5.4,
        env: {
          FOO: 'bar',
          PATH: `/pnpm7/node_modules/.bin${delimiter}foo`,
        },
      },
      want: {
        FOO: 'bar',
        PATH: `/pnpm7/node_modules/.bin${delimiter}foo`,
      },
    },
    {
      name: 'should not set path if pnpm 6 is detected',
      args: {
        cliType: 'pnpm',
        nodeVersion: { major: 14, range: '14.x', runtime: 'nodejs14.x' },
        lockfileVersion: 5.3,
        env: {
          FOO: 'bar',
        },
      },
      want: {
        FOO: 'bar',
      },
    },
  ];

  for (const { name, want, args } of cases) {
    it(name, () => {
      assert.deepStrictEqual(
        getEnvForPackageManager({
          cliType: args.cliType,
          lockfileVersion: args.lockfileVersion,
          nodeVersion: args.nodeVersion,
          env: args.env,
        }),
        want
      );
    });
  }
});
