const fs = require('fs');
const path = require('path');
const ms = require('ms');
const { version } = require('../package.json');

const {
  packAndDeploy,
  testDeployment,
} = require('../../../test/lib/deployment/test-deployment.js');

jest.setTimeout(12 * 60 * 1000);

let builderUrl;
let builderUrlLastUpdated = 0;
const buildUtilsUrl = version.includes('canary') ? '@canary' : undefined;

beforeEach(async () => {
  if (builderUrlLastUpdated < Date.now() - ms('30min')) {
    const builderPath = path.resolve(__dirname, '..');
    builderUrl = await packAndDeploy(builderPath);
    builderUrlLastUpdated = Date.now();
    console.log('builderUrl', builderUrl);
  }
});

const fixturesPath = path.resolve(__dirname, 'fixtures');
const testsThatFailToBuild = new Map([
  [
    '04-wrong-dist-dir',
    'No Output Directory named "out" found after the Build completed. You can configure the Output Directory in your Project Settings.',
  ],
  ['05-empty-dist-dir', 'The Output Directory "dist" is empty.'],
  [
    '06-missing-script',
    'Missing required "vercel-build" script in "package.json"',
  ],
  ['07-nonzero-sh', 'Command "./build.sh" exited with 1'],
  [
    '22-docusaurus-2-build-fail',
    'No Output Directory named "build" found after the Build completed. You can configure the Output Directory in your Project Settings.',
  ],
  [
    '36-hugo-version-not-found',
    'Version 0.0.0 of Hugo does not exist. Please specify a different one.',
  ],
]);

// eslint-disable-next-line no-restricted-syntax
for (const fixture of fs.readdirSync(fixturesPath)) {
  const errMsg = testsThatFailToBuild.get(fixture);
  if (errMsg) {
    // eslint-disable-next-line no-loop-func
    it(`should fail to build ${fixture}`, async () => {
      try {
        await testDeployment(
          { builderUrl, buildUtilsUrl },
          path.join(fixturesPath, fixture)
        );
      } catch (err) {
        expect(err).toBeTruthy();
        expect(err.deployment).toBeTruthy();
        expect(err.deployment.errorMessage).toBe(errMsg);
      }
    });
    continue; //eslint-disable-line
  }
  it(`should build ${fixture}`, async () => {
    await expect(
      testDeployment(
        { builderUrl, buildUtilsUrl },
        path.join(fixturesPath, fixture)
      )
    ).resolves.toBeDefined();
  });
}
