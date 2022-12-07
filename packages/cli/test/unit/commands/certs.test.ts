import { client } from '../../mocks/client';
import certs from '../../../src/commands/certs';
import { useUser } from '../../mocks/user';
import { useCert } from '../../mocks/certs';

describe('certs', () => {
  it('should list up to 20 certs by default', async () => {
    useUser();
    useCert();
    client.setArgv('certs', 'ls');
    const exitCodePromise = certs(client);
    await expect(client.stderr).toOutput('dummy-19.cert');
    await expect(exitCodePromise).resolves.toEqual(0);
  });

  it('should list up to 2 certs if limit set to 2', async () => {
    useUser();
    useCert();
    client.setArgv('certs', 'ls', '--limit', '2');
    const exitCodePromise = certs(client);
    await expect(client.stderr).toOutput('dummy-1.cert');
    await expect(exitCodePromise).resolves.toEqual(0);
  });
});
