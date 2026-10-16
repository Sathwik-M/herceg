<!-- Layouts of panels, the README's and others the tests pick by `shape`. -->
<script lang="ts">
  import type { ChartError, Chart as HercegChart, Table } from "herceg";
  import { Legend } from "../src/guides.js";
  import { Bar, Chart, Line, Pie, Rule } from "../src/index.js";
  import { Cell, Columns, Grid, Inset, Panel, Rows } from "../src/layout.js";

  type Data = Table<{
    time: "number";
    p99: "number";
    errors: "number";
    requests: "number";
    region: "category";
  }>;
  let {
    data,
    shape,
    chart = $bindable(null),
    heard,
  }: {
    data: Data;
    shape: "readme" | "grid" | "inset" | "weights" | "stray" | "conflict" | "nested" | "twice";
    chart?: HercegChart | null;
    heard?: (error: ChartError) => void;
  } = $props();
</script>

<Chart bind:chart height={700} onerror={heard}>
  {#if shape === "readme"}
    <Columns weights={[2, 1]}>
      <Rows weights={[2, 1]}>
        <Panel id="latency" title="p99">
          <Line {data} x="time" y="p99" color="region" />
        </Panel>
        <Panel id="errors" title="Errors">
          <Bar {data} x="time" y="errors" color="region" />
        </Panel>
      </Rows>
      <Panel id="share" title="By region">
        <Pie {data} category="region" value="requests" />
      </Panel>
    </Columns>
  {:else if shape === "grid"}
    <Grid rows={[1, 1]} columns={[2, 1]}>
      {#each ["a", "b"] as id, k (id)}
        <Cell row={k} column={0}>
          <Panel {id}><Line {data} x="time" y="p99" /></Panel>
        </Cell>
      {/each}
      <Cell row={0} column={1} rowSpan={2}>
        <Panel id="c"><Line {data} x="time" y="requests" /></Panel>
      </Cell>
    </Grid>
  {:else if shape === "inset"}
    <Rows>
      <Panel id="latency">
        <Line {data} x="time" y="p99" color="region" />
        <Legend place={{ inside: "top-left" }} />
        <Inset id="detail" x={{ domain: [0, 1] }} indicator>
          <Line {data} x="time" y="p99" color="region" />
        </Inset>
      </Panel>
      <Panel>
        <Line {data} x="time" y="errors" color="region" />
        <Rule y={3} />
      </Panel>
    </Rows>
  {:else if shape === "weights"}
    <Columns weights={[1, 2]}>
      <Panel id="a"><Line {data} x="time" y="p99" /></Panel>
    </Columns>
  {:else if shape === "stray"}
    <Rows>
      <Line {data} x="time" y="p99" />
      <Panel id="a"><Line {data} x="time" y="p99" /></Panel>
    </Rows>
  {:else if shape === "conflict"}
    <Panel id="a"><Line {data} x="time" y="p99" panel="b" /></Panel>
  {:else if shape === "twice"}
    <Columns>
      <Panel><Line {data} x="time" y="p99" /></Panel>
      <Panel id="panel-1"><Line {data} x="time" y="p99" /></Panel>
    </Columns>
  {:else}
    <Panel id="a">
      <Columns><Panel id="b"><Line {data} x="time" y="p99" /></Panel></Columns>
    </Panel>
  {/if}
</Chart>
