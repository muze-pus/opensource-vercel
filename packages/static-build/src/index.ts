import ms from 'ms';
import path from 'path';
import fetch from 'node-fetch';
import getPort from 'get-port';
import isPortReachable from 'is-port-reachable';
import frameworks, { Framework } from '@vercel/frameworks';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { cpus } from 'os';
import {
  BuildV2,
  Files,
  Config,
  PackageJson,
  PrepareCache,
  glob,
  download,
  spawnAsync,
  execCommand,
  spawnCommand,
  runNpmInstall,
  getEnvForPackageManager,
  getPrefixedEnvVars,
  getNodeBinPath,
  runBundleInstall,
  runPipInstall,
  runPackageJsonScript,
  runShellScript,
  getNodeVersion,
  getSpawnOptions,
  debug,
  NowBuildError,
  scanParentDirs,
  cloneEnv,
} from '@vercel/build-utils';
import type { Route, RouteWithSrc } from '@vercel/routing-utils';
import * as BuildOutputV1 from './utils/build-output-v1';
import * as BuildOutputV2 from './utils/build-output-v2';
import * as BuildOutputV3 from './utils/build-output-v3';
import * as GatsbyUtils from './utils/gatsby';
import * as NuxtUtils from './utils/nuxt';
import type { ImagesConfig, BuildConfig } from './utils/_shared';
import treeKill from 'tree-kill';

const sleep = (n: number) => new Promise(resolve => setTimeout(resolve, n));

const DEV_SERVER_PORT_BIND_TIMEOUT = ms('5m');

async function checkForPort(
  port: number | undefined,
  timeout: number
): Promise<void> {
  const start = Date.now();
  while (!(await isPortReachable(port))) {
    if (Date.now() - start > timeout) {
      throw new Error(`Detecting port ${port} timed out after ${ms(timeout)}`);
    }
    await sleep(100);
  }
}

function validateDistDir(distDir: string) {
  const distDirName = path.basename(distDir);
  const exists = () => existsSync(distDir);
  const isDirectory = () => statSync(distDir).isDirectory();
  const isEmpty = () => readdirSync(distDir).length === 0;

  const link = 'https://vercel.link/missing-public-directory';

  if (!exists()) {
    throw new NowBuildError({
      code: 'STATIC_BUILD_NO_OUT_DIR',
      message: `No Output Directory named "${distDirName}" found after the Build completed. You can configure the Output Directory in your Project Settings.`,
      link,
    });
  }

  if (!isDirectory()) {
    throw new NowBuildError({
      code: 'STATIC_BUILD_NOT_A_DIR',
      message: `The path specified as Output Directory ("${distDirName}") is not actually a directory.`,
      link,
    });
  }

  if (isEmpty()) {
    throw new NowBuildError({
      code: 'STATIC_BUILD_EMPTY_OUT_DIR',
      message: `The Output Directory "${distDirName}" is empty.`,
      link,
    });
  }
}

function hasScript(script: string, pkg: PackageJson) {
  const scripts = (pkg && pkg.scripts) || {};
  return typeof scripts[script] === 'string';
}

function getScriptName(pkg: PackageJson, cmd: string, { zeroConfig }: Config) {
  // The `dev` script can be `now-dev`
  const nowCmd = `now-${cmd}`;

  if (!zeroConfig && cmd === 'dev') {
    return nowCmd;
  }

  if (hasScript(nowCmd, pkg)) {
    return nowCmd;
  }

  if (hasScript(cmd, pkg)) {
    return cmd;
  }

  return zeroConfig ? cmd : nowCmd;
}

