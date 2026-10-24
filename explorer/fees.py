"""Statistics for directed policy fees.

The raw mean of gossip fee rates is dominated by placeholder announcements
(some nodes publish 2147483647 ppm, which is ``INT_MAX``), so every summary
here also carries an outlier-corrected mean that drops values outside Tukey
far-out fences (Q1 - 3*IQR .. Q3 + 3*IQR). On real gossip that turns a mean
of roughly 10.8M ppm into roughly 400 ppm while touching only the junk.

Everything in this module is a pure function and unit tested in
``explorer/tests/test_stats.py``.
"""

from __future__ import annotations

import statistics
from typing import Iterable

# Tukey's far-out factor. The inner fences use 1.5; far-out uses 3.
FAR_OUT_FACTOR = 3.0
# Quartiles say nothing about outliers on tiny samples; pass those through.
MIN_FILTERED = 4

SUMMARY_KEYS = (
    "count",
    "min",
    "max",
    "mean",
    "median",
    "std",
    "p90",
    "mean_filtered",
    "mean_capweighted",
)


def _numbers(values: Iterable) -> list[float]:
    return [float(value) for value in values]


def far_out_bounds(values: Iterable) -> tuple[float, float] | None:
    """Tukey far-out fences, or None when the sample is too small to filter."""
    data = _numbers(values)
    if len(data) < MIN_FILTERED:
        return None
    quartiles = statistics.quantiles(data, n=4)
    iqr = quartiles[2] - quartiles[0]
    return (
        quartiles[0] - FAR_OUT_FACTOR * iqr,
        quartiles[2] + FAR_OUT_FACTOR * iqr,
    )


def filter_outliers(values: Iterable, weights: Iterable | None = None) -> list[tuple[float, object]]:
    """Keep only (value, weight) pairs inside the far-out fences.

    ``weights`` runs parallel to ``values`` (the channel capacity of the
    policy, or None when unknown). Small samples are returned unchanged.
    """
    data = _numbers(values)
    mass: list = list(weights) if weights is not None else [None] * len(data)
    pairs = list(zip(data, mass))
    bounds = far_out_bounds(data)
    if bounds is None:
        return pairs
    low, high = bounds
    return [pair for pair in pairs if low <= pair[0] <= high]


def percentile(values: Iterable, fraction: float) -> float | None:
    """Linear-interpolation percentile (``fraction`` in 0..1) of raw values."""
    data = sorted(_numbers(values))
    if not data:
        return None
    if len(data) == 1:
        return data[0]
    position = fraction * (len(data) - 1)
    lower = int(position)
    upper = min(lower + 1, len(data) - 1)
    share = position - lower
    return data[lower] * (1.0 - share) + data[upper] * share


def summarize(values: Iterable, weights: Iterable | None = None) -> dict:
    """Aggregate one fee series.

    ``mean`` is raw; ``mean_filtered`` drops far-out values first and
    ``mean_capweighted`` weights the filtered values by the parallel
    ``weights`` list (capacities; None or 0 means unknown and is skipped).
    """
    data = _numbers(values)
    if not data:
        return {**{key: None for key in SUMMARY_KEYS}, "count": 0}
    kept = filter_outliers(data, weights)
    kept_values = [value for value, _weight in kept]
    weighted = [
        (value, weight)
        for value, weight in kept
        if isinstance(weight, (int, float)) and not isinstance(weight, bool) and weight > 0
    ]
    capweighted = None
    if weighted:
        total = sum(weight for _value, weight in weighted)
        if total > 0:
            capweighted = sum(value * weight for value, weight in weighted) / total
    return {
        "count": len(data),
        "min": min(data),
        "max": max(data),
        "mean": statistics.fmean(data),
        "median": statistics.median(data),
        "std": statistics.pstdev(data),
        "p90": percentile(data, 0.9),
        "mean_filtered": statistics.fmean(kept_values) if kept_values else None,
        "mean_capweighted": capweighted,
    }
