import {
  FileFsRef,
  Files,
  Config,
  debug,
  FileBlob,
  glob,
  Lambda,
  Prerender,
  getLambdaOptionsFromFunction,
  getPlatformEnv,
  streamToBuffer,
  NowBuildError,
  isSymbolicLink,
  NodejsLambda,
  EdgeFunction,
} from '@vercel/build-utils';
import { NodeFileTraceReasons } from '@vercel/nft';
import { Header, Rewrite, Route, Source } from '@vercel/routing-utils';
import { Sema } from 'async-sema';
import crc32 from 'buffer-crc32';
import fs, { lstat, stat } from 'fs-extra';
import path from 'path';
import resolveFrom from 'resolve-from';
import semver from 'semver';
import zlib from 'zlib';
import url from 'url';
import escapeStringRegexp from 'escape-string-regexp';
import { htmlContentType } from '.';
import textTable from 'text-table';
import prettyBytes from 'pretty-bytes';
import { getNextjsEdgeFunctionSource } from './edge-function-source/get-edge-function-source';
import type { LambdaOptionsWithFiles } from '@vercel/build-utils/dist/lambda';
import { stringifySourceMap } from './sourcemapped';
import type { RawSourceMap } from 'source-map';

type stringMap = { [key: string]: string };

// Identify /[param]/ in route string
// eslint-disable-next-line no-useless-escape
const TEST_DYNAMIC_ROUTE = /\/\[[^\/]+?\](?=\/|$)/;

function isDynamicRoute(route: string): boolean {
  route = route.startsWith('/') ? route : `/${route}`;
  return TEST_DYNAMIC_ROUTE.test(route);
}

/**
 * Validate if the entrypoint is allowed to be used
 */
function validateEntrypoint(entrypoint: string) {
  if (
    !/package\.json$/.exec(entrypoint) &&
    !/next\.config\.js$/.exec(entrypoint)
  ) {
    throw new NowBuildError({
      message:
        'Specified "src" for "@vercel/next" has to be "package.json" or "next.config.js"',
      code: 'NEXT_INCORRECT_SRC',
    });
  }
}

/**
 * Exclude certain files from the files object
 */
function excludeFiles(
  files: Files,
  matcher: (filePath: string) => boolean
): Files {
  return Object.keys(files).reduce((newFiles, filePath) => {
    if (matcher(filePath)) {
      return newFiles;
    }
    return {
      ...newFiles,
      [filePath]: files[filePath],
    };
  }, {});
}

/**
 * Enforce specific package.json configuration for smallest possible lambda
 */
function normalizePackageJson(
  defaultPackageJson: {
    dependencies?: stringMap;
    devDependencies?: stringMap;
    scripts?: stringMap;
  } = {}
) {
  const dependencies: stringMap = {};
  const devDependencies: stringMap = {
    ...defaultPackageJson.dependencies,
    ...defaultPackageJson.devDependencies,
  };

  if (devDependencies.react) {
    dependencies.react = devDependencies.react;
    delete devDependencies.react;
  }

  if (devDependencies['react-dom']) {
    dependencies['react-dom'] = devDependencies['react-dom'];
    delete devDependencies['react-dom'];
  }

  delete devDependencies['next-server'];

  return {
    ...defaultPackageJson,
    dependencies: {
      // react and react-dom can be overwritten
      react: 'latest',
      'react-dom': 'latest',
      ...dependencies, // override react if user provided it
      // next-server is forced to canary
      'next-server': 'v7.0.2-canary.49',
    },
    devDependencies: {
      ...devDependencies,
      // next is forced to canary
      next: 'v7.0.2-canary.49',
    },
    scripts: {
      ...defaultPackageJson.scripts,
      'now-build':
        'NODE_OPTIONS=--max_old_space_size=3000 next build --lambdas',
    },
  };
}

async function getNextConfig(workPath: string, entryPath: string) {
  const entryConfig = path.join(entryPath, './next.config.js');
  if (await fs.pathExists(entryConfig)) {
    return fs.readFile(entryConfig, 'utf8');
  }

  const workConfig = path.join(workPath, './next.config.js');
  if (await fs.pathExists(workConfig)) {
    return fs.readFile(workConfig, 'utf8');
  }

  return null;
}

function normalizePage(page: string): string {
  // Resolve on anything that doesn't start with `/`
  if (!page.startsWith('/')) {
    page = `/${page}`;
  }
  // remove '/index' from the end
  page = page.replace(/\/index$/, '/');
  return page;
}

export type Redirect = Rewrite & {
  statusCode?: number;
  permanent?: boolean;
};

type RoutesManifestRegex = {
  regex: string;
  regexKeys: string[];
};

type RoutesManifestRoute = {
  page: string;
  regex: string;
  namedRegex?: string;
  routeKeys?: { [named: string]: string };
};

type RoutesManifestOld = {
  pages404: boolean;
  basePath: string | undefined;
  redirects: (Redirect & RoutesManifestRegex)[];
  rewrites:
    | (Rewrite & RoutesManifestRegex)[]
    | {
        beforeFiles: (Rewrite & RoutesManifestRegex)[];
        afterFiles: (Rewrite & RoutesManifestRegex)[];
        fallback: (Rewrite & RoutesManifestRegex)[];
      };
  headers?: (Header & RoutesManifestRegex)[];
  dynamicRoutes: RoutesManifestRoute[];
  staticRoutes: RoutesManifestRoute[];
  version: 1 | 2 | 3;
  dataRoutes?: Array<{
    page: string;
    dataRouteRegex: string;
    namedDataRouteRegex?: string;
    routeKeys?: { [named: string]: string };
  }>;
  i18n?: {
    localeDetection?: boolean;
    defaultLocale: string;
    locales: string[];
    domains?: Array<{
      http?: boolean;
      domain: string;
      locales?: string[];
      defaultLocale: string;
    }>;
  };
};

type RoutesManifestV4 = Omit<RoutesManifestOld, 'dynamicRoutes' | 'version'> & {
  version: 4;
  dynamicRoutes: (RoutesManifestRoute | { page: string; isMiddleware: true })[];
};

export type RoutesManifest = RoutesManifestV4 | RoutesManifestOld;

export async function getRoutesManifest(
  entryPath: string,
  outputDirectory: string,
  nextVersion?: string
): Promise<RoutesManifest | undefined> {
  const shouldHaveManifest =
    nextVersion && semver.gte(nextVersion, '9.1.4-canary.0');
  if (!shouldHaveManifest) return;

  const pathRoutesManifest = path.join(
    entryPath,
    outputDirectory,
    'routes-manifest.json'
  );
  const hasRoutesManifest = await fs
    .access(pathRoutesManifest)
    .then(() => true)
    .catch(() => false);

  if (shouldHaveManifest && !hasRoutesManifest) {
    throw new NowBuildError({
      message:
        `The file "${pathRoutesManifest}" couldn't be found. This is normally caused by a misconfiguration in your project.\n` +
        'Please check the following, and reach out to support if you cannot resolve the problem:\n' +
        '  1. If present, be sure your `build` script in "package.json" calls `next build`.' +
        '  2. Navigate to your project\'s settings in the Vercel dashboard, and verify that the "Build Command" is not overridden, or that it calls `next build`.' +
        '  3. Navigate to your project\'s settings in the Vercel dashboard, and verify that the "Output Directory" is not overridden. Note that `next export` does **not** require you change this setting, even if you customize the `next export` output directory.',
      link: 'https://err.sh/vercel/vercel/now-next-routes-manifest',
      code: 'NEXT_NO_ROUTES_MANIFEST',
    });
  }

  const routesManifest: RoutesManifest = await fs.readJSON(pathRoutesManifest);
  // remove temporary array based routeKeys from v1/v2 of routes
  // manifest since it can result in invalid routes
  for (const route of routesManifest.dataRoutes || []) {
    if (Array.isArray(route.routeKeys)) {
      delete route.routeKeys;
      delete route.namedDataRouteRegex;
    }
  }
  for (const route of routesManifest.dynamicRoutes || []) {
    if ('routeKeys' in route && Array.isArray(route.routeKeys)) {
      delete route.routeKeys;
      delete route.namedRegex;
    }
  }

  return routesManifest;
}

