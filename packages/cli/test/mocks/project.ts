import { client } from './client';
import {
  Project,
  ProjectEnvTarget,
  ProjectEnvType,
  ProjectEnvVariable,
} from '../../src/types';
import { formatProvider } from '../../src/util/git/connect-git-provider';
import { parseEnvironment } from '../../src/commands/pull';
import { Env } from '@vercel/build-utils/dist';

const envs: ProjectEnvVariable[] = [
  {
    type: ProjectEnvType.Encrypted,
    id: '781dt89g8r2h789g',
    key: 'REDIS_CONNECTION_STRING',
    value: 'redis://abc123@redis.example.com:6379',
    target: [ProjectEnvTarget.Production, ProjectEnvTarget.Preview],
    gitBranch: undefined,
    configurationId: null,
    updatedAt: 1557241361455,
    createdAt: 1557241361455,
  },
  {
    type: ProjectEnvType.Encrypted,
    id: '781dt89g8r2h789g',
    key: 'BRANCH_ENV_VAR',
    value: 'env var for a specific branch',
    target: [ProjectEnvTarget.Preview],
    gitBranch: 'feat/awesome-thing',
    configurationId: null,
    updatedAt: 1557241361455,
    createdAt: 1557241361455,
  },
  {
    type: ProjectEnvType.Encrypted,
    id: 'r124t6frtu25df16',
    key: 'SQL_CONNECTION_STRING',
    value: 'Server=sql.example.com;Database=app;Uid=root;Pwd=P455W0RD;',
    target: [ProjectEnvTarget.Production],
    gitBranch: undefined,
    configurationId: null,
    updatedAt: 1557241361445,
    createdAt: 1557241361445,
  },
  {
    type: ProjectEnvType.Encrypted,
    id: 'a235l6frtu25df32',
    key: 'SPECIAL_FLAG',
    value: '1',
    target: [ProjectEnvTarget.Development],
    gitBranch: undefined,
    configurationId: null,
    updatedAt: 1557241361445,
    createdAt: 1557241361445,
  },
];

const systemEnvs = [
  {
    type: 'encrypted',
    id: 'a235l6frtu25df32',
    key: 'SYSTEM_ENV_FOR_DEV',
    value: 'development',
    target: ['development'],
    gitBranch: null,
    configurationId: null,
    updatedAt: 1557241361445,
    createdAt: 1557241361445,
  },
  {
    type: 'encrypted',
    id: 'a235l6frtu25df32',
    key: 'SYSTEM_ENV_FOR_PREV',
    value: 'preview',
    target: ['preview'],
    gitBranch: null,
    configurationId: null,
    updatedAt: 1557241361445,
    createdAt: 1557241361445,
  },
  {
    type: 'encrypted',
    id: 'a235l6frtu25df32',
    key: 'SYSTEM_ENV_FOR_PROD',
    value: 'production',
    target: ['production'],
    gitBranch: null,
    configurationId: null,
    updatedAt: 1557241361445,
    createdAt: 1557241361445,
  },
];

export const defaultProject = {
  id: 'foo',
  name: 'cli',
  accountId: 'K4amb7K9dAt5R2vBJWF32bmY',
  createdAt: 1555413045188,
  updatedAt: 1555413045188,
  env: envs,
  targets: {
    production: {
      alias: ['foobar.com'],
      aliasAssigned: 1571239348998,
      createdAt: 1571239348998,
      createdIn: 'sfo1',
      deploymentHostname: 'a-project-name-rjtr4pz3f',
      forced: false,
      id: 'dpl_89qyp1cskzkLrVicDaZoDbjyHuDJ',
      meta: {},
      plan: 'pro',
      private: true,
      readyState: 'READY',
      requestedAt: 1571239348998,
      target: 'production',
      teamId: null,
      type: 'LAMBDAS',
      url: 'a-project-name-rjtr4pz3f.vercel.app',
      userId: 'K4amb7K9dAt5R2vBJWF32bmY',
    },
  },
  latestDeployments: [
    {
      alias: ['foobar.com'],
      aliasAssigned: 1571239348998,
      createdAt: 1571239348998,
      createdIn: 'sfo1',
      deploymentHostname: 'a-project-name-rjtr4pz3f',
      forced: false,
      id: 'dpl_89qyp1cskzkLrVicDaZoDbjyHuDJ',
      meta: {},
      plan: 'pro',
      private: true,
      readyState: 'READY',
      requestedAt: 1571239348998,
      target: 'production',
      teamId: null,
      type: undefined,
      url: 'a-project-name-rjtr4pz3f.vercel.app',
      userId: 'K4amb7K9dAt5R2vBJWF32bmY',
    },
  ],
  lastRollbackTarget: null,
  alias: [
    {
      domain: 'foobar.com',
      target: 'PRODUCTION' as const,
    },
  ],
};

