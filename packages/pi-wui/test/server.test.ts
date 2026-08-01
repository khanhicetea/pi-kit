import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { WuiServer } from "../src/server";
import { normalizeWuiSpec, wuiCatalog } from "../src/shared/catalog";
import type { PortalSnapshot, ServerMessage } from "../src/shared/protocol";

const simpleSpec = {
  root: "root",
  state: {},
  elements: {
    root: {
      type: "Card",
      props: { title: "Build summary", description: "Everything passed" },
      children: ["content"],
    },
    content: {
      type: "Stack",
      props: { direction: "horizontal", gap: "sm", align: "center" },
      children: ["status", "message"],
    },
    status: {
      type: "Badge",
      props: { text: "Passed", variant: "default" },
      children: [],
    },
    message: {
      type: "Text",
      props: { text: "Ready", variant: "muted" },
      children: [],
    },
  },
};

const htmlPreviewSpec = {
  root: "preview",
  state: {},
  elements: {
    preview: {
      type: "HtmlPreview",
      props: {
        html: "<!doctype html><style>body{font-family:sans-serif}</style><button>Tap me</button>",
        title: "Mobile prototype",
        height: 844,
        viewport: "mobile",
        allowScripts: false,
      },
      children: [],
    },
  },
};

const formSpec = {
  root: "form",
  state: { form: { name: "Ada", role: "Engineer", updates: true } },
  elements: {
    form: {
      type: "Card",
      props: { title: "Profile", description: "Confirm your details", maxWidth: "md", centered: true },
      children: ["fields"],
    },
    fields: {
      type: "Stack",
      props: { direction: "vertical", gap: "md" },
      children: ["name", "role", "updates", "actions"],
    },
    name: {
      type: "Input",
      props: {
        label: "Name",
        name: "name",
        type: "text",
        value: { $bindState: "/form/name" },
        checks: [{ type: "required", message: "Name is required" }],
      },
      children: [],
    },
    role: {
      type: "Select",
      props: {
        label: "Role",
        name: "role",
        options: ["Engineer", "Designer", "Manager"],
        value: { $bindState: "/form/role" },
      },
      children: [],
    },
    updates: {
      type: "Switch",
      props: { label: "Product updates", name: "updates", checked: { $bindState: "/form/updates" } },
      children: [],
    },
    actions: {
      type: "Stack",
      props: { direction: "horizontal", gap: "sm" },
      children: ["submit", "cancel"],
    },
    submit: {
      type: "Button",
      props: { label: "Confirm", variant: "primary" },
      on: { press: { action: "submit", params: { intent: "confirm-profile" } } },
      children: [],
    },
    cancel: {
      type: "Button",
      props: { label: "Cancel", variant: "secondary" },
      on: { press: { action: "cancel", params: { reason: "user cancelled" } } },
      children: [],
    },
  },
};

