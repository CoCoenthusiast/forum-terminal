interface PublishPriceLike {
  closed?: { value?: unknown } | null;
}

interface PublishAssetLike {
  price?: readonly unknown[] | null;
}

interface PublishSeriesLike {
  points?: readonly unknown[] | null;
}

interface PublishSnapshotLike {
  asOf?: unknown;
  regime?: { id?: unknown } | null;
  prices?: readonly PublishPriceLike[] | null;
  metrics?: readonly { usd?: readonly unknown[] | null }[] | null;
  assets?: readonly PublishAssetLike[] | null;
  series?: readonly PublishSeriesLike[] | null;
  indicators?: readonly PublishSeriesLike[] | null;
  platforms?:
    | readonly {
        volume?: PublishSeriesLike | null;
        fees?: PublishSeriesLike | null;
        indicators?: readonly PublishSeriesLike[] | null;
      }[]
    | null;
  items?: readonly { lastDate?: unknown }[] | null;
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

  if (screen === 'market-structure') {
    const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];
    if (
      assets.every(
        (asset) => !Array.isArray(asset?.price) || asset.price.length === 0
      )
    ) {
      return 'no market structure prices available';
    }
    return null;
  }

  if (screen === 'macro') {
    const entries = [
      ...(Array.isArray(snapshot.series) ? snapshot.series : []),
      ...(Array.isArray(snapshot.indicators) ? snapshot.indicators : []),
    ];
    if (
      entries.every(
        (entry) => !Array.isArray(entry?.points) || entry.points.length === 0
      )
    ) {
      return 'no macro series available';
    }
    return null;
  }

  if (screen === 'health') {
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    if (items.every((item) => item?.lastDate == null)) {
      return 'no health data available';
    }
    return null;
  }

  if (screen === 'launchpads') {
    const platforms = Array.isArray(snapshot.platforms)
      ? snapshot.platforms
      : [];
    const entries = platforms.flatMap((platform) => [
      platform?.volume,
      platform?.fees,
      ...(Array.isArray(platform?.indicators) ? platform.indicators : []),
    ]);
    if (
      entries.every(
        (entry) => !Array.isArray(entry?.points) || entry.points.length === 0
      )
    ) {
      return 'no launchpads series available';
    }
    return null;
  }

  return null;
}
