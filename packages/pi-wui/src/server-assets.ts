import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { isRecord } from "./shared/protocol";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_ASSET_VIEW_BYTES = 100 * 1024 * 1024;
const MAX_ASSET_SESSION_BYTES = 250 * 1024 * 1024;
export const MAX_ASSETS_PER_VIEW = 24;
const MAX_ASSET_DOCUMENTS = 504;
const MAX_BUNDLE_FILES = 500;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_HTML_DOCUMENTS = 40;

export const WUI_SAFE_WEB_ASSET_EXTENSIONS = [
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
  ".woff",
  ".woff2",
] as const;
const SAFE_WEB_ASSET_EXTENSIONS = new Set<string>(WUI_SAFE_WEB_ASSET_EXTENSIONS);
export const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export type HtmlPreviewViewport = "responsive" | "mobile" | "tablet" | "desktop";
export interface HtmlFilePreviewInput {
  path: string;
  webRoot?: string;
  title?: string;
  viewport?: HtmlPreviewViewport;
  height?: number;
  allowScripts?: boolean;
  cleanupSource?: boolean;
}
export interface AssetFileInput {
  id: string;
  path: string;
  cleanupSource?: boolean;
}
export interface UploadedAsset {
  path: string;
  filename: string;
  assetId: string;
}
export interface HtmlFileAttachmentInput extends HtmlFilePreviewInput {
  elementId?: string;
}

export interface StagedHtmlDocument {
  id: string;
  path: string;
  rootPath?: string;
  entryPath?: string;
  allowScripts: boolean;
  createdAt: number;
}
export interface StagedAssetDocument {
  id: string;
  path: string;
  filename: string;
  contentType: string;
  inline: boolean;
  size: number;
  createdAt: number;
}
export interface StagedHtml {
  preview: HtmlFilePreviewInput;
  sourcePath: string;
  sourceRoot?: string;
  document: StagedHtmlDocument;
}
export interface StagedAsset {
  asset: AssetFileInput;
  sourcePath: string;
  document: StagedAssetDocument;
}

export class AssetHtmlStager {
  readonly htmlDocuments = new Map<string, StagedHtmlDocument>();
  readonly assetDocuments = new Map<string, StagedAssetDocument>();
  readonly pendingAssetIds = new Set<string>();
  readonly viewAssetIds = new Map<string, Set<string>>();
  private htmlTempDir: string | undefined;
  private assetTempDir: string | undefined;

  constructor(
    private readonly cwd: string,
    private readonly warn: (message: string) => void,
  ) {}

