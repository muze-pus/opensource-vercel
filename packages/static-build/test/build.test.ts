import path from 'path';
import { remove } from 'fs-extra';
import { build } from '../src';

describe('build()', () => {
  describe('Build Output API v2', () => {
    it('should detect the output format', async () => {
      const workPath = path.join(
        __dirname,
        'build-fixtures',
        '10-build-output-v2'
      );

      try {
        const buildResult = await build({
          files: {},
          entrypoint: 'package.json',
          workPath,
          config: {},
          meta: {
            skipDownload: true,
            cliVersion: '0.0.0',
          },
        });
        if ('buildOutputVersion' in buildResult) {
          throw new Error('Unexpected `buildOutputVersion` in build result');
        }

        expect(buildResult.output['index.html']).toBeTruthy();
        expect(buildResult.output['middleware']).toBeTruthy();
      } finally {
        remove(path.join(workPath, '.output'));
      }
    });
  });

  describe('Build Output API v3', () => {
    it('should detect the output format', async () => {
      const workPath = path.join(
        __dirname,
        'build-fixtures',
        '09-build-output-v3'
      );
      const buildResult = await build({
        files: {},
        entrypoint: 'package.json',
        workPath,
        config: {},
        meta: {
          skipDownload: true,
          cliVersion: '0.0.0',
        },
      });
      if ('output' in buildResult) {
        throw new Error('Unexpected `output` in build result');
      }
      expect(buildResult.buildOutputVersion).toEqual(3);
      expect(buildResult.buildOutputPath).toEqual(
        path.join(workPath, '.vercel/output')
      );
    });

    it('should throw an Error without `vercel build`', async () => {
      let err;
      const workPath = path.join(
        __dirname,
        'build-fixtures',
        '09-build-output-v3'
      );
      try {
        await build({
          files: {},
          entrypoint: 'package.json',
          workPath,
          config: {},
          meta: {
            skipDownload: true,
          },
        });
      } catch (_err: any) {
        err = _err;
      }
      expect(err.message).toEqual(
        `Detected Build Output v3 from the "build" script, but this Deployment is not using \`vercel build\`.\nPlease set the \`ENABLE_VC_BUILD=1\` environment variable.`
      );
    });
  });
});
