import assert from 'assert';
import Sema from 'async-sema';
import { ZipFile } from 'yazl';
import minimatch from 'minimatch';
import { readlink } from 'fs-extra';
import { Files, Config } from './types';
import FileFsRef from './file-fs-ref';
import { isSymbolicLink } from './fs/download';
import streamToBuffer from './fs/stream-to-buffer';

interface Environment {
  [key: string]: string;
}

export type LambdaOptions = LambdaOptionsWithFiles | LambdaOptionsWithZipBuffer;

export interface LambdaOptionsBase {
  handler: string;
  runtime: string;
  memory?: number;
  maxDuration?: number;
  environment?: Environment;
  allowQuery?: string[];
  regions?: string[];
}

export interface LambdaOptionsWithFiles extends LambdaOptionsBase {
  files: Files;
}

/**
 * @deprecated Use `LambdaOptionsWithFiles` instead.
 */
export interface LambdaOptionsWithZipBuffer extends LambdaOptionsBase {
  /**
   * @deprecated Use `files` property instead.
   */
  zipBuffer: Buffer;
}

interface GetLambdaOptionsFromFunctionOptions {
  sourceFile: string;
  config?: Pick<Config, 'functions'>;
}

export class Lambda {
  type: 'Lambda';
  files?: Files;
  handler: string;
  runtime: string;
  memory?: number;
  maxDuration?: number;
  environment: Environment;
  allowQuery?: string[];
  regions?: string[];
  /**
   * @deprecated Use `await lambda.createZip()` instead.
   */
  zipBuffer?: Buffer;

  constructor(opts: LambdaOptions) {
    const {
      handler,
      runtime,
      maxDuration,
      memory,
      environment = {},
      allowQuery,
      regions,
    } = opts;
    if ('files' in opts) {
      assert(typeof opts.files === 'object', '"files" must be an object');
    }
    if ('zipBuffer' in opts) {
      assert(Buffer.isBuffer(opts.zipBuffer), '"zipBuffer" must be a Buffer');
    }
    assert(typeof handler === 'string', '"handler" is not a string');
    assert(typeof runtime === 'string', '"runtime" is not a string');
    assert(typeof environment === 'object', '"environment" is not an object');

    if (memory !== undefined) {
      assert(typeof memory === 'number', '"memory" is not a number');
    }

    if (maxDuration !== undefined) {
      assert(typeof maxDuration === 'number', '"maxDuration" is not a number');
    }

    if (allowQuery !== undefined) {
      assert(Array.isArray(allowQuery), '"allowQuery" is not an Array');
      assert(
        allowQuery.every(q => typeof q === 'string'),
        '"allowQuery" is not a string Array'
      );
    }

    if (regions !== undefined) {
      assert(Array.isArray(regions), '"regions" is not an Array');
      assert(
        regions.every(r => typeof r === 'string'),
        '"regions" is not a string Array'
      );
    }
    this.type = 'Lambda';
    this.files = 'files' in opts ? opts.files : undefined;
    this.handler = handler;
    this.runtime = runtime;
    this.memory = memory;
    this.maxDuration = maxDuration;
    this.environment = environment;
    this.allowQuery = allowQuery;
    this.regions = regions;
    this.zipBuffer = 'zipBuffer' in opts ? opts.zipBuffer : undefined;
  }

  async createZip(): Promise<Buffer> {
    let { zipBuffer } = this;
    if (!zipBuffer) {
      if (!this.files) {
        throw new Error('`files` is not defined');
      }
      await sema.acquire();
      try {
        zipBuffer = await createZip(this.files);
      } finally {
        sema.release();
      }
    }
    return zipBuffer;
  }
}

const sema = new Sema(10);
const mtime = new Date(1540000000000);

/**
 * @deprecated Use `new Lambda()` instead.
 */
export async function createLambda(opts: LambdaOptions): Promise<Lambda> {
  const lambda = new Lambda(opts);

  // backwards compat
  lambda.zipBuffer = await lambda.createZip();

  return lambda;
}

export async function createZip(files: Files): Promise<Buffer> {
  const names = Object.keys(files).sort();

  const symlinkTargets = new Map<string, string>();
  for (const name of names) {
    const file = files[name];
    if (file.mode && isSymbolicLink(file.mode) && file.type === 'FileFsRef') {
      const symlinkTarget = await readlink((file as FileFsRef).fsPath);
      symlinkTargets.set(name, symlinkTarget);
    }
  }

  const zipFile = new ZipFile();
  const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
    for (const name of names) {
      const file = files[name];
      const opts = { mode: file.mode, mtime };
      const symlinkTarget = symlinkTargets.get(name);
      if (typeof symlinkTarget === 'string') {
        zipFile.addBuffer(Buffer.from(symlinkTarget, 'utf8'), name, opts);
      } else {
        const stream = file.toStream() as import('stream').Readable;
        stream.on('error', reject);
        zipFile.addReadStream(stream, name, opts);
      }
    }

    zipFile.end();
    streamToBuffer(zipFile.outputStream).then(resolve).catch(reject);
  });

  return zipBuffer;
}

export async function getLambdaOptionsFromFunction({
  sourceFile,
  config,
}: GetLambdaOptionsFromFunctionOptions): Promise<
  Pick<LambdaOptions, 'memory' | 'maxDuration'>
> {
  if (config?.functions) {
    for (const [pattern, fn] of Object.entries(config.functions)) {
      if (sourceFile === pattern || minimatch(sourceFile, pattern)) {
        return {
          memory: fn.memory,
          maxDuration: fn.maxDuration,
        };
      }
    }
  }

  return {};
}
