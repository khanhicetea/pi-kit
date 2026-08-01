import { useId } from "react";

const SERIES_COLORS = ["#7c3aed", "#2563eb", "#16a34a", "#ea580c", "#db2777", "#0891b2", "#ca8a04", "#64748b"];
const CHART_WIDTH = 640;
const CHART_HEIGHT = 240;
const PADDING = { top: 14, right: 16, bottom: 34, left: 44 };

interface SeriesItem {
  name: string;
  values: number[];
  color?: string | null | undefined;
}

interface SeriesChartProps {
  title?: string | null | undefined;
  labels: string[];
  series: SeriesItem[];
  showLegend?: boolean | null | undefined;
}

interface DonutChartProps {
  title?: string | null | undefined;
  centerLabel?: string | null | undefined;
  items: Array<{ label: string; value: number; color?: string | null | undefined }>;
}

interface SparklineProps {
  label?: string | null | undefined;
  value?: string | number | null | undefined;
  values: number[];
  color?: string | null | undefined;
}

function safeChartColor(color: string | null | undefined, index: number): string {
  return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : SERIES_COLORS[index % SERIES_COLORS.length]!;
}

function extent(values: number[]): { minimum: number; maximum: number } {
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  return minimum === maximum ? { minimum: minimum - 1, maximum: maximum + 1 } : { minimum, maximum };
}