export async function getDynamicRoutes(
  entryPath: string,
  entryDirectory: string,
  dynamicPages: string[],
  isDev?: boolean,
  routesManifest?: RoutesManifest,
  omittedRoutes?: Set<string>,
  canUsePreviewMode?: boolean,
  bypassToken?: string,
  isServerMode?: boolean,
  dynamicMiddlewareRouteMap?: Map<string, Source>
): Promise<Source[]> {
  if (routesManifest) {
    switch (routesManifest.version) {
      case 1:
      case 2: {
        return routesManifest.dynamicRoutes
          .filter(({ page }) => canUsePreviewMode || !omittedRoutes?.has(page))
          .map(({ page, regex }: { page: string; regex: string }) => {
            return {
              src: regex,
              dest: !isDev ? path.join('/', entryDirectory, page) : page,
              check: true,
              status:
                canUsePreviewMode && omittedRoutes?.has(page) ? 404 : undefined,
            };
          });
      }
      case 3:
      case 4: {
        return routesManifest.dynamicRoutes
          .filter(({ page }) => canUsePreviewMode || !omittedRoutes?.has(page))
          .map(params => {
            if ('isMiddleware' in params) {
              const route = dynamicMiddlewareRouteMap?.get(params.page);
              if (!route) {
                throw new Error(
                  `Could not find dynamic middleware route for ${params.page}`
                );
              }
              return route;
            }

            const { page, namedRegex, regex, routeKeys } = params;
            const route: Source = {
              src: namedRegex || regex,
              dest: `${!isDev ? path.join('/', entryDirectory, page) : page}${
                routeKeys
                  ? `?${Object.keys(routeKeys)
                      .map(key => `${routeKeys[key]}=$${key}`)
                      .join('&')}`
                  : ''
              }`,
            };

            if (!isServerMode) {
              route.check = true;
            }

            if (isServerMode && canUsePreviewMode && omittedRoutes?.has(page)) {
              // only match this route when in preview mode so
              // preview works for non-prerender fallback: false pages
              route.has = [
                {
                  type: 'cookie',
                  key: '__prerender_bypass',
                  value: bypassToken || undefined,
                },
                {
                  type: 'cookie',
                  key: '__next_preview_data',
                },
              ];
            }

            return route;
          });
      }
      default: {
        // update MIN_ROUTES_MANIFEST_VERSION
        throw new NowBuildError({
          message:
            'This version of `@vercel/next` does not support the version of Next.js you are trying to deploy.\n' +
            'Please upgrade your `@vercel/next` builder and try again. Contact support if this continues to happen.',
          code: 'NEXT_VERSION_UPGRADE',
        });
      }
    }
  }

  // FALLBACK:
  // When `routes-manifest.json` does not exist (old Next.js versions), we'll try to
  // require the methods we need from Next.js' internals.
  if (!dynamicPages.length) {
    return [];
  }

  let getRouteRegex: ((pageName: string) => { re: RegExp }) | undefined =
    undefined;

  let getSortedRoutes: ((normalizedPages: string[]) => string[]) | undefined;

  try {
    // NOTE: `eval('require')` is necessary to avoid bad transpilation to `__webpack_require__`
    ({ getRouteRegex, getSortedRoutes } = eval('require')(
      resolveFrom(entryPath, 'next-server/dist/lib/router/utils')
    ));
    if (typeof getRouteRegex !== 'function') {
      getRouteRegex = undefined;
    }
  } catch (_) {} // eslint-disable-line no-empty

  if (!getRouteRegex || !getSortedRoutes) {
    try {
      // NOTE: `eval('require')` is necessary to avoid bad transpilation to `__webpack_require__`
      ({ getRouteRegex, getSortedRoutes } = eval('require')(
        resolveFrom(entryPath, 'next/dist/next-server/lib/router/utils')
      ));
      if (typeof getRouteRegex !== 'function') {
        getRouteRegex = undefined;
      }
    } catch (_) {} // eslint-disable-line no-empty
  }

  if (!getRouteRegex || !getSortedRoutes) {
    throw new NowBuildError({
      message:
        'Found usage of dynamic routes but not on a new enough version of Next.js.',
      code: 'NEXT_DYNAMIC_ROUTES_OUTDATED',
    });
  }

  const pageMatchers = getSortedRoutes(dynamicPages).map(pageName => ({
    pageName,
    matcher: getRouteRegex && getRouteRegex(pageName).re,
  }));

  const routes: Source[] = [];
  pageMatchers.forEach(pageMatcher => {
    // in `vercel dev` we don't need to prefix the destination
    const dest = !isDev
      ? path.join('/', entryDirectory, pageMatcher.pageName)
      : pageMatcher.pageName;

    if (pageMatcher && pageMatcher.matcher) {
      routes.push({
        src: pageMatcher.matcher.source,
        dest,
        check: !isDev,
      });
    }
  });
  return routes;
}

export function localizeDynamicRoutes(
  dynamicRoutes: Source[],
  dynamicPrefix: string,
  entryDirectory: string,
  staticPages: Files,
  prerenderManifest: NextPrerenderedRoutes,
  routesManifest?: RoutesManifest,
  isServerMode?: boolean,
  isCorrectLocaleAPIRoutes?: boolean
): Source[] {
  return dynamicRoutes.map((route: Source) => {
    // i18n is already handled for middleware
    if (route.middleware !== undefined || route.middlewarePath !== undefined)
      return route;

    const { i18n } = routesManifest || {};

    if (i18n) {
      const { pathname } = url.parse(route.dest!);
      const pathnameNoPrefix = pathname?.replace(dynamicPrefix, '');
      const isFallback = prerenderManifest.fallbackRoutes[pathname!];
      const isBlocking = prerenderManifest.blockingFallbackRoutes[pathname!];
      const isApiRoute =
        pathnameNoPrefix === '/api' || pathnameNoPrefix?.startsWith('/api/');
      const isAutoExport =
        staticPages[addLocaleOrDefault(pathname!, routesManifest).substring(1)];

      const isLocalePrefixed =
        isFallback || isBlocking || isAutoExport || isServerMode;

      route.src = route.src.replace(
        '^',
        `^${dynamicPrefix ? `${dynamicPrefix}[/]?` : '[/]?'}(?${
          isLocalePrefixed ? '<nextLocale>' : ':'
        }${i18n.locales.map(locale => escapeStringRegexp(locale)).join('|')})?`
      );

      if (isLocalePrefixed && !(isCorrectLocaleAPIRoutes && isApiRoute)) {
        // ensure destination has locale prefix to match prerender output
        // path so that the prerender object is used
        route.dest = route.dest!.replace(
          `${path.join('/', entryDirectory, '/')}`,
          `${path.join('/', entryDirectory, '$nextLocale', '/')}`
        );
      }
    } else {
      route.src = route.src.replace('^', `^${dynamicPrefix}`);
    }
    return route;
  });
}

type LoaderKey = 'imgix' | 'cloudinary' | 'akamai' | 'default';

export type NextImagesManifest = {
  version: number;
  images: {
    loader: LoaderKey;
    sizes: number[];
    domains: string[];
    remotePatterns: RemotePattern[];
    minimumCacheTTL?: number;
    formats?: ImageFormat[];
    dangerouslyAllowSVG?: boolean;
    contentSecurityPolicy?: string;
  };
};

export type RemotePattern = {
  /**
   * Must be `http` or `https`.
   */
  protocol?: 'http' | 'https';

  /**
   * Can be literal or wildcard.
   * Single `*` matches a single subdomain.
   * Double `**` matches any number of subdomains.
   */
  hostname: string;

  /**
   * Can be literal port such as `8080` or empty string
   * meaning no port.
   */
  port?: string;

  /**
   * Can be literal or wildcard.
   * Single `*` matches a single path segment.
   * Double `**` matches any number of path segments.
   */
  pathname?: string;
};

type ImageFormat = 'image/avif' | 'image/webp';

export async function getImagesManifest(
  entryPath: string,
  outputDirectory: string
): Promise<NextImagesManifest | undefined> {
  const pathImagesManifest = path.join(
    entryPath,
    outputDirectory,
    'images-manifest.json'
  );

  const hasImagesManifest = await fs
    .access(pathImagesManifest)
    .then(() => true)
    .catch(() => false);

  if (!hasImagesManifest) {
    return undefined;
  }

  return fs.readJson(pathImagesManifest);
}

type FileMap = { [page: string]: FileFsRef };

