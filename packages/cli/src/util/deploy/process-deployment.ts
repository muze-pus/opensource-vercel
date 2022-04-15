import bytes from 'bytes';
import Progress from 'progress';
import chalk from 'chalk';
import {
  createDeployment,
  DeploymentOptions,
  VercelClientOptions,
} from '@vercel/client';
import { Output } from '../output';
// @ts-ignore
import Now from '../../util';
import { Org } from '../../types';
import ua from '../ua';
import { linkFolderToProject } from '../projects/link';
import { prependEmoji, emoji } from '../emoji';

function printInspectUrl(
  output: Output,
  inspectorUrl: string,
  deployStamp: () => string
) {
  output.print(
    prependEmoji(
      `Inspect: ${chalk.bold(inspectorUrl)} ${deployStamp()}`,
      emoji('inspect')
    ) + `\n`
  );
}

export default async function processDeployment({
  org,
  cwd,
  projectName,
  isSettingUpProject,
  skipAutoDetectionConfirmation,
  ...args
}: {
  now: Now;
  output: Output;
  paths: string[];
  requestBody: DeploymentOptions;
  uploadStamp: () => string;
  deployStamp: () => string;
  quiet: boolean;
  force?: boolean;
  withCache?: boolean;
  org: Org;
  prebuilt: boolean;
  projectName: string;
  isSettingUpProject: boolean;
  skipAutoDetectionConfirmation?: boolean;
  cwd?: string;
  rootDirectory?: string;
}) {
  let {
    now,
    output,
    paths,
    requestBody,
    deployStamp,
    force,
    withCache,
    quiet,
    prebuilt,
    rootDirectory,
  } = args;

  const { debug } = output;
  let bar: Progress | null = null;

  const { env = {} } = requestBody;

  const token = now._token;
  if (!token) {
    throw new Error('Missing authentication token');
  }

  const clientOptions: VercelClientOptions = {
    teamId: org.type === 'team' ? org.id : undefined,
    apiUrl: now._apiUrl,
    token,
    debug: now._debug,
    userAgent: ua,
    path: paths[0],
    force,
    withCache,
    prebuilt,
    rootDirectory,
    skipAutoDetectionConfirmation,
  };

  output.spinner(
    isSettingUpProject
      ? 'Setting up project'
      : `Deploying ${chalk.bold(`${org.slug}/${projectName}`)}`,
    0
  );

  // collect indications to show the user once
  // the deployment is done
  const indications = [];

  try {
    for await (const event of createDeployment(clientOptions, requestBody)) {
      if (['tip', 'notice', 'warning'].includes(event.type)) {
        indications.push(event);
      }

      if (event.type === 'file-count') {
        debug(
          `Total files ${event.payload.total.size}, ${event.payload.missing.length} changed`
        );

        const missingSize = event.payload.missing
          .map((sha: string) => event.payload.total.get(sha).data.length)
          .reduce((a: number, b: number) => a + b, 0);

        output.stopSpinner();
        bar = new Progress(`${chalk.gray('>')} Upload [:bar] :percent :etas`, {
          width: 20,
          complete: '=',
          incomplete: '',
          total: missingSize,
          clear: true,
        });
      }

      if (event.type === 'file-uploaded') {
        debug(
          `Uploaded: ${event.payload.file.names.join(' ')} (${bytes(
            event.payload.file.data.length
          )})`
        );

        if (bar) {
          bar.tick(event.payload.file.data.length);
        }
      }

      if (event.type === 'created') {
        if (bar && !bar.complete) {
          bar.tick(bar.total + 1);
        }

        await linkFolderToProject(
          output,
          cwd || paths[0],
          {
            orgId: org.id,
            projectId: event.payload.projectId,
          },
          projectName,
          org.slug
        );

        now.url = event.payload.url;

        output.stopSpinner();

        printInspectUrl(output, event.payload.inspectorUrl, deployStamp);

        if (quiet) {
          process.stdout.write(`https://${event.payload.url}`);
        }

        output.spinner(
          event.payload.readyState === 'QUEUED' ? 'Queued' : 'Building',
          0
        );
      }

      if (event.type === 'building') {
        output.spinner('Building', 0);
      }

      if (event.type === 'canceled') {
        output.stopSpinner();
        return event.payload;
      }

      // If `checksState` is present, we can only continue to "Completing" if the checks finished,
      // otherwise we might show "Completing" before "Running Checks".
      if (
        event.type === 'ready' &&
        (event.payload.checksState
          ? event.payload.checksState === 'completed'
          : true)
      ) {
        output.spinner('Completing', 0);
      }

      if (event.type === 'checks-running') {
        output.spinner('Running Checks', 0);
      }

      if (event.type === 'checks-conclusion-failed') {
        output.stopSpinner();
        return event.payload;
      }

      // Handle error events
      if (event.type === 'error') {
        output.stopSpinner();

        const error = await now.handleDeploymentError(event.payload, {
          env,
        });

        if (error.code === 'missing_project_settings') {
          return error;
        }

        throw error;
      }

      // Handle alias-assigned event
      if (event.type === 'alias-assigned') {
        event.payload.indications = indications;
        return event.payload;
      }
    }
  } catch (err) {
    output.stopSpinner();
    throw err;
  }
}
