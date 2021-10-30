import { join } from 'path';
import { promises as fsp } from 'fs';
import { build } from '../src';

describe('build()', () => {
  it('should build simple middleware', async () => {
    const fixture = join(__dirname, 'fixtures/simple');
    await build({
      workPath: fixture,
    });

    const middlewareManifest = JSON.parse(
      await fsp.readFile(
        join(fixture, '.output/server/middleware-manifest.json'),
        'utf8'
      )
    );
    expect(middlewareManifest).toMatchSnapshot();

    expect(
      await fsp.stat(join(fixture, '.output/server/pages/_middleware.js'))
    ).toBeTruthy();
  });
});
