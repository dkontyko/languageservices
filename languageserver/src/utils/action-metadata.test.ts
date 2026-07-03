import {Octokit} from "@octokit/rest";
import fetchMock from "fetch-mock";
import {fetchActionMetadata, getActionMetadataError, getActionsMetadataProvider, sanitizeErrorForLogs} from "./action-metadata.js";
import {TTLCache} from "./cache.js";

// A simplified version of the action.yml file from actions/checkout
const actionMetadataContent = `
name: 'Checkout'
description: 'Checkout a Git repository at a particular version'
inputs:
  repository:
    description: Repository name with owner. For example, actions/checkout
    default: \${{ github.repository }}
runs:
  using: node16
  main: dist/index.js
  post: dist/index.js
`;

// Based on https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3
const actionMetadata = {
  name: "action.yml",
  path: "action.yml",
  sha: "cab09ebd3a964aba67b57f9727f5f6fff1372b04",
  size: 3649,
  url: "https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3",
  html_url: "https://github.com/actions/checkout/blob/v3/action.yml",
  git_url: "https://api.github.com/repos/actions/checkout/git/blobs/cab09ebd3a964aba67b57f9727f5f6fff1372b04",
  download_url: "https://raw.githubusercontent.com/actions/checkout/v3/action.yml",
  type: "file",
  content: Buffer.from(actionMetadataContent).toString("base64"),
  encoding: "base64",
  _links: {
    self: "https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3",
    git: "https://api.github.com/repos/actions/checkout/git/blobs/cab09ebd3a964aba67b57f9727f5f6fff1372b04",
    html: "https://github.com/actions/checkout/blob/v3/action.yml"
  }
};

async function fetchActionWithMock(mock: fetchMock.FetchMockSandbox, cache?: TTLCache) {
  return await fetchActionMetadata(
    new Octokit({
      request: {
        fetch: mock
      }
    }),
    cache || new TTLCache(),
    {
      owner: "actions",
      name: "checkout",
      ref: "v3"
    }
  );
}

