'use client';

import { useMemo } from 'react';
import type { RenderModel, RenderStrategy } from '@/domain/worldline/render-model';
import {
  CHART_HEIGHT, CHART_PAD, CHART_WIDTH, MARGINAL_GAP, bandColor,
  buildMarginalBins, strategyColor, wan, type YDomain,
} from './geometry';

/**
 * 单策略面板：左边逐月分位带 + 代表线，右边边际分布（同一纵轴）。
 * 手写 SVG：与示范页同一套坐标映射，两个面板强制共用 domain。
 */
export function StrategyPanel({ model, strategy, index, domain, cursor }: {
  model: RenderModel;
  strategy: RenderStrategy;
  index: number;
  domain: YDomain;
  cursor: number;
}) {
  const months = model.meta.months;
  const plotRight = CHART_WIDTH - CHART_PAD.right;
  const plotWidth = plotRight - CHART_PAD.left;
  const innerHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const marginalX = plotRight + MARGINAL_GAP;
  const marginalWidth = CHART_PAD.right - MARGINAL_GAP - 6;

  const X = (month: number) => CHART_PAD.left + (months <= 1 ? 0 : ((month - 1) / (months - 1)) * plotWidth);
  const Y = (value: number) => CHART_PAD.top + innerHeight - ((value - domain.min) / (domain.max - domain.min || 1)) * innerHeight;

  const points = model.quantilesByMonth[strategy.id] ?? [];
  const bins = useMemo(() => buildMarginalBins(model.minUsables[strategy.id] ?? [], domain, 40), [model, strategy.id, domain]);

  const line = (pick: (point: { p5: number; p50: number; p90: number }) => number) => points.map((point, i) => `${i === 0 ? 'M' : 'L'}${X(i + 1)},${Y(pick(point))}`).join(' ');
  const bandArea = points.length < 2 ? '' : `${line(point => point.p90)} ${[...points].reverse().map((point, i) => `L${X(points.length - i)},${Y(point.p5)}`).join(' ')} Z`;
  const medianLine = line(point => point.p50);

  const ticks = useMemo(() => {
    const count = 4;
    return Array.from({ length: count + 1 }, (_, i) => domain.min + ((domain.max - domain.min) * i) / count);
  }, [domain]);

  const colors = strategyColor(strategy, index);

  return <figure className="wl-panel">
    <figcaption>
      <strong>{strategy.id.toUpperCase()} · {strategy.label}</strong>
      <span>门槛 {wan(strategy.floorMinor)} · P50 {wan(strategy.p50)}</span>
    </figcaption>
    <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={`${strategy.label}的逐月可用资金分位带与最低值分布`}>
      {ticks.map(tick => <g key={tick}>
        <line x1={CHART_PAD.left} x2={CHART_PAD.left + plotWidth + MARGINAL_GAP + marginalWidth} y1={Y(tick)} y2={Y(tick)} className="wl-grid" />
        <text x={CHART_PAD.left - 6} y={Y(tick) + 3.5} textAnchor="end" className="wl-axis">{wan(tick)}</text>
      </g>)}
      <line x1={CHART_PAD.left} x2={CHART_PAD.left + plotWidth + MARGINAL_GAP + marginalWidth} y1={Y(0)} y2={Y(0)} className="wl-zero" />
      <text x={CHART_PAD.left + 2} y={Y(0) - 4} className="wl-axis">0</text>

      {bandArea && <path d={bandArea} fill={colors} opacity={0.14} stroke="none" />}
      {points.length > 1 && <>
        <path d={points.map((point, i) => `${i === 0 ? 'M' : 'L'}${X(i + 1)},${Y(point.p90)}`).join(' ')} fill="none" stroke={colors} strokeOpacity={0.45} strokeWidth={1} strokeDasharray="4 4" />
        <path d={points.map((point, i) => `${i === 0 ? 'M' : 'L'}${X(i + 1)},${Y(point.p5)}`).join(' ')} fill="none" stroke={colors} strokeOpacity={0.45} strokeWidth={1} strokeDasharray="4 4" />
        <path d={medianLine} fill="none" stroke={colors} strokeWidth={1.6} />
      </>}

      {model.candidates.map(candidate => {
        const series = candidate.series[strategy.id] ?? [];
        if (series.length < 2) return null;
        const color = bandColor[candidate.band] ?? colors;
        return <path key={candidate.id}
          d={series.map((value, i) => `${i === 0 ? 'M' : 'L'}${X(i + 1)},${Y(value)}`).join(' ')}
          fill="none" stroke={color} strokeWidth={1.2} strokeOpacity={0.75} />;
      })}

      <line x1={X(cursor)} x2={X(cursor)} y1={CHART_PAD.top} y2={CHART_PAD.top + innerHeight} className="wl-cursor" />
      <text x={X(cursor)} y={CHART_PAD.top - 4} textAnchor="middle" className="wl-axis">第{cursor}月</text>

      {bins.map((bin, i) => {
        const height = (bin.to - bin.from) * 0 + innerHeight / bins.length;
        const y = Y(bin.to);
        const value = bin.from;
        const color = value < 0 ? bandColor.bad : value < strategy.floorMinor ? bandColor.tight : bandColor.ok;
        return <rect key={i} x={marginalX} y={y} width={Math.max(0.5, bin.density * marginalWidth)} height={Math.max(0.6, height - 0.6)} fill={color} opacity={0.55} />;
      })}
      <line x1={marginalX} x2={marginalX} y1={CHART_PAD.top} y2={CHART_PAD.top + innerHeight} className="wl-marginal-axis" />
      <text x={marginalX + marginalWidth} y={CHART_PAD.top + 8} textAnchor="end" className="wl-axis">最低值分布</text>
    </svg>
  </figure>;
}
