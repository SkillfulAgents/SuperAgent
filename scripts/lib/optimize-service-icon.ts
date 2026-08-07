import { optimize, type Config } from 'svgo'

const SERVICE_ICON_SVGO_CONFIG = {
  multipass: true,
  floatPrecision: 3,
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          // Combining separately painted paths can subtly change antialiasing
          // where their edges overlap. It saves under 1 KB compressed across
          // the whole icon set, so preserve those paint boundaries.
          mergePaths: false,
        },
      },
    },
  ],
} satisfies Config

export function optimizeServiceIcon(svg: string): string {
  return optimize(svg, SERVICE_ICON_SVGO_CONFIG).data
}
