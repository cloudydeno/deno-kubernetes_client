/**
 * $KUBECONFIG / .kube/config parsing, merging, etc
 *
 * TODO: paths in any of kubconfig path keys should
 * be relative to the file they were originally found in
 */

import { join } from "https://deno.land/std@0.88.0/path/mod.ts";
import * as YAML from "https://deno.land/std@0.88.0/encoding/yaml.ts";

export class KubeConfig {
  constructor(
    public readonly data: RawKubeConfig,
  ) {}

  static async readFromPath(path: string): Promise<KubeConfig> {
    const data = YAML.parse(await Deno.readTextFile(path));
    if (isRawKubeConfig(data)) return new KubeConfig(data);
    throw new Error(`KubeConfig's "apiVersion" and "kind" fields weren't set`);
  }

  static async getDefaultConfig(): Promise<KubeConfig> {
    const delim = Deno.build.os === 'windows' ? ';' : ':';
    const path = Deno.env.get("KUBECONFIG");
    const paths = path ? path.split(delim) : [];

    if (!path) {
      // default file is ignored if it't not found
      const defaultPath = join(Deno.env.get("HOME") || "/root", ".kube", "config");
      try {
        return await KubeConfig.readFromPath(defaultPath);
      } catch (err) {
        if (err.name === 'NotFoundError') { // TODO: confirm
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
    const [namespace, caData, tokenData] = await Promise.all([
      Deno.readTextFile(join(secretsPath, 'namespace')),
      Deno.readTextFile(join(secretsPath, 'ca.crt')),
      Deno.readTextFile(join(secretsPath, 'token')),
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
        'certificate-authority-data': caData,
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

  get defaultNamespace() {
    return this.context.namespace ?? null;
  }

  async getAuthHeader(): Promise<string | null> {
    if (this.user.username || this.user.password) {
      const {username, password} = this.user;
      return `Basic ${btoa(`${username ?? ''}:${password ?? ''}`)}`;

    } else if (this.user.token) {
      return `Bearer ${this.user.token}`;

    } else if (this.user['auth-provider']) {
      const {name, config} = this.user['auth-provider'];
      switch (name) {

        case 'gcp':
          if (config.expiry && config['access-token']) {
            const expiresAt = new Date(config.expiry);
            if (expiresAt.valueOf() < Date.now()) {
              return `Bearer ${config['access-token']}`;
            } else throw new Error(
              `TODO: GCP auth-provider token expired, use a kubectl command to refresh for now`);
          } else throw new Error(
            `TODO: GCP auth-provider lacks a cached token, use a kubectl command to refresh for now`);

        default: throw new Error(
          `TODO: this kubeconfig's auth-provider (${name}) isn't supported yet`);
      }

    } else if (this.user['exec']) {
      throw new Error(
        `TODO: kubeconfig "exec:" blocks aren't supported yet`);

    } else return null;
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



export interface RawKubeConfig {
  'apiVersion': "v1";
  'kind': "Config";

  'contexts'?: {name: string, context: ContextConfig}[];
  'clusters'?: {name: string, cluster: ClusterConfig}[];
  'users'?: {name: string, user: UserConfig}[];

  'current-context'?: string;

  // this actually has a sort of schema, used for CLI stuff
  // we just ignore it though
  'preferences'?: Record<string, unknown>;
}
function isRawKubeConfig(data: any): data is RawKubeConfig {
  return data && data.apiVersion === 'v1' && data.kind === 'Config';
}

export interface ContextConfig {
  'cluster'?: string;
  'user'?: string;
  'namespace'?: string;
}

export interface ClusterConfig {
  'server'?: string; // URL

  'certificate-authority'?: string; // path
  'certificate-authority-data'?: string; // base64
}

export interface UserConfig {
  // inline auth
  'token'?: string;
  'username'?: string;
  'password'?: string;

  // mTLS auth (--allow-read)
  'client-key'?: string; // path
  'client-key-data'?: string; // base64
  'client-certificate'?: string; // path
  'client-certificate-data'?: string; // base64

  // external auth (--allow-run)
  'auth-provider'?: {name: string, config: UserAuthProviderConfig};
  'exec'?: UserExecConfig;
}

export interface UserAuthProviderConfig {
  'access-token'?: string;
  'expiry'?: string;

  'cmd-args': string;
  'cmd-path': string;
  'expiry-key': string;
  'token-key': string;
}

export interface UserExecConfig {
  'apiVersion': "client.authentication.k8s.io/v1alpha1";
  'command': string;
  'args'?: string[];
  'env'?: { name: string; value: string; }[];
}
