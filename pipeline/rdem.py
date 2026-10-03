"""RDEM - a tiny, lossless (1 m quantised) elevation chunk format.

Layout (all little-endian), see docs/DATA_FORMAT.md for the full spec:

    offset  size  field
    0       4     magic  b"RDEM"
    4       1     version (1)
    5       1     flags  (bit 0: water mask present)
    6       2     reserved (0)
    8       2     width  (uint16)
    10      2     height (uint16)
    12      4     scale  (float32, metres per stored unit)
    16      4     offset (float32, metres added after scaling)
    20      4     elevation stream length in bytes (uint32)
    24      4     mask stream length in bytes (uint32, 0 if no mask)
    28      4     min elevation in metres (float32)
    32      4     max elevation in metres (float32)
    36      ...   elevation stream: zlib( int16 LE residuals of a 2-D gradient predictor )
    ...     ...   mask stream: zlib( packed bits, row-major, MSB first )

Predictor (applied on the int16 stored values v):
    pred(0,0) = 0
    pred(0,c) = v(0,c-1)
    pred(r,0) = v(r-1,0)
    pred(r,c) = v(r,c-1) + v(r-1,c) - v(r-1,c-1)
residual = (v - pred) wrapped to int16. Decoding reverses it with the same wrap.
"""
from __future__ import annotations

import struct
import zlib

import numpy as np

MAGIC = b"RDEM"
VERSION = 1
HEADER = struct.Struct("<4sBBHHHffIIff")
assert HEADER.size == 36
NODATA = -32768


def _residuals(v: np.ndarray) -> np.ndarray:
    v32 = v.astype(np.int32)
    pred = np.zeros_like(v32)
    pred[0, 1:] = v32[0, :-1]
    pred[1:, 0] = v32[:-1, 0]
    pred[1:, 1:] = v32[1:, :-1] + v32[:-1, 1:] - v32[:-1, :-1]
    res = v32 - pred
    # wrap to int16
    return ((res + 32768) % 65536 - 32768).astype("<i2")


def _reconstruct(res: np.ndarray) -> np.ndarray:
    h, w = res.shape
    out = np.zeros((h, w), dtype=np.int32)
    r = res.astype(np.int32)
    # first row: cumulative sum
    out[0] = np.cumsum(r[0])
    out[0] = (out[0] + 32768) % 65536 - 32768
    # subsequent rows: v(r,c) = res + v(r,c-1) + v(r-1,c) - v(r-1,c-1)
    # => d(r,c) = v(r,c) - v(r-1,c) satisfies d(r,c) = res(r,c) + d(r,c-1) for c>0,
    #    and d(r,0) = res(r,0)  (since pred(r,0) = v(r-1,0))
    for y in range(1, h):
        d = np.cumsum(r[y])
        out[y] = out[y - 1] + d
        out[y] = (out[y] + 32768) % 65536 - 32768
    return out.astype(np.int16)


def encode(elev_m: np.ndarray, water: np.ndarray | None = None, scale: float = 1.0,
           offset: float = 0.0, level: int = 9) -> bytes:
    """Encode a 2-D float elevation array (metres) and optional boolean water mask."""
    if elev_m.ndim != 2:
        raise ValueError("elevation must be 2-D")
    h, w = elev_m.shape
    if not (0 < w < 65536 and 0 < h < 65536):
        raise ValueError("chunk too large")
    finite = np.isfinite(elev_m)
    q = np.where(finite, np.round((elev_m - offset) / scale), NODATA)
    q = np.clip(q, -32767, 32767).astype(np.int16)
    q[~finite] = NODATA
    elev_stream = zlib.compress(_residuals(q).tobytes(), level)
    flags = 0
    mask_stream = b""
    if water is not None and water.any():
        flags |= 1
        bits = np.packbits(water.astype(bool).reshape(-1), bitorder="big")
        mask_stream = zlib.compress(bits.tobytes(), level)
    valid = q[q != NODATA]
    mn = float(valid.min()) * scale + offset if valid.size else 0.0
    mx = float(valid.max()) * scale + offset if valid.size else 0.0
    header = HEADER.pack(MAGIC, VERSION, flags, 0, w, h, scale, offset,
                         len(elev_stream), len(mask_stream), mn, mx)
    return header + elev_stream + mask_stream


def decode(buf: bytes):
    """Decode to (elevation float32 metres with NaN for nodata, water bool mask or None, header dict)."""
    (magic, version, flags, _r, w, h, scale, offset, elen, mlen, mn, mx) = HEADER.unpack_from(buf, 0)
    if magic != MAGIC:
        raise ValueError("not an RDEM chunk")
    if version != VERSION:
        raise ValueError(f"unsupported RDEM version {version}")
    pos = HEADER.size
    res = np.frombuffer(zlib.decompress(buf[pos:pos + elen]), dtype="<i2").reshape(h, w)
    q = _reconstruct(res)
    elev = q.astype(np.float32) * scale + offset
    elev[q == NODATA] = np.nan
    water = None
    if flags & 1:
        bits = np.frombuffer(zlib.decompress(buf[pos + elen:pos + elen + mlen]), dtype=np.uint8)
        water = np.unpackbits(bits, bitorder="big")[: w * h].reshape(h, w).astype(bool)
    return elev, water, dict(width=w, height=h, scale=scale, offset=offset, min=mn, max=mx, flags=flags)


if __name__ == "__main__":  # quick self-test
    rng = np.random.default_rng(1)
    a = np.cumsum(np.cumsum(rng.normal(0, 3, (300, 200)), 0), 1) + 1500
    wm = rng.random((300, 200)) > 0.7
    b = encode(a, wm)
    e, m, hdr = decode(b)
    assert np.array_equal(np.round(a), e), "roundtrip mismatch"
    assert np.array_equal(wm, m)
    print("ok", len(b), "bytes", hdr)
