const entrypoint = process.env.VERCEL_DEV_ENTRYPOINT;
delete process.env.VERCEL_DEV_ENTRYPOINT;

const tsconfig = process.env.VERCEL_DEV_TSCONFIG;
delete process.env.VERCEL_DEV_TSCONFIG;

if (!entrypoint) {
  throw new Error('`VERCEL_DEV_ENTRYPOINT` must be defined');
}

import { join } from 'path';
import { register } from 'ts-node';
import { fixConfig } from './typescript';

type TypescriptModule = typeof import('typescript');

let useRequire = false;

if (!process.env.VERCEL_DEV_IS_ESM) {
  const resolveTypescript = (p: string): string => {
    try {
      return require.resolve('typescript', {
        paths: [p],
      });
    } catch (_) {
      return '';
    }
  };

  const requireTypescript = (p: string): TypescriptModule => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(p) as TypescriptModule;
  };

  let ts: TypescriptModule | null = null;

  // Use the project's version of Typescript if available and supports `target`
  let compiler = resolveTypescript(process.cwd());
  if (compiler) {
    ts = requireTypescript(compiler);
  }

  // Otherwise fall back to using the copy that `@vercel/node` uses
  if (!ts) {
    compiler = resolveTypescript(join(__dirname, '..'));
    ts = requireTypescript(compiler);
  }

  let config: any = {};
  if (tsconfig) {
    try {
      config = ts.readConfigFile(tsconfig, ts.sys.readFile).config;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`Error while parsing "${tsconfig}"`);
        throw err;
      }
    }
  }

  fixConfigDev(config);

  register({
    compiler,
    compilerOptions: config.compilerOptions,
    transpileOnly: true,
  });

  useRequire = true;
}

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';
import type { Bridge } from '@vercel/node-bridge/bridge';
import { getVercelLauncher } from '@vercel/node-bridge/launcher.js';
import { VercelProxyResponse } from '@vercel/node-bridge/types';
import { streamToBuffer } from '@vercel/build-utils';
import exitHook from 'exit-hook';
import { EdgeRuntime, Primitives, runServer } from 'edge-runtime';
import { getConfig } from '@vercel/static-config';
import { Project } from 'ts-morph';
import ncc from '@vercel/ncc';
import fetch from 'node-fetch';

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise(resolve => {
    server.listen(port, host, () => {
      resolve();
    });
  });
}

async function createServerlessEventHandler(
  entrypoint: string,
  options: { shouldAddHelpers: boolean }
): Promise<(request: IncomingMessage) => Promise<VercelProxyResponse>> {
  const launcher = getVercelLauncher({
    entrypointPath: entrypoint,
    helpersPath: './helpers.js',
    shouldAddHelpers: options.shouldAddHelpers,
    useRequire,

    // not used
    bridgePath: '',
    sourcemapSupportPath: '',
  });
  const bridge: Bridge = launcher();

  return async function (request: IncomingMessage) {
    const body = await rawBody(request);
    const event = {
      Action: 'Invoke',
      body: JSON.stringify({
        method: request.method,
        path: request.url,
        headers: request.headers,
        encoding: 'base64',
        body: body.toString('base64'),
      }),
    };

    return bridge.launcher(event, {
      callbackWaitsForEmptyEventLoop: false,
    });
  };
}

async function serializeRequest(message: IncomingMessage) {
  const bodyBuffer = await streamToBuffer(message);
  const body = bodyBuffer.toString('base64');
  return JSON.stringify({
    url: message.url,
    method: message.method,
    headers: message.headers,
    body,
  });
}