/**
 * Responds to any GET for a project with a 404.
 * `useUnknownProject` should always come after `useProject`, if any,
 * to allow `useProject` responses to still happen.
 */
export function useUnknownProject() {
  let project: Project;
  client.scenario.get(`/v8/projects/:projectNameOrId`, (_req, res) => {
    res.status(404).send();
  });
  client.scenario.post(`/:version/projects`, (req, res) => {
    const { name } = req.body;
    project = {
      ...defaultProject,
      name,
      id: name,
    };
    res.json(project);
  });
  client.scenario.post(`/v9/projects/:projectNameOrId/link`, (req, res) => {
    const { type, repo, org } = req.body;
    const projName = req.params.projectNameOrId;
    if (projName !== project.name && projName !== project.id) {
      return res.status(404).send('Invalid Project name or ID');
    }
    if (
      (type === 'github' || type === 'gitlab' || type === 'bitbucket') &&
      (repo === 'user/repo' || repo === 'user2/repo2')
    ) {
      project.link = {
        type,
        repo,
        repoId: 1010,
        org,
        gitCredentialId: '',
        sourceless: true,
        createdAt: 1656109539791,
        updatedAt: 1656109539791,
      };
      res.json(project);
    } else {
      if (type === 'github') {
        res.status(400).json({
          message: `To link a GitHub repository, you need to install the GitHub integration first. (400)\nInstall GitHub App: https://github.com/apps/vercel`,
          action: 'Install GitHub App',
          link: 'https://github.com/apps/vercel',
          repo,
        });
      } else {
        res.status(400).json({
          code: 'repo_not_found',
          message: `The repository "${repo}" couldn't be found in your linked ${formatProvider(
            type
          )} account.`,
        });
      }
    }
  });
  client.scenario.patch(`/:version/projects/:projectNameOrId`, (req, res) => {
    Object.assign(project, req.body);
    res.json(project);
  });
}

