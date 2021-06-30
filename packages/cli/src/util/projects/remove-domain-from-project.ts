import chalk from 'chalk';
import Client from '../client';
import { ProjectAliasTarget } from '../../types';

export async function removeDomainFromProject(
  client: Client,
  projectNameOrId: string,
  domain: string
) {
  client.output.spinner(
    `Removing domain ${domain} from project ${chalk.bold(projectNameOrId)}`
  );
  try {
    const response = await client.fetch<ProjectAliasTarget[]>(
      `/projects/${encodeURIComponent(
        projectNameOrId
      )}/alias?domain=${encodeURIComponent(domain)}`,
      {
        method: 'DELETE',
      }
    );

    return response;
  } catch (err) {
    if (err.status < 500) {
      return err;
    }

    throw err;
  }
}
