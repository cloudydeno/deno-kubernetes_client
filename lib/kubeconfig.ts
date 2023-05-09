/**
 * $KUBECONFIG / .kube/config parsing, merging, etc
 *
 * TODO: paths in any of kubconfig path keys should
 * be relative to the file they were originally found in
 */

import { joinPath, parseYaml } from '../deps.ts';

export class KubeConfig {
  constructor(
    public readonly data: RawKubeConfig,
  ) {}

  static async readFromPath(path: string): Promise<KubeConfig> {
    const data = parseYaml(await Deno.readTextFile(path));
    if (isRawKubeConfig(data)) return new KubeConfig(data);
    throw new Error(`KubeConfig's "apiVersion" and "kind" fields weren't set`);
  }

  static async getDefaultConfig(): Promise<KubeConfig> {
    const delim = Deno.build.os === 'windows' ? ';' : ':';
    const path = Deno.env.get("KUBECONFIG");
    const paths = path ? path.split(delim) : [];

    if (!path) {
      // default file is ignored if it't not found
      const defaultPath = joinPath(Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/root", ".kube", "config");
      try {
        return await KubeConfig.readFromPath(defaultPath);
      } catch (err) {
        if (err.name === 'NotFound') {
          return new KubeConfig(mergeKubeConfigs([]));
        }
        throw err;
      }
    }

    const allConfigs = await Promise.all(paths
      .filter(x => x)
      .map(KubeConfig.readFromPath));
    return new KubeConfig(mergeKubeConfigs(allConfigs));
  }

  static async getInClusterConfig({
    // Using this baseUrl
    baseUrl = 'https://kubernetes.default.svc.cluster.local',
    secretsPath = '/var/run/secrets/kubernetes.io/serviceaccount',
  }={}) {
    // Avoid interactive prompting for in-cluster secrets.
    // These are not commonly used from an interactive session.
    const readPermission = await Deno.permissions.query({name: 'read', path: secretsPath});
    if (readPermission.state !== 'granted') {
      throw new Error(`Lacking --allow-read=${secretsPath}`);
    }

    const [namespace, caData, tokenData] = await Promise.all([
      Deno.readTextFile(joinPath(secretsPath, 'namespace')),
      Deno.readTextFile(joinPath(secretsPath, 'ca.crt')),
      Deno.readTextFile(joinPath(secretsPath, 'token')),
    ]);

    return new KubeConfig({
      'apiVersion': "v1",
      'kind': "Config",
      'current-context': "in-cluster",
      contexts: [{ name: "in-cluster", context: {
        'cluster': "local-cluster",
        'user': "service-account",
        'namespace': namespace,
      }}],
      clusters: [{ name: "local-cluster", cluster: {
        'server': baseUrl,
        'certificate-authority-data': btoa(caData),
      }}],
      users: [{ name: "service-account", user: {
        'token': tokenData,
      }}],
    });
  }

  static getSimpleUrlConfig({
    baseUrl = 'http://localhost:8080',
  }={}) {
    return new KubeConfig({
      'apiVersion': "v1",
      'kind': "Config",
      'current-context': "simple-url",
      contexts: [{ name: "simple-url", context: {
        'cluster': "url",
      }}],
      clusters: [{ name: "url", cluster: {
        'server': baseUrl,
      }}],
    });
  }

  getContext(name?: string) {
    return name && this.data.contexts?.find(x => x.name === name) || null;
  }
  getCluster(name?: string) {
    return name && this.data.clusters?.find(x => x.name === name) || null;
  }
  getUser(name?: string) {
    return name && this.data.users?.find(x => x.name === name) || null;
  }

  // client-go is really forgiving about incomplete configs, so let's act similar
  fetchContext(contextName?: string) {
    const current = this.getContext(contextName ?? this.data["current-context"]);
    const cluster = this.getCluster(current?.context?.cluster);
    const user = this.getUser(current?.context?.user);

    return new KubeConfigContext(
      current?.context ?? {},
      cluster?.cluster ?? {},
      user?.user ?? {});
  }
}

export class KubeConfigContext {
  constructor(
    public readonly context: ContextConfig,
    public readonly cluster: ClusterConfig,
    public readonly user: UserConfig,
  ) {}
  private execCred: ExecCredentialStatus | null = null;

  get defaultNamespace() {
    return this.context.namespace ?? null;
  }

  async getServerTls() {
    let serverCert = atob(this.cluster["certificate-authority-data"] ?? '') || null;
    if (!serverCert && this.cluster["certificate-authority"]) {
      serverCert = await Deno.readTextFile(this.cluster["certificate-authority"]);
    }

    if (serverCert) {
      return { serverCert };
    }
    return null;
  }