function linePath(values: number[], x: (index: number) => number, y: (value: number) => number): string {
  return values
    .map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(2)},${y(value).toFixed(2)}`)
    .join(" ");
}

function SeriesChart({ props, area }: { props: SeriesChartProps; area: boolean }) {
  const gradientPrefix = useId().replace(/:/g, "");
  const values = props.series.flatMap((series) => series.values);
  const { minimum, maximum } = extent(values);
  const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;
  const x = (index: number) =>
    PADDING.left + (props.labels.length === 1 ? plotWidth / 2 : (index / (props.labels.length - 1)) * plotWidth);
  const y = (value: number) => PADDING.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
  const baseline = y(0);
  const labelStep = Math.max(1, Math.ceil(props.labels.length / 6));
  const kind = area ? "Area" : "Line";

  return (
    <figure className="jr-chart">
      {props.title && <figcaption>{props.title}</figcaption>}
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="img"
        aria-label={`${kind} chart${props.title ? `: ${props.title}` : ""}`}
      >
        <line
          className="jr-chart-axis"
          x1={PADDING.left}
          x2={CHART_WIDTH - PADDING.right}
          y1={baseline}
          y2={baseline}
        />
        <text className="jr-chart-axis-label" x={PADDING.left - 8} y={PADDING.top + 4} textAnchor="end">
          {maximum}
        </text>
        <text
          className="jr-chart-axis-label"
          x={PADDING.left - 8}
          y={CHART_HEIGHT - PADDING.bottom + 4}
          textAnchor="end"
        >
          {minimum}
        </text>
        {props.labels.map(
          (label, index) =>
            (index % labelStep === 0 || index === props.labels.length - 1) && (
              <text
                className="jr-chart-axis-label"
                x={x(index)}
                y={CHART_HEIGHT - 10}
                textAnchor="middle"
                key={`${label}-${index}`}
              >
                {label}
              </text>
            ),
        )}
        {props.series.map((series, index) => {
          const color = safeChartColor(series.color, index);
          const path = linePath(series.values, x, y);
          const gradientId = `${gradientPrefix}-${index}`;
          return (
            <g key={`${series.name}-${index}`}>
              {area && (
                <>
                  <defs>
                    <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor={color} stopOpacity="0.34" />
                      <stop offset="100%" stopColor={color} stopOpacity="0.04" />
                    </linearGradient>
                  </defs>
                  <path
                    d={`${path} L${x(series.values.length - 1)},${baseline} L${x(0)},${baseline} Z`}
                    fill={`url(#${gradientId})`}
                  />
                </>
              )}
              <path d={path} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
              {series.values.map((value, pointIndex) => (
                <circle cx={x(pointIndex)} cy={y(value)} fill={color} r="3.5" key={pointIndex} />
              ))}
            </g>
          );
        })}
      </svg>
      {props.showLegend !== false && (
        <ul className="jr-chart-legend">
          {props.series.map((series, index) => (
            <li key={`${series.name}-${index}`}>
              <span style={{ backgroundColor: safeChartColor(series.color, index) }} />
              {series.name}
            </li>
          ))}
        </ul>
      )}
      <table className="jr-visually-hidden">
        <caption>{props.title ?? `${kind} chart data`}</caption>
        <thead>
          <tr>
            <th>Label</th>
            {props.series.map((series) => (
              <th key={series.name}>{series.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.labels.map((label, index) => (
            <tr key={`${label}-${index}`}>
              <th>{label}</th>
              {props.series.map((series) => (
                <td key={series.name}>{series.values[index]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function LineChart({ props }: { props: SeriesChartProps }) {
  return <SeriesChart props={props} area={false} />;
}

export function AreaChart({ props }: { props: SeriesChartProps }) {
  return <SeriesChart props={props} area />;
}

export function DonutChart({ props }: { props: DonutChartProps }) {
  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  const total = props.items.reduce((sum, item) => sum + item.value, 0);
  let offset = 0;

  return (
    <figure className="jr-chart jr-donut-chart">
      {props.title && <figcaption>{props.title}</figcaption>}
      <div className="jr-donut-layout">
        <svg viewBox="0 0 200 200" role="img" aria-label={`Donut chart${props.title ? `: ${props.title}` : ""}`}>
          <circle className="jr-donut-track" cx="100" cy="100" fill="none" r={radius} strokeWidth="28" />
          {props.items.map((item, index) => {
            const length = total > 0 ? (item.value / total) * circumference : 0;
            const currentOffset = offset;
            offset += length;
            return (
              <circle
                cx="100"
                cy="100"
                fill="none"
                key={`${item.label}-${index}`}
                r={radius}
                stroke={safeChartColor(item.color, index)}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-currentOffset}
                strokeWidth="28"
                transform="rotate(-90 100 100)"
              />
            );
          })}
          <text className="jr-donut-label" x="100" y="105" textAnchor="middle">
            {props.centerLabel ?? total}
          </text>
        </svg>
        <ul className="jr-chart-legend jr-chart-legend--vertical">
          {props.items.map((item, index) => (
            <li key={`${item.label}-${index}`}>
              <span style={{ backgroundColor: safeChartColor(item.color, index) }} />
              <span>{item.label}</span>
              <strong>
                {item.value}
                {total > 0 ? ` · ${Math.round((item.value / total) * 100)}%` : ""}
              </strong>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

export function Sparkline({ props }: { props: SparklineProps }) {
  const width = 180;
  const height = 54;
  const padding = 4;
  const { minimum, maximum } = extent(props.values);
  const x = (index: number) => padding + (index / (props.values.length - 1)) * (width - padding * 2);
  const y = (value: number) => padding + ((maximum - value) / (maximum - minimum)) * (height - padding * 2);
  const color = safeChartColor(props.color, 0);
  const path = linePath(props.values, x, y);

  return (
    <figure className="jr-sparkline">
      {(props.label || (props.value !== null && props.value !== undefined)) && (
        <figcaption>
          <span>{props.label}</span>
          {props.value !== null && props.value !== undefined && <strong>{props.value}</strong>}
        </figcaption>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Sparkline${props.label ? `: ${props.label}` : ""}`}
      >
        <path d={path} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
        <circle cx={x(props.values.length - 1)} cy={y(props.values.at(-1)!)} fill={color} r="4" />
      </svg>
      <span className="jr-visually-hidden">Values: {props.values.join(", ")}</span>
    </figure>
  );
}
