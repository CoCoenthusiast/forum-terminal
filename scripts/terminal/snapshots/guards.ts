interface PublishPriceLike {
  closed?: { value?: unknown } | null;
}

interface PublishSnapshotLike {
  asOf?: unknown;
  regime?: { id?: unknown } | null;
  prices?: readonly PublishPriceLike[] | null;
  metrics?: readonly { usd?: readonly unknown[] | null }[] | null;
}

export function publishBlockReason(
  screen: string,
  snapshot: PublishSnapshotLike
): string | null {
  if (screen === 'overview') {
    const regime = snapshot.regime;
    if (
      regime === null ||
      regime === undefined ||
      regime.id === null ||
      regime.id === undefined
    ) {
      const asOf = typeof snapshot.asOf === 'string' ? snapshot.asOf : '';
      return `regime not available for asOf ${asOf}`;
    }

    const prices = Array.isArray(snapshot.prices) ? snapshot.prices : [];
    if (prices.every((price) => price?.closed?.value == null)) {
      return 'no closed prices available';
    }
    return null;
  }

  if (screen === 'onchain') {
    const metrics = Array.isArray(snapshot.metrics) ? snapshot.metrics : [];
    if (
      metrics.every(
        (metric) => !Array.isArray(metric?.usd) || metric.usd.length === 0
      )
    ) {
      return 'no onchain series available';
    }
    return null;
  }

  return null;
}
