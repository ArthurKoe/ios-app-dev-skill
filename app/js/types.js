// Shared JSDoc typedefs (see docs/ARCHITECTURE.md). This module exports nothing at runtime.

/** @typedef {{lat:number, lon:number, widthKm:number, heightKm:number, rotationDeg:number}} Frame */
/** @typedef {{nx:number, ny:number, z:Float32Array}} Grid */
/** @typedef {{positions:Float32Array, indices:Uint32Array}} Mesh */
/**
 * @typedef {{
 *   cols:number, rows:number, tileW:number, tileH:number, artW:number, artH:number,
 *   scaleMPerMm:number, scaleDenominator:number,
 *   spx:number, spy:number, nx:number, ny:number, dx:number, dy:number,
 *   fitsBed:boolean, rotateOnBed:boolean, warnings:string[]
 * }} Layout
 */
/**
 * @typedef {{
 *   floorM:number, mmPerM:number, baseMm:number, exaggeration:number,
 *   minElevM:number, maxElevM:number, maxZMm:number
 * }} ZMap
 */
/**
 * @typedef {{
 *   label:string, row:number, col:number, x0:number, y0:number, widthMm:number, heightMm:number,
 *   top:Grid, water?:Uint8Array, bottom:Grid|null
 * }} TileField
 */
/**
 * @typedef {{filamentId:string, zFrom:number, zTo:number, layerFrom:number, elevFromM:number|null,
 *   color:string, finish:string, name:string}} ResolvedBand
 */

export {};