describe("fetchActionMetadata", () => {
  it("fetches action metadata", async () => {
    const mock = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", actionMetadata);

    const metadata = await fetchActionWithMock(mock);

    expect(metadata?.inputs?.repository?.description).toEqual(
      "Repository name with owner. For example, actions/checkout"
    );
  });

  it("fetches action metadata at a path", async () => {
    const mock = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/some-path%2Faction.yml?ref=v3", actionMetadata);

    const metadata = await fetchActionMetadata(
      new Octokit({
        request: {
          fetch: mock
        }
      }),
      new TTLCache(),
      {
        owner: "actions",
        name: "checkout",
        ref: "v3",
        path: "some-path"
      }
    );

    expect(metadata?.inputs?.repository?.description).toEqual(
      "Repository name with owner. For example, actions/checkout"
    );
  });

  it("falls back to .yaml extension on 404", async () => {
    const mock = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", 404)
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yaml?ref=v3", actionMetadata);

    const metadata = await fetchActionWithMock(mock);

    expect(metadata?.inputs?.repository?.description).toEqual(
      "Repository name with owner. For example, actions/checkout"
    );
  });

  it("fetches action metadata at a path with a .yaml extension", async () => {
    const mock = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/some-path%2Faction.yml?ref=v3", 404)
      .getOnce("https://api.github.com/repos/actions/checkout/contents/some-path%2Faction.yaml?ref=v3", actionMetadata);

    const metadata = await fetchActionMetadata(
      new Octokit({
        request: {
          fetch: mock
        }
      }),
      new TTLCache(),
      {
        owner: "actions",
        name: "checkout",
        ref: "v3",
        path: "some-path"
      }
    );

    expect(metadata?.inputs?.repository?.description).toEqual(
      "Repository name with owner. For example, actions/checkout"
    );
  });

  // Behavior under test is not changed. The test is updated to
  // actually create the client and ensure that 403 error handling
  // remains the same as before.
  it("does not fall back for other errors", async () => {
    const client = new Octokit({
      request: {
        fetch: fetchMock
          .sandbox()
          .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", 403)
      }
    });

    const metadata = await fetchActionMetadata(client, new TTLCache(), {
      owner: "actions",
      name: "checkout",
      ref: "v3"
    });

    expect(metadata).toBeUndefined();
    // 403 is intentionally excluded from refresh/retry to avoid re-auth loops; only 401 triggers refresh logic.
    expect(
      getActionMetadataError(client, {
        owner: "actions",
        name: "checkout",
        ref: "v3"
      })
    ).toBeUndefined();
  });

  it("classifies auth failures", async () => {
    const client = new Octokit({
      request: {
        fetch: fetchMock
          .sandbox()
          .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", 401)
      }
    });

    const metadata = await fetchActionMetadata(client, new TTLCache(), {
      owner: "actions",
      name: "checkout",
      ref: "v3"
    });

    expect(metadata).toBeUndefined();
    expect(
      getActionMetadataError(client, {
        owner: "actions",
        name: "checkout",
        ref: "v3"
      })
    ).toBe("auth");
  });

  it("refreshes token and retries once on auth error", async () => {
    const firstClientFetch = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", 401);

    const secondClientFetch = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", actionMetadata);

    const activeClient = new Octokit({
      request: {
        fetch: firstClientFetch
      }
    });

    const refreshedClient = new Octokit({
      request: {
        fetch: secondClientFetch
      }
    });

    const cache = new TTLCache();
    const provider = getActionsMetadataProvider(activeClient, cache, {
      refreshSessionToken: async () => "new-token",
      createClient: () => refreshedClient
    });

    const metadata = await provider?.fetchActionMetadata({
      owner: "actions",
      name: "checkout",
      ref: "v3"
    });

    expect(metadata?.inputs?.repository?.description).toEqual(
      "Repository name with owner. For example, actions/checkout"
    );
  });

  it("retries auth refresh only once per provider", async () => {
    const firstClientFetch = fetchMock
      .sandbox()
      .get("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", 401);

    const activeClient = new Octokit({
      request: {
        fetch: firstClientFetch
      }
    });

    let refreshCalls = 0;
    const provider = getActionsMetadataProvider(activeClient, new TTLCache(), {
      refreshSessionToken: async () => {
        refreshCalls += 1;
        return "new-token";
      },
      createClient: () =>
        new Octokit({
          request: {
            fetch: fetchMock
              .sandbox()
              .get("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", 401)
          }
        })
    });

    await provider?.fetchActionMetadata({
      owner: "actions",
      name: "checkout",
      ref: "v3"
    });

    await provider?.fetchActionMetadata({
      owner: "actions",
      name: "checkout",
      ref: "v3"
    });

    expect(refreshCalls).toBe(1);
  });

  it("sanitizes token-like values in error messages", () => {
    const original =
      "Bad credentials, Authorization: Bearer ghp_secret123 token=ghu_anotherSecret token:ghs_thirdSecret";
    const sanitized = sanitizeErrorForLogs(original);

    expect(sanitized).toContain("Bearer [REDACTED]");
    expect(sanitized).toContain("token=[REDACTED]");
    expect(sanitized).toContain("token:[REDACTED]");
    expect(sanitized).not.toContain("ghp_secret123");
    expect(sanitized).not.toContain("ghu_anotherSecret");
    expect(sanitized).not.toContain("ghs_thirdSecret");
  });

  it("handles invalid actions", async () => {
    const mock = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", 404)
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yaml?ref=v3", 404);

    const metadata = await fetchActionWithMock(mock);

    expect(metadata).toBeUndefined();
  });

  it("caches action metadata", async () => {
    const mock = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", actionMetadata);

    const cache = new TTLCache();

    const metadata = await fetchActionWithMock(mock, cache);
    expect(metadata?.inputs?.repository?.description).toEqual(
      "Repository name with owner. For example, actions/checkout"
    );

    const cachedMetadata = await fetchActionWithMock(mock, cache);
    expect(cachedMetadata?.inputs?.repository?.description).toEqual(
      "Repository name with owner. For example, actions/checkout"
    );
  });

  it("caches action metadata", async () => {
    const mock = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", actionMetadata);

    const cache = new TTLCache();

    const metadata = await fetchActionWithMock(mock, cache);
    expect(metadata?.inputs?.repository?.description).toEqual(
      "Repository name with owner. For example, actions/checkout"
    );

    const cachedMetadata = await fetchActionWithMock(mock, cache);
    expect(cachedMetadata?.inputs?.repository?.description).toEqual(
      "Repository name with owner. For example, actions/checkout"
    );
  });

  it("ignores directories", async () => {
    const mock = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", [actionMetadata]);

    const metadata = await fetchActionWithMock(mock);

    expect(metadata).toBeUndefined();
  });

  it("ignores non-files", async () => {
    const mock = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", {
        type: "not-a-file",
        content: Buffer.from(actionMetadataContent).toString("base64")
      });

    const metadata = await fetchActionWithMock(mock);

    expect(metadata).toBeUndefined();
  });

  it("ignores responses without content", async () => {
    const mock = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", {
        type: "file"
      });

    const metadata = await fetchActionWithMock(mock);

    expect(metadata).toBeUndefined();
  });

  it("handles emojis in action descriptions", async () => {
    const actionMetadataContent = `
name: 'Checkout'
description: 'Checkout a Git repository at a particular version'
inputs:
  repository:
    description: 📦 Repository 📦 name with owner. For example, actions/checkout
    default: \${{ github.repository }}
runs:
  using: node16
  main: dist/index.js
  post: dist/index.js
`;
    const mock = fetchMock
      .sandbox()
      .getOnce("https://api.github.com/repos/actions/checkout/contents/action.yml?ref=v3", {
        type: "file",
        content: Buffer.from(actionMetadataContent).toString("base64")
      });

    const metadata = await fetchActionWithMock(mock);

    expect(metadata?.inputs?.repository?.description).toEqual(
      "📦 Repository 📦 name with owner. For example, actions/checkout"
    );
  });
});
