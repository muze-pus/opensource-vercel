import { client } from './client';

const envs = [
  {
    type: 'encrypted',
    id: '781dt89g8r2h789g',
    key: 'REDIS_CONNECTION_STRING',
    value: 'redis://abc123@redis.example.com:6379',
    target: ['production', 'preview'],
    gitBranch: null,
    configurationId: null,
    updatedAt: 1557241361455,
    createdAt: 1557241361455,
  },
  {
    type: 'encrypted',
    id: 'r124t6frtu25df16',
    key: 'SQL_CONNECTION_STRING',
    value: 'Server=sql.example.com;Database=app;Uid=root;Pwd=P455W0RD;',
    target: ['production'],
    gitBranch: null,
    configurationId: null,
    updatedAt: 1557241361445,
    createdAt: 1557241361445,
  },
  {
    type: 'encrypted',
    id: 'a235l6frtu25df32',
    key: 'SPECIAL_FLAG',
    value: '1',
    target: ['development'],
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
      type: 'LAMBDAS',
      url: 'a-project-name-rjtr4pz3f.vercel.app',
      userId: 'K4amb7K9dAt5R2vBJWF32bmY',
    },
  ],
};

export function useProject(project = defaultProject) {
  client.scenario.get(`/v8/projects/${project.name}`, (_req, res) => {
    res.json(project);
  });
  client.scenario.get(`/v8/projects/${project.id}`, (_req, res) => {
    res.json(project);
  });
  client.scenario.get(`/v8/projects/${project.id}/env`, (_req, res) => {
    const target = _req.query.target;
    if (typeof target === 'string') {
      const targetEnvs = envs.filter(env => env.target.includes(target));
      res.json({ envs: targetEnvs });
    }

    res.json({ envs });
  });

  return { project, envs };
}