function getCommand(
  name: 'install' | 'build' | 'dev',
  pkg: PackageJson | null,
  config: Config,
  framework: Framework | undefined
): string | null {
  if (!config.zeroConfig) {
    return null;
  }

  const propName = `${name}Command`;
  const propValue = config[propName];

  if (typeof propValue === 'string') {
    return propValue;
  }

  if (pkg) {
    const scriptName = getScriptName(pkg, name, config);

    if (hasScript(scriptName, pkg)) {
      return null;
    }
  }

  if (framework) {
    switch (name) {
      case 'install':
        return null; // Install command never has default value
      case 'build':
        return framework.settings.buildCommand.value;
      case 'dev':
        return framework.settings.devCommand.value;
      default: {
        const _exhaustiveCheck: never = name;
        throw new Error(`Unhandled command: ${_exhaustiveCheck}`);
      }
    }
  }

  return null;
}

export const version = 2;

const nowDevScriptPorts = new Map<string, number>();
const nowDevChildProcesses = new Set<ChildProcess>();

['SIGINT', 'SIGTERM'].forEach(signal => {
  process.once(signal as NodeJS.Signals, async () => {
    for (const child of nowDevChildProcesses) {
      debug(
        `Got ${signal}, killing dev server child process (pid=${child.pid})`
      );
      await new Promise(resolve => treeKill(child.pid!, signal, resolve));
    }
    process.exit(0);
  });
});

const getDevRoute = (srcBase: string, devPort: number, route: RouteWithSrc) => {
  const basic: RouteWithSrc = {
    src: `${srcBase}${route.src}`,
    dest: `http://localhost:${devPort}${route.dest}`,
  };

  if (route.headers) {
    basic.headers = route.headers;
  }

  return basic;
};

async function getFrameworkRoutes(
  framework: Framework,
  dirPrefix: string
): Promise<Route[]> {
  if (!framework.defaultRoutes) {
    return [];
  }

  let routes: Route[];

  if (typeof framework.defaultRoutes === 'function') {
    routes = await framework.defaultRoutes(dirPrefix);
  } else {
    routes = framework.defaultRoutes;
  }

  return routes;
}