async function createEdgeEventHandler(
  entrypoint: string
): Promise<(request: IncomingMessage) => Promise<VercelProxyResponse>> {
  const buildResult = await ncc(entrypoint, { target: 'es2022' });
  const userCode = buildResult.code;

  const initialCode = `
    ${userCode};

    addEventListener('fetch', async (event) => {
      let serializedRequest = await event.request.text();
      let requestDetails = JSON.parse(serializedRequest);

      let body;

      if (requestDetails.method !== 'GET' && requestDetails.method !== 'HEAD') {
        body = Uint8Array.from(atob(requestDetails.body), c => c.charCodeAt(0));
      }

      let requestUrl = requestDetails.headers['x-forwarded-proto'] + '://' + requestDetails.headers['x-forwarded-host'] + requestDetails.url;

      let request = new Request(requestUrl, {
        headers: requestDetails.headers,
        method: requestDetails.method,
        body: body
      });

      event.request = request;

      let edgeHandler = module.exports.default;
      let response = edgeHandler(event.request, event);
      return event.respondWith(response);
    })`;

  const edgeRuntime = new EdgeRuntime({
    initialCode,
    extend: (context: Primitives) => {
      Object.assign(context, {
        __dirname: '',
        module: {
          exports: {},
        },
      });
      return context;
    },
  });
  const server = await runServer({ runtime: edgeRuntime });
  exitHook(server.close);

  return async function (request: IncomingMessage) {
    const response = await fetch(server.url, {
      method: 'post',
      body: await serializeRequest(request),
    });

    return {
      statusCode: response.status,
      headers: response.headers.raw(),
      body: await response.text(),
      encoding: 'utf8',
    };
  };
}

const validRuntimes = ['experimental-edge'];
function parseRuntime(entrypoint: string): string | undefined {
  const project = new Project();
  const staticConfig = getConfig(project, entrypoint);
  const runtime = staticConfig?.runtime;
  if (runtime && !validRuntimes.includes(runtime)) {
    throw new Error(`Invalid function runtime for "${entrypoint}": ${runtime}`);
  }

  return runtime;
}

async function createEventHandler(
  entrypoint: string,
  options: { shouldAddHelpers: boolean }
): Promise<(request: IncomingMessage) => Promise<VercelProxyResponse>> {
  const runtime = parseRuntime(entrypoint);
  if (runtime === 'experimental-edge') {
    return createEdgeEventHandler(entrypoint);
  }

  return createServerlessEventHandler(entrypoint, options);
}

let handleEvent: (request: IncomingMessage) => Promise<VercelProxyResponse>;

async function main() {
  const config = JSON.parse(process.env.VERCEL_DEV_CONFIG || '{}');
  delete process.env.VERCEL_DEV_CONFIG;

  const buildEnv = JSON.parse(process.env.VERCEL_DEV_BUILD_ENV || '{}');
  delete process.env.VERCEL_DEV_BUILD_ENV;

  const shouldAddHelpers = !(
    config.helpers === false || buildEnv.NODEJS_HELPERS === '0'
  );

  const proxyServer = createServer(onDevRequest);
  await listen(proxyServer, 0, '127.0.0.1');

  const entryPointPath = join(process.cwd(), entrypoint!);
  handleEvent = await createEventHandler(entryPointPath, { shouldAddHelpers });

  const address = proxyServer.address();
  if (typeof process.send === 'function') {
    process.send(address);
  } else {
    console.log('Dev server listening:', address);
  }
}

export function rawBody(readable: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    readable.on('error', reject);
    readable.on('data', chunk => {
      chunks.push(chunk);
      bytes += chunk.length;
    });
    readable.on('end', () => {
      resolve(Buffer.concat(chunks, bytes));
    });
  });
}

export async function onDevRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!handleEvent) {
    res.statusCode = 500;
    res.end('Bridge is not ready, please try again');
    return;
  }

  try {
    const result = await handleEvent(req);
    res.statusCode = result.statusCode;
    for (const [key, value] of Object.entries(result.headers)) {
      if (typeof value !== 'undefined') {
        res.setHeader(key, value);
      }
    }
    res.end(Buffer.from(result.body, result.encoding));
  } catch (error) {
    res.statusCode = 500;
    res.end(error.stack);
  }
}

export function fixConfigDev(config: { compilerOptions: any }): void {
  const nodeVersionMajor = Number(process.versions.node.split('.')[0]);
  fixConfig(config, nodeVersionMajor);

  // In prod, `.ts` inputs use TypeScript and
  // `.js` inputs use Babel to convert ESM to CJS.
  // In dev, both `.ts` and `.js` inputs use ts-node
  // without Babel so we must enable `allowJs`.
  config.compilerOptions.allowJs = true;

  // In prod, we emit outputs to the filesystem.
  // In dev, we don't emit because we use ts-node.
  config.compilerOptions.noEmit = true;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
