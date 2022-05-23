import os from 'os';
import url from 'url';
import fs from 'fs-extra';
import { join } from 'path';
import listen from 'async-listen';
import { createServer } from 'http';

const {
  exec,
  fetch,
  fixture,
  testFixture,
  testFixtureStdio,
  validateResponseHeaders,
} = require('./utils.js');

test('[vercel dev] should support request body', async () => {
  const dir = fixture('node-request-body');
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    const body = { hello: 'world' };

    // Test that `req.body` works in dev
    let res = await fetch(`http://localhost:${port}/api/req-body`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    validateResponseHeaders(res);
    expect(await res.json()).toMatchObject(body);

    // Test that `req` "data" events work in dev
    res = await fetch(`http://localhost:${port}/api/data-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should maintain query when invoking serverless function', async () => {
  const dir = fixture('node-query-invoke');
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    const res = await fetch(`http://localhost:${port}/something?url-param=a`);
    validateResponseHeaders(res);

    const text = await res.text();
    const parsed = url.parse(text, true);
    expect(parsed.pathname).toEqual('/something');
    expect(parsed.query['url-param']).toEqual('a');
    expect(parsed.query['route-param']).toEqual('b');
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should maintain query when proxy passing', async () => {
  const dir = fixture('query-proxy');
  const { dev, port, readyResolver } = await testFixture(dir);
  const dest = createServer((req, res) => {
    res.end(req.url);
  });

  try {
    await Promise.all([readyResolver, listen(dest, 0)]);

    const destAddr = dest.address();
    if (!destAddr || typeof destAddr === 'string') {
      throw new Error('Unexpected HTTP address');
    }

    const res = await fetch(
      `http://localhost:${port}/${destAddr.port}?url-param=a`
    );
    validateResponseHeaders(res);

    const text = await res.text();
    const parsed = url.parse(text, true);
    expect(parsed.pathname).toEqual('/something');
    expect(parsed.query['url-param']).toEqual('a');
    expect(parsed.query['route-param']).toEqual('b');
  } finally {
    dest.close();
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should maintain query when dev server defines routes', async () => {
  const dir = fixture('dev-server-query');
  const { dev, port, readyResolver } = await testFixture(dir, {
    env: {
      VERCEL_DEV_COMMAND: 'next dev --port $PORT',
    },
  });

  try {
    await readyResolver;

    const res = await fetch(`http://localhost:${port}/test?url-param=a`);
    validateResponseHeaders(res);

    const text = await res.text();

    // Hacky way of getting the page payload from the response
    // HTML since we don't have a HTML parser handy.
    const json = text
      .match(/<pre>(.*)<\/pre>/)![1]
      .replace('</pre>', '')
      .replace('<!-- -->', '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');
    const parsed = JSON.parse(json);
    const query = url.parse(parsed.url, true).query;

    expect(query['url-param']).toEqual('a');
    expect(query['route-param']).toEqual('b');
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should allow `cache-control` to be overwritten', async () => {
  const dir = fixture('headers');
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    const res = await fetch(
      `http://localhost:${port}/?name=cache-control&value=immutable`
    );
    expect(res.headers.get('cache-control')).toEqual('immutable');
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should send `etag` header for static files', async () => {
  const dir = fixture('headers');
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    const res = await fetch(`http://localhost:${port}/foo.txt`);
    const expected = 'd263af8ab880c0b97eb6c5c125b5d44f9e5addd9';
    expect(res.headers.get('etag')).toEqual(`"${expected}"`);
    const body = await res.text();
    expect(body.trim()).toEqual('hi');
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should frontend dev server and routes', async () => {
  const dir = fixture('dev-server-and-routes');
  const { dev, port, readyResolver } = await testFixture(dir, {
    env: {
      VERCEL_DEV_COMMAND: 'next dev --port $PORT',
    },
  });

  try {
    await readyResolver;

    let podId: string;

    let res = await fetch(`http://localhost:${port}/`);
    validateResponseHeaders(res);
    podId = res.headers.get('x-vercel-id')!.match(/:(\w+)-/)![1];
    let body = await res.text();
    expect(body.includes('hello, this is the frontend')).toBeTruthy();

    res = await fetch(`http://localhost:${port}/api/users`);
    validateResponseHeaders(res, podId);
    body = await res.text();
    expect(body).toEqual('users');

    res = await fetch(`http://localhost:${port}/api/users/1`);
    validateResponseHeaders(res, podId);
    body = await res.text();
    expect(body).toEqual('users/1');

    res = await fetch(`http://localhost:${port}/api/welcome`);
    validateResponseHeaders(res, podId);
    body = await res.text();
    expect(body).toEqual('hello and welcome');
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should support `@vercel/static` routing', async () => {
  const dir = fixture('static-routes');
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toEqual(200);
    const body = await res.text();
    expect(body.trim()).toEqual('<body>Hello!</body>');
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should support `@vercel/static-build` routing', async () => {
  const dir = fixture('static-build-routing');
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    const res = await fetch(`http://localhost:${port}/api/date`);
    expect(res.status).toEqual(200);
    const body = await res.text();
    expect(body.startsWith('The current date:')).toBeTruthy();
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should support directory listing', async () => {
  const dir = fixture('directory-listing');
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    // Get directory listing
    let res = await fetch(`http://localhost:${port}/`);
    let body = await res.text();
    expect(res.status).toEqual(200);
    expect(body.includes('Index of')).toBeTruthy();

    // Get a file
    res = await fetch(`http://localhost:${port}/file.txt`);
    body = await res.text();
    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual('Hello from file!');

    // Invoke a lambda
    res = await fetch(`http://localhost:${port}/lambda.js`);
    body = await res.text();
    expect(res.status).toEqual(200);
    expect(body).toEqual('Hello from Lambda!');

    // Trigger a 404
    res = await fetch(`http://localhost:${port}/does-not-exist`);
    expect(res.status).toEqual(404);
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should respond with 404 listing with Accept header support', async () => {
  const dir = fixture('directory-listing');
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    // HTML response
    let res = await fetch(`http://localhost:${port}/does-not-exist`, {
      headers: {
        Accept: 'text/html',
      },
    });
    expect(res.status).toEqual(404);
    expect(res.headers.get('content-type')).toEqual('text/html; charset=utf-8');
    let body = await res.text();
    expect(body.startsWith('<!DOCTYPE html>')).toBeTruthy();

    // JSON response
    res = await fetch(`http://localhost:${port}/does-not-exist`, {
      headers: {
        Accept: 'application/json',
      },
    });
    expect(res.status).toEqual(404);
    expect(res.headers.get('content-type')).toEqual('application/json');
    body = await res.text();
    expect(body).toEqual(
      '{"error":{"code":404,"message":"The page could not be found."}}\n'
    );

    // Plain text response
    res = await fetch(`http://localhost:${port}/does-not-exist`);
    expect(res.status).toEqual(404);
    body = await res.text();
    expect(res.headers.get('content-type')).toEqual(
      'text/plain; charset=utf-8'
    );
    expect(body).toEqual('The page could not be found.\n\nNOT_FOUND\n');
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should support `public` directory with zero config', async () => {
  const dir = fixture('api-with-public');
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    let res = await fetch(`http://localhost:${port}/api/user`);
    let body = await res.text();
    expect(body).toEqual('hello:user');

    res = await fetch(`http://localhost:${port}/`);
    body = await res.text();
    expect(body.startsWith('<h1>hello world</h1>')).toBeTruthy();
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should support static files with zero config', async () => {
  const dir = fixture('api-with-static');
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    let res = await fetch(`http://localhost:${port}/api/user`);
    let body = await res.text();
    expect(body).toEqual('bye:user');

    res = await fetch(`http://localhost:${port}/`);
    body = await res.text();
    expect(body.startsWith('<h1>goodbye world</h1>')).toBeTruthy();
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] should support custom 404 routes', async () => {
  const dir = fixture('custom-404');
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    // Test custom 404 with static dest
    let res = await fetch(`http://localhost:${port}/error.html`);
    expect(res.status).toEqual(404);
    let body = await res.text();
    expect(body.trim()).toEqual('<div>Custom 404 page</div>');

    // Test custom 404 with lambda dest
    res = await fetch(`http://localhost:${port}/error.js`);
    expect(res.status).toEqual(404);
    body = await res.text();
    expect(body).toEqual('Custom 404 Lambda\n');

    // Test regular 404 still works
    res = await fetch(`http://localhost:${port}/does-not-exist`);
    expect(res.status).toEqual(404);
    body = await res.text();
    expect(body).toEqual('The page could not be found.\n\nNOT_FOUND\n');
  } finally {
    dev.kill('SIGTERM');
  }
});

test('[vercel dev] prints `npm install` errors', async () => {
  const dir = fixture('runtime-not-installed');
  const result = await exec(dir);
  expect(result.stderr.includes('npm ERR! 404')).toBeTruthy();
  expect(
    result.stderr.includes('Failed to install `vercel dev` dependencies')
  ).toBeTruthy();
  expect(
    result.stderr.includes('https://vercel.link/npm-install-failed-dev')
  ).toBeTruthy();
});

test('[vercel dev] `vercel.json` should be invalidated if deleted', async () => {
  const dir = fixture('invalidate-vercel-config');
  const configPath = join(dir, 'vercel.json');
  const originalConfig = await fs.readJSON(configPath);
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    {
      // Env var should be set from `vercel.json`
      const res = await fetch(`http://localhost:${port}/api`);
      const body = await res.json();
      expect(body.FOO).toBe('bar');
    }

    {
      // Env var should not be set after `vercel.json` is deleted
      await fs.remove(configPath);

      const res = await fetch(`http://localhost:${port}/api`);
      const body = await res.json();
      expect(body.FOO).toBe(undefined);
    }
  } finally {
    dev.kill('SIGTERM');
    await fs.writeJSON(configPath, originalConfig);
  }
});

test('[vercel dev] reflects changes to config and env without restart', async () => {
  const dir = fixture('node-helpers');
  const configPath = join(dir, 'vercel.json');
  const originalConfig = await fs.readJSON(configPath);
  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    {
      // Node.js helpers should be available by default
      const res = await fetch(`http://localhost:${port}/?foo=bar`);
      const body = await res.json();
      expect(body.hasHelpers).toBe(true);
      expect(body.query.foo).toBe('bar');
    }

    {
      // Disable the helpers via `config.helpers = false`
      const config = {
        ...originalConfig,
        builds: [
          {
            ...originalConfig.builds[0],
            config: {
              helpers: false,
            },
          },
        ],
      };
      await fs.writeJSON(configPath, config);

      const res = await fetch(`http://localhost:${port}/?foo=bar`);
      const body = await res.json();
      expect(body.hasHelpers).toBe(false);
      expect(body.query).toBe(undefined);
    }

    {
      // Enable the helpers via `config.helpers = true`
      const config = {
        ...originalConfig,
        builds: [
          {
            ...originalConfig.builds[0],
            config: {
              helpers: true,
            },
          },
        ],
      };
      await fs.writeJSON(configPath, config);

      const res = await fetch(`http://localhost:${port}/?foo=baz`);
      const body = await res.json();
      expect(body.hasHelpers).toBe(true);
      expect(body.query.foo).toBe('baz');
    }

    {
      // Disable the helpers via `NODEJS_HELPERS = '0'`
      const config = {
        ...originalConfig,
        build: {
          env: {
            NODEJS_HELPERS: '0',
          },
        },
      };
      await fs.writeJSON(configPath, config);

      const res = await fetch(`http://localhost:${port}/?foo=baz`);
      const body = await res.json();
      expect(body.hasHelpers).toBe(false);
      expect(body.query).toBe(undefined);
    }

    {
      // Enable the helpers via `NODEJS_HELPERS = '1'`
      const config = {
        ...originalConfig,
        build: {
          env: {
            NODEJS_HELPERS: '1',
          },
        },
      };
      await fs.writeJSON(configPath, config);

      const res = await fetch(`http://localhost:${port}/?foo=boo`);
      const body = await res.json();
      expect(body.hasHelpers).toBe(true);
      expect(body.query.foo).toBe('boo');
    }
  } finally {
    dev.kill('SIGTERM');
    await fs.writeJSON(configPath, originalConfig);
  }
});

test('[vercel dev] `@vercel/node` TypeScript should be resolved by default', async () => {
  // The purpose of this test is to test that `@vercel/node` can properly
  // resolve the default "typescript" module when the project doesn't include
  // its own version. To properly test for this, a fixture needs to be created
  // *outside* of the `vercel` repo, since otherwise the root-level
  // "node_modules/typescript" is resolved as relative to the project, and
  // not relative to `@vercel/node` which is what we are testing for here.
  const dir = join(os.tmpdir(), 'vercel-node-typescript-resolve-test');
  const apiDir = join(dir, 'api');
  await fs.mkdirp(apiDir);
  await fs.writeFile(
    join(apiDir, 'hello.js'),
    'export default (req, res) => { res.end("world"); }'
  );

  const { dev, port, readyResolver } = await testFixture(dir);

  try {
    await readyResolver;

    const res = await fetch(`http://localhost:${port}/api/hello`);
    const body = await res.text();
    expect(body).toBe('world');
  } finally {
    dev.kill('SIGTERM');
    await fs.remove(dir);
  }
});

test(
  '[vercel dev] validate routes that use `check: true`',
  testFixtureStdio('routes-check-true', async (testPath: any) => {
    await testPath(200, '/blog/post', 'Blog Home');
  })
);

test(
  '[vercel dev] validate routes that use `check: true` and `status` code',
  testFixtureStdio('routes-check-true-status', async (testPath: any) => {
    await testPath(403, '/secret');
    await testPath(200, '/post', 'This is a post.');
    await testPath(200, '/post.html', 'This is a post.');
  })
);

test(
  '[vercel dev] validate routes that use custom 404 page',
  testFixtureStdio('routes-custom-404', async (testPath: any) => {
    await testPath(200, '/', 'Home Page');
    await testPath(404, '/nothing', 'Custom User 404');
    await testPath(404, '/exact', 'Exact Custom 404');
    await testPath(200, '/api/hello', 'Hello');
    await testPath(404, '/api/nothing', 'Custom User 404');
  })
);

test(
  '[vercel dev] handles miss after route',
  testFixtureStdio('handle-miss-after-route', async (testPath: any) => {
    await testPath(200, '/post', 'Blog Post Page', {
      test: '1',
      override: 'one',
    });
  })
);

test(
  '[vercel dev] handles miss after rewrite',
  testFixtureStdio('handle-miss-after-rewrite', async (testPath: any) => {
    await testPath(200, '/post', 'Blog Post Page', {
      test: '1',
      override: 'one',
    });
    await testPath(200, '/blog/post', 'Blog Post Page', {
      test: '1',
      override: 'two',
    });
    await testPath(404, '/blog/about.html', undefined, {
      test: '1',
      override: 'two',
    });
  })
);

test(
  '[vercel dev] does not display directory listing after 404',
  testFixtureStdio('handle-miss-hide-dir-list', async (testPath: any) => {
    await testPath(404, '/post');
    await testPath(200, '/post/one.html', 'First Post');
  })
);

test(
  '[vercel dev] should preserve query string even after miss phase',
  testFixtureStdio('handle-miss-querystring', async (testPath: any) => {
    await testPath(200, '/', 'Index Page');
    if (process.env.CI && process.platform === 'darwin') {
      console.log('Skipping since GH Actions hangs for some reason');
    } else {
      await testPath(200, '/echo/first/second', 'a=first,b=second');
      await testPath(200, '/functions/echo.js?a=one&b=two', 'a=one,b=two');
    }
  })
);

test(
  '[vercel dev] handles hit after handle: filesystem',
  testFixtureStdio('handle-hit-after-fs', async (testPath: any) => {
    await testPath(200, '/blog.html', 'Blog Page', { test: '1' });
  })
);

test(
  '[vercel dev] handles hit after dest',
  testFixtureStdio('handle-hit-after-dest', async (testPath: any) => {
    await testPath(200, '/post', 'Blog Post', { test: '1', override: 'one' });
  })
);

test(
  '[vercel dev] handles hit after rewrite',
  testFixtureStdio('handle-hit-after-rewrite', async (testPath: any) => {
    await testPath(200, '/post', 'Blog Post', { test: '1', override: 'one' });
  })
);

test(
  '[vercel dev] should serve the public directory and api functions',
  testFixtureStdio('public-and-api', async (testPath: any) => {
    await testPath(200, '/', 'This is the home page');
    await testPath(200, '/about.html', 'This is the about page');
    await testPath(200, '/.well-known/humans.txt', 'We come in peace');
    await testPath(200, '/api/date', /current date/);
    await testPath(200, '/api/rand', /random number/);
    await testPath(200, '/api/rand.js', /random number/);
    await testPath(404, '/api/api', /NOT_FOUND/m);
    await testPath(404, '/nothing', /Custom 404 Page/);
  })
);

test(
  '[vercel dev] should allow user rewrites for path segment files',
  testFixtureStdio('test-zero-config-rewrite', async (testPath: any) => {
    await testPath(404, '/');
    await testPath(200, '/echo/1', '{"id":"1"}', {
      'Access-Control-Allow-Origin': '*',
    });
    await testPath(200, '/echo/2', '{"id":"2"}', {
      'Access-Control-Allow-Headers': '*',
    });
  })
);

test('[vercel dev] validate builds', async () => {
  const directory = fixture('invalid-builds');
  const output = await exec(directory);

  expect(output.exitCode).toBe(1);
  expect(output.stderr).toMatch(
    /Invalid vercel\.json - `builds\[0\].src` should be string/m
  );
});

test('[vercel dev] validate routes', async () => {
  const directory = fixture('invalid-routes');
  const output = await exec(directory);

  expect(output.exitCode).toBe(1);
  expect(output.stderr).toMatch(
    /Invalid vercel\.json - `routes\[0\].src` should be string/m
  );
});

test('[vercel dev] validate cleanUrls', async () => {
  const directory = fixture('invalid-clean-urls');
  const output = await exec(directory);

  expect(output.exitCode).toBe(1);
  expect(output.stderr).toMatch(
    /Invalid vercel\.json - `cleanUrls` should be boolean/m
  );
});

test('[vercel dev] validate trailingSlash', async () => {
  const directory = fixture('invalid-trailing-slash');
  const output = await exec(directory);

  expect(output.exitCode).toBe(1);
  expect(output.stderr).toMatch(
    /Invalid vercel\.json - `trailingSlash` should be boolean/m
  );
});

test('[vercel dev] validate rewrites', async () => {
  const directory = fixture('invalid-rewrites');
  const output = await exec(directory);

  expect(output.exitCode).toBe(1);
  expect(output.stderr).toMatch(
    /Invalid vercel\.json - `rewrites\[0\].destination` should be string/m
  );
});
