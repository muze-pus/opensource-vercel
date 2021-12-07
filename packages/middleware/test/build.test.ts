import { join } from 'path';
import { promises as fsp } from 'fs';
import { build } from '../src';
import { Response } from 'node-fetch';

const setupFixture = async (fixture: string) => {
  const fixturePath = join(__dirname, `fixtures/${fixture}`);
  await build({
    workPath: fixturePath,
  });

  const functionsManifest = JSON.parse(
    await fsp.readFile(
      join(fixturePath, '.output/functions-manifest.json'),
      'utf8'
    )
  );

  const outputFile = join(fixturePath, '.output/server/pages/_middleware.js');
  expect(await fsp.stat(outputFile)).toBeTruthy();
  require(outputFile);
  //@ts-ignore
  const middleware = global._ENTRIES['middleware_pages/_middleware'].default;
  return {
    middleware,
    functionsManifest,
  };
};

describe('build()', () => {
  beforeEach(() => {
    //@ts-ignore
    global.Response = Response;
  });
  afterEach(() => {
    //@ts-ignore
    delete global.Response;
    //@ts-ignore
    delete global._ENTRIES;
  });
  it('should build simple middleware', async () => {
    const { functionsManifest, middleware } = await setupFixture('simple');

    expect(functionsManifest).toMatchSnapshot();
    expect(typeof middleware).toStrictEqual('function');
    const handledResponse = await middleware({
      request: {
        url: 'http://google.com',
      },
    });
    const unhandledResponse = await middleware({
      request: {
        url: 'literallyanythingelse',
      },
    });
    expect(String(handledResponse.response.body)).toEqual('Hi from the edge!');
    expect(
      (handledResponse.response as Response).headers.get('x-middleware-next')
    ).toEqual(null);
    expect(unhandledResponse.response.body).toEqual(null);
    expect(
      (unhandledResponse.response as Response).headers.get('x-middleware-next')
    ).toEqual('1');
  });

  it('should build simple middleware with env vars', async () => {
    const expectedEnvVar = 'expected-env-var';
    const fixture = join(__dirname, 'fixtures/env');
    process.env.ENV_VAR_SHOULD_BE_DEFINED = expectedEnvVar;
    await build({
      workPath: fixture,
    });
    // env var should be inlined in the output
    delete process.env.ENV_VAR_SHOULD_BE_DEFINED;

    const outputFile = join(fixture, '.output/server/pages/_middleware.js');
    expect(await fsp.stat(outputFile)).toBeTruthy();

    require(outputFile);
    //@ts-ignore
    const middleware = global._ENTRIES['middleware_pages/_middleware'].default;
    expect(typeof middleware).toStrictEqual('function');
    const handledResponse = await middleware({
      request: {},
    });
    expect(String(handledResponse.response.body)).toEqual(expectedEnvVar);
    expect(
      (handledResponse.response as Response).headers.get('x-middleware-next')
    ).toEqual(null);
  });

  it('should create a middleware that runs in strict mode', async () => {
    const { middleware } = await setupFixture('use-strict');
    const response = await middleware({
      request: {},
    });
    expect(String(response.response.body)).toEqual('is strict mode? yes');
  });
});
