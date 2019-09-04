import path from 'path';
import { TOKEN } from './constants';
import { fetch, API_DEPLOYMENTS } from '../src/utils';
import { Deployment } from './types';
import { createDeployment } from '../src/index';

describe('create v2 deployment', () => {
  let deployment: Deployment;

  afterEach(async () => {
    if (deployment) {
      const response = await fetch(
        `${API_DEPLOYMENTS}/${deployment.id}`,
        TOKEN,
        {
          method: 'DELETE'
        }
      );
      expect(response.status).toEqual(200);
    }
  });

  it('will display an empty deployment warning', async () => {
    for await (const event of createDeployment(
      path.resolve(__dirname, 'fixtures', 'v2'),
      {
        token: TOKEN,
        name: 'now-client-tests-v2'
      }
    )) {
      if (event.type === 'warning') {
        expect(event.payload).toEqual('READY');
      }

      if (event.type === 'ready') {
        deployment = event.payload;
        break;
      }
    }
  });

  it('will report correct file count event', async () => {
    for await (const event of createDeployment(
      path.resolve(__dirname, 'fixtures', 'v2'),
      {
        token: TOKEN,
        name: 'now-client-tests-v2'
      }
    )) {
      if (event.type === 'file_count') {
        expect(event.payload.total).toEqual(0);
      }

      if (event.type === 'ready') {
        deployment = event.payload;
        break;
      }
    }
  });

  it('will create a v2 deployment', async () => {
    for await (const event of createDeployment(
      path.resolve(__dirname, 'fixtures', 'v2'),
      {
        token: TOKEN,
        name: 'now-client-tests-v2'
      }
    )) {
      if (event.type === 'ready') {
        deployment = event.payload;
        expect(deployment.readyState).toEqual('READY');
        break;
      }
    }
  });
});