export function filterStaticPages(
  staticPageFiles: FileMap,
  dynamicPages: string[],
  entryDirectory: string,
  htmlContentType: string,
  prerenderManifest: NextPrerenderedRoutes,
  routesManifest?: RoutesManifest
) {
  const staticPages: FileMap = {};

  Object.keys(staticPageFiles).forEach((page: string) => {
    const pathname = page.replace(/\.html$/, '');
    const routeName = normalizeLocalePath(
      normalizePage(pathname),
      routesManifest?.i18n?.locales
    ).pathname;

    // Prerendered routes emit a `.html` file but should not be treated as a
    // static page.
    // Lazily prerendered routes have a fallback `.html` file on newer
    // Next.js versions so we need to also not treat it as a static page here.
    if (
      prerenderManifest.staticRoutes[routeName] ||
      prerenderManifest.fallbackRoutes[routeName] ||
      prerenderManifest.staticRoutes[normalizePage(pathname)] ||
      prerenderManifest.fallbackRoutes[normalizePage(pathname)]
    ) {
      return;
    }

    const staticRoute = path.join(entryDirectory, pathname);

    staticPages[staticRoute] = staticPageFiles[page];
    staticPages[staticRoute].contentType = htmlContentType;

    if (isDynamicRoute(pathname)) {
      dynamicPages.push(routeName);
      return;
    }
  });

  return staticPages;
}

export function getFilesMapFromReasons(
  fileList: Set<string>,
  reasons: NodeFileTraceReasons,
  ignoreFn?: (file: string, parent?: string) => boolean
) {
  // this uses the reasons tree to collect files specific to a
  // certain parent allowing us to not have to trace each parent
  // separately
  const parentFilesMap = new Map<string, Set<string>>();

  function propagateToParents(
    parents: Set<string>,
    file: string,
    seen = new Set<string>()
  ) {
    for (const parent of parents || []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        let parentFiles = parentFilesMap.get(parent);

        if (!parentFiles) {
          parentFiles = new Set();
          parentFilesMap.set(parent, parentFiles);
        }

        if (!ignoreFn?.(file, parent)) {
          parentFiles.add(file);
        }
        const parentReason = reasons.get(parent);

        if (parentReason?.parents) {
          propagateToParents(parentReason.parents, file, seen);
        }
      }
    }
  }

  for (const file of fileList!) {
    const reason = reasons!.get(file);
    const isInitial =
      reason?.type.length === 1 && reason.type.includes('initial');

    if (
      !reason ||
      !reason.parents ||
      (isInitial && reason.parents.size === 0)
    ) {
      continue;
    }
    propagateToParents(reason.parents, file);
  }
  return parentFilesMap;
}

export const collectTracedFiles =
  (
    baseDir: string,
    lstatResults: { [key: string]: ReturnType<typeof lstat> },
    lstatSema: Sema,
    reasons: NodeFileTraceReasons,
    files: { [filePath: string]: FileFsRef }
  ) =>
  async (file: string) => {
    const reason = reasons.get(file);
    if (reason && reason.type.includes('initial')) {
      // Initial files are manually added to the lambda later
      return;
    }
    const filePath = path.join(baseDir, file);

    if (!lstatResults[filePath]) {
      lstatResults[filePath] = lstatSema
        .acquire()
        .then(() => lstat(filePath))
        .finally(() => lstatSema.release());
    }
    const { mode } = await lstatResults[filePath];

    files[file] = new FileFsRef({
      fsPath: path.join(baseDir, file),
      mode,
    });
  };

export const ExperimentalTraceVersion = `9.0.4-canary.1`;

export type PseudoLayer = {
  [fileName: string]: PseudoFile | PseudoSymbolicLink;
};

export type PseudoFile = {
  file: FileFsRef;
  isSymlink: false;
  crc32: number;
  compBuffer: Buffer;
  uncompressedSize: number;
};

export type PseudoSymbolicLink = {
  file: FileFsRef;
  isSymlink: true;
  symlinkTarget: string;
};

const compressBuffer = (buf: Buffer): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(
      buf,
      { level: zlib.constants.Z_BEST_COMPRESSION },
      (err, compBuf) => {
        if (err) return reject(err);
        resolve(compBuf);
      }
    );
  });
};

export type PseudoLayerResult = {
  pseudoLayer: PseudoLayer;
  pseudoLayerBytes: number;
};

export async function createPseudoLayer(files: {
  [fileName: string]: FileFsRef;
}): Promise<PseudoLayerResult> {
  const pseudoLayer: PseudoLayer = {};
  let pseudoLayerBytes = 0;

  for (const fileName of Object.keys(files)) {
    const file = files[fileName];

    if (isSymbolicLink(file.mode)) {
      const symlinkTarget = await fs.readlink(file.fsPath);
      pseudoLayer[fileName] = {
        file,
        isSymlink: true,
        symlinkTarget,
      };
    } else {
      const origBuffer = await streamToBuffer(file.toStream());
      const compBuffer = await compressBuffer(origBuffer);
      pseudoLayerBytes += compBuffer.byteLength;
      pseudoLayer[fileName] = {
        file,
        compBuffer,
        isSymlink: false,
        crc32: crc32.unsigned(origBuffer),
        uncompressedSize: origBuffer.byteLength,
      };
    }
  }

  return { pseudoLayer, pseudoLayerBytes };
}

interface CreateLambdaFromPseudoLayersOptions extends LambdaOptionsWithFiles {
  layers: PseudoLayer[];
}

// measured with 1, 2, 5, 10, and `os.cpus().length || 5`
// and sema(1) produced the best results
const createLambdaSema = new Sema(1);

export async function createLambdaFromPseudoLayers({
  files: baseFiles,
  layers,
  ...lambdaOptions
}: CreateLambdaFromPseudoLayersOptions) {
  await createLambdaSema.acquire();

  const files: Files = {};
  const addedFiles = new Set();

  // Add files from pseudo layers
  for (const layer of layers) {
    for (const seedKey of Object.keys(layer)) {
      if (addedFiles.has(seedKey)) {
        // File was already added in a previous pseudo layer
        continue;
      }
      const item = layer[seedKey];
      files[seedKey] = item.file;
      addedFiles.add(seedKey);
    }
  }

  for (const fileName of Object.keys(baseFiles)) {
    if (addedFiles.has(fileName)) {
      // File was already added in a previous pseudo layer
      continue;
    }
    const file = baseFiles[fileName];
    files[fileName] = file;
    addedFiles.add(fileName);
  }

  createLambdaSema.release();

  return new NodejsLambda({
    ...lambdaOptions,
    files,
    shouldAddHelpers: false,
    shouldAddSourcemapSupport: false,
    supportsMultiPayloads: !!process.env.NEXT_PRIVATE_MULTI_PAYLOAD,
  });
}

export type NextRequiredServerFilesManifest = {
  appDir?: string;
  files: string[];
  ignore: string[];
  config: Record<string, any>;
};

export type NextPrerenderedRoutes = {
  bypassToken: string | null;

  staticRoutes: {
    [route: string]: {
      initialRevalidate: number | false;
      dataRoute: string;
      srcRoute: string | null;
    };
  };

  blockingFallbackRoutes: {
    [route: string]: {
      routeRegex: string;
      dataRoute: string;
      dataRouteRegex: string;
    };
  };

  fallbackRoutes: {
    [route: string]: {
      fallback: string;
      routeRegex: string;
      dataRoute: string;
      dataRouteRegex: string;
    };
  };

  omittedRoutes: {
    [route: string]: {
      routeRegex: string;
      dataRoute: string;
      dataRouteRegex: string;
    };
  };

  notFoundRoutes: string[];

  isLocalePrefixed: boolean;
};

export async function getExportIntent(
  entryPath: string
): Promise<false | { trailingSlash: boolean }> {
  const pathExportMarker = path.join(entryPath, '.next', 'export-marker.json');
  const hasExportMarker: boolean = await fs
    .access(pathExportMarker, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);

  if (!hasExportMarker) {
    return false;
  }

  const manifest: {
    version: 1;
    exportTrailingSlash: boolean;
    hasExportPathMap: boolean;
  } = JSON.parse(await fs.readFile(pathExportMarker, 'utf8'));

  switch (manifest.version) {
    case 1: {
      if (manifest.hasExportPathMap !== true) {
        return false;
      }

      return { trailingSlash: manifest.exportTrailingSlash };
    }

    default: {
      return false;
    }
  }
}

