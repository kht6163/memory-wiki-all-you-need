// cytoscape-fcose ships no types: a cytoscape extension registered with cytoscape.use().
declare module "cytoscape-fcose" {
  import type { Ext } from "cytoscape";
  const fcose: Ext;
  export default fcose;
}
