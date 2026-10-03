// Help dialog: the workflow in short and the printing concepts behind the settings.

import { createDialog } from './dialog.js';
import { h } from './dom.js';

const TOPICS = [
  ['1 · Choose a place', 'Pick a region with stored high-resolution data (Copernicus 30 m) or “Anywhere on Earth” for live data. Drag the frame on the map: move it, pull a corner to resize, use the round handle to rotate.'],
  ['2 · Split into tiles', 'Pick your printer and the tile grid. Every tile fits your bed; together they form the artwork. Neighbouring tiles share their edge samples, so the terrain continues seamlessly across the joints.'],
  ['Vertical exaggeration', 'At map scale mountains are almost flat. Exaggeration multiplies all heights – whole ranges need a lot, a single massif little or none. “Automatic” (on by default) picks the factor that makes the highest summit stand your target height (30 mm) above the base, so every area prints at a sensible height; the factor in use is shown under Relief and in the status bar.'],
  ['Height & printer', 'If the tallest point gets higher than your printer can print, the status bar and the Printer section warn you – lower the target relief or the exaggeration.'],
  ['Base & floor', 'The base is the solid plate under the lowest point. The floor is the elevation that sits right on top of the base: “Auto” starts just below the lowest point of the frame.'],
  ['Colour changes at layer heights', 'With elevation bands the slicer pauses at fixed layers to swap filament. Because all tiles share one height scale, the same layer list works for every tile – it is in the print plan.'],
  ['Art styles', 'Classic is a faithful relief. Terraced, Low-poly, Ridgelines, Hex columns and Contours are stylised; Lithophane is a thin panel that shows a shaded relief when backlit.'],
  ['Printing', 'Print every tile face up without supports, with elephant-foot compensation and the same filament batch. Labels on the back tell you where each tile goes (A1 = top-left).'],
  ['Keyboard', '?: help · 1/2/3: split / map / 3D view · Ctrl+S: save project · Double-click the 3D view: reset the camera.'],
];

/**
 * Creates the help dialog.
 * @returns {{open:()=>void}}
 */
export function createHelpDialog() {
  const body = h('div', { class: 'help' },
    h('p', { class: 'help-lead' }, 'Relief Studio turns elevation data into a tiled relief you can print on any 3D printer and assemble into a piece of wall art.'),
    h('dl', { class: 'help-topics' }, TOPICS.map(([title, text]) => [h('dt', null, title), h('dd', null, text)])),
    h('p', { class: 'hint' }, 'Elevation data: Copernicus DEM GLO-30/GLO-90 (© DLR e.V., © Airbus Defence and Space GmbH, provided under COPERNICUS by the EU and ESA) and AWS Terrain Tiles. Map tiles © OpenStreetMap contributors, OpenTopoMap, Esri.'));
  const dialog = createDialog({ title: 'How Relief Studio works', body, className: 'dialog-wide' });
  return { open: () => dialog.open() };
}
