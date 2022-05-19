import { join } from 'path';
import { fileNameSymbol } from '@vercel/client';
import { client } from '../../mocks/client';
import deploy from '../../../src/commands/deploy';
import { setupFixture } from '../../helpers/setup-fixture';
import { defaultProject, useProject } from '../../mocks/project';
import { useTeams } from '../../mocks/team';
import { useUser } from '../../mocks/user';

describe('deploy', () => {
  it('should reject deploying a single file', async () => {
    client.setArgv('deploy', __filename);
    const exitCode = await deploy(client);
    expect(exitCode).toEqual(1);
    expect(client.outputBuffer).toEqual(
      `Error! Support for single file deployments has been removed.\nLearn More: https://vercel.link/no-single-file-deployments\n`
    );
  });

  it('should reject deploying multiple files', async () => {
    client.setArgv('deploy', __filename, join(__dirname, 'inspect.test.ts'));
    const exitCode = await deploy(client);
    expect(exitCode).toEqual(1);
    expect(client.outputBuffer).toEqual(
      `Error! Can't deploy more than one path.\n`
    );
  });

  it('should reject deploying a directory that does not exist', async () => {
    client.setArgv('deploy', 'does-not-exists');
    const exitCode = await deploy(client);
    expect(exitCode).toEqual(1);
    expect(client.outputBuffer).toEqual(
      `Error! The specified file or directory "does-not-exists" does not exist.\n`
    );
  });

  it('should reject deploying a directory that does not contain ".vercel/output" when `--prebuilt` is used', async () => {
    client.setArgv('deploy', __dirname, '--prebuilt');
    const exitCode = await deploy(client);
    expect(exitCode).toEqual(1);
    expect(client.outputBuffer).toEqual(
      'Error! The "--prebuilt" option was used, but no prebuilt output found in ".vercel/output". Run `vercel build` to generate a local build.\n'
    );
  });

  it('should reject deploying a directory that was built with a different target environment when `--prebuilt --prod` is used on "preview" output', async () => {
    const cwd = setupFixture('build-output-api-preview');

    useUser();
    useTeams('team_dummy');
    useProject({
      ...defaultProject,
      id: 'build-output-api-preview',
      name: 'build-output-api-preview',
    });

    client.setArgv('deploy', cwd, '--prebuilt', '--prod');
    const exitCode = await deploy(client);
    expect(exitCode).toEqual(1);
    expect(client.outputBuffer).toEqual(
      'Error! The "--prebuilt" option was used with the target environment "production",' +
        ' but the prebuilt output found in ".vercel/output" was built with target environment "preview".' +
        ' Please run `vercel --prebuilt`.\n' +
        'Learn More: https://vercel.link/prebuilt-environment-mismatch\n'
    );
  });

  it('should reject deploying a directory that was built with a different target environment when `--prebuilt` is used on "production" output', async () => {
    const cwd = setupFixture('build-output-api-production');

    useUser();
    useTeams('team_dummy');
    useProject({
      ...defaultProject,
      id: 'build-output-api-preview',
      name: 'build-output-api-preview',
    });

    client.setArgv('deploy', cwd, '--prebuilt');
    const exitCode = await deploy(client);
    expect(exitCode).toEqual(1);
    expect(client.outputBuffer).toEqual(
      'Error! The "--prebuilt" option was used with the target environment "preview",' +
        ' but the prebuilt output found in ".vercel/output" was built with target environment "production".' +
        ' Please run `vercel --prebuilt --prod`.\n' +
        'Learn More: https://vercel.link/prebuilt-environment-mismatch\n'
    );
  });

  it('should reject deploying "version: 1"', async () => {
    client.setArgv('deploy');
    client.localConfig = {
      [fileNameSymbol]: 'vercel.json',
      version: 1,
    };
    const exitCode = await deploy(client);
    expect(exitCode).toEqual(1);
    expect(client.outputBuffer).toEqual(
      'Error! The value of the `version` property within vercel.json can only be `2`.\n'
    );
  });

  it('should reject deploying "version: {}"', async () => {
    client.setArgv('deploy');
    client.localConfig = {
      [fileNameSymbol]: 'vercel.json',
      // @ts-ignore
      version: {},
    };
    const exitCode = await deploy(client);
    expect(exitCode).toEqual(1);
    expect(client.outputBuffer).toEqual(
      'Error! The `version` property inside your vercel.json file must be a number.\n'
    );
  });
});
