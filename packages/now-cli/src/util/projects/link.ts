import { join } from 'path';
import fs from 'fs';
import { ensureDir } from 'fs-extra';
import { promisify } from 'util';
import getProjectByIdOrName from '../projects/get-project-by-id-or-name';
import Client from '../client';
import { ProjectNotFound } from '../errors-ts';
import getUser from '../get-user';
import getTeamById from '../get-team-by-id';
import { Output } from '../output';
import { Project } from '../../types';
import { Org } from '../../types';
import chalk from 'chalk';
import { prependEmoji, emoji } from '../emoji';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

export const NOW_FOLDER = '.now';
export const NOW_PROJECT_LINK_FILE = 'project.json';

interface ProjectFolderLink {
  projectId: string;
  orgId: string;
  orgSlug?: string;
  projectName?: string;
}

async function getOrg(client: Client, orgId: string): Promise<Org | null> {
  if (orgId.startsWith('team_')) {
    const team = await getTeamById(client, orgId);
    if (!team) return null;
    return { type: 'team', id: team.id, slug: team.slug };
  }

  const user = await getUser(client);
  if (user.uid !== orgId) return null;
  return { type: 'user', id: orgId, slug: user.username };
}

export async function getLinkedProject(
  client: Client,
  path: string
): Promise<[Org | null, Project | null]> {
  try {
    const json = await readFile(join(path, NOW_FOLDER, NOW_PROJECT_LINK_FILE), {
      encoding: 'utf8',
    });

    const link: ProjectFolderLink = JSON.parse(json);

    const [org, project] = await Promise.all([
      getOrg(client, link.orgId),
      getProjectByIdOrName(client, link.projectId, link.orgId),
    ]);

    if (project instanceof ProjectNotFound || org === null) {
      return [null, null];
    }

    return [org, project];
  } catch (error) {
    // link file does not exists, project is not linked
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
      return [null, null];
    }

    // link file can't be read
    if (error.name === 'SyntaxError') {
      throw new Error(
        'Now project settings could not be retrieved. To link your project again, remove .now'
      );
    }

    throw error;
  }
}

export async function linkFolderToProject(
  output: Output,
  path: string,
  projectFolderLink: ProjectFolderLink,
  projectName: string,
  orgSlug: string
) {
  try {
    await ensureDir(join(path, NOW_FOLDER));
  } catch (error) {
    if (error.code === 'ENOTDIR') {
      // folder couldn't be created because
      // we're deploying a static file
      return;
    }
    throw error;
  }

  await writeFile(
    join(path, NOW_FOLDER, NOW_PROJECT_LINK_FILE),
    JSON.stringify(projectFolderLink),
    {
      encoding: 'utf8',
    }
  );

  // update .gitignore
  let isGitIgnoreUpdated = false;
  try {
    const gitIgnorePath = join(path, '.gitignore');

    const gitIgnore = await readFile(gitIgnorePath)
      .then(buf => buf.toString())
      .catch(() => null);

    if (!gitIgnore || !gitIgnore.split('\n').includes('.now')) {
      await writeFile(gitIgnorePath, gitIgnore ? `${gitIgnore}\n.now` : '.now');
      isGitIgnoreUpdated = true;
    }
  } catch (error) {
    // ignore errors since this is non-critical
  }

  output.print(
    prependEmoji(
      `Linked to ${chalk.bold(`${orgSlug}/${projectName}`)} (created .now${
        isGitIgnoreUpdated ? ' and added it to .gitignore' : ''
      })`,
      emoji('link')
    ) + '\n'
  );
}
