// cytoscape-fcose ships no types: a cytoscape extension registered with cytoscape.use().
declare module "cytoscape-fcose" {
  import type { Ext } from "cytoscape";
  const fcose: Ext;
  export default fcose;
}

// cytoscape-layout-utilities: fcose packs disconnected components only when it is registered.
declare module "cytoscape-layout-utilities" {
  import type { Ext } from "cytoscape";
  const layoutUtilities: Ext;
  export default layoutUtilities;
}