export function useProject(project: Partial<Project> = defaultProject) {
  client.scenario.get(`/v8/projects/${project.name}`, (_req, res) => {
    res.json(project);
  });
  client.scenario.get(`/v8/projects/${project.id}`, (_req, res) => {
    res.json(project);
  });
  client.scenario.patch(`/:version/projects/${project.id}`, (req, res) => {
    Object.assign(project, req.body);
    res.json(project);
  });
  client.scenario.get(
    `/v1/env/pull/${project.id}/:target?/:gitBranch?`,
    (req, res) => {
      const target =
        typeof req.params.target === 'string'
          ? parseEnvironment(req.params.target)
          : undefined;
      let projectEnvs = envs;
      if (target) {
        projectEnvs = projectEnvs.filter(env => {
          if (!env.target) return false;

          // Ensure `target` matches
          const targets = Array.isArray(env.target) ? env.target : [env.target];
          const matchingTarget = targets.includes(target);
          if (!matchingTarget) return false;

          // Ensure `gitBranch` matches
          if (!env.gitBranch) return true;
          return req.params.gitBranch === env.gitBranch;
        });
      }
      const allEnvs = Object.entries(
        exposeSystemEnvs(
          projectEnvs,
          systemEnvs.map(env => env.key),
          project.autoExposeSystemEnvs,
          undefined,
          target
        )
      );

      const env: Record<string, string> = {};

      allEnvs.forEach(([k, v]) => {
        env[k] = v ?? '';
      });
      res.json({ env: env });
    }
  );
  client.scenario.get(
    `/v6/projects/${project.id}/system-env-values`,
    (_req, res) => {
      const target = _req.query.target || 'development';
      if (typeof target !== 'string') {
        throw new Error(
          `/v6/projects/${project.id}/system-env-values was given a query param of "target=${target}", which is not a valid environment.`
        );
      }
      const targetEnvs = systemEnvs.filter(env => env.target.includes(target));

      res.json({
        systemEnvValues: targetEnvs,
      });
    }
  );
  client.scenario.get(`/v8/projects/${project.id}/env`, (req, res) => {
    const target: ProjectEnvTarget | undefined =
      typeof req.query.target === 'string'
        ? parseEnvironment(req.query.target)
        : undefined;

    let targetEnvs = envs;
    if (target) {
      targetEnvs = targetEnvs.filter(env => {
        if (typeof env.target === 'string') {
          return env.target === target;
        }
        if (Array.isArray(env.target)) {
          return env.target.includes(target);
        }
        return false;
      });
    }

    res.json({ envs: targetEnvs });
  });
  client.scenario.post(`/v8/projects/${project.id}/env`, (req, res) => {
    const envObj = req.body;
    envObj.id = envObj.key;
    envs.push(envObj);
    res.json({ envs });
  });
  client.scenario.delete(
    `/v8/projects/${project.id}/env/:envId`,
    (req, res) => {
      const envId = req.params.envId;
      for (const [i, env] of envs.entries()) {
        if (env.key === envId) {
          envs.splice(i, 1);
          break;
        }
      }
      res.json(envs);
    }
  );
  client.scenario.post(`/v9/projects/${project.id}/link`, (req, res) => {
    const { type, repo, org } = req.body;
    if (
      (type === 'github' || type === 'gitlab' || type === 'bitbucket') &&
      (repo === 'user/repo' || repo === 'user2/repo2' || repo === 'user3/repo3')
    ) {
      project.link = {
        type,
        repo,
        repoId: 1010,
        org,
        gitCredentialId: '',
        sourceless: true,
        createdAt: 1656109539791,
        updatedAt: 1656109539791,
      };
      res.json(project);
    } else {
      if (type === 'github') {
        res.status(400).json({
          message: `To link a GitHub repository, you need to install the GitHub integration first. (400)\nInstall GitHub App: https://github.com/apps/vercel`,
          action: 'Install GitHub App',
          link: 'https://github.com/apps/vercel',
          repo,
        });
      } else {
        res.status(400).json({
          code: 'repo_not_found',
          message: `The repository "${repo}" couldn't be found in your linked ${formatProvider(
            type
          )} account.`,
        });
      }
    }
  });
  client.scenario.delete(`/v9/projects/${project.id}/link`, (_req, res) => {
    if (project.link) {
      project.link = undefined;
    }
    res.json(project);
  });
  client.scenario.get(`/v4/projects`, (req, res) => {
    res.json({
      projects: [defaultProject],
      pagination: null,
    });
  });
  client.scenario.post(`/projects`, (req, res) => {
    const { name } = req.body;
    if (name === project.name) {
      res.json(project);
    }
  });
  client.scenario.delete(`/:version/projects/${project.id}`, (_req, res) => {
    res.json({});
  });

  return { project, envs };
}

function getSystemEnvValue(
  systemEnvRef: string,
  { vercelUrl }: { vercelUrl?: string }
) {
  if (systemEnvRef === 'VERCEL_URL') {
    return vercelUrl || '';
  }

  return '';
}

function exposeSystemEnvs(
  projectEnvs: ProjectEnvVariable[],
  systemEnvValues: string[],
  autoExposeSystemEnvs: boolean | undefined,
  vercelUrl?: string,
  target?: ProjectEnvTarget
) {
  const envs: Env = {};

  if (autoExposeSystemEnvs) {
    envs['VERCEL'] = '1';
    envs['VERCEL_ENV'] = target || 'development';

    for (const key of systemEnvValues) {
      envs[key] = getSystemEnvValue(key, { vercelUrl });
    }
  }

  for (let env of projectEnvs) {
    if (env.type === ProjectEnvType.System) {
      envs[env.key] = getSystemEnvValue(env.value, { vercelUrl });
    } else {
      envs[env.key] = env.value;
    }
  }

  return envs;
}
