// Categorical colours for research-area bands (up to 15). Index = band position.
// Ordered so neighbouring bands (which sit next to each other in the Topic
// Evolution sankey) are maximally distinct under normal vision and protan/deutan
// CVD; validated with the dataviz validate_palette.js on the app's light surface.
// Beyond ~8 hues colour alone cannot carry identity: the chart also shows
// direct labels and a legend. Validated as rendered: flows are drawn at
// FLOW_FILL_OPACITY over the light surface, so the effective (composited)
// colours were run through the validator, not just these hexes. The app has a single (light) theme.
export const BAND_PALETTE = [
  '#eb6834', '#00a5c8', '#e34948', '#3d4fb8', '#1baf7a',
  '#6250d6', '#b5651d', '#2a78d6', '#5a8f29', '#a8559c',
  '#d99200', '#008300', '#e87ba4', '#8a8a00', '#d4478f',
];

// Sankey flow fill opacity; the palette above is validated at this alpha over #fcfaf4.
export const FLOW_FILL_OPACITY = 0.85;