export async function getExportStatus(
  entryPath: string
): Promise<false | { success: boolean; outDirectory: string }> {
  const pathExportDetail = path.join(entryPath, '.next', 'export-detail.json');
  const hasExportDetail: boolean = await fs
    .access(pathExportDetail, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);

  if (!hasExportDetail) {
    return false;
  }

  const manifest: {
    version: 1;
    success: boolean;
    outDirectory: string;
  } = JSON.parse(await fs.readFile(pathExportDetail, 'utf8'));

  switch (manifest.version) {
    case 1: {
      return {
        success: !!manifest.success,
        outDirectory: manifest.outDirectory,
      };
    }

    default: {
      return false;
    }
  }
}

export async function getRequiredServerFilesManifest(
  entryPath: string,
  outputDirectory: string
): Promise<NextRequiredServerFilesManifest | false> {
  const pathRequiredServerFilesManifest = path.join(
    entryPath,
    outputDirectory,
    'required-server-files.json'
  );

  const hasManifest: boolean = await fs
    .access(pathRequiredServerFilesManifest, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);

  if (!hasManifest) {
    return false;
  }

  const manifestData = JSON.parse(
    await fs.readFile(pathRequiredServerFilesManifest, 'utf8')
  );

  const requiredServerFiles = {
    files: [],
    ignore: [],
    config: {},
    appDir: manifestData.appDir,
  };

  switch (manifestData.version) {
    case 1: {
      requiredServerFiles.files = manifestData.files;
      requiredServerFiles.ignore = manifestData.ignore;
      requiredServerFiles.config = manifestData.config;
      requiredServerFiles.appDir = manifestData.appDir;
      break;
    }
    default: {
      throw new Error(
        `Invalid required-server-files manifest version ${manifestData.version}, please contact support if this error persists`
      );
    }
  }
  return requiredServerFiles;
}

export async function getPrerenderManifest(
  entryPath: string,
  outputDirectory: string
): Promise<NextPrerenderedRoutes> {
  const pathPrerenderManifest = path.join(
    entryPath,
    outputDirectory,
    'prerender-manifest.json'
  );

  const hasManifest: boolean = await fs
    .access(pathPrerenderManifest, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);

  if (!hasManifest) {
    return {
      staticRoutes: {},
      blockingFallbackRoutes: {},
      fallbackRoutes: {},
      bypassToken: null,
      omittedRoutes: {},
      notFoundRoutes: [],
      isLocalePrefixed: false,
    };
  }

  const manifest:
    | {
        version: 1;
        routes: {
          [key: string]: {
            initialRevalidateSeconds: number | false;
            dataRoute: string;
            srcRoute: string | null;
          };
        };
        dynamicRoutes: {
          [key: string]: {
            fallback?: string;
            routeRegex: string;
            dataRoute: string;
            dataRouteRegex: string;
          };
        };
        preview?: {
          previewModeId: string;
        };
      }
    | {
        version: 2 | 3;
        routes: {
          [route: string]: {
            initialRevalidateSeconds: number | false;
            srcRoute: string | null;
            dataRoute: string;
          };
        };
        dynamicRoutes: {
          [route: string]: {
            routeRegex: string;
            fallback: string | false;
            dataRoute: string;
            dataRouteRegex: string;
          };
        };
        preview: {
          previewModeId: string;
        };
        notFoundRoutes?: string[];
      } = JSON.parse(await fs.readFile(pathPrerenderManifest, 'utf8'));

  switch (manifest.version) {
    case 1: {
      const routes = Object.keys(manifest.routes);
      const lazyRoutes = Object.keys(manifest.dynamicRoutes);

      const ret: NextPrerenderedRoutes = {
        staticRoutes: {},
        blockingFallbackRoutes: {},
        fallbackRoutes: {},
        bypassToken:
          (manifest.preview && manifest.preview.previewModeId) || null,
        omittedRoutes: {},
        notFoundRoutes: [],
        isLocalePrefixed: false,
      };

      routes.forEach(route => {
        const { initialRevalidateSeconds, dataRoute, srcRoute } =
          manifest.routes[route];
        ret.staticRoutes[route] = {
          initialRevalidate:
            initialRevalidateSeconds === false
              ? false
              : Math.max(1, initialRevalidateSeconds),
          dataRoute,
          srcRoute,
        };
      });

      lazyRoutes.forEach(lazyRoute => {
        const { routeRegex, fallback, dataRoute, dataRouteRegex } =
          manifest.dynamicRoutes[lazyRoute];

        if (fallback) {
          ret.fallbackRoutes[lazyRoute] = {
            routeRegex,
            fallback,
            dataRoute,
            dataRouteRegex,
          };
        } else {
          ret.blockingFallbackRoutes[lazyRoute] = {
            routeRegex,
            dataRoute,
            dataRouteRegex,
          };
        }
      });

      return ret;
    }
    case 2:
    case 3: {
      const routes = Object.keys(manifest.routes);
      const lazyRoutes = Object.keys(manifest.dynamicRoutes);

      const ret: NextPrerenderedRoutes = {
        staticRoutes: {},
        blockingFallbackRoutes: {},
        fallbackRoutes: {},
        bypassToken: manifest.preview.previewModeId,
        omittedRoutes: {},
        notFoundRoutes: [],
        isLocalePrefixed: manifest.version > 2,
      };

      if (manifest.notFoundRoutes) {
        ret.notFoundRoutes.push(...manifest.notFoundRoutes);
      }

      routes.forEach(route => {
        const { initialRevalidateSeconds, dataRoute, srcRoute } =
          manifest.routes[route];
        ret.staticRoutes[route] = {
          initialRevalidate:
            initialRevalidateSeconds === false
              ? false
              : Math.max(1, initialRevalidateSeconds),
          dataRoute,
          srcRoute,
        };
      });

      lazyRoutes.forEach(lazyRoute => {
        const { routeRegex, fallback, dataRoute, dataRouteRegex } =
          manifest.dynamicRoutes[lazyRoute];

        if (typeof fallback === 'string') {
          ret.fallbackRoutes[lazyRoute] = {
            routeRegex,
            fallback,
            dataRoute,
            dataRouteRegex,
          };
        } else if (fallback === null) {
          ret.blockingFallbackRoutes[lazyRoute] = {
            routeRegex,
            dataRoute,
            dataRouteRegex,
          };
        } else {
          // Fallback behavior is disabled, all routes would've been provided
          // in the top-level `routes` key (`staticRoutes`).
          ret.omittedRoutes[lazyRoute] = {
            routeRegex,
            dataRoute,
            dataRouteRegex,
          };
        }
      });

      return ret;
    }
    default: {
      return {
        staticRoutes: {},
        blockingFallbackRoutes: {},
        fallbackRoutes: {},
        bypassToken: null,
        omittedRoutes: {},
        notFoundRoutes: [],
        isLocalePrefixed: false,
      };
    }
  }
}

// We only need this once per build
let _usesSrcCache: boolean | undefined;

async function usesSrcDirectory(workPath: string): Promise<boolean> {
  if (!_usesSrcCache) {
    const source = path.join(workPath, 'src', 'pages');

    try {
      if ((await fs.stat(source)).isDirectory()) {
        _usesSrcCache = true;
      }
    } catch (_err) {
      _usesSrcCache = false;
    }
  }

  return Boolean(_usesSrcCache);
}

async function getSourceFilePathFromPage({
  workPath,
  page,
  pageExtensions,
}: {
  workPath: string;
  page: string;
  pageExtensions?: string[];
}) {
  // TODO: this should be updated to get the pageExtensions
  // value used during next build
  const extensionsToTry = pageExtensions || ['js', 'jsx', 'ts', 'tsx'];

  let fsPath = path.join(workPath, 'pages', page);
  if (await usesSrcDirectory(workPath)) {
    fsPath = path.join(workPath, 'src', 'pages', page);
  }

  if (fs.existsSync(fsPath)) {
    return path.relative(workPath, fsPath);
  }
  const extensionless = fsPath.slice(0, -3); // remove ".js"

  for (const ext of extensionsToTry) {
    fsPath = `${extensionless}.${ext}`;
    if (fs.existsSync(fsPath)) {
      return path.relative(workPath, fsPath);
    }
  }

  if (isDirectory(extensionless)) {
    for (const ext of extensionsToTry) {
      fsPath = path.join(extensionless, `index.${ext}`);
      if (fs.existsSync(fsPath)) {
        return path.relative(workPath, fsPath);
      }
    }
  }

  console.log(
    `WARNING: Unable to find source file for page ${page} with extensions: ${extensionsToTry.join(
      ', '
    )}, this can cause functions config from \`vercel.json\` to not be applied`
  );
  return '';
}