  validateAssetInputs(assets: AssetFileInput[]): void {
    const ids = new Set<string>();
    for (const asset of assets) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(asset.id))
        throw new Error("Asset id must contain only letters, numbers, underscores, or dashes (max 64).");
      if (ids.has(asset.id)) throw new Error(`Duplicate asset id “${asset.id}”.`);
      ids.add(asset.id);
    }
  }

  async stageHtmlDocument(preview: HtmlFilePreviewInput): Promise<StagedHtml> {
    const requestedPath = resolve(this.cwd, preview.path.replace(/^@/, ""));
    const extension = extname(requestedPath).toLowerCase();
    if (extension !== ".html" && extension !== ".htm")
      throw new Error("HTML preview source must use an .html or .htm extension.");
    let sourcePath: string;
    let sourceStatus: Awaited<ReturnType<typeof stat>>;
    try {
      sourcePath = await realpath(requestedPath);
      sourceStatus = await stat(sourcePath);
    } catch {
      throw new Error(`HTML preview file was not found: ${requestedPath}`);
    }
    if (!sourceStatus.isFile()) throw new Error(`HTML preview file was not found: ${requestedPath}`);
    if (sourceStatus.size > MAX_HTML_BYTES) throw new Error(`HTML preview exceeds ${MAX_HTML_BYTES / 1024 / 1024}MB.`);

    this.htmlTempDir ??= await mkdtemp(join(tmpdir(), "pi-wui-html-"));
    const id = randomBytes(18).toString("base64url");
    let stagedPath: string;
    let sourceRoot: string | undefined;
    let stagedRoot: string | undefined;
    let entryPath: string | undefined;
    if (preview.webRoot) {
      const requestedRoot = resolve(this.cwd, preview.webRoot.replace(/^@/, ""));
      try {
        sourceRoot = await realpath(requestedRoot);
      } catch {
        throw new Error(`HTML preview webRoot was not found: ${requestedRoot}`);
      }
      if (!(await stat(sourceRoot)).isDirectory())
        throw new Error(`HTML preview webRoot was not found: ${requestedRoot}`);
      if (!isPathInside(sourceRoot, sourcePath)) throw new Error("HTML preview entry must be inside webRoot.");
      entryPath = relative(sourceRoot, sourcePath);
      if (entryPath.split(sep).some((part) => part.startsWith(".")))
        throw new Error("HTML preview entry cannot be inside a hidden directory.");
      const temporaryRoot = await realpath(tmpdir());
      if (preview.cleanupSource && (sourceRoot === temporaryRoot || !isPathInside(temporaryRoot, sourceRoot))) {
        throw new Error(
          "cleanupSource for an HTML webRoot is only allowed for a child directory of the system temporary directory.",
        );
      }
      stagedRoot = join(this.htmlTempDir, id);
      await this.copyHtmlBundle(sourceRoot, stagedRoot);
      stagedPath = join(stagedRoot, entryPath);
      try {
        await stat(stagedPath);
      } catch {
        await rm(stagedRoot, { recursive: true, force: true });
        throw new Error("HTML preview entry was excluded from its staged webRoot.");
      }
    } else {
      stagedPath = join(this.htmlTempDir, `${id}.html`);
      await copyFile(sourcePath, stagedPath);
    }
    const document: StagedHtmlDocument = {
      id,
      path: stagedPath,
      ...(stagedRoot ? { rootPath: stagedRoot } : {}),
      ...(entryPath ? { entryPath } : {}),
      allowScripts: preview.allowScripts === true,
      createdAt: Date.now(),
    };
    this.htmlDocuments.set(id, document);
    return { preview, sourcePath, ...(sourceRoot ? { sourceRoot } : {}), document };
  }

  private async copyHtmlBundle(sourceRoot: string, destinationRoot: string): Promise<void> {
    let fileCount = 0;
    let totalBytes = 0;
    const copyDirectory = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
      await mkdir(destinationDirectory, { recursive: true });
      for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const sourcePath = join(sourceDirectory, entry.name);
        const destinationPath = join(destinationDirectory, entry.name);
        const status = await lstat(sourcePath);
        if (status.isSymbolicLink()) throw new Error(`HTML webRoot cannot contain symlinks: ${sourcePath}`);
        if (status.isDirectory()) {
          await copyDirectory(sourcePath, destinationPath);
          continue;
        }
        if (!status.isFile()) continue;
        fileCount += 1;
        totalBytes += status.size;
        if (fileCount > MAX_BUNDLE_FILES) throw new Error(`HTML webRoot contains more than ${MAX_BUNDLE_FILES} files.`);
        if (totalBytes > MAX_BUNDLE_BYTES) throw new Error(`HTML webRoot exceeds ${MAX_BUNDLE_BYTES / 1024 / 1024}MB.`);
        await copyFile(sourcePath, destinationPath);
      }
    };
    try {
      await copyDirectory(sourceRoot, destinationRoot);
    } catch (error) {
      await rm(destinationRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async stageAssetDocument(asset: AssetFileInput): Promise<StagedAsset> {
    const requestedPath = resolve(this.cwd, asset.path.replace(/^@/, ""));
    let sourcePath: string;
    let status: Awaited<ReturnType<typeof stat>>;
    try {
      sourcePath = await realpath(requestedPath);
      status = await stat(sourcePath);
    } catch {
      throw new Error(`Asset file was not found: ${requestedPath}`);
    }
    if (!status.isFile()) throw new Error(`Asset file was not found: ${requestedPath}`);
    if (status.size > MAX_ASSET_BYTES)
      throw new Error(`Asset “${asset.id}” exceeds ${MAX_ASSET_BYTES / 1024 / 1024}MB.`);
    if (asset.cleanupSource && !isPathInside(await realpath(tmpdir()), sourcePath))
      throw new Error("cleanupSource for an asset is only allowed inside the system temporary directory.");
    if (this.assetDocuments.size >= MAX_ASSET_DOCUMENTS)
      throw new Error("The Web UI session has too many staged assets. Replace or prune older views first.");
    const sessionBytes = [...this.assetDocuments.values()].reduce((total, document) => total + document.size, 0);
    if (sessionBytes + status.size > MAX_ASSET_SESSION_BYTES)
      throw new Error(`Staged assets for the session exceed ${MAX_ASSET_SESSION_BYTES / 1024 / 1024}MB.`);
    const filename = basename(sourcePath);
    if (!filename || /[\u0000-\u001f\u007f]/.test(filename))
      throw new Error(`Asset “${asset.id}” has an unsafe filename.`);
    const extension = extname(filename).toLowerCase();
    if (!SAFE_WEB_ASSET_EXTENSIONS.has(extension))
      throw new Error(
        `Asset “${asset.id}” must use a safe web extension: ${WUI_SAFE_WEB_ASSET_EXTENSIONS.join(", ")}.`,
      );
    this.assetTempDir ??= await mkdtemp(join(tmpdir(), "pi-wui-assets-"));
    const id = randomBytes(18).toString("base64url");
    const stagedPath = join(this.assetTempDir, id);
    await copyFile(sourcePath, stagedPath);
    const document: StagedAssetDocument = {
      id,
      path: stagedPath,
      filename,
      contentType: MIME_TYPES[extension]!,
      inline: true,
      size: status.size,
      createdAt: Date.now(),
    };
    this.assetDocuments.set(id, document);
    return { asset, sourcePath, document };
  }

  resolveAssetReferences(
    sourceSpec: unknown,
    declaredAssets: Map<string, StagedAssetDocument>,
  ): { spec: unknown; documentIds: Set<string> } {
    const spec = structuredClone(sourceSpec);
    const documentIds = new Set<string>();
    const visit = (value: unknown): unknown => {
      if (typeof value === "string" && value.startsWith("asset://")) {
        const match = value.match(/^asset:\/\/([A-Za-z0-9_-]{1,64})$/);
        if (!match) throw new Error(`Invalid asset reference “${value}”. Use asset://<id>.`);
        const reference = match[1]!;
        const document = declaredAssets.get(reference) ?? this.assetDocuments.get(reference);
        if (!document) throw new Error(`Unknown asset id “${reference}”.`);
        documentIds.add(document.id);
        return this.assetUrl(document);
      }
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === "object")
        for (const [key, child] of Object.entries(value as Record<string, unknown>))
          (value as Record<string, unknown>)[key] = visit(child);
      return value;
    };
    return { spec: visit(spec), documentIds };
  }

  createHtmlOnlySpec(
    title: string,
    previews: HtmlFileAttachmentInput[],
    staged: StagedHtml[],
    requestedColumns?: number,
  ): unknown {
    const columns = requestedColumns ?? Math.min(previews.length, 4);
    if (!Number.isInteger(columns) || columns < 1 || columns > 6)
      throw new Error("HTML preview columns must be an integer from 1 to 6.");
    const elements: Record<string, Record<string, unknown>> = {};
    const previewKeys = previews.map((preview, index) => {
      const key = previews.length === 1 ? "html-preview" : `html-preview-${index + 1}`;
      const item = staged[index];
      if (!item) throw new Error("HTML preview staging failed.");
      elements[key] = {
        type: "HtmlPreview",
        props: this.htmlPreviewProps(
          preview,
          item.document,
          preview.title ?? (previews.length === 1 ? title : `${title} ${index + 1}`),
        ),
        children: [],
      };
      return key;
    });
    const root = previews.length === 1 ? previewKeys[0]! : "html-preview-grid";
    if (previews.length > 1) elements[root] = { type: "Grid", props: { columns, gap: "md" }, children: previewKeys };
    return { root, state: {}, elements };
  }

  attachHtmlDocuments(sourceSpec: unknown, previews: HtmlFileAttachmentInput[], staged: StagedHtml[]): unknown {
    const spec = structuredClone(sourceSpec);
    if (previews.length === 0) return spec;
    if (!isRecord(spec) || !isRecord(spec.elements))
      throw new Error("A mixed Web UI view requires a json-render spec with elements.");
    const elements = spec.elements as Record<string, unknown>;
    previews.forEach((preview, index) => {
      if (!preview.elementId) throw new Error("Each html item must provide elementId when spec is also provided.");
      const element = elements[preview.elementId];
      if (!isRecord(element) || element.type !== "HtmlPreview")
        throw new Error(`HTML attachment element “${preview.elementId}” must be an HtmlPreview.`);
      const item = staged[index];
      if (!item) throw new Error("HTML preview staging failed.");
      const props = isRecord(element.props) ? element.props : {};
      element.props = this.htmlPreviewProps(
        {
          ...preview,
          ...(preview.viewport === undefined && typeof props.viewport === "string"
            ? { viewport: props.viewport as HtmlPreviewViewport }
            : {}),
          ...(preview.height === undefined && typeof props.height === "number" ? { height: props.height } : {}),
        },
        item.document,
        preview.title ?? (typeof props.title === "string" ? props.title : preview.elementId),
      );
    });
    return spec;
  }

  private htmlPreviewProps(
    preview: HtmlFilePreviewInput,
    document: StagedHtmlDocument,
    title: string,
  ): Record<string, unknown> {
    const viewport = preview.viewport ?? "responsive";
    const entrySuffix = document.entryPath ? `/${document.entryPath.split(sep).map(encodeURIComponent).join("/")}` : "";
    return {
      src: `/sandbox/${document.id}${entrySuffix}`,
      title,
      viewport,
      height: preview.height ?? (viewport === "mobile" ? 844 : 640),
      allowScripts: preview.allowScripts === true,
    };
  }

  assetUrl(document: StagedAssetDocument): string {
    return `/_wui/resource/${document.id}/${encodeURIComponent(document.filename)}`;
  }
  async cleanupHtmlSource(item: StagedHtml): Promise<void> {
    if (!item.preview.cleanupSource) return;
    try {
      await rm(item.sourceRoot ?? item.sourcePath, { recursive: Boolean(item.sourceRoot), force: true });
    } catch (error) {
      this.warn(`Could not clean up HTML source ${item.sourceRoot ?? item.sourcePath}: ${errorMessage(error)}`);
    }
  }
  async cleanupAssetSource(item: StagedAsset): Promise<void> {
    if (!item.asset.cleanupSource) return;
    try {
      await rm(item.sourcePath, { force: true });
    } catch (error) {
      this.warn(`Could not clean up asset source ${item.sourcePath}: ${errorMessage(error)}`);
    }
  }
  async deleteHtmlDocument(id: string): Promise<void> {
    const document = this.htmlDocuments.get(id);
    if (!document) return;
    this.htmlDocuments.delete(id);
    await rm(document.rootPath ?? document.path, { recursive: Boolean(document.rootPath), force: true });
  }
  async deleteAssetDocument(id: string): Promise<void> {
    const document = this.assetDocuments.get(id);
    if (!document) return;
    this.assetDocuments.delete(id);
    this.pendingAssetIds.delete(id);
    await rm(document.path, { force: true });
  }
  async pruneHtmlDocuments(referenced: Set<string>): Promise<void> {
    for (const id of [...this.htmlDocuments.keys()]) if (!referenced.has(id)) await this.deleteHtmlDocument(id);
    while (this.htmlDocuments.size > MAX_HTML_DOCUMENTS) {
      const oldest = [...this.htmlDocuments.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      await this.deleteHtmlDocument(oldest.id);
    }
  }
  async pruneAssetDocuments(): Promise<void> {
    const referenced = new Set(this.pendingAssetIds);
    for (const ids of this.viewAssetIds.values()) for (const id of ids) referenced.add(id);
    for (const id of [...this.assetDocuments.keys()]) if (!referenced.has(id)) await this.deleteAssetDocument(id);
  }
  async close(): Promise<void> {
    this.htmlDocuments.clear();
    this.assetDocuments.clear();
    this.pendingAssetIds.clear();
    this.viewAssetIds.clear();
    await Promise.all([
      this.htmlTempDir ? rm(this.htmlTempDir, { recursive: true, force: true }) : undefined,
      this.assetTempDir ? rm(this.assetTempDir, { recursive: true, force: true }) : undefined,
    ]);
    this.htmlTempDir = undefined;
    this.assetTempDir = undefined;
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  const a = resolve(root);
  const b = resolve(candidate);
  return b === a || b.startsWith(`${a}${sep}`);
}
export function streamFile(path: string) {
  return createReadStream(path);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