  async getClientTls() {
    let userCert = atob(this.user["client-certificate-data"] ?? '') || null;
    if (!userCert && this.user["client-certificate"]) {
      userCert = await Deno.readTextFile(this.user["client-certificate"]);
    }

    let userKey = atob(this.user["client-key-data"] ?? '') || null;
    if (!userKey && this.user["client-key"]) {
      userKey = await Deno.readTextFile(this.user["client-key"]);
    }

    if (!userKey && !userCert && this.user.exec) {
      const cred = await this.getExecCredential();
      if (cred.clientKeyData) {
        return {
          userKey: cred.clientKeyData,
          userCert: cred.clientCertificateData,
        };
      }
    }

    if (userKey && userCert) {
      return { userKey, userCert };
    }
    if (userKey || userCert) throw new Error(
      `Within the KubeConfig, client key and certificate must both be provided if either is provided.`);
    return null;
  }

  async getAuthHeader(): Promise<string | null> {
    if (this.user.username || this.user.password) {
      const {username, password} = this.user;
      return `Basic ${btoa(`${username ?? ''}:${password ?? ''}`)}`;

    } else if (this.user.token) {
      return `Bearer ${this.user.token}`;

    } else if (this.user.tokenFile) {
      const token = await Deno.readTextFile(this.user.tokenFile);
      return `Bearer ${token.trim()}`;

    } else if (this.user['auth-provider']) {
      const {name, config} = this.user['auth-provider'];
      switch (name) {

        case 'gcp':
          if (config.expiry && config['access-token']) {
            const expiresAt = new Date(config.expiry);
            if (expiresAt.valueOf() > Date.now()) {
              return `Bearer ${config['access-token']}`;
            } else throw new Error(
              `TODO: GCP auth-provider token expired, use a kubectl command to refresh for now`);
          } else throw new Error(
            `TODO: GCP auth-provider lacks a cached token, use a kubectl command to refresh for now`);

        default: throw new Error(
          `TODO: this kubeconfig's auth-provider (${name}) isn't supported yet`);
      }

    } else if (this.user['exec']) {
      const cred = await this.getExecCredential();
      if (cred.token) {
        return `Bearer ${cred.token}`;
      }
      return null;

    } else return null;
  }

  private async getExecCredential() {
    if (this.execCred && (
        !this.execCred.expirationTimestamp ||
        new Date(this.execCred.expirationTimestamp) > new Date())) {
      return this.execCred;
    }

    const execConfig = this.user['exec'];
    if (!execConfig) throw new Error(`BUG: execConfig disappeared`);

    const isTTY = Deno.isatty(Deno.stdin.rid);
    const stdinPolicy = execConfig.interactiveMode ?? 'IfAvailable';
    if (stdinPolicy == 'Always' && !isTTY) {
      throw new Error(`KubeConfig exec plugin wants a TTY, but stdin is not a TTY`);
    }

    const req: ExecCredential = {
      'apiVersion': execConfig.apiVersion,
      'kind': 'ExecCredential',
      'spec': {
        'interactive': isTTY && stdinPolicy != 'Never',
      },
    };
    if (execConfig.provideClusterInfo) {
      const serverTls = await this.getServerTls();
      req.spec.cluster = {
        'config': this.cluster.extensions?.find(x => x.name == ExecAuthExtensionName)?.extension,
        'server': this.cluster.server,
        'certificate-authority-data': serverTls ? btoa(serverTls.serverCert) : undefined,
      };
    }

    const proc = new Deno.Command(execConfig.command, {
      args: execConfig.args,
      stdin: req.spec.interactive ? 'inherit' : 'null',
      stdout: 'piped',
      stderr: 'inherit',
      env: {
        ...Object.fromEntries(execConfig.env?.map(x => [x.name, x.value]) ?? []),
        KUBERNETES_EXEC_INFO: JSON.stringify(req),
      },
    });
    const output = await proc.output();
    if (!output.success) throw new Error(
      `Exec plugin ${execConfig.command} exited with code ${output.code}`);
    const stdout = JSON.parse(new TextDecoder().decode(output.stdout));
    if (!isExecCredential(stdout) || !stdout.status) throw new Error(
      `Exec plugin ${execConfig.command} did not output an ExecCredential`);

    this.execCred = stdout.status;
    return stdout.status;
  }
}

export function mergeKubeConfigs(configs: (RawKubeConfig | KubeConfig)[]) : RawKubeConfig {
  let currentContext = '';
  const contexts = new Map<string, {name: string, context: ContextConfig}>();
  const clusters = new Map<string, {name: string, cluster: ClusterConfig}>();
  const users = new Map<string, {name: string, user: UserConfig}>();
  const preferences: Record<string, unknown> = Object.create(null);

  // the first value should always be used as-is for each map / object
  // instead of implementing that, do the opposite, and in reverse order
  for (const source of configs.slice(0).reverse()) {
    const config = (source instanceof KubeConfig) ? source.data : source;

    if (config['current-context']) {
      currentContext = config['current-context'];
    }

    for (const context of config.contexts ?? []) {
      contexts.set(context.name, context);
    }
    for (const cluster of config.clusters ?? []) {
      clusters.set(cluster.name, cluster);
    }
    for (const user of config.users ?? []) {
      users.set(user.name, user);
    }

    for (const [key, value] of Object.entries(config.preferences ?? {})) {
      preferences[key] = value;
    }
  }

  return {
    'apiVersion': "v1",
    'kind': "Config",
    'current-context': currentContext,
    'contexts': Array.from(contexts.values()),
    'clusters': Array.from(clusters.values()),
    'users': Array.from(users.values()),
    'preferences': preferences,
  };
}


// TODO: can't we codegen this API from kubernetes definitions?
// there's api docs here https://kubernetes.io/docs/reference/config-api/kubeconfig.v1/

export interface RawKubeConfig {
  'apiVersion': "v1";
  'kind': "Config";