function isDirectory(path: string) {
  return fs.existsSync(path) && fs.lstatSync(path).isDirectory();
}

export function normalizeLocalePath(
  pathname: string,
  locales?: string[]
): {
  detectedLocale?: string;
  pathname: string;
} {
  let detectedLocale: string | undefined;
  // first item will be empty string from splitting at first char
  const pathnameParts = pathname.split('/');

  (locales || []).some(locale => {
    if (pathnameParts[1].toLowerCase() === locale.toLowerCase()) {
      detectedLocale = locale;
      pathnameParts.splice(1, 1);
      pathname = pathnameParts.join('/') || '/';
      return true;
    }
    return false;
  });

  return {
    pathname,
    detectedLocale,
  };
}

export function addLocaleOrDefault(
  pathname: string,
  routesManifest?: RoutesManifest,
  locale?: string
) {
  if (!routesManifest?.i18n) return pathname;
  if (!locale) locale = routesManifest.i18n.defaultLocale;

  return locale
    ? `/${locale}${pathname === '/index' ? '' : pathname}`
    : pathname;
}

export type LambdaGroup = {
  pages: string[];
  memory?: number;
  maxDuration?: number;
  isPrerenders?: boolean;
  pseudoLayer: PseudoLayer;
  pseudoLayerBytes: number;
  pseudoLayerUncompressedBytes: number;
};

export const MAX_UNCOMPRESSED_LAMBDA_SIZE = 250 * 1000 * 1000; // 250MB
const LAMBDA_RESERVED_UNCOMPRESSED_SIZE = 2.5 * 1000 * 1000; // 2.5MB
const LAMBDA_RESERVED_COMPRESSED_SIZE = 250 * 1000; // 250KB

export async function getPageLambdaGroups(
  entryPath: string,
  config: Config,
  pages: string[],
  prerenderRoutes: Set<string>,
  pageTraces: {
    [page: string]: {
      [key: string]: FileFsRef;
    };
  },
  compressedPages: {
    [page: string]: PseudoFile;
  },
  tracedPseudoLayer: PseudoLayer,
  initialPseudoLayerSize: number,
  initialPseudoLayerUncompressedSize: number,
  lambdaCompressedByteLimit: number,
  internalPages: string[],
  pageExtensions?: string[]
) {
  const groups: Array<LambdaGroup> = [];

  for (const page of pages) {
    const newPages = [...internalPages, page];
    const routeName = normalizePage(page.replace(/\.js$/, ''));
    const isPrerenderRoute = prerenderRoutes.has(routeName);

    let opts: { memory?: number; maxDuration?: number } = {};

    if (config && config.functions) {
      const sourceFile = await getSourceFilePathFromPage({
        workPath: entryPath,
        page,
        pageExtensions,
      });
      opts = await getLambdaOptionsFromFunction({
        sourceFile,
        config,
      });
    }

    let matchingGroup = groups.find(group => {
      const matches =
        group.maxDuration === opts.maxDuration &&
        group.memory === opts.memory &&
        group.isPrerenders === isPrerenderRoute;

      if (matches) {
        let newTracedFilesSize = group.pseudoLayerBytes;
        let newTracedFilesUncompressedSize = group.pseudoLayerUncompressedBytes;

        for (const newPage of newPages) {
          Object.keys(pageTraces[newPage] || {}).map(file => {
            if (!group.pseudoLayer[file]) {
              const item = tracedPseudoLayer[file] as PseudoFile;

              newTracedFilesSize += item.compBuffer?.byteLength || 0;
              newTracedFilesUncompressedSize += item.uncompressedSize || 0;
            }
          });
          newTracedFilesSize += compressedPages[newPage].compBuffer.byteLength;
          newTracedFilesUncompressedSize +=
            compressedPages[newPage].uncompressedSize;
        }

        const underUncompressedLimit =
          newTracedFilesUncompressedSize + initialPseudoLayerUncompressedSize <
          MAX_UNCOMPRESSED_LAMBDA_SIZE - LAMBDA_RESERVED_UNCOMPRESSED_SIZE;
        const underCompressedLimit =
          newTracedFilesSize + initialPseudoLayerSize <
          lambdaCompressedByteLimit - LAMBDA_RESERVED_COMPRESSED_SIZE;

        return underUncompressedLimit && underCompressedLimit;
      }
      return false;
    });

    if (matchingGroup) {
      matchingGroup.pages.push(page);
    } else {
      const newGroup: LambdaGroup = {
        pages: [page],
        ...opts,
        isPrerenders: isPrerenderRoute,
        pseudoLayerBytes: 0,
        pseudoLayerUncompressedBytes: 0,
        pseudoLayer: {},
      };
      groups.push(newGroup);
      matchingGroup = newGroup;
    }

    for (const newPage of newPages) {
      Object.keys(pageTraces[newPage] || {}).map(file => {
        const pseudoItem = tracedPseudoLayer[file] as PseudoFile;
        const compressedSize = pseudoItem?.compBuffer?.byteLength || 0;

        if (!matchingGroup!.pseudoLayer[file]) {
          matchingGroup!.pseudoLayer[file] = pseudoItem;
          matchingGroup!.pseudoLayerBytes += compressedSize;
          matchingGroup!.pseudoLayerUncompressedBytes +=
            pseudoItem.uncompressedSize || 0;
        }
      });

      // ensure the page file itself is accounted for when grouping as
      // large pages can be created that can push the group over the limit
      matchingGroup!.pseudoLayerBytes +=
        compressedPages[newPage].compBuffer.byteLength;
      matchingGroup!.pseudoLayerUncompressedBytes +=
        compressedPages[newPage].uncompressedSize;
    }
  }

  return groups;
}

export const outputFunctionFileSizeInfo = (
  pages: string[],
  pseudoLayer: PseudoLayer,
  pseudoLayerBytes: number,
  pseudoLayerUncompressedBytes: number,
  compressedPages: {
    [page: string]: PseudoFile;
  }
) => {
  const exceededLimitOutput: Array<string[]> = [];

  console.log(
    `Serverless Function's page${pages.length === 1 ? '' : 's'}: ${pages.join(
      ', '
    )}`
  );
  exceededLimitOutput.push([
    'Large Dependencies',
    'Uncompressed size',
    'Compressed size',
  ]);

  const dependencies: {
    [key: string]: {
      compressed: number;
      uncompressed: number;
    };
  } = {};

  for (const fileKey of Object.keys(pseudoLayer)) {
    if (!pseudoLayer[fileKey].isSymlink) {
      const fileItem = pseudoLayer[fileKey] as PseudoFile;
      const depKey = fileKey.split('/').slice(0, 3).join('/');

      if (!dependencies[depKey]) {
        dependencies[depKey] = {
          compressed: 0,
          uncompressed: 0,
        };
      }

      dependencies[depKey].compressed += fileItem.compBuffer.byteLength;
      dependencies[depKey].uncompressed += fileItem.uncompressedSize;
    }
  }

  for (const page of pages) {
    dependencies[`pages/${page}`] = {
      compressed: compressedPages[page].compBuffer.byteLength,
      uncompressed: compressedPages[page].uncompressedSize,
    };
  }
  let numLargeDependencies = 0;

  Object.keys(dependencies)
    .sort((a, b) => {
      // move largest dependencies to the top
      const aDep = dependencies[a];
      const bDep = dependencies[b];

      if (aDep.compressed > bDep.compressed) {
        return -1;
      }
      if (aDep.compressed < bDep.compressed) {
        return 1;
      }
      return 0;
    })
    .forEach(depKey => {
      const dep = dependencies[depKey];

      if (dep.compressed < 100 * 1000 && dep.uncompressed < 500 * 1000) {
        // ignore smaller dependencies to reduce noise
        return;
      }
      exceededLimitOutput.push([
        depKey,
        prettyBytes(dep.uncompressed),
        prettyBytes(dep.compressed),
      ]);
      numLargeDependencies += 1;
    });

  if (numLargeDependencies === 0) {
    exceededLimitOutput.push([
      'No large dependencies found (> 100KB compressed)',
    ]);
  }

  exceededLimitOutput.push([]);
  exceededLimitOutput.push([
    'All dependencies',
    prettyBytes(pseudoLayerUncompressedBytes),
    prettyBytes(pseudoLayerBytes),
  ]);

  console.log(
    textTable(exceededLimitOutput, {
      align: ['l', 'r', 'r'],
    })
  );
};

