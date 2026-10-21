export interface SdkContractPair {
  sdkVersion: string;
  contractVersion: string;
}

export declare const lastPublishedSdkContractPair: Readonly<SdkContractPair>;

export declare function assertSdkContractPair(
  shrinkwrap: unknown,
  pair: SdkContractPair,
): void;

export declare function assertWorkspaceSdkContractClosure(
  shrinkwrap: unknown,
  pair: SdkContractPair,
): void;

export declare function assertProductionDependencyClosure(
  packageJson: {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  },
  shrinkwrap: unknown,
): void;

export interface WorkspaceIntegrityMismatch {
  packageName: string;
  packagePath: string;
  version: string;
  actualIntegrity: string;
  expectedIntegrity: string;
}

export declare function collectWorkspacePackageIntegrityMismatches(
  shrinkwrap: unknown,
  workspacePackages: Record<string, { version: string; integrity: string }>,
): WorkspaceIntegrityMismatch[];
