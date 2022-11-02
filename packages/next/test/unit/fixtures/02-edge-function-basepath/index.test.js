const fs = require('fs-extra');
const ms = require('ms');
const path = require('path');
const { build } = require('../../../../dist');
const { FileFsRef } = require('@vercel/build-utils');

jest.setTimeout(ms('6m'));

describe(`${__dirname.split(path.sep).pop()}`, () => {
  it('should normalize routes in build results output', async () => {
    const files = [
      'index.test.js',
      'next.config.js',
      'package.json',
      'tsconfig.json',
      'pages/api/hello.ts',
      'pages/index.tsx',
    ].reduce((filesMap, file) => {
      const fsPath = path.join(__dirname, file);
      const { mode } = fs.statSync(fsPath);
      filesMap[path] = new FileFsRef({ mode, fsPath });
      return filesMap;
    }, {});

    const { output } = await build({
      config: {},
      entrypoint: 'package.json',
      files,
      meta: {
        skipDownload: true,
      },
      repoRootPath: __dirname,
      workPath: __dirname,
    });

    expect(output).toHaveProperty('test/api/hello');
    expect(output['test/api/hello'].type).toEqual('EdgeFunction');
  });
});
