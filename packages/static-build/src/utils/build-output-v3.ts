import { join } from 'path';
import { promises as fs } from 'fs';

const BUILD_OUTPUT_DIR = '.vercel/output';

/**
 * Returns the path to the Build Output v3 directory when the
 * `config.json` file was created by the framework / build script,
 * or `undefined` if the framework did not create the v3 output.
 */
export async function getBuildOutputDirectory(
  path: string
): Promise<string | undefined> {
  try {
    const outputDir = join(path, BUILD_OUTPUT_DIR);
    const configPath = join(outputDir, 'config.json');
    await fs.stat(configPath);
    return outputDir;
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  return undefined;
}
