import fs from 'fs-extra';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { join, normalize, relative, resolve } from 'path';
import {
  getDiscontinuedNodeVersions,
  normalizePath,
  Files,
  FileFsRef,
  PackageJson,
  BuildOptions,
  Config,
  Meta,
  Builder,
  BuildResultV2,
  BuildResultV2Typical,
  BuildResultV3,
  NowBuildError,
} from '@vercel/build-utils';
import { detectBuilders } from '@vercel/fs-detectors';
import minimatch from 'minimatch';
import {
  appendRoutesToPhase,
  getTransformedRoutes,
  mergeRoutes,
  MergeRoutesProps,
  Route,
} from '@vercel/routing-utils';
import { fileNameSymbol } from '@vercel/client';
import type { VercelConfig } from '@vercel/client';

import pull from './pull';
import { staticFiles as getFiles } from '../util/get-files';
import Client from '../util/client';
import getArgs from '../util/get-args';
import cmd from '../util/output/cmd';
import * as cli from '../util/pkg-name';
import cliPkg from '../util/pkg';
import readJSONFile from '../util/read-json-file';
import { CantParseJSONFile } from '../util/errors-ts';
import {
  pickOverrides,
  ProjectLinkAndSettings,
  readProjectSettings,
} from '../util/projects/project-settings';
import { VERCEL_DIR } from '../util/projects/link';
import confirm from '../util/input/confirm';
import { emoji, prependEmoji } from '../util/emoji';
import stamp from '../util/output/stamp';
import {
  OUTPUT_DIR,
  PathOverride,
  writeBuildResult,
} from '../util/build/write-build-result';
import { importBuilders } from '../util/build/import-builders';
import { initCorepack, cleanupCorepack } from '../util/build/corepack';
import { sortBuilders } from '../util/build/sort-builders';
import { toEnumerableError } from '../util/error';
import { validateConfig } from '../util/validate-config';

import { setMonorepoDefaultSettings } from '../util/build/monorepo';

type BuildResult = BuildResultV2 | BuildResultV3;

interface SerializedBuilder extends Builder {
  error?: any;
  require?: string;
  requirePath?: string;
  apiVersion: number;
}

/**
 * Contents of the `builds.json` file.
 */
export interface BuildsManifest {
  '//': string;
  target: string;
  argv: string[];
  error?: any;
  builds?: SerializedBuilder[];
}

const help = () => {
  return console.log(`
   ${chalk.bold(`${cli.logo} ${cli.name} build`)}

   ${chalk.dim('Options:')}

      -h, --help                     Output usage information
      -A ${chalk.bold.underline('FILE')}, --local-config=${chalk.bold.underline(
    'FILE'
  )}   Path to the local ${'`vercel.json`'} file
      -Q ${chalk.bold.underline('DIR')}, --global-config=${chalk.bold.underline(
    'DIR'
  )}    Path to the global ${'`.vercel`'} directory
      --cwd [path]                   The current working directory
      --output [path]                Directory where built assets should be written to
      --prod                         Build a production deployment
      -d, --debug                    Debug mode [off]
      -y, --yes                      Skip the confirmation prompt about pulling environment variables and project settings when not found locally

    ${chalk.dim('Examples:')}

    ${chalk.gray('-')} Build the project

      ${chalk.cyan(`$ ${cli.name} build`)}
      ${chalk.cyan(`$ ${cli.name} build --cwd ./path-to-project`)}
`);
};

