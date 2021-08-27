export type Primitive =
  | bigint
  | boolean
  | null
  | number
  | string
  | symbol
  | undefined;

export type JSONArray = JSONValue[];

export type JSONValue = Primitive | JSONObject | JSONArray;

export interface JSONObject {
  [key: string]: JSONValue;
}

export interface AuthConfig {
  _?: string;
  token?: string;
  skipWrite?: boolean;
}

export interface GlobalConfig {
  _?: string;
  currentTeam?: string;
  includeScheme?: string;
  collectMetrics?: boolean;
  api?: string;

  // TODO: legacy - remove
  updateChannel?: string;
  desktop?: {
    teamOrder: any;
  };
}

type Billing = {
  addons: string[];
  cancelation?: number;
  period: { start: number; end: number };
  plan: string;
  platform: string;
  trial: { start: number; end: number };
};

export type User = {
  uid: string;
  avatar: string;
  bio?: string;
  date: number;
  email: string;
  username: string;
  website?: string;
  billingChecked: boolean;
  billing: Billing;
  github?: {
    email: string;
    installation: {
      id: string;
      login: string;
      loginType: string;
    };
    login: string;
    updatedAt: number;
  };
  name?: string;
  limited?: boolean;
};

export interface Team {
  id: string;
  avatar?: string | null;
  billing: Billing;
  created: string;
  creatorId: string;
  membership: { uid: string; role: 'MEMBER' | 'OWNER'; created: number };
  name: string;
  slug: string;
  limited?: boolean;
  saml?: {
    enforced: boolean;
    connection?: {
      state: string;
    };
  };
}

export type Domain = {
  id: string;
  name: string;
  boughtAt: number;
  createdAt: number;
  expiresAt: number;
  transferStartedAt?: number;
  transferredAt?: number | null;
  orderedAt?: number;
  serviceType: 'zeit.world' | 'external' | 'na';
  verified: boolean;
  nsVerifiedAt: number | null;
  txtVerifiedAt: number | null;
  verificationRecord: string;
  nameservers: string[];
  intendedNameservers: string[];
  creator: {
    id: string;
    username: string;
    email: string;
  };
};

export type DomainConfig = {
  configuredBy: null | 'CNAME' | 'A' | 'http';
  misconfigured: boolean;
  serviceType: 'zeit.world' | 'external' | 'na';
  nameservers: string[];
  cnames: string[] & { traceString?: string };
  aValues: string[] & { traceString?: string };
  dnssecEnabled?: boolean;
};

export type Cert = {
  uid: string;
  autoRenew: boolean;
  cns: string[];
  created: string;
  creator: string;
  expiration: string;
};

export type Deployment = {
  uid: string;
  url: string;
  name: string;
  type: 'LAMBDAS';
  state:
    | 'BUILDING'
    | 'ERROR'
    | 'INITIALIZING'
    | 'QUEUED'
    | 'READY'
    | 'CANCELED';
  version?: number;
  created: number;
  createdAt: number;
  creator: { uid: string; username: string };
};

export type Alias = {
  uid: string;
  alias: string;
  createdAt: number;
  deployment: {
    id: string;
    url: string;
  };
  creator: {
    uid: string;
    username: string;
    email: string;
  };
  deploymentId?: string;
};

export type DNSRecord = {
  id: string;
  creator: string;
  mxPriority?: number;
  name: string;
  priority?: number;
  slug: string;
  type: string;
  value: string;
  created: number;
  updated: number;
  createdAt: number;
  updatedAt: number;
  domain: string;
};

type SRVRecordData = {
  name: string;
  type: 'SRV';
  srv: {
    port: number;
    priority: number;
    target: string;
    weight: number;
  };
};

type MXRecordData = {
  name: string;
  type: 'MX';
  value: string;
  mxPriority: number;
};

export type DNSRecordData =
  | {
      name: string;
      type: string;
      value: string;
    }
  | SRVRecordData
  | MXRecordData;

export interface ProjectAliasTarget {
  createdAt?: number;
  domain: string;
  redirect?: string | null;
  target: 'PRODUCTION' | 'STAGING';
  configuredBy?: null | 'CNAME' | 'A';
  configuredChangedAt?: null | number;
  configuredChangeAttempts?: [number, number];
}

export interface Secret {
  uid: string;
  name: string;
  value: string;
  teamId?: string;
  userId?: string;
  projectId?: string;
  created: string;
  createdAt: number;
}

export enum ProjectEnvTarget {
  Production = 'production',
  Preview = 'preview',
  Development = 'development',
}

