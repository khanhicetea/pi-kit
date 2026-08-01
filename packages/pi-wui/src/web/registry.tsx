import type { StateModel } from "@json-render/core";
import { defineRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { wuiCatalog } from "../shared/catalog";
import { AreaChart, DonutChart, LineChart, Sparkline } from "./charts";

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeUrl(value: string, image = false): string | undefined {
  if (image && /^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(value)) return value;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin === window.location.origin) return url.href;
    if (url.protocol === "https:") return url.href;
    if (!image && (url.protocol === "http:" || url.protocol === "mailto:")) return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}

function safeMarkdownUrl(url: string): string {
  return safeUrl(url, /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url)) ?? defaultUrlTransform(url);
}

export const PORTAL_ACTION_EVENT = "pi-wui:action";

export interface PortalActionRequest {
  action: "submit" | "cancel";
  params: Record<string, unknown>;
  state: StateModel;
  handled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

function requestPortalAction(
  action: "submit" | "cancel",
  params: Record<string, unknown> | undefined,
  state: StateModel,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const detail: PortalActionRequest = {
      action,
      params: params ?? {},
      state,
      handled: false,
      resolve,
      reject,
    };
    window.dispatchEvent(new CustomEvent<PortalActionRequest>(PORTAL_ACTION_EVENT, { detail }));
    if (!detail.handled) reject(new Error("Web UI action bridge is not available."));
  });
}

