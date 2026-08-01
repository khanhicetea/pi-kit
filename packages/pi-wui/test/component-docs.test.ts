import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWuiSpec, wuiCatalog } from "../src/shared/catalog";
import { getComponentDocumentation, listCatalogComponents } from "../src/shared/component-docs";

const chartElements = {
  line: {
    type: "LineChart",
    props: {
      title: "Traffic",
      labels: ["Mon", "Tue", "Wed"],
      series: [{ name: "Visits", values: [10, 18, 14], color: "#7c3aed" }],
    },
    children: [],
  },
  area: {
    type: "AreaChart",
    props: {
      labels: ["Mon", "Tue", "Wed"],
      series: [{ name: "Tokens", values: [20, 32, 28] }],
      showLegend: false,
    },
    children: [],
  },
  donut: {
    type: "DonutChart",
    props: {
      centerLabel: "100%",
      items: [
        { label: "Complete", value: 8 },
        { label: "Pending", value: 2 },
      ],
    },
    children: [],
  },
  sparkline: {
    type: "Sparkline",
    props: { label: "Latency", value: "84 ms", values: [110, 96, 102, 84] },
    children: [],
  },
};

test("catalog validates line, area, donut, and sparkline charts", () => {
  for (const [root, element] of Object.entries(chartElements)) {
    const spec = normalizeWuiSpec({ root, state: {}, elements: { [root]: element } });
    assert.equal(wuiCatalog.validate(spec).success, true, `${element.type} should validate`);
  }

  const invalidLine = structuredClone(chartElements.line);
  invalidLine.props.series[0]!.values.pop();
  const result = wuiCatalog.data.components.LineChart.props.safeParse(invalidLine.props);
  assert.equal(result.success, false);
});

test("targeted component discovery returns exact schemas and a common-component index", () => {
  const index = listCatalogComponents();
  assert.ok(index.common.includes("LineChart"));
  assert.ok(index.lessCommon.includes("Dialog"));
  assert.equal(index.common.includes("Dialog"), false);

  const [dialog, line] = getComponentDocumentation(["Dialog", "LineChart"]);
  assert.ok(dialog);
  assert.ok(line);
  assert.equal(dialog.name, "Dialog");
  assert.equal(dialog.common, false);
  assert.deepEqual(dialog.events, []);
  assert.equal((dialog.props as { type?: string }).type, "object");
  assert.equal(line.common, true);
  assert.deepEqual((line.example as { labels?: string[] }).labels, ["Mon", "Tue", "Wed"]);

  assert.throws(() => getComponentDocumentation(["MadeUpComponent"]), /Unknown WUI component/);
});
