import chalk from 'chalk';
import ms from 'ms';
import table from 'text-table';
import Client from '../../util/client';
import getCommandFlags from '../../util/get-command-flags';
import { getCommandName } from '../../util/pkg-name';
import strlen from '../../util/strlen';

export default async function list(
  client: Client,
  argv: any,
  args: string[],
  contextName: string
) {
  const { output } = client;
  if (args.length !== 0) {
    output.error(
      `Invalid number of arguments. Usage: ${chalk.cyan(
        `${getCommandName('project ls')}`
      )}`
    );
    return 2;
  }

  const start = Date.now();

  output.spinner(`Fetching projects in ${chalk.bold(contextName)}`);

  let projectsUrl = '/v4/projects/?limit=20';

  const next = argv['--next'] || false;
  if (next) {
    projectsUrl += `&until=${next}`;
  }

  const {
    projects: list,
    pagination,
  }: {
    projects: [{ name: string; updatedAt: number }];
    pagination: { count: number; next: number };
  } = await client.fetch(projectsUrl, {
    method: 'GET',
  });

  output.stopSpinner();

  const elapsed = ms(Date.now() - start);

  output.log(
    `${list.length > 0 ? 'Projects' : 'No projects'} found under ${chalk.bold(
      contextName
    )} ${chalk.gray(`[${elapsed}]`)}`
  );

  if (list.length > 0) {
    const cur = Date.now();
    const header = [['', 'name', 'updated'].map(title => chalk.dim(title))];

    const out = table(
      header.concat(
        list.map(secret => [
          '',
          chalk.bold(secret.name),
          chalk.gray(`${ms(cur - secret.updatedAt)} ago`),
        ])
      ),
      {
        align: ['l', 'l', 'l'],
        hsep: ' '.repeat(2),
        stringLength: strlen,
      }
    );

    if (out) {
      output.print(`\n${out}\n\n`);
    }

    if (pagination && pagination.count === 20) {
      const flags = getCommandFlags(argv, ['_', '--next', '-N', '-d', '-y']);
      const nextCmd = `project ls${flags} --next ${pagination.next}`;
      output.log(`To display the next page run ${getCommandName(nextCmd)}`);
    }
  }
  return 0;
}