export enum ProjectEnvType {
  Plaintext = 'plain',
  Secret = 'secret',
  Encrypted = 'encrypted',
  System = 'system',
}

export interface ProjectEnvVariable {
  id: string;
  key: string;
  value: string;
  type: ProjectEnvType;
  configurationId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  target?: ProjectEnvTarget | ProjectEnvTarget[];
  system?: boolean;
  gitBranch?: string;
}

export interface ProjectSettings {
  framework?: string | null;
  devCommand?: string | null;
  buildCommand?: string | null;
  outputDirectory?: string | null;
  rootDirectory?: string | null;
  autoExposeSystemEnvs?: boolean;
  directoryListing?: boolean;
}

export interface Project extends ProjectSettings {
  id: string;
  name: string;
  accountId: string;
  updatedAt: number;
  createdAt: number;
  alias?: ProjectAliasTarget[];
  devCommand?: string | null;
  framework?: string | null;
  rootDirectory?: string | null;
  latestDeployments?: Partial<Deployment>[];
  autoExposeSystemEnvs?: boolean;
  sourceFilesOutsideRootDirectory: boolean;
}

export interface Org {
  type: 'user' | 'team';
  id: string;
  slug: string;
}

export interface ProjectLink {
  projectId: string;
  orgId: string;
}

export interface PaginationOptions {
  prev: number;
  count: number;
  next?: number;
}

export type ProjectLinkResult =
  | { status: 'linked'; org: Org; project: Project }
  | { status: 'not_linked'; org: null; project: null }
  | { status: 'error'; exitCode: number };

export interface Token {
  id: string;
  name: string;
  type: string;
  origin?: string;
  activeAt: number;
  createdAt: number;
  teamId?: string;
}

/**
 * An object representing a Build on Vercel
 */
export interface Build {
  /**
   * The unique identifier of the Build
   * @example "bld_q5fj68jh7eewfe8"
   */
  id: string;

  /**
   * The unique identifier of the deployment
   * @example "dpl_BRGyoU2Jzzwx7myBnqv3xjRDD2GnHTwUWyFybnrUvjDD"
   */
  deploymentId: string;

  /**
   * The entrypoint of the deployment
   * @example "api/index.js"
   */
  entrypoint: string;

  /**
   * The state of the deployment depending on the process of deploying,
   * or if it is ready or in an error state
   * @example "READY"
   */
  readyState:
    | 'INITIALIZING'
    | 'BUILDING'
    | 'UPLOADING'
    | 'DEPLOYING'
    | 'READY'
    | 'ARCHIVED'
    | 'ERROR'
    | 'QUEUED'
    | 'CANCELED';

  /**
   * The time at which the Build state was last modified
   * @example 1567024758130
   */
  readyStateAt?: number;

  /**
   * The time at which the Build was scheduled to be built
   * @example 1567024756543
   */
  scheduledAt?: number | null;

  /**
   * The time at which the Build was created
   * @example 1567071524208
   */
  createdAt?: number;

  /**
   * The time at which the Build was deployed
   * @example 1567071598563
   */
  deployedAt?: number;

  /**
   * The region where the Build was first created
   * @example "sfo1"
   */
  createdIn?: string;

  /**
   * The Runtime the Build used to generate the output
   * @example "@vercel/node"
   */
  use?: string;

  /**
   * An object that contains the Build's configuration
   * @example {"zeroConfig": true}
   */
  config?: {
    distDir?: string | undefined;
    forceBuildIn?: string | undefined;
    reuseWorkPathFrom?: string | undefined;
    zeroConfig?: boolean | undefined;
  };

  /**
   * A list of outputs for the Build that can be either Serverless Functions or static files
   */
  output: BuildOutput[];

  /**
   * If the Build uses the `@vercel/static` Runtime, it contains a hashed string of all outputs
   * @example null
   */
  fingerprint?: string | null;

  copiedFrom?: string;
}

export interface BuildOutput {
  /**
   * The type of the output
   */
  type?: 'lambda' | 'file';

  /**
   * The absolute path of the file or Serverless Function
   */
  path: string;

  /**
   * The SHA1 of the file
   */
  digest: string;

  /**
   * The POSIX file permissions
   */
  mode: number;

  /**
   * The size of the file in bytes
   */
  size?: number;

  /**
   * If the output is a Serverless Function, an object
   * containing the name, location and memory size of the function
   */
  lambda?: {
    functionName: string;
    deployedTo: string[];
    memorySize?: number;
    timeout?: number;
    layers?: string[];
  } | null;
}
