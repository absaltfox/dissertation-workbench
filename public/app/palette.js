// Categorical colours for research-area bands (up to 15). Index = band position.
// Ordered so neighbouring bands (which sit next to each other in the Topic
// Evolution sankey) are maximally distinct under normal vision and protan/deutan
// CVD; validated with the dataviz validate_palette.js on the app's light surface.
// Beyond ~8 hues colour alone cannot carry identity: the chart also shows
// direct labels and a legend. The app has a single (light) theme.
export const BAND_PALETTE = [
  '#eb6834', '#00a5c8', '#e34948', '#3d4fb8', '#1baf7a',
  '#6250d6', '#b5651d', '#2a78d6', '#5a8f29', '#a8559c',
  '#eda100', '#008300', '#e87ba4', '#8a8a00', '#d4478f',
];