export const detectLambdaLimitExceeding = async (
  lambdaGroups: LambdaGroup[],
  compressedSizeLimit: number,
  compressedPages: {
    [page: string]: PseudoFile;
  }
) => {
  // show debug info if within 5 MB of exceeding the limit
  const COMPRESSED_SIZE_LIMIT_CLOSE = compressedSizeLimit - 5 * 1000 * 1000;
  const UNCOMPRESSED_SIZE_LIMIT_CLOSE =
    MAX_UNCOMPRESSED_LAMBDA_SIZE - 5 * 1000 * 1000;

  let numExceededLimit = 0;
  let numCloseToLimit = 0;
  let loggedHeadInfo = false;

  // pre-iterate to see if we are going to exceed the limit
  // or only get close so our first log line can be correct
  const filteredGroups = lambdaGroups.filter(group => {
    const exceededLimit =
      group.pseudoLayerBytes > compressedSizeLimit ||
      group.pseudoLayerUncompressedBytes > MAX_UNCOMPRESSED_LAMBDA_SIZE;

    const closeToLimit =
      group.pseudoLayerBytes > COMPRESSED_SIZE_LIMIT_CLOSE ||
      group.pseudoLayerUncompressedBytes > UNCOMPRESSED_SIZE_LIMIT_CLOSE;

    if (
      closeToLimit ||
      exceededLimit ||
      getPlatformEnv('BUILDER_DEBUG') ||
      process.env.NEXT_DEBUG_FUNCTION_SIZE
    ) {
      if (exceededLimit) {
        numExceededLimit += 1;
      }
      if (closeToLimit) {
        numCloseToLimit += 1;
      }
      return true;
    }
  });

  for (const group of filteredGroups) {
    if (!loggedHeadInfo) {
      if (numExceededLimit || numCloseToLimit) {
        console.log(
          `Warning: Max serverless function size of ${prettyBytes(
            compressedSizeLimit
          )} compressed or ${prettyBytes(
            MAX_UNCOMPRESSED_LAMBDA_SIZE
          )} uncompressed${numExceededLimit ? '' : ' almost'} reached`
        );
      } else {
        console.log(`Serverless function size info`);
      }
      loggedHeadInfo = true;
    }

    outputFunctionFileSizeInfo(
      group.pages,
      group.pseudoLayer,
      group.pseudoLayerBytes,
      group.pseudoLayerUncompressedBytes,
      compressedPages
    );
  }

  if (numExceededLimit) {
    console.log(
      `Max serverless function size was exceeded for ${numExceededLimit} function${
        numExceededLimit === 1 ? '' : 's'
      }`
    );
  }
};

// checks if prerender files are all static or not before creating lambdas
export const onPrerenderRouteInitial = (
  prerenderManifest: NextPrerenderedRoutes,
  canUsePreviewMode: boolean,
  entryDirectory: string,
  nonLambdaSsgPages: Set<string>,
  routeKey: string,
  hasPages404: boolean,
  routesManifest?: RoutesManifest
) => {
  let static404Page: string | undefined;
  let static500Page: string | undefined;

  // Get the route file as it'd be mounted in the builder output
  const pr = prerenderManifest.staticRoutes[routeKey];
  const { initialRevalidate, srcRoute } = pr;
  const route = srcRoute || routeKey;

  const routeNoLocale = routesManifest?.i18n
    ? normalizeLocalePath(routeKey, routesManifest.i18n.locales).pathname
    : routeKey;

  // if the 404 page used getStaticProps we need to update static404Page
  // since it wasn't populated from the staticPages group
  if (routeNoLocale === '/404') {
    static404Page = path.join(entryDirectory, routeKey);
  }

  if (routeNoLocale === '/500') {
    static500Page = path.join(entryDirectory, routeKey);
  }

  if (
    initialRevalidate === false &&
    (!canUsePreviewMode || (hasPages404 && routeNoLocale === '/404')) &&
    !prerenderManifest.fallbackRoutes[route] &&
    !prerenderManifest.blockingFallbackRoutes[route]
  ) {
    if (
      routesManifest?.i18n &&
      Object.keys(prerenderManifest.staticRoutes).some(route => {
        const staticRoute = prerenderManifest.staticRoutes[route];

        return (
          staticRoute.srcRoute === srcRoute &&
          staticRoute.initialRevalidate !== false
        );
      })
    ) {
      // if any locale static routes are using revalidate the page
      // requires a lambda
      return {
        static404Page,
        static500Page,
      };
    }

    nonLambdaSsgPages.add(route === '/' ? '/index' : route);
  }

  return {
    static404Page,
    static500Page,
  };
};

type OnPrerenderRouteArgs = {
  pagesDir: string;
  static404Page?: string;
  hasPages404: boolean;
  entryDirectory: string;
  prerenderManifest: NextPrerenderedRoutes;
  isSharedLambdas: boolean;
  isServerMode: boolean;
  canUsePreviewMode: boolean;
  lambdas: { [key: string]: Lambda };
  prerenders: { [key: string]: Prerender | FileFsRef };
  pageLambdaMap: { [key: string]: string };
  routesManifest?: RoutesManifest;
  isCorrectNotFoundRoutes?: boolean;
};
let prerenderGroup = 1;

