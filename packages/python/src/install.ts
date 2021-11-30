import { relative, basename } from 'path';
import execa from 'execa';
import { Meta, debug } from '@vercel/build-utils';

const makeDependencyCheckCode = (dependency: string) => `
from importlib import util
dep = '${dependency}'.replace('-', '_')
spec = util.find_spec(dep)
print(spec.origin)
`;

async function isInstalled(
  pythonPath: string,
  dependency: string,
  cwd: string
) {
  try {
    const { stdout } = await execa(
      pythonPath,
      ['-c', makeDependencyCheckCode(dependency)],
      {
        stdio: 'pipe',
        cwd,
      }
    );
    return stdout.startsWith(cwd);
  } catch (err) {
    return false;
  }
}

const makeRequirementsCheckCode = (requirementsPath: string) => `
import distutils.text_file
import pkg_resources
from pkg_resources import DistributionNotFound, VersionConflict
dependencies = distutils.text_file.TextFile(filename='${requirementsPath}').readlines()
pkg_resources.require(dependencies)
`;

async function areRequirementsInstalled(
  pythonPath: string,
  requirementsPath: string,
  cwd: string
) {
  try {
    await execa(
      pythonPath,
      ['-c', makeRequirementsCheckCode(requirementsPath)],
      {
        stdio: 'pipe',
        cwd,
      }
    );
    return true;
  } catch (err) {
    return false;
  }
}

async function pipInstall(pipPath: string, workPath: string, args: string[]) {
  const target = '.';
  // See: https://github.com/pypa/pip/issues/4222#issuecomment-417646535
  //
  // Disable installing to the Python user install directory, which is
  // the default behavior on Debian systems and causes error:
  //
  // distutils.errors.DistutilsOptionError: can't combine user with
  // prefix, exec_prefix/home, or install_(plat)base
  process.env.PIP_USER = '0';
  const cmdArgs = [
    'install',
    '--disable-pip-version-check',
    '--target',
    target,
    ...args,
  ];
  const pretty = `${pipPath} ${cmdArgs.join(' ')}`;
  debug(`Running "${pretty}"...`);
  try {
    await execa(pipPath, cmdArgs, {
      cwd: workPath,
    });
  } catch (err) {
    console.log(`Failed to run "${pretty}"`);
    throw err;
  }
}

interface InstallRequirementArg {
  pythonPath: string;
  pipPath: string;
  dependency: string;
  version: string;
  workPath: string;
  meta: Meta;
  args?: string[];
}

// note that any internal dependency that vc_init.py requires that's installed
// with this function can get overriden by a newer version from requirements.txt,
// so vc_init should do runtime version checks to be compatible with any recent
// version of its dependencies
export async function installRequirement({
  pythonPath,
  pipPath,
  dependency,
  version,
  workPath,
  meta,
  args = [],
}: InstallRequirementArg) {
  if (meta.isDev && (await isInstalled(pythonPath, dependency, workPath))) {
    debug(
      `Skipping ${dependency} dependency installation, already installed in ${workPath}`
    );
    return;
  }
  const exact = `${dependency}==${version}`;
  await pipInstall(pipPath, workPath, [exact, ...args]);
}

interface InstallRequirementsFileArg {
  pythonPath: string;
  pipPath: string;
  filePath: string;
  workPath: string;
  meta: Meta;
  args?: string[];
}

export async function installRequirementsFile({
  pythonPath,
  pipPath,
  filePath,
  workPath,
  meta,
  args = [],
}: InstallRequirementsFileArg) {
  const fileAtRoot = relative(workPath, filePath) === basename(filePath);

  // If the `requirements.txt` file is located in the Root Directory of the project and
  // the new File System API is used (`avoidTopLevelInstall`), the Install Command
  // will have already installed its dependencies, so we don't need to do it again.
  if (meta.avoidTopLevelInstall && fileAtRoot) {
    debug(
      `Skipping requirements file installation, already installed by Install Command`
    );
    return;
  }

  if (
    meta.isDev &&
    (await areRequirementsInstalled(pythonPath, filePath, workPath))
  ) {
    debug(`Skipping requirements file installation, already installed`);
    return;
  }
  await pipInstall(pipPath, workPath, ['--upgrade', '-r', filePath, ...args]);
}