export default async function main(client: Client): Promise<number> {
  const { output } = client;

  // Ensure that `vc build` is not being invoked recursively
  if (process.env.__VERCEL_BUILD_RUNNING) {
    output.error(
      `${cmd(
        `${cli.name} build`
      )} must not recursively invoke itself. Check the Build Command in the Project Settings or the ${cmd(
        'build'
      )} script in ${cmd('package.json')}`
    );
    output.error(
      `Learn More: https://vercel.link/recursive-invocation-of-commands`
    );
    return 1;
  } else {
    process.env.__VERCEL_BUILD_RUNNING = '1';
  }

  // Parse CLI args
  const argv = getArgs(client.argv.slice(2), {
    '--output': String,
    '--prod': Boolean,
    '--yes': Boolean,
  });

  if (argv['--help']) {
    help();
    return 2;
  }

  const cwd = process.cwd();

  // Build `target` influences which environment variables will be used
  const target = argv['--prod'] ? 'production' : 'preview';
  const yes = Boolean(argv['--yes']);

  // TODO: read project settings from the API, fall back to local `project.json` if that fails

  // Read project settings, and pull them from Vercel if necessary
  let project = await readProjectSettings(join(cwd, VERCEL_DIR));
  const isTTY = process.stdin.isTTY;
  while (!project?.settings) {
    let confirmed = yes;
    if (!confirmed) {
      if (!isTTY) {
        client.output.print(
          `No Project Settings found locally. Run ${cli.getCommandName(
            'pull --yes'
          )} to retrieve them.`
        );
        return 1;
      }

      confirmed = await confirm(
        client,
        `No Project Settings found locally. Run ${cli.getCommandName(
          'pull'
        )} for retrieving them?`,
        true
      );
    }
    if (!confirmed) {
      client.output.print(`Canceled. No Project Settings retrieved.\n`);
      return 0;
    }
    const { argv: originalArgv } = client;
    client.argv = [
      ...originalArgv.slice(0, 2),
      'pull',
      `--environment`,
      target,
    ];
    const result = await pull(client);
    if (result !== 0) {
      return result;
    }
    client.argv = originalArgv;
    project = await readProjectSettings(join(cwd, VERCEL_DIR));
  }

  // Delete output directory from potential previous build
  const outputDir = argv['--output']
    ? resolve(argv['--output'])
    : join(cwd, OUTPUT_DIR);
  await fs.remove(outputDir);

  const buildsJson: BuildsManifest = {
    '//': 'This file was generated by the `vercel build` command. It is not part of the Build Output API.',
    target,
    argv: process.argv,
  };

  const envToUnset = new Set<string>(['VERCEL', 'NOW_BUILDER']);

  try {
    const envPath = join(cwd, VERCEL_DIR, `.env.${target}.local`);
    // TODO (maybe?): load env vars from the API, fall back to the local file if that fails
    const dotenvResult = dotenv.config({
      path: envPath,
      debug: client.output.isDebugEnabled(),
    });
    if (dotenvResult.error) {
      output.debug(
        `Failed loading environment variables: ${dotenvResult.error}`
      );
    } else if (dotenvResult.parsed) {
      for (const key of Object.keys(dotenvResult.parsed)) {
        envToUnset.add(key);
      }
      output.debug(`Loaded environment variables from "${envPath}"`);
    }

    // For Vercel Analytics support
    if (project.settings.analyticsId) {
      envToUnset.add('VERCEL_ANALYTICS_ID');
      process.env.VERCEL_ANALYTICS_ID = project.settings.analyticsId;
    }

    // Some build processes use these env vars to platform detect Vercel
    process.env.VERCEL = '1';
    process.env.NOW_BUILDER = '1';

    await doBuild(client, project, buildsJson, cwd, outputDir);
    return 0;
  } catch (err: any) {
    output.prettyError(err);

    // Write error to `builds.json` file
    buildsJson.error = toEnumerableError(err);
    const buildsJsonPath = join(outputDir, 'builds.json');
    const configJsonPath = join(outputDir, 'config.json');
    await fs.outputJSON(buildsJsonPath, buildsJson, {
      spaces: 2,
    });
    await fs.writeJSON(configJsonPath, { version: 3 }, { spaces: 2 });

    return 1;
  } finally {
    // Unset environment variables that were added by dotenv
    // (this is mostly for the unit tests)
    for (const key of envToUnset) {
      delete process.env[key];
    }
  }
}

/**
 * Execute the Project's builders. If this function throws an error,
 * then it will be serialized into the `builds.json` manifest file.
 */