export const onPrerenderRoute =
  (prerenderRouteArgs: OnPrerenderRouteArgs) =>
  (
    routeKey: string,
    {
      isBlocking,
      isFallback,
      isOmitted,
      locale,
    }: {
      isBlocking?: boolean;
      isFallback?: boolean;
      isOmitted?: boolean;
      locale?: string;
    }
  ) => {
    const {
      pagesDir,
      hasPages404,
      static404Page,
      entryDirectory,
      prerenderManifest,
      isSharedLambdas,
      isServerMode,
      canUsePreviewMode,
      lambdas,
      prerenders,
      pageLambdaMap,
      routesManifest,
      isCorrectNotFoundRoutes,
    } = prerenderRouteArgs;

    if (isBlocking && isFallback) {
      throw new NowBuildError({
        code: 'NEXT_ISBLOCKING_ISFALLBACK',
        message: 'invariant: isBlocking and isFallback cannot both be true',
      });
    }

    if (isFallback && isOmitted) {
      throw new NowBuildError({
        code: 'NEXT_ISOMITTED_ISFALLBACK',
        message: 'invariant: isOmitted and isFallback cannot both be true',
      });
    }

    // Get the route file as it'd be mounted in the builder output
    let routeFileNoExt = routeKey === '/' ? '/index' : routeKey;
    let origRouteFileNoExt = routeFileNoExt;
    const { isLocalePrefixed } = prerenderManifest;

    if (!locale && isLocalePrefixed) {
      const localePathResult = normalizeLocalePath(
        routeKey,
        routesManifest?.i18n?.locales || []
      );

      locale = localePathResult.detectedLocale;
      origRouteFileNoExt =
        localePathResult.pathname === '/'
          ? '/index'
          : localePathResult.pathname;
    }

    const nonDynamicSsg =
      !isFallback &&
      !isBlocking &&
      !isOmitted &&
      !prerenderManifest.staticRoutes[routeKey].srcRoute;

    // if there isn't a srcRoute then it's a non-dynamic SSG page
    if ((nonDynamicSsg && !isLocalePrefixed) || isFallback || isOmitted) {
      routeFileNoExt = addLocaleOrDefault(
        // root index files are located without folder/index.html
        routeFileNoExt,
        routesManifest,
        locale
      );
    }

    const isNotFound = prerenderManifest.notFoundRoutes.includes(routeKey);

    const htmlFsRef =
      isBlocking || (isNotFound && !static404Page)
        ? // Blocking pages do not have an HTML fallback
          null
        : new FileFsRef({
            fsPath: path.join(
              pagesDir,
              isFallback
                ? // Fallback pages have a special file.
                  addLocaleOrDefault(
                    prerenderManifest.fallbackRoutes[routeKey].fallback,
                    routesManifest,
                    locale
                  )
                : // Otherwise, the route itself should exist as a static HTML
                  // file.
                  `${
                    isOmitted || isNotFound
                      ? addLocaleOrDefault('/404', routesManifest, locale)
                      : routeFileNoExt
                  }.html`
            ),
          });
    const jsonFsRef =
      // JSON data does not exist for fallback or blocking pages
      isFallback || isBlocking || (isNotFound && !static404Page)
        ? null
        : new FileFsRef({
            fsPath: path.join(
              pagesDir,
              `${
                isOmitted || isNotFound
                  ? addLocaleOrDefault('/404.html', routesManifest, locale)
                  : routeFileNoExt + '.json'
              }`
            ),
          });

    let initialRevalidate: false | number;
    let srcRoute: string | null;
    let dataRoute: string;

    if (isFallback || isBlocking) {
      const pr = isFallback
        ? prerenderManifest.fallbackRoutes[routeKey]
        : prerenderManifest.blockingFallbackRoutes[routeKey];
      initialRevalidate = 1; // TODO: should Next.js provide this default?
      // @ts-ignore
      if (initialRevalidate === false) {
        // Lazy routes cannot be "snapshotted" in time.
        throw new NowBuildError({
          code: 'NEXT_ISLAZY_INITIALREVALIDATE',
          message: 'invariant isLazy: initialRevalidate !== false',
        });
      }
      srcRoute = null;
      dataRoute = pr.dataRoute;
    } else if (isOmitted) {
      initialRevalidate = false;
      srcRoute = routeKey;
      dataRoute = prerenderManifest.omittedRoutes[routeKey].dataRoute;
    } else {
      const pr = prerenderManifest.staticRoutes[routeKey];
      ({ initialRevalidate, srcRoute, dataRoute } = pr);
    }

    const outputPathPage = normalizeIndexOutput(
      path.posix.join(entryDirectory, routeFileNoExt),
      isServerMode
    );
    const outputPathPageOrig = path.posix.join(
      entryDirectory,
      origRouteFileNoExt
    );
    let lambda: undefined | Lambda;
    let outputPathData = path.posix.join(entryDirectory, dataRoute);

    if (nonDynamicSsg || isFallback || isOmitted) {
      outputPathData = outputPathData.replace(
        new RegExp(`${escapeStringRegexp(origRouteFileNoExt)}.json$`),
        `${routeFileNoExt}.json`
      );
    }

    if (isSharedLambdas) {
      const outputSrcPathPage = normalizeIndexOutput(
        path.join(
          '/',
          srcRoute == null
            ? outputPathPageOrig
            : path.join(entryDirectory, srcRoute === '/' ? '/index' : srcRoute)
        ),
        isServerMode
      );

      const lambdaId = pageLambdaMap[outputSrcPathPage];
      lambda = lambdas[lambdaId];
    } else {
      const outputSrcPathPage = normalizeIndexOutput(
        srcRoute == null
          ? outputPathPageOrig
          : path.posix.join(
              entryDirectory,
              srcRoute === '/' ? '/index' : srcRoute
            ),
        isServerMode
      );

      lambda = lambdas[outputSrcPathPage];
    }

    if (!isNotFound && initialRevalidate === false) {
      if (htmlFsRef == null || jsonFsRef == null) {
        throw new NowBuildError({
          code: 'NEXT_HTMLFSREF_JSONFSREF',
          message: 'invariant: htmlFsRef != null && jsonFsRef != null',
        });
      }

      // If revalidate isn't enabled we force the /404 route to be static
      // to match next start behavior otherwise getStaticProps would be
      // recalled for each 404 URL path since Prerender is cached based
      // on the URL path
      if (!canUsePreviewMode || (hasPages404 && routeKey === '/404')) {
        htmlFsRef.contentType = htmlContentType;
        prerenders[outputPathPage] = htmlFsRef;
        prerenders[outputPathData] = jsonFsRef;
      }
    }
    const isNotFoundPreview =
      isCorrectNotFoundRoutes &&
      !initialRevalidate &&
      canUsePreviewMode &&
      isServerMode &&
      isNotFound;

    if (
      prerenders[outputPathPage] == null &&
      (!isNotFound || initialRevalidate || isNotFoundPreview)
    ) {
      if (lambda == null) {
        throw new NowBuildError({
          code: 'NEXT_MISSING_LAMBDA',
          message: `Unable to find lambda for route: ${routeFileNoExt}`,
        });
      }

      // `allowQuery` is an array of query parameter keys that are allowed for
      // a given path. All other query keys will be striped. We can automatically
      // detect this for prerender (ISR) pages by reading the routes manifest file.
      const pageKey = srcRoute || routeKey;
      const isDynamic = isDynamicRoute(pageKey);
      const route = routesManifest?.dynamicRoutes.find(
        (r): r is RoutesManifestRoute =>
          r.page === pageKey && !('isMiddleware' in r)
      ) as RoutesManifestRoute | undefined;
      const routeKeys = route?.routeKeys;
      // by default allowQuery should be undefined and only set when
      // we have sufficient information to set it
      let allowQuery: string[] | undefined;

      if (routeKeys) {
        // if we have routeKeys in the routes-manifest we use those
        // for allowQuery for dynamic routes
        allowQuery = Object.values(routeKeys);
      } else if (!isDynamic) {
        // for non-dynamic routes we use an empty array since
        // no query values bust the cache for non-dynamic prerenders
        allowQuery = [];
      }

      prerenders[outputPathPage] = new Prerender({
        expiration: initialRevalidate,
        lambda,
        allowQuery,
        fallback: htmlFsRef,
        group: prerenderGroup,
        bypassToken: prerenderManifest.bypassToken,
      });
      prerenders[outputPathData] = new Prerender({
        expiration: initialRevalidate,
        lambda,
        allowQuery,
        fallback: jsonFsRef,
        group: prerenderGroup,
        bypassToken: prerenderManifest.bypassToken,
      });

      ++prerenderGroup;

      if (routesManifest?.i18n && isBlocking) {
        for (const locale of routesManifest.i18n.locales) {
          const localeRouteFileNoExt = addLocaleOrDefault(
            routeFileNoExt,
            routesManifest,
            locale
          );
          const localeOutputPathPage = normalizeIndexOutput(
            path.posix.join(entryDirectory, localeRouteFileNoExt),
            isServerMode
          );
          const localeOutputPathData = outputPathData.replace(
            new RegExp(`${escapeStringRegexp(origRouteFileNoExt)}.json$`),
            `${localeRouteFileNoExt}${
              localeRouteFileNoExt !== origRouteFileNoExt &&
              origRouteFileNoExt === '/index'
                ? '/index'
                : ''
            }.json`
          );

          const origPrerenderPage = prerenders[outputPathPage];
          const origPrerenderData = prerenders[outputPathData];

          prerenders[localeOutputPathPage] = {
            ...origPrerenderPage,
            group: prerenderGroup,
          } as Prerender;

          prerenders[localeOutputPathData] = {
            ...origPrerenderData,
            group: prerenderGroup,
          } as Prerender;

          ++prerenderGroup;
        }
      }
    }

    if (
      ((nonDynamicSsg && !isLocalePrefixed) || isFallback || isOmitted) &&
      routesManifest?.i18n &&
      !locale
    ) {
      // load each locale
      for (const locale of routesManifest.i18n.locales) {
        if (locale === routesManifest.i18n.defaultLocale) continue;
        onPrerenderRoute(prerenderRouteArgs)(routeKey, {
          isBlocking,
          isFallback,
          isOmitted,
          locale,
        });
      }
    }
  };

type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

export async function getStaticFiles(
  entryPath: string,
  entryDirectory: string,
  outputDirectory: string
) {
  const collectLabel =
    'Collected static files (public/, static/, .next/static)';
  console.time(collectLabel);

  const nextStaticFiles = await glob(
    '**',
    path.join(entryPath, outputDirectory, 'static')
  );
  const staticFolderFiles = await glob('**', path.join(entryPath, 'static'));

  let publicFolderFiles: UnwrapPromise<ReturnType<typeof glob>> = {};
  let publicFolderPath: string | undefined;

  if (await fs.pathExists(path.join(entryPath, 'public'))) {
    publicFolderPath = path.join(entryPath, 'public');
  } else if (
    // check at the same level as the output directory also
    await fs.pathExists(path.join(entryPath, outputDirectory, '../public'))
  ) {
    publicFolderPath = path.join(entryPath, outputDirectory, '../public');
  }

  if (publicFolderPath) {
    debug(`Using public folder at ${publicFolderPath}`);
    publicFolderFiles = await glob('**/*', publicFolderPath);
  } else {
    debug('No public folder found');
  }
  const staticFiles: Record<string, FileFsRef> = {};
  const staticDirectoryFiles: Record<string, FileFsRef> = {};
  const publicDirectoryFiles: Record<string, FileFsRef> = {};

  for (const file of Object.keys(nextStaticFiles)) {
    staticFiles[path.join(entryDirectory, `_next/static/${file}`)] =
      nextStaticFiles[file];
  }

  for (const file of Object.keys(staticFolderFiles)) {
    staticDirectoryFiles[path.join(entryDirectory, 'static', file)] =
      staticFolderFiles[file];
  }

  for (const file of Object.keys(publicFolderFiles)) {
    publicDirectoryFiles[path.join(entryDirectory, file)] =
      publicFolderFiles[file];
  }

  console.timeEnd(collectLabel);
  return {
    staticFiles,
    staticDirectoryFiles,
    publicDirectoryFiles,
  };
}

