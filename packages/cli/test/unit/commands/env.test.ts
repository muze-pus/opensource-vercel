import fs from 'fs-extra';
import path from 'path';
import env from '../../../src/commands/env';
import { setupFixture } from '../../helpers/setup-fixture';
import { client } from '../../mocks/client';
import { defaultProject, useProject } from '../../mocks/project';
import { useTeams } from '../../mocks/team';
import { useUser } from '../../mocks/user';

describe('env', () => {
  describe('pull', () => {
    it('should handle pulling', async () => {
      const cwd = setupFixture('vercel-env-pull');
      useUser();
      useTeams('team_dummy');
      useProject({
        ...defaultProject,
        id: 'vercel-env-pull',
        name: 'vercel-env-pull',
      });
      client.setArgv('env', 'pull', '--yes', '--cwd', cwd);
      const exitCodePromise = env(client);
      await expect(client.stderr).toOutput(
        'Downloading "development" Environment Variables for Project vercel-env-pull'
      );
      await expect(client.stderr).toOutput('Created .env file');
      await expect(exitCodePromise).resolves.toEqual(0);

      const rawDevEnv = await fs.readFile(path.join(cwd, '.env'));

      // check for development env value
      const devFileHasDevEnv = rawDevEnv.toString().includes('SPECIAL_FLAG');
      expect(devFileHasDevEnv).toBeTruthy();
    });

    it('should handle alternate filename', async () => {
      const cwd = setupFixture('vercel-env-pull');
      useUser();
      useTeams('team_dummy');
      useProject({
        ...defaultProject,
        id: 'vercel-env-pull',
        name: 'vercel-env-pull',
      });
      client.setArgv('env', 'pull', 'other.env', '--yes', '--cwd', cwd);
      const exitCodePromise = env(client);
      await expect(client.stderr).toOutput(
        'Downloading "development" Environment Variables for Project vercel-env-pull'
      );
      await expect(client.stderr).toOutput('Created other.env file');
      await expect(exitCodePromise).resolves.toEqual(0);

      const rawDevEnv = await fs.readFile(path.join(cwd, 'other.env'));

      // check for development env value
      const devFileHasDevEnv = rawDevEnv.toString().includes('SPECIAL_FLAG');
      expect(devFileHasDevEnv).toBeTruthy();
    });

    it('should use given environment', async () => {
      const cwd = setupFixture('vercel-env-pull');
      useUser();
      useTeams('team_dummy');
      useProject({
        ...defaultProject,
        id: 'vercel-env-pull',
        name: 'vercel-env-pull',
      });

      client.setArgv(
        'env',
        'pull',
        '.env.production',
        '--environment',
        'production',
        '--cwd',
        cwd
      );
      const exitCodePromise = env(client);
      await expect(client.stderr).toOutput(
        `Downloading "production" Environment Variables for Project vercel-env-pull`
      );
      await expect(client.stderr).toOutput('Created .env.production file');
      await expect(exitCodePromise).resolves.toEqual(0);

      const rawProdEnv = await fs.readFile(path.join(cwd, '.env.production'));

      // check for development env value
      const envFileHasEnv = rawProdEnv
        .toString()
        .includes('REDIS_CONNECTION_STRING');
      expect(envFileHasEnv).toBeTruthy();
    });

    it('should throw an error when it does not recognize given environment', async () => {
      const cwd = setupFixture('vercel-env-pull');
      useUser();
      useTeams('team_dummy');
      useProject({
        ...defaultProject,
        id: 'vercel-env-pull',
        name: 'vercel-env-pull',
      });

      client.setArgv(
        'env',
        'pull',
        '.env.production',
        '--environment',
        'something-invalid',
        '--cwd',
        cwd
      );

      const exitCodePromise = env(client);
      await expect(client.stderr).toOutput(
        `Invalid environment \`something-invalid\`. Valid options: <production | preview | development>`
      );

      await expect(exitCodePromise).resolves.toEqual(1);
    });

    it('should expose production system env variables', async () => {
      const cwd = setupFixture('vercel-env-pull');
      useUser();
      useTeams('team_dummy');
      useProject({
        ...defaultProject,
        id: 'vercel-env-pull',
        name: 'vercel-env-pull',
        autoExposeSystemEnvs: true,
      });

      client.setArgv('env', 'pull', 'other.env', '--yes', '--cwd', cwd);
      const exitCodePromise = env(client);
      await expect(client.stderr).toOutput(
        'Downloading "development" Environment Variables for Project vercel-env-pull'
      );
      await expect(client.stderr).toOutput('Created other.env file');
      await expect(exitCodePromise).resolves.toEqual(0);

      const rawDevEnv = await fs.readFile(path.join(cwd, 'other.env'));

      const productionFileHasVercelEnv = rawDevEnv
        .toString()
        .includes('VERCEL_ENV="development"');
      expect(productionFileHasVercelEnv).toBeTruthy();
    });
  });
});