export const { registry, handlers } = defineRegistry(wuiCatalog, {
  components: {
    ...shadcnComponents,
    // Keep URL-bearing components within the portal's protocol allowlist while
    // retaining the shadcn catalog shape and visual language.
    Image: ({ props }) => {
      const src = props.src ? safeUrl(props.src, true) : undefined;
      const width = props.width ? Math.max(1, Math.min(2_400, props.width)) : undefined;
      const height = props.height ? Math.max(1, Math.min(2_400, props.height)) : undefined;
      return src ? (
        <img
          src={src}
          alt={props.alt}
          width={width}
          height={height}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="max-h-[70vh] max-w-full rounded-lg border border-border object-contain"
        />
      ) : (
        <div
          className="grid place-items-center rounded-lg border border-dashed border-border bg-muted px-4 text-xs text-muted-foreground"
          style={{ width: width ?? 160, height: height ?? 100 }}
          role="img"
          aria-label={props.alt}
        >
          {props.src ? "Blocked unsafe image URL" : props.alt}
        </div>
      );
    },
    Avatar: ({ props }) => {
      const src = props.src ? safeUrl(props.src, true) : undefined;
      const initials = (props.name || "?")
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
      const size = props.size === "lg" ? "h-12 w-12" : props.size === "sm" ? "h-8 w-8" : "h-10 w-10";
      return (
        <span
          className={`${size} inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-xs font-semibold text-muted-foreground`}
          title={props.name}
        >
          {src ? (
            <img src={src} alt={props.name} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            initials
          )}
        </span>
      );
    },
    Link: ({ props, on }) => {
      const href = safeUrl(props.href);
      if (!href) return <span className="text-sm text-muted-foreground">{props.label} (unsafe URL blocked)</span>;
      const press = on("press");
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          onClick={(event) => {
            if (press.shouldPreventDefault) event.preventDefault();
            press.emit();
          }}
        >
          {props.label} <span aria-hidden="true">↗</span>
        </a>
      );
    },
    Markdown: ({ props }) => (
      <div className="jr-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          urlTransform={safeMarkdownUrl}
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
          }}
        >
          {props.content}
        </ReactMarkdown>
      </div>
    ),
    Code: ({ props }) => (
      <figure className="jr-code">
        {(props.filename || props.language) && <figcaption>{props.filename ?? props.language}</figcaption>}
        <pre>
          <code data-language={props.language ?? undefined}>{props.code}</code>
        </pre>
      </figure>
    ),
    HtmlPreview: ({ props }) => {
      const frameRef = useRef<HTMLIFrameElement>(null);
      const viewport = props.viewport ?? "responsive";
      const viewportWidth =
        viewport === "mobile" ? 390 : viewport === "tablet" ? 768 : viewport === "desktop" ? 1_280 : undefined;
      const height = props.height ?? (viewport === "mobile" ? 844 : 640);
      const postContent = useCallback(() => {
        if (!props.html) return;
        frameRef.current?.contentWindow?.postMessage(
          {
            type: "pi-wui:html-preview",
            html: props.html,
            title: props.title ?? "HTML preview",
            allowScripts: props.allowScripts === true,
          },
          "*",
        );
      }, [props.allowScripts, props.html, props.title]);

      useEffect(postContent, [postContent]);

      return (
        <figure className="jr-html-preview">
          <figcaption>
            <span>{props.title ?? "HTML preview"}</span>
            <span>
              {viewport} · sandboxed{props.allowScripts ? " · scripts on" : ""}
            </span>
          </figcaption>
          <div className="jr-html-preview-stage">
            <iframe
              ref={frameRef}
              src={props.src ?? "/sandbox"}
              title={props.title ?? "HTML preview"}
              sandbox={props.src && !props.allowScripts ? "" : "allow-scripts"}
              referrerPolicy="no-referrer"
              onLoad={postContent}
              style={{
                width: viewportWidth ? `${viewportWidth}px` : "100%",
                maxWidth: "100%",
                height: `${height}px`,
              }}
            />
          </div>
        </figure>
      );
    },
    Metric: ({ props }) => {
      const trendClass =
        props.trend === "up" ? "text-emerald-400" : props.trend === "down" ? "text-rose-400" : "text-muted-foreground";
      return (
        <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
          <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
          <strong className="text-2xl font-semibold tracking-tight">{displayValue(props.value)}</strong>
          {props.detail && (
            <span className={`text-xs ${trendClass}`}>
              {props.trend === "up" ? "↑ " : props.trend === "down" ? "↓ " : ""}
              {props.detail}
            </span>
          )}
        </div>
      );
    },
    KeyValue: ({ props }) => (
      <dl className="m-0 divide-y divide-border rounded-lg border border-border px-4">
        {props.items.map((item, index) => (
          <div className="grid grid-cols-[minmax(90px,0.6fr)_1fr] gap-5 py-2.5 text-sm" key={`${item.label}-${index}`}>
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd className="m-0 overflow-wrap-anywhere">{displayValue(item.value)}</dd>
          </div>
        ))}
      </dl>
    ),
    BarChart: ({ props }) => {
      const maximum = Math.max(1, ...props.items.map((item) => Math.abs(item.value)));
      return (
        <figure className="m-0 rounded-xl border border-border bg-card p-4 text-card-foreground">
          {props.title && <figcaption className="mb-4 text-sm font-semibold">{props.title}</figcaption>}
          <div className="flex flex-col gap-2.5">
            {props.items.map((item, index) => {
              const customColor = item.color && /^#[0-9a-f]{3,8}$/i.test(item.color) ? item.color : undefined;
              const style = {
                width: `${Math.max(2, (Math.abs(item.value) / maximum) * 100)}%`,
                ...(customColor ? { backgroundColor: customColor } : {}),
              } satisfies CSSProperties;
              return (
                <div
                  className="grid grid-cols-[minmax(70px,120px)_minmax(100px,1fr)_auto] items-center gap-2.5 text-xs"
                  key={`${item.label}-${index}`}
                >
                  <span className="truncate text-muted-foreground">{item.label}</span>
                  <span className="h-5 overflow-hidden rounded-md bg-muted">
                    <span className="block h-full rounded-md bg-primary" style={style} />
                  </span>
                  <strong>{item.value}</strong>
                </div>
              );
            })}
          </div>
        </figure>
      );
    },
    LineChart,
    AreaChart,
    DonutChart,
    Sparkline,
  },
  actions: {
    submit: async (params, _setState, state) => requestPortalAction("submit", params, state),
    cancel: async (params, _setState, state) => requestPortalAction("cancel", params, state),
  },
});
