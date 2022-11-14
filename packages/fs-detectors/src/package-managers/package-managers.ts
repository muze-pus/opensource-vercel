import type { Framework } from '@vercel/frameworks';

export const packageManagers: Array<
  Omit<Framework, 'description' | 'getOutputDirName' | 'settings'>
> = [
  {
    name: 'npm',
    slug: 'npm',
    logo: '',
    darkModeLogo: '',
    detectors: {
      some: [
        {
          path: 'package-lock.json',
        },
        {
          path: 'package.json',
          matchContent: '"packageManager":\\s*"npm@.*"',
        },
      ],
    },
  },
  {
    name: 'pnpm',
    slug: 'pnpm',
    logo: '',
    darkModeLogo: '',
    detectors: {
      some: [
        {
          path: 'pnpm-lock.yaml',
        },
        {
          path: 'package.json',
          matchContent: '"packageManager":\\s*"pnpm@.*"',
        },
      ],
    },
  },
  {
    name: 'yarn',
    slug: 'yarn',
    logo: '',
    darkModeLogo: '',
    detectors: {
      some: [
        {
          path: 'yarn.lock',
        },
        {
          path: 'package.json',
          matchContent: '"packageManager":\\s*"yarn@.*"',
        },
        {
          path: 'package.json',
        },
      ],
    },
  },
];
