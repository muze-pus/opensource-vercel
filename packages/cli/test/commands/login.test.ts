import { client } from '../mocks/client';
import login from '../../src/commands/login';

describe('login', () => {
  it('should not allow the `--token` flag', async () => {
    client.setArgv('login', '--token', 'foo');
    const exitCode = await login(client);
    expect(exitCode).toEqual(2);
    expect(client.outputBuffer).toEqual(
      'Error! `--token` may not be used with the "login" command\n'
    );
  });
});
