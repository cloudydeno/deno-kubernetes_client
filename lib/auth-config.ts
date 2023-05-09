import { ClusterConfig } from "./kubeconfig.ts";

interface ExecCredential {
  'apiVersion': 'client.authentication.k8s.io/v1beta1';
  'kind': 'ExecCredential';
  'spec': ExecCredentialSpec;
  'status'?: ExecCredentialStatus;
}
function isExecCredential(data: any): data is ExecCredential {
  return data
      && data.apiVersion === 'client.authentication.k8s.io/v1beta1'
      && data.kind === 'ExecCredential';
}

interface ExecCredentialSpec {
  'cluster'?: Cluster;
  'interactive'?: boolean;
}

interface ExecCredentialStatus {
  'expirationTimestamp': Date;
  'token': string;
  'clientCertificateData': string;
  'clientKeyData': string;
}

interface Cluster {
  'server': string;
  'tls-server-name'?: string;
  'insecure-skip-tls-verify'?: boolean;
  'certificate-authority-data'?: string;
  'proxy-url'?: string;
  'disable-compression'?: boolean;
  'config'?: unknown; // comes from the "client.authentication.k8s.io/exec" extension
}
