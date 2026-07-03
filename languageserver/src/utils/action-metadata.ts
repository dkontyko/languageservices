import {actionIdentifier, ActionMetadata, ActionReference} from "@actions/languageservice/action";
import {ActionsMetadataProvider} from "@actions/languageservice";
import {error} from "@actions/languageservice/log";
import {Octokit, RestEndpointMethodTypes} from "@octokit/rest";
import {parse} from "yaml";
import {TTLCache} from "./cache.js";
import {errorMessage, errorStatus} from "./error.js";

export type ActionMetadataProviderOptions = {
  refreshSessionToken?: () => Promise<string | undefined>;
  onAuthError?: (action: ActionReference) => void;
  onActionFetchSuccess?: (action: ActionReference) => void;
  onActionFetchFailure?: (action: ActionReference) => void;
  setClient?: (client: Octokit) => void;
  userAgent?: string;
  gitHubApiUrl?: string;
  createClient?: (token: string) => Octokit;
};

const actionMetadataErrors = new WeakMap<Octokit, Map<string, "auth">>();

function isAuthError(e: unknown): boolean {
  const status = errorStatus(e);
  return status === 401;
}

const bearerTokenPattern = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const tokenAssignmentPattern = /([Tt]oken\s*[=:]\s*)([^\s'"`]+)/g;

export function sanitizeErrorForLogs(message: string): string {
  return message.replace(bearerTokenPattern, "Bearer [REDACTED]").replace(tokenAssignmentPattern, "$1[REDACTED]");
}

export function getActionsMetadataProvider(
  client: Octokit | undefined,
  cache: TTLCache,
  options?: ActionMetadataProviderOptions
): ActionsMetadataProvider | undefined {
  if (!client) {
    return undefined;
  }

  let currentClient = client;
  let authRetryAttempted = false;

  return {
    fetchActionMetadata: async action => {
      const metadata = await fetchActionMetadata(currentClient, cache, action);
      if (metadata !== undefined) {
        options?.onActionFetchSuccess?.(action);
        return metadata;
      }

      const errorCode = getActionMetadataError(currentClient, action);
      if (errorCode !== "auth" || authRetryAttempted) {
        options?.onActionFetchFailure?.(action);
        return undefined;
      }

      options?.onAuthError?.(action);
      authRetryAttempted = true;
      const refreshedToken = await options?.refreshSessionToken?.();
      if (!refreshedToken) {
        options?.onActionFetchFailure?.(action);
        return undefined;
      }

      currentClient =
        options?.createClient?.(refreshedToken) ||
        new Octokit({
          auth: refreshedToken,
          userAgent: options?.userAgent || "GitHub Actions Language Server",
          baseUrl: options?.gitHubApiUrl
        });
      options?.setClient?.(currentClient);

      // Clear cache to avoid retaining stale auth-derived misses.
      cache.clear();

      const retried = await fetchActionMetadata(currentClient, cache, action);
      if (retried !== undefined) {
        options?.onActionFetchSuccess?.(action);
        return retried;
      }

      const retryErrorCode = getActionMetadataError(currentClient, action);
      if (retryErrorCode === "auth") {
        options?.onAuthError?.(action);
      }
      options?.onActionFetchFailure?.(action);
      return undefined;
    }
  };
}

export async function fetchActionMetadata(
  client: Octokit,
  cache: TTLCache,
  action: ActionReference
): Promise<ActionMetadata | undefined> {
  const metadata = await cache.get(`${actionIdentifier(action)}/action-metadata`, undefined, () =>
    getActionMetadata(client, action)
  );
  if (!metadata) {
    return undefined;
  }

  // https://docs.github.com/actions/creating-actions/metadata-syntax-for-github-actions
  return parse(metadata) as ActionMetadata;
}

async function getActionMetadata(client: Octokit, action: ActionReference): Promise<string | undefined> {
  let resp: RestEndpointMethodTypes["repos"]["getContent"]["response"];
  try {
    resp = await fetchAction(client, action);
  } catch (e) {
    const safeErrorMessage = sanitizeErrorForLogs(errorMessage(e));
    error(`Failed to fetch action metadata for ${actionIdentifier(action)}: '${safeErrorMessage}'`);
    return;
  }

  // https://docs.github.com/rest/repos/contents?apiVersion=2022-11-28
  // Ignore directories (array of files) and non-file content
  if (resp.data === undefined || Array.isArray(resp.data) || resp.data.type !== "file") {
    return undefined;
  }

  if (resp.data.content === undefined) {
    return undefined;
  }

  return Buffer.from(resp.data.content, "base64").toString("utf8");
}

export function getActionMetadataError(client: Octokit, action: ActionReference): "auth" | undefined {
  const errors = actionMetadataErrors.get(client);
  if (!errors) {
    return undefined;
  }
  return errors.get(actionIdentifier(action));
}

function setActionMetadataError(client: Octokit, action: ActionReference, code: "auth" | undefined): void {
  const key = actionIdentifier(action);
  let errors = actionMetadataErrors.get(client);
  if (!errors) {
    errors = new Map<string, "auth">();
    actionMetadataErrors.set(client, errors);
  }

  if (code) {
    errors.set(key, code);
  } else {
    errors.delete(key);
  }
}

async function fetchAction(client: Octokit, action: ActionReference) {
  try {
    setActionMetadataError(client, action, undefined);
    return await client.repos.getContent({
      owner: action.owner,
      repo: action.name,
      ref: action.ref,
      path: action.path ? `${action.path}/action.yml` : "action.yml"
    });
  } catch (e) {
    if (isAuthError(e)) {
      setActionMetadataError(client, action, "auth");
    }

    // If action.yml doesn't exist, try action.yaml
    if (errorStatus(e) === 404) {
      return await client.repos.getContent({
        owner: action.owner,
        repo: action.name,
        ref: action.ref,
        path: action.path ? `${action.path}/action.yaml` : "action.yaml"
      });
    } else {
      throw e;
    }
  }
}
