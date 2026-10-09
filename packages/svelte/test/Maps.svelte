<script lang="ts">
  import type { Table } from "herceg";
  import { Chart, GeoPoint, GeoShape } from "../src/index.js";

  let {
    regions,
    places,
  }: {
    regions: Table<{ name: "category"; gdp: "number"; shape: "geometry" }>;
    places: Table<{ lon: "number"; lat: "number" }>;
  } = $props();
</script>

<Chart projection="mercator" locale="en-US">
  <GeoShape data={regions} name="name" color="gdp" />
  <GeoPoint data={places} longitude="lon" latitude="lat" />
</Chart>