async function createTestServer(options: { cloudflareTunnel?: boolean; onWarning?: (message: string) => void } = {}) {
  const staticDir = await mkdtemp(join(tmpdir(), "pi-wui-test-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>test</title>");
  const server = new WuiServer({
    staticDir,
    sessionId: "test-session",
    sessionName: "Test",
    cwd: process.cwd(),
    ...options,
  });
  const endpoint = await server.start();
  return { server, endpoint, staticDir };
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      try {
        resolve(JSON.parse(data.toString()) as ServerMessage);
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

async function openSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    origin: `http://127.0.0.1:${port}`,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

test("catalog accepts shadcn views and wires conventional form buttons", () => {
  assert.equal(wuiCatalog.validate(normalizeWuiSpec(simpleSpec)).success, true);
  assert.equal(wuiCatalog.validate(normalizeWuiSpec(formSpec)).success, true);
  assert.equal(wuiCatalog.validate(normalizeWuiSpec(htmlPreviewSpec)).success, true);

  const formWithoutActions = structuredClone(formSpec);
  delete (formWithoutActions.elements.submit as { on?: unknown }).on;
  delete (formWithoutActions.elements.cancel as { on?: unknown }).on;
  const normalized = normalizeWuiSpec(formWithoutActions) as typeof formSpec;
  assert.deepEqual(normalized.elements.submit.on, {
    press: { action: "submit", params: { intent: "confirm" } },
  });
  assert.deepEqual(normalized.elements.cancel.on, {
    press: { action: "cancel", params: { reason: "user cancelled" } },
  });
  assert.equal(wuiCatalog.validate(normalized).success, true);

  const formWithoutBindings = structuredClone(formSpec);
  formWithoutBindings.elements.name.props.value = null as unknown as { $bindState: string };
  formWithoutBindings.elements.role.props.value = null as unknown as { $bindState: string };
  formWithoutBindings.elements.updates.props.checked = null as unknown as { $bindState: string };
  const rebound = normalizeWuiSpec(formWithoutBindings) as typeof formSpec;
  assert.deepEqual(rebound.elements.name.props.value, { $bindState: "/form/name" });
  assert.deepEqual(rebound.elements.role.props.value, { $bindState: "/form/role" });
  assert.deepEqual(rebound.elements.updates.props.checked, { $bindState: "/form/updates" });

  const repeated = normalizeWuiSpec({
    root: "todos",
    state: { todos: [{ id: "1", completed: false }] },
    elements: {
      todos: {
        type: "Stack",
        props: { direction: "vertical", gap: "sm" },
        repeat: { statePath: "/todos", key: "id" },
        children: ["completed"],
      },
      completed: {
        type: "Checkbox",
        props: { label: "Done", name: "completed", checked: false },
        children: [],
      },
    },
  }) as { elements: { completed: { props: { checked: unknown } } } };
  assert.deepEqual(repeated.elements.completed.props.checked, { $bindItem: "completed" });

  const dashboard = {
    root: "page",
    state: {},
    elements: {
      page: {
        type: "Stack",
        props: { direction: "vertical", gap: "lg" },
        children: ["metrics"],
      },
      metrics: {
        type: "Grid",
        props: { columns: 4, gap: "md" },
        children: [],
      },
    },
  };
  const stretched = normalizeWuiSpec(dashboard) as {
    elements: { page: { props: { align: string } } };
  };
  assert.equal(stretched.elements.page.props.align, "stretch");
  assert.equal(wuiCatalog.validate(stretched).success, true);

  dashboard.elements.page.props = {
    ...dashboard.elements.page.props,
    align: "start",
  } as typeof dashboard.elements.page.props;
  const explicitlyAligned = normalizeWuiSpec(dashboard) as {
    elements: { page: { props: { align: string } } };
  };
  assert.equal(explicitlyAligned.elements.page.props.align, "start");
});

test("server binds locally, serves security headers, and presents views", async (t) => {
  const { server, endpoint, staticDir } = await createTestServer();
  t.after(async () => {
    await server.stop("test complete");
    await rm(staticDir, { recursive: true, force: true });
  });

  assert.match(endpoint.word, /^[a-z]{6}$/);
  assert.ok(endpoint.port >= 10_000 && endpoint.port <= 20_000);
  assert.match(endpoint.hostname, /^[a-z]{6}-7f000001\.nip\.io$/);

  const health = await fetch(`http://127.0.0.1:${endpoint.port}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-frame-options"), "DENY");
  const contentSecurityPolicy = health.headers.get("content-security-policy") ?? "";
  assert.match(contentSecurityPolicy, /default-src 'self'/);
  assert.match(contentSecurityPolicy, /style-src-attr 'unsafe-inline'/);

  const sandbox = await fetch(`http://127.0.0.1:${endpoint.port}/sandbox`);
  assert.equal(sandbox.status, 200);
  assert.equal(sandbox.headers.get("x-frame-options"), "SAMEORIGIN");
  const sandboxPolicy = sandbox.headers.get("content-security-policy") ?? "";
  assert.match(sandboxPolicy, /default-src 'none'/);
  assert.match(sandboxPolicy, /script-src 'unsafe-inline'/);
  assert.match(sandboxPolicy, /connect-src 'none'/);
  assert.match(sandboxPolicy, /script-src 'unsafe-inline' 'unsafe-eval' https:\/\/cdn\.tailwindcss\.com/);
  assert.match(sandboxPolicy, /https:\/\/cdn\.jsdelivr\.net\/npm\/alpinejs@3\.15\.12\/dist\/cdn\.min\.js/);
  assert.match(await sandbox.text(), /pi-wui:html-preview/);

  const missingResource = await fetch(`http://127.0.0.1:${endpoint.port}/_wui/not-found`);
  assert.equal(missingResource.status, 404, "reserved WUI resource routes must not fall back to the portal SPA");

  assert.throws(
    () =>
      server.present({
        title: "Invalid preview",
        spec: {
          ...htmlPreviewSpec,
          elements: {
            preview: {
              ...htmlPreviewSpec.elements.preview,
              props: { ...htmlPreviewSpec.elements.preview.props, viewport: "watch" },
            },
          },
        },
      }),
    /Invalid HtmlPreview/,
  );

  assert.throws(
    () =>
      server.present({
        title: "Invalid chart",
        spec: {
          root: "chart",
          state: {},
          elements: {
            chart: {
              type: "LineChart",
              props: {
                labels: ["Mon", "Tue"],
                series: [{ name: "Visits", values: [10] }],
              },
              children: [],
            },
          },
        },
      }),
    /Invalid LineChart.*Expected 2 values/,
  );

  const first = server.present({ title: "Summary", spec: simpleSpec });
  const second = server.present({ title: "Details", spec: simpleSpec });
  const third = server.present({ title: "Results", spec: simpleSpec });
  assert.equal(first.title, "Summary");
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.equal(third.revision, 1);
  assert.notEqual(first.id, second.id);
  assert.notEqual(second.id, third.id);

  const socket = await openSocket(endpoint.port);
  t.after(() => socket.close());
  const token = new URL(endpoint.fallbackUrl).hash.slice("#token=".length);
  socket.send(JSON.stringify({ type: "auth", token: decodeURIComponent(token) }));
  const authMessage = await nextMessage(socket);
  assert.equal(authMessage.type, "auth_ok");
  const initialSnapshot = (authMessage as { type: "auth_ok"; snapshot: PortalSnapshot }).snapshot;
  assert.equal(initialSnapshot.views.length, 3);
  assert.deepEqual(
    initialSnapshot.views.map((view) => view.title),
    ["Results", "Details", "Summary"],
  );
  assert.equal(initialSnapshot.activeView?.id, third.id);

  const replaced = server.present({ title: "Updated results", spec: simpleSpec, mode: "replace" });
  assert.equal(replaced.id, third.id);
  assert.equal(replaced.revision, 2);

  const stable = server.present({ title: "Progress", spec: simpleSpec, viewId: "progress" });
  const stableUpdate = server.present({ title: "Progress complete", spec: simpleSpec, viewId: "progress" });
  assert.equal(stableUpdate.id, stable.id);
  assert.equal(stableUpdate.revision, 2);
});

test("server warns and keeps the local URL when cloudflared is not installed", async (t) => {
  const emptyPath = await mkdtemp(join(tmpdir(), "pi-wui-empty-path-"));
  const originalPath = process.env.PATH;
  const warnings: string[] = [];
  process.env.PATH = emptyPath;

  let result: Awaited<ReturnType<typeof createTestServer>>;
  try {
    result = await createTestServer({
      cloudflareTunnel: true,
      onWarning: (message) => warnings.push(message),
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }

  const { server, endpoint, staticDir } = result;
  t.after(async () => {
    await server.stop("test complete");
    await rm(staticDir, { recursive: true, force: true });
    await rm(emptyPath, { recursive: true, force: true });
  });

  assert.equal(endpoint.url, endpoint.localUrl);
  assert.equal(endpoint.tunnelUrl, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /cloudflared is not installed/);
  assert.match(warnings[0]!, /developers\.cloudflare\.com/);
});

test("server stages local HTML files behind random sandbox URLs", async (t) => {
  const { server, endpoint, staticDir } = await createTestServer();
  const sourceDir = await mkdtemp(join(tmpdir(), "pi-wui-html-source-"));
  const sourcePath = join(sourceDir, "mobile-preview.html");
  await writeFile(
    sourcePath,
    "<!doctype html><style>body{color:tomato}</style><h1>Mobile preview</h1><script>document.body.dataset.ready='yes'</script>",
  );
  t.after(async () => {
    await server.stop("test complete");
    await rm(staticDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  });

  const presented = await server.presentHtmlFile({
    title: "Mobile preview",
    path: sourcePath,
    viewport: "mobile",
    height: 844,
    allowScripts: true,
    cleanupSource: true,
    viewId: "mobile-preview",
  });
  assert.equal(presented.title, "Mobile preview");
  assert.equal(existsSync(sourcePath), false);

  const socket = await openSocket(endpoint.port);
  t.after(() => socket.close());
  const token = new URL(endpoint.fallbackUrl).hash.slice("#token=".length);
  socket.send(JSON.stringify({ type: "auth", token: decodeURIComponent(token) }));
  const authMessage = await nextMessage(socket);
  assert.equal(authMessage.type, "auth_ok");
  const snapshot = (authMessage as { type: "auth_ok"; snapshot: PortalSnapshot }).snapshot;
  const src = snapshot.activeView?.spec.elements["html-preview"]?.props.src;
  assert.equal(typeof src, "string");
  assert.match(src as string, /^\/sandbox\/[A-Za-z0-9_-]+$/);

  const sandbox = await fetch(`http://127.0.0.1:${endpoint.port}${src}`);
  assert.equal(sandbox.status, 200);
  assert.equal(sandbox.headers.get("cache-control"), "no-store");
  assert.equal(sandbox.headers.get("cross-origin-resource-policy"), "cross-origin");
  const sandboxPolicy = sandbox.headers.get("content-security-policy") ?? "";
  assert.match(sandboxPolicy, /script-src 'self' 'unsafe-inline'/);
  assert.match(sandboxPolicy, /https:\/\/cdn\.tailwindcss\.com/);
  assert.match(sandboxPolicy, /https:\/\/cdn\.jsdelivr\.net\/npm\/alpinejs@3\.15\.12\/dist\/cdn\.min\.js/);
  assert.match(await sandbox.text(), /Mobile preview/);

  const firstConcept = join(sourceDir, "editorial.html");
  const secondConcept = join(sourceDir, "minimal.html");
  await writeFile(firstConcept, "<!doctype html><h1>Editorial</h1>");
  await writeFile(secondConcept, "<!doctype html><h1>Minimal</h1>");
  const snapshotPromise = nextMessage(socket);
  await server.presentHtmlFiles({
    title: "Two concepts",
    columns: 2,
    previews: [
      { path: firstConcept, title: "Editorial", viewport: "mobile", cleanupSource: true },
      { path: secondConcept, title: "Minimal", viewport: "mobile", cleanupSource: true },
    ],
  });
  const update = await snapshotPromise;
  assert.equal(update.type, "snapshot");
  const multiView = update.type === "snapshot" ? update.snapshot.activeView : null;
  assert.equal(multiView?.spec.elements["html-preview-grid"]?.type, "Grid");
  assert.deepEqual(multiView?.spec.elements["html-preview-grid"]?.children, ["html-preview-1", "html-preview-2"]);
  const stagedSources = [
    multiView?.spec.elements["html-preview-1"]?.props.src,
    multiView?.spec.elements["html-preview-2"]?.props.src,
  ];
  assert.equal(new Set(stagedSources).size, 2);
  assert.equal(existsSync(firstConcept), false);
  assert.equal(existsSync(secondConcept), false);
  for (const stagedSource of stagedSources) {
    assert.equal(typeof stagedSource, "string");
    const response = await fetch(`http://127.0.0.1:${endpoint.port}${stagedSource}`);
    assert.equal(response.status, 200);
  }
});

test("server resolves logical assets atomically and serves staged files", async (t) => {
  const { server, endpoint, staticDir } = await createTestServer();
  const sourceDir = await mkdtemp(join(tmpdir(), "pi-wui-asset-source-"));
  const sourcePath = join(sourceDir, "generated image.png");
  const sourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(sourcePath, sourceBytes);
  t.after(async () => {
    await server.stop("test complete");
    await rm(staticDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  });

  const imageSpec = {
    root: "image",
    state: {},
    elements: {
      image: {
        type: "Image",
        props: { src: "asset://generated-image", alt: "Generated result" },
        children: [],
      },
    },
  };
  const created = await server.createView({
    title: "Generated image",
    spec: imageSpec,
    assets: [{ id: "generated-image", path: sourcePath, cleanupSource: true }],
  });
  assert.match(created.assets["generated-image"] ?? "", /^\/_wui\/resource\/[A-Za-z0-9_-]+\/generated%20image\.png$/);
  assert.equal(existsSync(sourcePath), false);

  const assetUrl = created.assets["generated-image"]!;
  const assetResponse = await fetch(`http://127.0.0.1:${endpoint.port}${assetUrl}`);
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get("content-type"), "image/png");
  assert.equal(assetResponse.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), sourceBytes);

  const socket = await openSocket(endpoint.port);
  t.after(() => socket.close());
  const token = new URL(endpoint.fallbackUrl).hash.slice("#token=".length);
  socket.send(JSON.stringify({ type: "auth", token: decodeURIComponent(token) }));
  const authMessage = await nextMessage(socket);
  assert.equal(authMessage.type, "auth_ok");
  const snapshot = (authMessage as { type: "auth_ok"; snapshot: PortalSnapshot }).snapshot;
  assert.equal(snapshot.activeView?.spec.elements.image?.props.src, assetUrl);

  const rollbackSource = join(sourceDir, "rollback.png");
  await writeFile(rollbackSource, sourceBytes);
  await assert.rejects(
    () =>
      server.createView({
        title: "Broken asset reference",
        spec: {
          ...imageSpec,
          elements: {
            image: {
              ...imageSpec.elements.image,
              props: { ...imageSpec.elements.image.props, src: "asset://missing-image" },
            },
          },
        },
        assets: [{ id: "declared-image", path: rollbackSource, cleanupSource: true }],
      }),
    /Unknown asset id “missing-image”/,
  );
  assert.equal(existsSync(rollbackSource), true, "failed atomic calls must not clean up source files");
});

test("server uploads multiple safe web assets for later views", async (t) => {
  const { server, endpoint, staticDir } = await createTestServer();
  const sourceDir = await mkdtemp(join(tmpdir(), "pi-wui-upload-source-"));
  const firstPath = join(sourceDir, "hero image.png");
  const secondPath = join(sourceDir, "thumbnail.webp");
  const unsafePath = join(sourceDir, "notes.txt");
  await writeFile(firstPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(secondPath, Buffer.from("RIFF-test-WEBP"));
  await writeFile(unsafePath, "not a passive web asset");
  t.after(async () => {
    await server.stop("test complete");
    await rm(staticDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  });

  const uploaded = await server.uploadAssets([firstPath, secondPath]);
  assert.equal(uploaded.length, 2);
  assert.deepEqual(
    uploaded.map((asset) => asset.filename),
    ["hero image.png", "thumbnail.webp"],
  );
  assert.equal(new Set(uploaded.map((asset) => asset.assetId)).size, 2);
  for (const asset of uploaded) assert.match(asset.assetId, /^asset:\/\/[A-Za-z0-9_-]+$/);
  assert.equal(existsSync(firstPath), true, "uploading must not modify source files");
  assert.equal(existsSync(secondPath), true, "uploading must not modify source files");
  await assert.rejects(() => server.uploadAssets([unsafePath]), /must use a safe web extension/);

  // An unrelated view between upload and use must not prune pending assets.
  server.present({ title: "Intervening view", spec: simpleSpec });
  const created = await server.createView({
    title: "Uploaded images",
    spec: {
      root: "images",
      state: {},
      elements: {
        images: {
          type: "Grid",
          props: { columns: 2, gap: "md" },
          children: ["hero", "thumbnail"],
        },
        hero: {
          type: "Image",
          props: { src: uploaded[0]!.assetId, alt: "Hero" },
          children: [],
        },
        thumbnail: {
          type: "Image",
          props: { src: uploaded[1]!.assetId, alt: "Thumbnail" },
          children: [],
        },
      },
    },
  });
  assert.deepEqual(created.assets, {}, "pre-uploaded assets do not need to be redeclared on the view");

  const socket = await openSocket(endpoint.port);
  t.after(() => socket.close());
  const token = new URL(endpoint.fallbackUrl).hash.slice("#token=".length);
  socket.send(JSON.stringify({ type: "auth", token: decodeURIComponent(token) }));
  const authMessage = await nextMessage(socket);
  assert.equal(authMessage.type, "auth_ok");
  const snapshot = (authMessage as { type: "auth_ok"; snapshot: PortalSnapshot }).snapshot;
  const heroUrl = snapshot.activeView?.spec.elements.hero?.props.src;
  const thumbnailUrl = snapshot.activeView?.spec.elements.thumbnail?.props.src;
  assert.match(heroUrl as string, /^\/_wui\/resource\/[A-Za-z0-9_-]+\/hero%20image\.png$/);
  assert.match(thumbnailUrl as string, /^\/_wui\/resource\/[A-Za-z0-9_-]+\/thumbnail\.webp$/);

  const [heroResponse, thumbnailResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${endpoint.port}${heroUrl}`),
    fetch(`http://127.0.0.1:${endpoint.port}${thumbnailUrl}`),
  ]);
  assert.equal(heroResponse.status, 200);
  assert.equal(heroResponse.headers.get("content-type"), "image/png");
  assert.equal(thumbnailResponse.status, 200);
  assert.equal(thumbnailResponse.headers.get("content-type"), "image/webp");
});

test("server stages an HTML webRoot so relative bundle assets work", async (t) => {
  const { server, endpoint, staticDir } = await createTestServer();
  const webRoot = await mkdtemp(join(tmpdir(), "pi-wui-web-root-"));
  const assetsDir = join(webRoot, "assets");
  await mkdir(assetsDir);
  const entryPath = join(webRoot, "index.html");
  await writeFile(entryPath, '<!doctype html><link rel="stylesheet" href="./assets/site.css"><h1>Bundled preview</h1>');
  await writeFile(join(assetsDir, "site.css"), "h1 { color: tomato; }");
  await writeFile(join(webRoot, ".env"), "SECRET=must-not-be-staged");
  t.after(async () => {
    await server.stop("test complete");
    await rm(staticDir, { recursive: true, force: true });
    await rm(webRoot, { recursive: true, force: true });
  });

  await server.createView({
    title: "Bundled preview",
    html: [{ path: entryPath, webRoot, allowScripts: true, cleanupSource: true }],
  });
  assert.equal(existsSync(webRoot), false);

  const socket = await openSocket(endpoint.port);
  t.after(() => socket.close());
  const token = new URL(endpoint.fallbackUrl).hash.slice("#token=".length);
  socket.send(JSON.stringify({ type: "auth", token: decodeURIComponent(token) }));
  const authMessage = await nextMessage(socket);
  assert.equal(authMessage.type, "auth_ok");
  const snapshot = (authMessage as { type: "auth_ok"; snapshot: PortalSnapshot }).snapshot;
  const src = snapshot.activeView?.spec.elements["html-preview"]?.props.src;
  assert.match(src as string, /^\/sandbox\/[A-Za-z0-9_-]+\/index\.html$/);

  const entryResponse = await fetch(`http://127.0.0.1:${endpoint.port}${src}`);
  assert.equal(entryResponse.status, 200);
  assert.match(await entryResponse.text(), /Bundled preview/);
  assert.match(entryResponse.headers.get("content-security-policy") ?? "", /img-src 'self'/);
  assert.match(entryResponse.headers.get("content-security-policy") ?? "", /script-src 'self'/);

  const cssUrl = new URL("./assets/site.css", `http://127.0.0.1:${endpoint.port}${src}`).href;
  const cssResponse = await fetch(cssUrl);
  assert.equal(cssResponse.status, 200);
  assert.equal(cssResponse.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(cssResponse.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.match(await cssResponse.text(), /tomato/);

  const hiddenResponse = await fetch(new URL("./.env", `http://127.0.0.1:${endpoint.port}${src}`));
  assert.equal(hiddenResponse.status, 404);
  assert.doesNotMatch(await hiddenResponse.text(), /must-not-be-staged/);
});

test("server exposes live view state and applies JSON Pointer updates", async (t) => {
  const { server, endpoint, staticDir } = await createTestServer();
  t.after(async () => {
    await server.stop("test complete");
    await rm(staticDir, { recursive: true, force: true });
  });

  const presented = server.present({ title: "Profile", spec: formSpec, viewId: "profile" });
  assert.equal(presented.revision, 1);
  assert.equal(server.readState("profile", "/form/name").value, "Ada");

  const updated = server.updateState("profile", [
    { op: "set", path: "/form/name", value: "Grace" },
    { op: "set", path: "/form/team", value: "Compiler" },
    { op: "remove", path: "/form/role" },
  ]);
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.state, { form: { name: "Grace", updates: true, team: "Compiler" } });
  assert.deepEqual(server.readState().state, updated.state);
  assert.throws(
    () => server.updateState("profile", [{ op: "set", path: "/__proto__/polluted", value: true }]),
    /Unsafe state path/,
  );

  assert.equal(server.hasAuthenticatedBrowser, false);
  const socket = await openSocket(endpoint.port);
  t.after(() => socket.close());
  const token = new URL(endpoint.fallbackUrl).hash.slice("#token=".length);
  socket.send(JSON.stringify({ type: "auth", token: decodeURIComponent(token) }));
  const authMessage = await nextMessage(socket);
  assert.equal(authMessage.type, "auth_ok");
  assert.equal(server.hasAuthenticatedBrowser, true);
  const snapshot = (authMessage as { type: "auth_ok"; snapshot: PortalSnapshot }).snapshot;
  assert.equal(snapshot.activeView?.revision, 2);
  assert.deepEqual(snapshot.activeView?.state, updated.state);
  assert.deepEqual(snapshot.activeView?.spec.state, updated.state);
});

test("one view combines catalog UI, staged HTML, and required feedback", async (t) => {
  const { server, endpoint, staticDir } = await createTestServer();
  const sourceDir = await mkdtemp(join(tmpdir(), "pi-wui-mixed-source-"));
  const sourcePath = join(sourceDir, "prototype.html");
  await writeFile(sourcePath, "<!doctype html><h1>Sandboxed prototype</h1>");
  const socket = await openSocket(endpoint.port);
  t.after(async () => {
    socket.close();
    await server.stop("test complete");
    await rm(staticDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  });

  const mixedSpec = structuredClone(formSpec) as typeof formSpec & {
    elements: typeof formSpec.elements &
      Record<string, { type: string; props: Record<string, unknown>; children: string[] }>;
  };
  mixedSpec.root = "mixed";
  mixedSpec.elements.mixed = {
    type: "Grid",
    props: { columns: 2, gap: "lg" },
    children: ["preview", "form"],
  };
  mixedSpec.elements.preview = {
    type: "HtmlPreview",
    props: { title: "Prototype", viewport: "mobile", height: 700 },
    children: [],
  };

  const created = await server.createView({
    title: "Review prototype",
    spec: mixedSpec,
    html: [{ path: sourcePath, elementId: "preview" }],
    feedback: { timeoutMs: 5_000 },
  });
  assert.ok(created.feedback);

  const token = new URL(endpoint.fallbackUrl).hash.slice("#token=".length);
  socket.send(JSON.stringify({ type: "auth", token: decodeURIComponent(token) }));
  const authMessage = await nextMessage(socket);
  assert.equal(authMessage.type, "auth_ok");
  const snapshot = (authMessage as { type: "auth_ok"; snapshot: PortalSnapshot }).snapshot;
  assert.equal(snapshot.activeView?.id, created.id);
  assert.equal(snapshot.activeView?.interactive, true);
  assert.equal(snapshot.activeView?.spec.elements.preview?.type, "HtmlPreview");
  const src = snapshot.activeView?.spec.elements.preview?.props.src;
  assert.match(src as string, /^\/sandbox\/[A-Za-z0-9_-]+$/);
  assert.equal(snapshot.activeView?.spec.elements.preview?.props.viewport, "mobile");

  const activeView = snapshot.activeView!;
  const ackPromise = nextMessage(socket);
  socket.send(
    JSON.stringify({
      type: "action",
      eventId: "mixed-event-1",
      viewId: activeView.id,
      revision: activeView.revision,
      requestId: activeView.requestId,
      action: "submit",
      params: { intent: "approve" },
      state: { form: { name: "Grace", approved: true } },
    }),
  );
  const ack = await ackPromise;
  assert.equal(ack.type, "ack");
  const result = await created.feedback!;
  assert.equal(result.status, "submitted");
  if (result.status === "submitted") {
    assert.deepEqual(result.params, { intent: "approve" });
    assert.deepEqual(result.state, { form: { name: "Grace", approved: true } });
  }
});

test("authenticated WebSocket submission resolves an interactive request", async (t) => {
  const { server, endpoint, staticDir } = await createTestServer();
  const socket = await openSocket(endpoint.port);
  t.after(async () => {
    socket.close();
    await server.stop("test complete");
    await rm(staticDir, { recursive: true, force: true });
  });

  const inputResultPromise = server.requestInput({
    title: "Profile",
    spec: formSpec,
    timeoutMs: 5_000,
  });

  const token = new URL(endpoint.fallbackUrl).hash.slice("#token=".length);
  socket.send(JSON.stringify({ type: "auth", token: decodeURIComponent(token) }));
  const authMessage = await nextMessage(socket);
  assert.equal(authMessage.type, "auth_ok");
  const snapshot = (authMessage as { type: "auth_ok"; snapshot: PortalSnapshot }).snapshot;
  assert.equal(snapshot.activeView?.interactive, true);
  assert.ok(snapshot.activeView?.requestId);
  assert.deepEqual(snapshot.activeView?.spec.state, formSpec.state);
  assert.deepEqual(snapshot.activeView?.state, formSpec.state);
  assert.deepEqual(snapshot.activeView?.spec.elements.submit?.on, {
    press: { action: "submit", params: { intent: "confirm-profile" } },
  });

  const activeView = snapshot.activeView!;
  const ackPromise = nextMessage(socket);
  socket.send(
    JSON.stringify({
      type: "action",
      eventId: "event-1",
      viewId: activeView.id,
      revision: activeView.revision,
      requestId: activeView.requestId,
      action: "submit",
      params: { intent: "confirm-profile" },
      state: { form: { name: "Grace" } },
    }),
  );

  const ack = await ackPromise;
  assert.equal(ack.type, "ack");
  if (ack.type === "ack") assert.equal(ack.ok, true);

  const result = await inputResultPromise;
  assert.equal(result.status, "submitted");
  if (result.status === "submitted") {
    assert.deepEqual(result.state, { form: { name: "Grace" } });
    assert.deepEqual(result.params, { intent: "confirm-profile" });
  }
});