async function doBuild(
  client: Client,
  project: ProjectLinkAndSettings,
  buildsJson: BuildsManifest,
  cwd: string,
  outputDir: string
): Promise<void> {
  const { output } = client;

  const workPath = join(cwd, project.settings.rootDirectory || '.');

  const [pkg, vercelConfig, nowConfig] = await Promise.all([
    readJSONFile<PackageJson>(join(workPath, 'package.json')),
    readJSONFile<VercelConfig>(join(workPath, 'vercel.json')),
    readJSONFile<VercelConfig>(join(workPath, 'now.json')),
  ]);

  if (pkg instanceof CantParseJSONFile) throw pkg;
  if (vercelConfig instanceof CantParseJSONFile) throw vercelConfig;
  if (nowConfig instanceof CantParseJSONFile) throw nowConfig;

  if (vercelConfig) {
    vercelConfig[fileNameSymbol] = 'vercel.json';
  } else if (nowConfig) {
    nowConfig[fileNameSymbol] = 'now.json';
  }

  const localConfig = vercelConfig || nowConfig || {};
  const validateError = validateConfig(localConfig);

  if (validateError) {
    throw validateError;
  }

  const projectSettings = {
    ...project.settings,
    ...pickOverrides(localConfig),
  };

  if (
    process.env.VERCEL_BUILD_MONOREPO_SUPPORT === '1' &&
    pkg?.scripts?.['vercel-build'] === undefined &&
    projectSettings.rootDirectory !== null &&
    projectSettings.rootDirectory !== '.'
  ) {
    await setMonorepoDefaultSettings(cwd, workPath, projectSettings, output);
  }

  // Get a list of source files
  const files = (await getFiles(workPath, client)).map(f =>
    normalizePath(relative(workPath, f))
  );

  const routesResult = getTransformedRoutes(localConfig);
  if (routesResult.error) {
    throw routesResult.error;
  }

  if (localConfig.builds && localConfig.functions) {
    throw new NowBuildError({
      code: 'bad_request',
      message:
        'The `functions` property cannot be used in conjunction with the `builds` property. Please remove one of them.',
      link: 'https://vercel.link/functions-and-builds',
    });
  }

  let builds = localConfig.builds || [];
  let zeroConfigRoutes: Route[] = [];
  let isZeroConfig = false;

  if (builds.length > 0) {
    output.warn(
      'Due to `builds` existing in your configuration file, the Build and Development Settings defined in your Project Settings will not apply. Learn More: https://vercel.link/unused-build-settings'
    );
    builds = builds.map(b => expandBuild(files, b)).flat();
  } else {
    // Zero config
    isZeroConfig = true;

    // Detect the Vercel Builders that will need to be invoked
    const detectedBuilders = await detectBuilders(files, pkg, {
      ...localConfig,
      projectSettings,
      ignoreBuildScript: true,
      featHandleMiss: true,
    });

    if (detectedBuilders.errors && detectedBuilders.errors.length > 0) {
      throw detectedBuilders.errors[0];
    }

    for (const w of detectedBuilders.warnings) {
      console.log(
        `Warning: ${w.message} ${w.action || 'Learn More'}: ${w.link}`
      );
    }

    if (detectedBuilders.builders) {
      builds = detectedBuilders.builders;
    } else {
      builds = [{ src: '**', use: '@vercel/static' }];
    }

    zeroConfigRoutes.push(...(detectedBuilders.redirectRoutes || []));
    zeroConfigRoutes.push(
      ...appendRoutesToPhase({
        routes: [],
        newRoutes: detectedBuilders.rewriteRoutes,
        phase: 'filesystem',
      })
    );
    zeroConfigRoutes = appendRoutesToPhase({
      routes: zeroConfigRoutes,
      newRoutes: detectedBuilders.errorRoutes,
      phase: 'error',
    });
    zeroConfigRoutes.push(...(detectedBuilders.defaultRoutes || []));
  }

  const builderSpecs = new Set(builds.map(b => b.use));

  const buildersWithPkgs = await importBuilders(builderSpecs, cwd, output);

  // Populate Files -> FileFsRef mapping
  const filesMap: Files = {};
  for (const path of files) {
    const fsPath = join(workPath, path);
    const { mode } = await fs.stat(fsPath);
    filesMap[path] = new FileFsRef({ mode, fsPath });
  }

  const buildStamp = stamp();

  // Create fresh new output directory
  await fs.mkdirp(outputDir);

  const ops: Promise<Error | void>[] = [];

  // Write the `detectedBuilders` result to output dir
  const buildsJsonBuilds = new Map<Builder, SerializedBuilder>(
    builds.map(build => {
      const builderWithPkg = buildersWithPkgs.get(build.use);
      if (!builderWithPkg) {
        throw new Error(`Failed to load Builder "${build.use}"`);
      }
      const { builder, pkg: builderPkg } = builderWithPkg;
      return [
        build,
        {
          require: builderPkg.name,
          requirePath: builderWithPkg.path,
          apiVersion: builder.version,
          ...build,
        },
      ];
    })
  );
  buildsJson.builds = Array.from(buildsJsonBuilds.values());
  await fs.writeJSON(join(outputDir, 'builds.json'), buildsJson, {
    spaces: 2,
  });

  // The `meta` config property is re-used for each Builder
  // invocation so that Builders can share state between
  // subsequent entrypoint builds.
  const meta: Meta = {
    skipDownload: true,
    cliVersion: cliPkg.version,
  };

  // Execute Builders for detected entrypoints
  // TODO: parallelize builds (except for frontend)
  const sortedBuilders = sortBuilders(builds);
  const buildResults: Map<Builder, BuildResult> = new Map();
  const overrides: PathOverride[] = [];
  const repoRootPath = cwd;
  const corepackShimDir = await initCorepack({ repoRootPath });

  for (const build of sortedBuilders) {
    if (typeof build.src !== 'string') continue;

    const builderWithPkg = buildersWithPkgs.get(build.use);
    if (!builderWithPkg) {
      throw new Error(`Failed to load Builder "${build.use}"`);
    }

    try {
      const { builder, pkg: builderPkg } = builderWithPkg;

      const buildConfig: Config = isZeroConfig
        ? {
            outputDirectory: projectSettings.outputDirectory ?? undefined,
            ...build.config,
            projectSettings,
            installCommand: projectSettings.installCommand ?? undefined,
            devCommand: projectSettings.devCommand ?? undefined,
            buildCommand: projectSettings.buildCommand ?? undefined,
            framework: projectSettings.framework,
            nodeVersion: projectSettings.nodeVersion,
          }
        : build.config || {};
      const buildOptions: BuildOptions = {
        files: filesMap,
        entrypoint: build.src,
        workPath,
        repoRootPath,
        config: buildConfig,
        meta,
      };
      output.debug(
        `Building entrypoint "${build.src}" with "${builderPkg.name}"`
      );
      const buildResult = await builder.build(buildOptions);

      if (
        buildResult &&
        'output' in buildResult &&
        'runtime' in buildResult.output &&
        'type' in buildResult.output &&
        buildResult.output.type === 'Lambda'
      ) {
        const lambdaRuntime = buildResult.output.runtime;
        if (
          getDiscontinuedNodeVersions().some(o => o.runtime === lambdaRuntime)
        ) {
          throw new NowBuildError({
            code: 'NODEJS_DISCONTINUED_VERSION',
            message: `The Runtime "${build.use}" is using "${lambdaRuntime}", which is discontinued. Please upgrade your Runtime to a more recent version or consult the author for more details.`,
            link: 'https://github.com/vercel/vercel/blob/main/DEVELOPING_A_RUNTIME.md#lambdaruntime',
          });
        }
      }

      // Store the build result to generate the final `config.json` after
      // all builds have completed
      buildResults.set(build, buildResult);

      // Start flushing the file outputs to the filesystem asynchronously
      ops.push(
        writeBuildResult(
          outputDir,
          buildResult,
          build,
          builder,
          builderPkg,
          localConfig
        ).then(
          override => {
            if (override) overrides.push(override);
          },
          err => err
        )
      );
    } catch (err: any) {
      const buildJsonBuild = buildsJsonBuilds.get(build);
      if (buildJsonBuild) {
        buildJsonBuild.error = toEnumerableError(err);
      }
      throw err;
    }
  }

  if (corepackShimDir) {
    cleanupCorepack(corepackShimDir);
  }

  // Wait for filesystem operations to complete
  // TODO render progress bar?
  const errors = await Promise.all(ops);
  for (const error of errors) {
    if (error) {
      throw error;
    }
  }

  // Merge existing `config.json` file into the one that will be produced
  const configPath = join(outputDir, 'config.json');
  // TODO: properly type
  const existingConfig = await readJSONFile<any>(configPath);
  if (existingConfig instanceof CantParseJSONFile) {
    throw existingConfig;
  }
  if (existingConfig) {
    if (existingConfig.overrides) {
      overrides.push(existingConfig.overrides);
    }
    // Find the `Build` entry for this config file and update the build result
    for (const [build, buildResult] of buildResults.entries()) {
      if ('buildOutputPath' in buildResult) {
        output.debug(`Using "config.json" for "${build.use}`);
        buildResults.set(build, existingConfig);
        break;
      }
    }
  }

  const builderRoutes: MergeRoutesProps['builds'] = Array.from(
    buildResults.entries()
  )
    .filter(b => 'routes' in b[1] && Array.isArray(b[1].routes))
    .map(b => {
      return {
        use: b[0].use,
        entrypoint: b[0].src!,
        routes: (b[1] as BuildResultV2Typical).routes,
      };
    });
  if (zeroConfigRoutes.length) {
    builderRoutes.unshift({
      use: '@vercel/zero-config-routes',
      entrypoint: '/',
      routes: zeroConfigRoutes,
    });
  }
  const mergedRoutes = mergeRoutes({
    userRoutes: routesResult.routes,
    builds: builderRoutes,
  });

  const mergedImages = mergeImages(localConfig.images, buildResults.values());
  const mergedWildcard = mergeWildcard(buildResults.values());
  const mergedOverrides: Record<string, PathOverride> =
    overrides.length > 0 ? Object.assign({}, ...overrides) : undefined;

  // Write out the final `config.json` file based on the
  // user configuration and Builder build results
  // TODO: properly type
  const config = {
    version: 3,
    routes: mergedRoutes,
    images: mergedImages,
    wildcard: mergedWildcard,
    overrides: mergedOverrides,
  };
  await fs.writeJSON(join(outputDir, 'config.json'), config, { spaces: 2 });

  const relOutputDir = relative(cwd, outputDir);
  output.print(
    `${prependEmoji(
      `Build Completed in ${chalk.bold(
        relOutputDir.startsWith('..') ? outputDir : relOutputDir
      )} ${chalk.gray(buildStamp())}`,
      emoji('success')
    )}\n`
  );
}