export function normalizeIndexOutput(
  outputName: string,
  isServerMode: boolean
) {
  if (outputName !== '/index' && isServerMode) {
    return outputName.replace(/\/index$/, '');
  }
  return outputName;
}

/**
 * The path to next-server was changed in
 * https://github.com/vercel/next.js/pull/26756
 */
export function getNextServerPath(nextVersion: string) {
  return semver.gte(nextVersion, 'v11.0.2-canary.4')
    ? 'next/dist/server'
    : 'next/dist/next-server/server';
}

// update to leverage
export function updateRouteSrc(
  route: Route,
  index: number,
  manifestItems: Array<{ regex: string }>
) {
  if (route.src) {
    route.src = manifestItems[index].regex;
  }
  return route;
}

export async function getPrivateOutputs(
  dir: string,
  entries: Record<string, string>
) {
  const files: Files = {};
  const routes: Route[] = [];

  for (const [existingFile, outputFile] of Object.entries(entries)) {
    const fsPath = path.join(dir, existingFile);

    try {
      const { mode, size } = await stat(fsPath);
      if (size > 30 * 1024 * 1024) {
        throw new Error(`Exceeds maximum file size: ${size}`);
      }
      files[outputFile] = new FileFsRef({ mode, fsPath });
      routes.push({
        src: `/${outputFile}`,
        dest: '/404',
        status: 404,
        continue: true,
      });
    } catch (error) {
      debug(
        `Private file ${existingFile} had an error and will not be uploaded: ${error}`
      );
    }
  }

  return { files, routes };
}

export {
  excludeFiles,
  validateEntrypoint,
  normalizePackageJson,
  getNextConfig,
  stringMap,
  normalizePage,
  isDynamicRoute,
  getSourceFilePathFromPage,
};

interface MiddlewareManifest {
  version: 1;
  sortedMiddleware: string[];
  middleware: {
    [page: string]: MiddlewareInfo;
  };
}

interface MiddlewareInfo {
  env: string[];
  files: string[];
  name: string;
  page: string;
  regexp: string;
  wasm?: { filePath: string; name: string }[];
}

export async function getMiddlewareBundle({
  entryPath,
  outputDirectory,
  routesManifest,
  isCorrectMiddlewareOrder,
}: {
  entryPath: string;
  outputDirectory: string;
  routesManifest: RoutesManifest;
  isCorrectMiddlewareOrder: boolean;
}) {
  const middlewareManifest = await getMiddlewareManifest(
    entryPath,
    outputDirectory
  );

  if (middlewareManifest && middlewareManifest?.sortedMiddleware.length > 0) {
    const workerConfigs = await Promise.all(
      middlewareManifest.sortedMiddleware.map(async key => {
        const middleware = middlewareManifest.middleware[key];
        try {
          const wrappedModuleSource = await getNextjsEdgeFunctionSource(
            middleware.files,
            {
              name: middleware.name,
              staticRoutes: routesManifest.staticRoutes,
              dynamicRoutes: routesManifest.dynamicRoutes.filter(
                r => !('isMiddleware' in r)
              ),
              nextConfig: {
                basePath: routesManifest.basePath,
                i18n: routesManifest.i18n,
              },
            },
            path.resolve(entryPath, outputDirectory),
            middleware.wasm
          );

          return {
            page: middlewareManifest.middleware[key].page,
            edgeFunction: (() => {
              const { source, map } = wrappedModuleSource.sourceAndMap();
              const transformedMap = stringifySourceMap(
                transformSourceMap(map)
              );

              const wasmFiles = (middleware.wasm ?? []).reduce(
                (acc: Files, { filePath, name }) => {
                  const fullFilePath = path.join(
                    entryPath,
                    outputDirectory,
                    filePath
                  );
                  acc[`wasm/${name}.wasm`] = new FileFsRef({
                    mode: 0o644,
                    contentType: 'application/wasm',
                    fsPath: fullFilePath,
                  });
                  return acc;
                },
                {}
              );

              return new EdgeFunction({
                deploymentTarget: 'v8-worker',
                name: middleware.name,
                files: {
                  'index.js': new FileBlob({
                    data: source,
                    contentType: 'application/javascript',
                    mode: 0o644,
                  }),
                  ...(transformedMap && {
                    'index.js.map': new FileBlob({
                      data: transformedMap,
                      contentType: 'application/json',
                      mode: 0o644,
                    }),
                  }),
                  ...wasmFiles,
                },
                entrypoint: 'index.js',
                envVarsInUse: middleware.env,
              });
            })(),
            routeSrc: getRouteSrc(
              middlewareManifest.middleware[key],
              routesManifest
            ),
          };
        } catch (e: any) {
          e.message = `Can't build edge function ${key}: ${e.message}`;
          throw e;
        }
      })
    );

    const source: {
      staticRoutes: Route[];
      dynamicRouteMap: Map<string, Source>;
      edgeFunctions: Record<string, EdgeFunction>;
    } = {
      staticRoutes: [],
      dynamicRouteMap: new Map(),
      edgeFunctions: {},
    };

    for (const worker of workerConfigs.values()) {
      const edgeFile = worker.edgeFunction.name;
      worker.edgeFunction.name = edgeFile.replace(/^pages\//, '');
      source.edgeFunctions[edgeFile] = worker.edgeFunction;
      const route: Source = {
        continue: true,
        middlewarePath: edgeFile,
        src: worker.routeSrc,
      };

      if (isCorrectMiddlewareOrder) {
        route.override = true;
      }

      if (routesManifest.version > 3 && isDynamicRoute(worker.page)) {
        source.dynamicRouteMap.set(worker.page, route);
      } else {
        source.staticRoutes.push(route);
      }
    }

    return source;
  }

  return {
    staticRoutes: [],
    dynamicRouteMap: new Map(),
    edgeFunctions: {},
  };
}

/**
 * Attempts to read the middleware manifest from the pre-defined
 * location. If the manifest can't be found it will resolve to
 * undefined.
 */
async function getMiddlewareManifest(
  entryPath: string,
  outputDirectory: string
): Promise<MiddlewareManifest | undefined> {
  const middlewareManifestPath = path.join(
    entryPath,
    outputDirectory,
    './server/middleware-manifest.json'
  );

  const hasManifest = await fs
    .access(middlewareManifestPath)
    .then(() => true)
    .catch(() => false);

  if (!hasManifest) {
    return;
  }

  return fs.readJSON(middlewareManifestPath);
}

/**
 * For an object containing middleware info and a routes manifest this will
 * generate a string with the route that will activate the middleware on
 * Vercel Proxy.
 *
 * @param param0 The middleware info including regexp and page.
 * @param param1 The routes manifest
 * @returns A regexp string for the middleware route.
 */
function getRouteSrc(
  { regexp, page }: MiddlewareInfo,
  { basePath = '', i18n }: RoutesManifest
): string {
  if (page === '/') {
    return regexp.replace(
      '_next',
      `${basePath?.substring(1) ? `${basePath?.substring(1)}/` : ''}_next`
    );
  }

  const locale = i18n?.locales.length
    ? `(?:/(${i18n.locales
        .map(locale => escapeStringRegexp(locale))
        .join('|')}))?`
    : '';

  return `(?:^${basePath}${locale}${regexp.substring(1)})`;
}

/**
 * Makes the sources more human-readable in the source map
 * by removing webpack-specific prefixes
 */
function transformSourceMap(
  sourcemap: RawSourceMap | null
): RawSourceMap | undefined {
  if (!sourcemap) return;
  const sources = sourcemap.sources
    ?.map(source => {
      return source.replace(/^webpack:\/\/?_N_E\/(?:\.\/)?/, '');
    })
    // Hide the Next.js entrypoint
    .map(source => {
      return source.startsWith('?') ? '[native code]' : source;
    });

  return { ...sourcemap, sources };
}