function getPkg(entrypoint: string, workPath: string) {
  if (path.basename(entrypoint) !== 'package.json') {
    return null;
  }

  try {
    const pkgPath = path.join(workPath, entrypoint);
    const pkg: PackageJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg;
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  return null;
}

function getFramework(
  config: Config | null,
  pkg?: PackageJson | null
): Framework | undefined {
  if (!config || !config.zeroConfig) {
    return;
  }
  const { framework: configFramework = null } = config || {};

  if (configFramework) {
    const framework = frameworks.find(({ slug }) => slug === configFramework);

    if (framework) {
      return framework;
    }
  }

  if (!pkg) {
    return;
  }

  const dependencies = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  const framework = frameworks.find(
    ({ dependency }) => dependencies[dependency || '']
  );
  return framework;
}

async function fetchBinary(url: string, framework: string, version: string) {
  const res = await fetch(url);
  if (res.status === 404) {
    throw new NowBuildError({
      code: 'STATIC_BUILD_BINARY_NOT_FOUND',
      message: `Version ${version} of ${framework} does not exist. Please specify a different one.`,
      link: 'https://vercel.link/framework-versioning',
    });
  }
  await spawnAsync(`curl -sSL ${url} | tar -zx -C /usr/local/bin`, [], {
    shell: true,
  });
}

async function getUpdatedDistPath(
  framework: Framework | undefined,
  outputDirPrefix: string,
  entrypointDir: string,
  distPath: string,
  config: Config
): Promise<string | undefined> {
  if (framework) {
    const outputDirName = config.outputDirectory
      ? config.outputDirectory
      : await framework.getOutputDirName(outputDirPrefix);

    return path.join(outputDirPrefix, outputDirName);
  }

  if (!config || !config.distDir) {
    // Select either `dist` or `public` as directory
    const publicPath = path.join(entrypointDir, 'public');

    if (
      !existsSync(distPath) &&
      existsSync(publicPath) &&
      statSync(publicPath).isDirectory()
    ) {
      return publicPath;
    }
  }

  return undefined;
}

export const build: BuildV2 = async ({
  files,
  entrypoint,
  workPath,
  config,
  meta = {},
}) => {
  await download(files, workPath, meta);

  const mountpoint = path.dirname(entrypoint);
  const entrypointDir = path.join(workPath, mountpoint);

  let distPath = path.join(
    workPath,
    path.dirname(entrypoint),
    (config.distDir as string) || config.outputDirectory || 'dist'
  );

  const pkg = getPkg(entrypoint, workPath);
  const devScript = pkg ? getScriptName(pkg, 'dev', config) : null;
  const framework = getFramework(config, pkg);
  const devCommand = getCommand('dev', pkg, config, framework);
  const buildCommand = getCommand('build', pkg, config, framework);
  const installCommand = getCommand('install', pkg, config, framework);

  if (pkg || buildCommand) {
    const gemfilePath = path.join(workPath, 'Gemfile');
    const requirementsPath = path.join(workPath, 'requirements.txt');
    let isNpmInstall = false;
    let isBundleInstall = false;
    let isPipInstall = false;
    let output: Files = {};
    let images: ImagesConfig | undefined;
    const routes: Route[] = [];

    if (config.zeroConfig) {
      const { HUGO_VERSION, ZOLA_VERSION, GUTENBERG_VERSION } = process.env;

      if (HUGO_VERSION && !meta.isDev) {
        console.log('Installing Hugo version ' + HUGO_VERSION);
        const [major, minor] = HUGO_VERSION.split('.').map(Number);
        const isOldVersion = major === 0 && minor < 43;
        const prefix = isOldVersion ? `hugo_` : `hugo_extended_`;
        const url = `https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/${prefix}${HUGO_VERSION}_Linux-64bit.tar.gz`;
        await fetchBinary(url, 'Hugo', HUGO_VERSION);
      }

      if (ZOLA_VERSION && !meta.isDev) {
        console.log('Installing Zola version ' + ZOLA_VERSION);
        const url = `https://github.com/getzola/zola/releases/download/v${ZOLA_VERSION}/zola-v${ZOLA_VERSION}-x86_64-unknown-linux-gnu.tar.gz`;
        await fetchBinary(url, 'Zola', ZOLA_VERSION);
      }

      if (GUTENBERG_VERSION && !meta.isDev) {
        console.log('Installing Gutenberg version ' + GUTENBERG_VERSION);
        const url = `https://github.com/getzola/zola/releases/download/v${GUTENBERG_VERSION}/gutenberg-v${GUTENBERG_VERSION}-x86_64-unknown-linux-gnu.tar.gz`;
        await fetchBinary(url, 'Gutenberg', GUTENBERG_VERSION);
      }

      // `public` is the default for zero config
      distPath = path.join(
        workPath,
        path.dirname(entrypoint),
        config.outputDirectory || 'public'
      );
    }

    if (framework) {
      debug(
        `Detected ${framework.name} framework. Optimizing your deployment...`
      );

      const prefixedEnvs = getPrefixedEnvVars({
        envPrefix: framework.envPrefix,
        envs: process.env,
      });

      for (const [key, value] of Object.entries(prefixedEnvs)) {
        process.env[key] = value;
      }

      if (process.env.VERCEL_ANALYTICS_ID) {
        const frameworkDirectory = path.join(
          workPath,
          path.dirname(entrypoint)
        );
        switch (framework.slug) {
          case 'gatsby':
            await GatsbyUtils.injectVercelAnalyticsPlugin(frameworkDirectory);
            break;
          case 'nuxtjs':
            await NuxtUtils.injectVercelAnalyticsPlugin(frameworkDirectory);
            break;
          default:
            debug(
              `No analytics plugin injected for framework ${framework.slug}`
            );
            break;
        }
      }
    }

    const nodeVersion = await getNodeVersion(
      entrypointDir,
      undefined,
      config,
      meta
    );
    const spawnOpts = getSpawnOptions(meta, nodeVersion);

    if (!spawnOpts.env) {
      spawnOpts.env = {};
    }

    /* Don't fail the build on warnings from Create React App.
    Node.js will load 'false' as a string, not a boolean, so it's truthy still.
    This is to ensure we don't accidentally break other packages that check
    if process.env.CI is true somewhere.

    https://github.com/facebook/create-react-app/issues/2453
    https://github.com/facebook/create-react-app/pull/2501
    https://github.com/vercel/community/discussions/30
    */
    if (framework?.slug === 'create-react-app') {
      spawnOpts.env.CI = 'false';
    }

    const { cliType, lockfileVersion } = await scanParentDirs(entrypointDir);

    spawnOpts.env = getEnvForPackageManager({
      cliType,
      lockfileVersion,
      nodeVersion,
      env: spawnOpts.env || {},
    });

    if (meta.isDev) {
      debug('Skipping dependency installation because dev mode is enabled');
    } else {
      let hasPrintedInstall = false;
      const printInstall = () => {
        if (!hasPrintedInstall) {
          console.log('Installing dependencies...');
          hasPrintedInstall = true;
        }
      };

      if (!config.zeroConfig) {
        debug('Detected "builds" - not zero config');
        await runNpmInstall(entrypointDir, [], spawnOpts, meta, nodeVersion);
        isNpmInstall = true;
      } else if (typeof installCommand === 'string') {
        if (installCommand.trim()) {
          console.log(`Running "install" command: \`${installCommand}\`...`);
          await execCommand(installCommand, {
            ...spawnOpts,
            cwd: entrypointDir,
          });
          // Its not clear which command was run, so assume all
          isNpmInstall = true;
          isBundleInstall = true;
          isPipInstall = true;
        } else {
          console.log(`Skipping "install" command...`);
        }
      } else {
        if (existsSync(gemfilePath)) {
          debug('Detected Gemfile');
          printInstall();
          const opts = {
            env: cloneEnv(process.env, {
              // See more: https://github.com/rubygems/rubygems/blob/a82d04856deba58be6b90f681a5e42a7c0f2baa7/bundler/lib/bundler/man/bundle-config.1.ronn
              BUNDLE_BIN: 'vendor/bin',
              BUNDLE_CACHE_PATH: 'vendor/cache',
              BUNDLE_PATH: 'vendor/bundle',
              BUNDLE_RETRY: '5',
              BUNDLE_JOBS: String(cpus().length || 1),
              BUNDLE_SILENCE_ROOT_WARNING: '1',
              BUNDLE_DISABLE_SHARED_GEMS: '1',
              BUNDLE_DISABLE_VERSION_CHECK: '1',
            }),
          };
          await runBundleInstall(workPath, [], opts, meta);
          isBundleInstall = true;
        }
        if (existsSync(requirementsPath)) {
          debug('Detected requirements.txt');
          printInstall();
          await runPipInstall(
            workPath,
            ['-r', requirementsPath],
            undefined,
            meta
          );
          isPipInstall = true;
        }
        if (pkg) {
          await runNpmInstall(entrypointDir, [], spawnOpts, meta, nodeVersion);
          isNpmInstall = true;
        }
      }
    }

    let gemHome: string | undefined = undefined;
    const pathList = [];

    if (isNpmInstall || (pkg && (buildCommand || devCommand))) {
      const nodeBinPath = await getNodeBinPath({ cwd: entrypointDir });
      pathList.push(nodeBinPath); // Add `./node_modules/.bin`
      debug(
        `Added "${nodeBinPath}" to PATH env because a package.json file was found`
      );
    }

    if (isBundleInstall) {
      const vendorBin = path.join(workPath, 'vendor', 'bin');
      pathList.push(vendorBin); // Add `./vendor/bin`
      debug(`Added "${vendorBin}" to PATH env because a Gemfile was found`);
      const dir = path.join(workPath, 'vendor', 'bundle', 'ruby');
      const rubyVersion =
        existsSync(dir) && statSync(dir).isDirectory()
          ? readdirSync(dir)[0]
          : '';
      if (rubyVersion) {
        gemHome = path.join(dir, rubyVersion); // Add `./vendor/bundle/ruby/2.7.0`
        debug(`Set GEM_HOME="${gemHome}" because a Gemfile was found`);
      }
    }

    if (isPipInstall) {
      // TODO: Add bins to PATH once we implement pip caching
    }

    if (spawnOpts?.env?.PATH) {
      // Append system path last so others above take precedence
      pathList.push(spawnOpts.env.PATH);
    }

    spawnOpts.env = {
      ...spawnOpts.env,
      PATH: pathList.join(path.delimiter),
      GEM_HOME: gemHome,
    };

    if (
      meta.isDev &&
      (devCommand ||
        (pkg && devScript && pkg.scripts && pkg.scripts[devScript]))
    ) {
      let devPort: number | undefined = nowDevScriptPorts.get(entrypoint);

      if (typeof devPort === 'number') {
        debug(
          '`%s` server already running for %j',
          devCommand || devScript,
          entrypoint
        );
      } else {
        // Run the `now-dev` or `dev` script out-of-bounds, since it is assumed that
        // it will launch a dev server that never "completes"
        devPort = await getPort();
        nowDevScriptPorts.set(entrypoint, devPort);

        const opts: SpawnOptions = {
          cwd: entrypointDir,
          stdio: 'inherit',
          env: { ...spawnOpts.env, PORT: String(devPort) },
        };

        const cmd = devCommand || `yarn run ${devScript}`;
        const child: ChildProcess = spawnCommand(cmd, opts);

        child.on('close', () => nowDevScriptPorts.delete(entrypoint));
        nowDevChildProcesses.add(child);

        // Wait for the server to have listened on `$PORT`, after which we
        // will ProxyPass any requests to that development server that come in
        // for this builder.
        try {
          await checkForPort(devPort, DEV_SERVER_PORT_BIND_TIMEOUT);
        } catch (err) {
          throw new Error(
            `Failed to detect a server running on port ${devPort}.\nDetails: https://err.sh/vercel/vercel/now-static-build-failed-to-detect-a-server`
          );
        }

        debug('Detected dev server for %j', entrypoint);
      }

      let srcBase = mountpoint.replace(/^\.\/?/, '');

      if (srcBase.length > 0) {
        srcBase = `/${srcBase}`;
      }

      // We ignore defaultRoutes for `vercel dev`
      // since in this case it will get proxied to
      // a custom server we don't have control over
      routes.push(
        getDevRoute(srcBase, devPort, {
          src: '/(.*)',
          dest: '/$1',
        })
      );
    } else {
      if (meta.isDev) {
        debug(`WARN: A dev script is missing`);
      }

      if (buildCommand) {
        debug(`Executing "${buildCommand}"`);
      }

      const found =
        typeof buildCommand === 'string'
          ? await execCommand(buildCommand, {
              ...spawnOpts,

              // Yarn v2 PnP mode may be activated, so force
              // "node-modules" linker style
              env: {
                YARN_NODE_LINKER: 'node-modules',
                ...spawnOpts.env,
              },

              cwd: entrypointDir,
            })
          : await runPackageJsonScript(
              entrypointDir,
              ['vercel-build', 'now-build', 'build'],
              spawnOpts
            );

      if (!found) {
        throw new Error(
          `Missing required "${
            buildCommand || 'vercel-build'
          }" script in "${entrypoint}"`
        );
      }

      const outputDirPrefix = path.join(workPath, path.dirname(entrypoint));
      distPath =
        (await getUpdatedDistPath(
          framework,
          outputDirPrefix,
          entrypointDir,
          distPath,
          config
        )) || distPath;

      // If the Build Command or Framework output files according to the
      // Build Output v3 API, then stop processing here in `static-build`
      // since the output is already in its final form.
      const buildOutputPathV3 = await BuildOutputV3.getBuildOutputDirectory(
        outputDirPrefix
      );
      if (buildOutputPathV3) {
        // Ensure that `vercel build` is being used for this Deployment
        return BuildOutputV3.createBuildOutput(
          meta,
          buildCommand,
          buildOutputPathV3,
          framework
        );
      }

      const buildOutputPathV2 = await BuildOutputV2.getBuildOutputDirectory(
        outputDirPrefix
      );
      if (buildOutputPathV2) {
        return await BuildOutputV2.createBuildOutput(workPath);
      }

      const extraOutputs = await BuildOutputV1.readBuildOutputDirectory({
        workPath,
        nodeVersion,
      });

      if (extraOutputs.routes) {
        routes.push(...extraOutputs.routes);
      }

      if (extraOutputs.images) {
        images = extraOutputs.images;
      }

      if (extraOutputs.staticFiles) {
        output = Object.assign(
          {},
          extraOutputs.staticFiles,
          extraOutputs.functions
        );
      } else {
        // No need to verify the dist dir if there are other output files.
        if (!extraOutputs.functions) {
          validateDistDir(distPath);
        }

        if (framework && !extraOutputs.routes) {
          const frameworkRoutes = await getFrameworkRoutes(
            framework,
            outputDirPrefix
          );
          routes.push(...frameworkRoutes);
        }

        let ignore: string[] = [];
        if (config.outputDirectory === '.' || config.distDir === '.') {
          ignore = [
            '.env',
            '.env.*',
            '.git/**',
            '.vercel/**',
            'node_modules/**',
            'yarn.lock',
            'package-lock.json',
            'pnpm-lock.yaml',
            'package.json',
            '.vercel_build_output',
          ];
          debug(`Using ignore: ${JSON.stringify(ignore)}`);
        }
        output = await glob('**', { cwd: distPath, ignore }, mountpoint);
        Object.assign(output, extraOutputs.functions);
      }
    }

    return { routes, images, output };
  }

  if (!config.zeroConfig && entrypoint.endsWith('.sh')) {
    debug(`Running build script "${entrypoint}"`);
    const nodeVersion = await getNodeVersion(
      entrypointDir,
      undefined,
      config,
      meta
    );
    const spawnOpts = getSpawnOptions(meta, nodeVersion);
    await runShellScript(path.join(workPath, entrypoint), [], spawnOpts);
    validateDistDir(distPath);

    const output = await glob('**', distPath, mountpoint);

    return {
      output,
      routes: [],
    };
  }

  let message = `Build "src" is "${entrypoint}" but expected "package.json"`;

  if (!config.zeroConfig) {
    message += ' or "build.sh"';
  }

  throw new Error(message);
};

export const prepareCache: PrepareCache = async ({
  entrypoint,
  repoRootPath,
  workPath,
  config,
}) => {
  const cacheFiles: Files = {};

  // Build Output API v3 cache files
  const configV3 = await BuildOutputV3.readConfig(workPath);
  if (configV3?.cache && Array.isArray(configV3.cache)) {
    for (const cacheGlob of configV3.cache) {
      Object.assign(cacheFiles, await glob(cacheGlob, workPath));
    }
    return cacheFiles;
  }

  // File System API v1 cache files
  const buildConfigV1 = await BuildOutputV1.readBuildOutputConfig<BuildConfig>({
    workPath,
    configFileName: 'build.json',
  });
  if (buildConfigV1?.cache && Array.isArray(buildConfigV1.cache)) {
    for (const cacheGlob of buildConfigV1.cache) {
      Object.assign(cacheFiles, await glob(cacheGlob, workPath));
    }
    return cacheFiles;
  }

  // Default cache files
  Object.assign(
    cacheFiles,
    await glob('**/{.shadow-cljs,node_modules}/**', repoRootPath || workPath)
  );

  // Framework cache files
  const pkg = getPkg(entrypoint, workPath);
  const framework = getFramework(config, pkg);
  if (framework?.cachePattern) {
    Object.assign(cacheFiles, await glob(framework.cachePattern, workPath));
  }

  return cacheFiles;
};