function expandBuild(files: string[], build: Builder): Builder[] {
  if (!build.use) {
    throw new NowBuildError({
      code: `invalid_build_specification`,
      message: 'Field `use` is missing in build specification',
      link: 'https://vercel.com/docs/configuration#project/builds',
      action: 'View Documentation',
    });
  }

  let src = normalize(build.src || '**');
  if (src === '.' || src === './') {
    throw new NowBuildError({
      code: `invalid_build_specification`,
      message: 'A build `src` path resolves to an empty string',
      link: 'https://vercel.com/docs/configuration#project/builds',
      action: 'View Documentation',
    });
  }

  if (src[0] === '/') {
    // Remove a leading slash so that the globbing is relative
    // to `cwd` instead of the root of the filesystem.
    src = src.substring(1);
  }

  const matches = files.filter(
    name => name === src || minimatch(name, src, { dot: true })
  );

  return matches.map(m => {
    return {
      ...build,
      src: m,
    };
  });
}

function mergeImages(
  images: BuildResultV2Typical['images'],
  buildResults: Iterable<BuildResult>
): BuildResultV2Typical['images'] {
  for (const result of buildResults) {
    if ('images' in result && result.images) {
      images = Object.assign({}, images, result.images);
    }
  }
  return images;
}

function mergeWildcard(
  buildResults: Iterable<BuildResult>
): BuildResultV2Typical['wildcard'] {
  let wildcard: BuildResultV2Typical['wildcard'] = undefined;
  for (const result of buildResults) {
    if ('wildcard' in result && result.wildcard) {
      if (!wildcard) wildcard = [];
      wildcard.push(...result.wildcard);
    }
  }
  return wildcard;
}