  'contexts'?: {name: string, context: ContextConfig}[];
  'clusters'?: {name: string, cluster: ClusterConfig}[];
  'users'?: {name: string, user: UserConfig}[];

  'current-context'?: string;

  'preferences'?: {
    'colors'?: boolean;
    'extensions'?: Array<NamedExtension>;
  };
}
function isRawKubeConfig(data: any): data is RawKubeConfig {
  return data && data.apiVersion === 'v1' && data.kind === 'Config';
}

export interface ContextConfig {
  'cluster'?: string;
  'user'?: string;
  'namespace'?: string;

  'extensions'?: Array<NamedExtension>;
}

export interface ClusterConfig {
  'server'?: string; // URL

  // // TODO: determine what we can/should/will do about these networking things:
  // 'tls-server-name'?: string;
  // 'insecure-skip-tls-verify'?: boolean;
  // 'proxy-url'?: string;
  // 'disable-compression'?: boolean;

  'certificate-authority'?: string; // path
  'certificate-authority-data'?: string; // base64

  'extensions'?: Array<NamedExtension>;
}

export interface UserConfig {
  // static bearer auth
  'token'?: string; // string
  'tokenFile'?: string; // path
  // static basic auth
  'username'?: string;
  'password'?: string;

  // mTLS auth (--allow-read)
  'client-key'?: string; // path
  'client-key-data'?: string; // base64
  'client-certificate'?: string; // path
  'client-certificate-data'?: string; // base64

  // // TODO: impersonation
  // 'as'?: string;
  // 'as-uid'?: string;
  // 'as-groups'?: string[];
  // 'as-user-extra'?: Record<string, string[]>;

  // external auth (--allow-run)
  /** @deprecated Removed in Kubernetes 1.26, in favor of 'exec */
  'auth-provider'?: {name: string, config: UserAuthProviderConfig};
  'exec'?: UserExecConfig;

  'extensions'?: Array<NamedExtension>;
}

/** @deprecated Removed in Kubernetes 1.26, in favor of `UserExecConfig` */
export interface UserAuthProviderConfig {
  'access-token'?: string;
  'expiry'?: string;

  'cmd-args': string;
  'cmd-path': string;
  'expiry-key': string;
  'token-key': string;
}

export interface UserExecConfig {
  'apiVersion':
    | "client.authentication.k8s.io/v1alpha1"
    | "client.authentication.k8s.io/v1beta1"
    | "client.authentication.k8s.io/v1";
  'command': string;
  'args'?: string[];
  'env'?: Array<{
    'name': string;
    'value': string;
  }>;
  'installHint'?: string;
  'provideClusterInfo'?: boolean;
  'interactiveMode'?: 'Never' | 'IfAvailable' | 'Always';
}

export interface NamedExtension {
  'name': string;
  'extension'?: unknown;
}
export const ExecAuthExtensionName = "client.authentication.k8s.io/exec";


// https://kubernetes.io/docs/reference/config-api/client-authentication.v1beta1/

interface ExecCredential {
  'apiVersion': UserExecConfig['apiVersion'];
  'kind': 'ExecCredential';
  'spec': ExecCredentialSpec;
  'status'?: ExecCredentialStatus;
}
function isExecCredential(data: any): data is ExecCredential {
  return data
      && (data.apiVersion === 'client.authentication.k8s.io/v1alpha1'
        || data.apiVersion === 'client.authentication.k8s.io/v1beta1'
        || data.apiVersion === 'client.authentication.k8s.io/v1')
      && data.kind === 'ExecCredential';
}

interface ExecCredentialSpec {
  'cluster'?: Cluster;
  'interactive'?: boolean;
}

interface ExecCredentialStatus {
  'expirationTimestamp': string;
  'token': string;
  'clientCertificateData': string;
  'clientKeyData': string;
}

interface Cluster {
  'server'?: string;
  'tls-server-name'?: string;
  'insecure-skip-tls-verify'?: boolean;
  'certificate-authority-data'?: string;
  'proxy-url'?: string;
  'disable-compression'?: boolean;
  'config'?: unknown; // comes from the "client.authentication.k8s.io/exec" extension
}
