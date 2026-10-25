import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import type { ChartConfiguration } from 'chart.js';
import { registerFont } from 'canvas';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerDateAdapter } from './chart-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create a singleton ChartJSNodeCanvas instance to reuse across chart generations
// This ensures the date adapter registration persists
let chartJSNodeCanvasInstance: ChartJSNodeCanvas | null = null;

function getChartJSNodeCanvas(): ChartJSNodeCanvas {
  if (!chartJSNodeCanvasInstance) {
    chartJSNodeCanvasInstance = new ChartJSNodeCanvas({
      width: 800,
      height: 500,
      backgroundColour: 'white',
      chartCallback: (ChartJS) => {
        // Register date adapter with the Chart.js instance used by ChartJSNodeCanvas
        // This is necessary because ChartJSNodeCanvas creates an isolated Chart.js context
        registerDateAdapter(ChartJS);
      }
    });
  }
  return chartJSNodeCanvasInstance;
}

/**
 * Font stack used for every label in the chart.
 *
 * A single CJK-capable family is used on purpose: when a Latin-only face such
 * as Sora leads the stack, node-canvas renders CJK glyphs through a fallback
 * run that sits ~0.2em below the Latin run, so mixed titles like
 * "文荟学生公寓8号楼7F709房间 余额账单" come out with the numbers visually
 * raised above the Chinese text. With Noto Sans SC (Latin + CJK in one face)
 * there is no fallback run and both scripts share one baseline.
 */
export const CHART_FONT_STACK = "'Noto Sans SC', sans-serif";

// Register bundled fonts before the first canvas is created.
try {
  registerFont(join(__dirname, '../../fonts/NotoSansSC-Regular.otf'), {
    family: 'Noto Sans SC',
    weight: 'normal'
  });

  registerFont(join(__dirname, '../../fonts/NotoSansSC-Bold.otf'), {
    family: 'Noto Sans SC',
    weight: 'bold'
  });

  console.log('[Fonts] Custom fonts registered successfully');
} catch (error) {
  console.error('[Fonts] Failed to register custom fonts:', error);
}

export interface ChartDataPoint {
  timestamp: string;
  balance: number;
}

export interface ChartResult {
  buffer: Buffer;
  title: string;
}

/**
 * Render any Chart.js configuration through the shared ChartJSNodeCanvas
 * singleton (fonts + date adapter already registered). Exported for tooling.
 */
export const renderChart = async (config: ChartConfiguration): Promise<Buffer> =>
  getChartJSNodeCanvas().renderToBuffer(config);

/**
 * Generate a PNG line chart for the balance history of one room.
 * Returns an empty array when there are fewer than two data points.
 */
export const generateBalanceChart = async (
  data: ChartDataPoint[],
  roomLabel: string
): Promise<ChartResult[]> => {
  if (data.length < 2) {
    return [];
  }

  const sorted = [...data].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const series = sorted.map((d) => ({ x: new Date(d.timestamp).getTime(), y: d.balance }));
  const title = `${roomLabel} 余额账单`;

  const config = createChartConfig(series, title, sorted.length);

  try {
    const buffer = await getChartJSNodeCanvas().renderToBuffer(config);
    return [{ buffer, title }];
  } catch (error) {
    console.error('Failed to generate chart:', error);
    return [];
  }
};

/**
 * Tick callback that labels the axis with dates only.
 *
 * The daily update is pinned to a single hour, so the axis carries no time
 * information any more: every calendar day is labelled with its date exactly
 * once. The label is placed on the tick closest to the update hour, which
 * keeps it next to the point it describes.
 */
const createDateTickCallback =
  (dataHour: number) =>
  (value: number | string, index: number, ticks: { value: number }[]): string | null => {
    const date = new Date(value);
    const dateLabel = date.toLocaleDateString('zh-CN', {
      month: '2-digit',
      day: '2-digit'
    });

    // Find the tick of the same day that sits closest to the update hour.
    let labelIndex = index;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i];
      if (tick?.value === undefined || tick.value === null) {
        continue;
      }
      const tickDate = new Date(tick.value);
      if (
        tickDate.getFullYear() !== date.getFullYear() ||
        tickDate.getMonth() !== date.getMonth() ||
        tickDate.getDate() !== date.getDate()
      ) {
        continue;
      }
      const distance = Math.abs(tickDate.getHours() - dataHour);
      if (distance < bestDistance) {
        bestDistance = distance;
        labelIndex = i;
      }
    }

    return index === labelIndex ? dateLabel : null;
  };

/**
 * Create a chart configuration with time scale
 */
export const createChartConfig = (
  series: { x: number; y: number }[],
  title: string,
  totalPoints: number
): ChartConfiguration => {
  const lastPoint = series[series.length - 1];
  const dataHour = new Date(lastPoint.x).getHours();

  return {
    type: 'line',
    data: {
      datasets: [
        {
          label: '余额 (¥)',
          data: series,
          borderColor: 'rgb(43, 130, 255)',
          backgroundColor: 'rgba(43, 130, 255, 0.1)',
          borderWidth: 2.5,
          cubicInterpolationMode: 'monotone',
          fill: true,
          pointRadius: totalPoints < 24 ? 4 : 0
        }
      ]
    },
    options: {
      devicePixelRatio: 2,
      responsive: true,
      font: {
        family: CHART_FONT_STACK
      },
      plugins: {
        title: {
          display: true,
          text: title,
          font: {
            size: 18,
            weight: 'bold',
            family: CHART_FONT_STACK
          }
        },
        legend: {
          display: true,
          position: 'top',
          labels: {
            font: {
              family: CHART_FONT_STACK
            }
          }
        },
        tooltip: {
          callbacks: {
            // The axis carries dates only, so the tooltip does as well.
            title: (items) => {
              const item = items[0];
              const x = item?.parsed.x;
              if (!item || x === null || x === undefined) {
                return '';
              }
              return new Date(x).toLocaleDateString('zh-CN', {
                month: '2-digit',
                day: '2-digit'
              });
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          title: {
            display: true,
            text: '余额 (¥)',
            font: {
              family: CHART_FONT_STACK
            }
          },
          ticks: {
            font: {
              family: CHART_FONT_STACK
            }
          }
        },
        x: {
          type: 'time',
          title: {
            display: true,
            text: '日期',
            font: {
              family: CHART_FONT_STACK
            }
          },
          ticks: {
            maxRotation: 45,
            minRotation: 0,
            font: {
              family: CHART_FONT_STACK
            },
            callback: createDateTickCallback(dataHour),
            autoSkip: false // Disable auto-skipping to use custom callback
          }
        }
      }
    },
    plugins: [
      {
        id: 'customCanvasBackgroundColor',
        beforeDraw: (chart) => {
          const { ctx } = chart;
          ctx.save();
          ctx.globalCompositeOperation = 'destination-over';
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, chart.width, chart.height);
          ctx.restore();
        }
      }
    ]
  };
};
