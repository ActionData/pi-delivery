/**
 * The pre-alpha configuration contract is intentionally incomplete. No code
 * accepts it as operational configuration, and it will be versioned before a
 * provider adapter or runner is available.
 */
export const CONFIG_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type NativeCandidateQuery =
  | string
  | { readonly [key: string]: JsonValue };

export type TrackerKind = "github" | "linear" | "jira";

export interface DeliveryConfigV1 {
  readonly schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  readonly project: {
    readonly repository: string;
    readonly defaultBranch: string;
  };
  readonly tracker: {
    readonly kind: TrackerKind;
    readonly candidateQuery: NativeCandidateQuery;
  };
  readonly forge: {
    readonly kind: "github";
  };
}

export type DeliveryConfig = DeliveryConfigV1;
