import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EARTH_RADIUS, tmForward, tmInverse, frameLocalToLatLon, frameUVToLatLon, latLonToFrameUV,
  framePolygon, frameBounds, haversineKm, normalizeLon,
} from '../../app/js/core/projection.js';

const D2R = Math.PI / 180;

/** Initial great-circle bearing from point 1 to point 2, degrees clockwise from north (0..360). */
function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shoelace area with lon as x and lat as y; negative = clockwise on a north-up map. */
function signedArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [y1, x1] = ring[i];
    const [y2, x2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

test('EARTH_RADIUS is the IUGG mean radius', () => {
  assert.equal(EARTH_RADIUS, 6371008.8);
});

test('tmForward/tmInverse round-trip to < 1e-9 degrees in all hemispheres', () => {
  const origins = [[46, 10], [-33.9, 18.4], [35.36, 138.73], [-43.5, 170], [44.2, -110.7], [-13.25, -72.5], [0, 0], [68.2, 14.3], [-1.47, -78.82]];
  const rand = rng(7);
  let worst = 0;
  for (const [lat0, lon0] of origins) {
    for (let k = 0; k < 200; k++) {
      const lat = Math.max(-85, Math.min(85, lat0 + (rand() - 0.5) * 30));
      const lon = lon0 + (rand() - 0.5) * 30;
      const [x, y] = tmForward(lat, lon, lat0, lon0);
      const [lat2, lon2] = tmInverse(x, y, lat0, lon0);
      worst = Math.max(worst, Math.abs(lat2 - lat), Math.abs(lon2 - lon));
    }
  }
  assert.ok(worst < 1e-9, `worst round-trip error ${worst}`);
});

test('tmForward: origin maps to (0, 0); x east, y north; central meridian is true to scale', () => {
  const [x0, y0] = tmForward(-20, -60, -20, -60);
  assert.ok(Math.abs(x0) < 1e-9 && Math.abs(y0) < 1e-9);
  const [xe, ye] = tmForward(46, 10.1, 46, 10);
  assert.ok(xe > 7000 && Math.abs(ye) < 100, `east: ${xe}, ${ye}`);
  const [xn, yn] = tmForward(47, 10, 46, 10);
  assert.ok(Math.abs(xn) < 1e-6);
  assert.ok(Math.abs(yn - EARTH_RADIUS * D2R) < 1e-6, 'one degree of latitude along the central meridian');
});

test('tmInverse returns longitudes continuous around the central meridian', () => {
  const [lat, lon] = tmInverse(20000, 0, -40, 179.9);
  assert.ok(lon > 180, `expected an unwrapped longitude, got ${lon}`);
  assert.ok(Math.abs(lat + 40) < 0.01);
  assert.equal(normalizeLon(190), -170);
  assert.equal(normalizeLon(-180), -180);
  assert.equal(normalizeLon(180), -180);
  assert.equal(normalizeLon(-541), 179);
});

test('100 km wide frame at 46N measures ~100 km between the left/right edge midpoints', () => {
  for (const rotationDeg of [0, 30, 90, -135]) {
    const frame = { lat: 46, lon: 8, widthKm: 100, heightKm: 60, rotationDeg };
    const [la1, lo1] = frameUVToLatLon(frame, 0, 0.5);
    const [la2, lo2] = frameUVToLatLon(frame, 1, 0.5);
    const w = haversineKm(la1, lo1, la2, lo2);
    assert.ok(Math.abs(w - 100) / 100 < 0.002, `width ${w} km at rotation ${rotationDeg}`);
    const [la3, lo3] = frameUVToLatLon(frame, 0.5, 0);
    const [la4, lo4] = frameUVToLatLon(frame, 0.5, 1);
    const h = haversineKm(la3, lo3, la4, lo4);
    assert.ok(Math.abs(h - 60) / 60 < 0.002, `height ${h} km at rotation ${rotationDeg}`);
  }
});

test('frame centre is (lat, lon); top edge is north without rotation', () => {
  const frame = { lat: -28.75, lon: 29, widthKm: 60, heightKm: 45, rotationDeg: 0 };
  const [lat, lon] = frameUVToLatLon(frame, 0.5, 0.5);
  assert.ok(Math.abs(lat - frame.lat) < 1e-12 && Math.abs(lon - frame.lon) < 1e-12);
  const [latTop, lonTop] = frameUVToLatLon(frame, 0.5, 0);
  assert.ok(latTop > frame.lat && Math.abs(lonTop - frame.lon) < 1e-12);
  const [latL, lonL] = frameLocalToLatLon(frame, -30000, 0);
  assert.ok(lonL < frame.lon && Math.abs(latL - frame.lat) < 0.01);
});

test('rotationDeg is the clockwise bearing of frame-up (90 → up points east)', () => {
  for (const rotationDeg of [0, 45, 90, 180, 270, -30]) {
    const frame = { lat: 46, lon: 10, widthKm: 40, heightKm: 30, rotationDeg };
    const [lat, lon] = frameUVToLatLon(frame, 0.5, 0);
    const expected = ((rotationDeg % 360) + 360) % 360;
    let diff = Math.abs(bearingDeg(frame.lat, frame.lon, lat, lon) - expected);
    diff = Math.min(diff, 360 - diff);
    assert.ok(diff < 0.05, `rotation ${rotationDeg}: bearing off by ${diff}°`);
  }
  const frame = { lat: 46, lon: 10, widthKm: 40, heightKm: 30, rotationDeg: 90 };
  const [latUp, lonUp] = frameUVToLatLon(frame, 0.5, 0);
  assert.ok(lonUp > frame.lon && Math.abs(latUp - frame.lat) < 0.01, 'up is east');
  const [latRight, lonRight] = frameUVToLatLon(frame, 1, 0.5);
  assert.ok(latRight < frame.lat && Math.abs(lonRight - frame.lon) < 1e-9, 'right is south');
});

test('latLonToFrameUV inverts frameUVToLatLon', () => {
  const rand = rng(11);
  const frames = [
    { lat: 45.95, lon: 10.75, widthKm: 900, heightKm: 450, rotationDeg: 0 },
    { lat: -34.15, lon: 18.43, widthKm: 45, heightKm: 60, rotationDeg: 33 },
    { lat: 56.75, lon: -5, widthKm: 50, heightKm: 40, rotationDeg: -120 },
    { lat: -43.5, lon: 179.8, widthKm: 80, heightKm: 60, rotationDeg: 270 },
  ];
  for (const frame of frames) {
    for (let k = 0; k < 100; k++) {
      const u = rand() * 1.4 - 0.2;
      const v = rand() * 1.4 - 0.2;
      const [lat, lon] = frameUVToLatLon(frame, u, v);
      const [u2, v2] = latLonToFrameUV(frame, lat, lon);
      assert.ok(Math.abs(u2 - u) < 1e-9 && Math.abs(v2 - v) < 1e-9, `(${u}, ${v}) → (${u2}, ${v2})`);
    }
  }
});

test('framePolygon is a clockwise ring starting at the top-left corner, not closed', () => {
  for (const rotationDeg of [0, 25, 90, 200]) {
    const frame = { lat: 46.5, lon: 8.3, widthKm: 300, heightKm: 180, rotationDeg };
    const ring = framePolygon(frame);
    assert.equal(ring.length, 64);
    assert.deepEqual(ring[0], frameUVToLatLon(frame, 0, 0));
    assert.deepEqual(ring[16], frameUVToLatLon(frame, 1, 0));
    assert.deepEqual(ring[32], frameUVToLatLon(frame, 1, 1));
    assert.deepEqual(ring[48], frameUVToLatLon(frame, 0, 1));
    assert.notDeepEqual(ring[ring.length - 1], ring[0]);
    assert.ok(signedArea(ring) < 0, `ring must be clockwise at rotation ${rotationDeg}`);
    for (const [lat, lon] of ring) {
      const [u, v] = latLonToFrameUV(frame, lat, lon);
      const onEdge = Math.min(Math.abs(u), Math.abs(u - 1), Math.abs(v), Math.abs(v - 1));
      assert.ok(onEdge < 1e-9, 'every point lies on the frame outline');
    }
  }
  assert.equal(framePolygon({ lat: 0, lon: 0, widthKm: 10, heightKm: 10, rotationDeg: 0 }, 3).length, 12);
});

test('frameBounds contains the frame polygon and is tight', () => {
  const frames = [
    { lat: 45.95, lon: 10.75, widthKm: 900, heightKm: 450, rotationDeg: 0 },
    { lat: 46.5, lon: 8.3, widthKm: 300, heightKm: 180, rotationDeg: 25 },
    { lat: -28.75, lon: 29, widthKm: 60, heightKm: 45, rotationDeg: -70 },
    { lat: 68.2, lon: 14.3, widthKm: 90, heightKm: 50, rotationDeg: 135 },
  ];
  for (const frame of frames) {
    const b = frameBounds(frame);
    assert.ok(b.south < frame.lat && frame.lat < b.north && b.west < frame.lon && frame.lon < b.east);
    for (const segments of [16, 64]) {
      for (const [lat, lon] of framePolygon(frame, segments)) {
        assert.ok(lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east);
      }
    }
    // a very dense outline stays inside to well below a metre
    for (const [lat, lon] of framePolygon(frame, 1000)) {
      assert.ok(lat >= b.south - 1e-5 && lat <= b.north + 1e-5 && lon >= b.west - 1e-5 && lon <= b.east + 1e-5);
    }
    const ring = framePolygon(frame, 64);
    assert.equal(b.north, Math.max(...ring.map((p) => p[0])));
    assert.equal(b.west, Math.min(...ring.map((p) => p[1])));
  }
  // the top edge of an unrotated TM frame bulges north at its midpoint
  const wide = { lat: 46, lon: 10, widthKm: 900, heightKm: 400, rotationDeg: 0 };
  assert.equal(frameBounds(wide).north, frameUVToLatLon(wide, 0.5, 0)[0]);
});

test('frameBounds near the antimeridian stays continuous', () => {
  const b = frameBounds({ lat: -16, lon: 179.9, widthKm: 60, heightKm: 40, rotationDeg: 0 });
  assert.ok(b.west < 180 && b.east > 180 && b.east - b.west < 1);
});

test('haversineKm', () => {
  assert.equal(haversineKm(10, 20, 10, 20), 0);
  const deg = haversineKm(0, 0, 1, 0);
  assert.ok(Math.abs(deg - (EARTH_RADIUS / 1000) * D2R) < 1e-9);
  // Zurich → Milan ≈ 218 km
  const zm = haversineKm(47.3769, 8.5417, 45.4642, 9.19);
  assert.ok(Math.abs(zm - 218) < 2, `${zm}`);
  assert.ok(Math.abs(haversineKm(0, 0, 0, 180) - Math.PI * EARTH_RADIUS / 1000) < 1e-6);
});
